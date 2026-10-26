// Ranking: taste clusters, a learned scoring model, calibrated + diverse selection, and flow ordering.
import { markDirty, state } from "./db";
import { dot, normalize } from "./tagspace";
import { feelVector } from "./vectors";
import { titleKey, type Profile } from "./profile";
import type { Track } from "./types";

// ------------------ FEATURES ------------------
export const FEATURES = [
  "bias",
  "sem", // kNN similarity to what you love (embedding space)
  "cluster", // closeness to the centre of one of your taste clusters
  "neg", // closer to what you skip than to what you love
  "graph", // collaborative support: how strongly TIDAL/Last.fm link it to your seeds
  "sources", // how many independent sources agree
  "artistAff", // you already like this artist
  "newArtist", // an artist you've never heard
  "skipRate", // you tend to skip this artist
  "popFit", // popularity matches your usual range
  "bpmFit",
  "fresh", // recent release
  "tidalPick", // TIDAL's own discovery/new release mixes picked it too
  "lastfm", // Last.fm listeners connect it to your taste
  "noVec", // no description available (lets the model learn how much to trust those)
  "feel", // mood, tempo and mode close to what you love (beyond genre)
] as const;

// Hand-tuned starting point; the online learner moves away from it as feedback comes in
export const PRIOR = [-4.2, 2.3, 0.9, -2.5, 2.2, 0.8, 0.6, 0.4, -1.8, 0.7, 0.25, 0.35, 0.35, 0.35, -0.3, 1.4];

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const weights = () => (state.weights?.length === PRIOR.length ? state.weights : (state.weights = [...PRIOR]));

const logit = (x: number[], explore: number) => {
  const w = weights();
  let z = 0;
  for (let i = 0; i < w.length; i++) z += w[i] * x[i];
  // Exploration slider: trade familiar artists for new ones
  const e = explore - 0.4;
  return z + 1.6 * e * x[7] - 1.2 * e * x[6];
};

// ------------------ ONLINE LEARNING ------------------
// Logistic regression, one SGD step per outcome, L2-pulled towards the prior so a handful of skips on a
// bad day can't wreck it. Repeated plays of the same pick count up to 3 times.
const LR = 0.08;
const L2 = 0.02;
const seen = new Map<string, number>();
export const learnFromOutcome = (id: string, y: number, weight = 1) => {
  const rec = state.recommended[id];
  if (!rec || rec.x.length !== PRIOR.length) return;
  const n = seen.get(id) ?? 0;
  if (n >= 3) return;
  seen.set(id, n + 1);
  const w = weights();
  const p = sigmoid(rec.x.reduce((s, xi, i) => s + w[i] * xi, 0));
  for (let i = 0; i < w.length; i++) w[i] -= LR * weight * ((p - y) * rec.x[i] + L2 * (w[i] - PRIOR[i]));
  rec.learned = 1;
  state.trainedExamples++;
  markDirty("state");
};

// ------------------ CLUSTERING ------------------
export type Cluster = { centroid: Float32Array; weight: number; members: { id: string; w: number }[]; label: string };

