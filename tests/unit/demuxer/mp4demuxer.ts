import { expect } from 'chai';
import { hlsDefaultConfig } from '../../../src/config';
import MP4Demuxer from '../../../src/demux/mp4demuxer';
import MP4 from '../../../src/remux/mp4-generator';
import { ChunkMetadata } from '../../../src/types/transmuxer';
import { appendUint8Array } from '../../../src/utils/mp4-tools';
import type { HlsConfig } from '../../../src/config';
import type { HlsEventEmitter } from '../../../src/events';
import type { TrackFragmentSample } from '../../../src/remux/mp4-generator';
import type {
  DemuxedVideoTrack,
  DemuxerResult,
  PassthroughTrack,
} from '../../../src/types/demuxer';

describe('MP4Demuxer progressive parsing', function () {
  it('emits a large mdat in bounded chunks', function () {
    const demuxer = createDemuxer();
    const networkChunkSize = 128 * 1024;
    const samplePayload = new Uint8Array(networkChunkSize * 16);
    const moof = MP4.moof(0, 0, {
      type: 'video',
      id: 1,
      samples: [videoSample(samplePayload.byteLength)],
    });
    const fragment = appendUint8Array(moof, MP4.mdat(samplePayload));
    const outputs: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    let chunkID = 1;

    while (offset < fragment.byteLength) {
      const chunkEnd = Math.min(offset + networkChunkSize, fragment.byteLength);
      const result = demuxer.demux(
        fragment.slice(offset, chunkEnd),
        0,
        new ChunkMetadata(0, 1, chunkID, chunkEnd - offset),
      );
      const output = getVideoSamples(result);
      if (output.byteLength > 0) {
        expect(output.byteLength).to.be.at.most(networkChunkSize);
        outputs.push(output.slice());
      }
      offset += networkChunkSize;
      chunkID++;
    }

    expect(concatArrays(outputs)).to.deep.equal(fragment);
    demuxer.destroy();
  });

  it('forwards a partial mdat and preserves SEI split across chunks', function () {
    const demuxer = createDemuxer();
    const samplePayload = seiSamplePayload();
    const moof = MP4.moof(0, 0, {
      type: 'video',
      id: 1,
      samples: [videoSample(samplePayload.byteLength)],
    });
    const fragment = appendUint8Array(moof, MP4.mdat(samplePayload));
    const firstBoundary = moof.byteLength - 1;
    const secondBoundary = moof.byteLength + 8 + 10;
    const metadata = new ChunkMetadata(0, 1, 1, firstBoundary);

    const firstResult = demuxer.demux(
      fragment.slice(0, firstBoundary),
      0,
      metadata,
    );
    const firstOutput = getVideoSamples(firstResult).slice();
    expect(firstOutput).to.have.lengthOf(0);

    const secondResult = demuxer.demux(
      fragment.slice(firstBoundary, secondBoundary),
      0,
      new ChunkMetadata(0, 1, 2, secondBoundary - firstBoundary),
    );
    const secondOutput = getVideoSamples(secondResult).slice();
    const secondSampleData = secondResult.sampleData;
    expect(secondOutput).to.deep.equal(fragment.slice(0, secondBoundary));
    expect(secondResult.textTrack.samples).to.have.lengthOf(0);
    expect(secondSampleData?.tracks[1]).to.include({
      duration: 90000,
      sampleCount: 1,
    });

    const thirdResult = demuxer.demux(
      fragment.slice(secondBoundary),
      0,
      new ChunkMetadata(0, 1, 3, fragment.byteLength - secondBoundary),
    );
    const thirdOutput = getVideoSamples(thirdResult).slice();
    expect(thirdOutput).to.deep.equal(fragment.slice(secondBoundary));
    expect(thirdResult.sampleData).to.equal(secondSampleData);
    expect(thirdResult.textTrack.samples).to.have.lengthOf(1);
    expect(thirdResult.textTrack.samples[0]).to.include({
      payloadType: 5,
      pts: 0,
      userData: 'test',
    });
    expect(appendUint8Array(secondOutput, thirdOutput)).to.deep.equal(fragment);

    const flushResult = demuxer.flush(0, new ChunkMetadata(0, 1, 4, 0));
    expect(getVideoSamples(flushResult)).to.have.lengthOf(0);
    demuxer.destroy();
  });

  it('retains partial iframe media until the mdat is complete', function () {
    const demuxer = createDemuxer();
    const samplePayload = new Uint8Array(32);
    const moof = MP4.moof(0, 0, {
      type: 'video',
      id: 1,
      samples: [videoSample(samplePayload.byteLength)],
    });
    const fragment = appendUint8Array(moof, MP4.mdat(samplePayload));
    const partialLength = moof.byteLength + 16;
    const metadata = new ChunkMetadata(
      0,
      1,
      1,
      partialLength,
      -1,
      false,
      1,
      true,
    );

    const partialResult = demuxer.demux(
      fragment.slice(0, partialLength),
      0,
      metadata,
    );
    expect(getVideoSamples(partialResult)).to.have.lengthOf(0);

    const completeResult = demuxer.demux(
      fragment.slice(partialLength),
      0,
      metadata,
    );
    expect(getVideoSamples(completeResult)).to.deep.equal(fragment);
    demuxer.destroy();
  });

  it('parses timing from each moof while streaming multiple pairs', function () {
    const demuxer = createDemuxer();
    const firstPayload = new Uint8Array(24);
    const secondPayload = new Uint8Array(32);
    const firstMoof = MP4.moof(0, 0, {
      type: 'video',
      id: 1,
      samples: [videoSample(firstPayload.byteLength, 45000)],
    });
    const secondMoof = MP4.moof(1, 45000, {
      type: 'video',
      id: 1,
      samples: [videoSample(secondPayload.byteLength, 45000)],
    });
    const firstPair = appendUint8Array(firstMoof, MP4.mdat(firstPayload));
    const secondPair = appendUint8Array(secondMoof, MP4.mdat(secondPayload));
    const fragment = appendUint8Array(firstPair, secondPair);
    const firstBoundary = firstMoof.byteLength + 12;
    const secondBoundary = firstPair.byteLength + 12;
    const thirdBoundary = firstPair.byteLength + secondMoof.byteLength + 16;
    const boundaries = [
      0,
      firstBoundary,
      secondBoundary,
      thirdBoundary,
      fragment.byteLength,
    ];
    const outputs: Uint8Array<ArrayBuffer>[] = [];
    let secondPairSampleStart: number | undefined;

    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const result = demuxer.demux(
        fragment.slice(start, end),
        0,
        new ChunkMetadata(0, 1, index + 1, end - start),
      );
      const output = getVideoSamples(result);
      if (output.byteLength > 0) {
        outputs.push(output.slice());
      }
      const sampleStart = result.sampleData?.tracks[1]?.start;
      if (sampleStart === 45000) {
        secondPairSampleStart = sampleStart;
      }
    }

    expect(secondPairSampleStart).to.equal(45000);
    expect(concatArrays(outputs)).to.deep.equal(fragment);
    demuxer.destroy();
  });
});

