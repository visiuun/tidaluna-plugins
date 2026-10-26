// Builds assets/tagvec.bin: MiniLM (all-MiniLM-L6-v2) embeddings for the music-tag vocabulary,
// PCA-reduced and int8-quantised. Precomputing means TIDAL never has to load an AI runtime: running
// ONNX inside TIDAL's renderer next to other plugins could run it out of memory.
//
// Usage (needs a vocab.json of [tag, artistCount, weight] from a Last.fm crawl):
//   npm i @huggingface/transformers@4.3.1   (in a scratch folder)
//   npx tsx buildTagVectors.ts <vocab.json> <out tagvec.bin> [maxTags=6000] [dims=128]
//
// Format (little endian): "DDTV" | u32 count | u16 dims | u16 0 | Int8[count*dims] | utf8 names joined by "\n"
// @ts-ignore installed in a scratch folder when regenerating, not a dependency of the plugin
import { pipeline } from "@huggingface/transformers";
import { readFileSync, writeFileSync } from "fs";

const [vocabPath, outPath, maxArg, dimsArg] = process.argv.slice(2);
const MAX = Number(maxArg ?? 6000);
const DIMS = Number(dimsArg ?? 128);

const main = async () => {
  const vocab = (JSON.parse(readFileSync(vocabPath, "utf8")) as [string, number, number][]).slice(0, MAX).map(([t]) => t);
  const extractor: any = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });

  const X: Float32Array[] = [];
  for (let i = 0; i < vocab.length; i += 64) {
    const out = await extractor(
      vocab.slice(i, i + 64).map((t) => `music: ${t}`),
      { pooling: "mean", normalize: true },
    );
    const D = out.dims[1];
    for (let j = 0; j < out.dims[0]; j++) X.push(new Float32Array(out.data.subarray(j * D, (j + 1) * D)));
    if (i % 1024 === 0) console.log(`embedded ${i}/${vocab.length}`);
  }
  const D = X[0].length;

  // Centre: removes the direction every "music: …" string shares, which otherwise squashes all
  // similarities into a narrow high band
  const mean = new Float64Array(D);
  for (const x of X) for (let d = 0; d < D; d++) mean[d] += x[d] / X.length;
  const C = X.map((x) => Float64Array.from(x, (v, d) => v - mean[d]));

  // PCA via power iteration with deflation on the covariance matrix
  const cov = Array.from({ length: D }, () => new Float64Array(D));
  for (const c of C) for (let a = 0; a < D; a++) for (let b = a; b < D; b++) cov[a][b] += c[a] * c[b];
  for (let a = 0; a < D; a++) for (let b = 0; b < a; b++) cov[a][b] = cov[b][a];
  let total = 0;
  for (let a = 0; a < D; a++) total += cov[a][a];
  const comps: Float64Array[] = [];
  let kept = 0;
  for (let k = 0; k < DIMS; k++) {
    let v = Float64Array.from({ length: D }, () => Math.random() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 200; it++) {
      const w = new Float64Array(D);
      for (let a = 0; a < D; a++) {
        let s = 0;
        for (let b = 0; b < D; b++) s += cov[a][b] * v[b];
        w[a] = s;
      }
      const n = Math.hypot(...w);
      lambda = n;
      v = w.map((x) => x / n);
    }
    for (let a = 0; a < D; a++) for (let b = 0; b < D; b++) cov[a][b] -= lambda * v[a] * v[b];
    comps.push(v);
    kept += lambda;
  }
  console.log(`PCA ${D}→${DIMS}: ${((100 * kept) / total).toFixed(1)}% of variance kept`);

  const header = Buffer.alloc(12);
  header.write("DDTV", 0, "ascii");
  header.writeUInt32LE(vocab.length, 4);
  header.writeUInt16LE(DIMS, 8);
  const vecs = new Int8Array(vocab.length * DIMS);
  C.forEach((c, i) => {
    const p = comps.map((v) => v.reduce((s, vi, d) => s + vi * c[d], 0));
    const n = Math.hypot(...p) || 1;
    p.forEach((x, k) => (vecs[i * DIMS + k] = Math.max(-127, Math.min(127, Math.round((x / n) * 127)))));
  });
  writeFileSync(outPath, Buffer.concat([header, Buffer.from(vecs.buffer), Buffer.from(vocab.join("\n"), "utf8")]));
  console.log(`wrote ${vocab.length} tags × ${DIMS} dims to ${outPath}`);
};
main();
