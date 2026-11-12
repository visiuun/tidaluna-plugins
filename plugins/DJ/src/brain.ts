// What the DJ plays. Music comes in sets of a few tracks around one idea: what you have on repeat, a month
// from your past, one of your genres, an artist, things you haven't heard yet. The taste data is
// TrueTaste's when that plugin is installed (read-only, from its files); otherwise the DJ reads your
// likes, recently played and listening history from TIDAL itself.
import * as api from "../../TrueTaste/src/api";
import { artists, loadAll, state, tracks } from "../../TrueTaste/src/db";
import { buildProfile, labelFor, VERSION_RE, versionText, type Profile } from "../../TrueTaste/src/profile";
import { clusterSeeds, type Cluster } from "../../TrueTaste/src/rank";
import genreList from "file://../../TrueTaste/assets/genres.txt";
import { dot, normalize, normTag, tagVector } from "../../TrueTaste/src/tagspace";
import type { Track } from "../../TrueTaste/src/types";
import { trackVector } from "../../TrueTaste/src/vectors";
import { settings } from "./config";
import { log, warn } from "./log";
import { readDoc, writeDoc } from "./store.native";

export type { Track };
export type Kind = "more" | "onRepeat" | "recentLikes" | "throwback" | "taste" | "discovery" | "artist" | "forgotten" | "mood" | "dailyMix" | "request";
export type Facts = {
  month?: string;
  year?: number;
  season?: string;
  genre?: string;
  artist?: string;
  daypart?: string;
  query?: string;
  mood?: string;
  /** What TIDAL's playlist AI called what it put together for a request */
  aiTitle?: string;
  /** How a request was understood */
  matched?: "artist" | "vibe" | "radio" | "year" | "playlist";
};
export type Segment = { kind: Kind; key: string; title: string; tracks: Track[]; facts: Facts; anchor?: Anchor };
/** The sound the DJ is staying with until it's asked for something else */
export type Anchor = {
  label: string;
  vec: Float32Array | null;
  seedId?: string;
  /** For a request: the tracks TIDAL's playlist AI gave for it, and the prompt to ask for more */
  pool?: string[];
  prompt?: string;
};
export type Command = { command: "stop" | "skip" | "quiet" | "chatty" };

const DAY = 864e5;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ------------------ MEMORY ------------------
// What the DJ has played and talked about, so sets don't repeat themselves
type Memory = { played: Record<string, number>; themes: { key: string; at: number }[]; sessions: number; lastSessionAt: number; scratchPlaylist?: string };
let memory: Memory = { played: {}, themes: [], sessions: 0, lastSessionAt: 0 };
let memoryTimer: ReturnType<typeof setTimeout> | undefined;
const saveMemory = () => {
  memoryTimer ??= setTimeout(() => {
    memoryTimer = undefined;
    const cutoff = Date.now() - 30 * DAY;
    for (const [id, at] of Object.entries(memory.played)) if (at < cutoff) delete memory.played[id];
    memory.themes = memory.themes.filter((t) => t.at > cutoff).slice(-60);
    writeDoc("memory", JSON.stringify(memory)).catch(() => {});
  }, 4000);
};
export const markPlayed = (id: string) => {
  memory.played[id] = Date.now();
  saveMemory();
};
export const sessionCount = () => memory.sessions;
export const lastSessionAt = () => memory.lastSessionAt;
export const markSession = () => {
  memory.sessions++;
  memory.lastSessionAt = Date.now();
  saveMemory();
};
const rememberTheme = (key: string) => {
  memory.themes.push({ key, at: Date.now() });
  saveMemory();
};
const themeAge = (key: string) => {
  const last = [...memory.themes].reverse().find((t) => t.key === key);
  return last ? Date.now() - last.at : Infinity;
};

// ------------------ TASTE ------------------
let profile: Profile | undefined;
let clusters: Cluster[] = [];
let blocked: api.Blocks = { tracks: new Set(), artists: new Set() };
const vectors = new Map<string, Float32Array | null>();
const vectorOf = (id: string) => {
  if (!vectors.has(id)) vectors.set(id, trackVector(id));
  return vectors.get(id) ?? null;
};
let ownTracks: Record<string, Track> = {};
let tracksTimer: ReturnType<typeof setTimeout> | undefined;

/** Track details for ids we don't have yet (kept in the DJ's own cache; TrueTaste's files are never written) */
export const ensureTracks = async (ids: string[]) => {
  const missing = [...new Set(ids)].filter((id) => !tracks[id]);
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += 60) {
    const batch = await api.hydrateTracks(missing.slice(i, i + 60)).catch((err) => {
      if (api.isAbort(err)) throw err;
      warn("Couldn't read track details", err);
      return [] as Track[];
    });
    for (const t of batch) {
      tracks[t.id] = t;
      ownTracks[t.id] = t;
      for (const a of t.artists) artists[a.id] ??= { name: a.name };
    }
  }
  tracksTimer ??= setTimeout(() => {
    tracksTimer = undefined;
    const ids = Object.keys(ownTracks);
    for (const id of ids.slice(0, Math.max(0, ids.length - 3000))) delete ownTracks[id];
    writeDoc("tracks", JSON.stringify(ownTracks)).catch(() => {});
  }, 8000);
};

/** Details of a track the DJ has read (see ensureTracks) */
export const trackInfo = (id: string): Track | undefined => tracks[id];

