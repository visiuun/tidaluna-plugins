// Background layer: the cover with every foreground pulled back from its depth cliffs, so the
// renderer has background texture to show in the gaps that open up behind moving foreground.
// Built once per cover on the CPU in a few ms; the shader only samples it inside those gaps.

import type { DepthMap } from "./depth";
import { windowMinMax } from "./postprocess";

// Depth step (0-255) between neighbours that counts as one surface in front of another
const CLIFF = 12;
// Background pixels this close to a cliff often carry the foreground's anti-aliased rim, so they're
// never used as a colour source and get repainted from cleaner background
const RIM = 2;
// Lateral blur over the filled area, so the grown-in texture doesn't streak: sparse taps over a 7×7 window
const TAPS = [-3, -1, 1, 3];
const RIM_RADIUS = 3;

const N8 = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];

/**
 * @param rgba cover pixels, size² (any alpha)
 * @param depth depth map, size² (high = near)
 * @param reach how far (px) background grows in behind foreground: the widest gap the tilt can open
 * @returns layer: size² RGBA, rgb = background colour, a = background depth
 *          rim: size² RGBA, rgb = rim pixels repainted from their own surface, a = 255 on the rim
 */
export const buildBackground = (rgba: Uint8ClampedArray | Uint8Array, depth: Uint8Array, size: number, reach: number) => {
  const n = size * size;
  const d = Float32Array.from(depth);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = rgba[i * 4];
    col[i * 3 + 1] = rgba[i * 4 + 1];
    col[i * 3 + 2] = rgba[i * 4 + 2];
  }
  const filled = new Uint8Array(n);
  const seen = new Int32Array(n).fill(-1);

  // rim: background within RIM px of a nearer surface. Pixels with a much farther neighbour can grow first.
  const { lo, hi } = windowMinMax(depth, size, RIM);
  const rim = new Uint8Array(n);
  let candidates = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (hi[i] - depth[i] > CLIFF) rim[i] = 1;
    if (depth[i] - lo[i] > CLIFF) candidates[count++] = i;
  }

  // Grow background one pixel per pass across every cliff, carrying its depth and colour along.
  // Only pixels next to last pass's changes can change, so each pass just visits that ring.
  // Each pixel is filled once, from the nearest layer behind it: behind a nose is cheek, not the wall
  // that would otherwise flood in later from the edge of the face.
  const upd = new Int32Array(n);
  let next = new Int32Array(n);
  const updVal = new Float32Array(n * 4);
  for (let pass = 0; pass < reach && count > 0; pass++) {
    let m = 0;
    for (let c = 0; c < count; c++) {
      const i = candidates[c];
      if (filled[i]) continue;
      const x = i % size;
      const y = (i - x) / size;
      const limit = d[i] - CLIFF;
      let nearest = -1;
      for (let k = 0; k < 16; k += 2) {
        const nx = x + N8[k];
        const ny = y + N8[k + 1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const dj = d[ny * size + nx];
        if (dj < limit && dj > nearest) nearest = dj;
      }
      if (nearest < 0) continue;
      let w = 0, sd = 0, sr = 0, sg = 0, sb = 0;
      for (let k = 0; k < 16; k += 2) {
        const nx = x + N8[k];
        const ny = y + N8[k + 1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (d[j] >= limit || d[j] <= nearest - CLIFF) continue;
        // Original rim pixel: take its colour from further out (that surface or one further back)
        let src = j;
        if (rim[j] && !filled[j]) {
          const fx = Math.min(size - 1, Math.max(0, nx + N8[k] * RIM));
          const fy = Math.min(size - 1, Math.max(0, ny + N8[k + 1] * RIM));
          if (d[fy * size + fx] < d[j] + CLIFF) src = fy * size + fx;
        }
        const wk = N8[k] && N8[k + 1] ? 0.7 : 1;
        w += wk;
        sd += d[j] * wk;
        sr += col[src * 3] * wk;
        sg += col[src * 3 + 1] * wk;
        sb += col[src * 3 + 2] * wk;
      }
      if (w === 0) continue;
      upd[m] = i;
      updVal[m * 4] = sd / w;
      updVal[m * 4 + 1] = sr / w;
      updVal[m * 4 + 2] = sg / w;
      updVal[m * 4 + 3] = sb / w;
      m++;
    }

    // Apply after the pass so growth is exactly one pixel per pass, then queue the changed pixels' neighbours
    count = 0;
    for (let u = 0; u < m; u++) {
      const i = upd[u];
      d[i] = updVal[u * 4];
      col[i * 3] = updVal[u * 4 + 1];
      col[i * 3 + 1] = updVal[u * 4 + 2];
      col[i * 3 + 2] = updVal[u * 4 + 3];
      filled[i] = 1;
    }
    for (let u = 0; u < m; u++) {
      const i = upd[u];
      const x = i % size;
      const y = (i - x) / size;
      for (let k = 0; k < 16; k += 2) {
        const nx = x + N8[k];
        const ny = y + N8[k + 1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (seen[j] === pass) continue;
        seen[j] = pass;
        next[count++] = j;
      }
    }
    [candidates, next] = [next, candidates];
  }

  // Soften the grown-in area and repaint the rim, from clean neighbours on the same background surface
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    let r = col[i * 3], g = col[i * 3 + 1], b = col[i * 3 + 2];
    if (filled[i] || rim[i]) {
      const x = i % size;
      const y = (i - x) / size;
      let w = 0;
      r = g = b = 0;
      for (const dy of TAPS) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (const dx of TAPS) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          const j = yy * size + xx;
          if (rim[j] && !filled[j]) continue;
          if (Math.abs(d[j] - d[i]) >= CLIFF) continue;
          w++;
          r += col[j * 3];
          g += col[j * 3 + 1];
          b += col[j * 3 + 2];
        }
      }
      if (w > 0) {
        r /= w;
        g /= w;
        b /= w;
      } else {
        r = col[i * 3];
        g = col[i * 3 + 1];
        b = col[i * 3 + 2];
      }
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = Math.round(d[i]);
  }
  return { layer: out, rim: repaintRim(rgba, depth, rim, size) };
};

