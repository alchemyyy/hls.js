import { expect } from 'chai';
import { ElementaryStreamTypes } from '../../../src/loader/fragment';
import MP4 from '../../../src/remux/mp4-generator';
import { ChunkMetadata } from '../../../src/types/transmuxer';
import { logger } from '../../../src/utils/logger';
import {
  appendUint8Array,
  findBox,
  getSampleData,
  parseInitSegment,
  remuxVideoOnlyIFrameMoof,
  repairVideoTimestampCollisions,
  types,
  videoOnlyInitSegment,
  writeUint32,
} from '../../../src/utils/mp4-tools';
import type { TrackFragmentSample } from '../../../src/remux/mp4-generator';
import type { InitData } from '../../../src/utils/mp4-tools';

describe('mp4-tools', function () {
  it('reads tfhd default sample duration and size in declaration order', function () {
    const sampleData = getSampleData(
      fragmentWithTfhdDefaults(
        0x000019,
        appendBytes(uint64(0), uint32(3003), uint32(1234)),
        1234,
      ),
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(sampleData[1].duration).to.equal(3003);
    expect(sampleData[1].trun[0].samples[0].size).to.equal(1234);
  });

  it('does not treat trex default sample flags as tfhd field flags', function () {
    const data = initData();
    data[1]!.default!.flags = 0x00010001;

    const sampleData = getSampleData(
      fragmentWithTfhdDefaults(
        0x000018,
        appendBytes(uint32(3003), uint32(1234)),
        1234,
      ),
      data,
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(sampleData[1].duration).to.equal(3003);
    expect(sampleData[1].trun[0].samples[0].size).to.equal(1234);
  });

  it('parses trun entries beyond a truncated mdat without losing alignment', function () {
    // A byte-range addressed I-Frame request loads a moof declaring the whole
    // GOP with only the first sample's data present in the mdat slice.
    const fragment = gopFragment();
    const truncated = fragment.subarray(0, fragment.byteLength - 50);

    const sampleData = getSampleData(
      truncated,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    const track = sampleData[1];
    // All declared sample durations parse correctly (per-sample flags and
    // composition offsets of out-of-range samples must be skipped)
    expect(track.duration).to.equal(1001 + 2002 + 3003);
    expect(track.sampleCount).to.equal(3);
    // Only the sample whose data is within the loaded range is captured
    expect(track.trun[0].samples).to.have.lengthOf(1);
    expect(track.trun[0].samples[0]).to.deep.include({
      duration: 1001,
      size: 10,
      cts: 500,
    });
    expect(track.ptsMax).to.equal(500 + 1001);
  });

  it('repairs a segment-opening video PTS collision using the missing frame interval', function () {
    const fragment = timestampCollisionFragment(1984);
    const parsedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(parsedSamples[1].trun[0].samples[0].cts).to.equal(1984);
    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[1], 4000, logger),
    ).to.equal(true);

    const repairedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );
    expect(repairedSamples[1].trun[0].samples[0].cts).to.equal(4000);
  });

  it('does not rewrite a segment-opening video PTS without a collision', function () {
    const fragment = timestampCollisionFragment(6000);
    const parsedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[1], 4000, logger),
    ).to.equal(false);
    expect(parsedSamples[1].trun[0].samples[0].cts).to.equal(6000);
  });

  it('leaves valid H.264 open-GOP presentation reordering unchanged', function () {
    const fragment = timingFragment(
      [6006, 0, 3003, 15015, 9009, 12012, 24024, 18018, 21021],
      new Array<number>(9).fill(3003),
    );

    expectNoTimestampRepair(fragment, initData('avc1.640028', 90000), 1, 6006);
  });

  it('leaves valid HEVC CRA and RASL presentation reordering unchanged', function () {
    const fragment = timingFragment(
      [12000, 0, 3000, 6000, 9000, 27000, 15000, 18000, 21000, 24000],
      new Array<number>(10).fill(3000),
    );

    expectNoTimestampRepair(
      fragment,
      initData('hvc1.1.6.L120.B0', 90000),
      1,
      12000,
    );
  });

  it('leaves variable-frame-rate presentation timing unchanged', function () {
    const fragment = timingFragment(
      [80, 0, 40, 260, 160, 200],
      [40, 40, 80, 40, 60, 20],
    );

    expectNoTimestampRepair(fragment, initData('avc1.640028', 1000), 1, 80);
  });

  it('leaves deep B-frame presentation reordering unchanged', function () {
    const fragment = timingFragment(
      [
        7000, 0, 1000, 2000, 3000, 4000, 5000, 6000, 15000, 8000, 9000, 10000,
        11000, 12000, 13000, 14000,
      ],
      new Array<number>(16).fill(1000),
    );

    expectNoTimestampRepair(fragment, initData(), 1, 7000);
  });

  it('does not infer a missing frame from small-timescale rounding alone', function () {
    const fragment = timingFragment(
      [100, 108, 141, 175, 208, 242],
      [33, 34, 33, 34, 33, 34],
    );

    expectNoTimestampRepair(fragment, initData('avc1.640028', 1000), 1, 167);
  });

  it('does not repair an exact duplicate PTS without a missing interval', function () {
    const fragment = timingFragment(
      [4000, 4000, 5000, 6000, 7000, 8000],
      new Array<number>(6).fill(1000),
    );

    expectNoTimestampRepair(fragment, initData(), 1, 6000);
  });

  it('does not repair a PTS interval explained by a long-duration sample', function () {
    const fragment = timingFragment(
      [4000, 4000, 5000, 8000, 7000, 9000],
      [1000, 1000, 2000, 1000, 1000, 1000],
    );

    expectNoTimestampRepair(fragment, initData(), 1, 6000);
  });

  it('repairs quantized open-GOP timing when decode and presentation duration order differ', function () {
    const fragment = timingFragment(
      [2672, 2688, 3360, 6016, 4688, 5360, 8032, 6688, 7360, 10032, 8688, 9360],
      [688, 656, 672, 672, 672, 656, 672, 672, 656, 672, 672, 672],
    );
    const parsedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[1], 4016, logger),
    ).to.equal(true);
  });

  it('does not repair a collision on a non-sync opening sample', function () {
    const samples = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    samples[0].flags.isNonSync = 1;
    const fragment = fragmentFromSamples(samples);

    expectNoTimestampRepair(fragment, initData(), 1, 4000);
  });

  it('does not repair an opening sample that depends on another sample', function () {
    const samples = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    samples[0].flags.dependsOn = 1;
    const fragment = fragmentFromSamples(samples);

    expectNoTimestampRepair(fragment, initData(), 1, 4000);
  });

  it('uses first_sample_flags before fragment defaults', function () {
    const samples = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    const fragment = timedFlagFragment(
      samples,
      false,
      sampleFlags(2, 0),
      sampleFlags(1, 0),
    );
    const parsedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[1], 4000, logger),
    ).to.equal(true);
  });

  it('uses tfhd default_sample_flags before trex defaults', function () {
    const samples = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    const fragment = timedFlagFragment(
      samples,
      false,
      undefined,
      sampleFlags(2, 0),
    );
    const data = initData();
    data[1]!.default!.flags = sampleFlags(1, 0);
    const parsedSamples = getSampleData(
      fragment,
      data,
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[1], 4000, logger),
    ).to.equal(true);
  });

  it('uses trex default_sample_flags when fragment flags are absent', function () {
    const samples = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    const fragment = timedFlagFragment(samples, false);
    const data = initData();
    data[1]!.default!.flags = sampleFlags(1, 0);

    expectNoTimestampRepair(fragment, data, 1, 4000);
  });

  it('uses per-sample flags before fragment defaults', function () {
    const samples = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    const fragment = timedFlagFragment(
      samples,
      true,
      undefined,
      sampleFlags(1, 0),
    );
    const parsedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[1], 4000, logger),
    ).to.equal(true);
  });

  it('does not infer corruption from VFR near-collisions and gaps', function () {
    const fragment = timingFragment(
      [100, 108, 141, 240, 207, 273],
      new Array<number>(6).fill(33),
    );

    expectNoTimestampRepair(fragment, initData('avc1.640028', 1000), 1, 174);
  });

  it('repairs opening-collision evidence split across multiple truns', function () {
    const firstRun = timingSamples(
      [1984, 2000],
      new Array<number>(2).fill(1000),
    );
    const secondRun = timingSamples(
      [0, 1000, 3000, 5000],
      new Array<number>(4).fill(1000),
      2000,
    );
    const fragment = timedTrackFragment([[...firstRun], [...secondRun]]);
    const parsedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[1], 4000, logger),
    ).to.equal(true);

    const repairedSamples = getSampleData(
      fragment,
      initData(),
      new ChunkMetadata(0, 0, 0),
      logger,
    );
    expect(repairedSamples[1].trun[0].samples[0].cts).to.equal(4000);
  });

  it('does not treat a later trun as the fragment opening', function () {
    const firstRun = timingSamples(
      [0, 1000, 2000],
      new Array<number>(3).fill(1000),
    );
    const laterRun = timingSamples(
      [6984, 7000, 8000, 11000, 10000, 12000],
      new Array<number>(6).fill(1000),
      3000,
    );
    const fragment = timedTrackFragment([[...firstRun], [...laterRun]]);

    expectNoTimestampRepair(fragment, initData(), 1, 4000);
  });

  it('does not treat a second same-track traf as the fragment opening', function () {
    const openingTrackFragment = timingSamples(
      [0, 1000, 2000],
      new Array<number>(3).fill(1000),
    );
    const laterTrackFragment = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    const fragment = timedFragment([
      timedTraf(1, [openingTrackFragment]),
      timedTraf(1, [laterTrackFragment]),
    ]);

    expectNoTimestampRepair(fragment, initData(), 1, 4000);
  });

  it('repairs the first video trun when an audio traf precedes it', function () {
    const audioSamples = timingSamples(
      [0, 1024, 2048],
      new Array<number>(3).fill(1024),
    );
    const videoSamples = timingSamples(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    const fragment = timedFragment([
      timedTraf(1, [audioSamples]),
      timedTraf(2, [videoSamples]),
    ]);
    const data = initData('avc1.640028', 90000, 2);
    data[1] = {
      timescale: 48000,
      type: ElementaryStreamTypes.AUDIO,
      stsd: {
        codec: 'mp4a.40.2',
        encrypted: false,
        supplemental: undefined,
      },
    };
    const parsedSamples = getSampleData(
      fragment,
      data,
      new ChunkMetadata(0, 0, 0),
      logger,
    );

    expect(
      repairVideoTimestampCollisions(fragment, parsedSamples[2], 4000, logger),
    ).to.equal(true);

    const repairedSamples = getSampleData(
      fragment,
      data,
      new ChunkMetadata(0, 0, 0),
      logger,
    );
    expect(repairedSamples[2].trun[0].samples[0].cts).to.equal(4000);
  });

  it('does not repair collision-shaped timing on an audio track', function () {
    const fragment = timingFragment(
      [1984, 2000, 0, 1000, 3000, 5000],
      new Array<number>(6).fill(1000),
    );
    const data = initData('mp4a.40.2', 48000);
    data[1]!.type = ElementaryStreamTypes.AUDIO;

    expectNoTimestampRepair(fragment, data, 1, 4000);
  });

  it('remuxVideoOnlyIFrameMoof truncates a partial mdat to the kept samples', function () {
    const fragment = gopFragment();
    const mdatPayloadOffset = fragment.byteLength - 60;

    const result = remuxVideoOnlyIFrameMoof(
      fragment,
      1,
      1,
      mdatPayloadOffset + 10,
      undefined,
    );

    expect(result, 'result').to.not.equal(null);
    // The kept stream ends on the rewritten mdat box boundary
    expect(result!.byteLength, 'kept length').to.equal(mdatPayloadOffset + 10);
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])[0];
    expect(readUint32(trun, 4), 'trun sample_count').to.equal(1);
    expect(
      readUint32(fragment, mdatPayloadOffset - 8),
      'mdat box size',
    ).to.equal(18);
  });

  it('remuxVideoOnlyIFrameMoof distributes the kept count across runs', function () {
    const fragment = multiRunIFrameMoof();
    const mdatPayloadOffset = fragment.byteLength - 60;

    const result = remuxVideoOnlyIFrameMoof(
      fragment,
      1,
      3,
      mdatPayloadOffset + 25,
      undefined,
    );

    expect(result!.byteLength, 'kept length').to.equal(mdatPayloadOffset + 25);
    const truns = findBox(fragment, ['moof', 'traf', 'trun']);
    expect(readUint32(truns[0], 4), 'first run count').to.equal(2);
    expect(readUint32(truns[1], 4), 'second run count').to.equal(1);
    // Boxes shrink to their kept count (Safari rejects oversized truns);
    // the tail bytes become a nested 'free' box
    expect(truns[0].byteLength, 'first run size').to.equal(20);
    expect(truns[1].byteLength, 'second run shrunk').to.equal(16);
    expect(indexOfFourcc(fragment, 'free')).to.be.greaterThan(0);
    const senc = findBox(fragment, ['moof', 'traf', 'senc'])[0];
    expect(readUint32(senc, 4), 'senc sample_count').to.equal(3);
    expect(
      readUint32(fragment, mdatPayloadOffset - 8),
      'mdat box size',
    ).to.equal(33);
  });

  it('remuxVideoOnlyIFrameMoof frees runs left without samples', function () {
    const fragment = multiRunIFrameMoof();
    const mdatPayloadOffset = fragment.byteLength - 60;

    remuxVideoOnlyIFrameMoof(fragment, 1, 1, mdatPayloadOffset + 10, undefined);

    // Parsers reject zero-sample truns, so the emptied run becomes 'free'
    const truns = findBox(fragment, ['moof', 'traf', 'trun']);
    expect(truns, 'remaining truns').to.have.lengthOf(1);
    expect(readUint32(truns[0], 4), 'first run count').to.equal(1);
    expect(indexOfFourcc(fragment, 'free')).to.be.greaterThan(0);
  });

  it('parses a single rate-1 edit-list media time', function () {
    const initSegment = addVideoEditList(
      MP4.initSegment([videoInitTrack(1)]),
      2672,
    );
    const parsed = parseInitSegment(initSegment);

    expect(parsed.video?.editListMediaTime).to.equal(2672);
    expect(parsed[1]?.editListMediaTime).to.equal(2672);
  });

  it('parses a version-1 single rate-1 edit-list media time', function () {
    const initSegment = addVideoEditList(
      MP4.initSegment([videoInitTrack(1)]),
      2672,
      1,
      1,
      1,
    );
    const parsed = parseInitSegment(initSegment);

    expect(parsed.video?.editListMediaTime).to.equal(2672);
    expect(parsed[1]?.editListMediaTime).to.equal(2672);
  });

  it('rejects edit lists that cannot map playlist time directly', function () {
    const baseInitSegment = MP4.initSegment([videoInitTrack(1)]);
    const invalidInitSegments = [
      addVideoEditList(baseInitSegment, -1),
      addVideoEditList(baseInitSegment, 2672, 2),
      addVideoEditList(baseInitSegment, 2672, 1, 0),
      addVideoEditList(baseInitSegment, 2 ** 32, 1, 1, 1),
    ];

    for (
      let segmentIndex = 0;
      segmentIndex < invalidInitSegments.length;
      segmentIndex++
    ) {
      const parsed = parseInitSegment(invalidInitSegments[segmentIndex]);
      expect(parsed.video?.editListMediaTime).to.equal(undefined);
      expect(parsed[1]?.editListMediaTime).to.equal(undefined);
    }
  });

  it('videoOnlyInitSegment removes non-video tracks and patches box sizes', function () {
    const muxed = MP4.initSegment([
      videoInitTrack(1),
      audioInitTrack(2),
    ] as any);
    const muxedParsed = parseInitSegment(muxed);
    expect(muxedParsed.audio, 'muxed audio').to.exist;
    expect(muxedParsed.video, 'muxed video').to.exist;

    const filtered = videoOnlyInitSegment(muxed);
    expect(filtered, 'filtered').to.not.equal(null);
    expect(filtered!.byteLength).to.be.lessThan(muxed.byteLength);
    const parsed = parseInitSegment(filtered!);
    expect(parsed.video, 'video track').to.exist;
    expect(parsed.audio, 'audio track').to.equal(undefined);
    expect(findBox(filtered!, ['moov', 'trak'])).to.have.lengthOf(1);
    expect(findBox(filtered!, ['moov', 'mvex', 'trex'])).to.have.lengthOf(1);

    // Nothing to remove from a video-only init
    expect(videoOnlyInitSegment(filtered!)).to.equal(null);
  });

  it('remuxVideoOnlyIFrameMoof removes non-video track fragments and patches offsets', function () {
    const fragment = muxedIFrameMoof(1, 2);
    const audioTrafSize = trafSize(fragment, 2);
    const sencOffset = indexOfFourcc(fragment, 'senc');
    const moofSize = readUint32(fragment, 0);

    const result = remuxVideoOnlyIFrameMoof(
      fragment,
      1,
      2,
      undefined,
      undefined,
    );

    expect(result, 'result').to.not.equal(null);
    expect(result!.byteLength).to.equal(fragment.byteLength - audioTrafSize);
    expect(findBox(result!, ['moof', 'traf'])).to.have.lengthOf(1);
    expect(readUint32(result!, 0), 'moof size').to.equal(
      moofSize - audioTrafSize,
    );
    const trun = findBox(result!, ['moof', 'traf', 'trun'])[0];
    expect(readUint32(trun, 8), 'trun data_offset').to.equal(
      1000 - audioTrafSize,
    );
    // The video traf did not move, so its interior is untouched
    expect(indexOfFourcc(result!, 'senc')).to.equal(sencOffset);
    const saio = findBox(result!, ['moof', 'traf', 'saio'])[0];
    expect(readUint32(saio, 8), 'saio offset').to.equal(0x99);
    expect(indexOfFourcc(result!, 'mdat')).to.be.greaterThan(0);
  });

  it('remuxVideoOnlyIFrameMoof shifts video traf offsets when it follows a dropped traf', function () {
    const fragment = muxedIFrameMoof(2, 1);
    const audioTrafSize = trafSize(fragment, 2);

    const result = remuxVideoOnlyIFrameMoof(
      fragment,
      1,
      2,
      undefined,
      undefined,
    );

    expect(result, 'result').to.not.equal(null);
    expect(findBox(result!, ['moof', 'traf'])).to.have.lengthOf(1);
    const trun = findBox(result!, ['moof', 'traf', 'trun'])[0];
    expect(readUint32(trun, 8), 'trun data_offset').to.equal(
      1030 - audioTrafSize,
    );
    // saio points at the senc payload, which moved up with the traf
    const saio = findBox(result!, ['moof', 'traf', 'saio'])[0];
    expect(readUint32(saio, 8), 'saio offset').to.equal(0x99 - audioTrafSize);
  });

  it('remuxVideoOnlyIFrameMoof drops non-video trafs and truncates in one pass', function () {
    const fragment = muxedIFrameMoof(1, 2);
    const audioTrafSize = trafSize(fragment, 2);
    const mdatPayloadOffset = fragment.byteLength - 60;

    // Keep 1 of the video traf's 2 samples while excising the audio traf
    const result = remuxVideoOnlyIFrameMoof(
      fragment,
      1,
      1,
      mdatPayloadOffset + 10,
      undefined,
    );

    expect(result, 'result').to.not.equal(null);
    // Length reflects both the excised audio traf and the truncated mdat tail
    expect(result!.byteLength).to.equal(mdatPayloadOffset + 10 - audioTrafSize);
    expect(findBox(result!, ['moof', 'traf']), 'trafs').to.have.lengthOf(1);
    const trun = findBox(result!, ['moof', 'traf', 'trun'])[0];
    expect(readUint32(trun, 4), 'trun sample_count').to.equal(1);
    const senc = findBox(result!, ['moof', 'traf', 'senc'])[0];
    expect(readUint32(senc, 4), 'senc sample_count').to.equal(1);
  });

  it('remuxVideoOnlyIFrameMoof stretches the last sample duration', function () {
    const fragment = gopFragment();
    const trun = findBox(fragment, ['moof', 'traf', 'trun'])[0];
    // Per-sample layout is data-offset + duration/size/flags/cts (4 words each);
    // the third sample's duration sits after 2 samples of 16 bytes
    const durationOffset =
      trun.byteOffset - fragment.byteOffset + 4 + 4 + 4 + 2 * 16;

    const result = remuxVideoOnlyIFrameMoof(fragment, 1, 3, undefined, {
      durationOffset,
      value: 5005,
    });

    expect(result, 'result').to.not.equal(null);
    expect(readUint32(fragment, durationOffset), 'last duration').to.equal(
      5005,
    );
  });

  it('remuxVideoOnlyIFrameMoof returns null without moof-relative data offsets', function () {
    expect(
      remuxVideoOnlyIFrameMoof(
        muxedIFrameMoof(1, 2, false),
        1,
        2,
        undefined,
        undefined,
      ),
    ).to.equal(null);
  });
});

