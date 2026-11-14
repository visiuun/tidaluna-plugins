// Runs in the Electron main process: hosts the DJ's mixer in a hidden page with a process of its own
// (see mixer.page.js for why), relays calls to it, and serves it the audio. A track's stream is fetched
// and decrypted here, on its way to the mixer; nothing is written to disk.
import { createDecipheriv } from "crypto";
import os from "os";
import { blobRoute } from "./stems.native";

// Through a variable so the build leaves it alone, and inside a try: TidaLunar may not hand out electron
const runtimeRequire = (id: string) => require(id);
let electronModule: any | null | undefined;
const getElectron = () => {
  if (electronModule !== undefined) return electronModule;
  try {
    const electron = runtimeRequire("electron");
    electronModule = typeof electron?.WebContentsView === "function" && electron?.session ? electron : null;
  } catch {
    electronModule = null;
  }
  return electronModule;
};

const HOST = "dj-mixer.invalid";
const PAGE_URL = `https://${HOST}/`;
const PARTITION = "visiuun-dj-mixer";

// ------------------ AUDIO ------------------
export type TrackSource = { urls: string[]; encryptionType?: string; keyId?: string };
const sources = new Map<string, TrackSource>();

// The key that unwraps each stream's own key (the same one TidaLuna's downloader uses)
const MASTER_KEY = Buffer.from("UIlTTEMmmLfGowo/UC60x2H45W6MdGgTRfo/umg4754=", "base64");
const decipherFor = (keyId: string) => {
  const wrapped = Buffer.from(keyId, "base64");
  const unwrap = createDecipheriv("aes-256-cbc", Uint8Array.from(MASTER_KEY), Uint8Array.from(wrapped.subarray(0, 16)));
  const plain = unwrap.update(Uint8Array.from(wrapped.subarray(16)));
  const iv = new Uint8Array(16);
  iv.set(plain.subarray(16, 24));
  return createDecipheriv("aes-128-ctr", Uint8Array.from(plain.subarray(0, 16)), iv);
};

// The addresses come from the page: only TIDAL's own servers are ever fetched from
const isTidalAudio = (address: string) => {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && (url.hostname === "tidal.com" || url.hostname.endsWith(".tidal.com"));
  } catch {
    return false;
  }
};

const fetchAudio = async (src: TrackSource) => {
  if (!src.urls.length || !src.urls.every(isTidalAudio)) throw new Error("Not a TIDAL audio address");
  const parts: Uint8Array[] = [];
  // DASH streams come as many small segments: a few at a time
  for (let i = 0; i < src.urls.length; i += 6) {
    const batch = await Promise.all(
      src.urls.slice(i, i + 6).map(async (url) => {
        // A dropped connection or a busy server is worth a second and third go; a refusal isn't
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await fetch(url);
            if (res.ok) return new Uint8Array(await res.arrayBuffer());
            if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`TIDAL's server said HTTP ${res.status}`);
          } catch (err: any) {
            if (attempt >= 2 || /said HTTP/.test(String(err?.message))) throw err;
          }
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }),
    );
    parts.push(...batch);
  }
  let data: Uint8Array = parts.length === 1 ? parts[0] : new Uint8Array(Buffer.concat(parts));
  if (src.encryptionType === "OLD_AES" && src.keyId) {
    const d = decipherFor(src.keyId);
    data = new Uint8Array(Buffer.concat([d.update(data), d.final()]));
  } else if (src.encryptionType && src.encryptionType !== "NONE") throw new Error(`Unknown stream encryption ${src.encryptionType}`);
  return data;
};

let handlerInstalled = false;
const getSession = () => {
  const { session } = getElectron();
  const ses = session.fromPartition(PARTITION);
  if (handlerInstalled) return ses;
  if (ses.protocol.isProtocolHandled?.("https")) ses.protocol.unhandle("https");
  ses.protocol.handle("https", async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname !== HOST) return new Response(null, { status: 403 });
    if (url.pathname === "/") return new Response("<!doctype html><meta charset=utf-8><title>DJ mixer</title>", { headers: { "content-type": "text/html" } });
    // (A stretch of sound on its way to the vocal separator, or the voice on its way back)
    const blob = await blobRoute(req, url);
    if (blob) return blob;
    const token = url.pathname.match(/^\/track\/([\w-]+)$/)?.[1];
    const src = token && sources.get(token);
    if (!src) return new Response(null, { status: 404 });
    sources.delete(token!);
    try {
      const data = await fetchAudio(src);
      return new Response(data as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": String(data.byteLength) } });
    } catch (err: any) {
      return new Response(String(err?.message ?? err), { status: 502 });
    }
  });
  handlerInstalled = true;
  return ses;
};

