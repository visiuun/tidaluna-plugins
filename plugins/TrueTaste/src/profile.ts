// Turns raw signals into a taste profile. Following Spotify's "slow and fast-moving interests" research,
// listening decays on three clocks: who you are (months), what you're into lately (weeks), and what you
// can't stop playing right now (days). Your saved library (years of likes, old playlists) is a separate,
// deliberately light signal: it mostly guards against recommending what you already have.
import genreList from "file://../assets/genres.txt";
import { artists, state, tracks } from "./db";
import { normTag } from "./tagspace";
import type { Track } from "./types";

const DAY = 864e5;
const SLOW_HALF_LIFE = 180 * DAY;
const FAST_HALF_LIFE = 14 * DAY;
const NOW_HALF_LIFE = 2 * DAY;

/**
 * What one listen says about a track, from -1 to 1, continuous in how long you stayed: bailing in the
 * first seconds is a hard no, leaving after half a minute a mild one, and past that it counts more the
 * more of the track you heard. Replays add up, so the songs you keep coming back to rise to the top,
 * and the ones you keep cutting short sink.
 */
export const engagement = (ms: number, ratio: number) => {
  if (ratio >= 0.85) return 1;
  const s = ms / 1000;
  if (s < 8) return -1;
  if (s < 30) return -1 + ((s - 8) / 22) * 0.7;
  return 0.1 + 0.9 * Math.min(1, Math.max(0, (ratio - 0.15) / 0.7));
};

export type Clocks = { slow: number; fast: number; now: number; lib: number };
/** How much each clock counts. The engine shifts this towards "now" when it detects your taste moving */
export type Mix = Clocks;

export type Profile = {
  seeds: Map<string, number>; // trackId → positive weight (0-1]
  parts: Map<string, Clocks>; // per-clock evidence behind each seed, normalised 0-1
  negatives: Map<string, number>; // trackId → negative weight (0-1]
  mix: Mix;
  listeningEvidence: number; // how much real listening backs the profile
  known: Set<string>; // anything heard, liked or in any playlist: never "discovered" again
  knownTitles: Set<string>; // normalised "artist|title", catches other releases of a known song
  knownIsrcs: Set<string>; // same recording under another track id
  artistAffinity: Map<string, number>; // 0-1
  artistFamiliarity: Map<string, number>; // songs of theirs you know (whole library, not just fetched ones)
  artistSkipRate: Map<string, number>; // share of that artist's plays you cut short
  dislikedArtists: Set<string>; // 👎 on two or more of their tracks
  favArtists: Set<string>;
  pop: { mean: number; std: number } | null;
  bpm: { mean: number; std: number } | null;
  versionTaste: { live: number; remix: number; acoustic: number; altered: number };
};

const decay = (age: number, halfLife: number) => Math.pow(0.5, Math.max(0, age) / halfLife);

export const titleKey = (t: Pick<Track, "title" | "artists">) =>
  `${(t.artists[0]?.name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}|${t.title
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]|-\s.*$/g, "")
    .replace(/[^a-z0-9]/g, "")}`;

export const VERSION_RE = {
  live: /\blive\b|\bin concert\b|\bunplugged\b/i,
  remix: /\bremix\b|\bmix\)|\bedit\)|\brework\b|\bbootleg\b|\bvip\b/i,
  acoustic: /\bacoustic\b|\bpiano version\b|\bstripped\b/i,
  // Sped up / slowed edits: some people love them, so they follow your taste like live and remix
  altered: /\bsped up\b|\bslowed\b|\b8d\b|\bnightcore\b|\+ ?reverb\b/i,
  // Never good discoveries
  junk: /\bkaraoke\b|\binstrumental version\b|\bmade famous by\b|\bin the style of\b|\btribute to\b|\blullaby\b|\bringtone\b/i,
};
export const versionText = (t: Pick<Track, "title" | "version">) => `${t.title} ${t.version ?? ""}`;

const weightedStats = (pairs: [number, number][]) => {
  const W = pairs.reduce((s, [, w]) => s + w, 0);
  if (W <= 0 || pairs.length < 5) return null;
  const mean = pairs.reduce((s, [v, w]) => s + v * w, 0) / W;
  const variance = pairs.reduce((s, [v, w]) => s + w * (v - mean) ** 2, 0) / W;
  return { mean, std: Math.max(Math.sqrt(variance), 1e-3) };
};

