import { LunaUnload, Tracer } from "@luna/core";
import type { MediaItem } from "@luna/lib";
import { type DepthMap, closeDepthCache, disposeDepthWorker, getCachedDepth, getDepth, isAbort, loadCoverBitmap, setInferenceLogger, setInfoLogger } from "./depth";
import { backgroundFor, clearBackgrounds, reachFor } from "./background";
import { clearSurfaces, surfaceFor } from "./lighting";
import { pictureBox } from "./box";
import { CoverLoader, LOADER_CSS } from "./loader";
import { ParallaxRenderer, overflowFor } from "./renderer";
import { settings } from "./Settings";

export { Settings } from "./Settings";

export const { trace } = Tracer("[3DCover]");

export const unloads = new Set<LunaUnload>();

const STYLE_ID = "luna-3d-cover-styles";
const CANVAS_CLASS = "luna-3d-cover-canvas";
// Only the big cover in the now playing view
const PLAYER_COVER = 'img[data-test="now-playing-artwork"]';
// ...and the one on the DJ plugin's full screen, which lies over the whole window while it is open (TIDAL's own
// cover is under it then, and out of reach). The DJ marks the cover that is on its own and at rest: not the
// two decks of a mix, nor a cover a transition is being drawn on. What that cover is, its own picture says:
// the DJ's song changes at the moment its mix does, which is not always when TIDAL's does.
const STAGE = ".visiuun-dj-stage";
const STAGE_COVER = `${STAGE}.open .cv[data-3d] img`;
const stageOpen = () => !!document.querySelector(`${STAGE}.open`);
const onStage = (img: Element) => !!img.closest(STAGE);
/** Whether this is still the cover to draw on: on the DJ's full screen, the one it marks; else TIDAL's, while nothing lies over it */
const inPlace = (img: Element) => (onStage(img) ? img.matches(STAGE_COVER) : !stageOpen());
const COVER_RE = /resources\.tidal\.com\/images\/([0-9a-f/-]+?)\/(\d+)x(\d+)\.(jpg|png|webp)/i;
const TILT_CONTAINER = '[class*="_tilt_"]';
// TIDAL's light over the tilted cover: a radial gradient whose centre follows the tilt
const GLARE = '[class*="_glare_"]';
const GLARE_AT = /circle at\s+(-?[\d.]+)%\s+(-?[\d.]+)%/;
// A cover that takes longer than this to be ready gets the loading line round it
const LOADER_DELAY_MS = 350;
const LEAVE_TIMEOUT_MS = 1500;
// Smallest tilt treated as "full" deflection until TIDAL's real maximum has been seen
const TILT_MIN_REF = Math.sin((4 * Math.PI) / 180);
// Auto tilt: a slow sway while the mouse isn't on the cover, drawn at no more than this many frames a second
const AUTO_FPS = 30;
const AUTO_FADE_MS = 700; // how long the sway takes to give way to the mouse, and to come back
const AUTO_CHECK_MS = 500; // how often to look for a cover to sway when none is

// ------------------ STYLES ------------------
const style = document.createElement("style");
style.id = STYLE_ID;
style.textContent = `
  .${CANVAS_CLASS} {
    position: absolute !important;
    pointer-events: none !important;
    opacity: 0;
    transition: opacity 0.12s ease;
    display: block;
  }
  .${CANVAS_CLASS}.visible { opacity: 1; }
  ${LOADER_CSS}
`;
document.getElementById(STYLE_ID)?.remove();
document.head.appendChild(style);
unloads.add(() => style.remove());

// ------------------ STATE ------------------
const renderer = new ParallaxRenderer();
renderer.canvas.className = CANVAS_CLASS;
unloads.add(() => renderer.dispose());

const loader = new CoverLoader();
unloads.add(() => loader.remove());

type Active = {
  img: HTMLImageElement;
  tiltEl: HTMLElement | null;
  glareEl: HTMLElement | null;
  coverId: string;
  ready: boolean;
  leaving: boolean;
  leaveStart: number;
  loaderTimer?: number;
};

