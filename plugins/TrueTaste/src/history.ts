// Implicit feedback, the signal Spotify leans on most: what you finish, what you skip, what you heart.
import type { LunaUnload } from "@luna/core";
import { markDirty, state, writeLog } from "./db";
import { engagement } from "./profile";
import { learnFromOutcome } from "./rank";
import type { ListenKind } from "./types";

const POLL_MS = 2000;
const SKIP_MS = 30000;

type Current = { id: string; artists: string[]; start: number; duration: number; listened: number; lastPos: number; dd: boolean };
let current: Current | null = null;

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
  if (state.recommended[c.id]) learnFromOutcome(c.id, v > 0 ? 1 : 0, 3);
  writeLog(`${v > 0 ? "👍" : "👎"} on ${c.id}${state.recommended[c.id] ? " (one of our picks)" : ""}`);
  if (v < 0) lib().PlayState.next();
  return v;
};

const lib = () => window.luna.lib!;
type MediaItemLike = { id: string | number; contentType: string; duration?: number; tidalItem: { artists?: { id: string | number }[]; artist?: { id: string | number } } };

const fromOurPlaylist = () => {
  if (!state.playlistId) return false;
  const pq = lib().PlayState.playQueue;
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
  if (state.recommended[c.id]) {
    const e = engagement(ms, ratio);
    learnFromOutcome(c.id, (e + 1) / 2, e <= -0.9 ? 1.5 : 1);
    writeLog(`Feedback on pick ${c.id}: ${kind} (${Math.round(ratio * 100)}%)`);
  }
};

const poll = () => {
  if (!current) return;
  const ps = lib().PlayState;
  if (!ps.playing) return;
  const pos = ps.currentTime;
  const delta = pos - current.lastPos;
  // Only count real playback: seeks and stalls show up as jumps
  if (delta > 0 && delta < (POLL_MS / 1000) * 2.5) current.listened += delta;
  current.lastPos = pos;
};

export const startTracking = (unloads: Set<LunaUnload>) => {
  const { MediaItem, PlayState, redux } = lib();

  const begin = (item: MediaItemLike) => {
    if (item.contentType !== "track") {
      current = null;
      for (const fn of trackListeners) fn(null);
      return;
    }
    const artists = (item.tidalItem.artists ?? (item.tidalItem.artist ? [item.tidalItem.artist] : [])).map((a) => String(a.id));
    current = { id: String(item.id), artists, start: Date.now(), duration: item.duration ?? 0, listened: 0, lastPos: PlayState.currentTime, dd: fromOurPlaylist() };
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

  const timer = setInterval(poll, POLL_MS);
  unloads.add(() => clearInterval(timer));

  // Hearts. The action is a toggle, so the direction comes from what we know is already liked
  redux.intercept("content/TOGGLE_FAVORITE_ITEMS" as any, unloads, (payload: any) => {
    for (const { itemId, itemType } of payload?.items ?? []) {
      if (itemType !== "track") continue;
      const id = String(itemId);
      const wasLiked = id in state.likes && !(id in state.unlikes && state.unlikes[id] > state.likes[id]);
      if (wasLiked && !payload.forceFavorite) {
        state.unlikes[id] = Date.now();
      } else {
        state.likes[id] = Date.now();
        delete state.unlikes[id];
        if (state.recommended[id]) {
          learnFromOutcome(id, 1, 2.5);
          writeLog(`Feedback on pick ${id}: liked`);
        }
      }
      markDirty("state");
    }
  });

  // Closing TIDAL or reloading the plugin isn't a skip: drop the song in progress instead of recording it
  unloads.add(() => (current = null));
};
