// Takes the voice out of a piece of music. Self-contained (no imports), so the same text runs in the
// hidden page that does this for the DJ's mashups and in a test outside it.
//
// The work is done by a small neural network of the kind UVR5 uses (an "MDX-Net", 30 MB). It doesn't
// see sound, it sees a picture of it: for each stereo channel, how strong and at what phase every
// frequency is, 256 moments at a time (six seconds). What it returns is the same picture with only the
// voice left in it. Everything else here is making those pictures out of sound and sound out of them
// again, exactly the way the network was trained to expect.
const Stems = (() => {
  "use strict";
  // The network's own measurements (fixed when it was trained)
  const N_FFT = 6144; // samples that go into one column of the picture (0.14 s)
  const HOP = 1024; // samples from one column to the next
  const BINS = 2048; // rows the network looks at: everything below 14.7 kHz
  const FRAMES = 256; // columns it takes at a time
  const CHUNK = HOP * (FRAMES - 1); // samples in one picture
  const TRIM = N_FFT / 2; // of each picture's sound, this much at either end is thrown away (it is unreliable there)
  const GEN = CHUNK - 2 * TRIM; // ...and this much is kept
  const SHAPE = [1, 4, BINS, FRAMES];

  // ------------------ FOURIER TRANSFORM, 6144 POINTS ------------------
  // 6144 is 3 x 2048: three ordinary power-of-two transforms of every third sample, put together.
  const M = N_FFT / 3;
  const LOG = Math.log2(M);
  const rev = new Uint16Array(M);
  for (let i = 0; i < M; i++) {
    let r = 0;
    for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b);
    rev[i] = r;
  }
  const cosM = new Float64Array(M / 2);
  const sinM = new Float64Array(M / 2);
  for (let i = 0; i < M / 2; i++) {
    cosM[i] = Math.cos((2 * Math.PI * i) / M);
    sinM[i] = Math.sin((2 * Math.PI * i) / M);
  }
  /** In-place transform of M complex points; sign -1 forward, +1 inverse (not divided by M) */
  const fftM = (re, im, sign) => {
    for (let i = 0; i < M; i++) {
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
    for (let size = 2; size <= M; size <<= 1) {
      const half = size >> 1;
      const step = M / size;
      for (let start = 0; start < M; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cosM[t];
          const wi = sign * sinM[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  };
  const cosN = new Float64Array(N_FFT);
  const sinN = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    cosN[i] = Math.cos((2 * Math.PI * i) / N_FFT);
    sinN[i] = Math.sin((2 * Math.PI * i) / N_FFT);
  }
  // A periodic Hann window, as the network's training used
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

  const fr = [new Float64Array(M), new Float64Array(M), new Float64Array(M)];
  const fi = [new Float64Array(M), new Float64Array(M), new Float64Array(M)];
  /** The first BINS frequencies of one windowed frame (N_FFT real samples in `frame`) into outRe/outIm at `at`, every `stride` */
  const forward = (frame, outRe, outIm, at, stride) => {
    for (let r = 0; r < 3; r++) {
      const a = fr[r];
      const b = fi[r];
      for (let m = 0; m < M; m++) {
        a[m] = frame[3 * m + r];
        b[m] = 0;
      }
      fftM(a, b, -1);
    }
    for (let k = 0; k < BINS; k++) {
      // X[k] = F0[k] + w^k F1[k] + w^2k F2[k], with w = e^(-2 pi i / N)
      const c1 = cosN[k];
      const s1 = -sinN[k];
      const k2 = (2 * k) % N_FFT;
      const c2 = cosN[k2];
      const s2 = -sinN[k2];
      outRe[at + k * stride] = fr[0][k] + fr[1][k] * c1 - fi[1][k] * s1 + fr[2][k] * c2 - fi[2][k] * s2;
      outIm[at + k * stride] = fi[0][k] + fr[1][k] * s1 + fi[1][k] * c1 + fr[2][k] * s2 + fi[2][k] * c2;
    }
  };
  /** The real frame (N_FFT samples, into `frame`) whose first BINS frequencies are given; the rest are taken as zero */
  const inverse = (inRe, inIm, at, stride, frame) => {
    // The spectrum of a real signal mirrors itself: X[N - k] is X[k] turned over. With nothing from
    // BINS up, the only parts that exist are k < BINS and their mirror images at N - k.
    for (let r = 0; r < 3; r++) {
      const a = fr[r];
      const b = fi[r];
      for (let q = 0; q < M; q++) {
        // G_r[q] = sum over j of X[q + jM] e^(2 pi i (q + jM) r / N): j = 0 is X[q] itself, j = 2 the mirror of X[M - q]
        let re = 0;
        let im = 0;
        if (q < BINS) {
          const xr = inRe[at + q * stride];
          const xi = inIm[at + q * stride];
          const t = (q * r) % N_FFT;
          re += xr * cosN[t] - xi * sinN[t];
          im += xr * sinN[t] + xi * cosN[t];
        }
        const mirror = M - q; // X[q + 2M] = conj(X[N - q - 2M]) = conj(X[M - q])
        if (q > 0 && mirror < BINS) {
          const xr = inRe[at + mirror * stride];
          const xi = -inIm[at + mirror * stride];
          const t = ((q + 2 * M) * r) % N_FFT;
          re += xr * cosN[t] - xi * sinN[t];
          im += xr * sinN[t] + xi * cosN[t];
        }
        a[q] = re;
        b[q] = im;
      }
      fftM(a, b, 1);
      for (let m = 0; m < M; m++) frame[3 * m + r] = a[m] / N_FFT;
    }
  };

  // ------------------ SOUND TO PICTURE AND BACK ------------------
  const padded = new Float64Array(CHUNK + N_FFT);
  const frame = new Float64Array(N_FFT);
  const PLANE = BINS * FRAMES;
  /** One channel's chunk (CHUNK samples from `x` at `from`; past either end counts as silence) into planes `re` and `im` of the picture */
  const toPicture = (x, from, picture, re, im) => {
    // The chunk, with its own ends folded back over half a window either side
    for (let i = 0; i < CHUNK; i++) {
      const s = from + i;
      padded[TRIM + i] = s >= 0 && s < x.length ? x[s] : 0;
    }
    for (let i = 0; i < TRIM; i++) {
      padded[TRIM - 1 - i] = padded[TRIM + 1 + i];
      padded[TRIM + CHUNK + i] = padded[TRIM + CHUNK - 2 - i];
    }
    for (let t = 0; t < FRAMES; t++) {
      const o = t * HOP;
      for (let i = 0; i < N_FFT; i++) frame[i] = padded[o + i] * win[i];
      // (planes are rows of frequency, each FRAMES long)
      forward(frame, picture.subarray(re * PLANE), picture.subarray(im * PLANE), t, FRAMES);
    }
  };
  const acc = new Float64Array(CHUNK + N_FFT);
  const norm = new Float64Array(CHUNK + N_FFT);
  for (let t = 0; t < FRAMES; t++) for (let i = 0; i < N_FFT; i++) norm[t * HOP + i] += win[i] * win[i];
  /** The kept middle of one channel's chunk (GEN samples) out of planes `re` and `im`, into `out` at `to` (as far as `out` goes) */
  const fromPicture = (picture, re, im, out, to) => {
    acc.fill(0);
    const R = picture.subarray(re * PLANE);
    const I = picture.subarray(im * PLANE);
    for (let t = 0; t < FRAMES; t++) {
      inverse(R, I, t, FRAMES, frame);
      const o = t * HOP;
      for (let i = 0; i < N_FFT; i++) acc[o + i] += frame[i] * win[i];
    }
    // (acc holds the chunk from TRIM on; of the chunk, the first and last TRIM samples are dropped)
    for (let i = 0; i < GEN; i++) {
      const d = to + i;
      if (d < 0 || d >= out.length) continue;
      const a = 2 * TRIM + i;
      out[d] = acc[a] / norm[a];
    }
  };

  /**
   * The voice in a stretch of stereo sound.
   *   left, right: Float32Array at 44.1 kHz
   *   run: gives the network a picture (Float32Array, SHAPE) and resolves to its answer (same size)
   *   level: what the network's answer is multiplied by (it comes out a little quiet; see COMPENSATE)
   *   progress: called with 0..1
   * Resolves to { left, right }: the voice. The music without it is the original minus this.
   */
  const separate = async (left, right, run, level, progress) => {
    const n = left.length;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    const chunks = Math.max(1, Math.ceil(n / GEN));
    let ready = null;
    const prepare = (c) => {
      const picture = new Float32Array(4 * PLANE);
      const from = c * GEN - TRIM;
      toPicture(left, from, picture, 0, 1);
      toPicture(right, from, picture, 2, 3);
      return picture;
    };
    for (let c = 0; c < chunks; c++) {
      const picture = ready || prepare(c);
      const job = run(picture);
      // (The next picture is made while the network works on this one)
      ready = c + 1 < chunks ? prepare(c + 1) : null;
      const answer = await job;
      fromPicture(answer, 0, 1, outL, c * GEN);
      fromPicture(answer, 2, 3, outR, c * GEN);
      if (progress) progress((c + 1) / chunks);
    }
    if (level !== 1) {
      for (let i = 0; i < n; i++) {
        outL[i] *= level;
        outR[i] *= level;
      }
    }
    return { left: outL, right: outR };
  };

  return { separate, SHAPE, CHUNK, GEN, TRIM, N_FFT, HOP, BINS, FRAMES, forward, inverse, toPicture, fromPicture };
})();
if (typeof module !== "undefined") module.exports = Stems;
