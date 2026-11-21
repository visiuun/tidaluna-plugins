// The hidden page that takes voices out of music for the DJ's mashups (see stems.native.ts, which opens
// it, and stems.js, which this text is put after and which does the work). It is handed sound as plain
// 16-bit stereo under an address of its own, and leaves the voice it found under another.
(() => {
  "use strict";
  if (window.__stems) return;
  const state = { stage: "idle", progress: 0 };
  let ort;
  let session;
  let loading;
  let backend = "wasm";
  const hasGpu = async () => {
    try {
      return !!(await navigator.gpu?.requestAdapter());
    } catch {
      return false;
    }
  };
  const ready = () =>
    (loading ??= (async () => {
      const t0 = performance.now();
      state.stage = "loading";
      const res = await fetch("/lib/model.onnx");
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || "Couldn't get the separation model (HTTP " + res.status + ")");
      const model = new Uint8Array(await res.arrayBuffer());
      // On the graphics card where there is one (about 30 times faster, and the processor is left to the
      // music), else on most of the processor, not all of it: the music is playing meanwhile
      if (await hasGpu()) {
        try {
          ort = await import(location.origin + "/lib/ort.webgpu.min.mjs");
          ort.env.wasm.wasmPaths = location.origin + "/lib/";
          ort.env.wasm.numThreads = 1;
          session = await ort.InferenceSession.create(model, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
          // (its first run sets the card up, some seconds: done now, not in the middle of a mashup)
          const n = Stems.SHAPE.reduce((a, b) => a * b, 1);
          await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", new Float32Array(n), Stems.SHAPE) });
          backend = "webgpu";
        } catch (err) {
          console.warn("Vocal separator: the graphics card didn't work out, using the processor", err);
          session = undefined;
        }
      }
      if (!session) {
        ort = await import(location.origin + "/lib/ort.wasm.min.mjs");
        ort.env.wasm.wasmPaths = location.origin + "/lib/";
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)) : 1;
        session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
        backend = "wasm";
      }
      state.stage = "ready";
      return { threads: ort.env.wasm.numThreads, ms: Math.round(performance.now() - t0), backend };
    })().catch((err) => {
      loading = undefined;
      state.stage = "idle";
      throw err;
    }));
  const run = async (picture) => {
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", picture, Stems.SHAPE) });
    return out[session.outputNames[0]].data;
  };
  // (The network's answer comes out a touch quiet: measured against a known voice, by this much)
  const LEVEL = 1.02;
  let queue = Promise.resolve();
  const separate = (job) => {
    const mine = queue.then(async () => {
      await ready();
      const t0 = performance.now();
      const res = await fetch("/blob/" + job);
      if (!res.ok) throw new Error("The sound to separate isn't there (" + job + ")");
      const pcm = new Int16Array(await res.arrayBuffer());
      const n = pcm.length >> 1;
      const left = new Float32Array(n);
      const right = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        left[i] = pcm[2 * i] / 32768;
        right[i] = pcm[2 * i + 1] / 32768;
      }
      state.stage = "separating";
      state.progress = 0;
      try {
        const voice = await Stems.separate(left, right, run, LEVEL, (p) => (state.progress = p));
        const out = new Int16Array(2 * n);
        for (let i = 0; i < n; i++) {
          out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(voice.left[i] * 32768)));
          out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(voice.right[i] * 32768)));
        }
        const put = await fetch("/blob/" + job + ".v", { method: "POST", body: out.buffer });
        if (!put.ok) throw new Error("Couldn't hand the voice back");
      } finally {
        state.stage = "ready";
      }
      return { ms: Math.round(performance.now() - t0), seconds: n / 44100, threads: ort.env.wasm.numThreads, backend };
    });
    queue = mine.catch(() => {});
    return mine;
  };
  window.__stems = { state, ready, separate };
})();
