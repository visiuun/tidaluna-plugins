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
// The snapped map (data) is what the CPU works with. The GPU gets the smooth depth plus the two sides
// of each edge (edges: RGBA = smooth, lo, hi) and snaps per sample: thresholding the bilinearly
// filtered depth gives smooth silhouettes instead of 384px stair steps.
const EDGE_RADIUS = 3;
export const EDGE_RANGE = 24;
export const FOREGROUND_BIAS = 0.45; // slightly below the midpoint so the subject keeps its whole outline
export const sharpenEdges = (src: Uint8Array, size: number, rgba?: Uint8ClampedArray | Uint8Array) => {
  const { lo, hi } = windowMinMax(src, size, EDGE_RADIUS);
  const ramp = new Uint8Array(src);
  if (rgba) followColourEdges(ramp, src, lo, hi, size, rgba);
  const data = new Uint8Array(src);
  const edges = new Uint8Array(src.length * 4);
  for (let i = 0; i < data.length; i++) {
    const range = hi[i] - lo[i];
    if (range >= EDGE_RANGE) data[i] = ramp[i] - lo[i] > range * FOREGROUND_BIAS ? hi[i] : lo[i];
    edges[i * 4] = ramp[i];
    edges[i * 4 + 1] = lo[i];
    edges[i * 4 + 2] = hi[i];
  }
  return { data, edges };
};

// The model's edges are a few pixels soft and don't sit exactly on the object's outline, so snapping
// them by depth alone bites into letters and drops thin parts. Inside each edge band, re-place the
// ramp by colour instead: how far a pixel's colour lies from the nearby far side towards the nearby
// near side is how much of it belongs to the near side (a matte). Only trusted where the two sides
// are cleanly separable (flat colours far apart, like lettering): on textured or blurry edges (hair,
// leather highlights) colour would misplace pixels, so the depth ramp stays. Colour can't overrule
// clear depth either way.
// With sides, also writes each edge pixel's two colours for the renderer, which repeats the matte on
// the full-resolution cover so silhouettes are as crisp as the artwork: near = (near colour, 255) and
// far = (far colour, 255), both scaled by trust, so filtering between edge and non-edge texels can
// be undone by dividing by alpha.
const MATTE_CONTRAST = [16, 48]; // colour distance (0-441) between the sides: depth only → colour only
const MATTE_SEPARATION = [2, 4]; // that distance over the sides' own colour spread: same ramp
export type Sides = { near: Uint8Array; far: Uint8Array };
const followColourEdges = (
  ramp: Uint8Array,
  src: Uint8Array,
  lo: Uint8Array,
  hi: Uint8Array,
  size: number,
  rgba: Uint8ClampedArray | Uint8Array,
  sides?: Sides,
) => {
  const r = EDGE_RADIUS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const range = hi[i] - lo[i];
      if (range < EDGE_RANGE * 0.75) continue;
      const nearCut = lo[i] + range * 0.75;
      const farCut = lo[i] + range * 0.25;
      let nn = 0, nr = 0, ng = 0, nb = 0, nq = 0, fn = 0, fr = 0, fg = 0, fb = 0, fq = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(size - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(size - 1, x + r); xx++) {
          const j = yy * size + xx;
          const dj = src[j];
          if (dj >= nearCut) {
            nn++;
            nr += rgba[j * 4];
            ng += rgba[j * 4 + 1];
            nb += rgba[j * 4 + 2];
            nq += rgba[j * 4] ** 2 + rgba[j * 4 + 1] ** 2 + rgba[j * 4 + 2] ** 2;
          } else if (dj <= farCut) {
            fn++;
            fr += rgba[j * 4];
            fg += rgba[j * 4 + 1];
            fb += rgba[j * 4 + 2];
            fq += rgba[j * 4] ** 2 + rgba[j * 4 + 1] ** 2 + rgba[j * 4 + 2] ** 2;
          }
        }
      }
      if (!nn || !fn) continue;
      const er = nr / nn - fr / fn, eg = ng / nn - fg / fn, eb = nb / nn - fb / fn;
      const contrast2 = er * er + eg * eg + eb * eb;
      if (contrast2 < MATTE_CONTRAST[0] ** 2) continue;
      const t = (rgba[i * 4] - fr / fn) * er + (rgba[i * 4 + 1] - fg / fn) * eg + (rgba[i * 4 + 2] - fb / fn) * eb;
      const byColour = Math.min(1, Math.max(0, t / contrast2));
      const byDepth = (src[i] - lo[i]) / range;
      const contrast = Math.sqrt(contrast2);
      const nearSpread = Math.sqrt(Math.max(0, nq / nn - ((nr / nn) ** 2 + (ng / nn) ** 2 + (nb / nn) ** 2)));
      const farSpread = Math.sqrt(Math.max(0, fq / fn - ((fr / fn) ** 2 + (fg / fn) ** 2 + (fb / fn) ** 2)));
      const separation = contrast / (nearSpread + farSpread + 1);
      const trust =
        Math.min(1, (contrast - MATTE_CONTRAST[0]) / (MATTE_CONTRAST[1] - MATTE_CONTRAST[0])) *
        Math.min(1, Math.max(0, (separation - MATTE_SEPARATION[0]) / (MATTE_SEPARATION[1] - MATTE_SEPARATION[0])));
      if (trust <= 0) continue;
      if (sides) {
        sides.near[i * 4] = (nr / nn) * trust;
        sides.near[i * 4 + 1] = (ng / nn) * trust;
        sides.near[i * 4 + 2] = (nb / nn) * trust;
        sides.near[i * 4 + 3] = 255 * trust;
        sides.far[i * 4] = (fr / fn) * trust;
        sides.far[i * 4 + 1] = (fg / fn) * trust;
        sides.far[i * 4 + 2] = (fb / fn) * trust;
        sides.far[i * 4 + 3] = 255 * trust;
      }
      const a = Math.min(byDepth + 0.6, Math.max(byDepth - 0.6, byDepth + (byColour - byDepth) * trust));
      ramp[i] = Math.round(lo[i] + a * range);
    }
  }
};

/** Near/far colours of each edge (see followColourEdges), from the edges texture and the cover at its size */
export const edgeSides = (edges: Uint8Array, size: number, rgba: Uint8ClampedArray | Uint8Array): Sides => {
  const n = size * size;
  const src = new Uint8Array(n), lo = new Uint8Array(n), hi = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    src[i] = edges[i * 4];
    lo[i] = edges[i * 4 + 1];
    hi[i] = edges[i * 4 + 2];
  }
  const sides = { near: new Uint8Array(n * 4), far: new Uint8Array(n * 4) };
  followColourEdges(new Uint8Array(src), src, lo, hi, size, rgba, sides);
  return sides;
};

// Model output → stored map (before edge sharpening)
export const postProcess = (raw: Uint8Array, width: number, height: number) =>
  bilateral(median3(resample(raw, width, height, DEPTH_SIZE), DEPTH_SIZE), DEPTH_SIZE);
