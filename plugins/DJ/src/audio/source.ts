// Where a track's audio comes from: the same stream TIDAL's own player would play. The address (and the
// key for encrypted streams) is handed to the mixer's process, which fetches and decodes it there.
import type { PlaybackInfo } from "@luna/lib";

const lib = () => window.luna.lib!;

export type TrackStream = { urls: string[]; encryptionType?: string; keyId?: string; replayGain: number; peak: number; quality: string };

/**
 * The stream details through Luna's own getPlaybackInfo: one request at a time with TIDAL's (the playing track
 * first), shared with TIDAL's own request for the same, and asked for afresh once the answer it has is 45 minutes
 * old (the addresses in one are only good for an hour). Before Luna 1.25 an answer was kept for as long as TIDAL
 * stayed open, and the DJ asked for its own with an extra, changing parameter; through Luna's request cache each of
 * those would now be kept as an answer of its own.
 */
export const trackStream = async (id: string, quality: "LOSSLESS" | "HIGH"): Promise<TrackStream> => {
  const info = (await lib().getPlaybackInfo(id, quality)) as PlaybackInfo | undefined;
  if (!info) throw new Error(`Track ${id} is not available to stream`);
  const meta = info as any;
  const base = {
    replayGain: Number(meta.trackReplayGain ?? meta.albumReplayGain ?? -8),
    peak: Number(meta.trackPeakAmplitude ?? meta.albumPeakAmplitude ?? 1) || 1,
    quality: String(meta.audioQuality ?? quality),
  };
  if (info.manifestMimeType === "application/vnd.tidal.bts") {
    const m = info.manifest;
    return { urls: [m.urls[0]], encryptionType: m.encryptionType, keyId: m.keyId, ...base };
  }
  // DASH: an init segment followed by media segments, which together are one MP4
  const segments = info.manifest.tracks.audios[0].segments as { url: string }[];
  return { urls: segments.map((s) => s.url), ...base };
};

/**
 * Linear gain that evens out loudness between tracks without clipping their peaks. With TIDAL's own
 * loudness normalisation off, only the loudest masters are turned down, so the DJ plays as loud as
 * TIDAL itself does; with it on, tracks get their full ReplayGain, as TIDAL's player gives them.
 */
export const normGain = (raw: Pick<TrackStream, "replayGain" | "peak">, tidalNormalizes = false) => {
  // TIDAL's loudness normalisation off: every sample goes out as it is on the record
  if (!tidalNormalizes) return 1;
  const g = Math.pow(10, raw.replayGain / 20);
  return Math.max(0.15, Math.min(g, 1 / Math.max(0.1, raw.peak), 1));
};
