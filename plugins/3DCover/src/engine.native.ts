// Runs in the Electron main process. Hosts the depth model in a hidden page with its own renderer
// process, instead of in TIDAL's. TIDAL is a 32-bit app, so its page can only use ~2-4 GB, and the
// model's WebAssembly memory only ever grows: running it inside TIDAL's page eventually crashed
// TIDAL with "out of memory". Here it gets a process of its own that is closed seconds after its
// last cover (or after a batch of covers), which hands all of its memory back.
import { cachedBytes, type Wire, toWire } from "./fetch.native";
import { CPU_ATTEMPTS, GPU_ATTEMPTS, TRANSFORMERS_URL, engineSource } from "./engine";

// Through a variable so the build leaves it alone, and inside a try: TidaLunar may not hand out
// electron, and then the page falls back to running the model itself
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

const HOST = "3d-cover-engine.invalid";
const PAGE_URL = `https://${HOST}/`;
const PARTITION = "visiuun-3d-cover-engine"; // not "persist:", nothing is written to disk
// Closed as soon as it has nothing to do. It used to stay up for five minutes after a cover, which is
// longer than a song lasts: with a cover made per song it never closed, and held some 250 MB (and the
// model in the graphics card's memory) all evening for a tenth of a second of work per song. A fresh
// start costs about five seconds, which nobody waits for: covers are made ahead of time, and every one
// made is on disk. The few seconds are for covers that come in a row (the next song's, a skip).
const IDLE_MS = 8_000;
const MAX_JOBS = 50;
const JOB_TIMEOUT_MS = 180_000;

