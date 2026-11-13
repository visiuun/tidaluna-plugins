// Where a track's genres come from. The same two sources TrueTaste and the DJ use:
//  - TIDAL's own genres for the track (OpenAPI v2 `genres` relationship): curated per release, but broad
//    ("Hip Hop", "Dance", "Electronic").
//  - The artists' Last.fm tags, kept only when they are real genre names (MusicBrainz's curated list),
//    so "usa", "female vocalists" or "seen live" never show up. These name the sound more closely
//    ("plugg", "tech house", "hyperpop").
// A genre both sources agree on ranks highest. Track-level Last.fm tags (what this plugin used before)
// are sparse and noisy, so they aren't used at all.
import genreList from "file://../../TrueTaste/assets/genres.txt";

const V2 = "https://openapi.tidal.com/v2/";
const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_KEY = "b25b959554ed76058ac220b7b2e0a026";

const lib = () => window.luna.lib!;
const countryCode = () => lib().redux.store.getState().session?.countryCode ?? "US";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Hip-Hop", "hip hop", "hip_hop" → "hip hop" */
const normTag = (t: string) =>
  t
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}& ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

// Common spellings that aren't in the list under that name, and pairs that mean the same thing
const ALIASES: Record<string, string> = {
  rap: "hip hop",
  hiphop: "hip hop",
  "hip hop rap": "hip hop",
  rnb: "r&b",
  "r and b": "r&b",
  "rhythm and blues": "r&b",
  synthpop: "synth pop",
  electronica: "electronic",
  "drum n bass": "drum and bass",
  "drum & bass": "drum and bass",
  dnb: "drum and bass",
  "d&b": "drum and bass",
  lofi: "lo fi",
  kpop: "k pop",
  jpop: "j pop",
};
const canon = (t: string) => {
  const n = normTag(t);
  return ALIASES[n] ?? n;
};

// Broad labels that are true but say little. They still show, after anything more specific
const BROAD = new Set(["pop", "rock", "electronic", "dance", "hip hop", "alternative", "indie", "r&b", "soul", "jazz", "classical", "country", "folk", "metal", "latin", "world", "singer songwriter"]);

let genreNames: Map<string, string> | null = null;
/** Every known genre, normalized → its written form ("uk garage" → "uk garage", "synth pop" → "synth-pop") */
const genres = () => {
  if (genreNames) return genreNames;
  genreNames = new Map();
  for (const line of genreList.split("\n")) {
    const name = line.trim();
    if (name) genreNames.set(normTag(name), name);
  }
  // Common, real labels the list doesn't have on their own
  for (const extra of ["alternative", "indie"]) genreNames.set(extra, extra);
  return genreNames;
};

const UPPER = new Set(["uk", "us", "edm", "idm", "ebm", "r&b", "dnb", "nyc", "la", "ny", "dc", "mpb", "opm", "ost", "rnb"]);
const SMALL = new Set(["and", "n", "of", "the", "de", "y", "e"]);
/** "uk garage" → "UK Garage", "k-pop" → "K-Pop", "drum and bass" → "Drum and Bass" */
const titleCase = (s: string) =>
  s
    .split(" ")
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (UPPER.has(lower)) return w.toUpperCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      return w.replace(/(^|[-'])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());
    })
    .join(" ");

// ------------------ PERSISTENT CACHES ------------------
const DAY = 86400000;
type Stored<T> = { v: T; at: number };
const store = <T>(key: string, max: number, ttl: number) => {
  let data: Record<string, Stored<T>> = {};
  try {
    data = JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
  } catch {}
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    timer = undefined;
    const keys = Object.keys(data);
    if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) delete data[k];
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch {}
  };
  return {
    get: (k: string): T | undefined => {
      const e = data[k];
      return e && Date.now() - e.at < ttl ? e.v : undefined;
    },
    set: (k: string, v: T) => {
      delete data[k]; // re-insert so the oldest entries are dropped first
      data[k] = { v, at: Date.now() };
      timer ??= setTimeout(save, 2000);
    },
    flush: () => {
      if (timer) clearTimeout(timer);
      save();
    },
  };
};

