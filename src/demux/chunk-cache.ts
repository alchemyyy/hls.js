export default class ChunkCache {
  private chunks: Array<Uint8Array<ArrayBuffer>> = [];
  public dataLength: number = 0;

  push(chunk: Uint8Array<ArrayBuffer>): void {
    this.chunks.push(chunk);
    this.dataLength += chunk.length;
  }

  flush(maxLength: number = this.dataLength): Uint8Array<ArrayBuffer> {
    const { chunks, dataLength } = this;
    if (!chunks.length) {
      return new Uint8Array(0);
    }

    const requestedLength = Number.isFinite(maxLength)
      ? Math.max(Math.floor(maxLength), 0)
      : dataLength;
    const resultLength = Math.min(requestedLength, dataLength);
    if (resultLength === dataLength) {
      const result =
        chunks.length === 1
          ? getStandaloneArray(chunks[0])
          : concatUint8Arrays(chunks, dataLength);
      this.reset();
      return result;
    }

    const result = new Uint8Array(resultLength);
    let resultOffset = 0;
    while (resultOffset < resultLength) {
      const chunk = chunks[0];
      const copyLength = Math.min(
        chunk.byteLength,
        resultLength - resultOffset,
      );
      result.set(chunk.subarray(0, copyLength), resultOffset);
      resultOffset += copyLength;
      this.dataLength -= copyLength;

      if (copyLength === chunk.byteLength) {
        chunks.shift();
      } else {
        chunks[0] = chunk.subarray(copyLength) as Uint8Array<ArrayBuffer>;
      }
    }
    return result;
  }

  reset(): void {
    this.chunks.length = 0;
    this.dataLength = 0;
  }
}

function getStandaloneArray(
  data: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data;
  }
  return data.slice();
}

function concatUint8Arrays(
  chunks: Array<Uint8Array<ArrayBuffer>>,
  dataLength: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(dataLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
