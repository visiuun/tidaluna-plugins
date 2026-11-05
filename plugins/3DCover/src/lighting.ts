// Surface map for lighting: normals from the AI depth map plus a gloss estimate from the cover.
// Built once per cover on the CPU in a few ms; the shader relights, reflects and shadows with it.

import type { DepthMap } from "./depth";
import { EDGE_RANGE, windowMinMax } from "./postprocess";

// Depth step (0-255) between neighbours that counts as one surface in front of another:
// smoothing and slopes never cross it, so silhouettes don't turn into bright or dark outlines
const CLIFF = 12;
// The model's depth is 8-bit: smooth over this radius (half-size px, within each surface) so slopes
// aren't terraced
const SMOOTH_RADIUS = 4;
// How tall the depth range is compared to the cover's width: higher = deeper relief in the lighting
const RELIEF = 0.35;
// Blur radius (half-size px, two box passes) of the height that casts shadows
const SHADOW_BLUR = 2;

// One pass of a box blur along x or y that only averages neighbours on the same surface
const smoothAlong = (src: Float32Array, size: number, horizontal: boolean) => {
  const out = new Float32Array(src.length);
  const r = SMOOTH_RADIUS;
  const step = horizontal ? 1 : size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const at = horizontal ? x : y;
      const j0 = i - Math.min(r, at) * step;
      const j1 = i + Math.min(r, size - 1 - at) * step;
      const c = src[i];
      let sum = 0, n = 0;
      for (let j = j0; j <= j1; j += step) {
        const v = src[j];
        if (v - c < CLIFF && c - v < CLIFF) {
          sum += v;
          n++;
        }
      }
      out[i] = sum / n;
    }
  }
  return out;
};

// Plain box sum over 2r+1 along x or y (running sum; near the borders, scaled up as if the window were full)
const boxSum = (src: Float32Array, size: number, horizontal: boolean, r = 2) => {
  const out = new Float32Array(src.length);
  const step = horizontal ? 1 : size;
  const lineStep = horizontal ? size : 1;
  const full = 2 * r + 1;
  for (let line = 0; line < size; line++) {
    const base = line * lineStep;
    let s = 0;
    for (let k = 0; k <= Math.min(r, size - 1); k++) s += src[base + k * step];
    for (let x = 0; x < size; x++) {
      const n = Math.min(x, r) + Math.min(size - 1 - x, r) + 1;
      out[base + x * step] = n === full ? s : s * (full / n);
      if (x + r + 1 < size) s += src[base + (x + r + 1) * step];
      if (x - r >= 0) s -= src[base + (x - r) * step];
    }
  }
  return out;
};

// Slope from the neighbours on the same surface as the centre (one-sided next to a cliff, flat across one)
const slope = (before: number, c: number, after: number) => {
  const f = after - c, b = c - before;
  const fOk = Math.abs(f) < CLIFF, bOk = Math.abs(b) < CLIFF;
  if (fOk && bOk) return (f + b) / 2;
  return fOk ? f : bOk ? b : 0;
};

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Built at half the depth map's resolution: lighting only needs the broad shape, and the model's depth
 * has small bumps inside flat things (lettering, graphics) that would otherwise shade like dents.
 * @param rgba cover pixels, size²
 * @param depth snapped depth map (high = near) and its edges texture, size²
 * @returns (size/2)² RGBA: rg = surface normal xy (0.5 = facing the viewer), b = gloss,
 *          a = blurred depth (what casts shadows: soft-edged, so shadows get a penumbra)
 */