type TrackInfo = { genres: string[]; artists: string[] };
type Tag = { name: string; count: number };
const trackStore = store<TrackInfo>("tidal_genres_tracks_v2", 5000, 60 * DAY);
const artistStore = store<Tag[]>("tidal_genres_artists_v2", 3000, 30 * DAY);
try {
  localStorage.removeItem("tidal_genres_cache_v1"); // the old Last.fm track-tag results
} catch {}
export const flushCaches = () => {
  trackStore.flush();
  artistStore.flush();
};

// ------------------ TIDAL: batched track lookups ------------------
const asArray = <T>(x: T | T[] | undefined | null): T[] => (Array.isArray(x) ? x : x ? [x] : []);
type Res = { id: string; type: string; attributes?: Record<string, any>; relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] }> };

const trackWaiters = new Map<string, ((t: TrackInfo | undefined) => void)[]>();
let trackTimer: ReturnType<typeof setTimeout> | undefined;
let trackChain: Promise<void> = Promise.resolve();

const fetchTrackBatch = async (ids: string[]) => {
  const out = new Map<string, TrackInfo>();
  try {
    const headers = { ...(await lib().TidalApi.getAuthHeaders()), accept: "application/vnd.api+json" };
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${V2}tracks?countryCode=${countryCode()}&filter[id]=${ids.join(",")}&include=genres,artists`, { headers });
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) break;
      const doc = (await res.json()) as { data?: Res | Res[]; included?: Res[] };
      const included = new Map(asArray(doc.included).map((r) => [`${r.type}:${r.id}`, r]));
      const rel = (r: Res, name: string) => asArray(r.relationships?.[name]?.data).map((x) => included.get(`${x.type}:${x.id}`));
      for (const r of asArray(doc.data)) {
        out.set(String(r.id), {
          genres: rel(r, "genres")
            .map((g) => g?.attributes?.genreName as string | undefined)
            .filter((g): g is string => !!g),
          artists: rel(r, "artists")
            .map((a) => a?.attributes?.name as string | undefined)
            .filter((a): a is string => !!a),
        });
      }
      break;
    }
  } catch {}
  return out;
};

const flushTracks = () => {
  trackTimer = undefined;
  const ids = [...trackWaiters.keys()];
  trackChain = trackChain.then(async () => {
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const found = await fetchTrackBatch(batch);
      for (const id of batch) {
        const info = found.get(id);
        if (info) trackStore.set(id, info);
        for (const resolve of trackWaiters.get(id) ?? []) resolve(info);
        trackWaiters.delete(id);
      }
      await sleep(200);
    }
  });
};

const tidalTrack = (id: string): Promise<TrackInfo | undefined> => {
  const cached = trackStore.get(id);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const list = trackWaiters.get(id);
    if (list) return list.push(resolve);
    trackWaiters.set(id, [resolve]);
    // A short wait so a whole tracklist going on screen becomes one or two requests
    trackTimer ??= setTimeout(flushTracks, 120);
  });
};

// ------------------ LAST.FM: artist tags, one at a time ------------------
const artistPending = new Map<string, Promise<Tag[] | undefined>>();
let lfmChain: Promise<unknown> = Promise.resolve();
let lfmCooldownUntil = 0;

const lastfmArtistTags = (artist: string, stillWanted: () => boolean): Promise<Tag[] | undefined> => {
  const key = artist.toLowerCase().trim();
  const cached = artistStore.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = artistPending.get(key);
  if (pending) return pending;
  const run = lfmChain.then(async (): Promise<Tag[] | undefined> => {
    const again = artistStore.get(key);
    if (again) return again;
    if (!stillWanted() || Date.now() < lfmCooldownUntil) return undefined;
    try {
      const url = `${LASTFM}?method=artist.gettoptags&autocorrect=1&format=json&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(artist)}`;
      const res = await fetch(url);
      if (res.status === 429) {
        lfmCooldownUntil = Date.now() + 30000;
        return undefined;
      }
      if (!res.ok) return undefined;
      const data = await res.json();
      const tags: Tag[] = asArray<{ name: string; count: number | string }>(data?.toptags?.tag)
        .slice(0, 20)
        .map((t) => ({ name: String(t.name), count: Number(t.count) || 0 }));
      artistStore.set(key, tags);
      return tags;
    } catch {
      return undefined;
    } finally {
      await sleep(250);
    }
  });
  lfmChain = run.catch(() => {});
  artistPending.set(key, run);
  run.finally(() => artistPending.delete(key));
  return run;
};

// ------------------ COMBINING ------------------
export type GenreRequest = {
  /** TIDAL track id, when known */
  id?: string;
  /** Artist names as shown, used when TIDAL can't tell us (no id, or the lookup failed) */
  artists: string[];
  /** Whether the result is still worth fetching (a tracklist row scrolled away) */
  stillWanted?: () => boolean;
};

const resultCache = new Map<string, string[]>();
const resultPending = new Map<string, Promise<string[]>>();

export const cachedGenres = (req: GenreRequest) => resultCache.get(resultKey(req));
const resultKey = (req: GenreRequest) => (req.id ? `id:${req.id}` : `a:${req.artists.join(",").toLowerCase()}`);

export const getGenres = (req: GenreRequest): Promise<string[]> => {
  const key = resultKey(req);
  const done = resultCache.get(key);
  if (done) return Promise.resolve(done);
  const pending = resultPending.get(key);
  if (pending) return pending;
  const run = compute(req)
    .catch(() => [] as string[])
    .then((list) => {
      // An empty answer is only kept for this session's view if it wasn't cut short
      if (list.length || !req.stillWanted || req.stillWanted()) resultCache.set(key, list);
      return list;
    })
    .finally(() => resultPending.delete(key));
  resultPending.set(key, run);
  return run;
};

const compute = async (req: GenreRequest): Promise<string[]> => {
  const wanted = req.stillWanted ?? (() => true);
  const track = req.id ? await tidalTrack(req.id) : undefined;
  const artists = (track?.artists.length ? track.artists : req.artists).slice(0, 3);

  const score = new Map<string, number>();
  const display = new Map<string, string>();
  const add = (key: string, w: number, shown: string) => {
    score.set(key, (score.get(key) ?? 0) + w);
    if (!display.has(key)) display.set(key, shown);
  };

  // The artists' sound, strongest tags first. The main artist counts fully, featured ones less
  let lastfmHasData = false;
  const tagLists = await Promise.all(artists.map((a) => lastfmArtistTags(a, wanted)));
  tagLists.forEach((tags, i) => {
    const artistWeight = i === 0 ? 1 : 0.4;
    const own = normTag(artists[i]);
    const seen = new Set<string>();
    for (const t of tags ?? []) {
      if (t.count < 10) continue;
      const key = canon(t.name);
      const known = genres().get(key);
      if (!known || key === own || seen.has(key)) continue;
      seen.add(key);
      lastfmHasData = true;
      add(key, artistWeight * (t.count / 100), titleCase(known));
    }
  });

  // TIDAL's genres for this very track. "Hip Hop/Rap" and "R&B/Soul" are two genres each
  const tidal = new Set<string>();
  for (const g of track?.genres ?? []) {
    for (const part of g.split("/")) {
      const key = canon(part);
      if (!key || tidal.has(key)) continue;
      tidal.add(key);
      // When Last.fm knows the artist, a TIDAL genre it doesn't back up is likely just the label's filing
      const w = !lastfmHasData || score.has(key) ? 0.5 : 0.2;
      add(key, w, titleCase(part.trim()));
    }
  }

  // Broad labels go after specific ones that are well supported ("tech house" before "electronic")
  const hasSpecific = [...score.entries()].some(([k, s]) => !BROAD.has(k) && s >= 0.2);
  const ranked = [...score.entries()]
    .map(([k, s]): [string, number] => [k, BROAD.has(k) && hasSpecific ? s * 0.45 : s])
    .filter(([, s]) => s >= 0.12)
    .sort((a, b) => b[1] - a[1]);

  return ranked.slice(0, 3).map(([k]) => display.get(k)!);
};
