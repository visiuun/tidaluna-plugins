// Optimizer: nothing is animated or drawn while nobody can see it.
//
// TIDAL keeps its window fully awake in the background (see watch.native.ts), so minimised, or behind a
// game, TIDAL and every plugin go on drawing every frame of every animation, visualiser and 3D cover.
// This plugin finds out when the window can't actually be seen and, for as long as that lasts:
//
//   - holds animation frames: what was asked to be drawn waits, and is drawn once when the window is back
//   - pauses CSS animations, and endless animations made in script
//   - pauses videos that have no sound (animated covers and the like), and plays them again afterwards
//   - has the page say it is hidden (document.hidden, "visibilitychange"), as it would in a browser:
//     TIDAL and any plugin that asks can then leave their own work undone
//
// Timers and the music are left alone: playback, scrobbling and anything that keeps time carry on.
//
// Other plugins can go by it without depending on it: `document.hidden` and the "visibilitychange" event
// are the standard way, and `window.lunaOptimizer` ({ visible, onChange(cb) }) is there as well.
import { LunaUnload, Tracer } from "@luna/core";
import { settings, status, statusChanged } from "./state";
import { startWatching, stopWatching, visibilityAfter } from "./watch.native";

export { Settings } from "./Settings";
export const { trace } = Tracer("[Optimizer]");
export const unloads = new Set<LunaUnload>();

/** How long the window has to be out of sight before anything is paused: passing behind another window for a moment is not worth it */
const SETTLE_MS = 1500;

// ------------------ ANIMATION FRAMES ------------------
const realRequest = window.requestAnimationFrame;
const realCancel = window.cancelAnimationFrame;
const held = new Map<number, FrameRequestCallback>();
let heldId = -1;
let holding = false;
const request = (cb: FrameRequestCallback): number => {
  if (!holding) return realRequest.call(window, cb);
  // (ids below zero: the browser's own are above it)
  const id = heldId--;
  held.set(id, cb);
  status.framesHeld++;
  return id;
};
const cancel = (id: number) => {
  if (!held.delete(id)) realCancel.call(window, id);
};
const release = () => {
  holding = false;
  if (!held.size) return;
  const waiting = [...held.values()];
  held.clear();
  realRequest.call(window, (t) => {
    for (const cb of waiting) {
      try {
        cb(t);
      } catch (err) {
        // (as the browser would: reported, and the others still run)
        setTimeout(() => {
          throw err;
        });
      }
    }
  });
};
window.requestAnimationFrame = request;
window.cancelAnimationFrame = cancel;
unloads.add(() => {
  release();
  if (window.requestAnimationFrame === request) window.requestAnimationFrame = realRequest;
  if (window.cancelAnimationFrame === cancel) window.cancelAnimationFrame = realCancel;
});

// ------------------ CSS ANIMATIONS ------------------
const ATTR = "data-optimizer-paused";
const style = document.createElement("style");
style.textContent = `html[${ATTR}] *, html[${ATTR}] *::before, html[${ATTR}] *::after { animation-play-state: paused !important; }`;
document.head.appendChild(style);
unloads.add(() => {
  document.documentElement.removeAttribute(ATTR);
  style.remove();
});

// ------------------ ANIMATIONS MADE IN SCRIPT ------------------
// The endless ones (a loop made with element.animate) are paused too. One that ends is left to run: it
// is usually in step with something (TIDAL's progress bar runs for as long as the song does), and
// pausing it would leave it behind.
const loops = new Set<Animation>();
const pauseLoops = () => {
  for (const a of document.getAnimations()) {
    if (a.playState !== "running" || loops.has(a)) continue;
    const timing = a.effect?.getComputedTiming();
    if (timing?.iterations !== Infinity) continue;
    try {
      a.pause();
      loops.add(a);
    } catch {}
  }
};
const resumeLoops = () => {
  for (const a of loops) {
    try {
      if (a.playState === "paused") a.play();
    } catch {}
  }
  loops.clear();
};
unloads.add(resumeLoops);

