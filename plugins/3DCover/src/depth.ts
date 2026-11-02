import { clearDepthFiles, clearFileCache, depthCacheStats, fetchCached, fetchImageBytes, readDepth, writeDepth } from "./fetch.native";
import { DEPTH_SIZE, postProcess, sharpenEdges } from "./postprocess";

// data: snapped depth (CPU), edges: smooth depth + edge sides for the GPU (see sharpenEdges)
export type DepthMap = { size: number; data: Uint8Array; edges: Uint8Array };

export { DEPTH_SIZE };

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

const MODEL_IDS = {
  small: "onnx-community/depth-anything-v2-small",
  base: "onnx-community/depth-anything-v2-base",
} as const;
export type ModelKey = keyof typeof MODEL_IDS;

// Backends tried in order. GPU runs the model at full res in ~0.1s. The CPU fallback is
// single-threaded (TIDAL isn't cross-origin isolated), so it uses a smaller input size.
const GPU_ATTEMPTS = [
  { device: "webgpu", dtype: "fp16", size: 518 },
  { device: "webgpu", dtype: "fp32", size: 518 },
];
const CPU_ATTEMPTS = [{ device: "wasm", dtype: "q8", size: 392 }];

// ------------------ INFERENCE ENGINE ------------------
// One module that talks over a message port, so the same code can run in-page (to reach WebGPU
// when workers can't) or inside a Worker (CPU fallback, off the UI thread).
// Network requests are proxied back to the host → native disk-cached fetch, because Luna's https
// handler fails requests made from workers and clears the browser cache on every launch.
const engineSource = `
let tf;
let port;
let attempts;
const pipes = new Map();
const fetches = new Map();
let nextReq = 0;

const proxyFetch = (input) => new Promise((resolve, reject) => {
  const reqId = nextReq++;
  fetches.set(reqId, { resolve, reject });
  port.postMessage({ type: "fetch", reqId, url: String(input?.url ?? input) });
});

const gpuStatus = async () => {
  if (!self.navigator?.gpu) return "navigator.gpu missing";
  try { return (await self.navigator.gpu.requestAdapter()) ? "ok" : "no adapter"; } catch (err) { return "adapter error: " + err?.message; }
};

const getPipe = (model) => {
  if (!pipes.has(model)) {
    pipes.set(model, (async () => {
      if (!tf) {
        tf = await import(${JSON.stringify("__TF_URL__")});
        tf.env.fetch = proxyFetch;
        tf.env.useBrowserCache = false;
        tf.env.allowLocalModels = false;
        if (tf.env.backends?.onnx?.wasm) tf.env.backends.onnx.wasm.numThreads = 1;
      }
      const gpu = await gpuStatus();
      const tried = ["webgpu: " + gpu];
      for (const { device, dtype, size } of attempts) {
        if (device === "webgpu" && gpu !== "ok") continue;
        try {
          const pipe = await tf.pipeline("depth-estimation", model, { device, dtype });
          pipe.processor.image_processor.size = { width: size, height: size };
          pipe.backend = device + "/" + dtype + "@" + size;
          return pipe;
        } catch (err) {
          tried.push(device + "/" + dtype + ": " + (err?.message ?? err));
        }
      }
      throw new Error("No depth backend available (" + tried.join("; ") + ")");
    })());
    pipes.get(model).catch(() => pipes.delete(model));
  }
  return pipes.get(model);
};

const onMessage = async ({ data: msg }) => {
  if (msg.type === "fetched") {
    const req = fetches.get(msg.reqId);
    fetches.delete(msg.reqId);
    if (!req) return;
    if (msg.error) return req.reject(new Error(msg.error));
    const headers = msg.data ? { "content-length": String(msg.data.byteLength) } : {};
    return req.resolve(new Response(msg.data ?? null, { status: msg.status, headers }));
  }
  if (msg.type !== "infer") return;

  const { id, model, bitmap } = msg;
  try {
    const pipe = await getPipe(model);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = new tf.RawImage(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, 4);
    const t0 = performance.now();
    const { depth } = await pipe(image);
    const out = new Uint8Array(depth.data);
    const ms = Math.round(performance.now() - t0);
    port.postMessage({ type: "result", id, width: depth.width, height: depth.height, data: out, backend: pipe.backend, ms }, [out.buffer]);
  } catch (err) {
    port.postMessage({ type: "result", id, error: String(err?.message ?? err) });
  }
};

export const start = (p, a) => {
  port = p;
  attempts = a;
  port.onmessage = onMessage;
};

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => data.type === "start" && start(self, data.attempts);
}
`;

