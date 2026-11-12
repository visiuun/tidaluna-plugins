// Where a track's audio comes from: the same stream TIDAL's own player would play. The address (and the
// key for encrypted streams) is handed to the mixer's process, which fetches and decodes it there.
import type { PlaybackInfo } from "@luna/lib";

import { warn } from "../log";

const lib = () => window.luna.lib!;

export type TrackStream = { urls: string[]; encryptionType?: string; keyId?: string; replayGain: number; peak: number; quality: string };

/**
 * A track's playback info, asked for now. Luna's own `getPlaybackInfo` remembers every answer for as long
 * as TIDAL stays open, but the addresses in an answer are only good for an hour: after that TIDAL's
 * servers refuse them (403), and tracks seen earlier in a long session stopped loading. Asking with an
 * extra, changing parameter gets past that memory while keeping Luna's sign-in and request limiting.
 */
const freshPlaybackInfo = async (id: string, quality: string): Promise<PlaybackInfo | undefined> => {
  const { TidalApi, parseDasha } = lib() as any;
  const url = `https://desktop.tidal.com/v1/tracks/${id}/playbackinfo?audioquality=${quality}&playbackmode=STREAM&assetpresentation=FULL&dj=${Date.now()}`;
  const raw = await (TidalApi.playbackInfoSemaphore?.with ? TidalApi.playbackInfoSemaphore.with(() => TidalApi.fetch(url)) : TidalApi.fetch(url));
  if (!raw?.manifest) return undefined;
  if (raw.manifestMimeType === "application/vnd.tidal.bts") {
    const manifest = JSON.parse(atob(raw.manifest));
    return { ...raw, manifest, mimeType: manifest.mimeType };
  }
  if (raw.manifestMimeType === "application/dash+xml") return { ...raw, manifest: await parseDasha(atob(raw.manifest), "https://sp-ad-cf.audio.tidal.com"), mimeType: "audio/mp4" };
  throw new Error(`Unsupported stream manifest: ${raw.manifestMimeType}`);
};

export const trackStream = async (id: string, quality: "LOSSLESS" | "HIGH"): Promise<TrackStream> => {
  let info: PlaybackInfo | undefined;
  try {
    info = await freshPlaybackInfo(id, quality);
  } catch (err) {
    warn(`Couldn't get fresh stream details for ${id}, using the remembered ones`, err);
  }
  info ??= (await lib().getPlaybackInfo(id, quality as any)) as PlaybackInfo | undefined;
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
