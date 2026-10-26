// TIDAL API client. Endpoints and payload shapes come from TIDAL's own desktop bundle (desktop.tidal.com)
// and the public OpenAPI spec: v1 for mixes/favorites/blocks/search, OpenAPI v2 for the similarity graph,
// rich track metadata (bpm, key, tone tags, popularity, AI flag) and playlist writes.
import type { Track } from "./types";

const V1 = "https://desktop.tidal.com/v1/";
const V2 = "https://openapi.tidal.com/v2/";
const LASTFM = "https://ws.audioscrobbler.com/2.0/";
// Same public key the TidalGenres plugin uses
const LASTFM_KEY = "b25b959554ed76058ac220b7b2e0a026";

const lib = () => window.luna.lib!;
const session = () => lib().redux.store.getState().session;
export const userId = () => session().userId;
const countryCode = () => session().countryCode;

export class HttpError extends Error {
  constructor(
    public status: number,
    url: string,
    public body?: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

// ------------------ PACING ------------------
// Everything goes through one serial queue with a gap between requests: this runs in the background
// and must never compete with the app (or get rate limited). 429s back off and retry.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let gapMs = 250;
export const setRequestGap = (ms: number) => (gapMs = ms);

let chain: Promise<unknown> = Promise.resolve();
const abort = new AbortController();
// Called on unload: a run still in progress in this (old) plugin instance must not keep going
export const stopRequests = () => abort.abort();
export const isAbort = (err: unknown) => (err as Error)?.name === "AbortError";

const paced = <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const { signal } = abort;
  const run = chain.then(async () => {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    try {
      return await fn(signal);
    } finally {
      await sleep(gapMs);
    }
  });
  chain = run.catch(() => {});
  return run;
};

let requestCount = 0;
export const takeRequestCount = () => {
  const n = requestCount;
  requestCount = 0;
  return n;
};

const request = async (url: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> =>
  paced(async (signal) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.auth !== false) Object.assign(headers, await lib().TidalApi.getAuthHeaders());
    for (let attempt = 0; ; attempt++) {
      requestCount++;
      const res = await fetch(url, { ...init, headers, signal });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      return res;
    }
  });

