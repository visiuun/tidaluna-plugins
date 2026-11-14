// Animations that run by themselves: CSS ones, and those made with element.animate.
//
// The browser moves such an animation on every frame the screen shows, and each time something on the
// page has moved, the whole window is put together again by the graphics process. TIDAL's progress bar
// is one: it runs for as long as the song does and moves about two pixels a second, and for that the
// window was redrawn 180 times a second on a 180 Hz screen, all song long, visible or not. Measured, with
// nothing else moving: the graphics process at 46% of a processor core, 8% once the bar moved in steps.
//
// So an animation is given steps: its time is cut into slots, and it only moves from one slot to the
// next. Nothing about it changes otherwise (its length, its keyframes and their easing, who started
// it), and it goes back to what it was when the Optimizer is switched off.
//   - one that only slides something along (the progress bar and its knob) gets two steps for every
//     pixel it travels: it looks exactly as before
//   - any other one (spinners, turning covers, colours that flow, a lyric line fading in) steps on the
//     beat scripts draw on (see frames.ts): on a 60 Hz screen nothing changes,
//     on a faster one it moves 60 times a second instead of 180. And all of them step at the same
//     moment: each is moved by a few thousandths of a second so that its steps fall on the beat. Left
//     where they were, six animations stepping sixty times a second each still had the page redraw 170
//     times a second, each one at its own moment.
// Left alone: one whose pace over its whole length somebody has set in script (then it isn't "linear",
// and stepping it would undo that; the easing CSS gives an animation or a transition is kept, it is a
// different thing), and one that follows scrolling rather than time.
import { beat } from "./frames";
import { settings, status } from "./state";

/** An animation that slides something along and takes longer than this is slow enough to be given fewer steps than the beat */
const SLOW_MS = 3000;
const SWEEP_MS = 5000;

type Tuned = { easing: string; duration: number; limit: number; /** The beat it steps on, ms (0: it has its own pace, as a slide does) */ beat: number };
// The animations that have been given steps, held on to: the browser hands out a new object for the same
// animation once nobody holds the old one, and one that isn't recognised can't be put back (it was left
// in steps for good). Those that are over or whose element is gone are let go of at every look.
const tuned = new Map<Animation, Tuned>();
/** Only while the plugin is on: what is still asked for as it is being switched off (the window "showing again", for one) must not step anything, there would be nobody left to put it back */
let on = false;

const SLIDE = /^\s*(?:translate(?:X|Y|3d)?\([^()]*\)\s*)+$/;
const SKIP = new Set(["offset", "computedOffset", "easing", "composite"]);
/**
 * How far, in screen pixels at most, an animation moves its element if all it does is slide it (0: it
 * does something else). Not farther than its own box or the one it is in, or than the distances written
 * in its keyframes.
 */
const slideOf = (effect: KeyframeEffect): number => {
  const frames = effect.getKeyframes();
  if (!frames.length) return 0;
  let low = Infinity;
  let high = -Infinity;
  let slides = false;
  for (const frame of frames) {
    for (const key of Object.keys(frame)) {
      if (SKIP.has(key)) continue;
      const value = String((frame as Record<string, unknown>)[key]);
      if (key !== "transform" || !SLIDE.test(value)) return 0;
      slides = true;
      for (const m of value.matchAll(/(-?[\d.]+)px/g)) {
        const n = Number(m[1]);
        low = Math.min(low, n);
        high = Math.max(high, n);
      }
    }
  }
  // (keyframes that name nothing that is known here: not a slide)
  const el = effect.target;
  if (!slides || !el) return 0;
  const own = el.getBoundingClientRect();
  const around = el.parentElement?.getBoundingClientRect();
  const far = Math.max(own.width, own.height, around?.width ?? 0, around?.height ?? 0, high > low ? high - low : 0, 100);
  return far * (window.devicePixelRatio || 1);
};

const restoreOne = (a: Animation) => {
  const known = tuned.get(a);
  if (!known) return;
  tuned.delete(a);
  try {
    // (only if it is still as it was left: somebody may have set it since)
    if (a.effect?.getTiming().easing === known.easing) a.effect.updateTiming({ easing: "linear" });
  } catch {}
};

