// What the DJ knows about a track's rhythm and structure (worked out by dsp.js inside the mixer), kept
// on disk: a track is only ever analysed once.
import { readDoc, writeDoc } from "../store.native";
import { warn } from "../log";

export type Grid = { period: number; phase: number; count: number; resid: number; inlierShare: number; contrast: number; bpm: number };
export type Analysis = {
  v: number;
  duration: number;
  firstSound: number;
  lastSound: number;
  loud: number;
  bpm: number;
  steady: boolean;
  pulse: number;
  grid: Grid | null;
  head: Grid | null; // the first minute on its own
  tail: Grid | null; // the last minute on its own
  barPhase: number;
  barConf: number;
  phrasePhase: number;
  bars: number[]; // bar start times
  barEnergy: number[]; // dB
  fullLevel: number;
  firstBeat: number; // first bar line with sound
  introEnd: number;
  outroStart: number;
  introBars: number;
  outroBars: number;
  fadeOut: boolean;
  key: { tonic: number; mode: "major" | "minor"; conf: number };
  /** How far the track is from concert pitch, in cents (0 where its notes don't say) */
  tuning: number;
};
const VERSION = 9;

// ------------------ CACHE ------------------
let cache: Record<string, Analysis> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const MAX_CACHED = 4000;
const loadCache = async () => {
  if (cache) return cache;
  try {
    const json = await readDoc("analysis");
    const parsed = json ? JSON.parse(json) : {};
    cache = parsed?.v === VERSION ? (parsed.tracks ?? {}) : {};
  } catch {
    cache = {};
  }
  return cache!;
};
const saveCache = () => {
  saveTimer ??= setTimeout(() => {
    saveTimer = undefined;
    if (!cache) return;
    const ids = Object.keys(cache);
    // Oldest entries go first (insertion order)
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CACHED))) delete cache[id];
    writeDoc("analysis", JSON.stringify({ v: VERSION, tracks: cache })).catch((err) => warn("Couldn't save the analysis cache", err));
  }, 5000);
};
export const cachedAnalysis = async (id: string): Promise<Analysis | undefined> => (await loadCache())[id];

const round = (n: number, d = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);
const compact = (r: any): Analysis => {
  const grid = (g: any): Grid | null =>
    g
      ? { period: round(g.period, 7), phase: round(g.phase, 5), count: g.count, resid: round(g.resid), inlierShare: round(g.inlierShare, 2), contrast: round(g.contrast, 2), bpm: round(g.bpm, 3) }
      : null;
  return {
    v: VERSION,
    duration: round(r.duration, 3),
    firstSound: round(r.firstSound, 3),
    lastSound: round(r.lastSound, 3),
    loud: round(r.loud, 1),
    bpm: round(r.bpm, 2),
    steady: r.steady,
    pulse: round(r.pulse, 2),
    grid: grid(r.grid),
    head: grid(r.head),
    tail: grid(r.tail),
    barPhase: r.barPhase,
    barConf: round(r.barConf, 2),
    phrasePhase: r.phrasePhase,
    bars: Array.from(r.bars as number[], (t) => round(t, 3)),
    barEnergy: Array.from(r.barEnergy as number[], (t) => round(t, 1)),
    fullLevel: round(r.fullLevel, 1),
    firstBeat: round(r.firstBeat, 4),
    introEnd: round(r.introEnd, 3),
    outroStart: round(r.outroStart, 3),
    introBars: r.introBars,
    outroBars: r.outroBars,
    fadeOut: r.fadeOut,
    key: { tonic: r.key.tonic, mode: r.key.mode, conf: round(r.key.conf, 3) },
    tuning: round(r.tuning ?? 0, 1),
  };
};

/** Keeps an analysis the mixer just made */
export const storeAnalysis = async (id: string, raw: unknown): Promise<Analysis> => {
  const analysis = compact(raw);
  (await loadCache())[id] = analysis;
  saveCache();
  return analysis;
};
