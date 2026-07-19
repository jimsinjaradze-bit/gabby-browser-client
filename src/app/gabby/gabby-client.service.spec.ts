import { vi } from 'vitest';
import { GabbyClientService } from './gabby-client.service';
import { ClientCommand, TransferDto } from './protocol';

const TRANSFER_ID = '550e8400-e29b-41d4-a716-446655440000';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  binaryType = 'blob';
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  sent: (string | ArrayBuffer)[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ wasClean: true, code, reason } as CloseEvent);
  }

  // test helpers
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  simulateServerClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ wasClean: false, code, reason } as CloseEvent);
  }

  sentCommands(): ClientCommand[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as ClientCommand);
  }
}

function transferDto(overrides: Partial<TransferDto> = {}): TransferDto {
  return {
    id: TRANSFER_ID,
    status: 'REQUESTED',
    from: 'alice',
    to: 'bob',
    fileMeta: { name: 'notes.txt', sizeInBytes: 4, mimeType: 'text/plain' },
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function serverMessage(messageType: string, payload: unknown): string {
  return JSON.stringify({ messageType, payload });
}

describe('GabbyClientService', () => {
  let service: GabbyClientService;
  let download: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    service = new GabbyClientService();
    download = vi.fn();
    (service as unknown as { download: unknown }).download = download;
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.unstubAllGlobals();
  });

  function connectAs(name: string): FakeWebSocket {
    service.connect('ws://localhost:8080/ws', name);
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.simulateOpen();
    return ws;
  }

  it('connects with the name as a query parameter and arraybuffer binary type', () => {
    const ws = connectAs('alice');
    expect(ws.url).toBe('ws://localhost:8080/ws?name=alice');
    expect(ws.binaryType).toBe('arraybuffer');
    expect(service.connectionState()).toBe('connected');
  });

  it('refuses to connect without a name', () => {
    service.connect('ws://localhost:8080/ws', '  ');
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(service.lastError()).toContain('name');
  });

  it('updates nodes from NODE_LIST and excludes itself from peers', () => {
    const ws = connectAs('alice');
    ws.simulateMessage(
      serverMessage('NODE_LIST', [
        { name: 'alice', joinedAt: '2026-07-06T10:00:00Z' },
        { name: 'bob', joinedAt: '2026-07-06T10:01:00Z' },
      ]),
    );

    expect(service.nodes().length).toBe(2);
    expect(service.peers().map((p) => p.name)).toEqual(['bob']);
  });

  it('sends a well-formed SEND_PAYLOAD_REQ', () => {
    const ws = connectAs('alice');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'notes.txt', { type: 'text/plain' });

    service.sendFileRequest('bob', file);

    expect(ws.sentCommands()).toEqual([
      {
        clientCommandType: 'SEND_PAYLOAD_REQ',
        payload: {
          to: 'bob',
          fileMeta: { name: 'notes.txt', sizeInBytes: 4, mimeType: 'text/plain' },
        },
      },
    ]);
  });

  it('sends accept and reject commands with the transfer id', () => {
    const ws = connectAs('bob');
    service.accept(TRANSFER_ID);
    service.reject(TRANSFER_ID);

    expect(ws.sentCommands()).toEqual([
      { clientCommandType: 'ACCEPT_PAYLOAD_REQ', payload: { transferId: TRANSFER_ID } },
      { clientCommandType: 'REJECT_PAYLOAD_REQ', payload: { transferId: TRANSFER_ID } },
    ]);
  });

  it('blocks new requests while a REQUESTED transfer involves the sender', () => {
    const ws = connectAs('alice');
    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto()]));

    expect(service.canRequestTransfer('bob')).toBe(false);
    expect(service.canRequestTransfer('carol')).toBe(false); // alice is still the sender

    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto({ status: 'REJECTED' })]));
    expect(service.canRequestTransfer('bob')).toBe(true);
  });

  it('blocks new requests while either participant has an active transfer', () => {
    const ws = connectAs('carol');
    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto({ status: 'IN_PROGRESS' })]));

    expect(service.canRequestTransfer('bob')).toBe(false); // bob is receiving
    expect(service.canRequestTransfer('alice')).toBe(false); // alice is sending

    ws.simulateMessage(
      serverMessage('TRANSFER_LIST', [transferDto({ status: 'COMPLETED_SUCCESSFULLY' })]),
    );
    expect(service.canRequestTransfer('bob')).toBe(true);
  });

  it('streams the picked file once the transfer is accepted', async () => {
    const ws = connectAs('alice');
    const file = new File([new Uint8Array([9, 8, 7, 6])], 'notes.txt', { type: 'text/plain' });

    service.sendFileRequest('bob', file);
    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto()]));
    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto({ status: 'ACCEPTED' })]));

    await vi.waitFor(() => {
      expect(ws.sent.some((d) => d instanceof ArrayBuffer)).toBe(true);
    });

    const frame = ws.sent.find((d): d is ArrayBuffer => d instanceof ArrayBuffer)!;
    expect(new Uint8Array(frame)).toEqual(new Uint8Array([9, 8, 7, 6]));

    await vi.waitFor(() => {
      const view = service.transferViews().find((v) => v.dto.id === TRANSFER_ID)!;
      expect(view.phase).toBe('done');
    });
  });

  it('marks a transfer done when the server reports it completed', () => {
    const ws = connectAs('alice');
    ws.simulateMessage(
      serverMessage('TRANSFER_LIST', [transferDto({ status: 'COMPLETED_SUCCESSFULLY' })]),
    );

    const view = service.transferViews()[0];
    expect(view.phase).toBe('done');
    expect(view.progressPct).toBe(100);
  });

  it('reassembles incoming chunks and downloads the file when complete', () => {
    const ws = connectAs('bob');
    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto({ status: 'ACCEPTED' })]));

    ws.simulateMessage(new Uint8Array([1, 2]).buffer);
    let view = service.transferViews()[0];
    expect(view.phase).toBe('receiving');
    expect(view.progressBytes).toBe(2);
    expect(download).not.toHaveBeenCalled();

    ws.simulateMessage(new Uint8Array([3, 4]).buffer);
    view = service.transferViews()[0];
    expect(view.phase).toBe('done');
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0][1]).toBe('notes.txt');
  });

  it('marks incoming REQUESTED transfers as awaiting-accept with a countdown', () => {
    const ws = connectAs('bob');
    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto()]));

    const view = service.transferViews()[0];
    expect(view.direction).toBe('incoming');
    expect(view.phase).toBe('awaiting-accept');
    expect(view.secondsLeft).toBeGreaterThan(50);
  });

  it('marks past-validUntil REQUESTED transfers as expired', () => {
    const ws = connectAs('bob');
    ws.simulateMessage(
      serverMessage('TRANSFER_LIST', [
        transferDto({ validUntil: new Date(Date.now() - 1000).toISOString() }),
      ]),
    );

    expect(service.transferViews()[0].phase).toBe('expired');
  });

  it('fails in-flight transfers and resets state on unexpected close', () => {
    const ws = connectAs('bob');
    ws.simulateMessage(serverMessage('NODE_LIST', [{ name: 'bob', joinedAt: 'x' }]));
    ws.simulateMessage(serverMessage('TRANSFER_LIST', [transferDto({ status: 'ACCEPTED' })]));

    ws.simulateServerClose(1011, 'boom');

    expect(service.connectionState()).toBe('disconnected');
    expect(service.nodes()).toEqual([]);
    expect(service.lastError()).toContain('1011');
    expect(service.transferViews()[0].phase).toBe('failed');
  });

  it('does not surface an error on clean disconnect', () => {
    connectAs('bob');
    service.disconnect();

    expect(service.connectionState()).toBe('disconnected');
    expect(service.lastError()).toBe('');
  });
});