// Track fragment with per-sample sizes and senc/saio (one aux info offset)
function cryptoTraf(
  trackId: number,
  tfhdFlags: number,
  dataOffset: number,
): Uint8Array {
  return MP4.box(
    types.traf,
    MP4.box(
      types.tfhd,
      appendBytes(fullBoxHeader(tfhdFlags), uint32(trackId), uint32(1001)),
    ),
    MP4.box(
      types.trun,
      appendBytes(
        fullBoxHeader(0x201),
        uint32(2),
        uint32(dataOffset),
        uint32(10),
        uint32(20),
      ),
    ),
    MP4.box(
      0x73656e63, // 'senc'
      appendBytes(fullBoxHeader(0), uint32(2), uint32(0x11223344)),
    ),
    MP4.box(
      0x7361696f, // 'saio'
      appendBytes(fullBoxHeader(0), uint32(1), uint32(0x99)),
    ),
  );
}

// moof with two encrypted track fragments followed by an mdat
function muxedIFrameMoof(
  firstTrackId: number,
  secondTrackId: number,
  baseIsMoof: boolean = true,
): Uint8Array<ArrayBuffer> {
  const tfhdFlags = (baseIsMoof ? 0x020000 : 0) | 0x000008;
  const moof = MP4.box(
    types.moof,
    MP4.box(types.mfhd, appendBytes(fullBoxHeader(0), uint32(1))),
    cryptoTraf(firstTrackId, tfhdFlags, 1000),
    cryptoTraf(secondTrackId, tfhdFlags, 1030),
  );
  return appendUint8Array(moof, MP4.mdat(new Uint8Array(60)));
}

