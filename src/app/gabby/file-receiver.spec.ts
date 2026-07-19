import { FileReceiver } from './file-receiver';

function chunk(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe('FileReceiver', () => {
  it('tracks received bytes and completes at the expected size', () => {
    const receiver = new FileReceiver(5, 'text/plain');

    expect(receiver.isComplete).toBe(false);
    receiver.push(chunk(1, 2, 3));
    expect(receiver.receivedBytes).toBe(3);
    expect(receiver.isComplete).toBe(false);

    receiver.push(chunk(4, 5));
    expect(receiver.receivedBytes).toBe(5);
    expect(receiver.isComplete).toBe(true);
  });

  it('reassembles chunks in order into a blob with the right type', async () => {
    const receiver = new FileReceiver(4, 'application/pdf');
    receiver.push(chunk(10, 20));
    receiver.push(chunk(30, 40));

    const blob = receiver.toBlob();
    expect(blob.type).toBe('application/pdf');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([10, 20, 30, 40]));
  });

  it('is immediately complete for a zero-byte file', () => {
    const receiver = new FileReceiver(0, 'text/plain');
    expect(receiver.isComplete).toBe(true);
    expect(receiver.toBlob().size).toBe(0);
  });
});
