// Immersive Bloom: soft white glows at the edges of TIDAL's window where the sounds of the song come from, the
// way a game shows round the screen where things are around you. The top of the window is in front of you, the
// bottom behind, the sides left and right; higher sounds sit higher and lower ones lower. Only sound placed
// somewhere lights up: what is straight ahead in the middle (the vocal, the kick, the bass of most songs) never does.
//
// Each track is listened to once, ahead of time, in a worker (see bloom.worker.js): every 10 ms of it becomes how
// much sound comes from each of 48 directions. Playing, the page only looks up where TIDAL's player is in the
// track and draws that, so the glows are neither late nor behind the music: there is nothing to work out live.
import { type LunaUnload, Tracer } from "@luna/core";
import workerSource from "file://./bloom.worker.js";
import { MEASURED, settings, SETTINGS_EVENT, type PluginSettings } from "./Settings";
import { trackStream } from "./source";

export { Settings } from "./Settings";

export const { trace, errSignal } = Tracer("[ImmersiveBloom]");
export const unloads = new Set<LunaUnload>();

// @luna/lib is read from window.luna instead of imported: Luna's import wrapper for plugin modules registers a
// dependency and throws if Luna's registry doesn't hold this plugin at that instant (during reloads; see 3DCover)
const lib = () => window.luna.lib!;
const core = () => window.luna.core!;
const state = () => lib().redux.store.getState();

// ------------------ THE WORKER ------------------
type Directions = {
  fps: number;
  bins: number;
  frames: number;
  data: Uint8Array;
  spatialShare: number;
  levels: Record<string, number>;
  mono?: boolean;
  seconds?: number;
  ms?: Record<string, number>;
};
const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
unloads.add(() => URL.revokeObjectURL(workerUrl));
let worker: Worker | undefined;
let jobSeq = 0;
const jobs = new Map<number, { resolve: (d: Directions) => void; reject: (e: Error) => void }>();
const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(workerUrl);
  worker.onmessage = ({ data }) => {
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.type === "done") job.resolve(data.result);
    else job.reject(new Error(data.error));
  };
  worker.onerror = (e) => {
    for (const job of jobs.values()) job.reject(new Error(`Worker failed: ${e.message}`));
    jobs.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
};
unloads.add(() => {
  worker?.terminate();
  worker = undefined;
  jobs.clear();
});

// ------------------ TRACKS ------------------
// What was measured for the last few tracks; the one playing first, then the next in the queue. One at a time
type Entry = {
  id: string;
  key: string;
  status: "queued" | "running" | "done" | "failed";
  result?: Directions;
  jobId?: number;
  failedAt?: number;
};
const entries = new Map<string, Entry>();
const KEEP = 12;
const measureKey = () => MEASURED.map((k) => settings[k]).join("|");
let running: Entry | undefined;

const currentId = (): string | undefined => {
  const product = state().playbackControls?.mediaProduct;
  if (!product || (product.productType && product.productType !== "track")) return undefined;
  return product.productId != null ? String(product.productId) : undefined;
};
const nextId = (): string | undefined => {
  const pq = state().playQueue;
  const el = pq?.elements?.[(pq.currentIndex ?? -1) + 1];
  return el?.mediaItemId != null ? String(el.mediaItemId) : undefined;
};

const want = (id: string | undefined) => {
  if (!id) return;
  const key = measureKey();
  const e = entries.get(id);
  // (a track that failed is tried again a minute later at the soonest)
  if (e && e.key === key && (e.status !== "failed" || Date.now() - (e.failedAt ?? 0) < 60000)) return;
  entries.delete(id);
  entries.set(id, { id, key, status: "queued" });
  while (entries.size > KEEP) {
    const oldest = entries.keys().next().value!;
    if (entries.get(oldest) === running) break;
    entries.delete(oldest);
  }
};