// moof with one track fragment holding two runs (2 + 3 samples) and a senc
function multiRunIFrameMoof(): Uint8Array<ArrayBuffer> {
  const traf = MP4.box(
    types.traf,
    MP4.box(
      types.tfhd,
      appendBytes(fullBoxHeader(0x020008), uint32(1), uint32(1001)),
    ),
    MP4.box(
      types.trun,
      appendBytes(
        fullBoxHeader(0x201),
        uint32(2),
        uint32(1000),
        uint32(10),
        uint32(15),
      ),
    ),
    MP4.box(
      types.trun,
      appendBytes(
        fullBoxHeader(0x201),
        uint32(3),
        uint32(1050),
        uint32(5),
        uint32(5),
        uint32(5),
      ),
    ),
    MP4.box(
      0x73656e63, // 'senc'
      appendBytes(fullBoxHeader(0), uint32(5), uint32(0x11223344)),
    ),
  );
  const moof = MP4.box(
    types.moof,
    MP4.box(types.mfhd, appendBytes(fullBoxHeader(0), uint32(1))),
    traf,
  );
  return appendUint8Array(moof, MP4.mdat(new Uint8Array(60)));
}

function trafSize(fragment: Uint8Array, trackId: number): number {
  const trafs = findBox(fragment, ['moof', 'traf']);
  for (let i = 0; i < trafs.length; i++) {
    const tfhd = findBox(trafs[i], ['tfhd'])[0];
    if (readUint32(tfhd, 4) === trackId) {
      return trafs[i].byteLength + 8;
    }
  }
  return 0;
}

