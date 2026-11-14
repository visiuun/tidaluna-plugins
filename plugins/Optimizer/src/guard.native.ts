// Runs in the Electron main process: what the Optimizer does from outside TIDAL's page.
//
//   - reads how much memory and processor each of TIDAL's processes is using
//   - has TIDAL's page give back memory it no longer needs, hands what TIDAL isn't using back to
//     Windows, and clears caches on disk
//   - measures which scripts the page spends its time in
//   - notices when the page dies, hangs or is reloaded, and remembers what was playing, so that the page
//     that comes back can carry on from there (a page can't remember that itself: it is gone)
//
// TIDAL brings a page that died back by itself (a new window, after five seconds), and reloads one that
// passed 1500 MB, but only after five minutes of nothing playing and nobody at the window. What it
// doesn't do is keep the page from getting there, bring the music back, or act on a page that hangs.
import fs from "fs";
import path from "path";

// Through a variable so the build leaves it alone, and inside a try: TidaLunar may not hand out electron
const runtimeRequire = (id: string) => require(id);
const getElectron = (): any | null => {
  try {
    return runtimeRequire("electron");
  } catch {
    return null;
  }
};

const MB = 1048576;
const tidalWindow = (): any | undefined => {
  try {
    return getElectron()
      ?.BrowserWindow?.getAllWindows?.()
      .find((w: any) => !w.isDestroyed() && /tidal\.com/i.test(w.webContents.getURL()));
  } catch {
    return undefined;
  }
};
const tidalPage = (): any | undefined => tidalWindow()?.webContents;

// ------------------ WHAT OUTLIVES THE PAGE ------------------
// This file is run afresh whenever the plugin is loaded, which is also what happens after the page has
// died, and in a sandbox of its own (its `process` and its globals are not the real ones, and what it
// reads off a module is wrapped). What has to be known then is kept on Electron's `app` object, which
// is the same for every load, under a symbol (a property under a symbol is handed over as it is).
export type PlayNote = { id: string; position: number; duration: number; playing: boolean; at: number; /** TIDAL's volume slider (percent) and whether it is muted */ volume?: number; muted?: boolean };
export type Gone = {
  at: number;
  /** "reload", "hang" (it was frozen, and ended by the Optimizer), or what Chromium gave as the reason its process ended ("oom", "crashed", ...) */
  reason: string;
  /** MB the page held at the last look before it went */
  memory: number;
  /** What was playing, as last heard from the page */
  play?: PlayNote;
  /** The Optimizer itself asked for the reload, and why */
  asked?: string;
};
type Shelf = {
  play?: PlayNote;
  memory: number;
  /** The page went and the one that comes back hasn't asked yet */
  gone?: Gone;
  asked?: string;
  quitting?: boolean;
  watchingQuit?: boolean;
  unhook?: () => void;
  unfreeze: boolean;
  /** The page window whose line from TIDAL has been seen to (see mendLine) */
  mendedFor?: number;
  /** The check on a page that has stopped answering (see watchPage), and how many checks in a row it has missed */
  hang?: ReturnType<typeof setInterval>;
  missed: number;
};
const SHELF = Symbol.for("visiuun.optimizer.shelf");
const ownShelf: Shelf = { memory: 0, unfreeze: true, missed: 0 };
const shelf = (): Shelf => {
  const app = getElectron()?.app;
  if (!app) return ownShelf;
  return (app[SHELF] ??= { memory: 0, unfreeze: true, missed: 0 });
};
/** The DJ plugin's mixer plays on while the page is away and is picked up again by the DJ (see its mixer.native.ts): the music is then not for anyone else to bring back */
const djShelf = (): { live?: boolean; carriedAt?: number } => getElectron()?.app?.[Symbol.for("visiuun.dj.shelf")] ?? {};

