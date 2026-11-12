// Signal processing for the DJ, self-contained so the same text runs in a Web Worker (off TIDAL's UI
// thread) or directly on a page. Two jobs:
//   analyze: where the beats, bars and phrases are, how long the intro and outro last, tempo and key
//   stretch: bring a track to another tempo for a beatmatched blend (varispeed, plus sparse joins if needed)
const DSP = (() => {
  "use strict";

  // ------------------ FFT ------------------
  const makeFFT = (n) => {
    const levels = Math.log2(n);
    const cos = new Float32Array(n / 2);
    const sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    return (re, im) => {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const tre = re[j + half] * cos[k] + im[j + half] * sin[k];
            const tim = -re[j + half] * sin[k] + im[j + half] * cos[k];
            re[j + half] = re[j] - tre;
            im[j + half] = im[j] - tim;
            re[j] += tre;
            im[j] += tim;
          }
        }
      }
    };
  };

  const hann = (n) => {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  };

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    return s[Math.floor(s.length / 2)];
  };
  const percentile = (arr, p) => {
    if (!arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  };
  const dB = (e) => 10 * Math.log10(e + 1e-10);

  // ------------------ FEATURES ------------------
  // One pass at 86 frames/s for rhythm (onset strength per frame, overall and in the kick range) and
  // band energies; one slower pass with a long window for harmony (chroma), which needs the resolution
  // to tell bass notes apart.
  const features = (x, sr) => {
    const N = 1024;
    const H = 256;
    const fps = sr / H;
    const frames = Math.max(0, Math.floor((x.length - N) / H) + 1);
    const fft = makeFFT(N);
    const win = hann(N);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const binHz = sr / N;

    // ~1/3 octave bands from 30 Hz up
    const edges = [];
    for (let f = 30; f < sr / 2; f *= 1.26) edges.push(Math.max(1, Math.round(f / binHz)));
    edges.push(N / 2);
    const bands = [];
    for (let i = 0; i + 1 < edges.length; i++) if (edges[i + 1] > edges[i]) bands.push([edges[i], edges[i + 1]]);
    const nb = bands.length;
    const lowBands = bands.filter(([a]) => a * binHz < 150).length;

    const onset = new Float32Array(frames);
    const lowOnset = new Float32Array(frames);
    // How hard the low end hits, in plain amplitude: this is the kick drum
    const kick = new Float32Array(frames);
    const kickBin = Math.round(150 / binHz);
    const prevLow = new Float32Array(kickBin + 1);
    const energy = new Float32Array(frames);
    const bass = new Float32Array(frames);
    const treble = new Float32Array(frames);
    let prev = new Float32Array(nb);
    let cur = new Float32Array(nb);
    const bassBin = Math.round(200 / binHz);
    const trebleBin = Math.round(2500 / binHz);
    const norm = 2 / N;

    for (let t = 0; t < frames; t++) {
      const o = t * H;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const v = x[o + i];
        e += v * v;
        re[i] = v * win[i];
        im[i] = 0;
      }
      energy[t] = e / N;
      fft(re, im);
      let be = 0;
      let te = 0;
      for (let k = 1; k < N / 2; k++) {
        const p = (re[k] * re[k] + im[k] * im[k]) * norm * norm;
        re[k] = p;
        if (k <= kickBin) {
          const mag = Math.sqrt(p);
          if (t > 0 && mag > prevLow[k]) kick[t] += mag - prevLow[k];
          prevLow[k] = mag;
        }
        if (k <= bassBin) be += p;
        else if (k >= trebleBin) te += p;
      }
      bass[t] = be;
      treble[t] = te;
      let flux = 0;
      let low = 0;
      for (let b = 0; b < nb; b++) {
        let s = 0;
        for (let k = bands[b][0]; k < bands[b][1]; k++) s += re[k];
        const l = Math.log1p(1000 * Math.sqrt(s));
        cur[b] = l;
        const d = l - prev[b];
        if (d > 0) {
          flux += d;
          if (b < lowBands) low += d;
        }
      }
      onset[t] = t === 0 ? 0 : flux;
      lowOnset[t] = t === 0 ? 0 : low;
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }

    // Harmony
    const N2 = 4096;
    const H2 = 1024;
    const frames2 = Math.max(0, Math.floor((x.length - N2) / H2) + 1);
    const fft2 = makeFFT(N2);
    const win2 = hann(N2);
    const re2 = new Float32Array(N2);
    const im2 = new Float32Array(N2);
    const chroma = new Float32Array(frames2 * 12);
    const binPc = new Int8Array(N2 / 2).fill(-1);
    for (let k = 1; k < N2 / 2; k++) {
      const f = (k * sr) / N2;
      if (f < 60 || f > 2100) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
    }
    for (let t = 0; t < frames2; t++) {
      const o = t * H2;
      for (let i = 0; i < N2; i++) {
        re2[i] = x[o + i] * win2[i];
        im2[i] = 0;
      }
      fft2(re2, im2);
      for (let k = 1; k < N2 / 2; k++) {
        const pc = binPc[k];
        if (pc < 0) continue;
        chroma[t * 12 + pc] += Math.sqrt(re2[k] * re2[k] + im2[k] * im2[k]);
      }
    }

    return { fps, frames, hop: H, win: N, onset, lowOnset, kick, energy, bass, treble, chroma, chromaFps: sr / H2, chromaWin: N2, frames2 };
  };

  // Onset strength with the slow-moving level removed, so loud and quiet passages count alike
  const normalizeEnvelope = (onset, fps) => {
    const n = onset.length;
    const out = new Float32Array(n);
    const half = Math.round(fps * 0.75);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < Math.min(n, half); i++) {
      sum += onset[i];
      count++;
    }
    for (let i = 0; i < n; i++) {
      if (i + half < n) {
        sum += onset[i + half];
        count++;
      }
      if (i - half - 1 >= 0) {
        sum -= onset[i - half - 1];
        count--;
      }
      const v = onset[i] - sum / count;
      out[i] = v > 0 ? v : 0;
    }
    let sq = 0;
    for (let i = 0; i < n; i++) sq += out[i] * out[i];
    const std = Math.sqrt(sq / Math.max(1, n)) || 1;
    for (let i = 0; i < n; i++) out[i] /= std;
    return out;
  };

  const lerpAt = (arr, pos) => {
    if (pos <= 0) return arr[0] || 0;
    const i = Math.floor(pos);
    if (i >= arr.length - 1) return arr[arr.length - 1] || 0;
    const f = pos - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };

  // ------------------ TEMPO ------------------
  const estimateTempo = (env, fps, hintBpm) => {
    const n = env.length;
    const minLag = Math.floor((60 / 220) * fps);
    const maxLag = Math.ceil((60 / 50) * fps);
    const top = Math.min(n - 1, maxLag * 4 + 2);
    const acf = new Float32Array(top + 1);
    // Up to four minutes from the middle is plenty, and keeps long tracks cheap
    const span = Math.min(n, Math.round(fps * 240));
    const from = Math.max(0, Math.floor((n - span) / 2));
    for (let l = 1; l <= top; l++) {
      let s = 0;
      const end = from + span - l;
      for (let t = from; t < end; t++) s += env[t] * env[t + l];
      acf[l] = s / Math.max(1, end - from);
    }
    const at = (lag) => (lag >= top ? 0 : lerpAt(acf, lag));
    // A beat period also repeats at 2x, 3x and 4x its length
    const score = (lag) => at(lag) + 0.5 * at(2 * lag) + 0.33 * at(3 * lag) + 0.25 * at(4 * lag);
    const prior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
    const peakNear = (lag, tol) => {
      let best = lag;
      let bestS = -Infinity;
      for (let l = lag * (1 - tol); l <= lag * (1 + tol); l += 0.05) {
        if (l < minLag * 0.5 || l > maxLag * 2) continue;
        const s = score(l);
        if (s > bestS) {
          bestS = s;
          best = l;
        }
      }
      return { lag: best, s: bestS };
    };

    let best = { lag: (60 / 120) * fps, s: -Infinity };
    for (let l = minLag; l <= maxLag; l += 0.25) {
      const s = score(l) * prior((60 * fps) / l);
      if (s > best.s) best = { lag: l, s };
    }
    let hinted = false;
    if (hintBpm && hintBpm > 30 && hintBpm < 400) {
      // TIDAL's own tempo settles which multiple is the felt beat, when the audio agrees with it
      let hb = hintBpm;
      while (hb < 68) hb *= 2;
      while (hb > 200) hb /= 2;
      const h = peakNear((60 * fps) / hb, 0.05);
      const free = score(best.lag);
      if (h.s > 0.45 * free) {
        best = { lag: h.lag, s: h.s };
        hinted = true;
      }
    }
    const fine = peakNear(best.lag, 0.02);
    const mean = acf.reduce((a, b) => a + b, 0) / acf.length;
    return { period: fine.lag, bpm: (60 * fps) / fine.lag, strength: at(fine.lag) / (acf[1] || 1), clarity: at(fine.lag) / (Math.abs(mean) + 1e-9), hinted };
  };

  // ------------------ BEATS ------------------
  // Dynamic programming (Ellis 2007): the sequence of onsets that is both strong and evenly spaced
  const trackBeats = (env, period) => {
    const n = env.length;
    const tight = 100;
    // Smooth slightly so near-misses still count
    const sm = new Float32Array(n);
    const sigma = Math.max(1, period / 32);
    const rad = Math.ceil(sigma * 3);
    const kern = new Float32Array(2 * rad + 1);
    for (let i = -rad; i <= rad; i++) kern[i + rad] = Math.exp(-0.5 * (i / sigma) * (i / sigma));
    for (let t = 0; t < n; t++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const u = t + i;
        if (u >= 0 && u < n) s += env[u] * kern[i + rad];
      }
      sm[t] = s;
    }
    const lo = Math.round(period / 2);
    const hi = Math.round(period * 2);
    const penalty = new Float32Array(hi + 1);
    for (let d = lo; d <= hi; d++) penalty[d] = -tight * Math.pow(Math.log(d / period), 2);
    const cum = new Float32Array(n);
    const back = new Int32Array(n).fill(-1);
    for (let t = 0; t < n; t++) {
      let best = -Infinity;
      let arg = -1;
      for (let d = lo; d <= hi; d++) {
        const u = t - d;
        if (u < 0) break;
        const v = cum[u] + penalty[d];
        if (v > best) {
          best = v;
          arg = u;
        }
      }
      if (arg >= 0 && best > 0) {
        cum[t] = sm[t] + best;
        back[t] = arg;
      } else cum[t] = sm[t];
    }
    // Start from the best-scoring frame in the last period
    let end = n - 1;
    let bestEnd = -Infinity;
    for (let t = Math.max(0, n - hi); t < n; t++) {
      if (cum[t] > bestEnd) {
        bestEnd = cum[t];
        end = t;
      }
    }
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) {
      beats.push(t);
      if (back[t] < 0) break;
    }
    beats.reverse();
    return beats;
  };

  // ------------------ GRID ------------------
  /**
   * A steady grid (period + phase) over a stretch of the track, from the tracked beats and then
   * sharpened against the onset envelope itself. `resid` says how well real beats sit on it.
   */
  const fitGrid = (beatFrames, env, fps, fromSec, toSec, lowEnv) => {
    const sel = [];
    for (let i = 0; i < beatFrames.length; i++) {
      const s = beatFrames[i] / fps;
      if (s >= fromSec && s <= toSec) sel.push(i);
    }
    if (sel.length < 8) return null;
    const i0 = sel[0];
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const i of sel) {
      const k = i - i0;
      const y = beatFrames[i];
      sx += k;
      sy += y;
      sxx += k * k;
      sxy += k * y;
    }
    const m = sel.length;
    let P = (m * sxy - sx * sy) / (m * sxx - sx * sx);
    let t0 = (sy - P * sx) / m;
    const count = sel[sel.length - 1] - i0 + 1;

    const comb = (p, t, from = 0, to = count) => {
      let s = 0;
      for (let k = from; k < to; k++) s += lerpAt(env, t + k * p);
      return s;
    };
    // The tracked beats only suggest the tempo. The grid itself is found against the onset envelope:
    // every phase of the beat is tried (the tracker sometimes follows the off-beat hi-hats, which would
    // put the whole grid half a beat out), then period and phase are sharpened together.
    let best = { s: -Infinity, P, t0 };
    const mid = (count - 1) / 2;
    const anchor = t0 + mid * P;
    for (let dp = -0.012; dp <= 0.012 + 1e-12; dp += 0.0008) {
      const p = P * (1 + dp);
      const tc = anchor - mid * p;
      for (let dt = 0; dt < p; dt += 0.5) {
        const sc = comb(p, tc + dt);
        if (sc > best.s) best = { s: sc, P: p, t0: tc + dt };
      }
    }
    {
      const baseP = best.P;
      const baseT = best.t0;
      for (let dp = -0.001; dp <= 0.001 + 1e-12; dp += 0.00005) {
        const p = baseP * (1 + dp);
        const tc = baseT + mid * baseP - mid * p;
        for (let dt = -1; dt <= 1 + 1e-9; dt += 0.1) {
          const sc = comb(p, tc + dt);
          if (sc > best.s) best = { s: sc, P: p, t0: tc + dt };
        }
      }
    }
    P = best.P;
    t0 = best.t0;
    // How steady the pulse really is: in every stretch of 16 beats, find where the beat sits relative
    // to the grid. A drum machine stays put; a live drummer wanders; no pulse at all scatters.
    const devs = [];
    let inliers = 0;
    const span = 16;
    for (let from = 0; from + span <= count; from += span) {
      let bestOff = 0;
      let bestS = -Infinity;
      for (let off = -P / 2; off < P / 2; off += 0.25) {
        const sc = comb(P, t0 + off, from, from + span);
        if (sc > bestS) {
          bestS = sc;
          bestOff = off;
        }
      }
      // In a breakdown or an intro the off-beat (hi-hats, stabs) can be the loudest thing: that's the
      // arrangement, not the tempo moving, so a stretch sitting exactly half a beat out still counts as
      // on the grid. A tempo that really drifts shows up as in-between offsets.
      const d = Math.min(Math.abs(bestOff), Math.abs(P / 2 - Math.abs(bestOff)));
      devs.push(d);
      if (d < 0.03 * fps) inliers++;
    }
    const resid = devs.length ? median(devs) / fps : 1;
    const inlierShare = devs.length ? inliers / devs.length : 0;
    // How much stronger the envelope is on the grid than off it
    let on = 0;
    let off = 0;
    for (let k = 0; k < count; k++) {
      on += lerpAt(env, t0 + k * P);
      off += lerpAt(env, t0 + (k + 0.5) * P) + lerpAt(env, t0 + (k + 0.25) * P) + lerpAt(env, t0 + (k + 0.75) * P);
    }
    const contrast = on / (off / 3 + 1e-6);
    return { period: P / fps, phase: t0 / fps, firstIndex: i0, count, resid, inlierShare, contrast };
  };

  /**
   * Moves a grid's phase onto the average attack: the beat-synchronous energy profile at 1 ms steps has
   * its steepest rise where the drum actually hits, far more precise than an 11 ms analysis frame.
   */
  const refineAttack = (x, sr, grid) => {
    const span = Math.round(0.045 * sr);
    const prof = new Float64Array(2 * span + 1);
    let used = 0;
    for (let k = 0; k < grid.count; k++) {
      const c = Math.round((grid.phase + k * grid.period) * sr);
      if (c - span < 0 || c + span >= x.length) continue;
      for (let i = -span; i <= span; i++) {
        const v = x[c + i];
        prof[i + span] += v * v;
      }
      used++;
    }
    if (used < 6) return 0;
    const w = Math.max(1, Math.round(0.003 * sr));
    const sm = new Float64Array(prof.length);
    let run = 0;
    for (let i = 0; i < prof.length; i++) {
      run += prof[i];
      if (i >= w) run -= prof[i - w];
      sm[i] = run / Math.min(i + 1, w);
    }
    const d = Math.max(1, Math.round(0.004 * sr));
    let bestRise = 0;
    let at = span;
    let total = 0;
    for (let i = d; i < sm.length; i++) {
      const rise = sm[i] - sm[i - d];
      total += Math.abs(rise);
      if (rise > bestRise) {
        bestRise = rise;
        at = i - d / 2;
      }
    }
    // No clear attack (pads, strings): leave the grid where the envelope put it
    if (bestRise < 6 * (total / (sm.length - d))) return 0;
    return (at - span) / sr;
  };

  // ------------------ KEY ------------------
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const estimateKey = (chroma, frames2) => {
    const sum = new Float64Array(12);
    for (let t = 0; t < frames2; t++) for (let p = 0; p < 12; p++) sum[p] += chroma[t * 12 + p];
    const corr = (profile, shift) => {
      let mx = 0;
      let my = 0;
      for (let i = 0; i < 12; i++) {
        mx += sum[(i + shift) % 12];
        my += profile[i];
      }
      mx /= 12;
      my /= 12;
      let num = 0;
      let dx = 0;
      let dy = 0;
      for (let i = 0; i < 12; i++) {
        const a = sum[(i + shift) % 12] - mx;
        const b = profile[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
      }
      return num / (Math.sqrt(dx * dy) + 1e-12);
    };
    const all = [];
    for (let s = 0; s < 12; s++) {
      all.push({ tonic: s, mode: "major", c: corr(KK_MAJOR, s) });
      all.push({ tonic: s, mode: "minor", c: corr(KK_MINOR, s) });
    }
    all.sort((a, b) => b.c - a.c);
    return { tonic: all[0].tonic, mode: all[0].mode, conf: all[0].c - all[1].c, corr: all[0].c };
  };

  // ------------------ ANALYZE ------------------
  /**
   * x: mono samples at `sr` (22050 expected). hint.bpm: TIDAL's tempo for the track, if it has one.
   * All times in the result are seconds from the start of the track.
   */
  const analyze = (x, sr, hint) => {
    hint = hint || {};
    const duration = x.length / sr;
    const f = features(x, sr);
    const fps = f.fps;
    const frameSec = (t) => (t * f.hop + f.win / 2) / sr;
    const secFrame = (s) => (s * sr - f.win / 2) / f.hop;

    // Where sound starts and stops
    const silence = 1e-6; // -60 dBFS
    let first = 0;
    while (first < f.frames && f.energy[first] < silence) first++;
    let last = f.frames - 1;
    while (last > first && f.energy[last] < silence) last--;
    const firstSound = Math.max(0, (first * f.hop) / sr);
    const lastSound = Math.min(duration, (last * f.hop + f.win) / sr);

    let meanSq = 0;
    for (let t = 0; t < f.frames; t++) meanSq += f.energy[t];
    const loud = dB(meanSq / Math.max(1, f.frames));

    const env = normalizeEnvelope(f.onset, fps);
    const lowEnv = normalizeEnvelope(f.lowOnset, fps);
    const tempo = estimateTempo(env, fps, hint.bpm);
    const beatFrames = trackBeats(env, tempo.period);
    const beatsRaw = beatFrames.map(frameSec);

    // Grids in analysis-frame units, then converted. Whole track, plus the first and last minute on
    // their own: a live drummer drifts over a song but is steady enough across a 30 s blend.
    const toGrid = (g) => {
      if (!g) return null;
      const out = { period: g.period, phase: frameSec(g.phase * fps), count: g.count, resid: g.resid, inlierShare: g.inlierShare, contrast: g.contrast };
      // Which half of the beat is the beat. The grid was put where the onsets are strongest overall, which
      // off-beat hi-hats can win. The kick drum settles it: if the low end hits clearly harder half a
      // beat away, that's where the beat is. (Measured in plain amplitude: with levels evened out, a house
      // bassline, which plays on the off-beat, looks as strong as the kick it sits between.)
      const kickHits = (shift) => {
        let sum = 0;
        for (let k = 0; k < out.count; k++) {
          const c = secFrame(out.phase + (k + shift) * out.period);
          let m = 0;
          for (let i = Math.max(0, Math.floor(c) - 1); i <= Math.min(f.frames - 1, Math.ceil(c) + 2); i++) if (f.kick[i] > m) m = f.kick[i];
          sum += m;
        }
        return sum;
      };
      if (kickHits(0.5) > kickHits(0) * 1.3) out.phase += out.period / 2;
      out.phase += refineAttack(x, sr, out);
      out.bpm = 60 / out.period;
      return out;
    };
    const whole = toGrid(fitGrid(beatFrames, env, fps, secFrame(firstSound) / fps, secFrame(lastSound) / fps, lowEnv));
    const headEnd = Math.min(lastSound, firstSound + 70);
    const tailStart = Math.max(firstSound, lastSound - 80);
    const head = toGrid(fitGrid(beatFrames, env, fps, secFrame(firstSound) / fps, secFrame(headEnd) / fps, lowEnv));
    const tail = toGrid(fitGrid(beatFrames, env, fps, secFrame(tailStart) / fps, secFrame(lastSound) / fps, lowEnv));
    const steady = !!whole && whole.resid < 0.02 && whole.inlierShare > 0.6;
    // An intro or outro without a kick drum has only off-beat hi-hats to lock onto, which puts that
    // section's grid half a beat out. The track as a whole knows better: when its tempo is steady, the
    // section grids must agree with the whole-track grid about which half of the beat is the beat.
    if (whole && whole.resid < 0.03 && whole.inlierShare > 0.5) {
      for (const g of [head, tail]) {
        if (!g) continue;
        let d = ((g.phase - whole.phase) / whole.period) % 1;
        if (d < 0) d += 1;
        if (Math.abs(d - 0.5) < 0.2) g.phase += g.period / 2;
      }
    }

    // Beat list used for structure: the steady grid when the track holds one, else the tracked beats
    let beats;
    if (steady) {
      beats = [];
      const k0 = Math.ceil((firstSound - whole.phase) / whole.period - 1e-6);
      for (let k = k0; ; k++) {
        const t = whole.phase + k * whole.period;
        if (t > lastSound - 0.05) break;
        if (t >= 0) beats.push(t);
      }
    } else beats = beatsRaw.filter((t) => t >= firstSound - 0.05 && t <= lastSound);
    const nBeats = beats.length;

    // Per-beat features
    const beatE = new Float32Array(nBeats);
    const beatBass = new Float32Array(nBeats);
    const beatTreble = new Float32Array(nBeats);
    const beatLow = new Float32Array(nBeats);
    const beatChroma = new Float32Array(nBeats * 12);
    for (let k = 0; k < nBeats; k++) {
      const a = beats[k];
      const b = k + 1 < nBeats ? beats[k + 1] : Math.min(duration, a + (tempo.period / fps));
      const fa = Math.max(0, Math.floor(secFrame(a)));
      const fb = Math.min(f.frames, Math.max(fa + 1, Math.ceil(secFrame(b))));
      let e = 0;
      let bs = 0;
      let tr = 0;
      for (let t = fa; t < fb; t++) {
        e += f.energy[t];
        bs += f.bass[t];
        tr += f.treble[t];
      }
      const n = fb - fa;
      beatE[k] = dB(e / n);
      beatBass[k] = dB(bs / n);
      beatTreble[k] = dB(tr / n);
      // Kick strength right at the beat
      const c = secFrame(a);
      let lo = 0;
      for (let t = Math.max(0, Math.floor(c - 3)); t <= Math.min(f.frames - 1, Math.ceil(c + 3)); t++) lo = Math.max(lo, lowEnv[t]);
      beatLow[k] = lo;
      const ca = Math.max(0, Math.floor((a * sr - f.chromaWin / 2) / 1024));
      const cb = Math.min(f.frames2, Math.max(ca + 1, Math.ceil((b * sr - f.chromaWin / 2) / 1024)));
      for (let t = ca; t < cb; t++) for (let p = 0; p < 12; p++) beatChroma[k * 12 + p] += f.chroma[t * 12 + p];
    }

    // Bar phase: which of every four beats is the "one". Kicks and chord changes both favour it
    const chromaChange = new Float32Array(nBeats);
    for (let k = 1; k < nBeats; k++) {
      let num = 0;
      let na = 0;
      let nbb = 0;
      for (let p = 0; p < 12; p++) {
        const a = beatChroma[(k - 1) * 12 + p];
        const b = beatChroma[k * 12 + p];
        num += a * b;
        na += a * a;
        nbb += b * b;
      }
      chromaChange[k] = 1 - num / (Math.sqrt(na * nbb) + 1e-9);
    }
    const z = (arr) => {
      let m = 0;
      for (const v of arr) m += v;
      m /= Math.max(1, arr.length);
      let s = 0;
      for (const v of arr) s += (v - m) * (v - m);
      s = Math.sqrt(s / Math.max(1, arr.length)) || 1;
      return Float32Array.from(arr, (v) => (v - m) / s);
    };
    const zLow = z(beatLow);
    const zChange = z(chromaChange);
    const barScores = [0, 0, 0, 0];
    for (let k = 0; k < nBeats; k++) barScores[k % 4] += 0.6 * zLow[k] + zChange[k];
    let barPhase = 0;
    for (let p = 1; p < 4; p++) if (barScores[p] > barScores[barPhase]) barPhase = p;
    const sortedBar = [...barScores].sort((a, b) => b - a);
    const barConf = nBeats > 16 ? (sortedBar[0] - sortedBar[1]) / (nBeats / 4) : 0;

    // Bars, with loudness in three bands
    const bars = [];
    for (let k = barPhase; k + 3 < nBeats; k += 4) {
      let e = 0;
      let bs = 0;
      let tr = 0;
      for (let i = 0; i < 4; i++) {
        e += Math.pow(10, beatE[k + i] / 10);
        bs += Math.pow(10, beatBass[k + i] / 10);
        tr += Math.pow(10, beatTreble[k + i] / 10);
      }
      bars.push({ beat: k, t: beats[k], e: dB(e / 4), bass: dB(bs / 4), treble: dB(tr / 4) });
    }
    const nBars = bars.length;

    // Phrases: sections change every 4 (or 8) bars. The phase where the sound changes most wins, with
    // a nudge towards counting from the first bar, which is where a song's first phrase starts
    const novelty = new Float32Array(nBars);
    for (let j = 2; j + 1 < nBars; j++) {
      const a0 = Math.max(0, j - 4);
      const b1 = Math.min(nBars, j + 4);
      let d = 0;
      for (const key of ["e", "bass", "treble"]) {
        let ma = 0;
        let mb = 0;
        for (let i = a0; i < j; i++) ma += bars[i][key];
        for (let i = j; i < b1; i++) mb += bars[i][key];
        d += Math.abs(ma / (j - a0) - mb / (b1 - j));
      }
      novelty[j] = d;
    }
    const phraseScores = [0, 0, 0, 0];
    for (let j = 0; j < nBars; j++) phraseScores[j % 4] += novelty[j];
    phraseScores[0] *= 1.15;
    let phrasePhase = 0;
    for (let p = 1; p < 4; p++) if (phraseScores[p] > phraseScores[phrasePhase]) phrasePhase = p;

    // Intro and outro: the stretches before the track reaches its full level and after it leaves it
    const barE = bars.map((b) => b.e);
    const full = percentile(barE, 0.7);
    const bassFull = percentile(
      bars.map((b) => b.bass),
      0.7,
    );
    const isFull = (j) => j >= 0 && j < nBars && bars[j].e >= full - 4 && bars[j].bass >= bassFull - 8;
    let introBar = 0;
    while (introBar < nBars && !(isFull(introBar) && (isFull(introBar + 1) || introBar === nBars - 1))) introBar++;
    let outroBar = nBars;
    while (outroBar > 0 && !(isFull(outroBar - 1) && (isFull(outroBar - 2) || outroBar === 1))) outroBar--;
    if (introBar >= nBars) {
      introBar = 0;
      outroBar = nBars;
    }
    const firstBeat = nBars ? bars[0].t : beats[0] !== undefined ? beats[0] : firstSound;
    const introEnd = nBars ? bars[Math.min(nBars - 1, introBar)].t : firstSound;
    const beatLen = whole ? whole.period : tempo.period / fps;
    const outroStart = nBars ? (outroBar < nBars ? bars[outroBar].t : bars[nBars - 1].t + 4 * beatLen) : lastSound;

    // A fade-out: level falling steadily over the last bars
    let fadeOut = false;
    if (nBars >= 8) {
      const tailBars = bars.slice(-6).map((b) => b.e);
      let falling = 0;
      for (let i = 1; i < tailBars.length; i++) if (tailBars[i] < tailBars[i - 1] - 0.7) falling++;
      fadeOut = falling >= 4 && tailBars[0] - tailBars[tailBars.length - 1] > 8;
    }

    // Pulse clarity: how much of the onset energy lies on the beat
    let onBeat = 0;
    for (const t of beats) onBeat += lerpAt(env, secFrame(t));
    let total = 0;
    for (let t = 0; t < env.length; t++) total += env[t];
    const beatFramesPer = env.length / Math.max(1, nBeats);
    const pulse = nBeats ? onBeat / nBeats / (total / env.length + 1e-9) : 0;

    const key = estimateKey(f.chroma, f.frames2);

    return {
      duration,
      firstSound,
      lastSound,
      loud,
      bpm: whole ? whole.bpm : tempo.bpm,
      tempoHinted: tempo.hinted,
      steady,
      pulse,
      beatsPerFrameSpan: beatFramesPer,
      grid: whole,
      head,
      tail,
      beats: Float32Array.from(beats),
      barPhase,
      barConf,
      phrasePhase,
      bars: Float32Array.from(bars.map((b) => b.t)),
      barEnergy: Float32Array.from(barE),
      barBass: Float32Array.from(bars.map((b) => b.bass)),
      fullLevel: full,
      firstBeat,
      introEnd,
      outroStart,
      introBars: introBar,
      outroBars: nBars - outroBar,
      fadeOut,
      key,
    };
  };

  // ------------------ TEMPO SHIFT ------------------
  // How far a track's tempo is moved by simply playing it faster or slower (the way a turntable does):
  // 2% is a third of a semitone, the range DJs work in without key lock, and it leaves the sound
  // completely untouched. Anything beyond that is made up by leaving out (or repeating) a few
  // milliseconds here and there, in the spots where that shows least.
  const MAX_VARISPEED = 1.02;
  const TAPS = 48;
  const PHASES = 512;
  let sincTable;
  // Windowed-sinc interpolation table (Kaiser, about 80 dB): row p holds the weights for reading
  // p/PHASES of a sample past an input sample
  const sinc = () => {
    if (sincTable) return sincTable;
    const table = new Float32Array((PHASES + 1) * TAPS);
    const beta = 8;
    const i0 = (x) => {
      let sum = 1;
      let term = 1;
      for (let k = 1; k < 32; k++) {
        term *= (x / (2 * k)) * (x / (2 * k));
        sum += term;
      }
      return sum;
    };
    const norm = i0(beta);
    const cutoff = 1 / MAX_VARISPEED; // playing faster squeezes the spectrum up: nothing may fold back
    const half = TAPS / 2;
    for (let ph = 0; ph <= PHASES; ph++) {
      const frac = ph / PHASES;
      let sum = 0;
      for (let j = 0; j < TAPS; j++) {
        const d = j - (half - 1) - frac;
        const r = d / half;
        const w = Math.abs(r) >= 1 ? 0 : i0(beta * Math.sqrt(1 - r * r)) / norm;
        const v = Math.abs(d) < 1e-9 ? cutoff : Math.sin(Math.PI * cutoff * d) / (Math.PI * d);
        table[ph * TAPS + j] = v * w;
        sum += v * w;
      }
      for (let j = 0; j < TAPS; j++) table[ph * TAPS + j] /= sum;
    }
    return (sincTable = table);
  };

  /**
   * Plays `channels` from sample `x0` at `speed` (input samples per output sample) for `holdOut` output
   * samples, then glides linearly back to normal speed over `glideOut` samples.
   *
   * Up to 2% either way the track is just played faster or slower: resampled, with nothing cut and
   * nothing overlapped, so it sounds exactly like itself. For a bigger difference the rest is made up by
   * skipping (or repeating) 1-5 ms at a time, a few times a second at most, each one placed where the
   * music a few milliseconds apart is most alike (a quiet gap, never across a drum hit) and joined with a
   * short crossfade. Between those joins the audio is untouched. The bass is kept out of that: a held
   * bass note can't be cut anywhere without a bump, so everything below about 110 Hz is played by
   * varispeed alone up to 3.5%, and only joined (rarely, a whole wave at a time) beyond that.
   * (The earlier version overlapped two slightly offset copies of the track all the time, which is what a
   * phaser does, and it sounded like one.)
   *
   * Returns the shifted audio plus the exact point to continue from in the untouched track:
   * the sample after out[spliceOut - 1] is channels[spliceIn], so the two join sample for sample.
   */
  const stretch = (channels, sr, x0, speed, holdOut, glideOut) => {
    const nCh = channels.length;
    const len = channels[0].length;
    holdOut = Math.max(0, Math.round(holdOut));
    glideOut = Math.max(0, Math.round(glideOut));
    const T = holdOut + glideOut;
    const speedAt = (t) => (t <= holdOut ? speed : t >= T ? 1 : speed + ((1 - speed) * (t - holdOut)) / glideOut);
    const posAt = (t) => {
      if (t <= holdOut) return speed * t;
      const u = Math.min(t - holdOut, glideOut);
      return speed * holdOut + (glideOut ? speed * u + ((1 - speed) * u * u) / (2 * glideOut) : 0) + Math.max(0, t - T);
    };
    const dir = speed > 1 ? 1 : -1;
    const STEP = 64;

    /**
     * Where one band skips or repeats. `limit`: how far varispeed alone may go for it; `E`: how far
     * (samples) it may sit either side of its exact place; `LX`: crossfade length at a join.
     */
    const planJoins = (bandChannels, limit, E, LX) => {
      // How much of the wanted speed varispeed doesn't cover (0 for small differences)
      const excess = (t) => {
        const v = speedAt(t);
        return v - Math.min(limit, Math.max(1 / limit, v));
      };
      const jumps = []; // { t: output sample, delta: input samples (+ skips ahead, - repeats) }
      if (excess(0) === 0 || T <= LX) return { jumps, excess, LX };
      const mono = new Float32Array(len);
      for (let c = 0; c < nCh; c++) {
        const ch = bandChannels[c];
        for (let i = 0; i < len; i++) mono[i] += ch[i];
      }
      const mismatch = (pos, delta, stride) => {
        let sum = 0;
        for (let i = 0; i < LX; i += stride) {
          const d = mono[pos + i] - mono[pos + delta + i];
          sum += d * d;
        }
        return sum * stride;
      };
      const stride = Math.max(3, Math.round(LX / 256));
      let t = 0;
      let debt = 0; // how far the reader has fallen behind (or, slowing down, run ahead of) its place
      for (;;) {
        // Candidates: every moment from when a worthwhile jump becomes possible until the limit is reached
        let best = null;
        let tt = t;
        let dd = debt;
        let ended = false;
        for (;;) {
          const rate = Math.abs(excess(tt + STEP / 2));
          if (tt >= T - LX || rate === 0) {
            ended = true;
            break;
          }
          if (dd >= -E / 2) {
            const pos = Math.round(x0 + posAt(tt) - dir * dd);
            const from = Math.max(Math.ceil(E / 2), Math.ceil(dd));
            const to = Math.floor(E + dd);
            for (let j = from; j <= to; j += 4) {
              const delta = dir * j;
              if (pos < 0 || pos + delta < 0 || pos + LX >= len || pos + delta + LX >= len) continue;
              // Cost per sample gained: fewer, better joins
              const cost = (mismatch(pos, delta, stride) + 1e-7) / j;
              if (!best || cost < best.cost) best = { cost, t: tt, j, pos, debt: dd };
            }
          }
          if (dd >= E) break;
          tt += STEP;
          dd += rate * STEP;
        }
        // The end (or the point where varispeed alone takes over) came first: no more joins needed
        if (ended || !best) break;
        // Fine-tune the size of the chosen jump
        let j = best.j;
        let fine = Infinity;
        for (let k = Math.max(1, best.j - 3); k <= best.j + 3; k++) {
          const delta = dir * k;
          if (best.pos + delta < 0 || best.pos + delta + LX >= len) continue;
          const cost = mismatch(best.pos, delta, 1);
          if (cost < fine) {
            fine = cost;
            j = k;
          }
        }
        jumps.push({ t: best.t, delta: dir * j });
        // Carry on from the end of this join
        debt = best.debt - j;
        for (let u = best.t; u < best.t + LX; u += STEP) debt += Math.abs(excess(u + STEP / 2)) * STEP;
        t = best.t + LX;
      }
      return { jumps, excess, LX };
    };

    /** Where each output sample of a band reads from */
    const pointers = ({ jumps, excess }) => {
      const ptr = new Float64Array(T + 1);
      let drift = 0;
      let k = 0;
      for (let t = 0; t <= T; t++) {
        while (k < jumps.length && jumps[k].t === t) drift += jumps[k++].delta;
        ptr[t] = x0 + posAt(t) + drift;
        drift -= excess(t + 0.5);
      }
      return ptr;
    };
    /** Eases a band's last stretch so that it ends exactly at input sample `target` */
    const landOn = (ptr, plan, target, longest) => {
      const lastJoin = plan.jumps.length ? plan.jumps[plan.jumps.length - 1].t + plan.LX : 0;
      let w = Math.min(T - lastJoin, longest);
      if (w < 2048) w = Math.min(T, 2048);
      const off = target - ptr[T];
      for (let t = Math.max(0, T - w); t <= T; t++) {
        const x = (t - (T - w)) / w;
        ptr[t] += off * x * x * (3 - 2 * x);
      }
    };

    const table = sinc();
    const half = TAPS / 2;
    const out = [];
    for (let c = 0; c < nCh; c++) out.push(new Float32Array(T));
    const weights = new Float32Array(TAPS);
    const acc = new Float64Array(nCh);
    const render = (bandChannels, ptr, { jumps, LX }) => {
      const read = (pos) => {
        const ip = Math.floor(pos);
        const f = (pos - ip) * PHASES;
        const k = Math.floor(f);
        const a = f - k;
        const r0 = k * TAPS;
        const r1 = r0 + TAPS;
        for (let j = 0; j < TAPS; j++) weights[j] = table[r0 + j] + (table[r1 + j] - table[r0 + j]) * a;
        const start = ip - (half - 1);
        const inside = start >= 0 && start + TAPS <= len;
        for (let c = 0; c < nCh; c++) {
          const ch = bandChannels[c];
          let sum = 0;
          if (inside) for (let j = 0; j < TAPS; j++) sum += ch[start + j] * weights[j];
          else
            for (let j = 0; j < TAPS; j++) {
              const i = start + j;
              if (i >= 0 && i < len) sum += ch[i] * weights[j];
            }
          acc[c] = sum;
        }
      };
      let k = 0;
      for (let t = 0; t < T; t++) {
        while (k < jumps.length && t >= jumps[k].t + LX) k++;
        read(ptr[t]);
        if (k < jumps.length && t >= jumps[k].t) {
          // Inside a join: the old place fades out as the new one fades in
          const w = 0.5 - 0.5 * Math.cos((Math.PI * (t - jumps[k].t + 0.5)) / LX);
          for (let c = 0; c < nCh; c++) out[c][t] += acc[c] * w;
          read(ptr[t] - jumps[k].delta);
          for (let c = 0; c < nCh; c++) out[c][t] += acc[c] * (1 - w);
        } else {
          for (let c = 0; c < nCh; c++) out[c][t] += acc[c];
        }
      }
    };

    const within = (v, limit) => v <= limit && v >= 1 / limit;
    if (within(speed, MAX_VARISPEED)) {
      // Varispeed alone
      const plan = planJoins(channels, MAX_VARISPEED, 0, 0);
      const ptr = pointers(plan);
      const spliceIn = Math.round(ptr[T]);
      landOn(ptr, plan, spliceIn, 16384);
      render(channels, ptr, plan);
      return { out, total: T, spliceOut: T, spliceIn, x0, speed, holdOut, glideOut, joins: 0, bassJoins: 0 };
    }

    // Two bands: the bass (zero-phase low-pass, so the two add back up to the original exactly) and the rest
    const lows = [];
    const highs = [];
    {
      const w0 = (2 * Math.PI * 140) / sr; // twice over, that is -6 dB at about 110 Hz
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const cosw = Math.cos(w0);
      const a0 = 1 + alpha;
      const b0 = (1 - cosw) / 2 / a0;
      const b1 = (1 - cosw) / a0;
      const a1 = (-2 * cosw) / a0;
      const a2 = (1 - alpha) / a0;
      for (let c = 0; c < nCh; c++) {
        const ch = channels[c];
        const y = new Float64Array(len);
        let x1 = 0;
        let x2 = 0;
        let y1 = 0;
        let y2 = 0;
        for (let i = 0; i < len; i++) {
          const x = ch[i];
          const v = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = v;
          y[i] = v;
        }
        // ...back, forward and back again: no phase shift, and a steep slope
        for (let pass = 0; pass < 3; pass++) {
          x1 = x2 = y1 = y2 = 0;
          const back = pass !== 1;
          for (let n = 0; n < len; n++) {
            const i = back ? len - 1 - n : n;
            const x = y[i];
            const v = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = v;
            y[i] = v;
          }
        }
        const low = new Float32Array(len);
        const high = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          low[i] = y[i];
          high[i] = ch[i] - low[i];
        }
        lows.push(low);
        highs.push(high);
      }
    }
    const highPlan = planJoins(highs, MAX_VARISPEED, Math.round(0.0025 * sr), 768);
    const highPtr = pointers(highPlan);
    const spliceIn = Math.round(highPtr[T]);
    landOn(highPtr, highPlan, spliceIn, 16384);
    render(highs, highPtr, highPlan);
    // The bass: varispeed alone up to 3.5%; beyond that, joins a whole wave long with a long crossfade
    const lowPlan = planJoins(lows, 1.035, Math.round(0.012 * sr), 2048);
    const lowPtr = pointers(lowPlan);
    landOn(lowPtr, lowPlan, spliceIn, 4 * sr);
    render(lows, lowPtr, lowPlan);
    return { out, total: T, spliceOut: T, spliceIn, x0, speed, holdOut, glideOut, joins: highPlan.jumps.length, bassJoins: lowPlan.jumps.length };
  };

  return { analyze, stretch, makeFFT };
})();

// In a worker: { id, type: "analyze", mono, sr, hint } or { id, type: "stretch", channels, sr, x0, speed, holdOut, glideOut }
if (typeof self !== "undefined" && typeof window === "undefined" && typeof postMessage === "function") {
  self.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.type === "analyze") {
        const result = DSP.analyze(m.mono, m.sr, m.hint);
        postMessage({ id: m.id, result });
      } else if (m.type === "stretch") {
        const result = DSP.stretch(m.channels, m.sr, m.x0, m.speed, m.holdOut, m.glideOut);
        postMessage(
          { id: m.id, result },
          result.out.map((c) => c.buffer),
        );
      }
    } catch (err) {
      postMessage({ id: m.id, error: String((err && err.stack) || err) });
    }
  };
}
