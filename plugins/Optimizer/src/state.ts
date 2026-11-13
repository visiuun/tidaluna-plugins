import { ReactiveStore } from "@luna/core";

export type PluginSettings = {
  /** Hold animation frames (what nearly every animation, visualiser and 3D effect draws with) */
  frames: boolean;
  /** Pause CSS animations */
  css: boolean;
  /** Pause videos that have no sound (animated covers, decorations) */
  videos: boolean;
  /** Have the page itself say it is hidden, so that TIDAL and plugins that ask stop their own work */
  pageVisibility: boolean;
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("Optimizer", {
  frames: true,
  css: true,
  videos: true,
  pageVisibility: true,
});

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
