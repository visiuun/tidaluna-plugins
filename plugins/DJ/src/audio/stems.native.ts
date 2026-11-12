// Runs in the Electron main process. A mashup needs one song's voice without its band and another's
// band without its voice, and taking a voice out of a record is a neural network's job (see stems.js).
// Like the DJ's own voice, it runs in a hidden page with a process of its own: it needs most of a
// gigabyte while it works, which TIDAL's 32-bit page doesn't have to spare, and if it ever falls over
// it takes nothing with it. The page is closed when it has been idle for a while.
//
// The network (30 MB) and the runtime it runs on (onnxruntime-web, 11 MB) are downloaded once, kept in
// the DJ's data folder, and have to match the checksums below.
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { get as httpsGet } from "https";
import path from "path";
import { Readable } from "stream";
import { dataDir } from "../store.native";

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

const HOST = "dj-stems.invalid";
const PAGE_URL = `https://${HOST}/`;
const PARTITION = "visiuun-dj-stems"; // not "persist:", the files are kept by this module
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
/** Everything the page may load, by the name it asks for it under: where it comes from and what it must be */
const FILES: Record<string, { url: string; sha256: string; type: string }> = {
  "ort.wasm.min.mjs": { url: `${ORT}ort.wasm.min.mjs`, sha256: "f53ed4792e758e7232f779d479eb8931b97ff3ab2e3b9a33ee00d1251ffdaad6", type: "text/javascript" },
  "ort-wasm-simd-threaded.mjs": { url: `${ORT}ort-wasm-simd-threaded.mjs`, sha256: "745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8", type: "text/javascript" },
  "ort-wasm-simd-threaded.wasm": { url: `${ORT}ort-wasm-simd-threaded.wasm`, sha256: "207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea", type: "application/wasm" },
  // UVR5's "MDX-Net 1 (9.7)" vocal model, from the project's own model repository
  "model.onnx": {
    url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_1_9703.onnx",
    sha256: "229ad3bb96a037e89d8ed86732d6d3675856e6a07c3e3f02896eac01ec7ee4be",
    type: "application/octet-stream",
  },
};
// (GitHub hands a release file over to its storage hosts)
const isAllowed = (url: URL, redirected = false) =>
  url.protocol === "https:" && (["cdn.jsdelivr.net", "github.com"].includes(url.hostname) || (redirected && /(^|\.)githubusercontent\.com$/.test(url.hostname)));
const IDLE_MS = 3 * 60_000;
const JOB_TIMEOUT_MS = 4 * 60_000;

