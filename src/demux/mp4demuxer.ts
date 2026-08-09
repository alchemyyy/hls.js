/**
 * MP4 demuxer
 */
import { dummyTrack } from './dummy-demuxed-track';
import {
  type DemuxedAudioTrack,
  type DemuxedMetadataTrack,
  type DemuxedUserdataTrack,
  type Demuxer,
  type DemuxerResult,
  type KeyData,
  MetadataSchema,
  type PassthroughTrack,
} from '../types/demuxer';
import { logger as defaultLogger } from '../utils/logger';
import {
  appendUint8Array,
  findBox,
  hasBoxData,
  isHEVC,
  parseEmsg,
  parseInitSegment,
  parseSamples,
  parseSamplesAndTiming,
  parseSEIFromSample,
  RemuxerTrackIdConfig,
  segmentValidRange,
} from '../utils/mp4-tools';
import type { HlsConfig } from '../config';
import type { HlsEventEmitter } from '../events';
import type { ChunkMetadata } from '../types/transmuxer';
import type { ILogger } from '../utils/logger';
import type {
  IEmsgParsingData,
  InitData,
  ParsedSampleData,
  ProgressiveVideoSample,
} from '../utils/mp4-tools';

const emsgSchemePattern = /\/emsg[-/]ID3/i;

class MP4Demuxer implements Demuxer {
  private remainderData: Uint8Array<ArrayBuffer> | null = null;
  // Partial mdat state lets MSE consume bounded network chunks without
  // buffering the complete media segment in the transmuxer
  private progressiveMdatPending: boolean = false;
  private progressiveMdatEnd: number = 0;
  private progressiveSampleData?: ParsedSampleData;
  private progressiveSamples: ProgressiveVideoSample[] = [];
  private progressiveSampleIndex: number = 0;
  private progressiveSampleParts: Uint8Array<ArrayBuffer>[] = [];
  private progressiveSamplePartsLength: number = 0;
  private progressiveSampleSkipped: boolean = false;
  private progressiveOffset: number = 0;
  private progressiveIsHEVC: boolean = false;
  private timeOffset: number = 0;
  private config: HlsConfig;
  private videoTrack?: PassthroughTrack;
  private audioTrack?: DemuxedAudioTrack;
  private id3Track?: DemuxedMetadataTrack;
  private txtTrack?: DemuxedUserdataTrack;
  private initData?: InitData;
  private logger: ILogger;

  constructor(
    observer: HlsEventEmitter,
    config: HlsConfig,
    typeSupported?: unknown,
    logger: ILogger = defaultLogger,
  ) {
    this.config = config;
    this.logger = logger;
  }

  public resetTimeStamp() {}

  public resetInitSegment(
    initSegment: Uint8Array | undefined,
    audioCodec: string | undefined,
    videoCodec: string | undefined,
    trackDuration: number,
  ) {
    this.resetProgressiveState();
    const videoTrack = (this.videoTrack = dummyTrack(
      'video',
      1,
    ) as PassthroughTrack);
    const audioTrack = (this.audioTrack = dummyTrack(
      'audio',
      1,
    ) as DemuxedAudioTrack);
    const captionTrack = (this.txtTrack = dummyTrack(
      'text',
      1,
    ) as DemuxedUserdataTrack);

    this.id3Track = dummyTrack('id3', 1) as DemuxedMetadataTrack;
    this.initData = undefined;
    this.timeOffset = 0;

    if (!initSegment?.byteLength) {
      return;
    }
    const initData = (this.initData = parseInitSegment(initSegment));

    if (initData.video) {
      const { id, timescale, codec, supplemental } = initData.video;
      videoTrack.id = id;
      videoTrack.timescale = captionTrack.timescale = timescale;
      videoTrack.codec = codec;
      videoTrack.supplemental = supplemental;
    }

    if (initData.audio) {
      const { id, timescale, codec } = initData.audio;
      audioTrack.id = id;
      audioTrack.timescale = timescale;
      audioTrack.codec = codec;
    }

    captionTrack.id = RemuxerTrackIdConfig.text;
    videoTrack.sampleDuration = 0;
    videoTrack.duration = audioTrack.duration = trackDuration;
  }

