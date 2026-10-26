// Where a track sits in the taste space: its artists' weighted tags (lead artist counts most) plus the
// track's own TIDAL genres and tone tags, mixed by weight.
import { tracks } from "./db";
import { artistTagWeights } from "./profile";
import { normalize, tagVector } from "./tagspace";

const cache = new Map<string, Float32Array | null>();
const vectorOf = (tag: string) => {
  if (!cache.has(tag)) cache.set(tag, tagVector(tag));
  return cache.get(tag)!;
};

export const trackVector = (id: string): Float32Array | null => {
  const t = tracks[id];
  if (!t) return null;
  const mix = new Map<string, number>();
  const add = (tag: string, w: number) => mix.set(tag, (mix.get(tag) ?? 0) + w);
  t.artists.forEach((a, i) => {
    const share = i === 0 ? 1 : 0.35 / (t.artists.length - 1);
    for (const [tag, w] of artistTagWeights(a.id)) add(tag, w * share);
  });
  const artistMass = [...mix.values()].reduce((s, w) => s + w, 0);
  const own = [...new Set([...t.genres, ...t.tones].map((x) => x.toLowerCase()))].filter((x) => x !== "unknown");
  // TIDAL's own genres are on nearly every track, so they carry real weight next to the artist's tags
  for (const tag of own) add(tag, artistMass > 0 ? (0.45 * artistMass) / own.length : 1);

  let v: Float32Array | null = null;
  for (const [tag, w] of mix) {
    const e = vectorOf(tag);
    if (!e) continue;
    v ??= new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) v[i] += e[i] * w;
  }
  return v && normalize(v);
};

// ------------------ FEEL ------------------
// Genre says what a track is; feel says what it's like to listen to. Each track is projected onto mood
// axes in the same embedding space, then combined with tempo and major/minor mode, so a melancholic
// house track and a melancholic indie track can match even though their genres don't.
const MOODS = ["energetic", "chill", "dark", "happy", "melancholic", "aggressive", "dreamy", "romantic", "party", "euphoric", "atmospheric", "groovy", "hypnotic", "sad"];
let moodAxes: Float32Array[] | null = null;
const axes = () => (moodAxes ??= MOODS.map((m) => tagVector(m)).filter((v): v is Float32Array => !!v).map((v) => normalize(v)));

export const feelVector = (id: string, vec: Float32Array | null): Float32Array | null => {
  const t = tracks[id];
  if (!vec || !t) return null;
  const moods = axes().map((a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * vec[i];
    return s;
  });
  // Relative mood profile: which moods stand out for this track, not how "musical" it is overall
  const mean = moods.reduce((a, b) => a + b, 0) / Math.max(1, moods.length);
  const out = new Float32Array(moods.length + 2);
  moods.forEach((m, i) => (out[i] = (m - mean) * 4));
  if (t.bpm) out[moods.length] = Math.max(-1.5, Math.min(1.5, (t.bpm - 120) / 40)) * 0.6;
  if (t.keyScale === "MINOR" || t.keyScale === "MAJOR") out[moods.length + 1] = t.keyScale === "MINOR" ? 0.35 : -0.35;
  return normalize(out);
};

export const trackVectors = (ids: string[]) => {
  const out = new Map<string, Float32Array>();
  for (const id of new Set(ids)) {
    const v = trackVector(id);
    if (v) out.set(id, v);
  }
  return out;
};
