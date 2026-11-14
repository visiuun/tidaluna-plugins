// Scripts: which of them the page spends its time in, and (if asked) slower timers while nobody is looking.
import { profile } from "./guard.native";
import { settings, status } from "./state";

// ------------------ WHO IS USING THE PROCESSOR ------------------
export type Usage = {
  /** Seconds measured */
  seconds: number;
  /** Share of one processor core the page's scripts used in all, 0-1 */
  busy: number;
  /** ...of which collecting garbage */
  gc: number;
  rows: { name: string; ms: number; share: number }[];
};

// Luna loads a plugin's code from a blob, which is all a profile knows of it. The code ends with a line
// naming where it came from (Luna adds it), and the blob is still there to read the end of.
const named = new Map<string, string>();
const pluginOf = async (blob: string): Promise<string> => {
  const known = named.get(blob);
  if (known) return known;
  let name = "A plugin (unnamed)";
  try {
    const tail = await (await (await fetch(blob)).blob()).slice(-600).text();
    const url = tail.match(/sourceURL=(\S+?)\.mjs\s*$/)?.[1];
    if (url) {
      const plugins = (window as any).luna?.core?.LunaPlugin?.plugins ?? {};
      name = plugins[url]?.name ?? url.split("/").pop() ?? url;
    }
  } catch {}
  named.set(blob, name);
  return name;
};
const nameOf = async (url: string): Promise<string> => {
  if (url.startsWith("blob:")) return pluginOf(url);
  if (url.startsWith("https://luna/")) return "Luna itself";
  if (url.startsWith("/assets/") || /^https:\/\/(desktop|listen)\.tidal\.com\//.test(url)) return "TIDAL";
  if (url.startsWith("wasm:")) return "WebAssembly (of a plugin)";
  if (url.startsWith("node:") || /app\.asar|original\.asar/.test(url)) return "TIDAL's own glue";
  return url.length > 60 ? `${url.slice(0, 57)}…` : url;
};

/** Measures for `seconds` where the page's processor time goes: TIDAL, Luna, and every plugin by name */
export const measure = async (seconds = 10): Promise<Usage> => {
  const p = await profile(seconds);
  const sums = new Map<string, number>();
  for (const r of p.rows) {
    const name = await nameOf(r.url);
    sums.set(name, (sums.get(name) ?? 0) + r.ms);
  }
  const total = Math.max(1, p.ms);
  const rows = [...sums.entries()]
    .map(([name, ms]) => ({ name, ms: Math.round(ms), share: ms / total }))
    .filter((r) => r.ms >= 1)
    .sort((a, b) => b.ms - a.ms);
  return { seconds: total / 1000, busy: Math.max(0, total - p.idle) / total, gc: p.gc / total, rows };
};

// ------------------ SLOWER TIMERS OUT OF SIGHT ------------------
// A timer that repeats many times a second is nearly always there to look at the page or to draw
// something: pointless while nobody can see it. A browser slows those down in a background tab; TIDAL
// has switched that off for its window (its own timers have to keep time), so here it is done to the
// fast ones only, and only if asked: one that repeats more often than four times a second runs once a
// second while TIDAL is out of sight. Timers that fire once are left alone, and so are those that were
// started before this was switched on.
//
// Off unless asked for, because a plugin can be doing something with such a timer that is heard: a
// crossfade that moves the volume twenty times a second would move it once a second instead.
const FAST_MS = 250;
const SLOW_MS = 1000;
let slowing = false;
export const setSlowing = (hidden: boolean) => (slowing = hidden && settings.slowTimers);

let restore: (() => void) | undefined;
export const installTimers = () => {
  if (restore || !settings.slowTimers) return;
  type Loose = (...args: any[]) => any;
  const real = window.setInterval as Loose;
  const patched: Loose = function (handler: unknown, timeout?: number, ...args: unknown[]) {
    if (typeof handler !== "function" || !(Number(timeout) < FAST_MS)) return real.call(window, handler, timeout, ...args);
    let last = 0;
    const run = function (this: unknown, ...a: unknown[]) {
      if (slowing) {
        const now = performance.now();
        if (now - last < SLOW_MS) return void status.timersSkipped++;
        last = now;
      }
      return (handler as Loose).apply(this, a);
    };
    return real.call(window, run, timeout, ...args);
  };
  (window as any).setInterval = patched;
  restore = () => {
    slowing = false;
    if ((window as any).setInterval === patched) (window as any).setInterval = real;
    restore = undefined;
  };
};
export const removeTimers = () => restore?.();
