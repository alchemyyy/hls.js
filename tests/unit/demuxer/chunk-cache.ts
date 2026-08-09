import { expect } from 'chai';
import ChunkCache from '../../../src/demux/chunk-cache';

describe('ChunkCache', function () {
  it('flushes a bounded prefix and retains the remaining bytes', function () {
    const cache = new ChunkCache();
    cache.push(new Uint8Array([0, 1, 2]));
    cache.push(new Uint8Array([3, 4, 5, 6]));

    expect(cache.flush(5)).to.deep.equal(new Uint8Array([0, 1, 2, 3, 4]));
    expect(cache.dataLength).to.equal(2);
    expect(cache.flush()).to.deep.equal(new Uint8Array([5, 6]));
    expect(cache.dataLength).to.equal(0);
  });

  it('returns a standalone array for an input view', function () {
    const cache = new ChunkCache();
    const backingData = new Uint8Array([9, 1, 2, 3, 9]);
    cache.push(backingData.subarray(1, 4) as Uint8Array<ArrayBuffer>);

    const result = cache.flush();

    expect(result).to.deep.equal(new Uint8Array([1, 2, 3]));
    expect(result.buffer).to.not.equal(backingData.buffer);
  });
});