let active: Active | null = null;
const mouse = { x: 0, y: 0 }; // pointer position over the cover [-1, 1]
const eased = { x: 0, y: 0 }; // fallback when there's no tilt container
const drawn = { x: 0, y: 0, w: 0, h: 0, dirty: true };
let rafId = 0;
let lastFrame = 0;
let lastDraw = 0;
// How much of the auto tilt's sway is in the picture: 1 with the mouse away, 0 with it on the cover
let autoWeight = 0;
const autoOn = () => settings.autoTilt && settings.autoTiltAmount > 0;
// Two slow waves that never quite repeat, so it doesn't look like a loop
const sway = (now: number) => {
  const t = now / 1000;
  const a = settings.autoTiltAmount / 100;
  return { x: a * Math.sin((t * 2 * Math.PI) / 7), y: a * 0.85 * Math.sin((t * 2 * Math.PI) / 10.5 + 1.3) };
};

// ------------------ COVER SOURCES ------------------
type Cover = { id: string; urls: string[] };

// Full-res texture (TIDAL draws the 1280px cover), 640 as fallback
const coverFromUrl = (src: string): Cover | null => {
  const m = COVER_RE.exec(src);
  if (!m) return null;
  const [full, id, w, h] = m;
  if (w !== h) return { id, urls: [src] };
  const at = (res: number) => src.replace(full, `resources.tidal.com/images/${id}/${res}x${res}.jpg`);
  return { id, urls: [at(1280), at(640)] };
};

// What's actually playing. During a track change the DOM can briefly hold the previous track's <img>,
// so the cover to render comes from playback state rather than from whichever <img> is around.
let playingCover: Cover | null = null;

// Remember the last couple of decoded covers so prefetch + hover share one download
const bitmaps = new Map<string, Promise<ImageBitmap>>();
const getBitmap = (cover: Cover) => {
  let p = bitmaps.get(cover.id);
  if (!p) {
    p = loadCoverBitmap(cover.urls);
    p.catch(() => bitmaps.delete(cover.id));
    bitmaps.set(cover.id, p);
    if (bitmaps.size > 3) bitmaps.delete(bitmaps.keys().next().value!);
  }
  return p;
};

// The model works at ~518px, so hand it a 640px copy instead of the full 1280 texture
const buildDepth = (cover: Cover, signal?: AbortSignal) =>
  getDepth(cover.id, settings.model, async () => createImageBitmap(await getBitmap(cover), { resizeWidth: 640, resizeHeight: 640, resizeQuality: "high" }), signal);

const coverOf = async (item?: MediaItem) => {
  const url = await item?.coverUrl({ res: "1280" });
  return url ? coverFromUrl(url) : null;
};

// Generation starts as soon as a track does. Skipping drops whatever the previous track still had
// queued, unless the new track needs the same cover; a run already in progress finishes first (see
// runOn in depth.ts). Hovering a cover is never cancelled.
let trackAbort = new AbortController();
let trackSeq = 0;

// Nothing is generated for a cover nobody can hover: not while TIDAL's window can't be seen (the page
// says so when it is minimised; with the Optimizer plugin, also when it is behind a game or another
// window), and not while the now playing view, the only place the big cover is, isn't open. Making one
// starts the depth engine, a process of its own with the AI model in it: seconds of processor and some
// 250 MB each time, which used to be spent on every song whether or not the cover was on the screen.
// The playing cover's is made when the window is back or the view is opened (see checkPointer).
const coverOnPage = () => {
  for (const img of document.querySelectorAll<HTMLImageElement>(`${PLAYER_COVER}, ${STAGE_COVER}`)) if (img.isConnected && img.offsetWidth > 0) return true;
  return false;
};
/** The playing cover whose depth map has been asked for (so that it is asked for once) */
let generatedFor = "";
const generate = (cover: Cover, signal: AbortSignal, context: string) => {
  if (document.hidden || !coverOnPage()) return Promise.resolve();
  if (cover.id === playingCover?.id) generatedFor = cover.id;
  return buildDepth(cover, signal)
    .then((depth) => prebuildBackground(cover, depth, signal))
    .catch((err) => isAbort(err) || trace.err.withContext(context)(err));
};
const onSeenAgain = () => {
  if (!document.hidden && playingCover && generatedFor !== playingCover.id) generate(playingCover, trackAbort.signal, "back on screen");
};
document.addEventListener("visibilitychange", onSeenAgain);
unloads.add(() => document.removeEventListener("visibilitychange", onSeenAgain));

