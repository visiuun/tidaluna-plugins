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
type Host = { id: number; view: any; ready: Promise<void>; died: Promise<never>; gone?: string; awake?: ReturnType<typeof setInterval> };
let host: Host | undefined;
let hostSeq = 0;

// Every time the plugin is (re)loaded this file runs again with fresh variables, so "the open mixer" can't
// just be a variable here: a new copy of the plugin must be able to close a mixer an earlier copy left
// playing, or it would carry on underneath TIDAL's own player. Mixer pages are found by their address.
const closeAllMixers = () => {
  try {
    for (const contents of getElectron()?.webContents?.getAllWebContents?.() ?? []) {
      try {
        if (!contents.isDestroyed() && String(contents.getURL()).startsWith(PAGE_URL)) contents.close();
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

const closeHost = () => {
  const current = host;
  host = undefined;
  sources.clear();
  clearInterval(current?.awake);
  try {
    if (current) detach(current.view);
    if (current && !current.view.webContents.isDestroyed()) current.view.webContents.close();
  } catch {}
  closeAllMixers();
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
  let markDead!: (err: Error) => void;
  const died = new Promise<never>((_, reject) => (markDead = reject));
  died.catch(() => {});
  const created: Host = { id: ++hostSeq, view, ready: null!, died };
  contents.on("render-process-gone", (_: unknown, details: { reason: string }) => {
    clearInterval(created.awake);
    created.gone = details.reason;
    markDead(new Error(`The DJ's mixer stopped (${details.reason})`));
    if (host === created) closeHost();
  });
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

/** Closes the mixer with this id, if it's still the open one. Without an id: whatever is open */
export const mixerClose = async (id?: number) => {
  if (id !== undefined && host && host.id !== id) return;
  closeHost();
};
