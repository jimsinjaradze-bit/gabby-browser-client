import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import {
  ClientCommand,
  ClientCommandType,
  MAX_FILE_SIZE,
  NodeDto,
  ServerMessage,
  TransferDto,
} from './protocol';
import { sendFile } from './file-sender';
import { FileReceiver, triggerDownload } from './file-receiver';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * Client-side transfer lifecycle. The server pushes an updated TRANSFER_LIST
 * when a transfer completes (COMPLETED_SUCCESSFULLY / COMPLETED_WITH_ERROR),
 * but progress is still derived here from the bytes moved locally.
 */
export type TransferPhase =
  | 'awaiting-accept'
  | 'expired'
  | 'rejected'
  | 'sending'
  | 'receiving'
  | 'done'
  | 'failed';

export interface TransferView {
  dto: TransferDto;
  direction: 'incoming' | 'outgoing';
  phase: TransferPhase;
  progressBytes: number;
  progressPct: number;
  secondsLeft: number | null;
  failureReason?: string;
}

interface LocalTransferState {
  progressBytes?: number;
  terminal?: 'done' | 'failed';
  failureReason?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable({ providedIn: 'root' })
export class GabbyClientService implements OnDestroy {
  private ws: WebSocket | null = null;
  private nowTimer: ReturnType<typeof setInterval> | null = null;

  readonly connectionState = signal<ConnectionState>('disconnected');
  readonly selfName = signal('');
  readonly lastError = signal('');
  readonly nodes = signal<NodeDto[]>([]);
  readonly transfers = signal<TransferDto[]>([]);

  private readonly localState = signal<Record<string, LocalTransferState>>({});
  private readonly now = signal(Date.now());

  /** Files picked by the user, waiting for the server to assign a transfer id. */
  private readonly pendingFilesByPeer = new Map<string, File>();
  private readonly filesByTransferId = new Map<string, File>();
  private readonly sendingIds = new Set<string>();
  /** Relayed frames carry no transfer id, so only one incoming stream can be active. */
  private activeReceiver: { dto: TransferDto; receiver: FileReceiver } | null = null;

  private download: (blob: Blob, fileName: string) => void = triggerDownload;

  readonly peers = computed(() => {
    const self = this.selfName().toLowerCase();
    return this.nodes().filter((n) => n.name.toLowerCase() !== self);
  });

  readonly transferViews = computed<TransferView[]>(() => {
    const self = this.selfName().toLowerCase();
    const local = this.localState();
    const now = this.now();

    return this.transfers()
      .map((dto) => {
        const direction = dto.from.toLowerCase() === self ? 'outgoing' : ('incoming' as const);
        const state = local[dto.id];
        const phase = this.resolvePhase(dto, direction, state, now);
        const size = dto.fileMeta.sizeInBytes;
        const progressBytes = phase === 'done' ? size : (state?.progressBytes ?? 0);
        const progressPct =
          size > 0 ? Math.min(100, (progressBytes / size) * 100) : phase === 'done' ? 100 : 0;
        const secondsLeft =
          phase === 'awaiting-accept'
            ? Math.max(0, Math.ceil((new Date(dto.validUntil).getTime() - now) / 1000))
            : null;

        return {
          dto,
          direction,
          phase,
          progressBytes,
          progressPct,
          secondsLeft,
          failureReason: state?.failureReason,
        } satisfies TransferView;
      })
      .sort((a, b) => b.dto.validUntil.localeCompare(a.dto.validUntil));
  });

  connect(url: string, name: string): void {
    const trimmedName = name.trim();
    if (!trimmedName) {
      this.lastError.set('Pick a name before connecting.');
      return;
    }

    let wsUrl: URL;
    try {
      wsUrl = new URL(url);
    } catch {
      this.lastError.set(`Invalid server URL: ${url}`);
      return;
    }
    wsUrl.searchParams.set('name', trimmedName);

    this.teardownSocket();
    this.resetSessionState();
    this.selfName.set(trimmedName);
    this.lastError.set('');
    this.connectionState.set('connecting');

    const ws = new WebSocket(wsUrl.toString());
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.connectionState.set('connected');
      this.startTicker();
    };
    ws.onmessage = (event) => this.onMessage(event);
    ws.onclose = (event) => this.onClose(event);
    this.ws = ws;
  }