function indexOfFourcc(data: Uint8Array, fourcc: string): number {
  for (let i = 0; i < data.byteLength - 3; i++) {
    if (
      data[i] === fourcc.charCodeAt(0) &&
      data[i + 1] === fourcc.charCodeAt(1) &&
      data[i + 2] === fourcc.charCodeAt(2) &&
      data[i + 3] === fourcc.charCodeAt(3)
    ) {
      return i;
    }
  }
  return -1;
}

function videoInitTrack(id: number): any {
  return {
    codec: 'avc1.42001e',
    segmentCodec: 'avc',
    duration: 4,
    id,
    pixelRatio: [1, 1],
    pps: [new Uint8Array([0x68, 0xce, 0x06, 0xe2])],
    sps: [new Uint8Array([0x67, 0x42, 0x00, 0x1e, 0xab, 0x40])],
    timescale: 90000,
    type: 'video',
    width: 16,
    height: 16,
  };
}

function audioInitTrack(id: number): any {
  return {
    codec: 'mp4a.40.2',
    segmentCodec: 'aac',
    channelCount: 2,
    samplerate: 48000,
    config: [0x11, 0x90],
    duration: 4,
    id,
    timescale: 48000,
    type: 'audio',
  };
}

function addVideoEditList(
  initSegment: Uint8Array<ArrayBuffer>,
  mediaTime: number,
  entryCount: number = 1,
  mediaRateInteger: number = 1,
  version: 0 | 1 = 0,
): Uint8Array<ArrayBuffer> {
  const editListFields: Uint8Array[] = [];
  editListFields.push(fullBoxHeader(0, version));
  editListFields.push(uint32(entryCount));
  switch (version) {
    case 0:
      editListFields.push(uint32(0));
      editListFields.push(uint32(mediaTime));
      break;
    case 1:
      editListFields.push(uint64(0));
      editListFields.push(uint64(mediaTime));
      break;
  }
  editListFields.push(
    new Uint8Array([
      (mediaRateInteger >>> 8) & 0xff,
      mediaRateInteger & 0xff,
      0,
      0,
    ]),
  );
  const editList = MP4.box(
    0x65647473, // 'edts'
    MP4.box(0x656c7374, appendBytes(...editListFields)), // 'elst'
  );
  const movie = findBox(initSegment, ['moov'])[0];
  const track = findBox(initSegment, ['moov', 'trak'])[0];
  const movieBoxOffset = movie.byteOffset - initSegment.byteOffset - 8;
  const trackBoxOffset = track.byteOffset - initSegment.byteOffset - 8;
  const insertionOffset = track.byteOffset - initSegment.byteOffset;
  const result = new Uint8Array(initSegment.byteLength + editList.byteLength);
  result.set(initSegment.subarray(0, insertionOffset), 0);
  result.set(editList, insertionOffset);
  result.set(
    initSegment.subarray(insertionOffset),
    insertionOffset + editList.byteLength,
  );
  writeUint32(
    result,
    movieBoxOffset,
    readUint32(initSegment, movieBoxOffset) + editList.byteLength,
  );
  writeUint32(
    result,
    trackBoxOffset,
    readUint32(initSegment, trackBoxOffset) + editList.byteLength,
  );
  return result;
}

