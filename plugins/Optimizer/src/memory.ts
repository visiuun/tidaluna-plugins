// The memory guard, and cleaning up.
//
// TIDAL is a 32-bit program: its page can hold about 2 GB before its process is ended, and its scripts
// about 1.1 GB of that. With a lot of plugins and a long evening the page gets there, and then it is
// gone: "Something went wrong", and the music with it. TIDAL's own answer is to reload the page past
// 1500 MB, but only once nothing has played and nobody has touched the window for five minutes, which
// is never while you are listening.
//
// So the page is watched from outside (see guard.native.ts), and as it fills up:
//   - at three quarters of the limit its garbage is collected, which the page puts off by itself
//   - past the limit, if cleaning didn't help, it is reloaded: at once if it is about to die or nobody
//     is looking, otherwise when you have left it alone for two minutes. What was playing comes back
//     (see recover.ts), and with the DJ plugin the music doesn't stop at all.
// The same cleaning is done when TIDAL has been out of sight for a minute, where nobody sees the pause.
import { cleanDisk, cleanMemory, diskUsage, heapUsage, musicCarries, reloadPage, sample } from "./guard.native";
import { note, settings, status, statusChanged } from "./state";

const CHECK_MS = 15000;
/** Cleaning again sooner than this finds nothing new */
const CLEAN_GAP = 5 * 60000;
/** ...except past the limit, where it is the last thing to try before a reload */
const RECLEAN_GAP = 45000;
const HIDDEN_AFTER = 60000;
const HIDDEN_GAP = 10 * 60000;
/** Not twice within this: a page that is full again straight after a reload is not helped by another */
const RELOAD_GAP = 10 * 60000;
const IDLE_MS = 2 * 60000;
/** How far past the limit the page is reloaded whatever you are doing */
const URGENT = 1.15;
const CLEAN_AT = 0.75;

let unloaded = false;
let notify: (msg: string) => void = () => {};
let log: (msg: string) => void = () => {};
const loadedAt = Date.now();
let lastClean = 0;
let lastTouch = Date.now();
let warned = 0;

// The script memory's own ceiling (see heapUsage): nine tenths of it is as far as it should get
const heapCeiling = () => {
  const limit = Number((performance as any).memory?.jsHeapSizeLimit) || 0;
  return limit ? Math.round(limit / 1048576) : 0;
};

/** Collects the page's garbage now. `why`: for the record */
export const clean = async (why: string) => {
  lastClean = Date.now();
  const r = await cleanMemory();
  status.cleaned = { at: Date.now(), before: r.before, after: r.after, why };
  log(`Memory cleaned (${why}): ${r.before} MB before, ${r.after} MB after`);
  statusChanged();
  return r;
};