// The cover's own colours with each rim pixel replaced by clean pixels on its surface, or (for slivers
// too thin to have any) by clean pixels further back. Independent of the grown-in background, which
// may hold a layer further back than the rim's own surface.
const repaintRim = (rgba: Uint8ClampedArray | Uint8Array, depth: Uint8Array, rim: Uint8Array, size: number) => {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = rgba[i * 4];
    out[i * 4 + 1] = rgba[i * 4 + 1];
    out[i * 4 + 2] = rgba[i * 4 + 2];
    if (!rim[i]) continue;
    out[i * 4 + 3] = 255;
    const x = i % size;
    const y = (i - x) / size;
    for (const sameSurface of [true, false]) {
      let w = 0, r = 0, g = 0, b = 0;
      for (let dy = -RIM_RADIUS; dy <= RIM_RADIUS; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -RIM_RADIUS; dx <= RIM_RADIUS; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          const j = yy * size + xx;
          if (rim[j]) continue;
          const dd = depth[j] - depth[i];
          if (sameSurface ? Math.abs(dd) >= CLIFF : dd >= CLIFF) continue;
          w++;
          r += rgba[j * 4];
          g += rgba[j * 4 + 1];
          b += rgba[j * 4 + 2];
        }
      }
      if (w === 0) continue;
      out[i * 4] = r / w;
      out[i * 4 + 1] = g / w;
      out[i * 4 + 2] = b / w;
      break;
    }
  }
  // Foreground texels touching the rim carry the repainted colour too (still a = 0): the texture is
  // filtered, and the repaint applies right up to the edge, where it would otherwise blend in the
  // foreground's own colour and leave a faint outline
  const size2 = size * size;
  const edge = new Uint8Array(out);
  for (let i = 0; i < size2; i++) {
    if (rim[i]) continue;
    const x = i % size;
    const y = (i - x) / size;
    let w = 0, r = 0, g = 0, b = 0;
    for (let k = 0; k < 16; k += 2) {
      const nx = x + N8[k];
      const ny = y + N8[k + 1];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (!rim[j] || depth[j] >= depth[i]) continue;
      w++;
      r += out[j * 4];
      g += out[j * 4 + 1];
      b += out[j * 4 + 2];
    }
    if (w === 0) continue;
    edge[i * 4] = r / w;
    edge[i * 4 + 1] = g / w;
    edge[i * 4 + 2] = b / w;
  }
  return edge;
};

// ------------------ CACHE ------------------
// A few covers' worth (~1.2 MB each): the playing one, the preloaded next one, and the previous one
type Background = ReturnType<typeof buildBackground> & { image: ImageBitmap; reach: number };
const cache = new Map<DepthMap, Background>();
const MAX_CACHED = 3;

/** Gap width (depth-map px) the tilt can open at this Depth Shift, rounded up so small changes reuse the layer */
export const reachFor = (intensity: number, size: number) => Math.ceil(((intensity / 500) * Math.SQRT2 * size + 2) / 8) * 8;

/** Background layer for a cover, built (or rebuilt wider) only when needed */
export const backgroundFor = (image: ImageBitmap, depth: DepthMap, reach: number): Background => {
  const hit = cache.get(depth);
  if (hit && hit.image === image && hit.reach >= reach) {
    cache.delete(depth);
    cache.set(depth, hit);
    return hit;
  }
  const { size } = depth;
  const ctx = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, size, size);
  const bg = { ...buildBackground(ctx.getImageData(0, 0, size, size).data, depth.data, size, reach), image, reach };
  cache.delete(depth);
  cache.set(depth, bg);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return bg;
};

export const clearBackgrounds = () => cache.clear();