// The background layer takes a few ms of main-thread work: do it while idle so hovering only uploads it
const prebuildBackground = (cover: Cover, depth: DepthMap, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) =>
    requestIdleCallback(async () => {
      try {
        if (signal.aborted) return resolve();
        const image = await getBitmap(cover);
        backgroundFor(image, depth, reachFor(settings.intensity, depth.size));
        if (settings.lighting) surfaceFor(image, depth);
        resolve();
      } catch (err) {
        reject(err);
      }
    }, { timeout: 2000 }),
  );

const onTrack = async (item?: MediaItem) => {
  const seq = ++trackSeq;
  currentItem = item;
  trackStart = performance.now();
  const cover = await coverOf(item).catch(() => null);
  // A newer track arrived while this one's cover URL was resolving
  if (seq !== trackSeq) return;

  const previous = trackAbort;
  trackAbort = new AbortController();
  if (cover) {
    playingCover = cover;
    cachedImg = null;
    // Joined before the previous track's work is cancelled: if that was already this cover (the
    // preloaded next track), it carries on instead of starting over
    generate(cover, trackAbort.signal, "prefetch");
  }
  previous.abort();
};

// TIDAL preloads the next track near the end of the current one: build its depth map early too.
// Tied to the current track's signal, so skipping cancels it.
const onPreload = async (item?: MediaItem) => {
  if (!settings.preloadNext) return;
  const { signal } = trackAbort;
  const cover = await coverOf(item);
  if (cover && !signal.aborted) generate(cover, signal, "preload");
};

// @luna/lib is read from window.luna instead of imported: Luna's import wrapper for plugin modules
// registers a dependency and throws "Cannot add dependancy to non plugin!" if Luna's registry doesn't
// hold this plugin at that instant (happens during DEV live reloads / reinstalls).
const lib = window.luna.lib;
lib?.MediaItem.onMediaTransition(unloads, onTrack);
lib?.MediaItem.onPreload(unloads, onPreload);
setInferenceLogger((backend, ms) => {
  lastGenerateMs = ms;
  trace.log(`Depth map generated in ${ms}ms (${backend})`);
});

// ------------------ NEXT COVER PRELOADING ------------------
// The next song's cover is generated before it plays: once the current song is nearly over (early
// enough that it's ready on time, at least PRELOAD_LEAD_MS), or as soon as the next button is hovered.
// It's tied to the current track, so if a different song plays instead it's cancelled like a skip;
// if the next song does play, its work carries on.
const PRELOAD_LEAD_MS = 5000;
let currentItem: MediaItem | undefined;
let lastGenerateMs = 0;
let trackStart = 0;
let preloadedSeq = -1;

const preloadNext = async () => {
  if (!settings.preloadNext || preloadedSeq === trackSeq || !lib) return;
  preloadedSeq = trackSeq;
  const { signal } = trackAbort;
  const cover = await lib.PlayState.nextMediaItem().then(coverOf).catch(() => null);
  if (cover && !signal.aborted) generate(cover, signal, "preload next");
};

// Where the song is, from the player that is active now: Luna's PlayState.currentTime keeps hold of the
// first player it found, and stands still once TIDAL has changed to its other one (it has two)
let playerModule: { activePlayer?: { currentTime?: number } } | undefined;
const livePosition = (): number => {
  try {
    playerModule ??= (window as any).luna?.core?.findModuleByProperty?.((key: unknown, value: unknown) => key === "activePlayer" && typeof value === "object" && value !== null && "currentTime" in (value as object)) ?? undefined;
    const t = Number(playerModule?.activePlayer?.currentTime);
    if (Number.isFinite(t)) return t;
  } catch {}
  return lib?.PlayState.currentTime ?? 0;
};

const preloadTimer = setInterval(() => {
  const duration = currentItem?.duration;
  // Right after a song changes, the player can still report the previous song's position
  if (!settings.preloadNext || !duration || !lib?.PlayState.playing || performance.now() - trackStart < 3000) return;
  const position = livePosition();
  const remaining = (duration - position) * 1000;
  if (position <= duration && remaining <= Math.max(PRELOAD_LEAD_MS, lastGenerateMs + 1000)) preloadNext();
}, 1000);
unloads.add(() => clearInterval(preloadTimer));

const NEXT_BUTTON = '[data-test="next"]';
const onPointerOver = (e: PointerEvent) => {
  if ((e.target as Element | null)?.closest?.(NEXT_BUTTON)) preloadNext();
};
document.addEventListener("pointerover", onPointerOver, { passive: true });
unloads.add(() => document.removeEventListener("pointerover", onPointerOver));
setInfoLogger((msg) => trace.log(msg));
lib?.MediaItem.fromPlaybackContext().then(onTrack).catch(() => {});
unloads.add(() => trackAbort.abort());

