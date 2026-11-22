// Immersive Bloom's listener. Runs in a worker of its own (TIDAL's page only gets the result, a few hundred kB).
//
// TIDAL plays through a player outside its page, so there is no sound in the page to listen to. The track's own
// stream (TIDAL's DASH copy in AAC, the one its web player uses) is fetched here instead, segment by segment,
// unpacked from its MP4 boxes and decoded with WebCodecs as it arrives, and every 10 ms of it is measured on the
// way through: the decoded sound is never kept, only a few numbers per band, so a whole track never sits in
// TIDAL's memory (a 32-bit app). Once the track is through, those numbers become, for every 10 ms, how much
// sound comes from each of 48 directions around you, which is what the page draws.
//
// WHERE A SOUND IS. A stereo track is two signals; what they have in common, and how, says where each sound
// was put. Per frequency band, from the left/right powers and their cross-power (L·R*):
//   left/right  (|R|² − |L|²) / (|L|² + |R|²)        how far it is panned (the level difference)
//   front/back  2·Re(L·R*) / (|L|² + |R|²)            in phase: in front; in antiphase: behind (what a Dolby
//                                                     Surround decoder sends to the rear speakers)
//   (and below 1.1 kHz, 2·Im(L·R*) / (…): one side ahead in time, the way a binaural recording places a sound)
// These are averaged over neighbouring frequencies and a few tens of ms, so a sound that really comes from
// somewhere keeps its direction (the vector stays long) while reverb, room and wide pads, which have no one
// direction, cancel out (the vector shrinks) and are left out. Sound straight ahead, in the middle (the vocal,
// the kick, the bass of almost every song) is not 3D and is left out too: only what is off to a side, behind,
// or out of phase counts. Height has no cue of its own in two channels; higher-pitched sounds are heard as
// higher (the Pratt effect, and what the ear's own filtering does with height), so a sound's pitch lifts or
// lowers it as far as the "height" setting says.
"use strict";

const FPS = 100;
const N = 1024;
const NBINS = 48;
const NBANDS_TARGET = 28;
const S = 9; // values kept per band and frame (see createAnalyzer)
const GAP = 3; // bins apart that the delay between the channels is measured over

// ------------------ FFT ------------------
const LOG2N = Math.log2(N);
const REV = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(N / 2);
const SIN = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / N);
  SIN[i] = -Math.sin((2 * Math.PI * i) / N);
}
const WIN = new Float64Array(N);
for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N);
const re = new Float64Array(N);
const im = new Float64Array(N);
const fft = () => {
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j;
        const b = a + half;
        const tr = re[b] * COS[k] - im[b] * SIN[k];
        const ti = re[b] * SIN[k] + im[b] * COS[k];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
};

// ------------------ BANDS ------------------
// Log-spaced from 60 Hz to 18 kHz, at least two FFT bins each (the lowest ones are merged until they are)
const makeBands = (sr) => {
  const df = sr / N;
  const fLo = 60;
  const fHi = Math.min(18000, sr * 0.47);
  const raw = [];
  for (let k = 1; k < N / 2; k++) {
    const f = k * df;
    if (f < fLo || f > fHi) continue;
    const b = Math.min(NBANDS_TARGET - 1, Math.floor((NBANDS_TARGET * Math.log(f / fLo)) / Math.log(fHi / fLo)));
    (raw[b] ??= []).push(k);
  }
  const groups = [];
  let acc = [];
  for (const g of raw) {
    if (!g) continue;
    acc = acc.concat(g);
    if (acc.length >= 2) {
      groups.push(acc);
      acc = [];
    }
  }
  if (acc.length) groups.length ? (groups[groups.length - 1] = groups[groups.length - 1].concat(acc)) : groups.push(acc);
  const bandOf = new Int16Array(N / 2).fill(-1);
  const fc = new Float64Array(groups.length);
  const width = new Int16Array(groups.length);
  const first = new Int16Array(groups.length);
  const last = new Int16Array(groups.length);
  groups.forEach((g, b) => {
    for (const k of g) bandOf[k] = b;
    first[b] = g[0];
    last[b] = g[g.length - 1];
    fc[b] = Math.sqrt(g[0] * g[g.length - 1]) * df;
    width[b] = g.length;
  });
  return { bandOf, fc, width, first, last, nb: groups.length };
};