  disconnect(): void {
    this.ws?.close(1000, 'client disconnect');
  }

  sendFileRequest(peer: string, file: File): void {
    if (file.size > MAX_FILE_SIZE) {
      this.lastError.set(`"${file.name}" exceeds the 1 GB limit.`);
      return;
    }
    if (!this.canRequestTransfer(peer)) {
      this.lastError.set('Only one transfer at a time — wait for the current one to finish.');
      return;
    }

    this.pendingFilesByPeer.set(peer.toLowerCase(), file);
    this.sendCommand('SEND_PAYLOAD_REQ', {
      to: peer,
      fileMeta: {
        name: file.name,
        sizeInBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
      },
    });
  }

  accept(transferId: string): void {
    this.sendCommand('ACCEPT_PAYLOAD_REQ', { transferId });
  }

  reject(transferId: string): void {
    this.sendCommand('REJECT_PAYLOAD_REQ', { transferId });
  }

  /**
   * Each client is allowed a single transfer at a time. The server refuses
   * (and drops the connection!) when a new request involves a participant
   * that already has a REQUESTED transfer — even an expired one, since expiry
   * is only checked on accept — or an IN_PROGRESS one. ACCEPTED is guarded
   * too: binary frames carry no transfer id, so the server identifies the
   * stream by sender alone and a second concurrent transfer would be
   * ambiguous.
   */
  canRequestTransfer(peer: string): boolean {
    const self = this.selfName().toLowerCase();
    const to = peer.toLowerCase();
    const active: TransferDto['status'][] = ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'];
    return !this.transfers().some((t) => {
      if (!active.includes(t.status)) {
        return false;
      }
      const from_ = t.from.toLowerCase();
      const to_ = t.to.toLowerCase();
      return from_ === self || to_ === self || from_ === to || to_ === to;
    });
  }

  ngOnDestroy(): void {
    this.teardownSocket();
    this.stopTicker();
  }