// ------------------ THE PAGE ------------------
type Host = {
  id: number;
  view: any;
  ready: Promise<void>;
  died: Promise<never>;
  gone?: string;
  awake?: ReturnType<typeof setInterval>;
  /** stops watching TIDAL's page (see followPage) */
  unfollow?: () => void;
  /** which mixer page this is (see keyOf): a page is only carried over to a plugin that speaks the same one */
  key: string;
  /** what the session would need to pick this mixer up again, should TIDAL's page go ("": nothing worth carrying) */
  snapshot: string;
};
let host: Host | undefined;
let hostSeq = 0;

// ------------------ CARRIED OVER ------------------
// TIDAL's page can go while the music plays: its process dies (out of memory, mostly) or it is reloaded.
// TIDAL brings the page back by itself within seconds, and the mixer, a process of its own, has no reason
// to stop meanwhile: what is scheduled in it plays on. So it is not closed then but carried: kept, with
// what the session knew, until the DJ is loaded again in the new page and picks it up (see mixerAdopt),
// or closed after CARRY_MS if nobody does.
//
// Where it is kept has to outlive this file, which is run afresh whenever the plugin is loaded, in a
// sandbox of its own (its `process` and its globals are not the real ones, and what it reads off a
// module is wrapped). Electron's `app` object is the same for every load, and a property under a symbol
// is handed over as it is: that is where it is kept.
type Carried = { view: any; key: string; snapshot: string; since: number; timer: ReturnType<typeof setTimeout>; awake?: ReturnType<typeof setInterval> };
const CARRY_MS = 45000;
// (`live`: music is playing from a mixer that would be carried; `carriedAt`: when one last was. For whoever
// else looks after TIDAL's page, the Optimizer plugin for one: the music is not theirs to bring back then)
type Shelf = {
  carried?: Carried;
  quitting?: boolean;
  watchingQuit?: boolean;
  live?: boolean;
  carriedAt?: number;
  /** Stops keeping TIDAL's own player silent (see hush), and the volume its page last asked for meanwhile, and when */
  unhush?: () => void;
  volume?: number;
  volumeAt?: number;
};
const SHELF = Symbol.for("visiuun.dj.shelf");
const ownShelf: Shelf = {};
const shelf = (): Shelf => {
  const app = getElectron()?.app;
  if (!app) return ownShelf;
  return (app[SHELF] ??= {});
};
const keyOf = (pageSource: string) => {
  let h = 5381;
  for (let i = 0; i < pageSource.length; i++) h = ((h * 33) ^ pageSource.charCodeAt(i)) >>> 0;
  return `${pageSource.length}:${h}`;
};
/** Fades a mixer nobody drives any more and closes it */
const closeGently = (view: any) => {
  try {
    const contents = view.webContents;
    if (contents.isDestroyed()) return;
    contents.executeJavaScript(`window.__mixer && window.__mixer.call("killAll", { fade: 1.2 })`, true).catch(() => {});
    setTimeout(() => {
      try {
        detach(view);
        if (!contents.isDestroyed()) contents.close();
      } catch {}
    }, 1500);
  } catch {}
};
const dropCarried = (gently = false) => {
  const c = shelf().carried;
  if (!c) return;
  shelf().carried = undefined;
  clearTimeout(c.timer);
  clearInterval(c.awake);
  unhush(true);
  if (gently) return closeGently(c.view);
  try {
    detach(c.view);
    if (!c.view.webContents.isDestroyed()) c.view.webContents.close();
  } catch {}
};
// TIDAL's own player has been playing the same song all along, silently: the page kept it at volume zero.
// The page that comes back knows nothing of that. It starts by turning the volume all the way up, then
// to where you have it, and after a reload it puts the song back on by itself: the song would be heard
// twice, the first moment of it at full volume, until the DJ is loaded and has TIDAL silent again.
// So while the mixer is carried, TIDAL's player is stopped, and kept at volume zero: whenever the page
// asks for a volume, zero is asked for straight after it. (Sent the way the page sends it; TIDAL only
// looks at where a message says it is from.) It ends when the DJ's session is back, which keeps TIDAL
// silent in its own way, or when the mixer is given up, and then TIDAL gets the volume it last asked for.
const tellPlayer = (command: object) => {
  try {
    getElectron()?.ipcMain?.emit("player.message", { senderFrame: { url: "https://desktop.tidal.com/" }, visiuunDj: true }, JSON.stringify(command));
  } catch {}
};
const hush = () => {
  const s = shelf();
  tellPlayer({ command: "media.stop" });
  if (s.unhush) return;
  const ipc = getElectron()?.ipcMain;
  if (!ipc?.on) return;
  const heard = (event: any, message: unknown) => {
    try {
      if (event?.visiuunDj) return;
      const m = JSON.parse(String(message));
      if (m?.command !== "media.volume") return;
      shelf().volume = Number(m.volume);
      shelf().volumeAt = Date.now();
      if (Number(m.volume) > 0) tellPlayer({ command: "media.volume", volume: 0 });
    } catch {}
  };
  ipc.on("player.message", heard);
  s.volume = undefined;
  s.unhush = () => {
    try {
      ipc.off("player.message", heard);
    } catch {}
  };
};
/**
 * `restore`: TIDAL's player gets the volume its page last asked for (nobody else is going to give it one).
 * Not before the page has been quiet about it for three seconds: the full volume a page starts with is
 * followed by the real one a moment later, and it is that one the player is to get.
 */