// ------------------ THE ANALYSER ------------------
/**
 * Fed decoded sound (left, right) in order; `finish` gives the directions. `expectedSeconds` only sizes the store.
 * opts.height: 0-1, how far pitch lifts and lowers a sound
 */
const createAnalyzer = (sr, expectedSeconds, opts) => {
  const hop = Math.max(1, Math.round(sr / FPS));
  const fps = sr / hop;
  const bands = makeBands(sr);
  const NB = bands.nb;
  const RING = 1 << 16;
  const MASK = RING - 1;
  const ringL = new Float32Array(RING);
  const ringR = new Float32Array(RING);
  let got = 0; // samples received
  let next = 0; // next frame to measure (its window is centred on next·hop)
  let cap = Math.ceil((expectedSeconds + 5) * fps) + 16;
  // Per frame, per band (S values): |L|², |R|², the cross-power L·R* (re, im), and the cross-power of that between
  // bins GAP apart (re, im: the delay between the channels) and its magnitude
  let stats = new Float32Array(cap * NB * S);
  const acc = new Float64Array(NB * S);
  const xr = new Float64Array(N / 2);
  const xi = new Float64Array(N / 2);
  const df = sr / N;

  const measure = (end) => {
    const c = next * hop;
    const start = c - N / 2;
    for (let i = 0; i < N; i++) {
      const s = start + i;
      const ok = s >= 0 && s < end;
      const w = WIN[i];
      const j = REV[i];
      re[j] = ok ? ringL[s & MASK] * w : 0;
      im[j] = ok ? ringR[s & MASK] * w : 0;
    }
    fft();
    acc.fill(0);
    const { bandOf, first, last } = bands;
    // Both channels from one complex FFT (left in the real part, right in the imaginary part)
    for (let k = 1; k < N / 2; k++) {
      const b = bandOf[k];
      if (b < 0) continue;
      const zr = re[k];
      const zi = im[k];
      const wr = re[N - k];
      const wi = im[N - k];
      const lr = (zr + wr) * 0.5;
      const li = (zi - wi) * 0.5;
      const rr = (zi + wi) * 0.5;
      const ri = (wr - zr) * 0.5;
      const o = b * S;
      acc[o] += lr * lr + li * li;
      acc[o + 1] += rr * rr + ri * ri;
      // L·R*
      xr[k] = lr * rr + li * ri;
      xi[k] = li * rr - lr * ri;
    }
    for (let b = 0; b < NB; b++) {
      const o = b * S;
      // The delay between the channels in this band: how fast the phase of L·R* turns across it (measured over
      // bins `gap` apart, where the turn is bigger than the noise in each bin's phase; good to ±3.9 ms)
      const gap = Math.min(GAP, last[b] - first[b]);
      let sumR = 0;
      let sumI = 0;
      let dr = 0;
      let di = 0;
      let da = 0;
      // (and over neighbouring bins: coarser, but good to ±11.6 ms. A longer delay, which neither can measure,
      // comes out of the two as two different ones, and is then not taken for one)
      let er = 0;
      let ei = 0;
      for (let k = first[b]; k <= last[b]; k++) {
        sumR += xr[k];
        sumI += xi[k];
        if (k + 1 <= last[b]) {
          er += xr[k] * xr[k + 1] + xi[k] * xi[k + 1];
          ei += xi[k] * xr[k + 1] - xr[k] * xi[k + 1];
        }
        if (k + gap > last[b]) continue;
        const j = k + gap;
        dr += xr[k] * xr[j] + xi[k] * xi[j];
        di += xi[k] * xr[j] - xr[k] * xi[j];
        da += Math.hypot(xr[k], xi[k]) * Math.hypot(xr[j], xi[j]);
      }
      acc[o + 2] = sumR;
      acc[o + 3] = sumI;
      acc[o + 4] = dr;
      acc[o + 5] = di;
      acc[o + 6] = da;
      acc[o + 7] = er;
      acc[o + 8] = ei;
    }
    if (next >= cap) {
      const grown = new Float32Array(cap * 2 * NB * S);
      grown.set(stats);
      stats = grown;
      cap *= 2;
    }
    stats.set(acc, next * NB * S);
    next++;
  };

  return {
    fps,
    push(L, R) {
      const n = L.length;
      for (let off = 0; off < n;) {
        const take = Math.min(n - off, RING - N * 2);
        for (let i = 0; i < take; i++) {
          ringL[(got + i) & MASK] = L[off + i];
          ringR[(got + i) & MASK] = R[off + i];
        }
        got += take;
        off += take;
        while (next * hop + N / 2 <= got) measure(got);
      }
    },
    finish() {
      while (next * hop < got) measure(got);
      return directions(stats.subarray(0, next * NB * S), next, NB, bands, fps, df, opts);
    },
    get seconds() {
      return got / sr;
    },
  };
};

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Forward then backward one-pole smoothing of a strided series (no delay either way) */
const smoothBoth = (arr, start, stride, count, alpha) => {
  let y = arr[start];
  for (let i = 0, p = start; i < count; i++, p += stride) arr[p] = y += alpha * (arr[p] - y);
  y = arr[start + (count - 1) * stride];
  for (let i = count - 1, p = start + i * stride; i >= 0; i--, p -= stride) arr[p] = y += alpha * (arr[p] - y);
};

