const FIXTURE_BASE_URL = '/base/tests/unit/fixtures';

export interface FMP4OpeningPTSCollisionFixture {
  initializationSegment: Uint8Array<ArrayBuffer>;
  mediaSegment: Uint8Array<ArrayBuffer>;
  playlistOffset: number;
  segmentDuration: number;
}

/** Loads a minimized capture of an FFmpeg fMP4 opening-PTS collision. */
export function loadFMP4OpeningPTSCollisionFixture(): Promise<FMP4OpeningPTSCollisionFixture> {
  return Promise.all([
    fetch(`${FIXTURE_BASE_URL}/fmp4-opening-pts-collision-init.mp4`),
    fetch(`${FIXTURE_BASE_URL}/fmp4-opening-pts-collision-fragment.mp4`),
  ])
    .then((responses: Response[]): Promise<ArrayBuffer[]> => {
      for (
        let responseIndex = 0;
        responseIndex < responses.length;
        responseIndex++
      ) {
        const response = responses[responseIndex];
        if (!response.ok) {
          throw new Error(`Fixture request failed: ${response.status}`);
        }
      }
      return Promise.all(
        responses.map(
          (response: Response): Promise<ArrayBuffer> => response.arrayBuffer(),
        ),
      );
    })
    .then(
      (buffers: ArrayBuffer[]): FMP4OpeningPTSCollisionFixture => ({
        initializationSegment: new Uint8Array(buffers[0]),
        mediaSegment: new Uint8Array(buffers[1]),
        playlistOffset: 18.477,
        segmentDuration: 6.089,
      }),
    );
}
