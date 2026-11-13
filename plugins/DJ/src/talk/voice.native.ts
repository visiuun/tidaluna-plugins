// Runs in the Electron main process. The DJ's voice is a neural text-to-speech model (Kokoro, 82M
// parameters) that runs on this machine, in a hidden page with a process of its own: TIDAL is a 32-bit
// app, and a model inside its own page would eat into the memory TIDAL needs. The page is closed when
// idle. The model (~330 MB) is downloaded once and kept in the DJ's data folder. It's the full-precision
// version: inside TIDAL the small quantised one (90 MB) turned out three times slower.
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, rename, rm, stat } from "fs/promises";
import { get as httpsGet } from "https";
import os from "os";
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

const HOST = "dj-voice.invalid";
const PAGE_URL = `https://${HOST}/`;
const PARTITION = "visiuun-dj-voice"; // not "persist:", the model cache is our own files
// The voice engine is a pinned release, and the copy that gets downloaded has to match this checksum
const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
const KOKORO_SHA256 = "6067712fe4c43cdb36c762f860a5ab8d96ea1d9c8882466438eb9f3d0d20be8f";
// Everything the voice page loads comes from these two places (the engine and its runtime; the model and
// its voices). Hugging Face hands large files over to its own storage hosts.
const HOSTS = ["cdn.jsdelivr.net", "huggingface.co"];
const isAllowed = (url: URL, redirected = false) =>
  url.protocol === "https:" && (HOSTS.includes(url.hostname) || (redirected && /(^|\.)(huggingface\.co|hf\.co)$/.test(url.hostname)));
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const IDLE_MS = 4 * 60_000;
const JOB_TIMEOUT_MS = 6 * 60_000;