// ------------------ COVER DETECTION ------------------
const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

// Hit-test against the untransformed box around the tilt layer: the tilted <img>'s own rect shrinks
// as it rotates, which would make the edges count as "outside".
const hoverRect = (img: HTMLImageElement) => (img.closest(TILT_CONTAINER)?.parentElement ?? img).getBoundingClientRect();

// Cached lookup of the player cover <img>; re-queried when it's replaced, hidden or the track changes
let cachedImg: HTMLImageElement | null = null;
const isShown = (img: HTMLImageElement) => img.isConnected && img.offsetWidth > 0 && img.complete && img.naturalWidth > 0;
let lastMiss = 0;
const getPlayerCover = () => {
  if (cachedImg && isShown(cachedImg) && inPlace(cachedImg)) return cachedImg;
  cachedImg = null;
  // Not on the now playing view: don't re-scan the DOM on every mouse move
  const now = performance.now();
  if (now - lastMiss < 250) return null;
  const imgs = document.querySelectorAll<HTMLImageElement>(stageOpen() ? STAGE_COVER : PLAYER_COVER);
  // Newest is last in the DOM
  for (let i = imgs.length - 1; i >= 0; i--) {
    if (isShown(imgs[i])) return (cachedImg = imgs[i]);
  }
  lastMiss = now;
  return null;
};

// ------------------ TILT FOLLOWING ------------------
// TIDAL tilts the cover container towards the mouse with its own easing. The parallax reads that
// tilt back from the computed transform, so both move together and ease out together.
const tiltSign = { x: 0, y: 0 }; // learned mouse→tilt direction (votes)
// Largest tilt TIDAL has produced: full tilt = full shift, like the mouse at the cover edge in the Python app
const tiltMax = { x: TILT_MIN_REF, y: TILT_MIN_REF };

// ------------------ AUTO TILT OF THE WHOLE COVER ------------------
// TIDAL's tilt (framer-motion: up to 12°, rotateX/rotateY after perspective(1000px), written to the tilt box's
// inline transform only while its spring moves) is what the cover does under the mouse. The sway does the
// same: its own rotation goes after TIDAL's in that transform, as if the mouse were where the sway is. What
// TIDAL last wrote is kept apart (anything there that isn't ours is TIDAL's), so the parallax still reads
// TIDAL's tilt alone, and TIDAL's own value goes back when the sway is gone.
const TIDAL_MAX_TILT = 12; // deg, TIDAL's maxTilt
const TIDAL_PERSPECTIVE = "perspective(1000px)";
let tiltOwn: { el: HTMLElement | null; tidal: string; written: string } = { el: null, tidal: "", written: "" };
const tidalTransform = (el: HTMLElement) => {
  if (tiltOwn.el !== el) {
    restoreTilt();
    tiltOwn = { el, tidal: el.style.transform, written: "" };
  } else if (el.style.transform !== tiltOwn.written) tiltOwn.tidal = el.style.transform;
  return tiltOwn.tidal;
};
/** Tilt the cover as the mouse would at `m` ([-1, 1] from the centre), on top of TIDAL's tilt; null for TIDAL's alone */
const writeSwayTilt = (el: HTMLElement, m: { x: number; y: number } | null) => {
  const tidal = tidalTransform(el);
  const base = !tidal || tidal === "none" ? TIDAL_PERSPECTIVE : tidal.includes("perspective(") ? tidal : `${TIDAL_PERSPECTIVE} ${tidal}`;
  const next = m ? `${base} rotateX(${(-m.y * TIDAL_MAX_TILT).toFixed(3)}deg) rotateY(${(m.x * TIDAL_MAX_TILT).toFixed(3)}deg)` : tidal;
  if (el.style.transform !== next) el.style.transform = next;
  tiltOwn.written = el.style.transform;
};
const restoreTilt = () => {
  const { el, tidal, written } = tiltOwn;
  if (el && el.style.transform === written && written !== tidal) el.style.transform = tidal;
  tiltOwn = { el: null, tidal: "", written: "" };
};