function createDemuxer(): MP4Demuxer {
  const config: HlsConfig = {
    ...hlsDefaultConfig,
    progressive: true,
  };
  const demuxer = new MP4Demuxer(null as unknown as HlsEventEmitter, config);
  demuxer.resetInitSegment(
    MP4.initSegment([videoInitTrack()]),
    undefined,
    'avc1.42001e',
    1,
  );
  return demuxer;
}

function videoInitTrack(): DemuxedVideoTrack {
  return {
    codec: 'avc1.42001e',
    duration: 1,
    id: 1,
    inputTimeScale: 90000,
    pixelRatio: [1, 1],
    pps: [new Uint8Array([0x68, 0xce, 0x06, 0xe2])],
    samples: [],
    segmentCodec: 'avc',
    sps: [new Uint8Array([0x67, 0x42, 0x00, 0x1e, 0xab, 0x40])],
    timescale: 90000,
    type: 'video',
    width: 16,
    height: 16,
    pid: -1,
    sequenceNumber: -1,
    dropped: 0,
  };
}

function getVideoSamples(result: DemuxerResult): Uint8Array<ArrayBuffer> {
  return (result.videoTrack as PassthroughTrack).samples;
}

function videoSample(
  size: number,
  duration: number = 90000,
): TrackFragmentSample {
  return {
    cts: 0,
    duration,
    flags: {
      degradPrio: 0,
      dependsOn: 2,
      hasRedundancy: 0,
      isDependedOn: 0,
      isLeading: 0,
      isNonSync: 0,
      paddingValue: 0,
    },
    size,
  };
}

function seiSamplePayload(): Uint8Array<ArrayBuffer> {
  const uuid = new Uint8Array(16);
  const userData = new TextEncoder().encode('test');
  const nalu = new Uint8Array(3 + uuid.byteLength + userData.byteLength + 1);
  nalu.set([0x06, 0x05, uuid.byteLength + userData.byteLength], 0);
  nalu.set(uuid, 3);
  nalu.set(userData, 3 + uuid.byteLength);
  nalu[nalu.byteLength - 1] = 0x80;

  const sample = new Uint8Array(4 + nalu.byteLength);
  const naluSize = nalu.byteLength;
  sample[0] = (naluSize >>> 24) & 0xff;
  sample[1] = (naluSize >>> 16) & 0xff;
  sample[2] = (naluSize >>> 8) & 0xff;
  sample[3] = naluSize & 0xff;
  sample.set(nalu, 4);
  return sample;
}

function concatArrays(
  arrays: Uint8Array<ArrayBuffer>[],
): Uint8Array<ArrayBuffer> {
  let totalLength = 0;
  for (let index = 0; index < arrays.length; index++) {
    totalLength += arrays[index].byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (let index = 0; index < arrays.length; index++) {
    result.set(arrays[index], offset);
    offset += arrays[index].byteLength;
  }
  return result;
}