export const buildSurface = (rgba: Uint8ClampedArray | Uint8Array, depth: Pick<DepthMap, "data" | "edges">, size: number) => {
  // From the local spread of brightness over a 5×5 window:
  // Gloss: smooth, untextured areas (skin, sky, paint, plastic) catch highlights; textured ones (hair,
  // foliage, fabric, noise) stay matte.
  // Print: dead-flat colour (lettering, logos, graphics). Real curved surfaces show at least some
  // shading in the photo, so these are flat however the model shaped them (it domes every letter).
  const n = size * size;
  const lum = new Float32Array(n);
  const lum2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    lum2[i] = lum[i] * lum[i];
  }
  const sum = boxSum(boxSum(lum, size, true), size, false);
  const sq = boxSum(boxSum(lum2, size, true), size, false);

  // Down to half size: depth and gloss averaged, edge bands kept wherever any of the 2×2 is in one
  const h = size >> 1;
  const m = h * h;
  const depthH = new Float32Array(m);
  const gloss = new Float32Array(m);
  const print = new Float32Array(m);
  const ranges = new Uint8Array(m);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      let dSum = 0, gSum = 0, pSum = 0, range = 0;
      for (let k = 0; k < 4; k++) {
        const i = (2 * y + (k >> 1)) * size + 2 * x + (k & 1);
        dSum += depth.data[i];
        const mean = sum[i] / 25;
        const spread = Math.sqrt(Math.max(0, sq[i] / 25 - mean * mean));
        gSum += 1 - smoothstep(3, 18, spread);
        pSum += 1 - smoothstep(0.8, 2.5, spread);
        range = Math.max(range, depth.edges[i * 4 + 2] - depth.edges[i * 4 + 1]);
      }
      const j = y * h + x;
      depthH[j] = dSum / 4;
      gloss[j] = gSum / 4;
      print[j] = pSum / 4;
      ranges[j] = range;
    }
  }

  // The model blurs silhouettes into ramps several px wide, which would read as steep surfaces and
  // draw bright or dark rings round every object: keep edge bands and a little around them flat
  const near = windowMinMax(ranges, h, 2).hi;

  let d = depthH;
  for (let pass = 0; pass < 2; pass++) d = smoothAlong(smoothAlong(d, h, true), h, false);
  let blurred = depthH;
  for (let pass = 0; pass < 2; pass++) blurred = boxSum(boxSum(blurred, h, true, SHADOW_BLUR), h, false, SHADOW_BLUR);
  const blurNorm = 1 / (2 * SHADOW_BLUR + 1) ** 4;
  // Spread over the whole shape, so a letter is flat right up to its outline
  const printed = boxSum(boxSum(print, h, true), h, false);

  const scale = (RELIEF * h) / 255;
  let gxs = new Float32Array(m);
  let gys = new Float32Array(m);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const i = y * h + x;
      const k = scale * (1 - smoothstep(EDGE_RANGE * 0.4, EDGE_RANGE * 0.9, near[i])) * (1 - 0.85 * Math.min(1, printed[i] / 25));
      gxs[i] = slope(d[i - (x > 0 ? 1 : 0)], d[i], d[i + (x < h - 1 ? 1 : 0)]) * k;
      gys[i] = slope(d[i - (y > 0 ? h : 0)], d[i], d[i + (y < h - 1 ? h : 0)]) * k;
    }
  }
  // Smoothed once more so lone texels can't glint or go dark
  gxs = boxSum(boxSum(gxs, h, true, 1), h, false, 1);
  gys = boxSum(boxSum(gys, h, true, 1), h, false, 1);

  const out = new Uint8Array(m * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const i = y * h + x;
      const gx = gxs[i] / 9, gy = gys[i] / 9;
      // Height rises with depth (high = near), so the surface faces away from the uphill direction
      const len = Math.sqrt(gx * gx + gy * gy + 1);
      out[i * 4] = Math.round((-gx / len) * 127.5 + 127.5);
      out[i * 4 + 1] = Math.round((-gy / len) * 127.5 + 127.5);
      out[i * 4 + 2] = Math.round(255 * gloss[i]);
      out[i * 4 + 3] = Math.round(blurred[i] * blurNorm);
    }
  }
  return { size: h, data: out };
};

// Last few covers' maps (~150 KB each), so going back and forth doesn't rebuild them
export type Surface = ReturnType<typeof buildSurface>;
const cache = new Map<DepthMap, { image: ImageBitmap; surface: Surface }>();
const MAX_CACHED = 3;

export const surfaceFor = (image: ImageBitmap, depth: DepthMap): Surface => {
  const hit = cache.get(depth);
  if (hit && hit.image === image) {
    cache.delete(depth);
    cache.set(depth, hit);
    return hit.surface;
  }
  const { size } = depth;
  const ctx = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, size, size);
  const surface = buildSurface(ctx.getImageData(0, 0, size, size).data, depth, size);
  cache.set(depth, { image, surface });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return surface;
};

export const clearSurfaces = () => cache.clear();