const pump = async () => {
  const cur = currentId();
  const nxt = nextId();
  want(cur);
  want(nxt);
  // A measurement for something no longer playing or next is dropped
  if (running && running.id !== cur && running.id !== nxt && running.jobId !== undefined) {
    worker?.postMessage({ type: "cancel", id: running.jobId });
  }
  if (running) return;
  const pick = [cur, nxt].map((id) => id && entries.get(id)).find((e) => e && e.status === "queued");
  if (!pick) return;
  const entry = (running = pick);
  entry.status = "running";
  const t0 = performance.now();
  try {
    const stream = await trackStream(entry.id);
    const id = (entry.jobId = ++jobSeq);
    const result = await new Promise<Directions>((resolve, reject) => {
      jobs.set(id, { resolve, reject });
      getWorker().postMessage({ type: "analyse", id, urls: stream.urls, opts: { seconds: stream.seconds, height: settings.height / 100 } });
    });
    if (entries.get(entry.id) === entry && entry.key === measureKey()) {
      entry.result = result;
      entry.status = "done";
    }
    const lv = result.levels;
    trace.log(
      `Track ${entry.id}: ${result.seconds?.toFixed(0)} s listened to in ${Math.round(performance.now() - t0)} ms (worker ${result.ms?.total} ms), ` +
        `${Math.round(result.spatialShare * 100)}% of it placed in 3D${result.mono ? " (mono)" : ""}, levels p50 ${lv.p50.toFixed(2)} p90 ${lv.p90.toFixed(2)} p99 ${lv.p99.toFixed(2)}`,
    );
  } catch (err) {
    entry.status = "failed";
    entry.failedAt = Date.now();
    if (!/cancelled/.test(String((err as Error)?.message))) trace.warn(`Couldn't listen to track ${entry.id}`, err);
  } finally {
    if (running === entry) running = undefined;
    entry.jobId = undefined;
    void pump();
  }
};
const pumpTimer = setInterval(() => void pump(), 500);
unloads.add(() => clearInterval(pumpTimer));

const onSettings = (e: Event) => {
  const key = (e as CustomEvent).detail as keyof PluginSettings;
  // (what was measured with the old setting is measured again, the track playing first)
  if (MEASURED.includes(key)) void pump();
};
window.addEventListener(SETTINGS_EVENT, onSettings);
unloads.add(() => window.removeEventListener(SETTINGS_EVENT, onSettings));

// ------------------ WHERE THE PLAYER IS ------------------
// TIDAL moves its position on only four times a second. The clock here runs on its own between those, and each
// new reading nudges it rather than setting it, so it neither jumps nor drifts; a seek or a pause resets it.
type Player = { currentTime?: number };
let playerModule: { activePlayer?: Player } | undefined;
const activePlayer = () => {
  // (from the player that is active now: TIDAL has two, its own and a web player it changes to for some songs,
  // and Luna's PlayState keeps hold of the first one it found; as the DJ does)
  try {
    playerModule ??= core().findModuleByProperty(
      (key: unknown, value: unknown) =>
        key === "activePlayer" && typeof value === "object" && value !== null && "currentTime" in (value as object),
    ) as any;
  } catch {}
  return playerModule?.activePlayer;
};
const rawPosition = () => {
  const live = Number(activePlayer()?.currentTime);
  return Number.isFinite(live) ? live : Number(lib().PlayState.currentTime);
};
const isPlaying = () => state().playbackControls?.playbackState === "PLAYING";

const clock = { pos: 0, at: 0, raw: NaN, track: "" };
const position = (now: number, playing: boolean, track: string) => {
  const raw = rawPosition();
  if (track !== clock.track) {
    clock.track = track;
    clock.raw = NaN;
  }
  const predicted = clock.pos + (playing ? (now - clock.at) / 1000 : 0);
  if (raw !== clock.raw) {
    const first = Number.isNaN(clock.raw);
    clock.raw = raw;
    if (first || !playing || Math.abs(raw - predicted) > 0.3) clock.pos = raw;
    else clock.pos = predicted + (raw - predicted) * 0.25;
    clock.at = now;
  } else if (!playing) {
    clock.pos = raw;
    clock.at = now;
  }
  return clock.pos + (playing ? (now - clock.at) / 1000 : 0);
};

