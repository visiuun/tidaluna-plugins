import { clearDepthFiles, clearFileCache, depthCacheStats, fetchCached, fetchImageBytes, readDepth, writeDepth } from "./fetch.native";
import { CPU_ATTEMPTS, GPU_ATTEMPTS, MODEL_IDS, type ModelKey, TRANSFORMERS_URL, engineSource } from "./engine";
import { engineStatus, inferInProcess, stopProcessEngine } from "./engine.native";
import { DEPTH_SIZE, postProcess, sharpenEdges } from "./postprocess";

export type { ModelKey };

// Native results are binary on Luna and base64 on TidaLunar, whose IPC is JSON
const toBytes = (wire: Uint8Array | string) => {
  if (typeof wire !== "string") return wire;
  const text = atob(wire);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
};
const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

// data: snapped depth (CPU), edges: smooth depth + edge sides for the GPU (see sharpenEdges)
export type DepthMap = { size: number; data: Uint8Array; edges: Uint8Array };

export { DEPTH_SIZE };

type InferResult = { width: number; height: number; data: Uint8Array; backend: string; ms: number };
// Where the model runs. "process": a hidden page with its own renderer process, owned by the main
// process (engine.native.ts). TIDAL is 32-bit, so its page only gets ~2-4 GB, and the model's
// WebAssembly memory never shrinks: run inside TIDAL's page it eventually crashed TIDAL with "out of
// memory". "page"/"worker" are the fallbacks for when that's unavailable (e.g. sandboxed native code).
type Host = { kind: "process" | "page" | "worker"; run: (bitmap: ImageBitmap, model: ModelKey) => Promise<InferResult>; dispose: () => void };

let hostPromise: Promise<Host> | undefined;
let forceInRenderer = false;
let processWorked = false;
let forceWorker = false;
let tfUrl: Promise<string> | undefined;
const blobUrls: string[] = [];
let nextId = 0;
const pending = new Map<number, { resolve: (v: InferResult) => void; reject: (e: Error) => void }>();

const blobUrl = (source: BlobPart) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  blobUrls.push(url);
  return url;
};

const getTransformersUrl = () =>
  (tfUrl ??= fetchCached(TRANSFORMERS_URL).then(({ status, data }) => {
    if (!data) throw new Error(`Failed to download transformers.js (HTTP ${status})`);
    return blobUrl(toBytes(data) as BlobPart);
  })).catch((err) => {
    tfUrl = undefined;
    throw err;
  });

const onEngineMessage = (port: MessagePort | Worker) => async ({ data }: MessageEvent) => {
  if (data.type === "fetch") {
    try {
      const { status, data: wire } = await fetchCached(data.url);
      const bytes = wire ? toBytes(wire) : undefined;
      port.postMessage({ type: "fetched", reqId: data.reqId, status, data: bytes }, bytes ? [bytes.buffer] : []);
    } catch (err: any) {
      port.postMessage({ type: "fetched", reqId: data.reqId, error: String(err?.message ?? err) });
    }
    return;
  }
  const job = pending.get(data.id);
  if (!job) return;
  pending.delete(data.id);
  if (data.error) job.reject(new Error(data.error));
  else job.resolve(data);
};

const pageHasWebGPU = async () => {
  try {
    return !!(await (navigator as any).gpu?.requestAdapter());
  } catch {
    return false;
  }
};

const runOnPort = (port: MessagePort | Worker) => (bitmap: ImageBitmap, model: ModelKey) =>
  new Promise<InferResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ type: "infer", id, model: MODEL_IDS[model], bitmap }, [bitmap]);
  });

const processHost = async (): Promise<Host | undefined> => {
  const status = await engineStatus().catch(() => null);
  if (!status?.available) return undefined;
  const run = async (bitmap: ImageBitmap, model: ModelKey) => {
    const { width, height } = bitmap;
    const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
    const out = await inferInProcess(MODEL_IDS[model], status.binary ? rgba : toBase64(rgba), width, height);
    return { ...out, data: toBytes(out.data), backend: `${out.backend}, own process` };
  };
  return { kind: "process", run, dispose: () => void stopProcessEngine().catch(() => {}) };
};

