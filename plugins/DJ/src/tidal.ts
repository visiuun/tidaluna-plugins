// The link to TIDAL's own player. While the DJ is on, TIDAL keeps playing the current track as usual
// (so the player bar, queue, lyrics, scrobbling and play counts all keep working) but silently: the sound
// you hear comes from the DJ's mixer, which follows whatever you do with TIDAL's controls.
import type { LunaUnload } from "@luna/core";
import { log, warn } from "./log";
import { playerShared } from "./native";
import { noteSame, sameTrack } from "./versions";

const lib = () => window.luna.lib!;
const core = () => window.luna.core!;
const state = () => lib().redux.store.getState();
const actions = () => lib().redux.actions as Record<string, (payload?: any) => unknown>;

/**
 * TIDAL's own now-playing view, brought up for the DJ full screen to show through to (see THROUGH in stage.ts):
 * that is where other plugins draw their backdrop ("bg"), and where the lyrics are ("lyr": on its lyrics). ""
 * puts everything back as it was: the view closed again if it was closed, on the tab it was on.
 * It is asked again and again while the full screen is open (see lookUnder in stage.ts), and sees to it each time:
 * TIDAL closes its view on its own account (Esc reaches it too), and the full screen then had no lyrics until the
 * view had been opened by hand.
 */
let underEntered = false;
let underTab: string | undefined;
let underAsked = 0;
let underTries = 0;
export const underNowPlaying = (want: "" | "bg" | "lyr") => {
  try {
    const s = state() as { view?: { isNowPlaying?: boolean; showNowPlaying?: boolean }; settings?: { nowPlayingActiveView?: string } };
    // (whether it is up is `showNowPlaying`: `isNowPlaying` only follows, half a second behind, and was still
    // saying yes just after the view had been closed, so it was never opened again)
    const up = !!s.view?.showNowPlaying;
    const tab = s.settings?.nowPlayingActiveView;
    // (asked again if it didn't come up, less and less often: with nothing to play, TIDAL has no such view to show)
    if (up) underTries = 0;
    if (want && !up && Date.now() - underAsked > Math.min(15000, 1500 * 2 ** underTries)) {
      underAsked = Date.now();
      underTries++;
      actions()["view/ENTER_NOWPLAYING"]?.();
      underEntered = true;
    }
    if (want === "lyr" && tab !== "lyrics") {
      actions()["settings/SET_NOW_PLAYING_ACTIVE_VIEW"]?.("lyrics");
      underTab ??= tab ?? "";
    }
    if (want !== "lyr" && underTab !== undefined) {
      // (only if it is still on the lyrics this put it on)
      if (underTab && tab === "lyrics") actions()["settings/SET_NOW_PLAYING_ACTIVE_VIEW"]?.(underTab);
      underTab = undefined;
    }
    if (!want && underEntered) {
      if (up) actions()["view/EXIT_NOWPLAYING"]?.();
      underEntered = false;
    }
  } catch (err) {
    warn("Couldn't bring TIDAL's now-playing view up under the full screen", err);
  }
};

type Player = { volume: number; currentTime?: number; updateVolumeLevel?: () => void; name?: string };
type PlayerModule = { activePlayer?: Player };
let playerModule: PlayerModule | undefined;
const activePlayer = () => {
  playerModule ??= (core().findModuleByProperty<PlayerModule>((key: unknown, value: unknown) => key === "activePlayer" && typeof value === "object" && value !== null && "currentTime" in (value as object)) as PlayerModule | undefined) ?? undefined;
  return playerModule?.activePlayer;
};

const descriptorOf = (obj: object, key: string) => {
  for (let p: object | null = obj; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return d;
  }
  return undefined;
};