const readTilt = (el: HTMLElement) => {
  const tf = tidalTransform(el);
  if (!tf || tf === "none") return { x: 0, y: 0 };
  let m = new DOMMatrix(tf);
  // Strip perspective() so only the rotation is left
  const persp = /perspective\(\s*([\d.]+)px\s*\)/.exec(tf);
  const d = persp ? parseFloat(persp[1]) : 0;
  if (d > 0) m = new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1 / d, 0, 0, 0, 1]).multiply(m);
  // Where the surface normal points: x ≈ sin(rotateY), y ≈ -sin(rotateX)
  const len = Math.hypot(m.m31, m.m32, m.m33) || 1;
  const x = m.m31 / len;
  const y = m.m32 / len;
  tiltMax.x = Math.max(tiltMax.x, Math.abs(x));
  tiltMax.y = Math.max(tiltMax.y, Math.abs(y));
  return { x: x / tiltMax.x, y: y / tiltMax.y };
};

const learnSign = (tilt: { x: number; y: number }) => {
  if (Math.abs(mouse.x) > 0.5 && Math.abs(tilt.x) > 0.25) tiltSign.x = Math.max(-20, Math.min(20, tiltSign.x + Math.sign(mouse.x * tilt.x)));
  if (Math.abs(mouse.y) > 0.5 && Math.abs(tilt.y) > 0.25) tiltSign.y = Math.max(-20, Math.min(20, tiltSign.y + Math.sign(mouse.y * tilt.y)));
};

// ------------------ OVERLAY PLACEMENT ------------------
const syncPlacement = (img: HTMLImageElement) => {
  const c = renderer.canvas;
  if (c.previousElementSibling !== img) img.insertAdjacentElement("afterend", c);
  const cs = getComputedStyle(img);
  // On the picture, which can be smaller than the <img> (see box.ts)
  const b = pictureBox(img);
  // The canvas is larger than the cover so foreground can cross its border; the shader draws the
  // cover's rounded frame, since CSS rounding would apply to the larger canvas
  const overflow = settings.breakout ? overflowFor(settings.intensity, settings.focal / 100) : 0;
  const pad = renderer.resize(b.w, b.h, overflow, b.radius);
  c.style.left = `${img.offsetLeft + b.x - pad.x}px`;
  c.style.top = `${img.offsetTop + b.y - pad.y}px`;
  c.style.width = `${b.w + 2 * pad.x}px`;
  c.style.height = `${b.h + 2 * pad.y}px`;
  c.style.transform = cs.transform === "none" ? "" : cs.transform;
  const [originX, originY] = cs.transformOrigin.split(" ").map(parseFloat);
  c.style.transformOrigin = `${originX - b.x + pad.x}px ${originY - b.y + pad.y}px`;
  c.style.zIndex = cs.zIndex === "auto" ? "" : cs.zIndex;
};

// ------------------ RENDER LOOP ------------------
const scheduleFrame = () => {
  if (!rafId) rafId = requestAnimationFrame(frame);
};