/** Looks at TIDAL's processes, and does what the guard is there for */
export const check = async () => {
  if (unloaded) return;
  try {
    const s = await sample();
    status.sample = s;
    status.guardProblem = "";
    status.heapLimit = heapCeiling();
    const limit = Math.max(600, settings.guardLimit || 1500);
    let level = s.page / limit;
    // (the script memory is only asked for when the page is filling up: it means attaching to the page)
    if (settings.guard && status.heapLimit && (level >= 0.5 || !status.heap)) {
      status.heap = await heapUsage().catch(() => status.heap);
      level = Math.max(level, status.heap / (status.heapLimit * 0.9));
    }
    status.level = level;
    if (!settings.guard) {
      status.guard = "";
      return;
    }
    // (past the limit it is cleaned again sooner: the page is never reloaded without that having just been tried)
    if (level >= CLEAN_AT && Date.now() - lastClean > (level >= 1 ? RECLEAN_GAP : CLEAN_GAP)) {
      const r = await clean("the page was filling up").catch(() => undefined);
      if (r) {
        status.heap = await heapUsage().catch(() => status.heap);
        level = Math.max(r.after / limit, status.heapLimit ? status.heap / (status.heapLimit * 0.9) : 0);
        status.level = level;
        if (r.before - r.after >= 50) note(`Memory guard: TIDAL's page was at ${r.before} MB, cleaned down to ${r.after} MB`);
      }
    }
    if (level < 1) {
      status.guard = level >= CLEAN_AT ? "The page is getting full: it is cleaned as it grows" : "";
      return;
    }
    // Past the limit, and cleaning didn't bring it back under
    if (Date.now() - lastClean > RECLEAN_GAP + CHECK_MS) return;
    const full = `TIDAL's page is using ${s.page} MB${status.heap ? ` (${status.heap} MB of it scripts)` : ""}`;
    const recently = Date.now() - (settings.lastReload || 0) < RELOAD_GAP || Date.now() - loadedAt < 120000;
    if (!settings.guardReload || recently) {
      status.guard = `${full}, more than it can hold for long: it may stop. ${recently && settings.guardReload ? "It has only just been loaded, so it isn't reloaded again yet" : "Reloading it (Ctrl+R) empties it"}`;
      if (Date.now() - warned > 30 * 60000) {
        warned = Date.now();
        notify(`Optimizer: ${full} and may stop. Reloading it (Ctrl+R) empties it`);
      }
      return;
    }
    const idle = Date.now() - lastTouch > IDLE_MS;
    if (level < URGENT && status.visible && !idle) {
      status.guard = `${full}: it will be reloaded as soon as you leave it alone for a couple of minutes or it is out of sight`;
      if (Date.now() - warned > 30 * 60000) {
        warned = Date.now();
        notify(`Optimizer: ${full}. It will be reloaded when you look away, before it stops by itself`);
      }
      return;
    }
    const carries = await musicCarries().catch(() => false);
    settings.lastReload = Date.now();
    note(`Memory guard: TIDAL's page was at ${s.page} MB and cleaning didn't help, so it was reloaded before it stopped by itself${carries ? " (the music played on)" : ""}`);
    log(`Reloading the page: ${full}, level ${level.toFixed(2)}`);
    notify(`Optimizer: reloading TIDAL's page (${s.page} MB)${carries ? ": the music plays on" : ""}`);
    // (a moment for that to be written down)
    await new Promise((r) => setTimeout(r, 400));
    await reloadPage(`it held ${s.page} MB`);
  } catch (err) {
    status.guardProblem = String((err as Error)?.message ?? err);
  } finally {
    statusChanged();
  }
};

// ------------------ OUT OF SIGHT ------------------
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
/** Told when TIDAL's window goes out of sight and comes back (see index.ts) */
export const seenChanged = (hidden: boolean) => {
  clearTimeout(hiddenTimer);
  if (!hidden || unloaded) return;
  hiddenTimer = setTimeout(() => {
    if (unloaded || !settings.cleanHidden || Date.now() - lastClean < HIDDEN_GAP) return;
    clean("TIDAL was out of sight").catch(() => {});
  }, HIDDEN_AFTER);
};

// ------------------ DISK ------------------
export const checkDisk = async () => {
  if (unloaded) return;
  try {
    status.disk = await diskUsage();
    if (settings.cacheLimit > 0 && status.disk.cache > settings.cacheLimit) {
      const freed = await cleanDisk();
      note(`TIDAL's cache on disk had grown to ${status.disk.cache} MB: cleared (${freed} MB freed)`);
      status.disk = await diskUsage();
    }
  } catch (err) {
    status.guardProblem = String((err as Error)?.message ?? err);
  }
  statusChanged();
};
/** Clears the cache and old crash dumps now. Returns MB freed */
export const clearDisk = async () => {
  const freed = await cleanDisk();
  status.disk = await diskUsage().catch(() => status.disk);
  note(`Cache on disk cleared by hand: ${freed} MB freed`);
  return freed;
};

// ------------------ START / STOP ------------------
export const startGuard = (opts: { notify: (msg: string) => void; log: (msg: string) => void }) => {
  notify = opts.notify;
  log = opts.log;
  const touched = () => (lastTouch = Date.now());
  const events = ["pointerdown", "keydown", "wheel"] as const;
  for (const e of events) window.addEventListener(e, touched, { capture: true, passive: true });
  const first = setTimeout(check, 4000);
  const timer = setInterval(check, CHECK_MS);
  const disk = setTimeout(checkDisk, 30000);
  const diskTimer = setInterval(checkDisk, 6 * 3600e3);
  return () => {
    unloaded = true;
    for (const e of events) window.removeEventListener(e, touched, { capture: true });
    clearTimeout(first);
    clearInterval(timer);
    clearTimeout(disk);
    clearInterval(diskTimer);
    clearTimeout(hiddenTimer);
  };
};