// ------------------ DRAWING ------------------
const NB = 48;
const DEC = Float32Array.from({ length: 256 }, (_, u) => (u / 255) ** 2 * 2);
const level = new Float32Array(NB);
const smooth = new Float32Array(NB);
const target = new Float32Array(NB);
const shown = new Float32Array(NB);

const canvas = document.createElement("canvas");
canvas.className = "visiuun-immersive-bloom";
Object.assign(canvas.style, {
  position: "fixed",
  inset: "0",
  width: "100vw",
  height: "100vh",
  maxWidth: "none",
  maxHeight: "none",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "visible",
  pointerEvents: "none",
  zIndex: "2147483647",
  mixBlendMode: "screen",
} as CSSStyleDeclaration);
// (the DJ's full screen hides everything else in the page while it is open, with !important: an !important in
// the element's own style is the one thing that wins over that)
canvas.style.setProperty("visibility", "visible", "important");
canvas.style.setProperty("display", "block", "important");
canvas.style.setProperty("opacity", "1", "important");
// On top of everything: in the page's top layer (as a popover), which is drawn over every z-index, the DJ's full
// screen included (that sits at the same z-index as anything can, so whichever came into the page last was on top).
// Whatever comes into the top layer after it (a dialog, another popover, a full-screen element) goes over it, so it
// is put back on top whenever the top layer changes
canvas.setAttribute("popover", "manual");
document.body.appendChild(canvas);
unloads.add(() => canvas.remove());
let topSignature = "";
const raise = () => {
  if (!canvas.isConnected) document.body.appendChild(canvas);
  try {
    const others: Element[] = [];
    for (const el of document.querySelectorAll(":modal, :popover-open")) if (el !== canvas) others.push(el);
    if (document.fullscreenElement) others.push(document.fullscreenElement);
    const signature = others.map((el) => `${el.tagName}.${el.className}`).join("|") + `#${others.length}`;
    const open = canvas.matches(":popover-open");
    if (open && signature === topSignature) return;
    topSignature = signature;
    if (open) canvas.hidePopover();
    canvas.showPopover();
  } catch {
    // (no top layer here: the z-index has to do, from the end of the page)
    if (document.body.lastElementChild !== canvas) document.body.appendChild(canvas);
  }
};
raise();
document.addEventListener("fullscreenchange", raise);
unloads.add(() => document.removeEventListener("fullscreenchange", raise));
const raiseTimer = setInterval(raise, 1000);
unloads.add(() => clearInterval(raiseTimer));
const ctx = canvas.getContext("2d")!;
// Drawn at a quarter of the window's size and stretched: the glows are soft all over, and it costs a sixteenth
const SCALE = 4;
const fit = () => {
  const w = Math.max(16, Math.ceil(window.innerWidth / SCALE));
  const h = Math.max(16, Math.ceil(window.innerHeight / SCALE));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
};

/** The sound at time t, direction by direction (0 = in front, clockwise) */
const sample = (d: Directions, t: number) => {
  const f = t * d.fps;
  const i = Math.floor(f);
  if (i < 0 || i >= d.frames) return false;
  const j = Math.min(d.frames - 1, i + 1);
  const fr = f - i;
  const a = i * d.bins;
  const b = j * d.bins;
  for (let k = 0; k < NB; k++) level[k] = DEC[d.data[a + k]] * (1 - fr) + DEC[d.data[b + k]] * fr;
  return true;
};

/**
 * From the level in every direction to the few glows to show: the strongest few places (Most Glows At Once),
 * each a soft bump the width of its sound, so a busy mix lights a few spots and never the whole border
 */
