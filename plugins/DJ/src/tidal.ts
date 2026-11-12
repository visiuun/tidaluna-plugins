// The link to TIDAL's own player. While the DJ is on, TIDAL keeps playing the current track as usual
// (so the player bar, queue, lyrics, scrobbling and play counts all keep working) but silently: the sound
// you hear comes from the DJ's mixer, which follows whatever you do with TIDAL's controls.
import type { LunaUnload } from "@luna/core";
import { log, warn } from "./log";

const lib = () => window.luna.lib!;
const core = () => window.luna.core!;
const state = () => lib().redux.store.getState();
const actions = () => lib().redux.actions as Record<string, (payload?: any) => unknown>;

type Player = { volume: number; updateVolumeLevel?: () => void; name?: string };
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
  /** TIDAL's output device changed */
  device(webDeviceId: string | undefined): void;
};

export class TidalLink {
  private unloads = new Set<LunaUnload>();
  private selfSeekUntil = 0;
  private selfMoveUntil = 0;
  private restore?: { shuffle: boolean; repeat: number };
  private lastPlaying: boolean | undefined;
  private lastVolume = "";
  private lastDevice: string | undefined | null = null;
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
    this.lastDevice = null;
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
    const dev = (s.player?.availableDevices ?? []).find((d: any) => d.id === s.player?.activeDeviceId)?.webDeviceId as string | undefined;
    if (force || dev !== this.lastDevice) {
      this.lastDevice = dev;
      this.events.device(dev);
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
    const v = lib().PlayState.currentTime;
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

  /** Replaces TIDAL's queue with these tracks and starts the first */
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
    a["playQueue/ADD_NOW"]({ context: { type: "UNKNOWN" }, mediaItemIds: ids, fromIndex: 0, overwritePlayQueue: true });
    try {
      a["playQueue/SET_SOURCE_PROPERTIES"]({ name: "DJ", trackListName: "visiuun-dj" });
    } catch {}
    a["playbackControls/PLAY"]();
  }

  /** Makes everything after the current track in TIDAL's queue match `ids` */
  async setUpcoming(ids: string[]) {
    const current = this.upcomingIds();
    if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
    await this.ensureLoaded(ids);
    const a = actions();
    // Keep the common prefix, drop the rest from the end, then append
    let keep = 0;
    while (keep < current.length && keep < ids.length && current[keep] === ids[keep]) keep++;
    const pq = state().playQueue;
    for (let i = pq.elements.length - 1; i > pq.currentIndex + keep; i--) a["playQueue/REMOVE_AT_INDEX"]({ index: i });
    const add = ids.slice(keep);
    if (add.length) a["playQueue/ADD_LAST"]({ context: { type: "UNKNOWN" }, mediaItemIds: add });
  }

  /** Moves TIDAL to `id` if it's ahead in the queue. Returns whether TIDAL is (now) on it */
  moveTo(id: string) {
    if (this.currentId() === id) return true;
    const pq = state().playQueue;
    const index = (pq.elements ?? []).findIndex((e: any, i: number) => i > pq.currentIndex && String(e.mediaItemId) === id);
    if (index < 0) return false;
    this.selfMoveUntil = Date.now() + 2500;
    if (index === pq.currentIndex + 1) actions()["playQueue/MOVE_NEXT"]();
    else actions()["playQueue/MOVE_TO"](index);
    return true;
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