/** Spherical weighted k-means++: groups your loved tracks into distinct tastes */
export const clusterSeeds = (points: { id: string; w: number; v: Float32Array }[]): Cluster[] => {
  if (points.length === 0) return [];
  const k = points.length < 12 ? 1 : Math.max(2, Math.min(6, Math.round(Math.sqrt(points.length / 6))));
  const dims = points[0].v.length;

  // k-means++ init, weighted. Several restarts, keeping the tightest result, so the clusters (and their
  // names) don't reshuffle from one day to the next just because of a different random start
  const pick = (scores: number[]) => {
    const total = scores.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < scores.length; i++) if ((r -= scores[i]) <= 0) return i;
    return scores.length - 1;
  };
  const once = () => {
    const centroids: Float32Array[] = [Float32Array.from(points[pick(points.map((p) => p.w))].v)];
    while (centroids.length < k) {
      centroids.push(Float32Array.from(points[pick(points.map((p) => p.w * Math.max(0, 1 - Math.max(...centroids.map((c) => dot(c, p.v)))) ** 2))].v));
    }
    let assign = new Array<number>(points.length).fill(-1);
    let cost = 0;
    for (let iter = 0; iter < 30; iter++) {
      cost = 0;
      const next = points.map((p) => {
        let best = 0;
        let bestSim = -Infinity;
        centroids.forEach((c, i) => {
          const s = dot(c, p.v);
          if (s > bestSim) (bestSim = s), (best = i);
        });
        cost += p.w * (1 - bestSim);
        return best;
      });
      const changed = next.some((a, i) => a !== assign[i]);
      assign = next;
      if (!changed) break;
      centroids.forEach((_, ci) => {
        const sum = new Float32Array(dims);
        points.forEach((p, pi) => {
          if (assign[pi] !== ci) return;
          for (let d = 0; d < dims; d++) sum[d] += p.v[d] * p.w;
        });
        if (sum.some((x) => x !== 0)) centroids[ci] = normalize(sum);
      });
    }
    return { centroids, assign, cost };
  };
  let bestRun = once();
  for (let r = 1; r < 8; r++) {
    const run = once();
    if (run.cost < bestRun.cost) bestRun = run;
  }
  const { centroids, assign } = bestRun;

  let clusters: Cluster[] = centroids.map((centroid, ci) => {
    const members = points.filter((_, pi) => assign[pi] === ci).map((p) => ({ id: p.id, w: p.w }));
    return { centroid, weight: members.reduce((s, m) => s + m.w, 0), members, label: "" };
  });
  // Fold tiny clusters into their nearest neighbour
  const total = clusters.reduce((s, c) => s + c.weight, 0);
  const tiny = clusters.filter((c) => c.weight / total < 0.04 || c.members.length < 3);
  clusters = clusters.filter((c) => !tiny.includes(c));
  if (clusters.length === 0) return [{ centroid: normalize(centroids[0]), weight: total, members: points.map((p) => ({ id: p.id, w: p.w })), label: "" }];
  for (const t of tiny) {
    const near = clusters.reduce((a, b) => (dot(a.centroid, t.centroid) >= dot(b.centroid, t.centroid) ? a : b));
    near.members.push(...t.members);
    near.weight += t.weight;
  }
  return clusters.sort((a, b) => b.weight - a.weight);
};

// ------------------ SCORING ------------------
export type Candidate = {
  t: Track;
  vec: Float32Array | null;
  graph: number;
  sources: Set<string>;
  x?: number[];
  score?: number;
  cluster?: number;
};

const percentileScaler = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 3) return (v: number) => v;
  const lo = sorted[Math.floor(sorted.length * 0.05)];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  return (v: number) => (hi - lo < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
};

const gauss = (v: number | undefined, d: { mean: number; std: number } | null, minStd: number) => {
  if (v === undefined || !d) return 0.5;
  const s = Math.max(d.std * 1.5, minStd);
  return Math.exp(-((v - d.mean) ** 2) / (2 * s * s));
};

