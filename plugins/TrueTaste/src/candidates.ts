// Candidate retrieval: cast a wide net from several independent sources, each anchored on a different
// part of your taste. Ranking happens later; here, recall matters more than precision.
import * as api from "./api";
import { artists, state, tracks } from "./db";
import type { Profile } from "./profile";
import type { Cluster } from "./rank";

export type Pool = Map<string, { graph: number; sources: Set<string> }>;

type Log = (msg: string) => void;
const DAY = 864e5;

const addTo = (pool: Pool, id: string, source: string, weight: number) => {
  const c = pool.get(id) ?? { graph: 0, sources: new Set<string>() };
  c.graph += weight;
  c.sources.add(source);
  pool.set(id, c);
};
const rankDecay = (i: number, scale = 10) => 1 / (1 + i / scale);

// Weighted sampling without replacement; seeds used in the last few days are down-weighted so every
// day explores a different corner of your library
const sampleSeeds = (members: { id: string; w: number }[], n: number) => {
  const now = Date.now();
  const pool = members.map((m) => ({ ...m, w: m.w * (now - (state.seedsUsed[m.id] ?? 0) < 4 * DAY ? 0.08 : 1) * (0.6 + Math.random() * 0.8) }));
  const out: string[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let r = Math.random() * total;
    const i = Math.max(0, pool.findIndex((p) => (r -= p.w) <= 0));
    out.push(pool[i].id);
    pool.splice(i, 1);
  }
  return out;
};

const apportion = (clusters: Cluster[], total: number) => {
  const shares = clusters.map((c) => Math.pow(c.weight, 0.7));
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  return shares.map((s) => Math.max(1, Math.round((s / sum) * total)));
};

const safe = async <T>(p: Promise<T>, fallback: T, log: Log, what: string): Promise<T> => {
  try {
    return await p;
  } catch (err) {
    if (api.isAbort(err)) throw err;
    log(`${what} failed: ${(err as Error).message}`);
    return fallback;
  }
};