const maxOf = (m: Map<string, number>) => {
  let max = 1e-9;
  for (const v of m.values()) if (v > max) max = v;
  return max;
};

/** Seed weights for a given clock mix. Skips and 👎 pull a track down whatever the mix */
export const blendSeeds = (parts: Map<string, Clocks>, negatives: Map<string, number>, mix: Mix) => {
  const seeds = new Map<string, number>();
  for (const [id, c] of parts) {
    const w = mix.slow * c.slow + mix.fast * c.fast + mix.now * c.now + mix.lib * c.lib - 0.3 * (negatives.get(id) ?? 0);
    if (w > 0.02) seeds.set(id, w);
  }
  return seeds;
};

/** Default mix: listening clocks split 45/35/20; the library's share shrinks as listening evidence grows */
export const defaultMix = (listeningEvidence: number): Mix => {
  const lib = Math.min(0.5, Math.max(0.1, 0.5 - listeningEvidence / 600));
  return { slow: 0.45 * (1 - lib), fast: 0.35 * (1 - lib), now: 0.2 * (1 - lib), lib };
};

export const buildProfile = (now = Date.now()): Profile => {
  const slow = new Map<string, number>();
  const fast = new Map<string, number>();
  const recent = new Map<string, number>();
  const lib = new Map<string, number>();
  const neg = new Map<string, number>();
  const known = new Set<string>();
  const plays = new Map<string, { plays: number; skips: number }>();
  const add = (m: Map<string, number>, id: string, v: number) => m.set(id, (m.get(id) ?? 0) + v);
  /** A listening signal of strength v that happened at time `at` */
  const listen = (id: string, v: number, at: number) => {
    const age = now - at;
    add(slow, id, v * decay(age, SLOW_HALF_LIFE));
    add(fast, id, v * decay(age, FAST_HALF_LIFE));
    add(recent, id, v * decay(age, NOW_HALF_LIFE));
  };
  let evidence = 0;

  // Tracked plays: the main signal, continuous in listening time
  for (const e of state.events) {
    known.add(e.id);
    const v = engagement(e.ms, e.ratio);
    // Skips fade faster than loves: a skip is often about the moment, not the song
    if (v > 0) listen(e.id, v, e.t);
    else add(neg, e.id, -v * decay(now - e.t, 60 * DAY));
    const p = plays.get(e.id) ?? { plays: 0, skips: 0 };
    p.plays++;
    if (v < 0) p.skips++;
    plays.set(e.id, p);
    evidence++;
  }

  // 👍 / 👎: the most explicit signal there is
  const dislikesPerArtist = new Map<string, number>();
  for (const [id, f] of Object.entries(state.feedback ?? {})) {
    known.add(id);
    evidence += 3;
    if (f.v > 0) listen(id, 3, f.at);
    else {
      add(neg, id, 3 * decay(now - f.at, 120 * DAY));
      for (const a of f.artists) dislikesPerArtist.set(a, (dislikesPerArtist.get(a) ?? 0) + 1);
    }
  }

  // "My Most Listened" by month/year/all time: dated, play-count-ranked listening. Higher rank, more weight
  for (const m of state.historyMonths ?? []) {
    const allTime = /ALLTIME/.test(m.type);
    m.tracks.forEach((id, rank) => {
      known.add(id);
      const v = (/MONTHLY/.test(m.type) ? 1.5 : 1) * (1 - (0.5 * rank) / Math.max(1, m.tracks.length));
      if (allTime) add(slow, id, v);
      else listen(id, v, m.at);
      evidence += 0.5;
    });
  }

  // TIDAL "recently played" from every device, newest first
  for (const [id, at] of Object.entries(state.recentTracks ?? {})) {
    known.add(id);
    listen(id, 0.8, at);
    evidence += 0.5;
  }

  // Likes: a recent heart is current taste; years of hearts kept for memories are only a faint hint
  for (const [id, at] of Object.entries(state.likes)) {
    known.add(id);
    if ((state.unlikes[id] ?? 0) > at) {
      add(neg, id, 1);
      continue;
    }
    if (now - at < 90 * DAY) listen(id, 2, at);
    else add(lib, id, decay(now - at, 730 * DAY));
  }
  // Playlists count by how recently you touched them
  for (const [id, updated] of Object.entries(state.playlistTracks)) {
    known.add(id);
    add(lib, id, 0.8 * decay(now - updated, 365 * DAY));
  }
  for (const id of Object.keys(state.followedTracks ?? {})) known.add(id);
  for (const id of Object.keys(state.historyTracks ?? {})) known.add(id);

  // Normalise each clock so none dominates by sheer volume
  const ms = maxOf(slow);
  const mf = maxOf(fast);
  const mr = maxOf(recent);
  const ml = maxOf(lib);
  const parts = new Map<string, Clocks>();
  for (const id of new Set([...slow.keys(), ...lib.keys()])) {
    parts.set(id, {
      slow: Math.sqrt((slow.get(id) ?? 0) / ms),
      fast: Math.sqrt((fast.get(id) ?? 0) / mf),
      now: Math.sqrt((recent.get(id) ?? 0) / mr),
      lib: Math.sqrt((lib.get(id) ?? 0) / ml),
    });
  }
  const mn = maxOf(neg);
  const negatives = new Map<string, number>();
  for (const [id, v] of neg) if (v / mn > 0.05) negatives.set(id, Math.min(1, v / mn));
  const mix = defaultMix(evidence);
  const seeds = blendSeeds(parts, negatives, mix);
  for (const id of seeds.keys()) negatives.delete(id);

  // Artist level
  const favArtists = new Set(state.favArtists);
  const affinity = new Map<string, number>();
  const familiarity = new Map<string, number>();
  const artistPlays = new Map<string, { plays: number; skips: number }>();
  const knownTitles = new Set<string>(state.libraryKeys ?? []);
  const knownIsrcs = new Set<string>(state.libraryIsrcs ?? []);
  // Familiarity covers the whole library, including tracks whose details were never fetched
  for (const [a, n] of Object.entries(state.libraryArtists ?? {})) familiarity.set(a, n);
  for (const a of Object.keys(state.recentArtists ?? {})) familiarity.set(a, (familiarity.get(a) ?? 0) + 1);
  for (const id of known) {
    const t = tracks[id];
    if (!t) continue;
    knownTitles.add(titleKey(t));
    if (t.isrc) knownIsrcs.add(t.isrc);
    t.artists.forEach((a, i) => {
      if (!state.libraryArtists?.[a.id]) familiarity.set(a.id, (familiarity.get(a.id) ?? 0) + 1);
      const w = seeds.get(id);
      if (w) add(affinity, a.id, w * (i === 0 ? 1 : 0.4));
      const p = plays.get(id);
      if (p && i === 0) {
        const ap = artistPlays.get(a.id) ?? { plays: 0, skips: 0 };
        ap.plays += p.plays;
        ap.skips += p.skips;
        artistPlays.set(a.id, ap);
      }
    });
  }
  // Followed artists and recently played artists nudge affinity; followed lists are often old, so lightly
  for (const a of favArtists) add(affinity, a, 0.3);
  for (const [a, at] of Object.entries(state.recentArtists ?? {})) add(affinity, a, 0.8 * decay(now - at, FAST_HALF_LIFE));
  const ma = Math.max(1e-9, ...[...affinity.values()].map(Math.sqrt));
  for (const [a, v] of affinity) affinity.set(a, Math.sqrt(v) / ma);
  const skipRate = new Map<string, number>();
  for (const [a, p] of artistPlays) if (p.plays >= 3) skipRate.set(a, p.skips / p.plays);
  const dislikedArtists = new Set([...dislikesPerArtist].filter(([, n]) => n >= 2).map(([a]) => a));

  // What "your kind of track" looks like numerically
  const popPairs: [number, number][] = [];
  const bpmPairs: [number, number][] = [];
  const versionW = { live: 0, remix: 0, acoustic: 0, altered: 0, total: 0 };
  for (const [id, w] of seeds) {
    const t = tracks[id];
    if (!t) continue;
    if (t.popularity !== undefined) popPairs.push([t.popularity, w]);
    if (t.bpm) bpmPairs.push([t.bpm, w]);
    const vt = versionText(t);
    versionW.total += w;
    if (VERSION_RE.live.test(vt)) versionW.live += w;
    if (VERSION_RE.remix.test(vt)) versionW.remix += w;
    if (VERSION_RE.acoustic.test(vt)) versionW.acoustic += w;
    if (VERSION_RE.altered.test(vt)) versionW.altered += w;
  }
  const share = (v: number) => (versionW.total > 0 ? v / versionW.total : 0);

  return {
    seeds,
    parts,
    negatives,
    mix,
    listeningEvidence: evidence,
    known,
    knownTitles,
    knownIsrcs,
    artistAffinity: affinity,
    artistFamiliarity: familiarity,
    artistSkipRate: skipRate,
    dislikedArtists,
    favArtists,
    pop: weightedStats(popPairs),
    bpm: weightedStats(bpmPairs),
    versionTaste: { live: share(versionW.live), remix: share(versionW.remix), acoustic: share(versionW.acoustic), altered: share(versionW.altered) },
  };
};