export const scoreCandidates = (
  cands: Candidate[],
  profile: Profile,
  seedVecs: { id: string; w: number; v: Float32Array }[],
  negVecs: { w: number; v: Float32Array }[],
  clusters: Cluster[],
  explore: number,
) => {
  const now = Date.now();
  const seedFeels = seedVecs.map((s) => ({ w: s.w, f: feelVector(s.id, s.v) })).filter((s): s is { w: number; f: Float32Array } => !!s.f);
  const feelOf = (c: Candidate) => {
    const f = feelVector(c.t.id, c.vec);
    if (!f || !seedFeels.length) return NaN;
    const sims = seedFeels.map((s) => ({ s: dot(s.f, f), w: s.w })).sort((a, b) => b.s - a.s).slice(0, 8);
    return sims.reduce((t, x) => t + x.s * Math.sqrt(x.w), 0) / Math.max(1e-9, sims.reduce((t, x) => t + Math.sqrt(x.w), 0));
  };
  const feels = cands.map(feelOf);
  const feelS = percentileScaler(feels);
  const raw = cands.map((c) => {
    if (!c.vec) return { sem: NaN, cl: NaN, neg: NaN, cluster: -1 };
    // kNN: mean of the 5 closest loved tracks, weighted by how much you love them
    const sims = seedVecs.map((s) => ({ s: dot(s.v, c.vec!), w: s.w }));
    sims.sort((a, b) => b.s - a.s);
    const top = sims.slice(0, 5);
    const sem = top.reduce((s, x) => s + x.s * Math.sqrt(x.w), 0) / Math.max(1e-9, top.reduce((s, x) => s + Math.sqrt(x.w), 0));
    let cl = -Infinity;
    let cluster = -1;
    clusters.forEach((k, i) => {
      const s = dot(k.centroid, c.vec!);
      if (s > cl) (cl = s), (cluster = i);
    });
    const negs = negVecs.map((n) => dot(n.v, c.vec!) * Math.sqrt(n.w)).sort((a, b) => b - a);
    // (negative weights are ≤ 1, so a weak skip signal can't outweigh a strong match)
    const neg = negs.length ? negs.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, negs.length) : NaN;
    return { sem, cl, neg, cluster };
  });
  const semS = percentileScaler(raw.map((r) => r.sem));
  const clS = percentileScaler(raw.map((r) => r.cl));
  const gMax = Math.log1p(Math.max(1e-9, ...cands.map((c) => c.graph)));

  cands.forEach((c, i) => {
    const r = raw[i];
    const t = c.t;
    const lead = t.artists[0]?.id ?? "";
    const rel = Date.parse(t.album?.releaseDate ?? "");
    const age = Number.isFinite(rel) ? now - rel : Infinity;
    const has = (re: RegExp) => [...c.sources].some((s) => re.test(s));
    c.x = [
      1,
      Number.isNaN(r.sem) ? 0 : semS(r.sem),
      Number.isNaN(r.cl) ? 0 : clS(r.cl),
      // Only counts when a track resembles your skips more than your favourites
      Number.isNaN(r.neg) ? 0 : Math.max(0, Math.min(1, (r.neg - r.sem + 0.05) / 0.25)),
      Math.log1p(c.graph) / gMax,
      Math.min(1, new Set([...c.sources].map((s) => s.split(":")[0])).size / 4),
      Math.max(...t.artists.map((a) => profile.artistAffinity.get(a.id) ?? 0), 0),
      t.artists.every((a) => !profile.artistFamiliarity.has(a.id)) ? 1 : 0,
      profile.artistSkipRate.get(lead) ?? 0,
      gauss(t.popularity, profile.pop, 0.08),
      gauss(t.bpm, profile.bpm, 10),
      age < 180 * 864e5 ? 1 : age < 730 * 864e5 ? 0.5 : 0,
      has(/^tidal-(dd|newrel)/) ? 1 : 0,
      has(/^lastfm/) ? 1 : 0,
      c.vec ? 0 : 1,
      Number.isNaN(feels[i]) ? 0 : feelS(feels[i]),
    ].map((v) => Math.round(v * 1000) / 1000);
    c.score = sigmoid(logit(c.x, explore));
    c.cluster = r.cluster;
  });
  return cands;
};

// ------------------ SELECTION ------------------
// Calibrated: every taste cluster gets a share of the playlist (tempered, so minority tastes aren't
// drowned out by the dominant one, per Spotify's multi-faceted interest research). Diverse: MMR keeps
// near-duplicates out, one track per artist and per album.
export const selectPlaylist = (
  cands: Candidate[],
  clusters: Cluster[],
  size: number,
  explore: number,
  isKnownArtist: (c: Candidate) => boolean = () => false,
  knownCap = size,
) => {
  const chosen: Candidate[] = [];
  let known = 0;
  const usedArtists = new Set<string>();
  const usedAlbums = new Set<string>();
  const usedTitles = new Set<string>();
  const ok = (c: Candidate) =>
    !c.t.artists.some((a) => usedArtists.has(a.id)) &&
    !(c.t.album && usedAlbums.has(c.t.album.id)) &&
    !usedTitles.has(titleKey(c.t)) &&
    (known < knownCap || !isKnownArtist(c));
  const take = (c: Candidate) => {
    chosen.push(c);
    if (isKnownArtist(c)) known++;
    c.t.artists.forEach((a) => usedArtists.add(a.id));
    if (c.t.album) usedAlbums.add(c.t.album.id);
    usedTitles.add(titleKey(c.t));
  };
  // Relevance in log-odds: near the top, 97% vs 94% is a real difference that raw probabilities hide
  const rel = (c: Candidate) => Math.log(Math.max(1e-6, c.score!) / Math.max(1e-6, 1 - c.score!));
  const mmr = (c: Candidate) => {
    if (!c.vec) return rel(c);
    let maxSim = 0;
    for (const s of chosen) if (s.vec) maxSim = Math.max(maxSim, dot(s.vec, c.vec));
    return rel(c) - 1.2 * Math.max(0, maxSim - 0.6);
  };
  const best = (pool: Candidate[], floor = -Infinity) => {
    let top: Candidate | undefined;
    let topV = -Infinity;
    for (const c of pool.slice(0, 120)) {
      if (!ok(c) || rel(c) < floor) continue;
      const v = mmr(c);
      if (v > topV) (topV = v), (top = c);
    }
    return top;
  };

  const sorted = [...cands].sort((a, b) => b.score! - a.score!);
  const wildShare = 0.1 + 0.15 * explore;
  const calibrated = Math.round(size * (1 - wildShare));
  const shares = clusters.map((c) => Math.pow(c.weight, 0.7));
  const shareSum = shares.reduce((a, b) => a + b, 0) || 1;
  // Largest remainder apportionment
  const exact = shares.map((s) => (s / shareSum) * calibrated);
  const quota = exact.map(Math.floor);
  const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; quota.reduce((a, b) => a + b, 0) < calibrated && i < order.length; i++) quota[order[i][1]]++;

  const pools = clusters.map((_, k) => sorted.filter((c) => c.cluster === k));
  // A taste's slot is only worth filling with something genuinely good; otherwise it goes to the
  // best track overall instead of a weak one that merely sits in the right cluster
  const floor = sorted.length ? rel(sorted[0]) - 2 : -Infinity;
  // Round-robin so every cluster gets its best picks before any cluster gets its 5th
  let progress = true;
  while (progress && chosen.length < calibrated) {
    progress = false;
    pools.forEach((pool, k) => {
      if (quota[k] <= 0 || chosen.length >= calibrated) return;
      const c = best(
        pool.filter((p) => !chosen.includes(p)),
        floor,
      );
      if (!c) return void (quota[k] = 0);
      take(c);
      quota[k]--;
      progress = true;
    });
  }
  // Wildcards + anything a thin cluster couldn't fill: best remaining overall
  while (chosen.length < size) {
    const c = best(sorted.filter((p) => !chosen.includes(p)));
    if (!c) break;
    take(c);
  }
  return chosen;
};