  private sendCommand(clientCommandType: ClientCommandType, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.lastError.set('Not connected.');
      return;
    }
    const command: ClientCommand = { clientCommandType, payload };
    this.ws.send(JSON.stringify(command));
  }

  private onMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      this.onBinary(event.data);
      return;
    }
    const message = JSON.parse(event.data as string) as ServerMessage;
    switch (message.messageType) {
      case 'NODE_LIST':
        this.nodes.set(message.payload as NodeDto[]);
        break;
      case 'TRANSFER_LIST':
        this.onTransferList(message.payload as TransferDto[]);
        break;
    }
  }

  private onTransferList(list: TransferDto[]): void {
    this.transfers.set(list);
    const self = this.selfName().toLowerCase();

    for (const transfer of list) {
      const outgoing = transfer.from.toLowerCase() === self;

      if (outgoing && !this.filesByTransferId.has(transfer.id)) {
        const pending = this.pendingFilesByPeer.get(transfer.to.toLowerCase());
        if (
          pending &&
          pending.name === transfer.fileMeta.name &&
          pending.size === transfer.fileMeta.sizeInBytes
        ) {
          this.filesByTransferId.set(transfer.id, pending);
          this.pendingFilesByPeer.delete(transfer.to.toLowerCase());
        }
      }

      if (transfer.status === 'ACCEPTED') {
        if (outgoing) {
          this.startSending(transfer);
        } else {
          this.ensureReceiver(transfer);
        }
      }
    }
  }

  private startSending(transfer: TransferDto): void {
    if (this.sendingIds.has(transfer.id) || this.localState()[transfer.id]?.terminal) {
      return;
    }
    const file = this.filesByTransferId.get(transfer.id);
    if (!file) {
      this.patchLocal(transfer.id, {
        terminal: 'failed',
        failureReason: 'The original file is no longer available in this session.',
      });
      return;
    }

    this.sendingIds.add(transfer.id);
    sendFile({
      file,
      send: (frame) => this.ws?.send(frame),
      bufferedAmount: () => this.ws?.bufferedAmount ?? 0,
      onProgress: (sentBytes) => this.patchLocal(transfer.id, { progressBytes: sentBytes }),
      isAborted: () => this.connectionState() !== 'connected',
    })
      .then(async () => {
        while ((this.ws?.bufferedAmount ?? 0) > 0 && this.connectionState() === 'connected') {
          await sleep(50);
        }
        this.patchLocal(transfer.id, { terminal: 'done' });
      })
      .catch((error: unknown) => {
        this.patchLocal(transfer.id, {
          terminal: 'failed',
          failureReason: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private ensureReceiver(transfer: TransferDto): void {
    if (this.activeReceiver?.dto.id === transfer.id || this.localState()[transfer.id]?.terminal) {
      return;
    }
    const receiver = new FileReceiver(
      transfer.fileMeta.sizeInBytes,
      transfer.fileMeta.mimeType || 'application/octet-stream',
    );
    this.activeReceiver = { dto: transfer, receiver };
    if (receiver.isComplete) {
      this.finishReceiving();
    }
  }

  private onBinary(chunk: ArrayBuffer): void {
    const active = this.activeReceiver;
    if (!active) {
      console.warn(`Dropping ${chunk.byteLength} relayed bytes: no accepted incoming transfer`);
      return;
    }
    active.receiver.push(chunk);
    this.patchLocal(active.dto.id, { progressBytes: active.receiver.receivedBytes });
    if (active.receiver.isComplete) {
      this.finishReceiving();
    }
  }

  private finishReceiving(): void {
    const active = this.activeReceiver!;
    this.download(active.receiver.toBlob(), active.dto.fileMeta.name);
    this.patchLocal(active.dto.id, {
      terminal: 'done',
      progressBytes: active.receiver.receivedBytes,
    });
    this.activeReceiver = null;
  }

  private onClose(event: CloseEvent): void {
    const wasConnecting = this.connectionState() === 'connecting';
    this.ws = null;
    this.connectionState.set('disconnected');
    this.stopTicker();
    this.failInFlight('Connection lost before the transfer finished.');
    this.activeReceiver = null;
    this.sendingIds.clear();
    this.nodes.set([]);

    if (event.code !== 1000) {
      const detail = event.reason ? `: ${event.reason}` : '';
      this.lastError.set(
        wasConnecting
          ? `Could not connect (code ${event.code}${detail}). Is the server running and the name free?`
          : `Connection closed by server (code ${event.code}${detail}).`,
      );
    }
  }

  private failInFlight(reason: string): void {
    const local = { ...this.localState() };
    let changed = false;
    for (const transfer of this.transfers()) {
      const isActive = transfer.status === 'ACCEPTED' || transfer.status === 'IN_PROGRESS';
      if (isActive && !local[transfer.id]?.terminal) {
        local[transfer.id] = { ...local[transfer.id], terminal: 'failed', failureReason: reason };
        changed = true;
      }
    }
    if (changed) {
      this.localState.set(local);
    }
  }

  private resolvePhase(
    dto: TransferDto,
    direction: 'incoming' | 'outgoing',
    state: LocalTransferState | undefined,
    now: number,
  ): TransferPhase {
    if (state?.terminal) {
      return state.terminal;
    }
    switch (dto.status) {
      case 'REQUESTED':
        return new Date(dto.validUntil).getTime() < now ? 'expired' : 'awaiting-accept';
      case 'REJECTED':
        return 'rejected';
      case 'ACCEPTED':
      case 'IN_PROGRESS':
        return direction === 'outgoing' ? 'sending' : 'receiving';
      case 'COMPLETED_SUCCESSFULLY':
        return 'done';
      case 'COMPLETED_WITH_ERROR':
        return 'failed';
    }
  }

  private patchLocal(transferId: string, patch: LocalTransferState): void {
    this.localState.update((state) => ({
      ...state,
      [transferId]: { ...state[transferId], ...patch },
    }));
  }

  private resetSessionState(): void {
    this.nodes.set([]);
    this.transfers.set([]);
    this.localState.set({});
    this.pendingFilesByPeer.clear();
    this.filesByTransferId.clear();
    this.sendingIds.clear();
    this.activeReceiver = null;
  }

  private teardownSocket(): void {
    if (!this.ws) {
      return;
    }
    const ws = this.ws;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close(1000, 'client reconnect');
  }

  private startTicker(): void {
    this.stopTicker();
    this.nowTimer = setInterval(() => this.now.set(Date.now()), 1000);
  }

  private stopTicker(): void {
    if (this.nowTimer !== null) {
      clearInterval(this.nowTimer);
      this.nowTimer = null;
    }
  }
}