// ------------------ DESCRIPTORS ------------------
// Tags that say nothing about the sound
const JUNK_TAG = /^(seen live|favou?rites?|favou?rite|love|loved|awesome|amazing|beautiful|best|my|good|cool|albums i own|spotify|under \d+|all|music|\d{2,4}s?|check out|owned|vinyl|cd)$/;

const cleanTags = (artistId: string) => {
  const info = artists[artistId];
  const name = info?.name?.toLowerCase() ?? "";
  return (info?.tags ?? []).filter((t) => t.count >= 5 && !JUNK_TAG.test(t.name) && t.name !== name && t.name.length < 30);
};

// Inverse document frequency over every artist we know: "rock" says little, "slowcore" says a lot
let idfCache: { at: number; idf: Map<string, number>; n: number } | null = null;
const idf = (tag: string) => {
  if (!idfCache || Date.now() - idfCache.at > 60000) {
    const df = new Map<string, number>();
    let n = 0;
    for (const id in artists) {
      const tags = cleanTags(id);
      if (!tags.length) continue;
      n++;
      for (const t of tags.slice(0, 10)) df.set(t.name, (df.get(t.name) ?? 0) + 1);
    }
    idfCache = { at: Date.now(), idf: df, n };
  }
  // Too few artists to know what's common yet: treat all tags alike
  if (idfCache.n < 30) return 1;
  return Math.log(1 + idfCache.n / (1 + (idfCache.idf.get(tag) ?? 0)));
};

