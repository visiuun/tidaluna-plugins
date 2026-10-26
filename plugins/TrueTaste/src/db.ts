// In-memory working set, persisted to disk (store.native.ts) with debounced writes
import { appendLog, readDoc, writeDoc } from "./store.native";
import { emptyState, type ArtistInfo, type State, type Track } from "./types";

const MAX_EVENTS = 20000;
const MAX_TRACKS = 12000;
const MAX_ARTISTS = 8000;

export let state: State = emptyState();
export let tracks: Record<string, Track> = {};
export let artists: Record<string, ArtistInfo> = {};

const parse = <T>(json: string | null, fallback: T): T => {
  if (!json) return fallback;
  try {
    return JSON.parse(json) ?? fallback;
  } catch {
    return fallback;
  }
};

export const loadAll = async () => {
  const [s, t, a] = await Promise.all([readDoc("state"), readDoc("tracks"), readDoc("artists")]);
  state = { ...emptyState(), ...parse(s, {}) };
  // Earlier builds recorded plugin reloads as instant skips
  state.events = state.events.filter((e) => e.ms >= 1500);
  tracks = parse(t, {});
  artists = parse(a, {});
};

export const resetAll = () => {
  state = emptyState();
  tracks = {};
  artists = {};
};

// ------------------ PRUNING ------------------
const keepNewest = <V>(obj: Record<string, V>, max: number, time: (v: V) => number) => {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  keys.sort((a, b) => time(obj[b]) - time(obj[a]));
  const out: Record<string, V> = {};
  for (const k of keys.slice(0, max)) out[k] = obj[k];
  return out;
};

const prune = () => {
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  const monthAgo = Date.now() - 60 * 864e5;
  for (const [id, r] of Object.entries(state.recommended)) if (r.at < monthAgo) delete state.recommended[id];
  for (const [id, t] of Object.entries(state.seedsUsed)) if (t < monthAgo) delete state.seedsUsed[id];
  tracks = keepNewest(tracks, MAX_TRACKS, (t) => t.fetchedAt);
  artists = keepNewest(artists, MAX_ARTISTS, (a) => a.tagsAt ?? 0);
};

// ------------------ SAVING ------------------
const dirty = new Set<"state" | "tracks" | "artists">();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const markDirty = (...docs: ("state" | "tracks" | "artists")[]) => {
  for (const d of docs) dirty.add(d);
  saveTimer ??= setTimeout(() => flush().catch(() => {}), 20000);
};

export const flush = async () => {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (dirty.size === 0) return;
  prune();
  const docs = { state, tracks, artists };
  const names = [...dirty];
  dirty.clear();
  await Promise.all(names.map((name) => writeDoc(name, JSON.stringify(docs[name]))));
};

// ------------------ LOG ------------------
let logBuffer: string[] = [];
let logTimer: ReturnType<typeof setTimeout> | undefined;
export const writeLog = (line: string) => {
  logBuffer.push(`[${new Date().toISOString()}] ${line}`);
  logTimer ??= setTimeout(flushLog, 2000);
};
export const flushLog = () => {
  clearTimeout(logTimer);
  logTimer = undefined;
  if (logBuffer.length === 0) return;
  const text = logBuffer.join("\n") + "\n";
  logBuffer = [];
  appendLog(text).catch((err) => console.warn("[TrueTaste] log write failed", err));
};
