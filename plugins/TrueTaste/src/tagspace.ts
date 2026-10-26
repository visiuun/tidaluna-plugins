// The taste space: MiniLM sentence embeddings of ~6000 music tags ("dream pop", "uk garage",
// "melancholic"...), computed offline (scripts/buildTagVectors.ts), PCA-reduced and int8-quantised.
// "slowcore" lands next to "sadcore" and "dream pop" near "shoegaze" with zero words in common, and
// TIDAL never has to load an AI runtime: just a table lookup, so no memory or CPU cost while you listen.
import tagvec from "file://../assets/tagvec.bin?base64";

type Space = { dims: number; vecs: Int8Array; index: Map<string, number>; words: Map<string, number> };
let space: Space | null = null;

/** "Hip-Hop", "hip hop", "hip_hop" → "hip hop" */
export const normTag = (t: string) =>
  t
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}& ]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const load = (): Space => {
  if (space) return space;
  const bin = atob(tagvec);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "DDTV") throw new Error("Bad tag vector asset");
  const count = view.getUint32(4, true);
  const dims = view.getUint16(8, true);
  const vecs = new Int8Array(bytes.buffer, 12, count * dims);
  const names = new TextDecoder().decode(bytes.subarray(12 + count * dims)).split("\n");
  const index = new Map<string, number>();
  const words = new Map<string, number>();
  names.forEach((name, i) => {
    const key = normTag(name);
    // Vocabulary is sorted by usage: first spelling wins
    if (!index.has(key)) index.set(key, i);
    if (!key.includes(" ") && !words.has(key)) words.set(key, i);
  });
  return (space = { dims, vecs, index, words });
};

export const tagSpaceSize = () => load().index.size;

const add = (out: Float32Array, s: Space, i: number, w: number) => {
  const o = i * s.dims;
  for (let d = 0; d < s.dims; d++) out[d] += (s.vecs[o + d] / 127) * w;
};

/**
 * Vector for a tag: exact match, else composed from the known phrases/words inside it
 * ("japanese city pop" → "city pop" + "japanese"). Unknown tags return null.
 */
export const tagVector = (tag: string): Float32Array | null => {
  const s = load();
  const key = normTag(tag);
  const exact = s.index.get(key);
  const out = new Float32Array(s.dims);
  if (exact !== undefined) {
    add(out, s, exact, 1);
    return out;
  }
  const parts = key.split(" ");
  let found = 0;
  for (let i = 0; i < parts.length; i++) {
    // Prefer two-word phrases, then single words
    const pair = i + 1 < parts.length ? s.index.get(`${parts[i]} ${parts[i + 1]}`) : undefined;
    if (pair !== undefined) {
      add(out, s, pair, 1);
      found++;
      i++;
      continue;
    }
    const word = s.words.get(parts[i]);
    if (word !== undefined && parts[i].length > 2) {
      add(out, s, word, 0.7);
      found++;
    }
  }
  return found ? out : null;
};

export const normalize = (v: Float32Array) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
};

export const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