const MIME: Record<string, string> = { js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm", json: "application/json" };
const mimeOf = (pathname: string) => MIME[pathname.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

// Pixels waiting for the engine page to fetch them, by id
const inputs = new Map<string, Uint8Array>();
let nextInput = 0;

// Everything the engine page requests goes through here: its own page + inputs, and the AI runtime +
// model files from the same disk cache as before (so nothing is downloaded twice)
let handlerInstalled = false;
const getSession = () => {
  const { session } = getElectron();
  const ses = session.fromPartition(PARTITION);
  if (handlerInstalled) return ses;
  if (ses.protocol.isProtocolHandled?.("https")) ses.protocol.unhandle("https");
  ses.protocol.handle("https", async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname === HOST) {
      if (url.pathname === "/") return new Response("<!doctype html><meta charset=utf-8><title>3D Cover depth engine</title>", { headers: { "content-type": "text/html" } });
      const id = url.pathname.match(/^\/input\/(\d+)$/)?.[1];
      const pixels = id && inputs.get(id);
      if (!pixels) return new Response(null, { status: 404 });
      inputs.delete(id);
      return new Response(pixels as BodyInit, { headers: { "content-type": "application/octet-stream" } });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
    try {
      const { status, data } = await cachedBytes(req.url);
      if (!data) return new Response(null, { status });
      const headers = { "content-type": mimeOf(url.pathname), "content-length": String(data.byteLength), "access-control-allow-origin": "*" };
      return new Response(req.method === "HEAD" ? null : (data as BodyInit), { headers });
    } catch (err: any) {
      return new Response(String(err?.message ?? err), { status: 502 });
    }
  });
  handlerInstalled = true;
  return ses;
};

// Runs inside the engine page: loads transformers.js + the shared engine module, then exposes
// window.__infer for the main process to call. The module is imported from a blob, as in the page.
const bootstrap = (attempts: unknown) => `(async () => {
  if (window.__infer) return true;
  const blobOf = (data, type) => URL.createObjectURL(new Blob([data], { type }));
  const tfRes = await fetch(${JSON.stringify(TRANSFORMERS_URL)});
  if (!tfRes.ok) throw new Error("Failed to download transformers.js (HTTP " + tfRes.status + ")");
  const tfUrl = blobOf(await tfRes.arrayBuffer(), "text/javascript");
  const engine = await import(blobOf(${JSON.stringify(engineSource)}.replace("__TF_URL__", tfUrl), "text/javascript"));
  const { port1, port2 } = new MessageChannel();
  const jobs = new Map();
  let nextId = 0;
  port1.onmessage = async ({ data }) => {
    if (data.type === "fetch") {
      try {
        const res = await fetch(data.url);
        const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
        port1.postMessage({ type: "fetched", reqId: data.reqId, status: res.status, data: bytes }, bytes ? [bytes.buffer] : []);
      } catch (err) {
        port1.postMessage({ type: "fetched", reqId: data.reqId, error: String(err?.message ?? err) });
      }
      return;
    }
    const done = jobs.get(data.id);
    jobs.delete(data.id);
    done?.(data);
  };
  engine.start(port2, ${JSON.stringify(attempts)});
  window.__infer = async (model, input, width, height) => {
    const res = await fetch(input);
    if (!res.ok) throw new Error("Engine input missing (HTTP " + res.status + ")");
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(await res.arrayBuffer()), width, height));
    const out = await new Promise((resolve) => {
      const id = nextId++;
      jobs.set(id, resolve);
      port1.postMessage({ type: "infer", id, model, bitmap }, [bitmap]);
    });
    if (out.error) throw new Error(out.error);
    return { width: out.width, height: out.height, data: out.data, backend: out.backend, ms: out.ms };
  };
  return true;
})()`;

// died: rejects as soon as the process is gone, so a crash fails the job instead of waiting for the timeout
type Engine = { view: any; ready: Promise<void>; died: Promise<never>; jobs: number; gone?: string };
let engine: Engine | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let running = 0;

const closeEngine = () => {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const current = engine;
  engine = undefined;
  if (!current) return;
  try {
    if (!current.view.webContents.isDestroyed()) current.view.webContents.close();
  } catch {}
};

const openEngine = (): Engine => {
  const { WebContentsView } = getElectron();
  const view = new WebContentsView({
    webPreferences: {
      session: getSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event: any) => event.preventDefault());
  let markDead!: (err: Error) => void;
  const died = new Promise<never>((_, reject) => (markDead = reject));
  died.catch(() => {});
  const created: Engine = { view, jobs: 0, ready: null!, died };
  contents.on("render-process-gone", (_: unknown, details: { reason: string }) => {
    created.gone = details.reason;
    markDead(new Error(`Depth engine process gone (${details.reason})`));
    if (engine === created) closeEngine();
  });
  created.ready = (async () => {
    await contents.loadURL(PAGE_URL);
    await contents.executeJavaScript(bootstrap([...GPU_ATTEMPTS, ...CPU_ATTEMPTS]));
  })();
  created.ready = Promise.race([created.ready, died]);
  created.ready.catch(() => engine === created && closeEngine());
  return created;
};

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

const runOnce = async (model: string, pixels: Uint8Array, width: number, height: number) => {
  const current = (engine ??= openEngine());
  await withTimeout(current.ready, JOB_TIMEOUT_MS, "Starting the depth engine");
  const id = String(nextInput++);
  inputs.set(id, pixels);
  try {
    const call = `window.__infer(${JSON.stringify(model)}, ${JSON.stringify(`${PAGE_URL}input/${id}`)}, ${width}, ${height})`;
    const result = await withTimeout(Promise.race([current.view.webContents.executeJavaScript(call), current.died]), JOB_TIMEOUT_MS, "Depth inference");
    current.jobs++;
    return result as { width: number; height: number; data: Uint8Array; backend: string; ms: number };
  } catch (err: any) {
    // The process died (e.g. out of memory) or hung: start fresh next time
    if (engine === current) closeEngine();
    throw err;
  } finally {
    inputs.delete(id);
  }
};

const scheduleRecycle = () => {
  clearTimeout(idleTimer);
  if (running > 0 || !engine) return;
  // A batch of covers in a row (e.g. preloading): recycle right away instead of letting it grow
  if (engine.jobs >= MAX_JOBS) return closeEngine();
  idleTimer = setTimeout(closeEngine, IDLE_MS);
};

const fromWire = (wire: Wire) => (typeof wire === "string" ? new Uint8Array(Buffer.from(wire, "base64")) : new Uint8Array(wire));

// ------------------ API (called from the page) ------------------
// binary: whether Uint8Arrays can be passed as-is (Luna) or need base64 (TidaLunar's JSON IPC)
export const engineStatus = async () => {
  const available = !!getElectron();
  return { available, binary: typeof toWire(new Uint8Array(0)) !== "string" };
};

/** Depth for a width × height RGBA image, computed in the separate engine process. */
export const inferInProcess = async (model: string, pixels: Wire, width: number, height: number) => {
  if (!getElectron()) throw new Error("Separate depth engine unavailable");
  clearTimeout(idleTimer);
  running++;
  try {
    const bytes = fromWire(pixels);
    let result;
    try {
      result = await runOnce(model, bytes, width, height);
    } catch (err) {
      // One retry in a brand new process: a crash there doesn't take TIDAL down with it
      result = await runOnce(model, bytes, width, height).catch(() => Promise.reject(err));
    }
    return { width: result.width, height: result.height, data: toWire(new Uint8Array(result.data)), backend: result.backend, ms: result.ms };
  } finally {
    running--;
    scheduleRecycle();
  }
};

export const stopProcessEngine = async () => {
  closeEngine();
  inputs.clear();
};