const parse = <T>(json: string | null, fallback: T): T => {
  try {
    return json ? (JSON.parse(json) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
};

/** Your library straight from TIDAL, for when TrueTaste's data isn't there (or is stale) */
const lightSync = async () => {
  const cached = parse<{ at?: number; likes?: Record<string, number>; recent?: Record<string, number>; months?: typeof state.historyMonths } | null>(await readDoc("library"), null);
  if (cached?.at && Date.now() - cached.at < 12 * 3600e3) {
    for (const [id, at] of Object.entries(cached.likes ?? {})) state.likes[id] ??= at;
    for (const [id, at] of Object.entries(cached.recent ?? {})) state.recentTracks[id] ??= at;
    if (!state.historyMonths?.length && cached.months?.length) state.historyMonths = cached.months;
    return;
  }
  const now = Date.now();
  const likes: Record<string, number> = {};
  const recent: Record<string, number> = {};
  const favs = await api.favoriteTracks(5000).catch((err) => (warn("Couldn't read your liked tracks", err), []));
  for (const f of favs) likes[f.id] = f.addedAt || now;
  const activity = await api.recentActivity(200).catch(() => null);
  activity?.tracks.forEach((t, i) => (recent[t.id] = now - i * 2 * 3600e3));
  for (const [id, at] of Object.entries(likes)) state.likes[id] ??= at;
  for (const [id, at] of Object.entries(recent)) state.recentTracks[id] ??= at;
  let months = state.historyMonths ?? [];
  if (!months.length) {
    // "My Most Listened" per month: what throwbacks are made of
    const history = await api.historyMixes(state.historyRefs ?? []).catch(() => [] as api.HistoryMix[]);
    months = [];
    for (const mix of history.slice(0, 30)) {
      if (!/ALLTIME/.test(mix.mixType) && mix.at === undefined) continue;
      const list = await api.mixTracks(mix.id).catch(() => [] as api.LibraryTrack[]);
      months.push({ id: mix.id, type: mix.mixType, at: mix.at ?? now, tracks: list.map((t) => t.id) });
    }
    if (months.length) state.historyMonths = months.sort((a, b) => b.at - a.at);
  }
  await writeDoc("library", JSON.stringify({ at: now, likes, recent, months })).catch(() => {});
  log(`Read your library from TIDAL: ${favs.length} liked, ${Object.keys(recent).length} recently played, ${months.length} months of history`);
};

let ready: Promise<void> | undefined;
let loadedAt = 0;
/** Loads (or refreshes) everything the DJ knows about your taste */
export const initBrain = (force = false) => {
  if (force || (loadedAt && Date.now() - loadedAt > 6 * 3600e3)) ready = undefined;
  return (ready ??= load().catch((err) => {
    ready = undefined;
    throw err;
  }));
};

const load = async () => {
  const t0 = Date.now();
  api.setRequestGap(110);
  await loadAll();
  ownTracks = parse(await readDoc("tracks"), {} as Record<string, Track>);
  for (const [id, t] of Object.entries(ownTracks)) tracks[id] ??= t;
  memory = { ...memory, ...parse(await readDoc("memory"), {}) };
  const fromTrueTaste = !!state.librarySyncAt && Date.now() - state.librarySyncAt < 3 * DAY;
  if (!fromTrueTaste) await lightSync();
  blocked = await api.blocks().catch(() => blocked);

  profile = buildProfile();
  const top = [...profile.seeds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 400)
    .map(([id]) => id);
  const lately = [...profile.parts.entries()]
    .sort((a, b) => b[1].now + b[1].fast - (a[1].now + a[1].fast))
    .slice(0, 150)
    .map(([id]) => id);
  await ensureTracks([...top, ...lately]);
  // Artist-level taste needs the track details just read
  profile = buildProfile();

  vectors.clear();
  const points = top
    .map((id) => ({ id, w: profile!.seeds.get(id) ?? 0.1, v: vectorOf(id) }))
    .filter((p): p is { id: string; w: number; v: Float32Array } => !!p.v);
  clusters = clusterSeeds(points);
  for (const c of clusters) {
    const aw = new Map<string, number>();
    const genres = new Map<string, number>();
    for (const m of c.members) {
      const t = tracks[m.id];
      const a = t?.artists[0]?.id;
      if (a) aw.set(a, (aw.get(a) ?? 0) + m.w);
      for (const g of t?.genres ?? []) genres.set(g, (genres.get(g) ?? 0) + m.w);
    }
    // Last.fm tags name a sound best; TIDAL's own genres are the fallback
    c.label = labelFor(aw).split(" / ")[0] || [...genres.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.toLowerCase() || "";
  }
  loadedAt = Date.now();
  log(
    `Taste loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s (${fromTrueTaste ? "from TrueTaste" : "from TIDAL"}): ${profile.seeds.size} tracks you like, ${state.events.length} tracked listens, ${state.historyMonths?.length ?? 0} history months, ${clusters.length} tastes [${clusters.map((c) => c.label || "?").join(", ")}]`,
  );
};

// ------------------ PICKING ------------------
const leadArtist = (t: Track) => t.artists[0]?.id ?? t.id;
const recentlyPlayed = (id: string, within = 20 * 3600e3) => Date.now() - (memory.played[id] ?? 0) < within;

const eligible = (t: Track | undefined, allowRecent = false): t is Track => {
  // Long tracks are left out: decoded audio is held in memory, and TIDAL is a 32-bit app
  if (!t || !t.available || t.duration < 80 || t.duration > 480) return false;
  if (!settings.allowExplicit && t.explicit) return false;
  if (blocked.tracks.has(t.id) || t.artists.some((a) => blocked.artists.has(a.id))) return false;
  if (state.feedback?.[t.id]?.v === -1) return false;
  if (VERSION_RE.junk.test(versionText(t))) return false;
  if (!allowRecent && recentlyPlayed(t.id)) return false;
  return true;
};

type Weighted = { id: string; w: number };
const shuffleWeighted = (pool: Weighted[]) => {
  // Efraimidis-Spirakis: one pass weighted sampling without replacement
  return pool
    .filter((p) => p.w > 0)
    .map((p) => ({ id: p.id, k: Math.pow(Math.random(), 1 / p.w) }))
    .sort((a, b) => b.k - a.k)
    .map((p) => p.id);
};

/** n tracks from a weighted pool: no artist twice, nothing played in the last day */
const pick = async (pool: Weighted[], n: number, opts: { sameArtist?: boolean; exclude?: Set<string> } = {}) => {
  const order = shuffleWeighted(pool.filter((p) => !opts.exclude?.has(p.id)));
  const out: Track[] = [];
  const usedArtists = new Set<string>();
  for (let i = 0; i < order.length && out.length < n; i += 12) {
    const batch = order.slice(i, i + 12);
    await ensureTracks(batch);
    for (const id of batch) {
      const t = tracks[id];
      if (!eligible(t)) continue;
      if (!opts.sameArtist && usedArtists.has(leadArtist(t))) continue;
      usedArtists.add(leadArtist(t));
      out.push(t);
      if (out.length >= n) break;
    }
  }
  return out;
};

// ------------------ FLOW ------------------
const KEY_INDEX: Record<string, number> = { C: 0, CSHARP: 1, DB: 1, D: 2, DSHARP: 3, EB: 3, E: 4, F: 5, FSHARP: 6, GB: 6, G: 7, GSHARP: 8, AB: 8, A: 9, ASHARP: 10, BB: 10, B: 11 };
export const keyOf = (t: Track): { tonic: number; mode: "major" | "minor" } | undefined => {
  const tonic = KEY_INDEX[(t.key ?? "").toUpperCase().replace(/[^A-Z]/g, "")];
  if (tonic === undefined || !t.keyScale) return undefined;
  return { tonic, mode: /MINOR/i.test(t.keyScale) ? "minor" : "major" };
};
const camelot = (t: Track) => {
  const k = keyOf(t);
  if (!k) return undefined;
  const n = k.mode === "major" ? ((k.tonic * 7) % 12) + 8 : (((k.tonic + 3) * 7) % 12) + 8;
  return { n: ((n - 1) % 12) + 1, major: k.mode === "major" };
};
const stepCost = (a: Track, b: Track) => {
  let cost = 0;
  if (a.bpm && b.bpm) {
    let r = Math.abs(Math.log2(b.bpm / a.bpm));
    r = Math.min(r, Math.abs(r - 1)); // double/half time mixes too
    cost += Math.min(1.5, r * 9); // ~8% apart costs 1
  } else cost += 0.6;
  const ka = camelot(a);
  const kb = camelot(b);
  if (ka && kb) {
    const d = Math.min((ka.n - kb.n + 12) % 12, (kb.n - ka.n + 12) % 12);
    cost += ka.major === kb.major ? (d <= 1 ? 0 : 0.35) : d === 0 ? 0 : 0.35;
  } else cost += 0.15;
  return cost;
};
/** Orders a set so each track mixes into the next: closest tempos and compatible keys */
const flow = (list: Track[], after?: Track) => {
  if (list.length < 3 || list.length > 7) return list;
  let best = list;
  let bestCost = Infinity;
  const permute = (rest: Track[], done: Track[], cost: number) => {
    if (cost >= bestCost) return;
    if (!rest.length) {
      bestCost = cost;
      best = done;
      return;
    }
    rest.forEach((t, i) => {
      const prev = done[done.length - 1] ?? after;
      permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...done, t], cost + (prev ? stepCost(prev, t) * (done.length ? 1 : 0.3) : 0));
    });
  };
  permute(list, [], 0);
  return best;
};

// ------------------ SETS ------------------
const size = () => Math.max(3, Math.min(8, Math.round(settings.setLength)));
const daypart = (h = new Date().getHours()) => (h < 5 ? "late night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "late night");
const seasonOf = (d: Date) => ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"][d.getMonth()];

/**
 * From a wider pick, the run of n tracks that mixes best: starting from each candidate, keep adding the
 * closest match in tempo and key, and take the smoothest chain. Sets end up coherent enough to blend
 * without every set sounding the same, since the candidates themselves were drawn at random.
 */
const bestChain = (list: Track[], n: number, after?: Track) => {
  if (list.length <= n) return flow(list, after);
  let best: Track[] = list.slice(0, n);
  let bestCost = Infinity;
  for (const start of list) {
    const chain = [start];
    let cost = after ? stepCost(after, start) * 0.3 : 0;
    const rest = new Set(list);
    rest.delete(start);
    while (chain.length < n) {
      let next: Track | undefined;
      let nextCost = Infinity;
      for (const t of rest) {
        const c = stepCost(chain[chain.length - 1], t);
        if (c < nextCost) {
          nextCost = c;
          next = t;
        }
      }
      if (!next) break;
      chain.push(next);
      rest.delete(next);
      cost += nextCost;
    }
    if (chain.length === n && cost < bestCost) {
      bestCost = cost;
      best = chain;
    }
  }
  return flow(best, after);
};

type Builder = () => Promise<Segment | null>;
const make = (kind: Kind, key: string, title: string, list: Track[], facts: Facts, after?: Track): Segment | null =>
  list.length >= Math.min(3, size()) ? { kind, key, title, tracks: bestChain(list, size(), after), facts } : null;
/** How many candidates to draw for a set of size() */
const wide = () => size() * 2 + 2;

let lastTrack: Track | undefined;

const onRepeat: Builder = async () => {
  const p = profile!;
  const pool: Weighted[] = [];
  for (const [id, c] of p.parts) {
    const w = 0.65 * c.now + 0.45 * c.fast;
    if (w > 0.12 && !p.negatives.has(id)) pool.push({ id, w: w * w });
  }
  if (pool.length < 6) return null;
  return make("onRepeat", "onRepeat", "On repeat lately", await pick(pool, wide()), {}, lastTrack);
};

const recentLikes: Builder = async () => {
  const now = Date.now();
  const pool = Object.entries(state.likes)
    .filter(([id, at]) => now - at < 60 * DAY && !((state.unlikes[id] ?? 0) > at))
    .map(([id, at]) => ({ id, w: Math.pow(0.5, (now - at) / (25 * DAY)) + 0.1 }));
  if (pool.length < 5) return null;
  return make("recentLikes", "recentLikes", "Recently liked", await pick(pool, wide()), {}, lastTrack);
};

const throwback: Builder = async () => {
  const now = Date.now();
  const p = profile!;
  // A month from your listening history, at least five months back
  const months = (state.historyMonths ?? []).filter((m) => /MONTHLY/.test(m.type) && now - m.at > 150 * DAY && m.tracks.length >= 8);
  const fresh = months.filter((m) => themeAge(`throwback:${m.id}`) > 5 * DAY);
  const m = (fresh.length ? fresh : months)[Math.floor(Math.random() * (fresh.length || months.length))];
  if (m) {
    const d = new Date(m.at);
    // Favour the ones you haven't been playing lately: that's what makes it a throwback
    const pool = m.tracks.map((id, rank) => ({ id, w: (1 - (0.6 * rank) / m.tracks.length) * (1 - 0.8 * (p.parts.get(id)?.now ?? 0)) }));
    const list = await pick(pool, wide());
    return make("throwback", `throwback:${m.id}`, `Throwback: ${MONTHS[d.getMonth()]} ${d.getFullYear()}`, list, { month: MONTHS[d.getMonth()], year: d.getFullYear(), season: seasonOf(d) }, lastTrack);
  }
  // No history mixes: tracks you liked long ago, grouped by season
  const groups = new Map<string, { ids: string[]; d: Date }>();
  for (const [id, at] of Object.entries(state.likes)) {
    if (now - at < 300 * DAY || at < 1e11) continue;
    const d = new Date(at);
    const key = `${seasonOf(d)} ${d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear()}`;
    const g = groups.get(key) ?? { ids: [], d };
    g.ids.push(id);
    groups.set(key, g);
  }
  const usable = [...groups.entries()].filter(([key, g]) => g.ids.length >= 8 && themeAge(`throwback:${key}`) > 5 * DAY);
  if (!usable.length) return null;
  const [key, g] = usable[Math.floor(Math.random() * usable.length)];
  const list = await pick(
    g.ids.map((id) => ({ id, w: 1 })),
    wide(),
  );
  const year = Number(key.split(" ")[1]);
  return make("throwback", `throwback:${key}`, `Throwback: ${key}`, list, { season: key.split(" ")[0], year }, lastTrack);
};

const taste: Builder = async () => {
  const named = clusters.filter((c) => c.label && c.members.length >= 6);
  if (!named.length) return null;
  const options = named.map((c) => ({ c, w: Math.pow(c.weight, 0.6) * (themeAge(`taste:${c.label}`) < 4 * 3600e3 ? 0.05 : 1) }));
  const total = options.reduce((s, o) => s + o.w, 0);
  let r = Math.random() * total;
  const c = (options.find((o) => (r -= o.w) <= 0) ?? options[0]).c;
  const list = await pick(
    c.members.map((m) => ({ id: m.id, w: m.w })),
    wide(),
  );
  return make("taste", `taste:${c.label}`, `Your ${c.label} side`, list, { genre: c.label }, lastTrack);
};

const forgotten: Builder = async () => {
  const p = profile!;
  const now = Date.now();
  const lastHeard = new Map<string, number>();
  for (const e of state.events) lastHeard.set(e.id, Math.max(lastHeard.get(e.id) ?? 0, e.t));
  const pool: Weighted[] = [];
  for (const [id, c] of p.parts) {
    if (c.slow + c.lib < 0.35 || c.fast > 0.08 || c.now > 0.02 || p.negatives.has(id)) continue;
    if (now - (lastHeard.get(id) ?? 0) < 45 * DAY || now - (state.recentTracks[id] ?? 0) < 45 * DAY) continue;
    pool.push({ id, w: c.slow + 0.5 * c.lib });
  }
  if (pool.length < 10) return null;
  return make("forgotten", "forgotten", "Lost favourites", await pick(pool, wide()), {}, lastTrack);
};

const artistSpotlight: Builder = async () => {
  const p = profile!;
  const top = [...p.artistAffinity.entries()]
    .filter(([a]) => !p.dislikedArtists.has(a) && !blocked.artists.has(a) && artists[a]?.name && themeAge(`artist:${a}`) > 3 * DAY)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14);
  if (!top.length) return null;
  const [artistId] = top[Math.floor(Math.pow(Math.random(), 1.6) * top.length)];
  const name = artists[artistId].name;
  const loved: Weighted[] = [];
  for (const [id, w] of p.seeds) if (tracks[id]?.artists.some((a) => a.id === artistId)) loved.push({ id, w });
  const topTracks = await api.artistTopTracks(artistId, 12).catch(() => [] as string[]);
  const unheard = topTracks.filter((id) => !p.known.has(id)).map((id, i) => ({ id, w: 1 / (1 + i / 4) }));
  const n = size();
  const newOnes = await pick(unheard, Math.min(2, Math.max(1, Math.round(n * 0.3))), { sameArtist: true });
  const used = new Set(newOnes.map((t) => t.id));
  const familiar = await pick(loved.length >= 2 ? loved : topTracks.map((id, i) => ({ id, w: 1 / (1 + i / 4) })), n - newOnes.length, { sameArtist: true, exclude: used });
  // Same song under another release shouldn't appear twice
  const seen = new Set<string>();
  const list = [...familiar, ...newOnes].filter((t) => {
    const k = t.title.toLowerCase().replace(/\(.*?\)/g, "").trim();
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return make("artist", `artist:${artistId}`, `Spotlight: ${name}`, list, { artist: name }, lastTrack);
};

const MOODS: Record<string, { tags: string[]; title: string; mood: string; bpm?: [number, number] }> = {
  morning: { tags: ["mellow", "acoustic", "chill", "dreamy", "warm"], title: "Easing into the day", mood: "something easy" },
  afternoon: { tags: ["upbeat", "groovy", "happy", "energetic"], title: "Afternoon energy", mood: "something with a bit of energy" },
  evening: { tags: ["groovy", "romantic", "atmospheric", "chill"], title: "Evening mood", mood: "something for the evening" },
  "late night": { tags: ["atmospheric", "dark", "hypnotic", "dreamy", "chill"], title: "Late night", mood: "late night music" },
};
const vibeVector = (words: string[]) => {
  let out: Float32Array | null = null;
  for (const w of words) {
    const v = tagVector(w);
    if (!v) continue;
    normalize(v);
    out ??= new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] += v[i];
  }
  return out && normalize(out);
};
/** Tracks you like, ranked by how well they fit a vibe (relative to your library's average, so it isn't just your biggest genre) */
const byVibe = (qv: Float32Array, ids: Iterable<string>) => {
  const scored: { id: string; s: number }[] = [];
  let mean = 0;
  for (const id of ids) {
    const v = vectorOf(id);
    if (!v) continue;
    const s = dot(v, qv);
    mean += s;
    scored.push({ id, s });
  }
  mean /= Math.max(1, scored.length);
  return scored.map((x) => ({ id: x.id, s: x.s - mean })).sort((a, b) => b.s - a.s);
};

const moodSet: Builder = async () => {
  const part = daypart();
  const m = MOODS[part];
  const qv = vibeVector(m.tags);
  if (!qv || themeAge(`mood:${part}`) < 3 * 3600e3) return null;
  const ranked = byVibe(qv, profile!.seeds.keys());
  if (ranked.length < 30) return null;
  const pool = ranked.slice(0, Math.max(20, Math.round(ranked.length * 0.15))).map((x, i) => ({ id: x.id, w: 1 / (1 + i / 15) }));
  return make("mood", `mood:${part}`, m.title, await pick(pool, wide()), { daypart: part, mood: m.mood }, lastTrack);
};

// New music: gathered once in a while from several places, then ranked against your taste
let discoveryPool: { at: number; ids: Weighted[] } | undefined;
const gatherDiscovery = async () => {
  if (discoveryPool && Date.now() - discoveryPool.at < 2 * 3600e3 && discoveryPool.ids.length > 10) return discoveryPool.ids;
  const p = profile!;
  const found = new Map<string, number>();
  const add = (id: string, w: number) => !p.known.has(id) && found.set(id, (found.get(id) ?? 0) + w);
  // TrueTaste's own picks for today come first: they're already ranked for you
  if (state.playlistId) for (const t of await api.playlistTracks(state.playlistId, 100).catch(() => [])) add(t.id, 2);
  const mixes = await api.myMixes().catch(() => [] as api.MixRef[]);
  for (const mix of mixes) {
    const w = /DISCOVERY/.test(mix.mixType) ? 1.2 : /NEW_RELEASE/.test(mix.mixType) ? 1 : 0;
    if (!w) continue;
    (await api.mixItems(mix.id).catch(() => [] as string[])).forEach((id, i) => add(id, w / (1 + i / 30)));
  }
  const seeds = shuffleWeighted([...p.parts.entries()].map(([id, c]) => ({ id, w: c.now + c.fast + 0.2 * c.slow }))).slice(0, 3);
  for (const s of seeds) (await api.similarTracks(s).catch(() => [] as string[])).forEach((id, i) => add(id, 0.9 / (1 + i / 12)));
  const ids = [...found.entries()].map(([id, w]) => ({ id, w }));
  discoveryPool = { at: Date.now(), ids };
  return ids;
};
const discovery: Builder = async () => {
  const pool = await gatherDiscovery();
  if (pool.length < 5) return null;
  const p = profile!;
  // Drop artists you skip or 👎, then let the pool's own ranking decide
  const candidates = shuffleWeighted(pool).slice(0, 40);
  await ensureTracks(candidates);
  const ok = candidates.filter((id) => {
    const t = tracks[id];
    if (!eligible(t) || t.ai) return false;
    if (t.artists.some((a) => p.dislikedArtists.has(a.id) || (p.artistSkipRate.get(a.id) ?? 0) >= 0.75)) return false;
    return true;
  });
  const list = await pick(
    ok.map((id, i) => ({ id, w: 1 / (1 + i / 10) })),
    wide(),
  );
  return make("discovery", "discovery", "New for you", list, {}, lastTrack);
};

let dailyMixes: { title: string; ids: string[] }[] | undefined;
const dailyMix: Builder = async () => {
  if (!dailyMixes) {
    dailyMixes = [];
    for (const mix of (await api.myMixes().catch(() => [] as api.MixRef[])).filter((m) => /DAILY_MIX/.test(m.mixType)).slice(0, 6)) {
      const ids = await api.mixItems(mix.id).catch(() => [] as string[]);
      if (ids.length >= 8) dailyMixes.push({ title: mix.title ?? "your mix", ids });
    }
  }
  const options = dailyMixes.filter((m) => themeAge(`mix:${m.title}`) > 6 * 3600e3);
  const m = options[Math.floor(Math.random() * options.length)];
  if (!m) return null;
  const list = await pick(
    m.ids.map((id, i) => ({ id, w: 1 / (1 + i / 40) })),
    wide(),
  );
  return make("dailyMix", `mix:${m.title}`, m.title, list, {}, lastTrack);
};

type Themed = Exclude<Kind, "request" | "more">;
const BUILDERS: Record<Themed, Builder> = { onRepeat, recentLikes, throwback, taste, discovery, artist: artistSpotlight, forgotten, mood: moodSet, dailyMix };

/**
 * The next set. Opens with what you've been playing lately, then moves between your past, your genres,
 * artists and new music, never the same kind twice in a row.
 */
export const nextSegment = async (history: Segment[], avoidKind?: Kind): Promise<Segment> => {
  await initBrain();
  lastTrack = history[history.length - 1]?.tracks.at(-1);
  const last = history[history.length - 1]?.kind;
  const recentKinds = history.slice(-3).map((s) => s.kind);
  const d = Math.max(0, Math.min(1, settings.discovery / 100));
  const weights: Record<Themed, number> = {
    onRepeat: 1.1,
    recentLikes: 0.7,
    throwback: 1.2,
    taste: 1.3,
    forgotten: 0.8,
    artist: 0.8,
    mood: 0.7,
    discovery: 0.4 + 3.2 * d,
    dailyMix: 0.25 + 0.5 * d,
  };
  let order: Themed[];
  if (!history.length) order = ["onRepeat", "recentLikes", "taste", "mood", "dailyMix", "discovery", "throwback", "artist", "forgotten"];
  else {
    const pool = (Object.keys(weights) as Themed[]).map((k) => ({ id: k, w: weights[k] * (k === last || k === avoidKind ? 0 : recentKinds.includes(k) ? 0.35 : 1) }));
    order = shuffleWeighted(pool) as Themed[];
    // Whatever was excluded is still better than nothing
    for (const k of Object.keys(weights) as Themed[]) if (!order.includes(k)) order.push(k);
  }
  for (const kind of order) {
    try {
      const seg = await BUILDERS[kind]();
      if (seg) {
        rememberTheme(seg.key);
        log(`Next set: ${seg.title} [${seg.tracks.map((t) => `${t.artists[0]?.name} - ${t.title}${t.bpm ? ` (${Math.round(t.bpm)})` : ""}`).join(" | ")}]`);
        return seg;
      }
    } catch (err) {
      if (api.isAbort(err)) throw err;
      warn(`Couldn't build a "${kind}" set`, err);
    }
  }
  throw new Error("Couldn't find anything to play. Like a few tracks or listen for a while first, then try again");
};

// ------------------ UNDERSTANDING REQUESTS ------------------
// "Brazilian funk", "kawaii music", "something for a rainy Sunday": knowing what those mean takes a
// language model that knows the catalogue. TIDAL has one: its own AI playlist generator, which fills a
// playlist from a prompt. For each request the DJ makes a temporary unlisted playlist, lets TIDAL fill
// it, reads the tracks and deletes it again. Search and tags were tried first and get these wrong far
// too often.
const OPENAPI = "https://openapi.tidal.com/v2/";
const jsonApi = async () => ({ ...(await window.luna.lib!.TidalApi.getAuthHeaders()), "Content-Type": "application/vnd.api+json", accept: "application/vnd.api+json" });
const deletePlaylist = async (id: string) => {
  const res = await fetch(`${OPENAPI}playlists/${id}`, { method: "DELETE", headers: await jsonApi() });
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
};

let aiBusy: Promise<unknown> = Promise.resolve();
export type Progress = (stage: string) => void;
/** Tracks TIDAL's playlist AI picks for a prompt, most fitting first, and what it named the result. Takes 15-30 seconds */
const aiTracks = (prompt: string, progress?: Progress): Promise<{ ids: string[]; title?: string }> => {
  const job = aiBusy.then(async () => {
    progress?.("Asking TIDAL's AI");
    const headers = await jsonApi();
    // A temporary playlist left behind by a run that was cut short
    if (memory.scratchPlaylist) {
      await deletePlaylist(memory.scratchPlaylist).catch(() => {});
      memory.scratchPlaylist = undefined;
    }
    const playlist = await api.createPlaylist("DJ request (temporary)", "Made by the DJ plugin to understand a request. It deletes this itself; safe to delete.");
    memory.scratchPlaylist = playlist;
    saveMemory();
    try {
      const res = await fetch(`${OPENAPI}playlistGenerations`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ data: { type: "playlistGenerations", attributes: { prompt }, relationships: { playlist: { data: { id: playlist, type: "playlists" } } } } }),
      });
      if (!res.ok) throw new Error(`TIDAL's playlist AI said HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const id = (await res.json())?.data?.id;
      if (!id) throw new Error("TIDAL's playlist AI returned nothing");
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        const poll = await fetch(`${OPENAPI}playlistGenerations/${id}`, { headers });
        const attrs = poll.ok ? (await poll.json())?.data?.attributes : undefined;
        const status = String(attrs?.status ?? "");
        const pr = attrs?.progress;
        if (pr?.targetTrackCount) progress?.(`TIDAL's AI is picking tracks (${pr.selectedTrackCount ?? 0} of ${pr.targetTrackCount})`);
        else progress?.("TIDAL's AI is thinking");
        if (attrs?.progress?.playlistReady) break;
        if (status && !/OK|PENDING|PROCESSING/.test(status)) throw new Error(`TIDAL's playlist AI: ${status}`);
      }
      progress?.("Reading what it picked");
      // TIDAL names the playlist after what it understood ("Baile Funk Essentials"): the DJ uses that
      const named = await api.v2(`playlists/${playlist}`).catch(() => undefined);
      const data = Array.isArray(named?.data) ? named?.data[0] : named?.data;
      const name = String(data?.attributes?.name ?? "");
      return { ids: (await api.playlistTracks(playlist, 100)).map((t) => t.id), title: name && !/^DJ request/.test(name) ? name : undefined };
    } finally {
      await deletePlaylist(playlist)
        .then(() => {
          memory.scratchPlaylist = undefined;
          saveMemory();
        })
        .catch((err) => warn("Couldn't delete the temporary request playlist", err));
    }
  });
  aiBusy = job.catch(() => {});
  return job;
};