const pickGlows = (gain: number, maxGlows: number) => {
  for (let k = 0; k < NB; k++) smooth[k] = (level[(k + NB - 1) % NB] + 2 * level[k] + level[(k + 1) % NB]) * 0.25 * gain;
  let top = 0;
  for (let k = 0; k < NB; k++) top = Math.max(top, smooth[k]);
  target.fill(0);
  if (top < 0.04) return;
  const peaks: { at: number; v: number; width: number }[] = [];
  for (let k = 0; k < NB; k++) {
    const v = smooth[k];
    const l = smooth[(k + NB - 1) % NB];
    const r = smooth[(k + 1) % NB];
    if (v < 0.04 || v < top * 0.4 || v < l || v <= r) continue;
    // (where exactly, between bins, from the curve through the three)
    const den = l - 2 * v + r;
    const at = k + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0);
    // (how wide: as far as it stays above half)
    let w = 0;
    while (w < NB / 4 && smooth[(k + w + 1) % NB] > v * 0.5) w++;
    let w2 = 0;
    while (w2 < NB / 4 && smooth[(k + NB - w2 - 1) % NB] > v * 0.5) w2++;
    peaks.push({ at, v, width: Math.max(1, Math.min(2.5, (w + w2 + 1) / 2.4)) });
  }
  peaks.sort((x, y) => y.v - x.v);
  for (const p of peaks.slice(0, maxGlows)) {
    for (let k = 0; k < NB; k++) {
      let d = Math.abs(k - p.at);
      if (d > NB / 2) d = NB - d;
      const v = p.v * Math.exp((-d * d) / (2 * p.width * p.width));
      if (v > target[k]) target[k] = v;
    }
  }
};