// moof + mdat with three samples (per-sample duration, size, flags and cts)
// of sizes 10/20/30
function gopFragment(): Uint8Array<ArrayBuffer> {
  const samples: TrackFragmentSample[] = [
    gopSample(1001, 10, 500),
    gopSample(2002, 20, 0),
    gopSample(3003, 30, 250),
  ];
  return appendUint8Array(
    MP4.moof(0, 0, { type: 'video', id: 1, samples }),
    MP4.mdat(new Uint8Array(60)),
  );
}

function timestampCollisionFragment(
  firstPresentationTime: number,
): Uint8Array<ArrayBuffer> {
  return timingFragment(
    [firstPresentationTime, 2000, 0, 1000, 3000, 5000],
    new Array<number>(6).fill(1000),
  );
}

function timingFragment(
  presentationTimes: number[],
  durations: number[],
): Uint8Array<ArrayBuffer> {
  return fragmentFromSamples(timingSamples(presentationTimes, durations));
}

function timingSamples(
  presentationTimes: number[],
  durations: number[],
  initialDecodeTime: number = 0,
): TrackFragmentSample[] {
  expect(presentationTimes).to.have.lengthOf(durations.length);
  const samples: TrackFragmentSample[] = [];
  let decodeTime = initialDecodeTime;
  for (
    let sampleIndex = 0;
    sampleIndex < presentationTimes.length;
    sampleIndex++
  ) {
    const duration = durations[sampleIndex];
    samples.push(
      gopSample(
        duration,
        10,
        presentationTimes[sampleIndex] - decodeTime,
        sampleIndex === 0 ? 0 : 1,
      ),
    );
    decodeTime += duration;
  }
  return samples;
}

