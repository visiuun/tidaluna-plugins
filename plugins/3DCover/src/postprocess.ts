// Depth maps are stored at this resolution; the shader upsamples them bilinearly.
export const DEPTH_SIZE = 384;

// ------------------ DEPTH POST-PROCESSING ------------------
// Area-average resample of the model output down to DEPTH_SIZE².
const resample = (src: Uint8Array, sw: number, sh: number, size: number) => {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * sh) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * sw) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / size));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * sw + xx];
      out[y * size + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
};

// 3x3 median: removes isolated depth specks (stand-in for the Python tophat/blackhat artifact filter)
const median3 = (src: Float32Array, size: number) => {
  const out = new Float32Array(size * size);
  const win = new Float32Array(9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(size - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) win[k++] = src[yy * size + Math.min(size - 1, Math.max(0, x + dx))];
      }
      win.sort();
      out[y * size + x] = win[4];
    }
  }
  return out;
};

// Edge-preserving bilateral filter, same params as the Python cv2.bilateralFilter(d=5, sigmaColor=25, sigmaSpace=10).
const bilateral = (src: Float32Array, size: number) => {
  const r = 2;
  const spaceW: number[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) spaceW.push(dx * dx + dy * dy <= r * r ? Math.exp(-(dx * dx + dy * dy) / (2 * 10 * 10)) : 0);
  const colorW = new Float32Array(256);
  for (let i = 0; i < 256; i++) colorW[i] = Math.exp(-(i * i) / (2 * 25 * 25));

  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = src[y * size + x];
      let sum = 0;
      let wsum = 0;
      let k = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(size - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++, k++) {
          if (spaceW[k] === 0) continue;
          const xx = Math.min(size - 1, Math.max(0, x + dx));
          const v = src[yy * size + xx];
          const w = spaceW[k] * colorW[Math.min(255, Math.abs(v - c) | 0)];
          sum += v * w;
          wsum += w;
        }
      }
      out[y * size + x] = Math.round(sum / wsum);
    }
  }
  return out;
};

// Separable min and max over a (2r+1)² window, in one sweep
export const windowMinMax = (src: Uint8Array, size: number, r: number) => {
  const tmpLo = new Uint8Array(size * size);
  const tmpHi = new Uint8Array(size * size);
  const lo = new Uint8Array(size * size);
  const hi = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(size - 1, x + r);
      let mn = 255, mx = 0;
      for (let xx = x0; xx <= x1; xx++) {
        const v = src[row + xx];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      tmpLo[row + x] = mn;
      tmpHi[row + x] = mx;
    }
  }
  for (let y = 0; y < size; y++) {
    const y0 = Math.max(0, y - r) * size;
    const y1 = Math.min(size - 1, y + r) * size;
    for (let x = 0; x < size; x++) {
      let mn = 255, mx = 0;
      for (let yy = y0 + x; yy <= y1 + x; yy += size) {
        if (tmpLo[yy] < mn) mn = tmpLo[yy];
        if (tmpHi[yy] > mx) mx = tmpHi[yy];
      }
      lo[y * size + x] = mn;
      hi[y * size + x] = mx;
    }
  }
  return { lo, hi };
};

// The model blurs object boundaries into soft ramps, which the renderer can't tell apart from real
// slopes, so it stretches edge pixels into streaks. Snap every ramp that spans a big depth range to
// whichever side it's closer to, turning it into a cliff the renderer fills from the background.
// Smooth surfaces never cover EDGE_RANGE inside the window, so they're left alone.
const EDGE_RADIUS = 3;
const EDGE_RANGE = 24;
const FOREGROUND_BIAS = 0.45; // slightly below the midpoint so the subject keeps its whole outline
export const sharpenEdges = (src: Uint8Array, size: number): Uint8Array => {
  const { lo, hi } = windowMinMax(src, size, EDGE_RADIUS);
  const out = new Uint8Array(src);
  for (let i = 0; i < out.length; i++) {
    const range = hi[i] - lo[i];
    if (range >= EDGE_RANGE) out[i] = src[i] - lo[i] > range * FOREGROUND_BIAS ? hi[i] : lo[i];
  }
  return out;
};

// Model output → stored map (before edge sharpening)
export const postProcess = (raw: Uint8Array, width: number, height: number) =>
  bilateral(median3(resample(raw, width, height, DEPTH_SIZE), DEPTH_SIZE), DEPTH_SIZE);