const MIME: Record<string, string> = { js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm", json: "application/json", bin: "application/octet-stream", onnx: "application/octet-stream" };
const mimeOf = (pathname: string) => MIME[pathname.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

// ------------------ DOWNLOADS (kept on disk) ------------------
// Files go from the network straight to disk and from disk straight to the page, never whole in this
// process's memory: it is 32-bit too, and holding a 330 MB model here is what once took TIDAL down.
const modelDir = () => path.join(dataDir(), "models");
let downloading: { url: string; got: number; total: number } | undefined;

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
      const progress = total > 5e6 ? (downloading = { url, got: 0, total }) : undefined;
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
        // A connection cut short must not leave half a model behind as if it were whole
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

const inflight = new Map<string, Promise<{ status: number; file?: string }>>();
/** The local copy of a URL, downloading it first if needed */
const cachedFile = (url: string) => {
  const running = inflight.get(url);
  if (running) return running;
  const job = (async () => {
    const file = path.join(modelDir(), createHash("sha1").update(url).digest("hex"));
    if (await stat(file).catch(() => null)) return { status: 200, file };
    await mkdir(modelDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    let status: number;
    try {
      status = await downloadTo(url, tmp);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    if (status < 200 || status >= 300) {
      await rm(tmp, { force: true });
      return { status };
    }
    if (url === KOKORO_URL && (await sha256Of(tmp)) !== KOKORO_SHA256) {
      await rm(tmp, { force: true });
      throw new Error("The downloaded voice engine doesn't match its checksum");
    }
    await rename(tmp, file);
    return { status: 200, file };
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
};

// ------------------ THE PAGE ------------------
// Cross-origin isolated, which is what lets the model use several CPU threads
const ISOLATION = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
let handlerInstalled = false;
const getSession = () => {
  const { session } = getElectron();
  const ses = session.fromPartition(PARTITION);
  if (handlerInstalled) return ses;
  if (ses.protocol.isProtocolHandled?.("https")) ses.protocol.unhandle("https");
  ses.protocol.handle("https", async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname === HOST) return new Response("<!doctype html><meta charset=utf-8><title>DJ voice</title>", { headers: { "content-type": "text/html", ...ISOLATION } });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
    if (!isAllowed(url)) return new Response(null, { status: 403 });
    try {
      const { status, file } = await cachedFile(req.url);
      if (!file) return new Response(null, { status });
      const size = (await stat(file)).size;
      const headers = { "content-type": mimeOf(url.pathname), "content-length": String(size), "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
      if (req.method === "HEAD") return new Response(null, { headers });
      return new Response(Readable.toWeb(createReadStream(file)) as unknown as BodyInit, { headers });
    } catch (err: any) {
      return new Response(String(err?.message ?? err), { status: 502 });
    }
  });
  handlerInstalled = true;
  return ses;
};

// Runs inside the page. Long lines are spoken sentence by sentence: the model is at its best on short
// passages, and a pause between sentences sounds natural anyway.
const bootstrap = `(async () => {
  if (window.__speak) return true;
  const src = await fetch(${JSON.stringify(KOKORO_URL)});
  if (!src.ok) throw new Error("Couldn't download the voice engine (HTTP " + src.status + ")");
  const mod = await import(URL.createObjectURL(new Blob([await src.arrayBuffer()], { type: "text/javascript" })));
  let tts;
  window.__voiceState = "starting";
  window.__speak = async (text, voice, speed) => {
    if (!tts) {
      window.__voiceState = "loading";
      tts = await mod.KokoroTTS.from_pretrained(${JSON.stringify(MODEL)}, { dtype: "fp32", device: "wasm" });
      window.__voiceState = "ready";
    }
    const sentences = (text.match(/[^.!?]+[.!?]+["')]*|[^.!?]+$/g) || [text]).map((s) => s.trim()).filter(Boolean);
    // Very short sentences join their neighbour so the rhythm isn't choppy
    const parts = [];
    for (const s of sentences) {
      if (parts.length && (parts[parts.length - 1].length < 18 || s.length < 12) && parts[parts.length - 1].length + s.length < 220) parts[parts.length - 1] += " " + s;
      else parts.push(s);
    }
    const chunks = [];
    let rate = 24000;
    for (const part of parts) {
      const audio = await tts.generate(part, { voice, speed });
      rate = audio.sampling_rate;
      chunks.push(audio.audio);
    }
    const gap = Math.round(rate * 0.16);
    const total = chunks.reduce((n, c) => n + c.length, 0) + gap * Math.max(0, chunks.length - 1);
    const pcm = new Int16Array(total);
    let o = 0;
    chunks.forEach((c, i) => {
      for (let j = 0; j < c.length; j++) pcm[o + j] = Math.max(-32768, Math.min(32767, Math.round(c[j] * 32767)));
      o += c.length + (i < chunks.length - 1 ? gap : 0);
    });
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return { rate, pcm: btoa(bin) };
  };
  return true;
})()`;

type Host = { view: any; ready: Promise<void>; died: Promise<never>; gone?: string };
let host: Host | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let running = 0;
let lastError: string | undefined;
let everReady = false;

const closeHost = () => {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const current = host;
  host = undefined;
  try {
    if (current && !current.view.webContents.isDestroyed()) current.view.webContents.close();
  } catch {}
};

/** Voice pages left open by an earlier copy of the plugin (found by address: its variables are gone) */
const closeStrays = () => {
  try {
    for (const contents of getElectron()?.webContents?.getAllWebContents?.() ?? []) {
      try {
        if (!contents.isDestroyed() && String(contents.getURL()).startsWith(PAGE_URL) && contents !== host?.view.webContents) contents.close();
      } catch {}
    }
  } catch {}
};

// Speech is prepared ahead of time, so it gives way to the mixer and to TIDAL itself. But not to everything: a page
// nobody sees is run at the lowest priority there is, and there a game using the whole processor left a twelve-second
// line taking over two minutes to make (one took more than six), so the DJ said nothing for four songs. One step
// below normal is still out of the way, and the same line under the same game took 52 s. Said again before every
// line: the priority of a page's process is Chromium's to change.
const settle = (contents: any) => {
  try {
    if (!contents.isDestroyed()) os.setPriority(contents.getOSProcessId(), os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
};

const openHost = (): Host => {
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
    created.gone = details.reason;
    markDead(new Error(`Voice engine process gone (${details.reason})`));
    if (host === created) closeHost();
  });
  created.ready = Promise.race([
    (async () => {
      await contents.loadURL(PAGE_URL);
      settle(contents);
      await contents.executeJavaScript(bootstrap);
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

// ------------------ API (called from the page) ------------------
/** Speech for `text` as 16-bit mono PCM, base64 */
export const kokoroSpeak = async (text: string, voice: string, speed: number): Promise<{ rate: number; pcm: string }> => {
  if (!getElectron()) throw new Error("The local voice isn't available in this version of TidaLuna");
  clearTimeout(idleTimer);
  running++;
  if (!host) closeStrays();
  const current = (host ??= openHost());
  try {
    await withTimeout(current.ready, JOB_TIMEOUT_MS, "Starting the voice engine");
    settle(current.view.webContents);
    const call = `window.__speak(${JSON.stringify(text)}, ${JSON.stringify(voice)}, ${Number(speed) || 1})`;
    const result = await withTimeout(Promise.race([current.view.webContents.executeJavaScript(call), current.died]), JOB_TIMEOUT_MS, "Speaking");
    lastError = undefined;
    everReady = true;
    return result as { rate: number; pcm: string };
  } catch (err: any) {
    lastError = String(err?.message ?? err);
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

/** Whether the model is already on disk, and what the engine is doing */
export const voiceStatus = async () => {
  const modelFile = path.join(modelDir(), createHash("sha1").update(`https://huggingface.co/${MODEL}/resolve/main/onnx/model.onnx`).digest("hex"));
  const downloaded = !!(await stat(modelFile).catch(() => null));
  return {
    available: !!getElectron(),
    downloaded,
    everReady,
    busy: running > 0,
    progress: downloading ? Math.round((downloading.got / Math.max(1, downloading.total)) * 100) : undefined,
    error: lastError,
  };
};

export const stopVoiceEngine = async () => {
  closeHost();
  closeStrays();
};

export const clearVoiceModel = async () => {
  closeHost();
  await rm(modelDir(), { recursive: true, force: true });
};

// ------------------ CLOUD VOICE (optional) ------------------
// With your own OpenAI key the lines are spoken by a cloud voice instead. Only the text of the line is sent.
export const cloudSpeak = async (apiKey: string, text: string, voice: string, style: string): Promise<{ rate: number; pcm: string }> => {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: text, instructions: style, response_format: "pcm" }),
  });
  if (!res.ok) throw new Error(`Cloud voice failed (HTTP ${res.status}): ${(await res.text().catch(() => "")).slice(0, 160)}`);
  return { rate: 24000, pcm: Buffer.from(await res.arrayBuffer()).toString("base64") };
};