function fragmentFromSamples(
  samples: TrackFragmentSample[],
): Uint8Array<ArrayBuffer> {
  const mediaDataSize = samples.reduce(
    (totalSize, sample) => totalSize + sample.size,
    0,
  );
  return appendUint8Array(
    MP4.moof(0, 0, { type: 'video', id: 1, samples }),
    MP4.mdat(new Uint8Array(mediaDataSize)),
  );
}

function timedTrackFragment(
  runs: TrackFragmentSample[][],
): Uint8Array<ArrayBuffer> {
  return timedFragment([timedTraf(1, runs)]);
}

function timedFragment(trafs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const moofChildren: Uint8Array[] = [];
  moofChildren.push(
    MP4.box(types.mfhd, appendBytes(fullBoxHeader(0), uint32(1))),
  );
  for (let trafIndex = 0; trafIndex < trafs.length; trafIndex++) {
    moofChildren.push(trafs[trafIndex]);
  }
  const moof = MP4.box(types.moof, ...moofChildren);
  return appendUint8Array(moof, MP4.mdat(new Uint8Array(1024)));
}

function timedTraf(trackId: number, runs: TrackFragmentSample[][]): Uint8Array {
  const trafChildren: Uint8Array[] = [];
  trafChildren.push(
    MP4.box(types.tfhd, appendBytes(fullBoxHeader(0x020000), uint32(trackId))),
  );
  trafChildren.push(
    MP4.box(types.tfdt, appendBytes(fullBoxHeader(0), uint32(0))),
  );
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    trafChildren.push(timedTrun(runs[runIndex]));
  }
  return MP4.box(types.traf, ...trafChildren);
}