/**
 * An artist's sound as weighted tags (Last.fm strength × distinctiveness). Each tag has its own vector in
 * the taste space and they're mixed with these weights, so specific tags aren't drowned out by generic ones.
 */
export const artistTagWeights = (artistId: string): [string, number][] =>
  cleanTags(artistId)
    .slice(0, 10)
    .map((t): [string, number] => [t.name, (t.count / 100) * idf(t.name)]);

// Cluster names only use real genre names (MusicBrainz's curated list): "usa", "female vocalists" or
// "seen live" are fine inside vectors but say nothing about a sound
let genreNames: Set<string> | null = null;
const isGenre = (tag: string) => (genreNames ??= new Set(genreList.split("\n").map(normTag))).has(normTag(tag));

/** Top tags of a weighted set of artists, used to name taste clusters */
export const labelFor = (artistWeights: Map<string, number>) => {
  const score = new Map<string, number>();
  const support = new Map<string, number>();
  for (const [a, w] of artistWeights) {
    const tags = (artists[a]?.tags ?? []).filter((t) => t.count >= 10 && isGenre(t.name));
    // Distinctive tags make better names: "uk garage" over "electronic", never "canada"
    tags.slice(0, 5).forEach((t, i) => {
      score.set(t.name, (score.get(t.name) ?? 0) + w * (1 - i * 0.15) * idf(t.name));
      support.set(t.name, (support.get(t.name) ?? 0) + 1);
    });
  }
  // A name has to describe the group, not one artist's quirk
  const minSupport = artistWeights.size >= 4 ? 2 : 1;
  return [...score.entries()]
    .filter(([t]) => (support.get(t) ?? 0) >= minSupport)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([t]) => t)
    .join(" / ");
};
