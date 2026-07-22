import { CHUNK_DATA_SIZE } from './protocol';

export interface SendFileOptions {
  file: Blob;
  send(frame: ArrayBuffer): void;
  bufferedAmount(): number;
  onProgress(sentBytes: number): void;
  isAborted?(): boolean;
  /** Pause sending while the socket buffer is above this. */
  highWaterMark?: number;
  drainDelayMs?: number;
  /** Defaults to CHUNK_DATA_SIZE; pass the server's POLICY-negotiated size instead. */
  chunkSize?: number;
}

const DEFAULT_HIGH_WATER_MARK = 1_000_000;
const DEFAULT_DRAIN_DELAY_MS = 20;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Streams a file as raw binary frames. The server allows a single active
 * transfer per client, so PayloadRelayService resolves the transfer from the
 * sender and frames carry no header. Chunks are read lazily via Blob.slice so
 * large files never sit in memory whole.
 */
export async function sendFile(options: SendFileOptions): Promise<void> {
  const {
    file,
    highWaterMark = DEFAULT_HIGH_WATER_MARK,
    drainDelayMs = DEFAULT_DRAIN_DELAY_MS,
    chunkSize = CHUNK_DATA_SIZE,
  } = options;

  let offset = 0;
  while (offset < file.size) {
    if (options.isAborted?.()) {
      throw new Error('Transfer aborted');
    }
    while (options.bufferedAmount() > highWaterMark) {
      await sleep(drainDelayMs);
      if (options.isAborted?.()) {
        throw new Error('Transfer aborted');
      }
    }

    const end = Math.min(offset + chunkSize, file.size);
    options.send(await file.slice(offset, end).arrayBuffer());

    offset = end;
    options.onProgress(offset);
  }
}
