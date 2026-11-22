// Implicit feedback, the signal Spotify leans on most: what you finish, what you skip, what you heart.
import type { LunaUnload } from "@luna/core";
import { MediaItem, PlayState, redux, safeInterval } from "@luna/lib";
import { markDirty, state, tracks, writeLog } from "./db";
import { engagement } from "./profile";
import { learnFromOutcome } from "./rank";
import type { ListenKind } from "./types";

const POLL_MS = 2000;
const SKIP_MS = 30000;

// `pick`: the recommendation this track is, see pickFor
type Current = { id: string; artists: string[]; start: number; duration: number; listened: number; lastPos: number; dd: boolean; pick?: string };
let current: Current | null = null;

// Where the song is, from the player that is active now (TIDAL has two, its own and a web player it changes to for
// some songs; Luna's PlayState.currentTime follows the change)
const position = (): number => PlayState.currentTime;

/**
 * Which of our picks a track is: the pick itself, or the same recording (same ISRC) under another id. The playlist
 * can hold another release of a pick than the one ranked (its best quality version), and RealMAX can swap a track
 * for its best version as it plays: either way your reaction counts for the pick
 */
export const pickFor = (id: string, isrc = tracks[id]?.isrc): string | undefined => {
  if (state.recommended[id]) return id;
  if (!isrc) return undefined;
  for (const pick in state.recommended) if (tracks[pick]?.isrc === isrc) return pick;
  return undefined;
};

const trackListeners = new Set<(id: string | null) => void>();
/** Called with the new track id whenever playback moves to another track */
export const onTrackChange = (fn: (id: string | null) => void) => {
  trackListeners.add(fn);
  return () => void trackListeners.delete(fn);
};
export const currentTrackId = () => current?.id ?? null;
export const playingOurPlaylist = () => !!current?.dd;
export const feedbackFor = (id: string | null) => (id ? state.feedback[id]?.v : undefined);

/**
 * 👍 / 👎 on what's playing. Pressing the same one again takes it back. 👎 also skips, like hiding a
 * song. On one of TrueTaste's own picks it's the strongest training signal the ranker gets.
 */
export const giveFeedback = (v: 1 | -1) => {
  const c = current;
  if (!c) return undefined;
  const prev = state.feedback[c.id];
  if (prev?.v === v) {
    delete state.feedback[c.id];
    markDirty("state");
    writeLog(`Feedback removed on ${c.id}`);
    return undefined;
  }
  state.feedback[c.id] = { v, at: Date.now(), artists: c.artists };
  markDirty("state");
  if (c.pick) learnFromOutcome(c.pick, v > 0 ? 1 : 0, 3);
  writeLog(`${v > 0 ? "👍" : "👎"} on ${c.id}${c.pick ? ` (one of our picks${c.pick !== c.id ? `, ${c.pick}` : ""})` : ""}`);
  if (v < 0) PlayState.next();
  return v;
};

const fromOurPlaylist = () => {
  if (!state.playlistId) return false;
  const pq = PlayState.playQueue;
  const ctx = pq.elements?.[pq.currentIndex]?.context;
  return String(ctx?.id ?? pq.sourceEntityId ?? "") === state.playlistId;
};

const classify = (ms: number, ratio: number): ListenKind => {
  if (ratio >= 0.8) return "complete";
  if (ms < SKIP_MS && ratio < 0.5) return "skip";
  return "partial";
};

const finish = () => {
  const c = current;
  current = null;
  if (!c || c.duration <= 0) return;
  const ms = Math.round(c.listened * 1000);
  // Barely started (clicked through, or a reload): not a meaningful signal either way
  if (ms < 1500) return;
  const ratio = Math.min(1, c.listened / c.duration);
  const kind = classify(ms, ratio);
  state.events.push({ id: c.id, t: c.start, ms, ratio: Math.round(ratio * 100) / 100, kind, ...(c.dd ? { dd: 1 as const } : {}) });
  markDirty("state");

  // Outcome of something we recommended → train the ranker, on the same listening-time curve
  if (c.pick) {
    const e = engagement(ms, ratio);
    learnFromOutcome(c.pick, (e + 1) / 2, e <= -0.9 ? 1.5 : 1);
    writeLog(`Feedback on pick ${c.pick}${c.pick !== c.id ? ` (as ${c.id})` : ""}: ${kind} (${Math.round(ratio * 100)}%)`);
  }
};