const draw = () => {
  fit();
  const W = canvas.width;
  const H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // (never more than about a fifth of the whole border lit, however busy the song)
  let total = 0;
  for (let k = 0; k < NB; k++) total += Math.min(1, shown[k]);
  const budget = Math.min(1, (NB * 0.2) / Math.max(1e-6, total));
  const R = Math.min(W, H) * (0.14 + 0.24 * (settings.size / 100));
  const perimeter = 2 * (W + H);
  const spacing = perimeter / NB;
  const along = R * 1.4;
  const across = R * 1.0;
  // (the bins overlap: each gives its share so neighbours add up to the level)
  const share = Math.min(1, spacing / (along * 0.5));
  const peak = settings.intensity / 100;
  ctx.globalCompositeOperation = "lighter";
  for (let k = 0; k < NB; k++) {
    const v = Math.min(1, shown[k] * budget);
    if (v < 0.004) continue;
    const a = v * peak * share;
    const ang = (k / NB) * Math.PI * 2;
    const sx = Math.sin(ang);
    const sy = -Math.cos(ang);
    const m = Math.max(Math.abs(sx), Math.abs(sy));
    const px = sx / m;
    const py = sy / m;
    // On the window's edge (a square around you stretched to the window: the corners are the diagonals), a little outside it
    const sideness = Math.max(0, Math.min(1, (Math.abs(sx) - Math.abs(sy)) * 2 + 0.5));
    const x = (W / 2) * (1 + px) + px * across * 0.25 * sideness;
    const y = (H / 2) * (1 + py) + py * across * 0.25 * (1 - sideness);
    const ex = along * (1 - sideness) + across * sideness;
    const ey = across * (1 - sideness) + along * sideness;
    const grow = 0.75 + 0.35 * v;
    ctx.setTransform(ex * grow, 0, 0, ey * grow, x, y);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.35, `rgba(255,255,255,${a * 0.62})`);
    g.addColorStop(0.7, `rgba(255,255,255,${a * 0.18})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
  }
};

let raf = 0;
let last = 0;
let lit = false;
const frame = (now: number) => {
  raf = 0;
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
  last = now;
  const track = currentId() ?? "";
  const playing = isPlaying();
  const t = position(now, playing, track);
  const d = entries.get(track)?.result;
  // (looked up a little ahead, as far as the glow takes to come up)
  const has = playing && d && sample(d, t + (settings.offset + 25) / 1000);
  if (has) pickGlows(1.6 * 2 ** ((settings.sensitivity - 50) / 18), Math.max(1, Math.round(settings.maxGlows)));
  else target.fill(0);
  const up = 1 - Math.exp(-dt / 0.025);
  const down = Math.exp(-dt / Math.max(0.03, settings.fade / 1000));
  let any = false;
  for (let k = 0; k < NB; k++) {
    shown[k] = target[k] > shown[k] ? shown[k] + (target[k] - shown[k]) * up : Math.max(target[k], shown[k] * down);
    if (shown[k] < 0.002) shown[k] = 0;
    else any = true;
  }
  if (any || lit) draw();
  lit = any;
  // (nothing to show and nothing coming: the loop rests until the music plays again)
  if (any || has) raf = requestAnimationFrame(frame);
  else last = 0;
};
const wake = () => {
  if (!raf && isPlaying()) raf = requestAnimationFrame(frame);
};
const wakeTimer = setInterval(wake, 250);
unloads.add(() => {
  clearInterval(wakeTimer);
  cancelAnimationFrame(raf);
  raf = 0;
});
void pump();
wake();

/** Draws a still pattern once: { degrees clockwise from in front: level } (for looking at how glows look) */
export const preview = (glows: Record<number, number>) => {
  level.fill(0);
  for (const [deg, v] of Object.entries(glows)) {
    const k = ((Math.round((Number(deg) / 360) * NB) % NB) + NB) % NB;
    level[k] = Math.max(level[k], v);
  }
  pickGlows(1, 8);
  shown.set(target);
  draw();
};

/** Listens to any track (without playing it) and returns where its strongest sound is, every `step` seconds */
export const inspect = async (id: string, step = 0.5) => {
  const stream = await trackStream(id);
  const jid = ++jobSeq;
  const d = await new Promise<Directions>((resolve, reject) => {
    jobs.set(jid, { resolve, reject });
    getWorker().postMessage({ type: "analyse", id: jid, urls: stream.urls, opts: { seconds: stream.seconds, height: settings.height / 100 } });
  });
  const out: string[] = [];
  for (let t = 0; t < d.frames / d.fps; t += step) {
    let best = 0;
    let at = 0;
    for (let f = Math.round(t * d.fps); f < Math.round((t + step) * d.fps) && f < d.frames; f++)
      for (let k = 0; k < d.bins; k++) if (DEC[d.data[f * d.bins + k]] > best) [best, at] = [DEC[d.data[f * d.bins + k]], k];
    out.push(`${t.toFixed(1)}:${best.toFixed(2)}@${Math.round((at / d.bins) * 360)}`);
  }
  return { seconds: d.seconds, spatialShare: d.spatialShare, levels: d.levels, ms: d.ms, timeline: out.join(" ") };
};

/** What the plugin knows right now (for looking into it from the console: luna.core.LunaPlugin.plugins[…].exports.debug()) */
export const debug = () => {
  const track = currentId() ?? "";
  const d = entries.get(track)?.result;
  const t = position(performance.now(), isPlaying(), track);
  const at = d ? Math.floor(t * d.fps) : -1;
  return {
    track,
    playing: isPlaying(),
    position: t,
    tracks: [...entries.values()].map((e) => ({ id: e.id, status: e.status, frames: e.result?.frames })),
    raw: d && at >= 0 && at < d.frames ? Array.from(d.data.subarray(at * d.bins, (at + 1) * d.bins)) : null,
    shown: Array.from(shown, (v) => Math.round(v * 100) / 100),
    looping: !!raf,
    // (the strongest direction, second by second: its level and where, in degrees clockwise from in front)
    timeline: d
      ? Array.from({ length: Math.floor(d.frames / d.fps) }, (_, s) => {
          let best = 0;
          let at = 0;
          for (let f = Math.round(s * d.fps); f < Math.round((s + 1) * d.fps) && f < d.frames; f++)
            for (let k = 0; k < d.bins; k++) if (DEC[d.data[f * d.bins + k]] > best) [best, at] = [DEC[d.data[f * d.bins + k]], k];
          return `${s}:${best.toFixed(2)}@${Math.round((at / d.bins) * 360)}`;
        }).join(" ")
      : null,
  };
};