const SETTLED_MS = 3000;
const unhush = (restore: boolean) => {
  const s = shelf();
  const stop = s.unhush;
  if (!stop) return;
  s.unhush = undefined;
  const finish = () => {
    try {
      stop();
      const now = shelf();
      // (not if TIDAL's player is being kept silent again meanwhile)
      if (restore && !now.unhush && now.volume !== undefined && Number.isFinite(now.volume)) tellPlayer({ command: "media.volume", volume: now.volume });
      if (!now.unhush) now.volume = undefined;
    } catch {}
  };
  const age = Date.now() - (s.volumeAt ?? 0);
  if (!restore || age >= SETTLED_MS) finish();
  else setTimeout(finish, SETTLED_MS - age);
};

// Every time the plugin is (re)loaded this file runs again with fresh variables, so "the open mixer" can't
// just be a variable here: a new copy of the plugin must be able to close a mixer an earlier copy left
// playing, or it would carry on underneath TIDAL's own player. Mixer pages are found by their address.
// (All but one that is being carried over: that one is its own business, see dropCarried)
const closeAllMixers = () => {
  try {
    const carried = shelf().carried?.view?.webContents;
    for (const contents of getElectron()?.webContents?.getAllWebContents?.() ?? []) {
      try {
        if (!contents.isDestroyed() && contents !== carried && String(contents.getURL()).startsWith(PAGE_URL)) contents.close();
      } catch {}
    }
  } catch {}
};

// A page that isn't shown anywhere is treated by the system as background work: on Windows 11 its
// process is put in efficiency mode, where analysing a track took 10-20 s instead of about one. So the
// mixer's page sits in TIDAL's window as a single transparent pixel, which makes it foreground.
const tidalWindow = () => {
  try {
    const windows = getElectron()?.BrowserWindow?.getAllWindows?.() ?? [];
    return windows.find((w: any) => !w.isDestroyed() && /tidal\.com/.test(String(w.webContents?.getURL?.() ?? ""))) ?? windows.find((w: any) => !w.isDestroyed());
  } catch {
    return undefined;
  }
};
const attach = (view: any) => {
  try {
    const win = tidalWindow();
    if (!win?.contentView?.addChildView) return;
    view.setBackgroundColor?.("#00000000");
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  } catch {}
};
const detach = (view: any) => {
  try {
    for (const win of getElectron()?.BrowserWindow?.getAllWindows?.() ?? []) {
      try {
        if (!win.isDestroyed()) win.contentView?.removeChildView?.(view);
      } catch {}
    }
  } catch {}
};