// ------------------ VIDEOS ------------------
// Only the ones nobody hears: a video with sound is something being listened to
const paused = new Set<HTMLVideoElement>();
const silent = (v: HTMLVideoElement) => v.muted || v.volume === 0;
const pauseVideo = (v: HTMLVideoElement) => {
  if (v.paused || !silent(v)) return;
  paused.add(v);
  status.videosPaused++;
  v.pause();
};
const onPlay = (e: Event) => {
  // (one that starts while the window is out of sight)
  if (videosOff && e.target instanceof HTMLVideoElement) pauseVideo(e.target);
};
let videosOff = false;
document.addEventListener("play", onPlay, true);
const resumeVideos = () => {
  videosOff = false;
  for (const v of paused) if (v.isConnected && v.paused) v.play().catch(() => {});
  paused.clear();
};
unloads.add(() => {
  document.removeEventListener("play", onPlay, true);
  resumeVideos();
});

// ------------------ WHAT THE PAGE SAYS ------------------
let saysHidden = false;
const say = (hidden: boolean) => {
  if (hidden === saysHidden) return;
  saysHidden = hidden;
  if (hidden) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  } else {
    // (back to the browser's own)
    delete (document as any).hidden;
    delete (document as any).visibilityState;
  }
  document.dispatchEvent(new Event("visibilitychange"));
};
unloads.add(() => say(false));

// ------------------ FOR OTHER PLUGINS ------------------
type Listener = (visible: boolean) => void;
const listeners = new Set<Listener>();
const api = {
  /** TIDAL's window can be seen */
  get visible() {
    return !applied;
  },
  /** Called whenever that changes. Returns a function that stops it */
  onChange(cb: Listener) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
};
(window as any).lunaOptimizer = api;
unloads.add(() => {
  if ((window as any).lunaOptimizer === api) delete (window as any).lunaOptimizer;
});

// ------------------ OUT OF SIGHT, AND BACK ------------------
let applied = false;
let sweep: ReturnType<typeof setInterval> | undefined;
const apply = (hide: boolean) => {
  if (hide === applied) return;
  applied = hide;
  if (hide) {
    status.pauses++;
    status.pausedSince = Date.now();
    if (settings.pageVisibility) say(true);
    if (settings.frames) holding = true;
    if (settings.css) {
      document.documentElement.setAttribute(ATTR, "");
      pauseLoops();
      // (and those that start while the window is out of sight)
      sweep = setInterval(pauseLoops, 10000);
    }
    if (settings.videos) {
      videosOff = true;
      document.querySelectorAll("video").forEach(pauseVideo);
    }
  } else {
    status.pausedMs += Date.now() - status.pausedSince;
    status.pausedSince = 0;
    clearInterval(sweep);
    document.documentElement.removeAttribute(ATTR);
    resumeLoops();
    resumeVideos();
    say(false);
    release();
  }
  for (const cb of listeners) {
    try {
      cb(!hide);
    } catch (err) {
      trace.err.withContext("a listener")(err);
    }
  }
  window.dispatchEvent(new CustomEvent("optimizer:visibility", { detail: { visible: !hide } }));
  statusChanged();
};

let alive = true;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
const seen = (visible: boolean) => {
  status.visible = visible;
  clearTimeout(settleTimer);
  if (visible) apply(false);
  else settleTimer = setTimeout(() => alive && apply(true), SETTLE_MS);
  statusChanged();
};
unloads.add(() => {
  alive = false;
  clearTimeout(settleTimer);
  apply(false);
  stopWatching().catch(() => {});
});

(async () => {
  try {
    const first = await startWatching();
    status.covered = first.covered;
    seen(first.visible);
    trace.log(`Watching TIDAL's window (${first.covered ? "minimised or covered" : "minimised only: being covered can't be told here"})`);
    let known = first.visible;
    while (alive) {
      const now = await visibilityAfter(known);
      if (!alive) break;
      if (now === null) {
        // (the watch was lost, by a reload of the native side for one: started again after a moment)
        await new Promise((r) => setTimeout(r, 3000));
        if (!alive) break;
        known = (await startWatching()).visible;
        seen(known);
      } else if (now !== known) {
        known = now;
        seen(known);
      }
    }
  } catch (err) {
    status.problem = String((err as Error)?.message ?? err);
    statusChanged();
    trace.err.withContext("watching the window")(err);
  }
})();