// ------------------ STAYING WITH A SOUND ------------------
const nearestLabel = (vec: Float32Array | null) => {
  if (!vec) return "";
  let best = "";
  let bestSim = 0.45;
  for (const c of clusters) {
    const s = dot(c.centroid, vec);
    if (c.label && s > bestSim) {
      bestSim = s;
      best = c.label;
    }
  }
  return best;
};

/** The sound of one track (the one playing when the DJ was started) */
export const anchorFromTrack = async (id: string): Promise<Anchor> => {
  await initBrain();
  await ensureTracks([id]);
  const vec = vectorOf(id);
  const t = tracks[id];
  return { label: nearestLabel(vec) || t?.genres[0]?.toLowerCase() || "", vec, seedId: id };
};

/** The sound of a set (after "switch it up" or a request, the DJ stays with what it moved to) */
export const anchorFromSegment = (seg: Segment): Anchor => {
  if (seg.anchor) return seg.anchor;
  let sum: Float32Array | null = null;
  for (const t of seg.tracks) {
    const v = vectorOf(t.id);
    if (!v) continue;
    sum ??= new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) sum[i] += v[i];
  }
  const vec = sum && normalize(sum);
  const f = seg.facts;
  const label = f.genre ?? (seg.kind === "request" ? (f.matched === "artist" ? "" : f.mood) : undefined) ?? nearestLabel(vec);
  return { label: label || "", vec, seedId: seg.tracks[seg.tracks.length - 1]?.id };
};