const poll = () => {
  if (!current) return;
  if (!PlayState.playing) return;
  const pos = position();
  const delta = pos - current.lastPos;
  // Only count real playback: seeks and stalls show up as jumps
  if (delta > 0 && delta < (POLL_MS / 1000) * 2.5) current.listened += delta;
  current.lastPos = pos;
};

let stopWatchingLikes: (() => void) | undefined;
type Store = { getState: () => any; subscribe: (fn: () => void) => () => void };
/** Notes likes and unlikes as TIDAL's list of liked tracks changes (see startTracking); returns the way to stop */
export const watchLikes = (store: Store) => {
  let seen: Set<string> | undefined;
  let list: unknown;
  const check = () => {
    const fav = store.getState()?.favorites;
    if (!fav?.isLoaded || !Array.isArray(fav.tracks) || fav.tracks === list) return;
    list = fav.tracks;
    const now = new Set<string>(fav.tracks.map(String));
    // (the list as it first comes is what you had: nothing to note)
    if (!seen) return void (seen = now);
    const added = [...now].filter((id) => !seen!.has(id));
    const removed = [...seen].filter((id) => !now.has(id));
    seen = now;
    if (!added.length && !removed.length) return;
    const yours = added.length + removed.length <= 25;
    const at = Date.now();
    for (const id of added) {
      state.likes[id] = at;
      delete state.unlikes[id];
      const pick = yours ? (id === current?.id ? current.pick : pickFor(id)) : undefined;
      if (pick) {
        learnFromOutcome(pick, 1, 2.5);
        writeLog(`Feedback on pick ${pick}${pick !== id ? ` (as ${id})` : ""}: liked`);
      }
    }
    for (const id of removed) state.unlikes[id] = at;
    if (yours) writeLog(`Likes: ${added.length ? `+${added.join(", +")}` : ""}${added.length && removed.length ? " " : ""}${removed.length ? `-${removed.join(", -")}` : ""}`);
    markDirty("state");
  };
  check();
  return store.subscribe(check);
};

export const startTracking = (unloads: Set<LunaUnload>) => {
  const begin = (item: MediaItem) => {
    if (item.contentType !== "track") {
      current = null;
      for (const fn of trackListeners) fn(null);
      return;
    }
    const artists = (item.tidalItem.artists ?? (item.tidalItem.artist ? [item.tidalItem.artist] : [])).map((a) => String(a.id));
    const id = String(item.id);
    const pick = pickFor(id, (item.tidalItem as { isrc?: string }).isrc);
    current = { id, artists, start: Date.now(), duration: item.duration ?? 0, listened: 0, lastPos: position(), dd: fromOurPlaylist(), pick };
    for (const fn of trackListeners) fn(current.id);
  };

  MediaItem.onMediaTransition(unloads, (item) => {
    finish();
    begin(item);
  });
  // Whatever is already playing when TIDAL (or the plugin) starts
  MediaItem.fromPlaybackContext()
    .then((item) => item && !current && begin(item))
    .catch(() => {});

  safeInterval(unloads, poll, POLL_MS);

  // Hearts: TIDAL's own list of your liked tracks, watched for what comes and goes. (Watching the heart action
  // itself missed some: Luna only sees the actions TIDAL's code builds after Luna has hooked into it, and a like
  // can also come from a context menu, another device, or another plugin.) A whole batch at once is TIDAL
  // reloading the list, not you: those are noted, but don't train the ranker.
  stopWatchingLikes = watchLikes(redux.store);
  unloads.add(() => stopWatchingLikes?.());

  // Closing TIDAL or reloading the plugin isn't a skip: drop the song in progress instead of recording it
  unloads.add(() => (current = null));
};