export const gatherCandidates = async (profile: Profile, clusters: Cluster[], unclustered: { id: string; w: number }[], useLastfm: boolean, log: Log) => {
  const pool: Pool = new Map();
  const now = Date.now();

  // 1) Seeds, spread across clusters (plus a few seeds we couldn't place in the taste space)
  const seedsPerCluster = apportion(clusters, 14);
  const seeds: { id: string; w: number }[] = [];
  clusters.forEach((c, k) => {
    for (const id of sampleSeeds(c.members, seedsPerCluster[k])) seeds.push({ id, w: profile.seeds.get(id) ?? 0.5 });
  });
  for (const id of sampleSeeds(unclustered, clusters.length ? 2 : 14)) seeds.push({ id, w: profile.seeds.get(id) ?? 0.5 });
  for (const s of seeds) state.seedsUsed[s.id] = now;
  log(`Seeds: ${seeds.map((s) => `${tracks[s.id]?.artists[0]?.name ?? "?"} - ${tracks[s.id]?.title ?? s.id}`).join(" | ")}`);

  // 2) TIDAL similar tracks (TIDAL's collaborative filtering, one hop from each seed)
  for (const s of seeds) {
    const ids = await safe(api.similarTracks(s.id), [], log, `similarTracks ${s.id}`);
    ids.forEach((id, i) => addTo(pool, id, `similar:${s.id}`, s.w * rankDecay(i)));
  }

  // 3) Track radio for the strongest seed of the top clusters (longer, more adventurous chains)
  const radioSeeds = clusters.length ? clusters.slice(0, 3).map((c) => [...c.members].sort((a, b) => b.w - a.w)[Math.floor(Math.random() * Math.min(5, c.members.length))]?.id) : seeds.slice(0, 3).map((s) => s.id);
  for (const id of radioSeeds.filter(Boolean)) {
    const ids = await safe(api.trackMixItems(id), [], log, `track radio ${id}`);
    ids.forEach((tid, i) => addTo(pool, tid, `radio:${id}`, 0.5 * (profile.seeds.get(id) ?? 0.5) * rankDecay(i, 25)));
  }

  // 4) Artist expansion: artists similar to the ones you love that you've never played
  const topArtistsPerCluster = clusters.length
    ? clusters.map((c) => {
        const aw = new Map<string, number>();
        for (const m of c.members) {
          const a = tracks[m.id]?.artists[0]?.id;
          if (a) aw.set(a, (aw.get(a) ?? 0) + m.w);
        }
        return [...aw.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
      })
    : [[...profile.artistAffinity.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a)];
  const artistQuota = apportion(clusters.length ? clusters : [{ weight: 1 } as Cluster], 10);
  const seedArtists = topArtistsPerCluster.flatMap((list, k) => {
    // Skip the very top artist sometimes so it isn't always the same neighbourhood
    const shuffled = list.slice(0, 8).sort(() => Math.random() - 0.5);
    return shuffled.slice(0, artistQuota[k]);
  });
  const newArtists = new Map<string, number>();
  for (const a of seedArtists) {
    const similar = await safe(api.similarArtists(a), [], log, `similarArtists ${a}`);
    similar.forEach((sa, i) => {
      if ((profile.artistFamiliarity.get(sa) ?? 0) > 0) return;
      newArtists.set(sa, (newArtists.get(sa) ?? 0) + (0.3 + (profile.artistAffinity.get(a) ?? 0)) * rankDecay(i, 8));
    });
  }
  const expand = [...newArtists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const maxNew = expand[0]?.[1] ?? 1;
  for (const [a, score] of expand) {
    const ids = await safe(api.artistTopTracks(a, 6), [], log, `toptracks ${a}`);
    ids.forEach((id, i) => addTo(pool, id, `simartist:${a}`, 0.8 * (score / maxNew) * rankDecay(i, 3)));
  }

  // 5) Last.fm: a second, scrobble-based opinion. Similar artists and similar tracks, mapped onto TIDAL
  if (useLastfm) {
    const knownNames = new Set<string>();
    for (const id of profile.known) for (const a of tracks[id]?.artists ?? []) knownNames.add(api.normName(a.name));
    const lfmArtists = seedArtists
      .slice(0, 6)
      .map((a) => artists[a]?.name)
      .filter((n): n is string => !!n);
    const lfmNew = new Map<string, number>();
    for (const name of lfmArtists) {
      const similar = await safe(api.lastfmSimilarArtists(name, 25), [], log, `lastfm similar ${name}`);
      for (const s of similar) if (!knownNames.has(api.normName(s.name))) lfmNew.set(s.name, Math.max(lfmNew.get(s.name) ?? 0, s.match));
    }
    for (const [name, match] of [...lfmNew.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      const id = await safe(api.searchArtist(name), undefined, log, `search ${name}`);
      if (!id) continue;
      const ids = await safe(api.artistTopTracks(id, 5), [], log, `toptracks ${id}`);
      ids.forEach((tid, i) => addTo(pool, tid, `lastfm-artist:${id}`, 0.7 * match * rankDecay(i, 3)));
    }
    for (const s of [...seeds].sort((a, b) => b.w - a.w).slice(0, 4)) {
      const t = tracks[s.id];
      if (!t?.artists[0]) continue;
      const similar = await safe(api.lastfmSimilarTracks(t.artists[0].name, t.title, 15), [], log, `lastfm similar track ${t.title}`);
      const fresh = similar.filter((x) => !knownNames.has(api.normName(x.artist))).slice(0, 6);
      for (const x of fresh) {
        const id = await safe(api.searchTrack(x.artist, x.title), undefined, log, `search ${x.title}`);
        if (id) addTo(pool, id, `lastfm-track:${s.id}`, s.w * x.match);
      }
    }
  }

  // 6) TIDAL's own personal mixes: not thrown away, just re-ranked against your real taste
  const mixes = await safe(api.myMixes(), [], log, "my mixes");
  for (const mix of mixes) {
    if (/VIDEO/.test(mix.mixType)) continue;
    const kind = /DISCOVERY/.test(mix.mixType) ? "tidal-dd" : /NEW_RELEASE/.test(mix.mixType) ? "tidal-newrel" : /DAILY_MIX/.test(mix.mixType) ? "tidal-daily" : null;
    if (!kind) continue;
    const ids = await safe(api.mixItems(mix.id), [], log, `mix ${mix.mixType}`);
    const w = kind === "tidal-dd" ? 0.6 : kind === "tidal-newrel" ? 0.5 : 0.3;
    ids.forEach((id, i) => addTo(pool, id, `${kind}:${mix.id}`, w * rankDecay(i, 20)));
  }

  log(`Candidate pool: ${pool.size} tracks from ${seeds.length} seeds, ${seedArtists.length} seed artists, ${expand.length} new artists`);
  return pool;
};