type InferResult = { width: number; height: number; data: Uint8Array; backend: string; ms: number };
type Host = { kind: "page" | "worker"; port: MessagePort | Worker; dispose: () => void };

let hostPromise: Promise<Host> | undefined;
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
    return blobUrl(data as BlobPart);
  })).catch((err) => {
    tfUrl = undefined;
    throw err;
  });

const onEngineMessage = (port: MessagePort | Worker) => async ({ data }: MessageEvent) => {
  if (data.type === "fetch") {
    try {
      const { status, data: bytes } = await fetchCached(data.url);
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

const createHost = async (): Promise<Host> => {
  const engineUrl = blobUrl(engineSource.replace("__TF_URL__", await getTransformersUrl()));

  // Prefer running in-page when the page has WebGPU: fast, and the GPU does the heavy lifting
  if (!forceWorker && (await pageHasWebGPU())) {
    const engine = await import(engineUrl);
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = onEngineMessage(port1);
    engine.start(port2, GPU_ATTEMPTS);
    return { kind: "page", port: port1, dispose: () => port1.close() };
  }

  const worker = new Worker(engineUrl, { type: "module" });
  worker.onmessage = onEngineMessage(worker);
  worker.postMessage({ type: "start", attempts: [...GPU_ATTEMPTS, ...CPU_ATTEMPTS] });
  return { kind: "worker", port: worker, dispose: () => worker.terminate() };
};

const runOn = (host: Host, bitmap: ImageBitmap, model: ModelKey) =>
  new Promise<InferResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    host.port.postMessage({ type: "infer", id, model: MODEL_IDS[model], bitmap }, [bitmap]);
  });

const inferDepth = async (bitmap: () => Promise<ImageBitmap>, model: ModelKey): Promise<InferResult> => {
  const host = await (hostPromise ??= createHost().catch((err) => {
    hostPromise = undefined;
    throw err;
  }));
  try {
    return await runOn(host, await bitmap(), model);
  } catch (err) {
    if (host.kind !== "page") throw err;
    // In-page WebGPU didn't work out: fall back to the worker (CPU) for the rest of the session
    onInfo?.(`In-page WebGPU failed, using worker: ${(err as Error).message}`);
    host.dispose();
    forceWorker = true;
    hostPromise = undefined;
    return inferDepth(bitmap, model);
  }
};

export const disposeDepthWorker = () => {
  hostPromise?.then((host) => host.dispose()).catch(() => {});
  hostPromise = undefined;
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
const fetchBlob = async (url: string): Promise<Blob> => new Blob([(await fetchImageBytes(url)) as BlobPart]);

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
// One inference at a time. Jobs carry an AbortSignal: if the track was skipped before a job's turn
// comes up, it's dropped instead of burning seconds of CPU on a cover nobody will see.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

export const isAbort = (err: unknown) => (err as Error)?.name === "AbortError";

// ------------------ PUBLIC API ------------------
type Job = { promise: Promise<DepthMap>; keep: boolean };
const inflight = new Map<string, Job>();

let onInferred: ((backend: string, ms: number) => void) | undefined;
export const setInferenceLogger = (fn: typeof onInferred) => (onInferred = fn);

// Resolution is part of the key so maps from older builds aren't read at the wrong size
const depthKey = (coverId: string, model: ModelKey) => `${model}@${DEPTH_SIZE}:${coverId}`;

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
  if (existing) {
    if (!signal) existing.keep = true;
    return existing.promise;
  }

  const job: Job = { keep: !signal, promise: null! };
  job.promise = (async () => {
    const stored = await readDepth(key).catch(() => null);
    if (stored?.length === DEPTH_SIZE * DEPTH_SIZE) {
      const map = { size: DEPTH_SIZE, ...sharpenEdges(stored, DEPTH_SIZE) };
      memSet(key, map);
      return map;
    }

    const raw = await enqueue(() => {
      if (signal?.aborted && !job.keep) throw new DOMException("Track skipped before its turn", "AbortError");
      return inferDepth(bitmap, model);
    });
    // Stored before edge sharpening, so tuning it later doesn't need fresh inference
    const smooth = postProcess(raw.data, raw.width, raw.height);
    const map = { size: DEPTH_SIZE, ...sharpenEdges(smooth, DEPTH_SIZE) };
    onInferred?.(raw.backend, raw.ms);
    memSet(key, map);
    writeDepth(key, smooth).catch(() => {});
    return map;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job.promise;
};