// Being created with background throttling off isn't enough: the page still ends up treated as hidden
// (it reports itself as such), and its process is then run at about a fifth of the speed. Measured: the
// same loop took 500 ms in the mixer's page and 100 ms in TIDAL's, and a blend took so long to work out
// that it was scheduled seconds after it should have started. Saying it again on the page itself brings
// it straight back to full speed, so that is done once it has loaded and repeated while it lives.
const keepAwake = (contents: any) => {
  try {
    if (contents.isDestroyed()) return;
    contents.setBackgroundThrottling(false);
    os.setPriority(contents.getOSProcessId(), os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch {}
};

// The mixer is driven from TIDAL's page. When that page goes (it reloads, or its process dies, which a
// page holding a couple of gigabytes does now and then), nothing is left to drive the mixer or to stop
// it. With music playing it is carried over to the page that comes back (see CARRIED OVER); otherwise,
// or when TIDAL itself is closing, the mixer goes when the page does.
const pageGone = (created: Host) => {
  if (host !== created) return;
  const s = shelf();
  let alive = false;
  try {
    alive = !created.gone && !created.view.webContents.isDestroyed();
  } catch {}
  if (!created.snapshot || s.quitting || !alive) return closeHost();
  // Carried: no longer this file's mixer, but not closed
  host = undefined;
  sources.clear();
  created.unfollow?.();
  dropCarried();
  s.carried = { view: created.view, key: created.key, snapshot: created.snapshot, since: Date.now(), awake: created.awake, timer: setTimeout(() => dropCarried(true), CARRY_MS) };
  s.carriedAt = Date.now();
  s.live = false;
  hush();
};
const watchQuit = () => {
  const s = shelf();
  if (s.watchingQuit) return;
  s.watchingQuit = true;
  try {
    // (TIDAL is closing: its window going is not a page to wait for)
    getElectron()?.app?.on("before-quit", () => {
      s.quitting = true;
      dropCarried();
    });
  } catch {}
};
const followPage = (created: Host) => {
  try {
    watchQuit();
    const page = tidalWindow()?.webContents;
    if (!page?.on) return;
    const gone = () => pageGone(created);
    const navigated = (details: any, _url?: string, inPlace?: boolean, mainFrame?: boolean) => {
      if ((details?.isMainFrame ?? mainFrame) && !(details?.isSameDocument ?? inPlace)) gone();
    };
    page.on("render-process-gone", gone);
    page.on("destroyed", gone);
    page.on("did-start-navigation", navigated);
    created.unfollow = () => {
      try {
        page.off("render-process-gone", gone);
        page.off("destroyed", gone);
        page.off("did-start-navigation", navigated);
      } catch {}
    };
  } catch {}
};

const closeHost = () => {
  const current = host;
  host = undefined;
  if (current) {
    shelf().live = false;
    // (a mixer that was picked up and is closed before its session was running: TIDAL's player is let go of)
    unhush(true);
  }
  sources.clear();
  clearInterval(current?.awake);
  current?.unfollow?.();
  try {
    if (current) detach(current.view);
    if (current && !current.view.webContents.isDestroyed()) current.view.webContents.close();
  } catch {}
  closeAllMixers();
};

/** A host around a mixer page: one just made (see openHost) or one carried over (see mixerAdopt) */
const hostFor = (view: any, key: string): Host => {
  const contents = view.webContents;
  let markDead!: (err: Error) => void;
  const died = new Promise<never>((_, reject) => (markDead = reject));
  died.catch(() => {});
  const created: Host = { id: ++hostSeq, view, ready: null!, died, key, snapshot: "" };
  contents.on("render-process-gone", (_: unknown, details: { reason: string }) => {
    clearInterval(created.awake);
    created.gone = details.reason;
    markDead(new Error(`The DJ's mixer stopped (${details.reason})`));
    if (host === created) closeHost();
  });
  // (Closed by something other than this module: just as gone. Left as "still there", the session kept
  // waiting for a mixer that would never answer, with TIDAL's own player muted: silence)
  contents.once("destroyed", () => {
    clearInterval(created.awake);
    created.gone ??= "closed";
    markDead(new Error("The DJ's mixer was closed"));
    if (host === created) closeHost();
  });
  return created;
};

const openHost = (pageSource: string): Host => {
  const { WebContentsView } = getElectron();
  const view = new WebContentsView({
    webPreferences: {
      session: getSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      // It has no window to click in: audio must be allowed to start on its own
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  const contents = view.webContents;
  attach(view);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event: any) => event.preventDefault());
  const created = hostFor(view, keyOf(pageSource));
  const { died } = created;
  created.ready = Promise.race([
    (async () => {
      await contents.loadURL(PAGE_URL);
      // A page nobody can see gets background priority from the system; this one is making the sound
      keepAwake(contents);
      created.awake = setInterval(() => (contents.isDestroyed() ? clearInterval(created.awake) : keepAwake(contents)), 10000);
      await contents.executeJavaScript(pageSource, true);
    })(),
    died,
  ]);
  created.ready.catch(() => host === created && closeHost());
  followPage(created);
  return created;
};

// ------------------ API (called from TIDAL's page) ------------------
/**
 * Opens a fresh mixer (closing any earlier one) and returns its id. Calls and the close carry that id: a
 * session that is still winding down can then neither drive nor close the mixer of the one that replaced it
 * (that happened: the new session was left with no mixer while TIDAL's own player stayed muted).
 */
export const mixerOpen = async (pageSource: string) => {
  if (!getElectron()) throw new Error("The DJ's mixer can't run in this version of TidaLuna");
  dropCarried();
  closeHost();
  const created = (host = openHost(pageSource));
  await created.ready;
  return created.id;
};

/** Where the mixer page can fetch a track's audio from. One use */
export const mixerTrackUrl = async (token: string, source: TrackSource) => {
  sources.set(token, source);
  return `${PAGE_URL}track/${token}`;
};

/** Calls the mixer; the reply is JSON (see mixer.page.js) */
export const mixerCall = async (method: string, argsJson: string, id?: number): Promise<string> => {
  const current = host;
  if (!current || (id !== undefined && current.id !== id)) return JSON.stringify({ ok: false, error: "The DJ's mixer isn't running", gone: true });
  try {
    await current.ready;
    return (await Promise.race([current.view.webContents.executeJavaScript(`window.__mixer.call(${JSON.stringify(method)}, ${argsJson})`, true), current.died])) as string;
  } catch (err: any) {
    return JSON.stringify({ ok: false, error: String(err?.message ?? err), gone: !host || host !== current || !!current.gone });
  }
};

/** Closes the mixer with this id, if it's still the open one. Without an id: whatever is open, and one that was being carried over */
export const mixerClose = async (id?: number) => {
  if (id !== undefined && host && host.id !== id) return;
  if (id === undefined) dropCarried();
  closeHost();
};

/**
 * What the session would need to pick this mixer up again if TIDAL's page went right now (see CARRIED
 * OVER). Sent whenever it changes; "": nothing worth carrying (nothing playing, or the session is ending).
 */
export const mixerCarry = async (snapshot: string, id: number) => {
  if (!host || host.id !== id) return;
  host.snapshot = snapshot;
  shelf().live = !!snapshot;
  // (a session that says so is running, and has TIDAL's player silent itself)
  if (snapshot) unhush(false);
};

/**
 * A mixer left playing by the page that went, if there is one and it is the same mixer page as
 * `pageSource` (an update of the plugin in between changes what the page understands: that one is closed).
 * Returns what its session knew, and for how long it has been on its own (ms).
 */
export const mixerCarried = async (pageSource: string): Promise<{ snapshot: string; alone: number } | null> => {
  const c = shelf().carried;
  if (!c) return null;
  let alive = false;
  try {
    alive = !c.view.webContents.isDestroyed() && !c.view.webContents.isCrashed();
  } catch {}
  if (!alive || c.key !== keyOf(pageSource)) {
    dropCarried(alive);
    return null;
  }
  return { snapshot: c.snapshot, alone: Date.now() - c.since };
};

/** Takes the carried mixer as this page's own: it is driven from here from now on. Returns its id (see mixerOpen) */
export const mixerAdopt = async () => {
  const c = shelf().carried;
  if (!c) throw new Error("There is no mixer to pick up");
  // (anything else that is open goes first, while the carried one is still marked as such: see closeAllMixers)
  closeHost();
  shelf().carried = undefined;
  clearTimeout(c.timer);
  clearInterval(c.awake);
  // The page fetches its audio from this file's own handler (the one an earlier load put there knows nothing of this load's tracks)
  getSession();
  const created = hostFor(c.view, c.key);
  created.ready = Promise.resolve();
  const contents = c.view.webContents;
  // (TIDAL makes a new window when its page has died: the mixer's pixel moves into it)
  detach(c.view);
  attach(c.view);
  keepAwake(contents);
  created.awake = setInterval(() => (contents.isDestroyed() ? clearInterval(created.awake) : keepAwake(contents)), 10000);
  // The session that knew this mixer is gone, but what it knew still holds until the new one says otherwise
  created.snapshot = c.snapshot;
  shelf().live = true;
  host = created;
  followPage(created);
  return created.id;
};