const frame = (now: number) => {
  rafId = 0;
  if (!active?.ready) return;
  if (!active.img.isConnected || !inPlace(active.img) || (!onStage(active.img) && playingCover && active.coverId !== playingCover.id)) {
    cachedImg = null;
    teardown();
    return checkPointer();
  }

  // With the mouse away the sway needs few frames: it moves slowly
  const swaying = active.leaving && autoOn() && autoWeight > 0.999;
  if (swaying && now - lastDraw < 1000 / AUTO_FPS - 2) return scheduleFrame();

  let n: { x: number; y: number };
  if (active.tiltEl?.isConnected) {
    const tilt = readTilt(active.tiltEl);
    if (!active.leaving) learnSign(tilt);
    n = { x: tilt.x * (tiltSign.x < 0 ? -1 : 1), y: tilt.y * (tiltSign.y < 0 ? -1 : 1) };
  } else {
    const dt = lastFrame ? Math.min(100, now - lastFrame) : 16.67;
    const s = Math.min(0.95, Math.max(0, settings.mouseSmoothing / 100));
    const k = s === 0 ? 1 : 1 - Math.pow(s, dt / 16.67);
    const goal = active.leaving ? { x: 0, y: 0 } : mouse;
    eased.x += (goal.x - eased.x) * k;
    eased.y += (goal.y - eased.y) * k;
    n = eased;
  }
  const dtAuto = lastFrame ? Math.min(100, now - lastFrame) : 16.67;
  lastFrame = now;

  // The sway comes in as the mouse leaves (while TIDAL's tilt eases out) and gives way as it comes back
  const autoGoal = active.leaving && autoOn() ? 1 : 0;
  autoWeight += Math.sign(autoGoal - autoWeight) * Math.min(Math.abs(autoGoal - autoWeight), dtAuto / AUTO_FADE_MS);
  const aw = autoWeight * autoWeight * (3 - 2 * autoWeight); // smoothstep
  const s = aw > 0 ? sway(now) : null;
  if (s) n = { x: n.x + s.x * aw, y: n.y + s.y * aw };
  // The whole cover tilts with it (the sway is where the mouse would be)
  if (active.tiltEl?.isConnected) writeSwayTilt(active.tiltEl, s && { x: s.x * aw, y: s.y * aw });

  const neutral = Math.abs(n.x) < 0.003 && Math.abs(n.y) < 0.003;
  if (active.leaving && autoGoal === 0 && autoWeight === 0 && (neutral || now - active.leaveStart > LEAVE_TIMEOUT_MS)) return teardown();

  syncPlacement(active.img);
  const flip = settings.invert ? -1 : 1;
  const { width: w, height: h } = renderer.canvas;
  // Skip redundant draws while the cover is resting
  if (drawn.dirty || Math.abs(n.x - drawn.x) > 1e-4 || Math.abs(n.y - drawn.y) > 1e-4 || w !== drawn.w || h !== drawn.h) {
    try {
      const light = lightPosition(active, { x: n.x * flip, y: n.y * flip }, aw);
      renderer.draw({
        nx: n.x * flip,
        ny: n.y * flip,
        intensity: settings.intensity,
        focal: settings.focal / 100,
        suppress: settings.antiSmear / 100,
        lighting: settings.lighting ? settings.lightStrength / 100 : 0,
        lightX: light.x,
        lightY: light.y,
        glare: light.glare,
      });
      Object.assign(drawn, { x: n.x, y: n.y, w, h, dirty: false });
      lastDraw = now;
    } catch (err) {
      trace.err.withContext("draw")(err);
      return teardown();
    }
  }
  scheduleFrame();
};

// The lighting uses TIDAL's own light (its glare's centre), so both move together. Without one, a
// light on the side opposite the tilt that swings in from outside the cover as the tilt grows.
// While the cover sways on its own (weight `auto`) TIDAL's light is out, so the light is our own.
const lightPosition = (state: Active, n: { x: number; y: number }, auto = 0) => {
  const len = Math.hypot(n.x, n.y) || 1;
  const reach = 1.1 - 0.8 * Math.min(1, len);
  const own = { x: 0.5 - (n.x / len) * reach, y: 0.5 - (n.y / len) * reach, glare: 0 };
  const at = state.glareEl?.isConnected ? GLARE_AT.exec(state.glareEl.style.background) : null;
  if (!at || auto >= 1) return own;
  const opacity = parseFloat(state.glareEl!.style.opacity);
  const tidal = { x: parseFloat(at[1]) / 100, y: parseFloat(at[2]) / 100, glare: Number.isNaN(opacity) ? 1 : opacity };
  const mix = (a: number, b: number) => a + (b - a) * auto;
  return { x: mix(tidal.x, own.x), y: mix(tidal.y, own.y), glare: mix(tidal.glare, own.glare) };
};

// ------------------ LIFECYCLE ------------------
const RETRY_AFTER_MS = 10_000;
let failed = { id: "", at: 0 };

const teardown = () => {
  restoreTilt();
  if (!active) return;
  clearTimeout(active.loaderTimer);
  active = null;
  cancelAnimationFrame(rafId);
  rafId = 0;
  lastFrame = 0;
  lastDraw = 0;
  autoWeight = 0;
  eased.x = eased.y = mouse.x = mouse.y = 0;
  drawn.dirty = true;
  renderer.canvas.classList.remove("visible");
  renderer.canvas.remove();
  loader.remove();
};

// Keep rendering while the cover eases back to neutral, then hand back to the real <img>
// (with auto tilt on it stays, and sways)
const leave = () => {
  if (!active || active.leaving) return;
  if (!active.ready && !autoOn()) return teardown();
  active.leaving = true;
  active.leaveStart = performance.now();
  scheduleFrame();
};