// ------------------ SOUND ON ITS WAY BETWEEN PAGES ------------------
// The mixer's page hands a stretch of sound over and takes the voice back; both go through here as plain
// bytes (posted and fetched by the pages, each once). They are kept as files for the few seconds between:
// the mixer's side of this and the separator's are separate copies of this module with nothing in memory
// in common (a list kept on the global object was simply not there for the other one).
const blobDir = () => path.join(dataDir(), "handover");
const blobFile = (id: string) => path.join(blobDir(), `${id}.bin`);
export const putBlob = async (id: string, data: Uint8Array) => {
  await mkdir(blobDir(), { recursive: true });
  // (Whatever was left behind by something that never came back for it)
  const now = Date.now();
  for (const name of await readdir(blobDir()).catch(() => [] as string[])) {
    const file = path.join(blobDir(), name);
    const age = now - ((await stat(file).catch(() => null))?.mtimeMs ?? now);
    if (age > 5 * 60_000) await rm(file, { force: true });
  }
  await writeFile(blobFile(id), data);
};
export const takeBlob = async (id: string) => {
  try {
    const data = await readFile(blobFile(id));
    await rm(blobFile(id), { force: true });
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } catch {
    return undefined;
  }
};
/** Answers a page's request for /blob/<id> (POST leaves one, GET picks it up); undefined if it is no such request */
export const blobRoute = async (req: Request, url: URL): Promise<Response | undefined> => {
  const id = url.pathname.match(/^\/blob\/([\w.-]{1,80})$/)?.[1];
  if (!id) return undefined;
  if (req.method === "POST") {
    await putBlob(id, new Uint8Array(await req.arrayBuffer()));
    return new Response("ok");
  }
  const data = await takeBlob(id);
  if (!data) return new Response(null, { status: 404 });
  return new Response(data as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": String(data.byteLength) } });
};

// ------------------ DOWNLOADS (kept on disk) ------------------
const modelDir = () => path.join(dataDir(), "models");
let downloading: { got: number; total: number } | undefined;
const downloadTo = (url: string, file: string, redirects = 6): Promise<number> =>
  new Promise((resolve, reject) => {
    httpsGet(url, { headers: { "user-agent": "Mozilla/5.0" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`Too many redirects for ${url}`));
        const next = new URL(res.headers.location, url);
        if (!isAllowed(next, true)) return reject(new Error(`Download of ${url} was sent somewhere unexpected (${next.hostname})`));
        return resolve(downloadTo(next.href, file, redirects - 1));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return resolve(status);
      }
      const total = Number(res.headers["content-length"]) || 0;
      const progress = total > 5e6 ? (downloading = { got: 0, total }) : undefined;
      const done = () => {
        if (downloading === progress) downloading = undefined;
      };
      const out = createWriteStream(file);
      let received = 0;
      res.on("data", (chunk: Uint8Array) => {
        received += chunk.length;
        if (progress) progress.got = received;
      });
      res.on("error", (err) => (done(), out.destroy(), reject(err)));
      out.on("error", (err) => (done(), res.destroy(), reject(err)));
      out.on("finish", () => {
        done();
        if (total && received !== total) reject(new Error(`Download of ${url} was cut short`));
        else resolve(status);
      });
      res.pipe(out);
    }).on("error", reject);
  });
const sha256Of = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
const inflight = new Map<string, Promise<string>>();
/** The local copy of one of FILES, downloaded and checked first if it isn't there yet */
const localFile = (name: string) => {
  const running = inflight.get(name);
  if (running) return running;
  const job = (async () => {
    const spec = FILES[name];
    const file = path.join(modelDir(), `stems-${spec.sha256.slice(0, 16)}`);
    if (await stat(file).catch(() => null)) return file;
    await mkdir(modelDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const status = await downloadTo(spec.url, tmp);
      if (status < 200 || status >= 300) throw new Error(`Couldn't download ${name} (HTTP ${status})`);
      if ((await sha256Of(tmp)) !== spec.sha256) throw new Error(`The downloaded ${name} doesn't match its checksum`);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return file;
  })().finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
};

// ------------------ THE PAGE ------------------
// Cross-origin isolated, which is what lets the network use several CPU threads
const ISOLATION = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
let handlerInstalled = false;
const getSession = () => {
  const { session } = getElectron();
  const ses = session.fromPartition(PARTITION);
  if (handlerInstalled) return ses;
  if (ses.protocol.isProtocolHandled?.("https")) ses.protocol.unhandle("https");
  ses.protocol.handle("https", async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname !== HOST) return new Response(null, { status: 403 });
    if (url.pathname === "/") return new Response("<!doctype html><meta charset=utf-8><title>DJ stems</title>", { headers: { "content-type": "text/html", ...ISOLATION } });
    try {
      const blob = await blobRoute(req, url);
      if (blob) return blob;
      const name = url.pathname.match(/^\/lib\/([\w.-]+)$/)?.[1];
      if (!name || !FILES[name]) return new Response(null, { status: 404 });
      const file = await localFile(name);
      const size = (await stat(file)).size;
      return new Response(Readable.toWeb(createReadStream(file)) as unknown as BodyInit, {
        headers: { "content-type": FILES[name].type, "content-length": String(size), "cross-origin-resource-policy": "same-origin", ...ISOLATION },
      });
    } catch (err: any) {
      return new Response(String(err?.message ?? err), { status: 502 });
    }
  });
  handlerInstalled = true;
  return ses;
};