const qs = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    // Lists (include, filter[id]) must keep literal commas, TIDAL rejects %2C
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/g, ",")}`)
    .join("&");

const getJson = async <T>(url: string, init?: RequestInit & { auth?: boolean }): Promise<T | undefined> => {
  const res = await request(url, init);
  if (res.status === 404 || res.status === 403) return undefined;
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ""));
  return res.json();
};

export const v1 = <T>(path: string, params: Record<string, string | number | undefined> = {}) =>
  getJson<T>(`${V1}${path}${path.includes("?") ? "&" : "?"}${qs({ countryCode: countryCode(), locale: "en_US", deviceType: "DESKTOP", ...params })}`);

// ------------------ JSON:API (v2) ------------------
type Ref = { id: string; type: string; meta?: Record<string, any> };
type Resource = Ref & { attributes?: Record<string, any>; relationships?: Record<string, { data?: Ref | Ref[] }> };
export type JsonApiDoc = { data?: Resource | Resource[]; included?: Resource[]; links?: { next?: string } };

// Per the spec, user collections and all writes don't take a countryCode
const takesCountry = (path: string) => !path.startsWith("userCollection");
const v2Url = (path: string, params: Record<string, string | number | undefined> = {}) =>
  `${V2}${path}${path.includes("?") ? "&" : "?"}${qs({ countryCode: takesCountry(path) ? countryCode() : undefined, ...params })}`;

export const v2 = (path: string, params: Record<string, string | number | undefined> = {}) =>
  getJson<JsonApiDoc>(v2Url(path, params), { headers: { accept: "application/vnd.api+json" } });

const nextUrl = (next: string) => (next.startsWith("http") ? next : `${V2}${next.replace(/^\/(v2\/)?/, "")}`);

/** Follows `links.next` cursors until `max` items have been collected */
export const v2All = async (path: string, params: Record<string, string | number | undefined> = {}, max = 500) => {
  const data: Resource[] = [];
  const included: Resource[] = [];
  let doc = await v2(path, params);
  while (doc) {
    data.push(...(Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : []));
    included.push(...(doc.included ?? []));
    if (!doc.links?.next || data.length >= max) break;
    let url = nextUrl(doc.links.next);
    if (takesCountry(path) && !url.includes("countryCode=")) url += `${url.includes("?") ? "&" : "?"}countryCode=${countryCode()}`;
    doc = await getJson<JsonApiDoc>(url, { headers: { accept: "application/vnd.api+json" } });
  }
  return { data, included };
};

const v2Write = async (method: "POST" | "PATCH" | "DELETE", path: string, body: unknown) => {
  const url = `${V2}${path}`;
  const res = await request(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/vnd.api+json", accept: "application/vnd.api+json", "Idempotency-Key": crypto.randomUUID() },
  });
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ""));
  const text = await res.text();
  return text ? (JSON.parse(text) as JsonApiDoc) : undefined;
};

const asArray = <T>(x: T | T[] | undefined): T[] => (Array.isArray(x) ? x : x ? [x] : []);

// ------------------ TRACK PARSING ------------------
const isoDuration = (s?: string) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(s ?? "");
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
};

const fromV2 = (res: Resource, included: Map<string, Resource>): Track => {
  const a = res.attributes ?? {};
  const rel = (name: string) => asArray(res.relationships?.[name]?.data).map((r) => included.get(`${r.type}:${r.id}`));
  const album = rel("albums")[0];
  return {
    id: String(res.id),
    title: a.title ?? "",
    version: a.version || undefined,
    artists: rel("artists")
      .filter((r): r is Resource => !!r)
      .map((r) => ({ id: String(r.id), name: r.attributes?.name ?? "" })),
    album: album ? { id: String(album.id), title: album.attributes?.title ?? "", releaseDate: album.attributes?.releaseDate } : undefined,
    duration: isoDuration(a.duration),
    explicit: !!a.explicit,
    popularity: typeof a.popularity === "number" ? a.popularity : undefined,
    bpm: typeof a.bpm === "number" && a.bpm > 0 ? a.bpm : undefined,
    key: a.key && a.key !== "UNKNOWN" ? a.key : undefined,
    keyScale: a.keyScale && a.keyScale !== "UNKNOWN" ? a.keyScale : undefined,
    tones: asArray<string>(a.toneTags),
    genres: rel("genres")
      .map((g) => g?.attributes?.genreName)
      .filter((g): g is string => !!g),
    ai: !!a.ai,
    isrc: a.isrc,
    available: !Array.isArray(a.availability) || a.availability.length > 0,
    fetchedAt: Date.now(),
  };
};

/** Full metadata for tracks, 20 per request */
export const hydrateTracks = async (ids: string[]): Promise<Track[]> => {
  const out: Track[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const doc = await v2("tracks", { "filter[id]": batch.join(","), include: "artists,albums,genres" });
    const included = new Map((doc?.included ?? []).map((r) => [`${r.type}:${r.id}`, r]));
    for (const res of asArray(doc?.data)) out.push(fromV2(res, included));
  }
  return out;
};

// ------------------ SIMILARITY GRAPH ------------------
export const similarTracks = async (trackId: string) => (await v2All(`tracks/${trackId}/relationships/similarTracks`, {}, 40)).data.map((r) => String(r.id));

export const similarArtists = async (artistId: string) => (await v2All(`artists/${artistId}/relationships/similarArtists`, {}, 30)).data.map((r) => String(r.id));

type V1Track = { id: number; title: string; artists?: { id: number; name: string }[]; streamReady?: boolean; allowStreaming?: boolean };
type V1Items = { items?: ({ item?: V1Track; type?: string } & Partial<V1Track>)[] };
const v1TrackIds = (res?: V1Items) =>
  (res?.items ?? [])
    .map((x) => (x.item && (x.type === undefined || x.type === "track") ? x.item : x.id !== undefined ? (x as V1Track) : undefined))
    .filter((t): t is V1Track => !!t && t.streamReady !== false && t.allowStreaming !== false)
    .map((t) => String(t.id));

export const artistTopTracks = async (artistId: string, limit = 10) => v1TrackIds(await v1<V1Items>(`artists/${artistId}/toptracks`, { limit }));

/** TIDAL's "track radio": a mix seeded from a single track */
export const trackMixItems = async (trackId: string) => {
  const mix = await v1<{ id?: string }>(`tracks/${trackId}/mix`);
  return mix?.id ? mixItems(mix.id) : [];
};

export const mixItems = async (mixId: string) => v1TrackIds(await v1<V1Items>(`mixes/${mixId}/items`, { limit: 100 }));

export type MixRef = { id: string; mixType: string; title?: string };
/** The user's personal mixes (Daily Discovery, history mixes, daily mixes...). Page layout varies, so search it */
export const myMixes = async (): Promise<MixRef[]> => {
  const page = await v1<unknown>("pages/my_collection_my_mixes");
  const found = new Map<string, MixRef>();
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (typeof node.mixType === "string" && typeof node.id === "string") found.set(node.id, { id: node.id, mixType: node.mixType, title: node.title });
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(page, 0);
  return [...found.values()];
};

// ------------------ USER LIBRARY ------------------
/** A library track: v1 lists carry title/artists/ISRC inline, enough to spot other releases of the same song */
export type LibraryTrack = { id: string; title: string; version?: string; artists: { id: string; name: string }[]; isrc?: string; addedAt: number };
type V1FullTrack = V1Track & { version?: string | null; isrc?: string };
const libraryTrack = (t: V1FullTrack, addedAt = 0): LibraryTrack => ({
  id: String(t.id),
  title: t.title ?? "",
  version: t.version ?? undefined,
  artists: (t.artists ?? []).map((a) => ({ id: String(a.id), name: a.name })),
  isrc: t.isrc,
  addedAt,
});

// Every v1 list is paged at 100
const v1Paged = async <T>(path: string, params: Record<string, string | number>, max: number) => {
  const out: T[] = [];
  for (let offset = 0; offset < max; offset += 100) {
    const page = await v1<{ items?: T[]; totalNumberOfItems?: number }>(path, { ...params, limit: 100, offset });
    out.push(...(page?.items ?? []));
    if (!page?.items?.length || offset + 100 >= (page.totalNumberOfItems ?? 0)) break;
  }
  return out;
};

/** All liked tracks, no cap that a real library would hit */
export const favoriteTracks = async (max = 50000) =>
  (await v1Paged<{ created?: string; item?: V1FullTrack }>(`users/${userId()}/favorites/tracks`, { order: "DATE", orderDirection: "DESC" }, max))
    .filter((x) => x.item?.id !== undefined)
    .map((x) => libraryTrack(x.item!, Date.parse(x.created ?? "") || 0));

export const favoriteArtistIds = async (max = 500) =>
  (await v2All("userCollectionArtists/me/relationships/items", { sort: "-addedAt", locale: "en-US" }, max)).data.filter((r) => r.type === "artists").map((r) => String(r.id));

type V1Playlist = { uuid: string; title: string; numberOfTracks?: number; lastUpdated?: string; creator?: { id?: number } };
/** Playlists you made */
export const myPlaylists = async () => v1Paged<V1Playlist>(`users/${userId()}/playlists`, {}, 2000);

/** Playlists you made and playlists you follow */
export const allPlaylists = async () => {
  const items = await v1Paged<{ playlist?: V1Playlist; item?: V1Playlist } & Partial<V1Playlist>>(`users/${userId()}/playlistsAndFavoritePlaylists`, { order: "DATE", orderDirection: "DESC" }, 2000);
  return items.map((x) => x.playlist ?? x.item ?? (x as V1Playlist)).filter((p): p is V1Playlist => !!p?.uuid);
};

export const playlistTracks = async (uuid: string, max = 10000) =>
  (await v1Paged<{ item?: V1FullTrack; type?: string }>(`playlists/${uuid}/items`, {}, max))
    .filter((x) => x.item?.id !== undefined && (x.type === undefined || x.type === "track"))
    .map((x) => libraryTrack(x.item!));

/** Tracks of a mix with title/artists/ISRC (for history mixes, which also count as "already known") */
export const mixTracks = async (mixId: string) =>
  (await v1Paged<{ item?: V1FullTrack; type?: string }>(`mixes/${mixId}/items`, {}, 300))
    .filter((x) => x.item?.id !== undefined && (x.type === undefined || x.type === "track"))
    .map((x) => libraryTrack(x.item!));

// ------------------ LISTENING HISTORY ------------------
// The home feed's "Your listening history": "My Most Listened" per month, per year and all time.
// That's months of real, play-count-ranked listening: what the drift detection needs to see your phases.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export type HistoryMix = { id: string; mixType: string; title: string; at?: number };

const gateways = ["https://api.tidal.com/v2/", "https://desktop.tidal.com/v2/"];
export const gatewayStatus: string[] = [];
const gateway = async <T>(path: string, params: Record<string, string | number | undefined>): Promise<T | undefined> => {
  for (const base of gateways) {
    const url = `${base}${path}?${qs({ countryCode: countryCode(), locale: "en_US", deviceType: "DESKTOP", platform: "DESKTOP", ...params })}`;
    try {
      const res = await request(url, { headers: { "x-tidal-authenticated-userid": String(userId()) } });
      gatewayStatus.push(`${base.split("/")[2]} ${res.status}`);
      if (res.ok) return res.json();
    } catch (err) {
      if (isAbort(err)) throw err;
      gatewayStatus.push(`${base.split("/")[2]} ${(err as Error).message}`);
    }
  }
  return undefined;
};

const HISTORY_TYPE = /^HISTORY_(MONTHLY|YEARLY|ALLTIME)_MIX$/;
/**
 * Finds "My Most Listened" mixes anywhere in a JSON tree, whatever the layout: the mix type can sit on the
 * node or in its JSON:API attributes, and the month ("September 2026") in any text field.
 */
export const findHistoryMixes = (root: unknown, found: Map<string, HistoryMix>, viewAll = new Set<string>()) => {
  const seen = new Set<object>();
  const walk = (node: any, depth: number, inHistory: boolean) => {
    if (!node || typeof node !== "object" || depth > 16 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node) && node.length > 3000) return;
    const fields = { ...(node.attributes ?? {}), ...node };
    const type = Object.values(fields).find((v): v is string => typeof v === "string" && HISTORY_TYPE.test(v));
    const id = fields.id ?? fields.mixId;
    if (type && id !== undefined) {
      const text = Object.values(fields)
        .filter((v): v is string => typeof v === "string")
        .join(" ")
        .toLowerCase();
      const m = new RegExp(`(${MONTHS.join("|")})\\s+(\\d{4})`).exec(text);
      const y = /\b(20\d{2})\b/.exec(text);
      const at = m ? Date.UTC(Number(m[2]), MONTHS.indexOf(m[1]), 15) : /YEARLY/.test(type) && y ? Date.UTC(Number(y[1]), 6, 1) : undefined;
      const prev = found.get(String(id));
      found.set(String(id), { id: String(id), mixType: type, title: fields.title ?? fields.subTitle ?? prev?.title ?? "", at: at ?? prev?.at });
    }
    const here = inHistory || Object.values(node).some((v) => typeof v === "string" && /listening history|my most listened/i.test(v));
    // Remember the module's "View all" source so every past month can be read, not just the visible ones
    if (here) for (const [k, v] of Object.entries(node)) if (/sourceType|viewAll/i.test(k) && typeof v === "string") viewAll.add(v);
    for (const v of Object.values(node)) walk(v, depth + 1, here);
  };
  walk(root, 0, false);
};

/** History mixes from the API, TIDAL's own in-memory state, and `known` (those seen in earlier sessions) */
export const historyMixes = async (known: HistoryMix[] = []): Promise<HistoryMix[]> => {
  const found = new Map<string, HistoryMix>(known.map((m) => [m.id, m]));
  const viewAll = new Set<string>();
  gatewayStatus.length = 0;
  findHistoryMixes(await gateway<unknown>("home/feed/static", { limit: 40 }), found, viewAll);
  // Whatever the app already loaded (e.g. the Home page) is in its store
  try {
    findHistoryMixes(lib().redux.store.getState(), found, viewAll);
  } catch {}
  for (const source of viewAll) findHistoryMixes(await gateway<unknown>(`home/pages/${encodeURIComponent(source)}/view-all`, { limit: 50, offset: 0 }), found);
  for (const m of await myMixes().catch(() => [])) if (/HISTORY/.test(m.mixType) && !found.has(m.id)) found.set(m.id, { id: m.id, mixType: m.mixType, title: m.title ?? "" });
  return [...found.values()];
};

// ------------------ HOME FEED TAP ------------------
// When TIDAL loads your Home page, read the same response (a clone; the app is untouched) and remember
// the "My Most Listened" mixes in it. Covers whatever headers the app sends that the plugin can't know.
export const tapHomeFeed = (onMixes: (mixes: HistoryMix[]) => void) => {
  const original = window.fetch;
  let active = true;
  const tapped: typeof fetch = async (input, init) => {
    const res = await original(input, init);
    if (!active) return res;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (res.ok && /\/v2\/home\/(feed|pages)\//.test(url)) {
        res
          .clone()
          .json()
          .then((json) => {
            const found = new Map<string, HistoryMix>();
            findHistoryMixes(json, found);
            if (found.size) onMixes([...found.values()]);
          })
          .catch(() => {});
      }
    } catch {}
    return res;
  };
  window.fetch = tapped;
  return () => {
    active = false;
    // Only unhook if nothing wrapped fetch after us; otherwise stay as an inert pass-through
    if (window.fetch === tapped) window.fetch = original;
  };
};

/**
 * TIDAL's "Recently played", newest first, from every device: real recent listening even before this
 * plugin has tracked anything. No play durations, so it counts as a lighter signal than tracked plays.
 */
export const recentActivity = async (max = 300) => {
  const items = await v1Paged<{ type?: string; item?: any }>(`users/${userId()}/activity`, {}, max);
  const tracks: LibraryTrack[] = [];
  const artists: string[] = [];
  for (const x of items) {
    if (x.type === "TRACK" && x.item?.id !== undefined) tracks.push(libraryTrack(x.item));
    else if (x.type === "ARTIST" && x.item?.id !== undefined) artists.push(String(x.item.id));
    else if (x.type === "ALBUM") for (const a of x.item?.artists ?? []) artists.push(String(a.id));
  }
  return { tracks, artists };
};

export type Blocks = { tracks: Set<string>; artists: Set<string> };
export const blocks = async (): Promise<Blocks> => {
  const res = await v1<Record<string, unknown>>(`users/${userId()}/blocks/ids`).catch(() => undefined);
  const ids = (key: RegExp) =>
    new Set(
      Object.entries(res ?? {})
        .filter(([k]) => key.test(k))
        .flatMap(([, v]) => (Array.isArray(v) ? v : []))
        .map((x: any) => String(x?.id ?? x)),
    );
  return { tracks: ids(/track/i), artists: ids(/artist/i) };
};

// ------------------ SEARCH (to map Last.fm results onto TIDAL) ------------------
export const searchArtist = async (name: string) => {
  const res = await v1<{ items?: { id: number; name: string }[] }>("search/artists", { query: name, limit: 5 });
  const norm = normName(name);
  return res?.items?.find((a) => normName(a.name) === norm)?.id?.toString();
};

export const searchTrack = async (artist: string, title: string) => {
  const res = await v1<{ items?: (V1Track & { title: string })[] }>("search/tracks", { query: `${artist} ${title}`, limit: 5 });
  const na = normName(artist);
  const nt = normName(title);
  return res?.items
    ?.find((t) => t.streamReady !== false && normName(t.title).startsWith(nt) && t.artists?.some((a) => normName(a.name) === na))
    ?.id?.toString();
};

export const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ------------------ LAST.FM ------------------
// Folksonomy tags ("dream pop", "post-punk", "melancholic"...) are the richest free description of an
// artist's sound; the bundled tag embeddings turn them into a taste space. Similar artists/tracks come
// from Last.fm's scrobble-based collaborative filtering, a second opinion next to TIDAL's own.
const lastfm = async <T>(params: Record<string, string | number>) =>
  getJson<T>(`${LASTFM}?${qs({ ...params, api_key: LASTFM_KEY, format: "json", autocorrect: 1 })}`, { auth: false });

export const lastfmArtistTags = async (artist: string) => {
  const res = await lastfm<{ toptags?: { tag?: { name: string; count: number }[] } }>({ method: "artist.gettoptags", artist });
  return (res?.toptags?.tag ?? []).map((t) => ({ name: t.name.toLowerCase().trim(), count: Number(t.count) || 0 }));
};

export const lastfmSimilarArtists = async (artist: string, limit = 20) => {
  const res = await lastfm<{ similarartists?: { artist?: { name: string; match: string }[] } }>({ method: "artist.getsimilar", artist, limit });
  return (res?.similarartists?.artist ?? []).map((a) => ({ name: a.name, match: Number(a.match) || 0 }));
};

export const lastfmSimilarTracks = async (artist: string, track: string, limit = 15) => {
  const res = await lastfm<{ similartracks?: { track?: { name: string; match: number; artist: { name: string } }[] } }>({
    method: "track.getsimilar",
    artist,
    track,
    limit,
  });
  return (res?.similartracks?.track ?? []).map((t) => ({ artist: t.artist.name, title: t.name, match: Number(t.match) || 0 }));
};

// ------------------ PLAYLIST WRITES ------------------
export const playlistExists = async (id: string) => !!(await v2(`playlists/${id}`));

export const createPlaylist = async (name: string, description: string) => {
  const doc = await v2Write("POST", "playlists", { data: { type: "playlists", attributes: { name, description, accessType: "UNLISTED" } } });
  const id = (Array.isArray(doc?.data) ? doc?.data[0] : doc?.data)?.id;
  if (!id) throw new Error("Playlist creation returned no id");
  return String(id);
};

export const updatePlaylist = (id: string, attributes: { name?: string; description?: string }) =>
  v2Write("PATCH", `playlists/${id}`, { data: { id, type: "playlists", attributes } });

export const playlistItems = async (id: string) =>
  (await v2All(`playlists/${id}/relationships/items`, {}, 1000)).data.map((r) => ({ id: String(r.id), type: r.type, itemId: String(r.meta?.itemId ?? "") }));

export const removePlaylistItems = async (id: string, items: { id: string; type: string; itemId: string }[]) => {
  for (let i = 0; i < items.length; i += 20) {
    await v2Write("DELETE", `playlists/${id}/relationships/items`, {
      data: items.slice(i, i + 20).map((x) => ({ id: x.id, type: x.type, meta: { itemId: x.itemId } })),
    });
  }
};

export const addPlaylistTracks = async (id: string, trackIds: string[]) => {
  for (let i = 0; i < trackIds.length; i += 20) {
    await v2Write("POST", `playlists/${id}/relationships/items`, {
      data: trackIds.slice(i, i + 20).map((t) => ({ id: t, type: "tracks" })),
      meta: { onDuplicates: "ADD" },
    });
  }
};