  public resetContiguity(): void {
    this.resetProgressiveState();
  }

  static probe(data: Uint8Array) {
    return hasBoxData(data, 'moof');
  }

  public demux(
    data: Uint8Array<ArrayBuffer>,
    timeOffset: number,
    chunkMeta?: ChunkMetadata,
  ): DemuxerResult {
    this.timeOffset = timeOffset;
    // Load all data into the avc track. The CMAF remuxer will look for the data in the samples object; the rest of the fields do not matter
    let videoSamples = data;
    const videoTrack = this.videoTrack as PassthroughTrack;
    const textTrack = this.txtTrack as DemuxedUserdataTrack;
    let parseFragment = true;
    if (this.config.progressive) {
      if (this.progressiveMdatPending) {
        // Do not include bytes from the next top-level box in this pair
        const remainingMdatLength = Math.max(
          this.progressiveMdatEnd - this.progressiveOffset,
          0,
        );
        const outputLength = Math.min(data.byteLength, remainingMdatLength);
        videoTrack.samples =
          outputLength === data.byteLength ? data : data.slice(0, outputLength);
        if (outputLength < data.byteLength) {
          this.remainderData = data.slice(outputLength);
        }
        textTrack.samples = this.consumeProgressiveSamples(
          videoTrack.samples,
          true,
        );
        if (this.progressiveOffset >= this.progressiveMdatEnd) {
          this.progressiveMdatPending = false;
        }
        parseFragment = false;
      } else {
        // Hold box headers until a complete moof and mdat header can be parsed
        if (this.remainderData) {
          videoSamples = appendUint8Array(this.remainderData, data);
        }
        const allowIncompleteMdat =
          this.initData !== undefined &&
          chunkMeta !== undefined &&
          !chunkMeta.iframe;
        const segmentedData = segmentValidRange(
          videoSamples,
          allowIncompleteMdat,
        );
        this.remainderData = segmentedData.remainder;
        videoTrack.samples = segmentedData.valid || new Uint8Array();
        if (
          allowIncompleteMdat &&
          videoTrack.samples.byteLength > 0 &&
          segmentedData.mdatEnd !== null
        ) {
          this.resetProgressiveSampleState();
          this.progressiveMdatEnd = segmentedData.mdatEnd;
          this.progressiveMdatPending =
            this.progressiveMdatEnd > videoTrack.samples.byteLength;
        }
      }
    } else {
      videoTrack.samples = videoSamples;
    }
    const id3Track = parseFragment
      ? this.extractID3Track(videoTrack, timeOffset)
      : (this.id3Track as DemuxedMetadataTrack);
    const sampleData = parseFragment
      ? this.parseFragment(videoTrack, textTrack, timeOffset, chunkMeta)
      : this.progressiveSampleData;
    if (this.progressiveMdatPending && sampleData) {
      this.progressiveSampleData = sampleData;
    }

    return {
      videoTrack,
      audioTrack: this.audioTrack as DemuxedAudioTrack,
      id3Track,
      textTrack: this.txtTrack as DemuxedUserdataTrack,
      initData: this.initData,
      sampleData,
    };
  }

  public flush(_timeOffset: number, chunkMeta?: ChunkMetadata) {
    const timeOffset = this.timeOffset;
    const videoTrack = this.videoTrack as PassthroughTrack;
    const textTrack = this.txtTrack as DemuxedUserdataTrack;
    videoTrack.samples = this.remainderData || new Uint8Array();
    this.remainderData = null;

    const id3Track = this.extractID3Track(videoTrack, this.timeOffset);
    const sampleData = this.parseFragment(
      videoTrack,
      textTrack,
      timeOffset,
      chunkMeta,
    );
    this.resetProgressiveState();

    return {
      videoTrack,
      audioTrack: dummyTrack() as DemuxedAudioTrack,
      id3Track,
      textTrack: dummyTrack() as DemuxedUserdataTrack,
      initData: this.initData,
      sampleData,
    };
  }

