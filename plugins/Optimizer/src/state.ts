import { ReactiveStore } from "@luna/core";
import type { Disk, Sample } from "./guard.native";

export type Note = { at: number; text: string };
export type PluginSettings = {
  /** Don't render the page at all while it can't be seen */
  render: boolean;
  /** In sight: scripts draw at most this many times a second, and animations move in steps (0: as often as the screen shows a frame) */
  frameLimit: number;
  /** Hold animation frames (what nearly every animation, visualiser and 3D effect draws with) */
  frames: boolean;
  /** Pause CSS animations */
  css: boolean;
  /** Pause videos that have no sound (animated covers, decorations) */
  videos: boolean;
  /** Have the page itself say it is hidden, so that TIDAL and plugins that ask stop their own work */
  pageVisibility: boolean;
  /** Memory guard: watch what TIDAL's page holds, and clean up as it nears the limit */
  guard: boolean;
  /** ...the limit, MB (TIDAL's own figure for "too much" is 1500) */
  guardLimit: number;
  /** ...and past it, reload the page before it dies */
  guardReload: boolean;
  /** Collect the page's garbage when it has been out of sight for a minute */
  cleanHidden: boolean;
  /** Hand the memory TIDAL isn't using back to Windows while it is out of sight. Off unless switched on: Luna has to be asked for it (1.2.0 had it on, under another name, and asked at the worst moment) */
  handBack: boolean;
  /** Clear TIDAL's cache on disk when it passes this many MB (0: never by itself) */
  cacheLimit: number;
  /** After the page died or was reloaded: put what was playing back on, where it was */
  recover: boolean;
  /** End a page that has frozen (TIDAL then brings a fresh one) */
  unfreeze: boolean;
  /** Slow down fast repeating timers while TIDAL can't be seen */
  slowTimers: boolean;
  /** What the Optimizer has done (the newest last), and when it last reloaded the page */
  history: Note[];
  lastReload: number;
};
const DEFAULTS: PluginSettings = {
  render: true,
  frameLimit: 60,
  frames: true,
  css: true,
  videos: true,
  pageVisibility: true,
  guard: true,
  guardLimit: 1500,
  guardReload: true,
  cleanHidden: true,
  handBack: false,
  cacheLimit: 1024,
  recover: true,
  unfreeze: true,
  slowTimers: false,
  history: [],
  lastReload: 0,
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("Optimizer", { ...DEFAULTS });
// (what was stored by an earlier version has none of the newer ones)
for (const key of Object.keys(DEFAULTS) as (keyof PluginSettings)[]) if (settings[key] === undefined) (settings as any)[key] = DEFAULTS[key];

/** What the Optimizer is doing, for its settings page */
export const status = {
  /** TIDAL's window can be seen */
  visible: true,
  /** Being covered by other windows is noticed (not only being minimised) */
  covered: false,
  /** The reason nothing is being watched, if so */
  problem: "",
  /** Since TIDAL started: how often and for how long things were paused, and how many frames were not drawn */
  pauses: 0,
  pausedMs: 0,
  pausedSince: 0,
  framesHeld: 0,
  videosPaused: 0,
  timersSkipped: 0,
  /** In sight: frames of the screen that scripts were not given, animations that were given steps, and the screen's rate (0: not known yet) */
  framesSpared: 0,
  animationsStepped: 0,
  screenRate: 0,
  /** TIDAL's processes at the last look, the page's script memory (MB, and its ceiling), and what is on disk */
  sample: undefined as Sample | undefined,
  heap: 0,
  heapLimit: 0,
  disk: undefined as Disk | undefined,
  /** How full the page is, of what the guard allows (1 = at the limit) */
  level: 0,
  /** What the guard has to say right now, if anything */
  guard: "",
  /** Why memory or disk can't be looked at, if so */
  guardProblem: "",
  /** The last cleaning of the page's memory: when, and MB before and after */
  cleaned: undefined as { at: number; before: number; after: number; why: string } | undefined,
  /** The last time memory was handed back to Windows: when, and what all of TIDAL had in memory before and after, MB */
  trimmed: undefined as { at: number; before: number; after: number } | undefined,
  /** Whether that can be done here (undefined: not asked yet) */
  canTrim: undefined as boolean | undefined,
};
const listeners = new Set<() => void>();
export const onStatus = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
export const statusChanged = () => {
  for (const cb of listeners) {
    try {
      cb();
    } catch {}
  }
};

/**
 * Writes down something the Optimizer did (kept across restarts, the last thirty). The list is made anew
 * from plain values every time: what is read back out of the settings is wrapped by Luna's store, and a
 * list with such wrapped entries in it can't be saved (nor, from then on, anything else in the settings).
 */
export const note = (text: string) => {
  const before = Array.from(settings.history ?? [], (n) => ({ at: Number(n.at), text: String(n.text) }));
  settings.history = [...before, { at: Date.now(), text }].slice(-30);
  statusChanged();
};