const prepare = async (state: Active) => {
  const shown = coverFromUrl(state.img.currentSrc || state.img.src);
  const cover = onStage(state.img) ? shown : (playingCover ?? shown);
  if (!cover) return teardown();
  state.coverId = cover.id;

  if (!getCachedDepth(cover.id, settings.model)) {
    state.loaderTimer = window.setTimeout(() => active === state && loader.show(state.img), LOADER_DELAY_MS);
  }

  try {
    const [image, depth] = await Promise.all([getBitmap(cover), buildDepth(cover)]);
    if (active !== state) return;

    clearTimeout(state.loaderTimer);
    loader.hide();
    renderer.setSource(image, depth);
    drawn.dirty = true;

    state.ready = true;
    syncPlacement(state.img);
    scheduleFrame();
    requestAnimationFrame(() => active === state && renderer.canvas.classList.add("visible"));
  } catch (err) {
    trace.err.withContext("Failed to build parallax cover")(err);
    failed = { id: cover.id, at: performance.now() };
    if (active === state) teardown();
  }
};

const activate = (img: HTMLImageElement, hovered = true) => {
  teardown();
  const cover = onStage(img) ? coverFromUrl(img.currentSrc || img.src)?.id : playingCover?.id;
  if (cover && failed.id === cover && performance.now() - failed.at < RETRY_AFTER_MS) return;
  const tiltEl = img.closest<HTMLElement>(TILT_CONTAINER);
  const glareEl = tiltEl?.querySelector<HTMLElement>(GLARE) ?? null;
  const state: Active = { img, tiltEl, glareEl, coverId: "", ready: false, leaving: !hovered, leaveStart: performance.now() };
  // A cover that starts out swaying fades the sway in from still
  autoWeight = 0;
  active = state;
  prepare(state);
};

// ------------------ INPUT ------------------
const pointer = { x: 0, y: 0, seen: false };

// One passive listener does it all: hit-test the player cover, then start / resume / leave.
// Unlike pointerover, this still works when React swaps the <img> under a resting cursor.
const checkPointer = () => {
  if (!pointer.seen) return;
  const img = getPlayerCover();
  if (active && active.img !== img) teardown();
  if (!img) return;
  // (the now playing view is open, and the playing cover's depth map was left unmade while it wasn't)
  if (playingCover && generatedFor !== playingCover.id) generate(playingCover, trackAbort.signal, "cover on screen");

  const r = hoverRect(img);
  if (!inside(r, pointer.x, pointer.y)) return leave();

  if (!active) activate(img);
  else if (active.leaving) active.leaving = false;
  if (!active) return;

  // Normalized pointer position [-1, 1] relative to the cover centre (same as the Python app)
  mouse.x = Math.max(-1, Math.min(1, (pointer.x - (r.left + r.width / 2)) / (r.width / 2)));
  mouse.y = Math.max(-1, Math.min(1, (pointer.y - (r.top + r.height / 2)) / (r.height / 2)));
};

const onPointerMove = (e: PointerEvent) => {
  if (e.pointerType === "touch") return;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.seen = true;
  checkPointer();
};

const onSettingsUpdated = () => {
  drawn.dirty = true;
  // Auto tilt turned off with the mouse away: ease back to still from now, then hand back to the <img>
  if (active?.leaving && !autoOn()) active.leaveStart = performance.now();
  if (active?.ready) scheduleFrame();
  else checkAutoTilt();
};

// With auto tilt on, the cover sways as soon as it's on the screen, not only once it's hovered. Nothing is
// looked for while the window can't be seen: rAF stands still then anyway, and so the sway with it.
const checkAutoTilt = () => {
  if (!autoOn() || active || document.hidden) return;
  const img = getPlayerCover();
  if (!img) return;
  if (playingCover && generatedFor !== playingCover.id) generate(playingCover, trackAbort.signal, "auto tilt");
  activate(img, false);
};
const autoTimer = setInterval(checkAutoTilt, AUTO_CHECK_MS);
unloads.add(() => clearInterval(autoTimer));

window.addEventListener("pointermove", onPointerMove, { passive: true });
window.addEventListener("luna:3dcover:updated", onSettingsUpdated);
window.addEventListener("blur", leave);

unloads.add(() => {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("luna:3dcover:updated", onSettingsUpdated);
  window.removeEventListener("blur", leave);
  teardown();
  bitmaps.clear();
  clearBackgrounds();
  clearSurfaces();
  disposeDepthWorker();
  closeDepthCache();
});
