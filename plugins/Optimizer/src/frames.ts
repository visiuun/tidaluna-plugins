// Animation frames: what nearly every animation, visualiser and effect made in script draws with.
//
//   - While TIDAL can't be seen they are held: what was asked to be drawn waits, and is drawn once when
//     the window is back.
//   - While it can be seen there are no more of them than asked for. A script that draws "every frame"
//     draws as often as the screen shows one: 60 times a second on most screens, 144, 180 or 240 on a
//     fast one, and every one of them is the whole way through the page (styles, painting, the graphics
//     card). TIDAL's page with a moving background was measured at 171 of those a second on a 180 Hz
//     screen, more than a whole processor core between the page and the graphics process. With a limit
//     of 60 the scripts are given every third frame of that screen. Scrolling and the pointer are the
//     browser's own business and stay as fast as the screen.
import { settings, status } from "./state";

type Callback = FrameRequestCallback;
const realRequest = window.requestAnimationFrame;
const realCancel = window.cancelAnimationFrame;

/** Asked for while out of sight */
const held = new Map<number, Callback>();
/** Asked for in sight with a limit on, or let go after being held: run by the pump, on the frames that are their turn */
let queued = new Map<number, Callback>();
/** The ones being run right now (one of them may cancel another) */
let running: Map<number, Callback> | undefined;
// (ids below zero: the browser's own are above it)
let nextId = -1;
let holding = false;
let removed = false;

// ------------------ THE SCREEN'S RATE ------------------
// Asked of the system where that can be done (see setScreenRate). Otherwise learned from the frames
// themselves: the time between two in a row, over a quarter of a second of them. The shortest times
// count, not the usual ones: a page that is busy misses frames, and one that missed every other frame
// while it was being measured looked like a 90 Hz screen.
const gaps: number[] = [];
let lastFrame = 0;
/** Milliseconds between two frames of the screen (0: not known yet) */
let period = 0;
/** The system has said what the screen's rate is: nothing to learn */
let told = false;
const learn = (now: number) => {
  const gap = now - lastFrame;
  lastFrame = now;
  // (longer than this and the two weren't in a row)
  if (!(gap > 1) || gap > 50) return;
  gaps.push(gap);
  if (gaps.length < 24) return;
  const sorted = gaps.splice(0).sort((a, b) => a - b);
  if (told) return;
  period = sorted[sorted.length >> 3];
  status.screenRate = Math.round(1000 / period);
};
/** The rate of the screen TIDAL's window is on, as the system gives it (0 or nothing: not known, it is measured instead) */
export const setScreenRate = (hz: number | undefined | null) => {
  told = Number(hz) >= 20 && Number(hz) <= 1000;
  if (!told) return;
  period = 1000 / Number(hz);
  status.screenRate = Math.round(Number(hz));
};
/** Frames a second the screen shows (0: not known yet) */
export const screenRate = () => (period ? 1000 / period : 0);
let measuring = false;
/** Looks at a quarter of a second of frames to learn the screen's rate: at the start, when the window is back (it may be on another screen by then), and now and then */
export const measureScreen = () => {
  if (measuring || removed || told) return;
  measuring = true;
  let left = 40;
  const tick = (now: number) => {
    learn(now);
    if (--left > 0 && !removed) realRequest.call(window, tick);
    else measuring = false;
  };
  realRequest.call(window, tick);
};
/** Scripts get every how-manyth frame of the screen: a whole number, so that what they draw stays evenly spaced (a 144 Hz screen and a limit of 60: every second one, 72 a second) */
const share = () => {
  const limit = settings.frameLimit;
  if (!(limit > 0) || !period) return 1;
  return Math.max(1, Math.round(1000 / period / limit));
};
/** Frames a second scripts are given right now (0: the screen's rate isn't known yet) */
export const scriptRate = () => (period ? 1000 / period / share() : 0);
/**
 * The beat: milliseconds between two frames scripts are given, or 0 while every frame of the screen is
 * theirs (no limit, a screen no faster than the limit, or its rate not known yet). Everything that is
 * held back is held to this one beat, counted from the page's time zero: script frames, and the steps
 * of animations (see animations.ts). Two things that each change sixty times a second, but at different
 * moments, make the page redraw a hundred and twenty times.
 */