/**
 * What a set that continues a sound is called. The sound the session is staying with never changes, so
 * naming every set after it gave "More house" for hours. A set is named after what's actually in it: its
 * own sub-genre when the artists' tags say so, and when that's the same as last time, whatever else is
 * true of it (its decade, that it's new to you, that it's faster or slower than the last one).
 */
const nameSet = (list: Track[], anchor: Anchor, history: Segment[]) => {
  const weights = new Map<string, number>();
  const genres = new Map<string, number>();
  for (const t of list) {
    const artist = t.artists[0]?.id;
    if (artist) weights.set(artist, (weights.get(artist) ?? 0) + 1);
    for (const g of t.genres) genres.set(g, (genres.get(g) ?? 0) + 1);
  }
  const tags = labelFor(weights).split(" / ").filter(Boolean);
  const sound = tags[0] || anchor.label || [...genres.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.toLowerCase() || "";
  if (!sound) return { title: "More like this", sound: undefined };
  const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
  const second = tags[1] && tags[1] !== sound && !tags[1].includes(sound) && !sound.includes(tags[1]) ? tags[1] : undefined;
  const prev = history[history.length - 1];
  const tempo = (ts: Track[]) => {
    const v = ts.map((t) => t.bpm).filter((x): x is number => !!x);
    return v.length >= 2 ? v.reduce((x, y) => x + y, 0) / v.length : 0;
  };
  const years = list.map((t) => Number(t.album?.releaseDate?.slice(0, 4))).filter((y) => y > 1900);
  const decades = new Map<number, number>();
  for (const y of years) decades.set(Math.floor(y / 10) * 10, (decades.get(Math.floor(y / 10) * 10) ?? 0) + 1);
  const [decade, inDecade] = [...decades.entries()].sort((x, y) => y[1] - x[1])[0] ?? [0, 0];
  const fresh = profile ? list.filter((t) => !profile!.known.has(t.id)).length : 0;
  const now = tempo(list);
  const before = prev ? tempo(prev.tracks) : 0;

  const options: string[] = [];
  // A different sound from the last set: its name says it all
  if (sound !== prev?.facts.genre) options.push(second ? `${cap(sound)} and ${second}` : cap(sound));
  if (decade && decade <= 2010 && years.length >= 3 && inDecade >= years.length * 0.7) options.push(`${decade >= 2000 ? decade : String(decade).slice(2)}s ${sound}`);
  if (list.length >= 3 && fresh >= list.length * 0.7) options.push(`${cap(sound)} you haven't heard`);
  if (now && before && now - before >= 3) options.push(`${cap(sound)}, picking up the pace`);
  if (now && before && before - now >= 3) options.push(`${cap(sound)}, easing off`);
  if (second) options.push(`${cap(sound)} and ${second}`);
  options.push(`More ${sound}`, `Staying with ${sound}`, `Deeper into ${sound}`);
  const used = new Set(history.slice(-3).map((h) => h.title));
  return { title: options.find((o) => !used.has(o)) ?? options[0], sound };
};

/** More of the same sound: mostly music you know that sits close to it, plus some you don't */
export const continueSegment = async (anchor: Anchor, history: Segment[]): Promise<Segment> => {
  await initBrain();
  const p = profile!;
  lastTrack = history[history.length - 1]?.tracks.at(-1);
  const n = size();
  const newCount = Math.min(n, Math.round(n * Math.max(0, Math.min(1, settings.discovery / 100))));
  const seedId = lastTrack?.id ?? anchor.seedId;
  const sim = (id: string) => {
    const v = anchor.vec && vectorOf(id);
    return v ? dot(v, anchor.vec!) : 0;
  };

  // Staying with a request: more of what TIDAL's playlist AI gave for it, asking again when it runs low
  if (anchor.pool) {
    const unplayed = () => anchor.pool!.filter((id) => !recentlyPlayed(id) && !history.some((h) => h.tracks.some((t) => t.id === id)));
    if (unplayed().length < n + 2 && anchor.prompt) {
      const more = await aiTracks(`${anchor.prompt} (more like that, different songs)`).catch((err) => (warn("Couldn't ask TIDAL's playlist AI for more", err), { ids: [] as string[] }));
      anchor.pool = [...new Set([...anchor.pool, ...more.ids])];
    }
    let list = await pick(
      unplayed().map((id, i) => ({ id, w: 1 / (1 + i / 20) })),
      wide(),
    );
    // Nothing left of it: what TIDAL's listeners play next to the last track
    if (list.length < 3 && seedId) {
      const ids = (await api.trackMixItems(seedId).catch(() => [] as string[])).slice(0, 60);
      list = await pick(
        ids.map((id, i) => ({ id, w: 1 / (1 + i / 15) })),
        wide(),
      );
    }
    if (list.length < 2) throw new Error("nothing left for this request");
    const chosen = bestChain(list, n, lastTrack);
    const named = nameSet(chosen, anchor, history);
    const seg: Segment = { kind: "more", key: `more:${anchor.label}`, title: named.title, tracks: chosen, facts: { genre: named.sound }, anchor };
    log(`Next set: ${seg.title} [${seg.tracks.map((t) => `${t.artists[0]?.name} - ${t.title}${t.bpm ? ` (${Math.round(t.bpm)})` : ""}`).join(" | ")}]`);
    return seg;
  }

  let familiar: Track[] = [];
  if (anchor.vec && n - newCount > 0) {
    const ranked: { id: string; s: number }[] = [];
    for (const id of p.seeds.keys()) {
      const s = sim(id);
      if (s > 0.55) ranked.push({ id, s });
    }
    ranked.sort((a, b) => b.s - a.s);
    familiar = await pick(
      ranked.slice(0, 150).map((x, i) => ({ id: x.id, w: (p.seeds.get(x.id) ?? 0.1) + 1 / (1 + i / 30) })),
      (n - newCount) * 2 + 2,
    );
  }
  // What TIDAL's listeners play next to this: fills the "new" share, and everything when your library has nothing close
  const wantNew = Math.max(newCount, n - familiar.length);
  let fresh: Track[] = [];
  if (wantNew > 0 && seedId) {
    const ids = [...(await api.similarTracks(seedId).catch(() => [] as string[])), ...(await api.trackMixItems(seedId).catch(() => [] as string[])).slice(0, 50)];
    const pool = [...new Set(ids)].filter((id) => !p.known.has(id) || familiar.length === 0).map((id, i) => ({ id, w: 1 / (1 + i / 15) }));
    fresh = (await pick(pool, wantNew + 3, { exclude: new Set(familiar.map((t) => t.id)) })).filter((t) => !t.ai);
    // Keep the ones closest to the sound, when they can be placed
    if (anchor.vec) fresh.sort((a, b) => sim(b.id) - sim(a.id));
    fresh = fresh.slice(0, wantNew);
  }
  const list = [...bestChain(familiar, Math.max(0, n - fresh.length), lastTrack), ...fresh];
  if (list.length < 2) throw new Error("nothing close to this sound");
  const ordered = flow(list, lastTrack);
  const named = nameSet(ordered, anchor, history);
  const seg: Segment = { kind: "more", key: `more:${anchor.label}`, title: named.title, tracks: ordered, facts: { genre: named.sound }, anchor };
  log(`Next set: ${seg.title} [${seg.tracks.map((t) => `${t.artists[0]?.name} - ${t.title}${t.bpm ? ` (${Math.round(t.bpm)})` : ""}`).join(" | ")}]`);
  return seg;
};

// ------------------ REQUESTS ------------------
let genreNames: Set<string> | undefined;
/** A real genre name ("drum and bass", "breakcore"), as opposed to an artist who happens to be called that */
const isGenre = (text: string) => (genreNames ??= new Set(genreList.split("\n").map(normTag))).has(normTag(text));

const STOP_WORDS = new Set("a an the some any play put on me my i im want wanna need give us can you could please dj hey ok okay to for of and with something stuff music songs song tracks track tunes like more make it lets let s now just really bit little listen hear feel feeling in mood vibe vibes playlist kind".split(" "));
const UP = /\b(upbeat|energy|energetic|hype|hyped|faster|pump|pumped|dance|dancing|party|workout|gym|run|running|banger|bangers|loud|harder)\b/;
const DOWN = /\b(chill|calm|calmer|relax|relaxing|slow|slower|mellow|quiet|quieter|sleep|sleepy|study|studying|focus|rainy|soft|softer|gentle|wind down|unwind)\b/;

const searchPlaylists = async (query: string) => {
  const res = await api.v1<{ items?: { uuid: string; title: string; numberOfTracks?: number }[] }>("search/playlists", { query, limit: 6 }).catch(() => undefined);
  return (res?.items ?? []).filter((p) => (p.numberOfTracks ?? 0) >= 15);
};

/** A typed request: a command, or a set built around what was asked for */
export const request = async (text: string, current?: Track, progress?: Progress): Promise<Segment | Command | null> => {
  await initBrain();
  const q = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;
  if (/^(stop|quit|exit|bye|goodbye|turn (it |yourself )?off|that'?s (all|enough)|good ?night)\b/.test(q)) return { command: "stop" };
  if (/^(skip|next)( (this|it|one|song|track))*$/.test(q) || /\bskip this\b/.test(q)) return { command: "skip" };
  if (/\b(less|stop|no|quit|without|zero)\b.{0,12}\b(talk|talking|chatter|chat|commentary|speaking)\b|\b(shut up|be quiet|just (the )?music)\b/.test(q)) return { command: "quiet" };
  if (/\b(more|start|bring back)\b.{0,12}\b(talk|talking|chatter|commentary)\b|\btalk (to me|more)\b/.test(q)) return { command: "chatty" };

  const p = profile!;
  const n = size();
  const title = `You asked: ${text.trim()}`;
  const done = (list: Track[], facts: Facts): Segment | null => (list.length >= 2 ? { kind: "request", key: `request:${q}`, title, tracks: flow(list, current), facts: { query: text.trim(), ...facts } } : null);

  // Things the DJ already knows how to do
  if (/\b(throwback|throwbacks|nostalgi\w*|old (stuff|songs|favou?rites)|back in the day|memory lane)\b/.test(q)) {
    const s = await throwback();
    if (s) return { ...s, facts: { ...s.facts, query: text.trim() } };
  }
  if (/\b(new (music|stuff|songs|releases|tracks)|something new|discover\w*|haven'?t heard|never heard|surprise me|unfamiliar)\b/.test(q)) {
    const s = await discovery();
    if (s) return { ...s, facts: { ...s.facts, query: text.trim() } };
  }
  if (/\b(favou?rites?|on repeat|most played|my top|what i('| ha)?ve been (playing|listening))\b/.test(q)) {
    const s = (await onRepeat()) ?? (await recentLikes());
    if (s) return { ...s, facts: { ...s.facts, query: text.trim() } };
  }
  if (current && /\b(more like this|like this (one|song|track)|similar to this|this vibe|keep this)\b/.test(q)) {
    const ids = [...(await api.similarTracks(current.id).catch(() => [] as string[])), ...(await api.trackMixItems(current.id).catch(() => [] as string[])).slice(0, 40)];
    const list = await pick(
      ids.map((id, i) => ({ id, w: 1 / (1 + i / 12) })),
      n,
      { exclude: new Set([current.id]) },
    );
    const s = done(list, { matched: "radio", artist: current.artists[0]?.name });
    if (s) return s;
  }
  // "songs I listened to in 2024"
  const year = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(q);
  if (year && /\b(listened|played|was into|i liked|my)\b/.test(q)) {
    const y = Number(year[1]);
    const ids = new Map<string, number>();
    for (const m of state.historyMonths ?? []) if (new Date(m.at).getFullYear() === y && !/ALLTIME/.test(m.type)) m.tracks.forEach((id, i) => ids.set(id, Math.max(ids.get(id) ?? 0, 1 - (0.6 * i) / m.tracks.length)));
    for (const [id, at] of Object.entries(state.likes)) if (new Date(at).getFullYear() === y) ids.set(id, Math.max(ids.get(id) ?? 0, 0.5));
    const s = done(await pick([...ids.entries()].map(([id, w]) => ({ id, w })), n), { matched: "year", year: y });
    if (s) return s;
  }

  // Everything else goes to TIDAL's playlist AI, which actually knows what "brazilian funk" is
  {
    const label = q
      .replace(/^(hey |ok |okay )?(dj )?(please )?(can you |could you )?((play|put on|i want|i wanna hear|give me|let'?s hear|queue|some|more|genre|me) )*/, "")
      .replace(/ (please|now|music|songs|stuff|tracks|tunes)$/, "")
      .trim();
    const relative = UP.test(q) || DOWN.test(q) || /\b(this|same|similar)\b/.test(q);
    const prompt = relative && current ? `${text.trim()}. For reference, what is playing now: "${current.title}" by ${current.artists[0]?.name ?? "unknown"}` : text.trim();
    const ai = await aiTracks(prompt, progress).catch((err) => (warn("TIDAL's playlist AI couldn't be used, falling back to matching words", err), { ids: [] as string[], title: undefined }));
    const ids = ai.ids;
    if (ids.length >= 3) {
      progress?.("Choosing where to start");
      // The first tracks are the most on-target: the opening set comes from the top of the list
      const list = await pick(
        ids.slice(0, Math.max(12, n * 2)).map((id, i) => ({ id, w: 1 / (1 + i / 6) })),
        wide(),
        { exclude: current ? new Set([current.id]) : undefined },
      );
      if (list.length >= 2) {
        const tracksPicked = bestChain(list, n, current);
        log(`Request "${text.trim()}": TIDAL's playlist AI gave ${ids.length} tracks`);
        return {
          kind: "request",
          key: `request:${q}`,
          title,
          tracks: tracksPicked,
          facts: { query: text.trim(), matched: "playlist", mood: label, aiTitle: ai.title },
          anchor: { label, vec: null, seedId: tracksPicked[tracksPicked.length - 1]?.id, pool: ids, prompt: text.trim() },
        };
      }
    }
  }

  // Fallbacks when TIDAL's playlist AI isn't available: matching the words of the request
  // What's being asked for, without the "play me some…"
  const words = q.split(" ").filter((w) => !STOP_WORDS.has(w) && w !== "genre");
  const subject = q
    .replace(/^(hey |ok |okay )?(dj )?(please )?(can you |could you )?((play|put on|i want|i wanna hear|give me|let'?s hear|queue|some|more|genre) )*/, "")
    .replace(/^(some|more|music by|songs by|stuff by|something by|by) /, "")
    .replace(/ (please|now|music|songs|stuff)$/, "")
    .trim();
  const genre = isGenre(subject) || isGenre(words.join(" "));
  const byArtist = /\b(by|artist)\b/.test(q);

  // An artist by name. Genres come first: "drum and bass" is a genre, even though an artist has that name
  if (subject && subject.split(" ").length <= 5 && (!genre || byArtist) && !(UP.test(q) || DOWN.test(q))) {
    const artistId = await api.searchArtist(subject).catch(() => undefined);
    if (artistId && !blocked.artists.has(artistId)) {
      const top = await api.artistTopTracks(artistId, 15).catch(() => [] as string[]);
      await ensureTracks(top.slice(0, 15));
      const name = tracks[top[0]]?.artists.find((a) => a.id === artistId)?.name ?? subject;
      const loved: Weighted[] = [];
      for (const [id, w] of p.seeds) if (tracks[id]?.artists.some((a) => a.id === artistId)) loved.push({ id, w: 1 + w });
      const pool = new Map<string, number>(top.map((id, i) => [id, 1 / (1 + i / 5)]));
      for (const l of loved) pool.set(l.id, (pool.get(l.id) ?? 0) + l.w);
      const list = await pick([...pool.entries()].map(([id, w]) => ({ id, w })), n, { sameArtist: true });
      const s = done(list, { matched: "artist", artist: name });
      if (s) return s;
    }
  }

  // A vibe: genre, mood or moment. Your own library first, then TIDAL's playlists for it
  const qv = vibeVector(words);
  const picks: Weighted[] = [];
  if (qv) {
    // A named genre has to really be that genre: only close matches from your library count
    const ranked = byVibe(qv, p.seeds.keys()).filter((x) => x.s > (genre ? 0.12 : 0.03));
    ranked.slice(0, 60).forEach((x, i) => picks.push({ id: x.id, w: (0.5 + x.s * 4) / (1 + i / 25) }));
  }
  const fromPlaylists: Weighted[] = [];
  if ((genre || picks.length < n * 3) && words.length) {
    for (const pl of (await searchPlaylists(genre ? subject : words.join(" "))).slice(0, 2)) {
      (await api.playlistTracks(pl.uuid, 80).catch(() => [])).forEach((t, i) => fromPlaylists.push({ id: t.id, w: 0.6 / (1 + i / 40) }));
    }
  }
  let pool = [...picks, ...fromPlaylists];
  // "More upbeat" / "calmer": lean on tempo too
  const up = UP.test(q);
  const down = DOWN.test(q);
  if ((up || down) && pool.length) {
    await ensureTracks(pool.slice(0, 80).map((x) => x.id));
    const ref = current?.bpm ?? p.bpm?.mean ?? 115;
    pool = pool.map((x) => {
      const bpm = tracks[x.id]?.bpm;
      if (!bpm) return x;
      const rel = (bpm - ref) / 30;
      return { id: x.id, w: x.w * Math.max(0.15, 1 + (up ? rel : -rel)) };
    });
  }
  if (pool.length) {
    const list = await pick(pool, n);
    const s = done(list, { matched: picks.length >= fromPlaylists.length ? "vibe" : "playlist", mood: genre ? subject : words.join(" ") });
    // The DJ stays with what was asked for, not with wherever these particular tracks happen to sit
    if (s) return { ...s, anchor: { label: genre ? subject : words.join(" "), vec: qv, seedId: s.tracks[s.tracks.length - 1]?.id } };
  }
  return null;
};

/** Short prompts offered as chips, fitted to the time of day and your taste */
export const suggestions = (): string[] => {
  const part = daypart();
  const out = ["Switch it up", part === "morning" ? "Something easy for the morning" : part === "late night" ? "Late night vibes" : "Make it more upbeat"];
  const genre = clusters.map((c) => c.label).filter(Boolean)[Math.floor(Math.random() * Math.max(1, Math.min(3, clusters.length)))];
  if (genre) out.push(`Some ${genre}`);
  out.push("Throwbacks", "Something new", "More like this");
  return out;
};

export const stopRequests = () => api.stopRequests();