// ------------------ FROM MEASUREMENTS TO DIRECTIONS ------------------
const directions = (stats, frames, NB, bands, fps, df, opts) => {
  const height = Math.max(0, Math.min(1, opts?.height ?? 0.5)) * 0.9;
  // A few tens of ms of averaging: longer for the narrow low bands, which have fewer bins to average over
  // Averaging a few numbers that point every which way never quite comes to nothing: what a band would show
  // of a direction from pure chance, for how much it averages over, is taken off (see \`direct\`)
  const chance = new Float64Array(NB);
  for (let b = 0; b < NB; b++) {
    const tauFrames = Math.min(9, Math.max(2.5, (3 * 8) / bands.width[b]));
    chance[b] = Math.min(0.5, 2.5 / (bands.width[b] * tauFrames));
    const alpha = 1 - Math.exp(-1 / tauFrames);
    for (let s = 0; s < 4; s++) smoothBoth(stats, b * S + s, NB * S, frames, alpha);
    // (the delay between the channels over longer: a sound holds its place for longer than that)
    const alphaD = 1 - Math.exp(-1 / (tauFrames * 2.5));
    for (let s = 4; s < S; s++) smoothBoth(stats, b * S + s, NB * S, frames, alphaD);
  }
  // Each band against its own average over the track (most of the way): a hard-panned hi-hat counts about as
  // much as a hard-panned bass, though the bass has a hundred times the power
  const mean = new Float64Array(NB);
  for (let f = 0; f < frames; f++) for (let b = 0; b < NB; b++) mean[b] += stats[(f * NB + b) * S] + stats[(f * NB + b) * S + 1];
  let top = 0;
  for (let b = 0; b < NB; b++) top = Math.max(top, (mean[b] /= Math.max(1, frames)));
  const inv = new Float64Array(NB);
  for (let b = 0; b < NB; b++) inv[b] = 1 / (Math.pow(Math.max(mean[b], top * 1e-3, 1e-12), 0.8) * Math.pow(Math.max(top, 1e-12), 0.2));
  const lift = new Float64Array(NB);
  for (let b = 0; b < NB; b++) lift[b] = Math.max(-1, Math.min(1, Math.log2(bands.fc[b] / 1500) / 2.5)) * height;

  const DEG = Math.PI / 180;
  // The most the ears hear between them (about 0.7 ms) is a sound all the way to one side
  const ITD_MAX = 0.0007;
  const H = new Float32Array(frames * NBINS);
  let spatialSum = 0;
  let totalSum = 0;
  for (let f = 0; f < frames; f++) {
    const row = f * NBINS;
    for (let b = 0; b < NB; b++) {
      const o = (f * NB + b) * S;
      const pl = stats[o];
      const pr = stats[o + 1];
      const e = pl + pr;
      if (e <= 1e-12) continue;
      const we = e * inv[b];
      totalSum += we;
      // Level difference, the in-phase (+) or inverted (-) part the two have in common, and what is left over
      const ild = (pr - pl) / e;
      const cr = (2 * stats[o + 2]) / e;
      const ci = (2 * stats[o + 3]) / e;
      // Time difference, as far as the band agrees on one (L first: the sound is on the left)
      const dr = stats[o + 4];
      const di = stats[o + 5];
      const da = stats[o + 6];
      let itd = 0;
      let delayed = 0;
      let cons = 0;
      if (da > 0) {
        const gap = Math.min(GAP, bands.last[b] - bands.first[b]);
        const tau = -Math.atan2(di, dr) / (2 * Math.PI * gap * df);
        const tau1 = -Math.atan2(stats[o + 8], stats[o + 7]) / (2 * Math.PI * df);
        // (how well the band agrees on that delay: a sound has one, a room or a wide pad has none; and a delay
        // too long to measure, which the two measures disagree on, is none either)
        cons = Math.min(1, Math.hypot(dr, di) / da) * (1 - smoothstep(0.00015, 0.0004, Math.abs(tau - tau1)));
        const sure = smoothstep(0.55, 0.85, cons);
        const t = Math.max(-1, Math.min(1, -tau / ITD_MAX));
        itd = t * sure;
        delayed = smoothstep(0.08, 0.25, Math.abs(t)) * sure;
      }
      const lat = Math.max(-1, Math.min(1, ild + itd * (1 - Math.abs(ild))));
      const ahead = Math.sqrt(Math.max(0, 1 - lat * lat));
      // Without a delay, in phase is in front and inverted behind (by the share of each). With one, the phase says
      // nothing about front or back (the delay turns it round and round across the band), and the ears can't
      // tell either: a delayed sound is taken as in front, as they take it
      const side = Math.sqrt(Math.max(1e-9, 1 - ild * ild));
      const fbPhase = Math.max(-1, Math.min(1, (cr * ahead) / side));
      const fb = fbPhase * (1 - delayed) + ahead * delayed;
      // How much of it comes from one place at all (1: all of it; reverb and wide pads: little)
      const raw = Math.min(1, (ild * ild + cr * cr + ci * ci) * (1 - delayed) + Math.max(ild * ild, cons) * delayed);
      const direct = Math.max(0, raw - chance[b]) / (1 - chance[b]);
      const az = Math.atan2(lat, fb);
      const off = smoothstep(12 * DEG, 55 * DEG, Math.abs(az));
      const w = we * direct * off;
      if (w < 1e-7) continue;
      spatialSum += w;
      // On screen: straight up is in front, down is behind, the sides are left and right, and pitch lifts it
      const x = Math.sin(az);
      const y = Math.cos(az) + lift[b];
      let pos = (Math.atan2(x, y) / (2 * Math.PI)) * NBINS;
      if (pos < 0) pos += NBINS;
      const i0 = Math.floor(pos) % NBINS;
      const fr = pos - Math.floor(pos);
      H[row + i0] += w * (1 - fr);
      H[row + ((i0 + 1) % NBINS)] += w * fr;
    }
  }
  // Level: square root of the share of all bands (amplitude rather than power). Then what stands out: the
  // level against where that direction has been over the last second, so an entry, a hit or a sweep flares
  // up and a part that sits there all song stays as a soft glow
  const slowA = 1 - Math.exp(-1 / (1.0 * fps));
  const slow = new Float64Array(NBINS);
  const out = new Uint8Array(frames * NBINS);
  const frameMax = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const row = f * NBINS;
    let m = 0;
    for (let k = 0; k < NBINS; k++) {
      const v = Math.sqrt(H[row + k] / NB);
      const rise = Math.max(0, v - slow[k]);
      slow[k] += slowA * (v - slow[k]);
      const level = 0.55 * v + 1.1 * rise;
      out[row + k] = Math.round(Math.sqrt(Math.min(1, level / 2)) * 255);
      if (level > m) m = level;
    }
    frameMax[f] = m;
  }
  const sorted = Float32Array.from(frameMax).sort();
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  return {
    fps,
    bins: NBINS,
    frames,
    data: out,
    spatialShare: totalSum > 0 ? spatialSum / totalSum : 0,
    levels: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99) },
  };
};