export const beat = () => {
  const every = share();
  return every > 1 ? every * period : 0;
};

// ------------------ THE PUMP ------------------
// Runs what was asked for on the frames that are the scripts' turn. The frames in between are not asked
// of the browser at all: a frame that is asked for is a whole turn of the page (styles, layout, painting,
// handing over to the graphics process) even when no script draws in it. So the next frame is asked for
// only when its turn has nearly come, with a timer in between.
let pumping = false;
let waiting: ReturnType<typeof setTimeout> | undefined;
/** When the scripts last had a frame (the frame's own time) */
let lastRun = 0;
const run = (cb: Callback, now: number) => {
  try {
    cb(now);
  } catch (err) {
    // (as the browser would: reported, and the others still run)
    setTimeout(() => {
      throw err;
    });
  }
};
const ask = () => {
  waiting = undefined;
  realRequest.call(window, pump);
};
/** Asks for the frame that is the scripts' next turn */
const next = () => {
  const every = share();
  const now = performance.now();
  // (no limit; or nothing has been drawn for a while, and where the screen's frames fall is no longer known: the next one, then)
  if (every <= 1 || now - lastRun > 250) return ask();
  // The frame wanted is the first of the screen's at or after the next beat. The screen's frames come one
  // period apart, counted from the last one seen. A frame that is asked for arrives with the screen's
  // next one, so it is asked for half a period before the one wanted.
  const T = every * period;
  const due = (Math.floor(lastRun / T) + 1) * T;
  const frames = Math.max(1, Math.ceil((due - lastRun) / period - 0.001));
  const wait = lastRun + (frames - 0.5) * period - now;
  if (wait <= 1) ask();
  else waiting = setTimeout(ask, wait);
};
const pump = (now: number) => {
  const every = share();
  if (every > 1 && now - lastRun < every * period * 1.5) status.framesSpared += Math.max(0, Math.round((now - lastRun) / period) - 1);
  lastRun = now;
  running = queued;
  queued = new Map();
  for (const cb of running.values()) run(cb, now);
  running = undefined;
  if (queued.size) next();
  else pumping = false;
};
const start = () => {
  if (pumping) return;
  pumping = true;
  next();
};

const request = (cb: Callback): number => {
  if (removed) return realRequest.call(window, cb);
  if (holding) {
    const id = nextId--;
    held.set(id, cb);
    status.framesHeld++;
    return id;
  }
  if (!(settings.frameLimit > 0)) return realRequest.call(window, cb);
  const id = nextId--;
  queued.set(id, cb);
  start();
  return id;
};
const cancel = (id: number) => {
  if (id >= 0) return realCancel.call(window, id);
  if (!held.delete(id) && !queued.delete(id)) running?.delete(id);
};

/** Out of sight: frames asked for from now on wait */
export const holdFrames = () => (holding = true);
/** In sight again: what waited is drawn, once */
export const releaseFrames = () => {
  holding = false;
  if (!held.size) return;
  for (const [id, cb] of held) queued.set(id, cb);
  held.clear();
  start();
};

export const installFrames = () => {
  window.requestAnimationFrame = request;
  window.cancelAnimationFrame = cancel;
  measureScreen();
  const again = setInterval(() => !holding && measureScreen(), 60000);
  return () => {
    removed = true;
    holding = false;
    clearInterval(again);
    clearTimeout(waiting);
    // (whatever still waits is handed to the browser as it is)
    for (const cb of [...held.values(), ...queued.values()]) realRequest.call(window, cb);
    held.clear();
    queued.clear();
    if (window.requestAnimationFrame === request) window.requestAnimationFrame = realRequest;
    if (window.cancelAnimationFrame === cancel) window.cancelAnimationFrame = realCancel;
  };
};