// ------------------ PROCESSES ------------------
export type ProcessRow = {
  pid: number;
  what: string;
  /** MB that are its own */
  memory: number;
  /** MB it has in memory right now (what it holds but isn't touching, Windows may have put aside) */
  ram: number;
  /** % of one processor core */
  cpu: number;
  page?: boolean;
};
export type Sample = { rows: ProcessRow[]; page: number; total: number; ram: number; cpu: number };
const nameOf = (contents: any): string => {
  const url = String(contents.getURL?.() ?? "");
  if (/desktop\.tidal\.com|listen\.tidal\.com/.test(url)) return "TIDAL's page";
  if (url.startsWith("https://dj-mixer.invalid")) return "DJ: mixer";
  if (url.startsWith("https://dj-stems.invalid")) return "DJ: vocal separator";
  if (url.startsWith("https://3d-cover-engine.invalid")) return "3D Cover: depth engine";
  if (url.includes("optimizer-sentinel")) return "Optimizer: window watch";
  if (url.startsWith("devtools:")) return "Developer tools";
  const title = String(contents.getTitle?.() ?? "").trim();
  return title ? `Page: ${title.slice(0, 40)}` : "A plugin's page";
};
// Processor time each process had used at the last look, to tell how much it has used since. (Electron's
// own figure for "now" is a share of all the processor's cores together: on sixteen cores, a process
// that keeps one of them fully busy reads 6%. What is shown here is the share of one core.)
let usedBefore = new Map<number, number>();
let lookedAt = 0;
/**
 * Every process of TIDAL's: what it is, the memory that is its own (MB), how much it has in memory right
 * now, and how much of one processor core it has been using since the last look (%). `cores`: how many
 * the processor has, for the first look.
 */
