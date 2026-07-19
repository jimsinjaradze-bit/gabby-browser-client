/**
 * Reassembles a file from relayed binary frames. Frames carry raw chunk
 * bytes with no transfer id, so completion is detected by byte count against
 * the file meta (the server also confirms it with a TRANSFER_LIST update).
 */
export class FileReceiver {
  private readonly chunks: ArrayBuffer[] = [];
  private received = 0;

  constructor(
    private readonly expectedBytes: number,
    private readonly mimeType: string,
  ) {}

  get receivedBytes(): number {
    return this.received;
  }

  get isComplete(): boolean {
    return this.received >= this.expectedBytes;
  }

  push(chunk: ArrayBuffer): void {
    this.chunks.push(chunk);
    this.received += chunk.byteLength;
  }

  toBlob(): Blob {
    return new Blob(this.chunks, { type: this.mimeType });
  }
}

export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