// ------------------ THE DJ'S ENTRIES IN TIDAL'S QUEUE ------------------
// Every entry of TIDAL's queue has an id of its own (uid). Those the DJ added are noted, so that it only ever
// takes out or moves its own. Kept in localStorage: TIDAL keeps its queue, with the same ids, across reloads and
// restarts, and the DJ's entries in it are still known to be the DJ's then (an id is made from the moment it was
// made, so it never comes again for one of yours). Those noted in sessionStorage by 1.14.1 and before are taken in.
const OWNED_KEY = "visiuun-dj-queue-uids";
const OWNED_MAX = 2000;
const ownedUids: Set<string> = (() => {
  const read = (store: () => Storage) => {
    try {
      const v = JSON.parse(store().getItem(OWNED_KEY) ?? "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };
  return new Set<string>([...read(() => localStorage), ...read(() => sessionStorage)]);
})();
const saveOwned = () => {
  try {
    const all = [...ownedUids];
    if (all.length > OWNED_MAX) for (const uid of all.slice(0, all.length - OWNED_MAX)) ownedUids.delete(uid);
    localStorage.setItem(OWNED_KEY, JSON.stringify([...ownedUids]));
    sessionStorage.removeItem(OWNED_KEY);
  } catch {}
};
/** Notes as the DJ's every entry of TIDAL's queue that wasn't there `before` */
const noteOwned = (before: Set<string>) => {
  try {
    const elements = state().playQueue.elements ?? [];
    const present = new Set<string>();
    for (const e of elements) {
      const uid = String(e.uid);
      present.add(uid);
      if (!before.has(uid)) ownedUids.add(uid);
    }
    // (entries no longer in the queue are forgotten)
    for (const uid of ownedUids) if (!present.has(uid)) ownedUids.delete(uid);
    saveOwned();
  } catch {}
};

/**
 * Takes every entry the DJ put in TIDAL's queue that is still to come out of it again (the one playing stays, and
 * goes as TIDAL moves on). Done when the full DJ stops, and by transitions only for any the DJ left behind before
 * this was done: they sat in front of your own queue, and transitions only then mixed the DJ's picks in instead
 * of what you had queued. Returns how many were taken out.
 */
export const dropOwnUpcoming = (): number => {
  try {
    const pq = state().playQueue;
    const elements: { uid: unknown }[] = pq.elements ?? [];
    if (!elements.length || !ownedUids.size) return 0;
    const drop = elements.filter((e, i) => i > pq.currentIndex && ownedUids.has(String(e.uid))).map((e) => String(e.uid));
    // (by its id, never by where it is: TIDAL never takes out the entry that is playing this way)
    for (const uid of drop) actions()["playQueue/REMOVE_ELEMENT"]({ uid });
    const left = new Set((state().playQueue.elements ?? []).map((e: any) => String(e.uid)));
    for (const uid of drop) if (!left.has(uid)) ownedUids.delete(uid);
    saveOwned();
    return drop.length;
  } catch (err) {
    warn("Couldn't take the DJ's own tracks out of TIDAL's queue", err);
    return 0;
  }
};

/** How far TIDAL's queue is looked through for the track the mixer moved on to (see reachable) */
const REACH = 100;
/**
 * Where `id` (or another version of it, see versions.ts) is in TIDAL's queue after the current entry, looking past
 * nothing but entries queued with Play next / Add to queue, which are put in right after the current one (or after
 * the last of them): what TIDAL's next was when the mixer took it, wherever such entries have been put in front of it
 * since. -1: it isn't there (it was taken out, or the queue is somewhere else now). The nearest one counts.
 * `own`: only an entry the DJ put there.
 */
const reachable = (elements: { uid: unknown; mediaItemId: unknown; priority?: string }[], current: number, id: string, own: boolean) => {
  const last = Math.min(elements.length, current + 1 + REACH);
  for (let i = current + 1; i < last; i++) {
    const e = elements[i];
    if ((!own || ownedUids.has(String(e.uid))) && sameTrack(String(e.mediaItemId), id)) return i;
    // (an entry of what you're playing, the album or the playlist: what comes after it is further on, not next)
    if (e.priority !== "priority_keep") return -1;
  }
  return -1;
};

/**
 * Puts a track on in TIDAL right after the one it is on (what was played stays its history), plays it, and moves it
 * to `at` seconds once it plays. For a shared mashup (see playShared in session.ts). False: it didn't come on.
 */
export const playTrackAt = async (id: string, at: number) => {
  try {
    await lib().MediaItem.fromId(id).catch(() => undefined);
    const a = actions();
    const pq = state().playQueue;
    const index = Math.max(0, (pq.currentIndex ?? -1) + 1);
    a["playQueue/ADD_AT_INDEX"]({ context: { type: "UNKNOWN" }, index, mediaItemIds: [id] });
    a["playQueue/MOVE_TO"](index);
    a["playbackControls/PLAY"]();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = state();
      const cur = s.playQueue.elements?.[s.playQueue.currentIndex]?.mediaItemId;
      // (or another version of it: RealMAX may put its best version on in its place, see versions.ts)
      if (cur !== undefined && sameTrack(String(cur), id) && s.playbackControls.playbackState === "PLAYING") {
        if (at > 1) {
          a["playbackControls/SEEK"](at);
          await new Promise((r) => setTimeout(r, 800));
        }
        return true;
      }
    }
  } catch (err) {
    warn("Couldn't put the track on", err);
  }
  return false;
};

// ------------------ SILENCING ------------------
// TIDAL sets its player's volume through a `volume` setter (on every track start and slider move).
// Shadowing that setter on the player keeps it at zero without touching the slider you see.
let silenced: Player | undefined;
const silence = (player: Player) => {
  const d = descriptorOf(Object.getPrototypeOf(player), "volume");
  if (!d?.set) throw new Error("TIDAL's player has no volume control to take over");
  Object.defineProperty(player, "volume", {
    configurable: true,
    enumerable: false,
    get: () => d.get?.call(player),
    set: () => d.set!.call(player, 0),
  });
  d.set.call(player, 0);
  silenced = player;
};
const unsilence = () => {
  const player = silenced;
  silenced = undefined;
  if (!player) return;
  try {
    // Dropping the shadow puts TIDAL's own setter back in charge
    delete (player as any).volume;
    const pc = state().playbackControls;
    player.volume = pc.muted ? 0 : pc.volume / 100;
    // With TIDAL's loudness normalisation on, this re-applies the track's adjustment
    if (!pc.muted) player.updateVolumeLevel?.();
  } catch (err) {
    warn("Couldn't hand the volume back to TIDAL", err);
  }
};
// A safety net: if this plugin instance is replaced without its cleanup running, the next one restores the sound
declare global {
  interface Window {
    __visiuunDjRelease?: () => void;
  }
}

export type LinkEvents = {
  /** You moved the progress bar */
  seek(time: number): void;
  /** Play/pause changed */
  playing(playing: boolean): void;
  /** Volume slider or mute changed */
  volume(percent: number, muted: boolean): void;
};

export class TidalLink {
  private unloads = new Set<LunaUnload>();
  private selfSeekUntil = 0;
  private selfMoveUntil = 0;
  private restore?: { shuffle: boolean; repeat: number };
  private lastPlaying: boolean | undefined;
  private lastVolume = "";
  active = false;

  constructor(private readonly events: LinkEvents) {}

  // ------------------ LIFECYCLE ------------------
  /**
   * `lockModes`: shuffle and repeat are switched off and held off (the full DJ runs TIDAL's queue itself:
   * shuffling it or repeating a track would pull TIDAL away from what the mixer is playing and end the
   * session). They come back as they were when the session ends.
   */
  takeOver(lockModes = false) {
    if (this.active) return;
    window.__visiuunDjRelease?.();
    const player = activePlayer();
    if (!player) throw new Error("Couldn't find TIDAL's player");
    silence(player);
    this.active = true;
    this.posTimer = setInterval(() => this.notePosition(), 20);
    window.__visiuunDjRelease = () => this.release();
    const { redux } = lib();
    const pq = state().playQueue;
    this.restore = { shuffle: !!pq.shuffleModeEnabled, repeat: pq.repeatMode };
    // Seeks: the mixer follows the progress bar
    redux.intercept("playbackControls/SEEK" as any, this.unloads, (time: number) => {
      if (Date.now() < this.selfSeekUntil) return;
      if (typeof time === "number") this.events.seek(time);
    });
    if (lockModes) {
      try {
        if (pq.shuffleModeEnabled) actions()["playQueue/DISABLE_SHUFFLE_MODE"]();
        if (pq.repeatMode) actions()["playQueue/SET_REPEAT_MODE"](0);
      } catch {}
      // The buttons and keyboard shortcuts send these; the DJ's own changes don't pass through here
      const block = ["playQueue/TOGGLE_SHUFFLE", "playQueue/TOGGLE_REPEAT_MODE", "playQueue/ENABLE_SHUFFLE_MODE", "playQueue/ENABLE_SHUFFLE_MODE_AND_SHUFFLE_ITEMS"];
      for (const type of block) redux.intercept(type as any, this.unloads, () => true);
      redux.intercept("playQueue/SET_REPEAT_MODE" as any, this.unloads, (mode: unknown) => (mode ? true : undefined));
    }
    const unsubscribe = redux.store.subscribe(() => this.observe());
    this.unloads.add(unsubscribe);
    this.observe(true);
  }

  release() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.posTimer);
    this.posTimer = undefined;
    for (const u of this.unloads) {
      try {
        u();
      } catch {}
    }
    this.unloads.clear();
    unsilence();
    if (window.__visiuunDjRelease) delete window.__visiuunDjRelease;
    this.lastPlaying = undefined;
    this.lastVolume = "";
    this.queueSeen = undefined;
    this.uidIds.clear();
  }

  /** Puts shuffle/repeat back the way they were before the session */
  restoreModes() {
    const r = this.restore;
    this.restore = undefined;
    if (!r) return;
    try {
      if (r.shuffle) actions()["playQueue/ENABLE_SHUFFLE_MODE"]();
      if (r.repeat) actions()["playQueue/SET_REPEAT_MODE"](r.repeat);
    } catch {}
  }

  /** Waits until TIDAL's player and its queue are there to take over (they aren't in the first moments of a page). False: they didn't come */
  async whenReady(ms: number) {
    const until = Date.now() + ms;
    for (;;) {
      try {
        if (activePlayer() && Array.isArray(state().playQueue?.elements) && state().playbackControls) {
          // (a moment more: TIDAL is still putting back what it remembered of its queue)
          await new Promise((r) => setTimeout(r, 1000));
          return true;
        }
      } catch {}
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Called on every store change and on the session's tick */
  observe(force = false) {
    if (!this.active) return;
    // TIDAL swaps players for some content: keep whichever one is active silent
    const player = activePlayer();
    if (player && player !== silenced) {
      const old = silenced;
      try {
        if (old) delete (old as any).volume;
        silence(player);
      } catch (err) {
        warn("Couldn't silence TIDAL's player", err);
      }
    }
    const s = state();
    this.noteSwaps(s.playQueue?.elements);
    const pc = s.playbackControls;
    const playing = pc.desiredPlaybackState === "PLAYING";
    if (force || playing !== this.lastPlaying) {
      this.lastPlaying = playing;
      this.events.playing(playing);
    }
    const vol = `${pc.volume}|${pc.muted}`;
    if (force || vol !== this.lastVolume) {
      this.lastVolume = vol;
      this.events.volume(Number(pc.volume) || 0, !!pc.muted);
    }
  }

  /**
   * RealMAX swaps an entry of TIDAL's queue for the best version of its song where it stands, as TIDAL's own buttons
   * move to it (the same entry, another track): the two are noted as the same song (see versions.ts), so the DJ
   * doesn't take it for something else you put on
   */
  private queueSeen?: unknown;
  private uidIds = new Map<string, string>();
  private noteSwaps(elements: { uid: unknown; mediaItemId: unknown }[] | undefined) {
    if (!Array.isArray(elements) || elements === this.queueSeen) return;
    this.queueSeen = elements;
    const ids = new Map<string, string>();
    for (const e of elements) {
      const uid = String(e.uid);
      const id = String(e.mediaItemId);
      const was = this.uidIds.get(uid);
      if (was !== undefined && was !== id) noteSame(was, id);
      ids.set(uid, id);
    }
    this.uidIds = ids;
  }

  // ------------------ OUTPUT DEVICE ------------------
  // The mixer plays out of the device TIDAL plays out of, alongside TIDAL's own (silent) player. In exclusive
  // mode TIDAL's player would keep that device to itself (and pay no heed to being kept silent): while the DJ
  // plays, TIDAL's player opens it in shared mode instead (see playerShared in mixer.native.ts). TIDAL's
  // settings are left as they are, and exclusive mode is back the moment the DJ stops.
  /** The device TIDAL plays out of (name undefined: the system's default), and whether TIDAL means to have it to itself */
  output(): { name: string | undefined; exclusive: boolean } {
    const p = state().player ?? {};
    const dev = (p.availableDevices ?? []).find((d: any) => d.id === p.activeDeviceId);
    return { name: dev && dev.id !== "default" ? String(dev.name ?? "") || undefined : undefined, exclusive: p.activeDeviceMode === "exclusive" && !!dev?.nativeDeviceId && dev.id !== "default" };
  }
  /** Has TIDAL's player hold its device in shared mode while the DJ plays. True: it was in exclusive mode, and now isn't */
  async shareDevice(): Promise<boolean> {
    try {
      const p = state().player ?? {};
      const dev = (p.availableDevices ?? []).find((d: any) => d.id === p.activeDeviceId);
      // (the page's own choice of device, made again: the player gets it in shared mode)
      const exclusive = p.activeDeviceMode === "exclusive" && dev?.nativeDeviceId && dev.id !== "default";
      const select = exclusive
        ? JSON.stringify({ command: "media.device.select", device: { controllableVolume: dev.controllableVolume !== false, id: dev.nativeDeviceId, name: dev.name, type: "default" }, options: { mode: "exclusive" } })
        : undefined;
      const held = await playerShared(true, select);
      if (held && select) log(`TIDAL's player holds ${dev.name} in shared mode while the DJ plays (exclusive mode is back when it stops)`);
      return !!(held && select);
    } catch (err) {
      warn("Couldn't keep TIDAL's player in shared mode", err);
      return false;
    }
  }
  /** TIDAL's player gets its device back the way TIDAL asked for it (exclusive mode, if that is on) */
  async restoreDevice() {
    try {
      await playerShared(false);
    } catch (err) {
      warn("Couldn't give TIDAL's player its exclusive mode back", err);
    }
  }

  // ------------------ STATE ------------------
  /** The track TIDAL's queue is on */
  currentId(): string | undefined {
    const pq = state().playQueue;
    const id = pq.elements?.[pq.currentIndex]?.mediaItemId;
    return id === undefined ? undefined : String(id);
  }
  /** Ids after the current one in TIDAL's queue */
  upcomingIds(): string[] {
    const pq = state().playQueue;
    return (pq.elements ?? []).slice(pq.currentIndex + 1).map((e: any) => String(e.mediaItemId));
  }
  /** TIDAL's queue from the current item on */
  queueFromCurrent(): string[] {
    const pq = state().playQueue;
    return (pq.elements ?? []).slice(Math.max(0, pq.currentIndex)).map((e: any) => String(e.mediaItemId));
  }
  /** Repeat is set to repeat the one track */
  get repeatsOne() {
    return state().playQueue.repeatMode === 2;
  }
  /** The track TIDAL is on, if it is a track (not a video) */
  currentTrackId(): string | undefined {
    const product = state().playbackControls.mediaProduct;
    if (product?.productType && product.productType !== "track") return undefined;
    return this.currentId();
  }
  volumeState() {
    const pc = state().playbackControls;
    return { percent: Number(pc.volume) || 0, muted: !!pc.muted };
  }
  // TIDAL only moves its position on four times a second, so a reading of it is up to a quarter of a
  // second old. Lyrics have to be closer to the sound than that: the moment each new value appears is
  // noted, and the position is carried forward from there.
  private posValue = -1;
  private posAt = 0;
  private posTimer?: ReturnType<typeof setInterval>;
  private notePosition() {
    // From the player that is active now. Luna's PlayState.currentTime keeps hold of the player it found
    // first, and TIDAL has two (its own, and a web player it changes to for some songs): after a change
    // that figure stands still. The DJ then took TIDAL to be far from the music and moved it there again
    // every few seconds, stalling it for an instant each time (the play button flickered).
    const live = Number(activePlayer()?.currentTime);
    const v = Number.isFinite(live) ? live : lib().PlayState.currentTime;
    if (v !== this.posValue) {
      this.posValue = v;
      this.posAt = performance.now();
    }
    return v;
  }
  position() {
    const v = this.notePosition();
    if (!this.posTimer || !this.playing) return v;
    return v + Math.min(0.4, (performance.now() - this.posAt) / 1000);
  }
  get playing() {
    return state().playbackControls.desiredPlaybackState === "PLAYING";
  }
  /** TIDAL's own loudness normalisation is on */
  get normalizes() {
    const mode = state().settings?.audioNormalization;
    return !!mode && mode !== "NONE";
  }
  get selfMoved() {
    return Date.now() < this.selfMoveUntil;
  }
  firstName(): string | undefined {
    const meta = state().user?.meta;
    const name = (meta?.firstName || meta?.profileName || "").trim().split(/\s+/)[0];
    return name && /^[\p{L}'-]{2,20}$/u.test(name) ? name : undefined;
  }

  // ------------------ CONTROL ------------------
  private async ensureLoaded(ids: string[]) {
    // Tracks have to be in TIDAL's store before the queue can show them
    const { MediaItem } = lib();
    await Promise.all(ids.map((id) => MediaItem.fromId(id).catch(() => undefined)));
  }

  /**
   * Puts these tracks on in TIDAL's queue, right after the one it is on, and starts the first. What was played
   * before stays where it is, so TIDAL's previous button still goes back to it, and what you had queued
   * comes after the DJ's tracks (see setUpcoming)
   */
  async startQueue(ids: string[]) {
    // Covers the time it takes to load the tracks: the old track still showing isn't "you played something else"
    this.selfMoveUntil = Date.now() + 10000;
    await this.ensureLoaded(ids);
    this.selfMoveUntil = Date.now() + 4000;
    const a = actions();
    try {
      if (state().playQueue.shuffleModeEnabled) a["playQueue/DISABLE_SHUFFLE_MODE"]();
      if (state().playQueue.repeatMode) a["playQueue/SET_REPEAT_MODE"](0);
    } catch {}
    // (spliced in after the current track and moved to: TIDAL's own "play now" rebuilds the queue, and what
    // was played before, and what you had queued, would be gone)
    const before = new Set<string>((state().playQueue.elements ?? []).map((e: any) => String(e.uid)));
    const at = Math.max(0, state().playQueue.currentIndex + 1);
    a["playQueue/ADD_AT_INDEX"]({ context: { type: "UNKNOWN" }, index: at, mediaItemIds: ids });
    noteOwned(before);
    a["playQueue/MOVE_TO"](at);
    try {
      a["playQueue/SET_SOURCE_PROPERTIES"]({ name: "DJ", trackListName: "visiuun-dj" });
    } catch {}
    a["playbackControls/PLAY"]();
  }

  /**
   * Makes the DJ's own tracks right after the current one in TIDAL's queue match `ids`. Only entries the DJ
   * put there are ever taken out or moved: what you had queued yourself stays, after the DJ's (it used to be
   * cleared, and the queue you had was gone once the DJ had been on, a mashup for one)
   */
  async setUpcoming(ids: string[]) {
    const mine = () => {
      const pq = state().playQueue;
      return (pq.elements ?? []).map((e: any, i: number) => ({ i, id: String(e.mediaItemId), uid: String(e.uid), own: ownedUids.has(String(e.uid)) })).filter((e: any) => e.i > pq.currentIndex);
    };
    // The DJ's block as it stands: its entries straight after the current track, in order
    const block = () => {
      const after = mine();
      const out: string[] = [];
      for (const e of after) {
        if (!e.own) break;
        out.push(e.id);
      }
      return { after, block: out };
    };
    const { after, block: now } = block();
    const strays = after.filter((e: any) => e.own).length - now.length;
    if (!strays && now.length === ids.length && now.every((id, i) => id === ids[i])) return;
    await this.ensureLoaded(ids);
    const a = actions();
    // Keep the common start of the block; every other entry of the DJ's after the current track goes
    let keep = 0;
    while (keep < now.length && keep < ids.length && now[keep] === ids[keep]) keep++;
    const drop = mine()
      .filter((e: any) => e.own)
      .slice(keep)
      .map((e: any) => e.i)
      .sort((x: number, y: number) => y - x);
    for (const index of drop) a["playQueue/REMOVE_AT_INDEX"]({ index });
    const add = ids.slice(keep);
    if (!add.length) return;
    const before = new Set<string>((state().playQueue.elements ?? []).map((e: any) => String(e.uid)));
    a["playQueue/ADD_AT_INDEX"]({ context: { type: "UNKNOWN" }, index: state().playQueue.currentIndex + 1 + keep, mediaItemIds: add });
    noteOwned(before);
  }

  /**
   * Moves TIDAL on to `id`, the track the mixer has moved on to (or another version of it: see versions.ts), one
   * step: it is TIDAL's next entry, or comes right after entries you queued in front of it since (see reachable).
   * Returns whether TIDAL is (now) on it.
   *
   * Never by jumping to it: TIDAL deletes every Play next / Add to queue entry a jump goes past (they are only ever
   * played once), and everything else it goes past counts as played. Moved with TIDAL's move to an entry further on,
   * the DJ deleted what you had just queued; looked for anywhere in the queue, it went to the same song hundreds of
   * entries on, past and out of everything in between. An entry further on is brought up to right after the one
   * playing instead, everything else staying as it is, and TIDAL moves on to it the way its own next button does.
   *
   * `swapIn`: an entry that is another version of it is made `id` on the way, the way RealMAX swaps an entry for its
   * best version as TIDAL's own next button moves to it (the DJ's moves go past RealMAX: actions sent through Luna
   * don't pass other plugins' intercepts), so TIDAL plays what the mixer has. `own`: only an entry the DJ put there
   * (the full DJ's tracks are its own; it never takes one of yours for one of them).
   */
  moveTo(id: string, swapIn = false, own = false) {
    if (sameTrack(this.currentId(), id)) return true;
    const pq = state().playQueue;
    const elements = pq.elements ?? [];
    const at = pq.currentIndex + 1;
    const index = reachable(elements, pq.currentIndex, id, own);
    if (index < 0) return false;
    const entry = elements[index];
    const swap = swapIn && String(entry.mediaItemId) !== id;
    if (index > at || swap) {
      // One change to the queue: the entry up next to the one playing (made `id`, if swapped), nothing else moved
      // and nothing taken out. TIDAL keeps playing as it was: it is the entry playing that tells it what to play.
      try {
        const moved = swap ? { ...entry, mediaItemId: typeof entry.mediaItemId === "number" ? Number(id) : id } : entry;
        actions()["playQueue/RESET"]({ ...pq, elements: [...elements.slice(0, at), moved, ...elements.slice(at, index), ...elements.slice(index + 1)] });
        if (swap) noteSame(String(entry.mediaItemId), id);
      } catch (err) {
        warn(swap ? "Couldn't put the version the mixer has in TIDAL's queue" : "Couldn't bring the next track up in TIDAL's queue", err);
      }
      // (not next after all: rather not move TIDAL than move it past what you queued)
      const now = state().playQueue;
      if (String(now.elements?.[now.currentIndex + 1]?.uid) !== String(entry.uid)) return false;
    }
    this.selfMoveUntil = Date.now() + 2500;
    actions()["playQueue/MOVE_NEXT"]();
    return true;
  }

  /** Sets TIDAL's volume slider (percent) */
  setVolume(percent: number) {
    try {
      actions()["playbackControls/SET_VOLUME"]({ volume: Math.max(0, Math.min(100, Math.round(percent))) });
    } catch {}
  }
  seek(time: number) {
    this.selfSeekUntil = Date.now() + 1200;
    actions()["playbackControls/SEEK"](Math.max(0, time));
  }
  pause() {
    actions()["playbackControls/PAUSE"]();
  }
  play() {
    actions()["playbackControls/PLAY"]();
  }
  logState(what: string) {
    const pq = state().playQueue;
    log(`${what}: TIDAL on ${this.currentId()} (index ${pq.currentIndex}/${pq.elements?.length}), ${state().playbackControls.playbackState}`);
  }
}