const createHost = async (): Promise<Host> => {
  if (!forceInRenderer) {
    const host = await processHost();
    if (host) return host;
  }

  const engineUrl = blobUrl(engineSource.replace("__TF_URL__", await getTransformersUrl()));

  // Prefer running in-page when the page has WebGPU: fast, and the GPU does the heavy lifting
  if (!forceWorker && (await pageHasWebGPU())) {
    const engine = await import(engineUrl);
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = onEngineMessage(port1);
    engine.start(port2, GPU_ATTEMPTS);
    return { kind: "page", run: runOnPort(port1), dispose: () => port1.close() };
  }

  const worker = new Worker(engineUrl, { type: "module" });
  worker.onmessage = onEngineMessage(worker);
  worker.postMessage({ type: "start", attempts: [...GPU_ATTEMPTS, ...CPU_ATTEMPTS] });
  return { kind: "worker", run: runOnPort(worker), dispose: () => worker.terminate() };
};

const aborted = () => new DOMException("Track skipped", "AbortError");

// The fallback worker shares TIDAL's memory, so it's closed once idle to hand that memory back.
// (Never mid-run: a run that has started always finishes and its result is still saved.)
const WORKER_IDLE_MS = 30_000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const recycleWhenIdle = (host: Host) => {
  clearTimeout(idleTimer);
  if (host.kind !== "worker") return;
  idleTimer = setTimeout(async () => {
    if (pending.size > 0 || !hostPromise || (await hostPromise.catch(() => null)) !== host) return;
    hostPromise = undefined;
    host.dispose();
  }, WORKER_IDLE_MS);
};

const inferDepth = async (bitmap: () => Promise<ImageBitmap>, model: ModelKey, cancel?: AbortSignal): Promise<InferResult> => {
  clearTimeout(idleTimer);
  const host = await (hostPromise ??= createHost().catch((err) => {
    hostPromise = undefined;
    throw err;
  }));
  const image = await bitmap();
  if (cancel?.aborted) {
    image.close();
    throw aborted();
  }
  try {
    const result = await host.run(image, model);
    if (host.kind === "process") processWorked = true;
    return result;
  } catch (err) {
    if (isAbort(err)) throw err;
    if (host.kind === "process") {
      // Once it has worked, a failure is a one-off (the next cover gets a fresh process). If it never
      // worked here, it can't: run the model the old way rather than not at all.
      if (processWorked) throw err;
      onInfo?.(`Separate depth process failed, running the model in TIDAL instead: ${(err as Error).message}`);
      host.dispose();
      forceInRenderer = true;
      hostPromise = undefined;
      return inferDepth(bitmap, model, cancel);
    }
    if (host.kind !== "page") throw err;
    // In-page WebGPU didn't work out: fall back to the worker (CPU) for the rest of the session
    onInfo?.(`In-page WebGPU failed, using worker: ${(err as Error).message}`);
    host.dispose();
    forceWorker = true;
    hostPromise = undefined;
    return inferDepth(bitmap, model, cancel);
  } finally {
    recycleWhenIdle(host);
  }
};

export const disposeDepthWorker = () => {
  clearTimeout(idleTimer);
  hostPromise?.then((host) => host.dispose()).catch(() => {});
  hostPromise = undefined;
  // Also when no host was made yet in this session: one from before a plugin reload may still be open
  stopProcessEngine().catch(() => {});
  tfUrl = undefined;
  for (const url of blobUrls.splice(0)) URL.revokeObjectURL(url);
  for (const job of pending.values()) job.reject(new Error("Depth engine disposed"));
  pending.clear();
};

export const clearModelCache = () => clearFileCache();

let onInfo: ((msg: string) => void) | undefined;
export const setInfoLogger = (fn: typeof onInfo) => (onInfo = fn);

// ------------------ IMAGE LOADING ------------------
// Fetched in the main process: no CORS issues with TIDAL's image CDN.
const fetchBlob = async (url: string): Promise<Blob> => new Blob([toBytes(await fetchImageBytes(url)) as BlobPart]);

export const loadCoverBitmap = async (urls: string[]): Promise<ImageBitmap> => {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      return await createImageBitmap(await fetchBlob(url));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
};

// ------------------ CACHE (memory + disk) ------------------
// Depth maps are stored on disk by the main process, so they survive restarts and Luna's cache wipes.
const MAX_MEM_ENTRIES = 40;

