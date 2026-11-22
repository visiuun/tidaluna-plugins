// Where a track's sound comes from: TIDAL's DASH copy of it (AAC, the one its web player plays), the same way
// the DJ finds its streams (see DJ/src/audio/source.ts). Only the addresses are got here; the worker fetches them.
const lib = () => window.luna.lib!;

/** The init segment first, then the media segments, which together are one fragmented MP4 */
export type TrackStream = { urls: string[]; seconds?: number };

/**
 * A track's playback info, asked for now. Luna's own `getPlaybackInfo` remembers every answer for as long as TIDAL
 * stays open, but the addresses in it only work for an hour: an extra, changing parameter gets past that memory
 * while keeping Luna's sign-in and request limiting (as the DJ does).
 */
const fresh = async (id: string, quality: string) => {
  const { TidalApi } = lib() as any;
  const url = `https://desktop.tidal.com/v1/tracks/${id}/playbackinfo?audioquality=${quality}&playbackmode=STREAM&assetpresentation=FULL&bloom=${Date.now()}`;
  return await (TidalApi.playbackInfoSemaphore?.with ? TidalApi.playbackInfoSemaphore.with(() => TidalApi.fetch(url)) : TidalApi.fetch(url));
};

const seconds = (mpd: string) => {
  const m = mpd.match(/mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : undefined;
};

export const trackStream = async (id: string): Promise<TrackStream> => {
  // (HIGH is AAC at 320 kb/s, which keeps a track's stereo picture whole; LOW, at 96, is the fallback)
  for (const quality of ["HIGH", "LOW"]) {
    const raw = await fresh(id, quality).catch(() => undefined);
    if (raw?.manifestMimeType !== "application/dash+xml" || !raw.manifest) continue;
    const xml = atob(raw.manifest);
    const parsed = await (lib() as any).parseDasha(xml, "https://sp-ad-cf.audio.tidal.com");
    const segments = parsed?.tracks?.audios?.[0]?.segments as { url: string }[] | undefined;
    if (segments?.length) return { urls: segments.map((s) => s.url), seconds: seconds(xml) };
  }
  throw new Error(`No DASH stream for track ${id}`);
};
