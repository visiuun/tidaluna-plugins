// One generation run: sync → profile → vectors → cluster → retrieve → filter → rank → select → write.
import * as api from "./api";
import { gatherCandidates } from "./candidates";
import { artists, flush, markDirty, state, tracks, writeLog } from "./db";
import { blendSeeds, buildProfile, labelFor, titleKey, VERSION_RE, versionText, type Clocks, type Mix, type Profile } from "./profile";
import { clusterSeeds, scoreCandidates, selectPlaylist, sequence, type Candidate } from "./rank";
import { settings } from "./config";
import type { State, Track } from "./types";
import { dot, normalize, tagSpaceSize } from "./tagspace";
import { trackVectors } from "./vectors";

const DAY = 864e5;
export const PLAYLIST_NAME = "Your Daily Discovery";

// ------------------ STATUS ------------------
export type Status = { running: boolean; stage: string; error?: string };
let status: Status = { running: false, stage: "Idle" };
const listeners = new Set<(s: Status) => void>();
export const getStatus = () => status;
export const onStatus = (fn: (s: Status) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const setStatus = (s: Partial<Status>) => {
  status = { ...status, ...s };
  for (const fn of listeners) fn(status);
};

let log: (msg: string) => void = writeLog;
export const setLogger = (fn: (msg: string) => void) => (log = fn);
let notify: (msg: string) => void = () => {};
export const setNotifier = (fn: (msg: string) => void) => (notify = fn);

/** The "day" a playlist belongs to: rolls over at the configured refresh hour, not midnight */
export const discoveryDay = (now = Date.now()) => {
  const d = new Date(now - settings.refreshHour * 3600e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

// ------------------ LIBRARY SYNC ------------------
// Everything you've liked or put in any playlist (yours or followed) is read in full every run: the
// playlist must only ever contain music that's new to you. Any read failure stops the run rather than
// risk recommending something you already have.
const syncLibrary = async () => {
  setStatus({ stage: "Reading your library" });
  const now = Date.now();
  const keys = new Set<string>();
  const isrcs = new Set<string>();
  const libraryArtists: Record<string, number> = {};
  const remember = (t: api.LibraryTrack) => {
    if (t.title && t.artists.length) keys.add(titleKey(t));
    if (t.isrc) isrcs.add(t.isrc);
    for (const a of t.artists) libraryArtists[a.id] = (libraryArtists[a.id] ?? 0) + 1;
  };

  const favs = await api.favoriteTracks();
  const likes: Record<string, number> = {};
  for (const f of favs) {
    likes[f.id] = f.addedAt || state.likes[f.id] || now;
    remember(f);
  }
  // Hearts made since the last sync but not yet visible in the API
  for (const [id, at] of Object.entries(state.likes)) if (!(id in likes) && at > (state.librarySyncAt ?? 0)) likes[id] = at;
  state.likes = likes;
  state.favArtists = (await api.favoriteArtistIds(2000).catch(() => null)) ?? state.favArtists;

  const uid = String(api.userId());
  const lists = (await api.allPlaylists().catch(() => null)) ?? (await api.myPlaylists());
  const own: Record<string, number> = {};
  const followed: Record<string, 1> = {};
  let ownCount = 0;
  for (const p of lists) {
    if (p.uuid === state.playlistId) continue;
    const mine = p.creator?.id === undefined || String(p.creator.id) === uid;
    if (mine) ownCount++;
    // A playlist you haven't touched in years says little about today's taste
    const updated = Date.parse(p.lastUpdated ?? "") || now - 365 * DAY;
    setStatus({ stage: `Reading your playlists (${p.title})` });
    for (const t of await api.playlistTracks(p.uuid)) {
      remember(t);
      if (mine) own[t.id] = Math.max(own[t.id] ?? 0, updated);
      else followed[t.id] = 1;
    }
  }
  state.playlistTracks = own;
  state.followedTracks = followed;

  // "My Most Listened" per month / year / all time: months of real, play-ranked listening
  setStatus({ stage: "Reading your listening history" });
  const history = await api.historyMixes(state.historyRefs ?? []).catch((err) => (log(`listening history unavailable: ${err.message}`), [] as api.HistoryMix[]));
  state.historyRefs = history;
  const months: State["historyMonths"] = [];
  for (const mix of history) {
    const all = /ALLTIME/.test(mix.mixType);
    if (!all && mix.at === undefined) continue;
    const list = await api.mixTracks(mix.id).catch(() => [] as api.LibraryTrack[]);
    list.forEach(remember);
    months.push({ id: mix.id, type: mix.mixType, at: mix.at ?? now, tracks: list.map((t) => t.id) });
  }
  if (history.length) state.historyMonths = months.sort((a, b) => b.at - a.at);
  else log(`No listening history yet (home feed: ${api.gatewayStatus.join(", ") || "n/a"}). It's picked up next time you open TIDAL's Home page`);
  log(
    `Listening history: ${months.map((m) => (/ALLTIME/.test(m.type) ? "all time" : new Date(m.at).toLocaleDateString("en", { month: "short", year: "numeric" })) + ` (${m.tracks.length})`).join(", ") || "none found"}`,
  );

  // TIDAL "recently played" from every device, newest first. Times are estimated from the order
  const recent = await api.recentActivity().catch((err) => (log(`recently played unavailable: ${err.message}`), null));
  if (recent) {
    state.recentTracks = {};
    state.recentArtists = {};
    recent.tracks.forEach((t, i) => {
      remember(t);
      state.recentTracks[t.id] = now - i * 2 * 3600e3;
    });
    recent.artists.forEach((a, i) => (state.recentArtists[a] = Math.max(state.recentArtists[a] ?? 0, now - i * 6 * 3600e3)));
  }

  state.libraryArtists = libraryArtists;
  state.libraryKeys = [...keys];
  state.libraryIsrcs = [...isrcs];
  state.librarySyncAt = now;
  markDirty("state");
  log(
    `Library: ${favs.length} liked, ${state.favArtists.length} artists, ${lists.length} playlists (${ownCount} yours) with ${Object.keys(own).length + Object.keys(followed).length} tracks, ${keys.size} distinct songs by ${Object.keys(libraryArtists).length} artists, ${recent?.tracks.length ?? 0} recently played, ${state.events.length} tracked listens`,
  );
};

// ------------------ METADATA ------------------
const ensureTracks = async (ids: string[]) => {
  const stale = Date.now() - 60 * DAY;
  const missing = [...new Set(ids)].filter((id) => !tracks[id] || tracks[id].fetchedAt < stale);
  if (missing.length === 0) return;
  for (let i = 0; i < missing.length; i += 100) {
    const batch = await api.hydrateTracks(missing.slice(i, i + 100)).catch((err) => {
      if (api.isAbort(err)) throw err;
      log(`hydrate failed: ${err.message}`);
      return [] as Track[];
    });
    for (const t of batch) {
      tracks[t.id] = t;
      for (const a of t.artists) {
        artists[a.id] ??= { name: a.name };
        artists[a.id].name = a.name;
      }
    }
    setStatus({ stage: `Reading track details (${Math.min(i + 100, missing.length)}/${missing.length})` });
  }
  markDirty("tracks", "artists");
};

const ensureArtistTags = async (artistIds: string[], cap: number) => {
  if (!settings.useLastfm) return;
  const stale = Date.now() - 90 * DAY;
  const todo = [...new Set(artistIds)].filter((a) => artists[a]?.name && (!artists[a].tagsAt || artists[a].tagsAt! < stale)).slice(0, cap);
  let done = 0;
  for (const a of todo) {
    const tags = await api.lastfmArtistTags(artists[a].name).catch((err) => {
      if (api.isAbort(err)) throw err;
      return null;
    });
    if (tags) {
      artists[a].tags = tags.slice(0, 15);
      artists[a].tagsAt = Date.now();
    }
    if (++done % 10 === 0) setStatus({ stage: `Learning what artists sound like (${done}/${todo.length})` });
  }
  if (todo.length) markDirty("artists");
};

// ------------------ FILTERS ------------------
const keep = (t: Track, profile: Profile, blocks: api.Blocks, now: number) => {
  if (!t.available || blocks.tracks.has(t.id) || t.artists.some((a) => blocks.artists.has(a.id))) return "blocked/unavailable";
  if (profile.known.has(t.id) || profile.knownTitles.has(titleKey(t)) || (t.isrc && profile.knownIsrcs.has(t.isrc))) return "already in your library";
  if (settings.excludeAI && t.ai) return "ai";
  if (!settings.allowExplicit && t.explicit) return "explicit";
  if (t.duration < 75 || t.duration > 900) return "length";
  const vt = versionText(t);
  if (VERSION_RE.junk.test(vt)) return "junk version";
  if (VERSION_RE.live.test(vt) && profile.versionTaste.live < 0.08) return "live";
  if (VERSION_RE.remix.test(vt) && profile.versionTaste.remix < 0.1) return "remix";
  if (VERSION_RE.acoustic.test(vt) && profile.versionTaste.acoustic < 0.05) return "acoustic";
  if (VERSION_RE.altered.test(vt) && profile.versionTaste.altered < 0.04) return "sped up/slowed";
  const rec = state.recommended[t.id];
  if (rec && now - rec.at < 21 * DAY) return "recently recommended";
  if ((profile.artistSkipRate.get(t.artists[0]?.id ?? "") ?? 0) >= 0.75) return "artist you skip";
  if (t.artists.some((a) => profile.dislikedArtists.has(a.id))) return "artist you 👎";
  return null;
};

// ------------------ PLAYLIST ------------------
const writePlaylist = async (ids: string[], description: string) => {
  let id = state.playlistId;
  if (id && !(await api.playlistExists(id).catch(() => true))) id = undefined;
  // Lost our id (reset, reinstall): adopt the existing playlist rather than making a second one
  id ??= (await api.myPlaylists().catch(() => [])).find((p) => p.title === PLAYLIST_NAME)?.uuid;
  if (id && !state.playlistId) {
    state.playlistId = id;
    markDirty("state");
  }
  if (!id) {
    id = await api.createPlaylist(PLAYLIST_NAME, description);
    state.playlistId = id;
    markDirty("state");
    log(`Created playlist ${id}`);
    await api.addPlaylistTracks(id, ids);
  } else {
    // Add the new picks first, then remove the old ones: a failure halfway never leaves it empty
    const old = await api.playlistItems(id);
    await api.addPlaylistTracks(id, ids);
    await api.removePlaylistItems(id, old);
    await api.updatePlaylist(id, { name: PLAYLIST_NAME, description }).catch((err) => log(`description update failed: ${err.message}`));
  }
  try {
    window.luna.lib!.redux.actions["content/LOAD_PLAYLIST"]({ playlistUUID: id });
  } catch {}
  return id;
};

// ------------------ TASTE DRIFT ------------------
// People go through phases. Compare where the last couple of weeks of listening sit in the taste space
// with the long-term centre; the further apart, the more the playlist follows the new phase.
const centroid = (vecs: { id: string; v: Float32Array }[], parts: Map<string, Clocks>, weight: (c: Clocks) => number) => {
  let out: Float32Array | null = null;
  let mass = 0;
  for (const { id, v } of vecs) {
    const c = parts.get(id);
    const w = c ? weight(c) : 0;
    if (w <= 0) continue;
    out ??= new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] += v[i] * w;
    mass += w;
  }
  return { v: out && normalize(out), mass };
};

const measureDrift = (vecs: { id: string; v: Float32Array }[], profile: Profile) => {
  const longTerm = centroid(vecs, profile.parts, (c) => c.slow + 0.3 * c.lib);
  const lately = centroid(vecs, profile.parts, (c) => 0.6 * c.fast + 0.4 * c.now);
  // Not enough recent listening to call it a shift
  if (!longTerm.v || !lately.v || lately.mass < 4) return 0;
  return Math.max(0, Math.min(1, (0.93 - dot(longTerm.v, lately.v)) / 0.35));
};

/** Moves weight from the long-term clock to the recent ones, in proportion to the drift */
const driftMix = (base: Mix, drift: number): Mix => {
  const listening = base.slow + base.fast + base.now;
  const slow = 0.45 * (1 - 0.75 * drift);
  const fast = 0.35 + 0.15 * drift;
  const now = 0.2 + 0.2 * drift;
  const sum = slow + fast + now;
  return { slow: (listening * slow) / sum, fast: (listening * fast) / sum, now: (listening * now) / sum, lib: base.lib * (1 - 0.5 * drift) };
};

// ------------------ RUN ------------------
let running: Promise<void> | null = null;
export const isRunning = () => !!running;

export const runDiscovery = (reason: string) => (running ??= run(reason).finally(() => (running = null)));

const run = async (reason: string) => {
  const t0 = Date.now();
  const now = t0;
  api.takeRequestCount();
  setStatus({ running: true, stage: "Starting", error: undefined });
  log(`=== Generating (${reason}) ===`);
  try {
    // Fresh read of the library unless it was read moments ago (e.g. pressing Generate twice)
    if (!state.librarySyncAt || now - state.librarySyncAt > 30 * 60e3) await syncLibrary();
    const blocks = await api.blocks();
    log(`Blocked: ${blocks.tracks.size} tracks, ${blocks.artists.size} artists`);

    // Profile, with metadata for the tracks that define it
    let profile = buildProfile(now);
    // Long-term favourites plus whatever you're into right now, so a new phase is represented even
    // before it's big overall
    const top = (score: (id: string) => number, n: number) => [...profile.parts.keys()].sort((a, b) => score(b) - score(a)).slice(0, n);
    const seedIds = [
      ...new Set([
        ...[...profile.seeds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 350).map(([id]) => id),
        ...top((id) => profile.parts.get(id)!.fast + profile.parts.get(id)!.now, 150),
      ]),
    ].filter((id) => profile.parts.has(id) && !profile.negatives.has(id));
    const negIds = [...profile.negatives.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([id]) => id);
    if (seedIds.length < 5) {
      log(`Only ${seedIds.length} signals so far, waiting for more listening`);
      setStatus({ running: false, stage: "Not enough listening history yet. Like some tracks or listen for a while" });
      return;
    }
    setStatus({ stage: "Reading your favourite tracks" });
    await ensureTracks([...seedIds, ...negIds]);
    profile = buildProfile(now);

    setStatus({ stage: "Learning what your artists sound like" });
    const seedArtists = [...profile.artistAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([a]) => a);
    await ensureArtistTags(seedArtists, 150);

    setStatus({ stage: "Mapping your taste (local AI)" });
    const seedVecMap = trackVectors([...seedIds, ...negIds]);

    // Taste clusters over all your evidence first
    let seedVecs = seedIds.filter((id) => seedVecMap.has(id) && profile.seeds.has(id)).map((id) => ({ id, w: profile.seeds.get(id)!, v: seedVecMap.get(id)! }));
    const negVecs = negIds.filter((id) => seedVecMap.has(id)).map((id) => ({ w: profile.negatives.get(id)!, v: seedVecMap.get(id)! }));
    let unclustered = seedIds.filter((id) => !seedVecMap.has(id) && profile.seeds.has(id)).map((id) => ({ id, w: profile.seeds.get(id)! }));
    await yieldToUi();
    let clusters = clusterSeeds(seedVecs);
    for (const c of clusters) {
      const aw = new Map<string, number>();
      for (const m of c.members) for (const a of tracks[m.id]?.artists.slice(0, 1) ?? []) aw.set(a.id, (aw.get(a.id) ?? 0) + m.w);
      c.label = labelFor(aw) || [...aw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a]) => artists[a]?.name).join(" / ");
    }

    // Has your taste moved lately? Two views: how your recent listening is spread over your tastes vs
    // the long-term spread (house going from 15% to 40% of your plays), and where its centre sits in
    // the taste space. Either one moving shifts weight to the recent clocks.
    const clockShare = (weight: (c: Clocks) => number) => {
      const per = clusters.map((c) => c.members.reduce((s, m) => s + weight(profile.parts.get(m.id) ?? { slow: 0, fast: 0, now: 0, lib: 0 }), 0));
      const sum = per.reduce((a, b) => a + b, 0) || 1;
      return per.map((x) => x / sum);
    };
    const recentShare = clockShare((c) => 0.6 * c.fast + 0.4 * c.now);
    const longShare = clockShare((c) => c.slow);
    const trends = clusters.map((_, k) => recentShare[k] - longShare[k]);
    const shift = 0.5 * trends.reduce((s, t) => s + Math.abs(t), 0);
    const drift = Math.max(
      Math.max(0, Math.min(1, (shift - 0.1) / 0.35)),
      measureDrift(
        seedIds.filter((id) => seedVecMap.has(id)).map((id) => ({ id, v: seedVecMap.get(id)! })),
        profile,
      ),
    );
    const mix = driftMix(profile.mix, drift);
    profile.seeds = blendSeeds(profile.parts, profile.negatives, mix);
    // Re-weight everything under the new mix: a rising taste gets more seeds and more of the playlist
    const reweight = <T extends { id: string; w: number }>(list: T[]) => list.map((x) => ({ ...x, w: profile.seeds.get(x.id) ?? 0 })).filter((x) => x.w > 0);
    seedVecs = reweight(seedVecs);
    unclustered = reweight(unclustered);
    for (const c of clusters) {
      c.members = reweight(c.members);
      c.weight = c.members.reduce((s, m) => s + m.w, 0);
    }
    clusters = clusters.filter((c) => c.members.length > 0);
    const order = clusters.map((c, k) => ({ c, t: trends[k] })).sort((a, b) => b.c.weight - a.c.weight);
    clusters = order.map((o) => o.c);
    trends.splice(0, trends.length, ...order.map((o) => o.t));
    const totalW = clusters.reduce((s, c) => s + c.weight, 0) || 1;
    const listeningShare = 1 - mix.lib;
    log(
      `Taste drift ${Math.round(drift * 100)}% (spread moved ${Math.round(shift * 100)}%)${drift > 0.35 ? ": you're in a new phase, following it" : ""}; weights: ${Math.round(listeningShare * 100)}% listening (${[mix.slow, mix.fast, mix.now].map((x) => Math.round((x / listeningShare) * 100)).join("/")} months/weeks/days), ${Math.round(mix.lib * 100)}% saved library`,
    );
    log(
      `Taste clusters: ${clusters.map((c, k) => `${c.label} ${Math.round((100 * c.weight) / totalW)}%${trends[k] > 0.08 ? " ↑" : trends[k] < -0.08 ? " ↓" : ""}`).join(", ")}; ${unclustered.length} seeds without description`,
    );

    // Retrieval
    setStatus({ stage: "Searching for music you haven't heard" });
    const pool = await gatherCandidates(profile, clusters, unclustered, settings.useLastfm, log);

    // Cheap filters first, then metadata for the most connected candidates
    const byGraph = [...pool.entries()]
      .filter(([id]) => !profile.known.has(id) && !blocks.tracks.has(id))
      .sort((a, b) => b[1].graph - a[1].graph)
      .slice(0, 700);
    setStatus({ stage: "Reading candidate details" });
    await ensureTracks(byGraph.map(([id]) => id));
    const rejected: Record<string, number> = {};
    let cands: Candidate[] = [];
    for (const [id, c] of byGraph) {
      const t = tracks[id];
      if (!t) continue;
      const why = keep(t, profile, blocks, now);
      if (why) {
        rejected[why] = (rejected[why] ?? 0) + 1;
        continue;
      }
      cands.push({ t, vec: null, graph: c.graph, sources: c.sources });
    }
    // Same song from different releases: keep the best connected one
    const byTitle = new Map<string, Candidate>();
    for (const c of cands) {
      const k = titleKey(c.t);
      const prev = byTitle.get(k);
      if (!prev || c.graph > prev.graph) byTitle.set(k, c);
    }
    cands = [...byTitle.values()];
    log(`Filtered: ${cands.length} left (${Object.entries(rejected).map(([k, v]) => `${v} ${k}`).join(", ")})`);

    // Two-stage ranking: a cheap pre-rank decides who gets the full treatment (Last.fm descriptions)
    const pre = (c: Candidate) => Math.log1p(c.graph) * (1 + 0.5 * Math.max(0, ...c.t.artists.map((a) => profile.artistAffinity.get(a.id) ?? 0))) * (c.sources.size > 1 ? 1.3 : 1);
    cands = cands.sort((a, b) => pre(b) - pre(a)).slice(0, 320);
    setStatus({ stage: "Learning what new artists sound like" });
    await ensureArtistTags(
      cands.flatMap((c) => c.t.artists.map((a) => a.id)),
      120,
    );
    setStatus({ stage: "Ranking with your taste model" });
    const candVecs = trackVectors(cands.map((c) => c.t.id));
    for (const c of cands) c.vec = candVecs.get(c.t.id) ?? null;
    await yieldToUi();

    const explore = settings.exploration / 100;
    scoreCandidates(cands, profile, seedVecs, negVecs, clusters, explore);
    // Discovery means new artists: only a few picks may come from artists already in your library
    const isKnownArtist = (c: Candidate) => c.t.artists.some((a) => (profile.artistFamiliarity.get(a.id) ?? 0) > 0);
    const knownCap = Math.max(1, Math.round(settings.size * (0.4 - 0.35 * explore)));
    const picks = sequence(selectPlaylist(cands, clusters, settings.size, explore, isKnownArtist, knownCap));
    const newArtists = picks.filter((p) => !isKnownArtist(p)).length;
    if (picks.length < 5) throw new Error(`Only ${picks.length} tracks survived ranking`);

    // Write
    setStatus({ stage: "Updating your playlist" });
    const labels = clusters.slice(0, 4).map((c) => c.label).filter(Boolean);
    const date = new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    const description = `New music picked for you every day from what you actually listen to, made locally by Luna.${labels.length ? ` Today: ${labels.join(" · ")}.` : ""} Updated ${date}.`;
    await writePlaylist(
      picks.map((p) => p.t.id),
      description,
    );

    for (const p of picks) state.recommended[p.t.id] = { at: now, x: p.x! };
    const clusterCounts = clusters.map((_, k) => picks.filter((p) => p.cluster === k).length);
    state.lastRun = {
      at: now,
      day: discoveryDay(now),
      tracks: picks.length,
      clusters: clusters.map((c, k) => ({ label: c.label, share: c.weight / totalW, tracks: clusterCounts[k], trend: trends[k] })),
      ms: Date.now() - t0,
      candidates: pool.size,
      requests: api.takeRequestCount(),
      engine: `MiniLM tag space (${tagSpaceSize()} tags)`,
      drift,
      listeningShare,
      newArtists,
    };
    markDirty("state");
    log(
      `Picks:\n${picks
        .map((p, i) => `  ${String(i + 1).padStart(2)}. ${(p.score! * 100).toFixed(0)}% [${p.cluster! >= 0 ? clusters[p.cluster!].label : "wildcard"}] ${p.t.artists.map((a) => a.name).join(", ")} - ${p.t.title} {${[...p.sources].map((s) => s.split(":")[0]).filter((s, i, a) => a.indexOf(s) === i).join(",")}}`)
        .join("\n")}`,
    );
    log(`Done in ${Math.round((Date.now() - t0) / 1000)}s, ${state.lastRun.requests} requests; ${newArtists}/${picks.length} picks by artists new to you`);
    if (settings.notify) notify(`${PLAYLIST_NAME} is ready: ${picks.length} new tracks`);
    setStatus({ running: false, stage: "Ready" });
  } catch (err) {
    if (api.isAbort(err)) {
      setStatus({ running: false, stage: "Cancelled" });
      return;
    }
    const msg = (err as Error)?.message ?? String(err);
    log(`Failed: ${msg}\n${(err as Error)?.stack ?? ""}`);
    setStatus({ running: false, stage: "Failed", error: msg });
  } finally {
    await flush().catch(() => {});
  }
};