function timedFlagFragment(
  samples: TrackFragmentSample[],
  includeSampleFlags: boolean,
  firstSampleFlags?: number,
  defaultSampleFlags?: number,
): Uint8Array<ArrayBuffer> {
  const trackFragmentHeaderFlags =
    0x020000 | (defaultSampleFlags === undefined ? 0 : 0x000020);
  const trackFragmentHeaderFields: Uint8Array[] = [];
  trackFragmentHeaderFields.push(fullBoxHeader(trackFragmentHeaderFlags));
  trackFragmentHeaderFields.push(uint32(1));
  if (defaultSampleFlags !== undefined) {
    trackFragmentHeaderFields.push(uint32(defaultSampleFlags));
  }
  const trackFragment = MP4.box(
    types.traf,
    MP4.box(types.tfhd, appendBytes(...trackFragmentHeaderFields)),
    MP4.box(types.tfdt, appendBytes(fullBoxHeader(0), uint32(0))),
    timedTrun(samples, includeSampleFlags, firstSampleFlags),
  );
  return timedFragment([trackFragment]);
}

function timedTrun(
  samples: TrackFragmentSample[],
  includeSampleFlags: boolean = true,
  firstSampleFlags?: number,
): Uint8Array {
  const trackRunFlags =
    0x000b01 |
    (includeSampleFlags ? 0x000400 : 0) |
    (firstSampleFlags === undefined ? 0 : 0x000004);
  const trunFields: Uint8Array[] = [];
  trunFields.push(fullBoxHeader(trackRunFlags, 1));
  trunFields.push(uint32(samples.length));
  trunFields.push(uint32(0));
  if (firstSampleFlags !== undefined) {
    trunFields.push(uint32(firstSampleFlags));
  }
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const sample = samples[sampleIndex];
    trunFields.push(uint32(sample.duration));
    trunFields.push(uint32(sample.size));
    if (includeSampleFlags) {
      trunFields.push(uint32(sampleFlagsFromSample(sample)));
    }
    trunFields.push(uint32(sample.cts));
  }
  return MP4.box(types.trun, appendBytes(...trunFields));
}