export const sample = async (cores = 1): Promise<Sample> => {
  const electron = getElectron();
  if (!electron) throw new Error("Electron isn't available here");
  const pages = new Map<number, string>();
  let pagePid = -1;
  try {
    for (const c of electron.webContents.getAllWebContents()) {
      if (c.isDestroyed()) continue;
      const pid = c.getOSProcessId();
      const name = nameOf(c);
      // (several pages can share a process: the one that says most)
      if (!pages.has(pid) || name === "TIDAL's page") pages.set(pid, name);
      if (name === "TIDAL's page") pagePid = pid;
    }
  } catch {}
  const now = Date.now();
  const seconds = (now - lookedAt) / 1000;
  const used = new Map<number, number>();
  const rows: ProcessRow[] = [];
  for (const m of electron.app.getAppMetrics()) {
    const kb = m.memory?.privateBytes ?? m.memory?.workingSetSize ?? 0;
    const what =
      m.type === "Browser" ? "TIDAL itself" : m.type === "GPU" ? "Graphics" : m.type === "Tab" ? (pages.get(m.pid) ?? "A page") : m.name || m.serviceName || String(m.type);
    const total = Number(m.cpu?.cumulativeCPUUsage);
    const before = usedBefore.get(m.pid);
    let cpu = (m.cpu?.percentCPUUsage ?? 0) * Math.max(1, cores);
    if (Number.isFinite(total)) {
      used.set(m.pid, total);
      if (before !== undefined && seconds >= 1 && seconds < 120) cpu = (Math.max(0, total - before) / seconds) * 100;
    }
    rows.push({ pid: m.pid, what, memory: Math.round(kb / 1024), ram: Math.round((m.memory?.workingSetSize ?? 0) / 1024), cpu: Math.round(cpu * 10) / 10, page: m.pid === pagePid || undefined });
  }
  // (asked twice within a second: the figures of the look before stand)
  if (seconds >= 1) {
    usedBefore = used;
    lookedAt = now;
  }
  rows.sort((a, b) => b.memory - a.memory);
  const page = rows.find((r) => r.page)?.memory ?? 0;
  if (page) shelf().memory = page;
  return { rows, page, total: rows.reduce((s, r) => s + r.memory, 0), ram: rows.reduce((s, r) => s + r.ram, 0), cpu: Math.round(rows.reduce((s, r) => s + r.cpu, 0) * 10) / 10 };
};
/** What all of TIDAL's processes have in memory right now, MB (no processor figures: those are for the regular look) */
const inMemory = (): number => {
  try {
    let kb = 0;
    for (const m of getElectron().app.getAppMetrics()) kb += m.memory?.workingSetSize ?? 0;
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
};
const pageMemory = async (): Promise<number> => {
  try {
    const pid = tidalPage()?.getOSProcessId();
    for (const m of getElectron().app.getAppMetrics()) if (m.pid === pid) return Math.round((m.memory?.privateBytes ?? m.memory?.workingSetSize ?? 0) / 1024);
  } catch {}
  return 0;
};

/** How many frames a second the screen TIDAL's window is on shows (0: not known) */
export const screenRate = async (): Promise<number> => {
  try {
    const electron = getElectron();
    const win = tidalWindow();
    return Number(electron.screen.getDisplayMatching(win.getBounds()).displayFrequency) || 0;
  } catch {
    return 0;
  }
};

// ------------------ THE PAGE'S DEBUGGER ------------------
// Chromium's own tools for a page (collect garbage, give memory back, profile) are reached through its
// debugger. Only one thing can be attached at a time: one job after the other, and none while the
// developer tools are open on the page.
let jobs: Promise<unknown> = Promise.resolve();
type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
const withDebugger = <T>(fn: (send: Send, dbg: any) => Promise<T>): Promise<T> => {
  const job = jobs.then(async () => {
    const page = tidalPage();
    if (!page) throw new Error("TIDAL's page wasn't found");
    const dbg = page.debugger;
    if (dbg.isAttached()) throw new Error("something else is attached to the page (the developer tools?)");
    try {
      dbg.attach("1.3");
    } catch (err: any) {
      throw new Error(`the page's debugger couldn't be reached (${String(err?.message ?? err)}): are the developer tools open?`);
    }
    try {
      return await fn((method, params) => dbg.sendCommand(method, params), dbg);
    } finally {
      try {
        dbg.detach();
      } catch {}
    }
  });
  jobs = job.catch(() => {});
  return job;
};

// ------------------ MEMORY ------------------
export type Cleaned = { before: number; after: number };
/**
 * Has TIDAL's page give back what it no longer needs: its garbage is collected, in full (left to
 * itself the page puts that off for as long as it can), and twice, since what the first round lets go
 * of can free more. Nothing that is in use is touched. Returns the page's memory before and after, MB.
 *
 * (Chromium has stronger medicine, Memory.forciblyPurgeJavaScriptMemory: tried, and it leaves the page
 * unable to run any script at all. Not used.)
 */
export const cleanMemory = async (): Promise<Cleaned> => {
  const before = await pageMemory();
  await withDebugger(async (send) => {
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
  });
  // (the system takes a moment to count it)
  await new Promise((r) => setTimeout(r, 1200));
  return { before, after: await pageMemory() };
};

/**
 * How much of its script memory the page is using, MB. That has a ceiling of its own, well under what the
 * process may hold (about 1.1 GB in TIDAL, a 32-bit program), and running into it ends the page just the same.
 * (The page's own figure for this, performance.memory, is rounded and up to twenty minutes old.)
 */
export const heapUsage = async (): Promise<number> => {
  const r = await withDebugger((send) => send("Runtime.getHeapUsage"));
  return Math.round((r?.usedSize ?? 0) / MB);
};

// ------------------ BACK TO WINDOWS ------------------
// What a process holds and what it has in memory (RAM) are two things. A page that holds 900 MB has most
// of it lying in memory untouched: Windows only takes that out when memory runs short, and until then it
// counts against TIDAL in the Task Manager and is not there for anything else. Windows can be asked to
// take it out now: each process lets go of what it has in memory and takes back, as it goes along, only
// what it really uses. Nothing is lost or closed, and what is needed again is back in an instant.
// Tried on TIDAL out of sight: 3071 MB in memory before, 1068 MB two seconds later, 1368 MB after
// forty-five (the page was still being drawn then, which it no longer is).
//
// Never asked of what makes the sound: TIDAL itself (its player is in it), the audio service, the DJ's
// pages, any page that is playing. A stutter is not worth any amount of memory.
//
// There is no way to ask this from here, so a PowerShell line does it (it sets each process's
// working-set limits to what they already are, which makes Windows trim it).
//
// Luna asks whether this plugin may start programs, and it asks at the moment one is first started, with
// a box that stops all of TIDAL until it is answered. Version 1.2.0 started its first one a minute after
// TIDAL had gone out of sight: the box came up behind whatever was in front, with nobody there, and
// TIDAL and the music stood still until somebody found it. So the question is put on purpose (see
// canHandBack), only when you switch this on or while TIDAL's window is in front of you, and nothing is
// ever started that hasn't been allowed in this very run.
let childProcess: any | null | undefined;
/** Luna has let this plugin start programs (asked in this run: see canHandBack) */
let allowed = false;
const starter = (): any | null => {
  if (childProcess !== undefined) return childProcess;
  try {
    childProcess = runtimeRequire("child_process");
  } catch {
    childProcess = null;
  }
  return childProcess;
};
const onWindows = path.sep === "\\";
/**
 * Whether memory can be handed back here: "no" where it can't be done at all (not Windows), otherwise
 * what Luna says to this plugin starting programs. THIS IS WHERE LUNA ASKS (once for each version of the
 * plugin, if you allowed it; again every time if you didn't): only to be called when you are there.
 * Nothing is started by it: `spawn` is called with nothing to start, which Luna rules on before Node
 * turns it down.
 */
export const canHandBack = async (): Promise<"yes" | "refused" | "no"> => {
  const cp = onWindows && getElectron() ? starter() : null;
  if (!cp) return "no";
  if (allowed) return "yes";
  try {
    cp.spawn();
    return "no";
  } catch (err: any) {
    // (Luna's refusal says so; anything else is Node complaining that there was nothing to start, which means Luna let it through)
    if (/Security|Access Denied|blocked/i.test(String(err?.message ?? err))) return "refused";
    allowed = true;
    return "yes";
  }
};
export type HandedBack = { before: number; after: number; processes: number };
/**
 * Hands the memory TIDAL's processes aren't using back to Windows. Returns what all of TIDAL had in
 * memory before and after (MB), and how many processes were asked.
 */
export const handBack = async (): Promise<HandedBack> => {
  const electron = getElectron();
  const cp = onWindows ? starter() : null;
  if (!electron || !cp) throw new Error("not possible here");
  // (never the first start of a program: that is what Luna asks about, and it is asked only when you are there)
  if (!allowed) throw new Error("Luna hasn't been asked yet whether this plugin may start programs");
  const leave = new Set<number>();
  for (const c of electron.webContents.getAllWebContents()) {
    try {
      if (c.isDestroyed()) continue;
      if (c.isCurrentlyAudible() || /^https:\/\/dj-/.test(c.getURL())) leave.add(c.getOSProcessId());
    } catch {}
  }
  const pids: number[] = [];
  for (const m of electron.app.getAppMetrics()) {
    const pid = Number(m.pid);
    if (!Number.isInteger(pid) || pid <= 0 || leave.has(pid)) continue;
    if (m.type === "Browser" || /audio/i.test(`${m.name ?? ""} ${m.serviceName ?? ""}`)) continue;
    pids.push(pid);
  }
  const before = inMemory();
  if (pids.length) {
    const script = `foreach($i in ${pids.join(",")}){try{$p=[Diagnostics.Process]::GetProcessById($i);$p.MaxWorkingSet=$p.MaxWorkingSet}catch{}}`;
    const exe = path.join(String((process as any).env?.SystemRoot || "C:\\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await new Promise<void>((resolve, reject) => {
      let child: any;
      try {
        child = cp.spawn(exe, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore" });
      } catch (err) {
        return reject(err);
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve();
      }, 20000);
      child.on("error", (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  // (the system takes a moment to count it)
  await new Promise((r) => setTimeout(r, 1500));
  return { before, after: inMemory(), processes: pids.length };
};

// ------------------ DISK ------------------
const sizeOf = async (dir: string, olderThan = 0): Promise<{ bytes: number; files: string[] }> => {
  const out = { bytes: 0, files: [] as string[] };
  const walk = async (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) await walk(p, depth + 1);
        continue;
      }
      try {
        const st = await fs.promises.stat(p);
        if (olderThan && st.mtimeMs > olderThan) continue;
        out.bytes += st.size;
        out.files.push(p);
      } catch {}
    }
  };
  await walk(dir, 0);
  return out;
};
const dumpDirs = (): string[] => {
  const app = getElectron()?.app;
  const dirs: string[] = [];
  try {
    dirs.push(path.join(app.getPath("crashDumps"), "reports"));
  } catch {}
  try {
    dirs.push(path.join(app.getPath("userData"), "CrashDumps"));
  } catch {}
  return dirs;
};
const DUMP_AGE = 7 * 864e5;
export type Disk = { cache: number; dumps: number };
/** What can be cleared on disk, MB: the cache of what TIDAL has downloaded (covers, pages, scripts), and crash dumps older than a week */
export const diskUsage = async (): Promise<Disk> => {
  const page = tidalPage();
  if (!page) throw new Error("TIDAL's page wasn't found");
  const cache = await page.session.getCacheSize();
  let dumps = 0;
  for (const d of dumpDirs()) dumps += (await sizeOf(d, Date.now() - DUMP_AGE)).bytes;
  return { cache: Math.round(cache / MB), dumps: Math.round(dumps / MB) };
};
/**
 * Clears those. Nothing that is yours goes: not the login, not settings, not what plugins have stored;
 * what the cache held is downloaded again when it is next needed. Returns how much was freed, MB.
 */
export const cleanDisk = async (): Promise<number> => {
  const page = tidalPage();
  if (!page) throw new Error("TIDAL's page wasn't found");
  const before = await page.session.getCacheSize();
  await page.session.clearCache();
  let freed = Math.max(0, before - (await page.session.getCacheSize()));
  for (const d of dumpDirs()) {
    const old = await sizeOf(d, Date.now() - DUMP_AGE);
    for (const f of old.files) {
      if (!/\.(dmp|txt|log|meta)$/i.test(f)) continue;
      try {
        const st = await fs.promises.stat(f);
        await fs.promises.unlink(f);
        freed += st.size;
      } catch {}
    }
  }
  return Math.round(freed / MB);
};

// ------------------ SCRIPTS ------------------
export type ProfileRow = { url: string; ms: number };
export type Profile = { ms: number; idle: number; gc: number; system: number; rows: ProfileRow[] };
/**
 * Where TIDAL's page spends its time over `seconds`: for every script, how long the processor was in it
 * (a browser function it called counts as the script's: looking through the page, measuring an element).
 * Sampled a thousand times a second; costs next to nothing and changes nothing.
 */
export const profile = async (seconds: number): Promise<Profile> => {
  const length = Math.max(1, Math.min(30, seconds)) * 1000;
  const cpu = await withDebugger(async (send) => {
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 1000 });
    await send("Profiler.start");
    await new Promise((r) => setTimeout(r, length));
    const { profile } = await send("Profiler.stop");
    await send("Profiler.disable").catch(() => {});
    return profile as { nodes: { id: number; callFrame: { url: string; functionName: string }; children?: number[] }[]; samples: number[]; timeDeltas: number[] };
  });
  const byId = new Map(cpu.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of cpu.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  /** The script a sample belongs to: its own, or the nearest one up the calls that led to it */
  const owner = new Map<number, string>();
  const ownerOf = (id: number): string => {
    const known = owner.get(id);
    if (known !== undefined) return known;
    let at: number | undefined = id;
    let found = "";
    while (at !== undefined) {
      const n = byId.get(at);
      if (!n) break;
      const fn = n.callFrame.functionName;
      if (at === id && (fn === "(idle)" || fn === "(program)" || fn === "(garbage collector)")) {
        found = fn;
        break;
      }
      if (n.callFrame.url) {
        found = n.callFrame.url;
        break;
      }
      at = parent.get(at);
    }
    owner.set(id, found);
    return found;
  };
  const self = new Map<string, number>();
  let total = 0;
  cpu.samples.forEach((id, i) => {
    const dt = Math.max(0, cpu.timeDeltas[i] ?? 0) / 1000;
    total += dt;
    const key = ownerOf(id);
    self.set(key, (self.get(key) ?? 0) + dt);
  });
  const take = (key: string) => {
    const v = self.get(key) ?? 0;
    self.delete(key);
    return Math.round(v);
  };
  const idle = take("(idle)");
  const gc = take("(garbage collector)");
  const system = take("(program)") + take("");
  const rows = [...self.entries()]
    .map(([url, ms]) => ({ url, ms: Math.round(ms * 10) / 10 }))
    .filter((r) => r.ms >= 0.5)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 40);
  return { ms: Math.round(total), idle, gc, system, rows };
};

// ------------------ WHEN THE PAGE GOES ------------------
/** What is playing, as the page knows it: said every couple of seconds, so that it is known here when the page is gone */
export const notePlay = async (note: PlayNote | null) => {
  shelf().play = note ?? undefined;
};

/**
 * Stops TIDAL's player, the way TIDAL does before a reload of its own. The page that comes back starts
 * by turning the volume all the way up, and only then to where you have it: a player that is still
 * playing at that moment is heard at full volume for a second. (Sent the way the page sends it; TIDAL
 * only looks at where a message says it is from.)
 */
const stopPlayer = () => {
  try {
    getElectron()?.ipcMain?.emit("player.message", { senderFrame: { url: "https://desktop.tidal.com/" } }, JSON.stringify({ command: "media.stop" }));
  } catch {}
};

const went = (reason: string) => {
  const s = shelf();
  if (s.quitting) return;
  stopPlayer();
  // (a page that died is then also replaced, which is a navigation of its own: the first word stands)
  if (s.gone && Date.now() - s.gone.at < 15000) return;
  s.gone = { at: Date.now(), reason, memory: s.memory, play: s.play, asked: s.asked };
  s.asked = undefined;
};

const BEAT_MS = 5000;
const MISSES = 6;
/** The page saying it is alive (see watchPage): every few seconds, from a timer of its own */
export const beat = async () => {
  shelf().missed = 0;
};

/**
 * Watches TIDAL's page from here: its process ending, a reload, and (with `unfreeze`) a page that has
 * frozen. TIDAL only writes that last one down, and Chromium only notices it when the page is clicked.
 * So the page says it is alive every five seconds (see beat): one that has said nothing for half a
 * minute is ended, which has TIDAL bring a fresh one, the way it does after a crash. Not while the
 * developer tools are open (a page stopped at a breakpoint is not frozen), and not after the page has
 * changed until the plugin in the new one asks for it again: a page whose plugin never loaded says
 * nothing either.
 */
export const watchPage = async (unfreeze: boolean) => {
  const electron = getElectron();
  const s = shelf();
  s.unfreeze = unfreeze;
  s.unhook?.();
  s.unhook = undefined;
  const page = tidalPage();
  if (!electron || !page) throw new Error("TIDAL's page wasn't found");
  if (!s.watchingQuit) {
    s.watchingQuit = true;
    electron.app.on("before-quit", () => (shelf().quitting = true));
  }
  // (once for each page window: a reload keeps the window, and its line with it)
  if (s.mendedFor !== page.id && mendLine()) s.mendedFor = page.id;
  const stopBeat = () => {
    clearInterval(shelf().hang);
    shelf().hang = undefined;
  };
  const died = (_: unknown, details: { reason: string }) => {
    stopBeat();
    if (details?.reason !== "clean-exit") went(details?.reason || "crashed");
  };
  const navigated = (details: any, _url?: string, inPlace?: boolean, mainFrame?: boolean) => {
    if (!(details?.isMainFrame ?? mainFrame) || (details?.isSameDocument ?? inPlace)) return;
    stopBeat();
    went("reload");
  };
  page.on("render-process-gone", died);
  page.on("did-start-navigation", navigated);
  page.once("destroyed", stopBeat);
  stopBeat();
  s.missed = 0;
  s.hang = setInterval(() => {
    const now = shelf();
    try {
      if (page.isDestroyed()) return stopBeat();
      if (!now.unfreeze || page.isDevToolsOpened() || page.isLoading()) return void (now.missed = 0);
      if (++now.missed < MISSES) return;
      stopBeat();
      went("hang");
      page.forcefullyCrashRenderer();
    } catch {}
  }, BEAT_MS);
  s.unhook = () => {
    stopBeat();
    try {
      page.off("render-process-gone", died);
      page.off("did-start-navigation", navigated);
      page.off("destroyed", stopBeat);
    } catch {}
  };
};
/** Stops watching (the plugin is being switched off). What is remembered stays */
export const unwatchPage = async () => {
  shelf().unhook?.();
  shelf().unhook = undefined;
};

// ------------------ TIDAL'S LINE TO ITS PAGE ------------------
// What TIDAL's main process has to tell the page (above all what its player is doing: loaded, playing,
// where it is) goes through one "dispatcher", pointed at the page's window. When the page has died,
// TIDAL makes a new window and points the dispatcher at it, and then the old window, as it is cleaned
// up a moment later, takes the dispatcher down again: its cleanup doesn't know it is no longer the one.
// From then on nothing reaches the page. It asks the player to load a song and never hears that it has:
// the play button spins, nothing can be played or paused, and that lasts until TIDAL is restarted.
// (Seen in TIDAL 2.48: "Registering client dispatcher" followed by "Client dispatcher destroyed".)
//
// So the dispatcher is pointed at the page once more, for every new page window this plugin is loaded
// in (see watchPage): what was said meanwhile had been kept, and is delivered. For a window whose line
// is whole it changes nothing. The dispatcher is a module of TIDAL's own, asked for by its file: Luna
// asks you once whether this plugin may use it, when the plugin is loaded, not in the middle of a crash.
const dispatcher = (): any | null => {
  try {
    const file = path.join((process as any).resourcesPath, "original.asar", "app", "main", "client", "clientDispatcher.js");
    return runtimeRequire(file)?.default ?? null;
  } catch {
    return null;
  }
};
/** Puts TIDAL's line to its page back (see above). False: it couldn't be reached in this version of TIDAL */
const mendLine = (): boolean => {
  try {
    const page = tidalPage();
    const d = dispatcher();
    if (!page || typeof d?.registerWebContents !== "function") return false;
    d.registerWebContents(page);
    return true;
  } catch {
    return false;
  }
};

export type Recovery = Gone & { away: number; /** The DJ plugin kept the music playing and picks it up itself */ djCarried: boolean };
/** Asked by a page that has just loaded: did the one before it go, how, and what was it playing? (Answered once) */
export const takeRecovery = async (): Promise<Recovery | null> => {
  const s = shelf();
  const g = s.gone;
  s.gone = undefined;
  if (!g || Date.now() - g.at > 180000) return null;
  const dj = djShelf();
  return { ...g, away: Date.now() - g.at, djCarried: (dj.carriedAt ?? 0) >= g.at - 5000 || !!dj.live };
};

/** Whether the music would carry on through a reload of the page right now (the DJ plugin's mixer is playing it) */
export const musicCarries = async () => !!djShelf().live;

/** Reloads TIDAL's page (the memory guard, see memory.ts). What it was playing is brought back by the page that loads */
export const reloadPage = async (why: string) => {
  const page = tidalPage();
  if (!page) throw new Error("TIDAL's page wasn't found");
  shelf().asked = why;
  stopPlayer();
  // (Luna's settings are a made-up address of TIDAL's: reloaded there, TIDAL shows "page not found" and Luna doesn't load at all)
  let home: string | undefined;
  try {
    const url = new URL(page.getURL());
    if (url.pathname.startsWith("/not-found") || url.search.includes("LunaSettings")) home = `${url.origin}/`;
  } catch {}
  if (home) await page.loadURL(home).catch(() => {});
  else page.reload();
};