type Host = { view: any; ready: Promise<void>; died: Promise<never>; awake?: ReturnType<typeof setInterval> };
let host: Host | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let running = 0;

const closeHost = () => {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const current = host;
  host = undefined;
  clearInterval(current?.awake);
  try {
    if (current && !current.view.webContents.isDestroyed()) current.view.webContents.close();
  } catch {}
};
/** Pages left open by an earlier copy of the plugin (found by address: its variables are gone) */
const closeStrays = () => {
  try {
    for (const contents of getElectron()?.webContents?.getAllWebContents?.() ?? []) {
      try {
        if (!contents.isDestroyed() && String(contents.getURL()).startsWith(PAGE_URL) && contents !== host?.view.webContents) contents.close();
      } catch {}
    }
  } catch {}
};

const openHost = (pageSource: string): Host => {
  const { WebContentsView } = getElectron();
  const view = new WebContentsView({
    webPreferences: { session: getSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event: any) => event.preventDefault());
  let markDead!: (err: Error) => void;
  const died = new Promise<never>((_, reject) => (markDead = reject));
  died.catch(() => {});
  const created: Host = { view, ready: null!, died };
  contents.on("render-process-gone", (_: unknown, details: { reason: string }) => {
    clearInterval(created.awake);
    markDead(new Error(`The vocal separator stopped (${details.reason})`));
    if (host === created) closeHost();
  });
  // (Said on the page itself and repeated: a hidden page is otherwise run at a fraction of the speed, see mixer.native.ts)
  const keepAwake = () => {
    try {
      if (contents.isDestroyed()) clearInterval(created.awake);
      else contents.setBackgroundThrottling(false);
    } catch {}
  };
  created.ready = Promise.race([
    (async () => {
      await contents.loadURL(PAGE_URL);
      keepAwake();
      created.awake = setInterval(keepAwake, 10000);
      await contents.executeJavaScript(pageSource, true);
    })(),
    died,
  ]);
  created.ready.catch(() => host === created && closeHost());
  return created;
};

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

const inPage = async <T>(pageSource: string, code: string, what: string): Promise<T> => {
  if (!getElectron()) throw new Error("Mashups aren't available in this version of TidaLuna");
  clearTimeout(idleTimer);
  running++;
  if (!host) closeStrays();
  const current = (host ??= openHost(pageSource));
  try {
    await withTimeout(current.ready, JOB_TIMEOUT_MS, "Starting the vocal separator");
    return (await withTimeout(Promise.race([current.view.webContents.executeJavaScript(code, true), current.died]), JOB_TIMEOUT_MS, what)) as T;
  } catch (err) {
    if (host === current) closeHost();
    throw err;
  } finally {
    running--;
    if (running === 0 && host) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(closeHost, IDLE_MS);
    }
  }
};

// ------------------ API (called from TIDAL's page) ------------------
/** Gets the separator ready: its files downloaded (once) and the network loaded */
export const stemsReady = (pageSource: string) => inPage<{ threads: number; ms: number }>(pageSource, "window.__stems.ready()", "Loading the vocal separator");

/** Takes the voice out of the sound left under `job` (see blobRoute); the voice is left under `${job}.v` */
export const stemsSeparate = (pageSource: string, job: string) =>
  inPage<{ ms: number; seconds: number; threads: number }>(pageSource, `window.__stems.separate(${JSON.stringify(String(job).replace(/[^\w.-]/g, ""))})`, "Separating the vocals");

/** How far along it is: downloading its files (0-100), or through the piece it is working on (0-1) */
export const stemsProgress = async () => {
  let page: { stage?: string; progress?: number } = {};
  try {
    if (host && !host.view.webContents.isDestroyed()) page = (await host.view.webContents.executeJavaScript("window.__stems ? { stage: window.__stems.state.stage, progress: window.__stems.state.progress } : {}", true)) ?? {};
  } catch {}
  return { ...page, downloading: downloading ? Math.round((downloading.got / Math.max(1, downloading.total)) * 100) : undefined };
};

export const stemsClose = async () => {
  closeHost();
  closeStrays();
};