function sampleFlagsFromSample(sample: TrackFragmentSample): number {
  return (
    (sample.flags.isLeading << 26) |
    (sample.flags.dependsOn << 24) |
    (sample.flags.isDependedOn << 22) |
    (sample.flags.hasRedundancy << 20) |
    (sample.flags.paddingValue << 17) |
    (sample.flags.isNonSync << 16) |
    sample.flags.degradPrio
  );
}

function sampleFlags(dependsOn: 1 | 2, isNonSync: 0 | 1): number {
  return (dependsOn << 24) | (isNonSync << 16);
}

function expectNoTimestampRepair(
  fragment: Uint8Array<ArrayBuffer>,
  data: InitData,
  trackId: number,
  expectedPresentationTime: number,
): void {
  const originalFragment = fragment.slice();
  const parsedSamples = getSampleData(
    fragment,
    data,
    new ChunkMetadata(0, 0, 0),
    logger,
  );

  expect(
    repairVideoTimestampCollisions(
      fragment,
      parsedSamples[trackId],
      expectedPresentationTime,
      logger,
    ),
  ).to.equal(false);
  expect(fragment).to.deep.equal(originalFragment);
}

function gopSample(
  duration: number,
  size: number,
  cts: number,
  isNonSync: 0 | 1 = 0,
): TrackFragmentSample {
  return {
    cts,
    duration,
    size,
    flags: {
      degradPrio: 0,
      dependsOn: 2,
      hasRedundancy: 0,
      isDependedOn: 0,
      isLeading: 0,
      isNonSync,
      paddingValue: 0,
    },
  };
}

function readUint32(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]) >>>
    0
  );
}

function initData(
  codec: string = 'avc1.42001e',
  timescale: number = 90000,
  trackId: number = 1,
): InitData {
  const data = [] as unknown as InitData;
  data[trackId] = {
    timescale,
    type: ElementaryStreamTypes.VIDEO,
    stsd: {
      codec,
      encrypted: false,
      supplemental: undefined,
    },
    default: {
      duration: 1001,
      sampleSize: 0,
      flags: 0,
    },
  };
  return data;
}

function fragmentWithTfhdDefaults(
  tfhdFlags: number,
  tfhdFields: Uint8Array,
  mdatSize: number,
): Uint8Array<ArrayBuffer> {
  const moof = MP4.box(
    types.moof,
    MP4.box(types.mfhd, appendBytes(uint32(0), uint32(1))),
    MP4.box(
      types.traf,
      MP4.box(
        types.tfhd,
        appendBytes(fullBoxHeader(tfhdFlags), uint32(1), tfhdFields),
      ),
      MP4.box(types.tfdt, appendBytes(uint32(0), uint32(0))),
      MP4.box(types.trun, appendBytes(fullBoxHeader(0), uint32(1))),
    ),
  );
  return appendUint8Array(moof, MP4.mdat(new Uint8Array(mdatSize)));
}

function fullBoxHeader(flags: number, version: number = 0): Uint8Array {
  return new Uint8Array([
    version,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ]);
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function uint64(value: number): Uint8Array {
  return appendBytes(uint32(Math.floor(value / 2 ** 32)), uint32(value));
}

function appendBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return arrays.reduce(
    (result, data) => appendUint8Array(result, data),
    new Uint8Array(0),
  ) as Uint8Array<ArrayBuffer>;
}