  private parseFragment(
    videoTrack: PassthroughTrack,
    textTrack: DemuxedUserdataTrack,
    timeOffset: number,
    chunkMeta?: ChunkMetadata,
  ): ParsedSampleData | undefined {
    const initData = this.initData;
    if (initData && chunkMeta) {
      const includeProgressiveSamples =
        this.progressiveMdatPending && !initData.video?.encrypted;
      const { progressiveSamples, samples, sampleData } = parseSamplesAndTiming(
        timeOffset,
        videoTrack,
        initData,
        this.logger,
        __USE_IFRAMES__ && chunkMeta.iframe,
        includeProgressiveSamples,
      );
      textTrack.samples = samples;
      if (progressiveSamples) {
        this.initializeProgressiveSamples(progressiveSamples, videoTrack);
      }
      return sampleData;
    }
    textTrack.samples = parseSamples(timeOffset, videoTrack);
  }

  private resetProgressiveState(): void {
    this.remainderData = null;
    this.progressiveMdatPending = false;
    this.progressiveMdatEnd = 0;
    this.resetProgressiveSampleState();
  }

  private resetProgressiveSampleState(): void {
    this.progressiveSampleData = undefined;
    this.progressiveSamples = [];
    this.progressiveSampleIndex = 0;
    this.progressiveSampleParts = [];
    this.progressiveSamplePartsLength = 0;
    this.progressiveSampleSkipped = false;
    this.progressiveOffset = 0;
    this.progressiveIsHEVC = false;
  }