// ------------------ ORDERING ------------------
// Camelot wheel, like a DJ: neighbouring keys (same number, or ±1 in the same mode) mix harmonically
const PITCH = ["C", "CSharp", "D", "Eb", "E", "F", "FSharp", "G", "Ab", "A", "Bb", "B"];
const camelot = (t: { key?: string; keyScale?: string }) => {
  const p = PITCH.indexOf(t.key ?? "");
  if (p < 0 || (t.keyScale !== "MAJOR" && t.keyScale !== "MINOR")) return null;
  // Major: C = 8B, each fifth up is +1. Minor: A minor = 8A, same numbering from the relative major
  const fromMajor = t.keyScale === "MAJOR" ? p : (p + 3) % 12;
  return { n: ((fromMajor * 7) % 12 + 7) % 12 + 1, minor: t.keyScale === "MINOR" };
};
const keyClash = (a: Candidate, b: Candidate) => {
  const ka = camelot(a.t);
  const kb = camelot(b.t);
  if (!ka || !kb) return 0.3;
  const step = Math.min(Math.abs(ka.n - kb.n), 12 - Math.abs(ka.n - kb.n));
  if (step === 0) return 0;
  return step === 1 && ka.minor === kb.minor ? 0.1 : 1;
};

// Open with the strongest pick, then walk to whatever flows best from the previous track
// (similar sound, close tempo, compatible key) while keeping strong picks early.
export const sequence = (picks: Candidate[]) => {
  if (picks.length < 3) return picks;
  const maxScore = Math.max(...picks.map((p) => p.score!));
  const left = [...picks];
  const first = left.reduce((a, b) => (a.score! >= b.score! ? a : b));
  const out = [first];
  left.splice(left.indexOf(first), 1);
  while (left.length) {
    const prev = out[out.length - 1];
    const pos = out.length / picks.length;
    let top = left[0];
    let topV = -Infinity;
    for (const c of left) {
      const sim = prev.vec && c.vec ? dot(prev.vec, c.vec) : 0.4;
      const tempo = prev.t.bpm && c.t.bpm ? Math.min(1, Math.abs(prev.t.bpm - c.t.bpm) / 40) : 0.3;
      // Same cluster back to back is fine, but not three in a row
      const run = out.length >= 2 && out[out.length - 2].cluster === prev.cluster && prev.cluster === c.cluster ? 0.15 : 0;
      const v = 0.45 * sim + (0.45 - 0.25 * pos) * (c.score! / maxScore) - 0.15 * tempo - 0.08 * keyClash(prev, c) - run;
      if (v > topV) (topV = v), (top = c);
    }
    out.push(top);
    left.splice(left.indexOf(top), 1);
  }
  return out;
};