// ------------------ THE STREAM ------------------
// TIDAL's DASH audio: an init segment (the MP4 header with the codec's setup) and media segments, each a
// moof (where its samples are) and an mdat (the samples). Just enough of MP4 is read here to get them out.
const boxes = (dv, off, end, cb) => {
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      hdr = 16;
    } else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;
    cb(type, off + hdr, off + size, off);
    off += size;
  }
};
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "dinf", "moof", "traf"]);

const descLen = (u8, p) => {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = u8[p.i++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return len;
};
/** The AudioSpecificConfig out of an esds box */
const parseEsds = (u8, start, end) => {
  const p = { i: start + 4 };
  while (p.i < end) {
    const tag = u8[p.i++];
    const len = descLen(u8, p);
    if (tag === 0x03) {
      p.i += 2;
      const flags = u8[p.i++];
      if (flags & 0x80) p.i += 2;
      if (flags & 0x40) p.i += 1 + u8[p.i];
      if (flags & 0x20) p.i += 2;
      continue;
    }
    if (tag === 0x04) {
      p.i += 13;
      continue;
    }
    if (tag === 0x05) return u8.slice(p.i, p.i + len);
    p.i += len;
  }
  return null;
};

const parseInit = (buf) => {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const info = { timescale: 0, mediaTime: 0, asc: null, sr: 0, ch: 0, entry: "", defDur: 1024, defSize: 0, duration: 0 };
  const walk = (s, e) =>
    boxes(dv, s, e, (t, bs, be) => {
      if (CONTAINERS.has(t)) walk(bs, be);
      else if (t === "mdhd") {
        const v = dv.getUint8(bs);
        info.timescale = v === 1 ? dv.getUint32(bs + 20) : dv.getUint32(bs + 12);
        const dur = v === 1 ? Number(dv.getBigUint64(bs + 24)) : dv.getUint32(bs + 16);
        if (dur && info.timescale) info.duration = dur / info.timescale;
      } else if (t === "mehd") {
        const v = dv.getUint8(bs);
        info.fragmentDuration = v === 1 ? Number(dv.getBigUint64(bs + 4)) : dv.getUint32(bs + 4);
      } else if (t === "elst") {
        const v = dv.getUint8(bs);
        if (dv.getUint32(bs + 4) > 0) {
          const mt = v === 1 ? Number(dv.getBigInt64(bs + 16)) : dv.getInt32(bs + 12);
          if (mt > 0) info.mediaTime = mt;
        }
      } else if (t === "stsd") walk(bs + 8, be);
      else if (t === "mp4a" || t === "enca" || t === "fLaC" || t === "Opus" || t === "ec-3" || t === "ac-3") {
        info.entry = t;
        info.ch = dv.getUint16(bs + 16);
        info.sr = dv.getUint32(bs + 24) >>> 16;
        walk(bs + 28, be);
      } else if (t === "esds") info.asc = parseEsds(u8, bs, be);
      else if (t === "trex") {
        info.defDur = dv.getUint32(bs + 12);
        info.defSize = dv.getUint32(bs + 16);
      }
    });
  walk(0, buf.byteLength);
  if (info.fragmentDuration && info.timescale) info.duration = info.fragmentDuration / info.timescale;
  if (info.entry !== "mp4a" || !info.asc) throw new Error(`Unsupported stream (${info.entry || "no audio entry"})`);
  const aot = info.asc[0] >> 3;
  info.codec = `mp4a.40.${aot}`;
  return info;
};

/** The samples of a media segment: [{ data, duration }] */
const parseSegment = (buf, info) => {
  const dv = new DataView(buf);
  const out = [];
  boxes(dv, 0, buf.byteLength, (t, bs, be, moofStart) => {
    if (t !== "moof") return;
    boxes(dv, bs, be, (t2, ts, te) => {
      if (t2 !== "traf") return;
      let base = moofStart;
      let defDur = info.defDur;
      let defSize = info.defSize;
      boxes(dv, ts, te, (t3, s, e) => {
        if (t3 === "tfhd") {
          const flags = dv.getUint32(s) & 0xffffff;
          let p = s + 8;
          if (flags & 0x01) {
            base = Number(dv.getBigUint64(p));
            p += 8;
          }
          if (flags & 0x02) p += 4;
          if (flags & 0x08) {
            defDur = dv.getUint32(p);
            p += 4;
          }
          if (flags & 0x10) {
            defSize = dv.getUint32(p);
            p += 4;
          }
        } else if (t3 === "trun") {
          const flags = dv.getUint32(s) & 0xffffff;
          const count = dv.getUint32(s + 4);
          let p = s + 8;
          let at = base;
          if (flags & 0x01) {
            at = base + dv.getInt32(p);
            p += 4;
          }
          if (flags & 0x04) p += 4;
          for (let i = 0; i < count; i++) {
            let dur = defDur;
            let size = defSize;
            if (flags & 0x100) {
              dur = dv.getUint32(p);
              p += 4;
            }
            if (flags & 0x200) {
              size = dv.getUint32(p);
              p += 4;
            }
            if (flags & 0x400) p += 4;
            if (flags & 0x800) p += 4;
            if (at + size > buf.byteLength) return;
            out.push({ data: new Uint8Array(buf, at, size), duration: dur });
            at += size;
          }
        }
      });
    });
  });
  return out;
};

// ------------------ A JOB ------------------
const fetchRetry = async (url, signal) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return await res.arrayBuffer();
      if (attempt >= 2 || (res.status < 500 && res.status !== 429)) throw new Error(`TIDAL's server said HTTP ${res.status}`);
    } catch (err) {
      if (signal.aborted || attempt >= 2 || /said HTTP/.test(String(err?.message))) throw err;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
};