const memCache = new Map<string, DepthMap>();
const memSet = (key: string, map: DepthMap) => {
  memCache.delete(key);
  memCache.set(key, map);
  if (memCache.size > MAX_MEM_ENTRIES) memCache.delete(memCache.keys().next().value!);
};

export const clearDepthCache = async () => {
  memCache.clear();
  await clearDepthFiles();
};

export const getDepthCacheStats = () => depthCacheStats();

export const closeDepthCache = () => memCache.clear();

// ------------------ QUEUE ------------------
// One inference at a time. Jobs carry the AbortSignals of the tracks that want them: once all of
// those are skipped before the job's turn comes up, it's dropped.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

export const isAbort = (err: unknown) => (err as Error)?.name === "AbortError";

// ------------------ PUBLIC API ------------------
// keep: someone is hovering the cover, never cancel. cancel: fires once every track that wanted it was skipped.
type Job = { promise: Promise<DepthMap>; keep: boolean; signals: AbortSignal[]; cancel: AbortController };
const want = (job: Job, signal?: AbortSignal) => {
  if (!signal) return void (job.keep = true);
  job.signals.push(signal);
  const check = () => !job.keep && job.signals.every((s) => s.aborted) && job.cancel.abort();
  if (signal.aborted) check();
  else signal.addEventListener("abort", check, { once: true });
};
const inflight = new Map<string, Job>();

let onInferred: ((backend: string, ms: number) => void) | undefined;
export const setInferenceLogger = (fn: typeof onInferred) => (onInferred = fn);

// Resolution is part of the key so maps from older builds aren't read at the wrong size
const depthKey = (coverId: string, model: ModelKey) => `${model}@${DEPTH_SIZE}:${coverId}`;

// Cover pixels at depth-map size, so depth edges can be placed on the cover's own outlines.
// Without them (decode failed) edges just follow the depth map.
const coverPixels = async (bitmap: () => Promise<ImageBitmap>) => {
  try {
    const image = await bitmap();
    const ctx = new OffscreenCanvas(DEPTH_SIZE, DEPTH_SIZE).getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, DEPTH_SIZE, DEPTH_SIZE);
    image.close();
    return ctx.getImageData(0, 0, DEPTH_SIZE, DEPTH_SIZE).data;
  } catch {
    return undefined;
  }
};

export const getCachedDepth = (coverId: string, model: ModelKey): DepthMap | undefined => memCache.get(depthKey(coverId, model));

/**
 * Cached depth map for a cover, generating it if needed.
 * Without a signal (e.g. you're hovering the cover) the job always runs; with one, it's skipped if
 * the signal aborts before the job reaches the front of the queue.
 */
export const getDepth = (coverId: string, model: ModelKey, bitmap: () => Promise<ImageBitmap>, signal?: AbortSignal): Promise<DepthMap> => {
  const key = depthKey(coverId, model);
  const hit = memCache.get(key);
  if (hit) return Promise.resolve(hit);

  const existing = inflight.get(key);
  if (existing && !existing.cancel.signal.aborted) {
    want(existing, signal);
    return existing.promise;
  }

  const job: Job = { keep: false, signals: [], cancel: new AbortController(), promise: null! };
  want(job, signal);
  job.promise = (async () => {
    const stored = await readDepth(key).then((wire) => (wire ? toBytes(wire) : null)).catch(() => null);
    if (stored?.length === DEPTH_SIZE * DEPTH_SIZE) {
      const map = { size: DEPTH_SIZE, ...sharpenEdges(stored, DEPTH_SIZE, await coverPixels(bitmap)) };
      memSet(key, map);
      return map;
    }

    const raw = await enqueue(() => {
      if (job.cancel.signal.aborted) throw aborted();
      return inferDepth(bitmap, model, job.cancel.signal);
    });
    // Stored before edge sharpening, so tuning it later doesn't need fresh inference
    const smooth = postProcess(raw.data, raw.width, raw.height);
    const map = { size: DEPTH_SIZE, ...sharpenEdges(smooth, DEPTH_SIZE, await coverPixels(bitmap)) };
    onInferred?.(raw.backend, raw.ms);
    memSet(key, map);
    writeDepth(key, toBase64(smooth)).catch(() => {});
    return map;
  })().finally(() => inflight.get(key) === job && inflight.delete(key));

  inflight.set(key, job);
  return job.promise;
};