const tune = (a: Animation) => {
  try {
    const limit = settings.frameLimit;
    const effect = a.effect;
    if (!on || !(limit > 0) || !(effect instanceof KeyframeEffect) || !(a.timeline instanceof DocumentTimeline)) return;
    if (a.playState !== "running" && a.playState !== "paused") return;
    const timing = effect.getTiming();
    const known = tuned.get(a);
    if (known) {
      // (somebody else has set its pace since: it is theirs)
      if (timing.easing !== known.easing) return void tuned.delete(a);
    } else if (timing.easing !== "linear") return;
    const duration = Number(effect.getComputedTiming().duration);
    if (!(duration > 0) || !Number.isFinite(duration)) return;
    const T = beat();
    if (known && known.duration === duration && known.limit === limit && (!known.beat || known.beat === T)) return known.beat ? onBeat(a, known.beat) : undefined;
    const runs = Number(timing.iterations ?? 1);
    let steps: number;
    // (a slide is only looked for in what lasts: measuring an element is not worth it for a menu that fades)
    const travel = runs === Infinity || duration * runs < SLOW_MS ? 0 : slideOf(effect);
    if (travel) steps = (duration / 1000) * Math.min(limit, Math.max(2, Math.ceil((travel * 2) / (duration / 1000))));
    // (nothing to gain where every frame of the screen is the scripts' anyway, or while its rate isn't known)
    else if (!T) return known ? restoreOne(a) : undefined;
    else steps = duration / T;
    effect.updateTiming({ easing: `steps(${Math.max(1, Math.round(steps))}, end)` });
    // (read back: the browser writes it its own way)
    tuned.set(a, { easing: effect.getTiming().easing ?? "", duration, limit, beat: travel ? 0 : T });
    if (!known) status.animationsStepped++;
    if (!travel) onBeat(a, T);
  } catch {}
};

/**
 * Moves an animation by a few milliseconds so that its steps fall on the beat (counted from the page's
 * time zero, as the script frames are). Only one that is running at its normal pace: giving a paused one
 * a start time would start it, and take it out of its stylesheet's hands. One that hasn't started yet is
 * seen to once it has.
 */
const onBeat = (a: Animation, T: number) => {
  try {
    if (a.playState !== "running" || a.playbackRate !== 1) return;
    if (a.pending) return void a.ready.then(() => on && tuned.get(a)?.beat === T && onBeat(a, T)).catch(() => {});
    const start = a.startTime;
    if (typeof start !== "number") return;
    const first = start + (Number(a.effect?.getComputedTiming().delay) || 0);
    const off = ((first % T) + T) % T;
    const move = off > T / 2 ? T - off : -off;
    if (Math.abs(move) > 0.25) a.startTime = start + move;
  } catch {}
};

/** Every animation on the page: stepped where that applies, and those that have gone forgotten */
export const tuneAll = () => {
  if (!on) return;
  if (!(settings.frameLimit > 0)) return restoreAll();
  try {
    for (const a of document.getAnimations()) tune(a);
  } catch {}
  forget();
};
/** Lets go of the ones that are over, or whose element is no longer on the page */
const forget = () => {
  for (const a of tuned.keys()) {
    try {
      const el = (a.effect as KeyframeEffect | null)?.target;
      if (a.playState === "idle" || a.playState === "finished" || !el?.isConnected) tuned.delete(a);
    } catch {
      tuned.delete(a);
    }
  }
};
const restoreAll = () => {
  for (const a of [...tuned.keys()]) restoreOne(a);
  tuned.clear();
};

/** Starts stepping animations as they are made. Returns what stops it and puts them back */
export const installAnimations = () => {
  on = true;
  // Made in script: seen as they are made (a moment later, when whoever made it has finished setting it up)
  const proto = Element.prototype;
  const real = proto.animate;
  const patched: typeof real = function (this: Element, ...args: Parameters<typeof real>) {
    const a = real.apply(this, args);
    setTimeout(tune, 0, a);
    return a;
  };
  proto.animate = patched;
  // CSS ones, and transitions: when they start (a line of lyrics starts a dozen at once: looked at together, a moment later)
  const started = new Set<Element>();
  const look = () => {
    const all = [...started];
    started.clear();
    for (const el of all) {
      try {
        if (el.isConnected) for (const a of el.getAnimations()) tune(a);
      } catch {}
    }
  };
  const onStart = (e: Event) => {
    const el = e.target;
    if (!on || !(el instanceof Element) || !(settings.frameLimit > 0)) return;
    if (!started.size) queueMicrotask(look);
    started.add(el);
  };
  document.addEventListener("animationstart", onStart, true);
  document.addEventListener("transitionrun", onStart, true);
  // ...and everything now and then: those that were already running, one whose length has changed, the screen's rate once known
  const first = setTimeout(tuneAll, 1500);
  const timer = setInterval(() => (document.hidden ? forget() : tuneAll()), SWEEP_MS);
  return () => {
    on = false;
    if (proto.animate === patched) proto.animate = real;
    document.removeEventListener("animationstart", onStart, true);
    document.removeEventListener("transitionrun", onStart, true);
    clearTimeout(first);
    clearInterval(timer);
    restoreAll();
  };
};
