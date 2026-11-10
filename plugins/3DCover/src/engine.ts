// Shared by the page (depth.ts) and the separate engine process (engine.native.ts)

export const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

export const MODEL_IDS = {
  small: "onnx-community/depth-anything-v2-small",
  base: "onnx-community/depth-anything-v2-base",
} as const;
export type ModelKey = keyof typeof MODEL_IDS;

// Backends tried in order. GPU runs the model at full res in ~0.1s. The CPU fallback is
// single-threaded (TIDAL isn't cross-origin isolated), so it uses a smaller input size.
export const GPU_ATTEMPTS = [
  { device: "webgpu", dtype: "fp16", size: 518 },
  { device: "webgpu", dtype: "fp32", size: 518 },
];
export const CPU_ATTEMPTS = [{ device: "wasm", dtype: "q8", size: 392 }];

// ------------------ INFERENCE ENGINE ------------------
// One module that talks over a message port, so the same code can run in-page (to reach WebGPU
// when workers can't) or inside a Worker (CPU fallback, off the UI thread).
// Network requests are proxied back to the host → native disk-cached fetch, because Luna's https
// handler fails requests made from workers and clears the browser cache on every launch.
export const engineSource = `
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