  private initializeProgressiveSamples(
    samples: ProgressiveVideoSample[],
    videoTrack: PassthroughTrack,
  ): void {
    // Complete samples were scanned above. Retain only an incomplete sample
    // prefix so that SEI messages split across network chunks are not lost
    const progressiveSamples: ProgressiveVideoSample[] = [];
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      if (
        Number.isSafeInteger(sample.start) &&
        Number.isSafeInteger(sample.end) &&
        sample.start >= 0 &&
        sample.end > sample.start
      ) {
        progressiveSamples.push(sample);
      }
    }
    progressiveSamples.sort((first, second) => first.start - second.start);
    this.progressiveSamples = progressiveSamples;
    this.progressiveIsHEVC = isHEVC(videoTrack.codec);
    this.consumeProgressiveSamples(videoTrack.samples, false);
  }

  private consumeProgressiveSamples(
    data: Uint8Array<ArrayBuffer>,
    parseCompletedSamples: boolean,
  ): DemuxedUserdataTrack['samples'] {
    const userdataSamples: DemuxedUserdataTrack['samples'] = [];
    const dataStart = this.progressiveOffset;
    const dataEnd = dataStart + data.byteLength;

    while (this.progressiveSampleIndex < this.progressiveSamples.length) {
      const sample = this.progressiveSamples[this.progressiveSampleIndex];
      if (sample.end <= dataStart) {
        this.resetProgressiveSampleParts();
        this.progressiveSampleIndex++;
        continue;
      }
      if (sample.start >= dataEnd) {
        break;
      }

      const overlapStart = Math.max(sample.start, dataStart);
      const overlapEnd = Math.min(sample.end, dataEnd);
      const dataOffset = overlapStart - dataStart;
      const overlapLength = overlapEnd - overlapStart;
      const completeSampleInData =
        overlapStart === sample.start && overlapEnd === sample.end;

      if (completeSampleInData && this.progressiveSamplePartsLength === 0) {
        if (parseCompletedSamples) {
          parseSEIFromSample(
            data,
            dataOffset,
            dataOffset + overlapLength,
            this.progressiveIsHEVC,
            sample.pts,
            userdataSamples,
          );
        }
        this.progressiveSampleIndex++;
        continue;
      }

      if (
        this.progressiveSamplePartsLength === 0 &&
        overlapStart > sample.start
      ) {
        this.progressiveSampleSkipped = true;
      }
      if (!this.progressiveSampleSkipped && overlapLength > 0) {
        const samplePart = data.slice(dataOffset, dataOffset + overlapLength);
        this.progressiveSampleParts.push(samplePart);
        this.progressiveSamplePartsLength += samplePart.byteLength;
      }

      if (overlapEnd < sample.end) {
        break;
      }

      if (parseCompletedSamples && !this.progressiveSampleSkipped) {
        const sampleData = concatUint8Arrays(
          this.progressiveSampleParts,
          this.progressiveSamplePartsLength,
        );
        parseSEIFromSample(
          sampleData,
          0,
          sampleData.byteLength,
          this.progressiveIsHEVC,
          sample.pts,
          userdataSamples,
        );
      }
      this.resetProgressiveSampleParts();
      this.progressiveSampleIndex++;
    }

    this.progressiveOffset = dataEnd;
    return userdataSamples;
  }

  private resetProgressiveSampleParts(): void {
    this.progressiveSampleParts = [];
    this.progressiveSamplePartsLength = 0;
    this.progressiveSampleSkipped = false;
  }

  private extractID3Track(
    videoTrack: PassthroughTrack,
    timeOffset: number,
  ): DemuxedMetadataTrack {
    const id3Track = this.id3Track as DemuxedMetadataTrack;
    if (videoTrack.samples.length) {
      const emsgs = findBox(videoTrack.samples, ['emsg']);
      if (emsgs) {
        emsgs.forEach((data: Uint8Array) => {
          const emsgInfo = parseEmsg(data);
          if (emsgSchemePattern.test(emsgInfo.schemeIdUri)) {
            const pts = getEmsgStartTime(emsgInfo, timeOffset);
            let duration =
              emsgInfo.eventDuration === 0xffffffff
                ? Number.POSITIVE_INFINITY
                : emsgInfo.eventDuration / emsgInfo.timeScale;
            // Safari takes anything <= 0.001 seconds and maps it to Infinity
            if (duration <= 0.001) {
              duration = Number.POSITIVE_INFINITY;
            }
            const payload = emsgInfo.payload;
            id3Track.samples.push({
              data: payload,
              len: payload.byteLength,
              dts: pts,
              pts: pts,
              type: MetadataSchema.emsg,
              duration: duration,
            });
          } else if (this.config.enableEmsgKLVMetadata) {
            const klvSchemaUri =
              this.config.emsgKLVSchemaUri || MetadataSchema.misbklv;
            if (emsgInfo.schemeIdUri.startsWith(klvSchemaUri)) {
              const pts = getEmsgStartTime(emsgInfo, timeOffset);
              id3Track.samples.push({
                data: emsgInfo.payload,
                len: emsgInfo.payload.byteLength,
                dts: pts,
                pts: pts,
                type: MetadataSchema.misbklv,
                duration: Number.POSITIVE_INFINITY,
              });
            }
          }
        });
      }
    }
    return id3Track;
  }

  demuxSampleAes(
    data: Uint8Array,
    keyData: KeyData,
    timeOffset: number,
  ): Promise<DemuxerResult> {
    return Promise.reject(
      new Error('The MP4 demuxer does not support SAMPLE-AES decryption'),
    );
  }

  destroy() {
    // @ts-ignore
    this.config = null;
    this.resetProgressiveState();
    this.videoTrack =
      this.audioTrack =
      this.id3Track =
      this.txtTrack =
        undefined;
    this.initData = undefined;
  }
}

function getEmsgStartTime(
  emsgInfo: IEmsgParsingData,
  timeOffset: number,
): number {
  return Number.isFinite(emsgInfo.presentationTime)
    ? (emsgInfo.presentationTime as number) / emsgInfo.timeScale
    : timeOffset +
        (emsgInfo.presentationTimeDelta as number) / emsgInfo.timeScale;
}

function concatUint8Arrays(
  arrays: Uint8Array<ArrayBuffer>[],
  totalLength: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (let index = 0; index < arrays.length; index++) {
    const data = arrays[index];
    result.set(data, offset);
    offset += data.byteLength;
  }
  return result;
}

export default MP4Demuxer;
