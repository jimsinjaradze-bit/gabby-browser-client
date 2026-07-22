import { sendFile } from './file-sender';
import { CHUNK_DATA_SIZE } from './protocol';

function makeBlob(size: number): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = i % 256;
  }
  return new Blob([bytes]);
}

describe('sendFile', () => {
  it('sends raw chunks of at most CHUNK_DATA_SIZE bytes', async () => {
    const frames: ArrayBuffer[] = [];
    const size = CHUNK_DATA_SIZE + 1234;

    await sendFile({
      file: makeBlob(size),
      send: (frame) => frames.push(frame),
      bufferedAmount: () => 0,
      onProgress: () => {},
    });

    expect(frames.length).toBe(2);
    expect(frames[0].byteLength).toBe(CHUNK_DATA_SIZE);
    expect(frames[1].byteLength).toBe(1234);
  });

  it('preserves the file bytes across chunk boundaries', async () => {
    const frames: ArrayBuffer[] = [];
    const size = CHUNK_DATA_SIZE * 2 + 7;

    await sendFile({
      file: makeBlob(size),
      send: (frame) => frames.push(frame),
      bufferedAmount: () => 0,
      onProgress: () => {},
    });

    const reassembled = new Uint8Array(size);
    let offset = 0;
    for (const frame of frames) {
      const data = new Uint8Array(frame);
      reassembled.set(data, offset);
      offset += data.length;
    }
    const expected = new Uint8Array(await makeBlob(size).arrayBuffer());
    expect(reassembled).toEqual(expected);
  });

  it('reports cumulative progress after each chunk', async () => {
    const progress: number[] = [];
    const size = CHUNK_DATA_SIZE + 10;

    await sendFile({
      file: makeBlob(size),
      send: () => {},
      bufferedAmount: () => 0,
      onProgress: (sent) => progress.push(sent),
    });

    expect(progress).toEqual([CHUNK_DATA_SIZE, size]);
  });

  it('waits for the socket buffer to drain before sending more', async () => {
    let buffered = 5_000_000;
    let drainChecks = 0;
    const frames: ArrayBuffer[] = [];

    await sendFile({
      file: makeBlob(10),
      send: (frame) => frames.push(frame),
      bufferedAmount: () => {
        drainChecks++;
        // Drain after a few polls.
        if (drainChecks > 3) {
          buffered = 0;
        }
        return buffered;
      },
      onProgress: () => {},
      drainDelayMs: 1,
    });

    expect(drainChecks).toBeGreaterThan(3);
    expect(frames.length).toBe(1);
  });

  it('stops when aborted', async () => {
    const frames: ArrayBuffer[] = [];
    let sentOnce = false;

    await expect(
      sendFile({
        file: makeBlob(CHUNK_DATA_SIZE * 3),
        send: (frame) => {
          frames.push(frame);
          sentOnce = true;
        },
        bufferedAmount: () => 0,
        onProgress: () => {},
        isAborted: () => sentOnce,
      }),
    ).rejects.toThrow('aborted');

    expect(frames.length).toBe(1);
  });

  it('honors a custom chunkSize', async () => {
    const frames: ArrayBuffer[] = [];

    await sendFile({
      file: makeBlob(10),
      send: (frame) => frames.push(frame),
      bufferedAmount: () => 0,
      onProgress: () => {},
      chunkSize: 3,
    });

    expect(frames.map((f) => f.byteLength)).toEqual([3, 3, 3, 1]);
  });

  it('sends nothing for an empty file', async () => {
    const frames: ArrayBuffer[] = [];
    await sendFile({
      file: makeBlob(0),
      send: (frame) => frames.push(frame),
      bufferedAmount: () => 0,
      onProgress: () => {},
    });
    expect(frames.length).toBe(0);
  });
});