const analyseDash = async (urls, opts, signal) => {
  const t0 = performance.now();
  const init = parseInit(await fetchRetry(urls[0], signal));
  const media = urls.slice(1);
  // Segments are fetched a few ahead of the one being decoded
  const AHEAD = 6;
  const pending = [];
  let fetched = 0;
  const fill = () => {
    while (fetched < media.length && pending.length < AHEAD) {
      const p = fetchRetry(media[fetched++], signal);
      p.catch(() => {});
      pending.push(p);
    }
  };
  fill();

  let analyzer = null;
  let skip = -1;
  let failed = null;
  const decoder = new AudioDecoder({
    output: (ad) => {
      try {
        if (failed || signal.aborted) return;
        const n = ad.numberOfFrames;
        const sr = ad.sampleRate;
        if (!analyzer) {
          analyzer = createAnalyzer(sr, opts.seconds || init.duration || 600, opts);
          // The encoder's lead-in (the edit list says how much): TIDAL's own player starts after it
          skip = init.timescale ? Math.round((init.mediaTime * sr) / init.timescale) : 0;
        }
        const L = new Float32Array(n);
        ad.copyTo(L, { planeIndex: 0, format: "f32-planar" });
        let R = L;
        if (ad.numberOfChannels > 1) {
          R = new Float32Array(n);
          ad.copyTo(R, { planeIndex: 1, format: "f32-planar" });
        }
        if (skip > 0) {
          const cut = Math.min(skip, n);
          skip -= cut;
          if (cut < n) analyzer.push(L.subarray(cut), R.subarray(cut));
        } else analyzer.push(L, R);
      } catch (err) {
        failed = err;
      } finally {
        ad.close();
      }
    },
    error: (err) => (failed = err),
  });
  decoder.configure({ codec: init.codec, sampleRate: init.sr, numberOfChannels: init.ch, description: init.asc });
  let ts = 0;
  let decodeMs = 0;
  while (pending.length) {
    const buf = await pending.shift();
    fill();
    if (failed) throw failed;
    if (signal.aborted) throw new Error("cancelled");
    const t = performance.now();
    for (const s of parseSegment(buf, init)) {
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round((ts * 1e6) / init.timescale),
          duration: Math.round((s.duration * 1e6) / init.timescale),
          data: s.data,
        }),
      );
      ts += s.duration;
    }
    // (kept from running far ahead of the decoder)
    while (decoder.decodeQueueSize > 64) await new Promise((r) => decoder.addEventListener("dequeue", r, { once: true }));
    decodeMs += performance.now() - t;
  }
  await decoder.flush();
  decoder.close();
  if (failed) throw failed;
  if (!analyzer) throw new Error("No sound in the stream");
  const t1 = performance.now();
  const result = analyzer.finish();
  result.mono = init.ch < 2;
  result.ms = { total: Math.round(performance.now() - t0), directions: Math.round(performance.now() - t1) };
  result.seconds = analyzer.seconds;
  return result;
};

// ------------------ MESSAGES ------------------
if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  const jobs = new Map();
  self.onmessage = async ({ data }) => {
    if (data.type === "cancel") {
      jobs.get(data.id)?.abort();
      return;
    }
    if (data.type !== "analyse") return;
    const ctrl = new AbortController();
    jobs.set(data.id, ctrl);
    try {
      const result = await analyseDash(data.urls, data.opts || {}, ctrl.signal);
      self.postMessage({ type: "done", id: data.id, result }, [result.data.buffer]);
    } catch (err) {
      self.postMessage({ type: "error", id: data.id, error: String(err?.message ?? err) });
    } finally {
      jobs.delete(data.id);
    }
  };
}

// (for tests outside a worker)
if (typeof module !== "undefined") module.exports = { createAnalyzer, parseInit, parseSegment, NBINS, FPS };
