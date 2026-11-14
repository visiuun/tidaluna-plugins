// Optimizer: keeps TIDAL light, and keeps it going.
//
// Besides what is below, which is this file's own business:
//   - a memory guard that cleans TIDAL's page as it fills up and reloads it before it dies, and memory
//     handed back to Windows while TIDAL is out of sight (memory.ts)
//   - what was playing put back on after the page died, froze or was reloaded (recover.ts)
//   - a measurement of which scripts the page spends its time in (scripts.ts)
//   - TIDAL's processes, their memory and what is on disk, on the settings page (Settings.tsx)
// The part of all that which has to happen outside the page is in guard.native.ts.
//
// Nothing is animated or drawn while nobody can see it.
//
// TIDAL keeps its window fully awake in the background (see watch.native.ts), so minimised, or behind a
// game, TIDAL and every plugin go on drawing every frame of every animation, visualiser and 3D cover.
// This plugin finds out when the window can't actually be seen and, for as long as that lasts:
//
//   - doesn't render the page at all: the browser skips its contents, and has everything where it was
//     when the window is back (TIDAL's progress bar alone kept the whole window being redrawn at the
//     screen's rate)
//   - holds animation frames: what was asked to be drawn waits, and is drawn once when the window is back
//   - pauses CSS animations, and endless animations made in script
//   - pauses decoration that is a video (animated covers and the like: muted, with no sound of its own), and plays it
//     again afterwards. Never TIDAL's own player
//   - has the page say it is hidden (document.hidden, "visibilitychange"), as it would in a browser:
//     TIDAL and any plugin that asks can then leave their own work undone
//
// Timers and the music are left alone: playback, scrobbling and anything that keeps time carry on.
//
// And while the window can be seen, nothing is drawn more often than it needs to be: scripts get no
// more frames a second than the frame limit (60), and animations that run by themselves move in steps
// (see frames.ts and animations.ts).
//
// Other plugins can go by it without depending on it: `document.hidden` and the "visibilitychange" event
// are the standard way, and `window.lunaOptimizer` ({ visible, onChange(cb) }) is there as well.
import { LunaUnload, Tracer } from "@luna/core";
import { installAnimations, tuneAll } from "./animations";
import { holdFrames, installFrames, measureScreen, releaseFrames, setScreenRate } from "./frames";
import { screenRate } from "./guard.native";
import { seenChanged, startGuard } from "./memory";
import { startRecovery } from "./recover";
import { installTimers, removeTimers, setSlowing } from "./scripts";
import { settings, status, statusChanged } from "./state";
import { startWatching, stopWatching, visibilityAfter } from "./watch.native";

export { Settings } from "./Settings";
// (what the settings page shows and does, for whoever wants to look or ask from outside it)
export { check, clean, checkDisk, trim } from "./memory";
export { measure } from "./scripts";
export { settings, status } from "./state";
export const { trace } = Tracer("[Optimizer]");
export const unloads = new Set<LunaUnload>();

/** How long the window has to be out of sight before anything is paused: passing behind another window for a moment is not worth it */
const SETTLE_MS = 1500;

// ------------------ ANIMATION FRAMES ------------------
// Held while out of sight, and no more of them than the frame limit while in sight (see frames.ts);
// animations that run by themselves are moved in steps (see animations.ts).
unloads.add(installFrames());
unloads.add(installAnimations());
/** The screen's rate, asked of the system: now, and when the window is back (it may be on another screen by then). Measured from the frames where it can't be asked */
const askScreen = () =>
  screenRate()
    .then((hz) => {
      setScreenRate(hz);
      if (!hz) measureScreen();
      tuneAll();
    })
    .catch(() => measureScreen());
askScreen();

// ------------------ NOT DRAWN AT ALL ------------------
// Holding frames and pausing animations was not the end of it. With all of that on, and TIDAL behind
// another window, the page was still at 42% of a processor core and the graphics process at 55%: the
// window was being put together and shown 180 times a second (the screen's rate), for nobody. What kept
// it going is an animation that is left to run because it keeps time: TIDAL's progress bar. And an
// animation that is running makes the browser redraw, whether or not anything can be seen.
//
// So while the window is out of sight the page's contents are not rendered at all: the browser is told
// to skip them (content-visibility), which it does without forgetting anything. The layout is still
// there to be asked about (a script that measures an element gets its answer), scrolling stays where it
// is, lyrics go on scrolling, animations keep their time and are where they should be when the window
// is back. Measured over the same seven seconds: the page at 5%, the graphics process at 1%.
const UNSEEN = "data-optimizer-unseen";
const unseenStyle = document.createElement("style");
unseenStyle.textContent = `html[${UNSEEN}] body { content-visibility: hidden !important; }`;
document.head.appendChild(unseenStyle);
unloads.add(() => {
  document.documentElement.removeAttribute(UNSEEN);
  unseenStyle.remove();
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
// Only decoration: animated covers and the like, which are muted and have no sound of their own.
//
// Never TIDAL's own player. That is a <video> too (in #tidal-player-root), and not only for videos:
// songs TIDAL plays through its web player are in it as well. With the DJ plugin on it plays at volume
// zero, since the DJ's mixer makes the sound, and pausing it pauses TIDAL, and the DJ, which follows
// TIDAL, with it: the music stopped whenever the window went out of sight during such a song. So volume
// zero doesn't count as "no sound" (muted does), anything that has an audio track is left alone, and so
// is everything in TIDAL's player.
const paused = new Set<HTMLVideoElement>();
const PLAYER = "#tidal-player-root, .tidal-player-root, [id^='tidal-player'], [class*='tidal-player']";
const decoration = (v: HTMLVideoElement) => v.muted && !(Number((v as any).webkitAudioDecodedByteCount) > 0) && v.id !== "video-one" && v.id !== "video-two" && !v.closest(PLAYER);
const pauseVideo = (v: HTMLVideoElement) => {
  if (v.paused || !decoration(v)) return;
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
  // (the memory guard cleans up while nobody is looking; fast timers run slower then, if that is asked for)
  seenChanged(hide);
  setSlowing(hide);
  if (hide) {
    status.pauses++;
    status.pausedSince = Date.now();
    if (settings.pageVisibility) say(true);
    if (settings.frames) holdFrames();
    if (settings.render) document.documentElement.setAttribute(UNSEEN, "");
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
    document.documentElement.removeAttribute(UNSEEN);
    document.documentElement.removeAttribute(ATTR);
    resumeLoops();
    resumeVideos();
    say(false);
    releaseFrames();
    // (the window may be on another screen by now; and what started while it was away is looked at)
    if (alive) askScreen();
    tuneAll();
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

// ------------------ MEMORY, RECOVERY, TIMERS ------------------
const said = { notify: (msg: string) => trace.msg.log(msg), log: (msg: string) => trace.log(msg) };
unloads.add(startGuard(said));
unloads.add(startRecovery(said));
installTimers();
unloads.add(removeTimers);

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
