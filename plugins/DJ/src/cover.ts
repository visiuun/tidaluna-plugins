// The cover art mixes too. While the DJ takes one track into the next, the cover in the now playing view
// (and the small one in the player bar) turns from the old cover into the new one along with the sound:
// it starts when the incoming track does, sends a wave across the cover where the song changes (the bass
// handover), and has arrived when the old track has gone. Nothing pulses or flashes on the beat. Each kind of transition has its own look.
//
// It's a small WebGL canvas, drawn by a worker and only while a transition lasts, laid over TIDAL's own
// cover (which changes underneath it, unseen, when TIDAL moves to the next track).
import type { LunaUnload } from "@luna/core";

import { settings } from "./config";
import { warn } from "./log";
import { mixerClock, onStatus, type CoverTransition } from "./session";

const BIG_COVER = 'img[data-test="now-playing-artwork"]';
const MINI_COVER = 'figure[data-test="current-media-imagery"] img';
const TILT = '[class*="_tilt_"]';
const COVER_ID = /resources\.tidal\.com\/images\/([0-9a-f/-]+?)\/\d+x\d+\./i;
/** Room around the cover (a share of its size) for light and echoes that go past its edge */
const PAD = 0.2;

const STYLES = ["liquid", "slices", "swirl", "mosaic", "wave", "echo", "duo"] as const;

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;      // 0: the old cover, 1: the new one
uniform float u_time;   // seconds into the transition
uniform float u_drop;   // 1 at the big moment (the bass changes hands / the new track lands), falling away
uniform float u_dropT;  // seconds since that moment (negative before it)
uniform float u_style;
uniform float u_seed;
uniform float u_alpha;
uniform float u_pad;
uniform float u_px;     // cover size, px
uniform float u_radius; // corner radius, px
uniform vec3 u_cb;     // the new cover's own colour

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}
// Distance to the cover's rounded edge in px (negative inside)
float box(vec2 uv) {
  vec2 q = abs(uv - 0.5) * u_px - (u_px * 0.5 - u_radius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
}
vec2 rot(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}
// A picture pushed past its own edge carries on mirrored, rather than smearing its last row of pixels
vec2 wrap(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
vec3 texA(vec2 uv) { return texture2D(u_a, wrap(uv)).rgb; }
vec3 texB(vec2 uv) { return texture2D(u_b, wrap(uv)).rgb; }
// Colours pulled slightly apart, the way a lens does at its edge
vec3 splitA(vec2 uv, vec2 o) { return vec3(texA(uv + o).r, texA(uv).g, texA(uv - o).b); }
vec3 splitB(vec2 uv, vec2 o) { return vec3(texB(uv + o).r, texB(uv).g, texB(uv - o).b); }

void main() {
  vec2 uv = (v_uv - u_pad) / (1.0 - 2.0 * u_pad);
  vec2 c = uv - 0.5;
  float r = length(c);
  float d = box(uv);
  float inside = smoothstep(0.75, -0.75, d);
  float drop = u_drop;

  // Nothing here moves on the beat (it used to pulse and flash with every kick, which looked cheap): the
  // picture only changes with the transition itself. The one event is the song change, where a wave
  // runs out from the middle of the cover.
  float ring = u_dropT > 0.0 ? exp(-abs(r - u_dropT * 0.85) * 13.0) * drop : 0.0;
  vec2 uz = 0.5 + c;
  uz += normalize(c + 1e-5) * ring * 0.04;
  vec2 ca = c * (0.05 * ring);

  vec3 col = vec3(0.0);
  vec4 behind = vec4(0.0); // drawn around the cover (premultiplied)
  float glow = 0.0;
  float live = step(0.002, u_p) * step(u_p, 0.998);

  if (u_style < 0.5) {
    // Liquid: the new cover seeps through the old one like ink, both pulled along a slow current
    vec2 flow = vec2(fbm(uv * 2.3 + u_seed + vec2(u_time * 0.06, 0.0)), fbm(uv * 2.3 + u_seed * 1.7 + vec2(0.0, u_time * 0.05))) - 0.47;
    float n = fbm(uv * 2.6 + u_seed * 3.1 + flow * 0.6 + vec2(0.0, u_time * 0.03));
    // (The noise sits between about 0.15 and 0.8: the line starts just under that, so the new cover
    // shows from the first bar, and ends just over it)
    float edge = mix(0.1, 0.88, u_p);
    float m = smoothstep(edge - 0.06, edge + 0.06, n);
    m = mix(1.0, m, smoothstep(0.0, 0.04, u_p)) * (1.0 - smoothstep(0.96, 1.0, u_p));
    vec2 ua = uz + flow * 0.24 * u_p;
    vec2 ub = uz - flow * 0.24 * (1.0 - u_p);
    col = mix(splitB(ub, ca), splitA(ua, ca), m);
    glow = exp(-abs(n - edge) / 0.03) * live;
  } else if (u_style < 1.5) {
    // Slices: the cover is cut into strips, and one after another each strip slides over to the new cover,
    // alternately from the top and from the bottom
    float N = 11.0;
    float i = floor(uv.x * N);
    float th = hash(vec2(i, u_seed)) * 0.8 + 0.06;
    float k = smoothstep(th, th + 0.12, u_p);
    k = k * k * (3.0 - 2.0 * k);
    float down = mod(i, 2.0) < 1.0 ? 1.0 : 0.0;
    float y = mix(1.0 - uv.y, uv.y, down);
    float shown = step(y, k);
    // The new strip arrives riding the edge of the old one, like a blind being drawn
    float shift = (1.0 - k) * mix(1.0, -1.0, down);
    col = mix(splitA(uz, ca), splitB(uz + vec2(0.0, shift), ca), shown);
    glow = exp(-abs(y - k) * 90.0) * step(0.001, k) * step(k, 0.999) * 0.8 * live;
  } else if (u_style < 2.5) {
    // Swirl: the old cover winds up like a record being spun back while the new one unwinds into place
    float fall = 1.0 - smoothstep(0.0, 0.8, r);
    fall *= fall;
    vec2 ua = 0.5 + rot(uz - 0.5, 6.5 * u_p * fall);
    vec2 ub = 0.5 + rot(uz - 0.5, -6.5 * (1.0 - u_p) * fall);
    float n = fbm(uv * 3.0 + u_seed) - 0.5;
    float edge = mix(-0.2, 0.95, u_p);
    float m = smoothstep(edge - 0.1, edge + 0.1, r * 1.25 + n * 0.18);
    col = mix(splitB(ub, ca), splitA(ua, ca), m);
    glow = exp(-abs(r * 1.25 + n * 0.18 - edge) / 0.04) * live;
  } else if (u_style < 3.5) {
    // Mosaic: the picture breaks into blocks, each block turns over on its own, and it sharpens again
    float k = sin(3.14159 * u_p);
    vec2 id = floor(uv * 12.0);
    float th = hash(id + u_seed) * 0.76 + 0.12;
    float m = 1.0 - smoothstep(th - 0.015, th + 0.015, u_p);
    // Each tile goes coarse as its own turn comes and sharpens again after, so most of the picture
    // stays readable all the way through
    float near = exp(-abs(u_p - th) * 9.0);
    float cells = mix(240.0, 24.0, clamp(near * k * 1.4, 0.0, 1.0));
    vec2 uq = (floor(uz * cells) + 0.5) / cells;
    vec2 us = mix(uz, uq, smoothstep(0.0, 0.1, k));
    // A tile turns over like a card: squeezed flat at the moment it changes
    vec2 tile = fract(uv * 12.0) - 0.5;
    float turn = exp(-abs(u_p - th) * 30.0);
    us.x += tile.x * turn * 0.06;
    col = mix(texB(us), texA(us), m);
    vec2 g = abs(tile);
    glow = smoothstep(0.45, 0.5, max(g.x, g.y)) * 0.5 * near * k * live;
  } else if (u_style < 4.5) {
    // Wave: a bright line of water crosses the cover, bending what's on either side of it
    float f = uv.x * 0.74 + uv.y * 0.26 + sin(uv.y * 7.0 + u_time * 1.7) * 0.045 + (fbm(uv * 3.0 + u_seed + vec2(0.0, u_time * 0.08)) - 0.47) * 0.16;
    float edge = mix(-0.2, 1.2, u_p);
    float dist = f - edge;
    float m = smoothstep(-0.01, 0.01, dist);
    // Ripples run ahead of the line and behind it, bending both pictures
    float lens = exp(-abs(dist) * 9.0) * live;
    float ripple = sin(dist * 70.0 - u_time * 5.0) * exp(-abs(dist) * 7.0) * live;
    vec2 push = vec2(0.74, 0.26) * (lens * 0.07 + ripple * 0.018);
    col = mix(splitB(uz - push, ca + vec2(0.01 * lens, 0.0)), splitA(uz + push, ca + vec2(0.02 * lens, 0.0)), m);
    col *= 1.0 + ripple * 0.18;
    glow = (exp(-abs(dist) * 45.0) * 1.4 + exp(-abs(dist) * 8.0) * 0.25) * live;
  } else if (u_style < 5.5) {
    // Echo (for drops and cuts): the old cover repeats outwards, fainter each time; then the new one lands
    float build = clamp(u_p * 2.0, 0.0, 1.0);
    float landed = step(0.5, u_p);
    float after = max(u_dropT, 0.0);
    for (int k = 4; k >= 1; k--) {
      float fk = float(k);
      float s = 1.0 + fk * (0.035 + 0.075 * build) + after * 0.28 * fk;
      vec2 uk = 0.5 + c / s;
      float mk = smoothstep(0.75, -0.75, box(uk));
      float ak = pow(0.52, fk) * mk * build * exp(-after * 2.4);
      vec3 ck = splitA(uk, c * 0.02 * fk);
      behind = vec4(ck * ak, ak) + behind * (1.0 - ak);
    }
    vec3 a = splitA(uz, ca + c * 0.03 * build);
    col = mix(a, splitB(uz, ca), landed);
  } else {
    // Duo (for mashups): both covers at once, either side of a seam that slowly turns and ripples. Along
    // the seam the two are woven through each other, and each leans away from it a little, like two
    // sheets held together. How much of the picture each has follows the music: half and half while
    // the two songs play together.
    float ang = 0.62 + 0.34 * sin(u_time * 0.11 + u_seed);
    vec2 n = vec2(cos(ang), sin(ang));
    vec2 along = vec2(-n.y, n.x);
    float wob = (fbm(uv * 2.2 + vec2(u_time * 0.06, u_seed)) - 0.47) * 0.17 + sin(dot(c, along) * 9.0 + u_time * 0.8) * 0.016;
    float dist = dot(c, n) + wob - (u_p - 0.5) * 1.75; // above 0: the old cover's side
    float m = smoothstep(-0.01, 0.01, dist);
    float near = exp(-abs(dist) * 7.0) * live;
    vec3 a = splitA(uz + n * 0.028 * near, ca + n * 0.011 * near);
    vec3 b = splitB(uz - n * 0.028 * near, ca - n * 0.011 * near);
    col = mix(b, a, m);
    float band = exp(-abs(dist) * 24.0) * live;
    float weave = smoothstep(0.42, 0.58, abs(fract(dot(c, along) * 22.0 + u_time * 0.22) - 0.5) * 2.0);
    col = mix(col, mix(a, b, weave), band * 0.9);
    glow = (exp(-abs(dist) * 60.0) * 1.3 + exp(-abs(dist) * 9.0) * 0.22) * live;
  }

  // Light on the line where the two covers meet, in the new cover's colour
  // (less of it on a cover that's already bright, which would only wash out)
  vec3 tint = mix(u_cb, vec3(1.0), 0.55);
  float room = 1.0 - 0.65 * dot(col, vec3(0.3, 0.6, 0.1));
  col += glow * 0.3 * tint * room;
  // The crest of the wave at the song change catches a little light
  col += ring * 0.1 * room;

  vec4 outc = vec4(col, 1.0) * inside + behind * (1.0 - inside);
  gl_FragColor = outc * u_alpha;
}`;

// ------------------ THE DRAWING, IN A WORKER ------------------
// The picture is drawn by a worker, on a canvas handed over to it. When TIDAL changes track its page is
// busy for a moment several times over (its own re-render, other plugins reading the new cover): measured,
// 0.1-0.4 s at a time, right where the wave plays. Drawn from the page, the animation froze with it; a
// worker keeps its own time and didn't drop a frame through a 0.4 s stall of the page.
const WORKER_SOURCE = `
const VERT = ${JSON.stringify(VERT)};
const FRAG = ${JSON.stringify(FRAG)};
const NAMES = ["u_a", "u_b", "u_p", "u_time", "u_drop", "u_dropT", "u_style", "u_seed", "u_alpha", "u_pad", "u_px", "u_radius", "u_cb"];
const views = new Map();
let run = null;
let clock = { offset: 0, frozen: 0, at: 0, running: false };
let looping = false;
let lastDraw = 0;
// The mixer's clock, carried forward on this worker's own clock from the readings the page sends (it
// stands still while paused). Each reading is timed on arrival here: the page's clock and this one can't
// be compared (they were seen 1.9 s apart, after which the picture only moved when a reading came in,
// four times a second).
const mixerNow = () => (clock.running ? clock.offset + Math.min(performance.now(), clock.at + 1500) / 1000 : clock.frozen);
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
// Where the picture is at mixer time t: how far along, and the moment of the song change
const frameAt = (tr, t) => {
  const span = Math.max(0.05, tr.end - tr.start);
  const tau = Math.max(0, Math.min(1, (t - tr.start) / span));
  const dropT = t - tr.swap;
  const drop = dropT >= 0 ? Math.exp(-dropT * 2.2) : 0;
  let p;
  if (tr.kind === "mashup") {
    // In with the other song's voice, to half and half by the time it sings; there for as long as the
    // two play together (swaying a little); over to the new cover as the bands change over
    const mid = tr.mid > tr.swap ? tr.mid : tr.swap + (tr.end - tr.swap) * 0.7;
    if (t < tr.swap) p = 0.5 * smooth((t - tr.start) / Math.max(0.05, tr.swap - tr.start));
    else if (t < mid) p = 0.5 + 0.035 * Math.sin((t - tr.swap) * 0.45) * Math.min(1, (t - tr.swap) / 2) * Math.min(1, (mid - t) / 2);
    else p = 0.5 + 0.5 * smooth((t - mid) / Math.max(0.05, tr.end - mid));
  } else if (tr.kind === "drop" || tr.kind === "cut") {
    // Half the way is the build-up to the moment the new track lands, the other half its arrival
    const lead = Math.max(0.05, tr.swap - tr.start);
    p = t < tr.swap ? 0.5 * smooth((t - tr.start) / lead) * 0.98 : 0.5 + 0.5 * smooth((t - tr.swap) / Math.max(0.05, tr.end - tr.swap));
  } else if (tr.kind === "fade") {
    p = smooth(tau);
  } else {
    // A blend: the new cover works its way in up to the bass handover, moves ahead there, and the old
    // one has gone a little before the old track has
    let sw = (tr.swap - tr.start) / span;
    if (!(sw > 0.15 && sw < 0.9)) sw = 0.55;
    const jump = Math.min(0.06, (1 - sw) / 3);
    if (tau < sw) p = 0.44 * smooth(tau / sw);
    else if (tau < sw + jump) p = 0.44 + 0.16 * smooth((tau - sw) / jump);
    else p = 0.6 + 0.4 * smooth((tau - sw - jump) / Math.max(0.01, 0.96 - sw - jump));
  }
  return { p: Math.max(0, Math.min(1, p)), drop: drop, dropT: dropT, time: Math.max(0, t - tr.start) };
};
const setup = (v) => {
  const g = v.canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!g) return;
  const shader = (type, src) => {
    const s = g.createShader(type);
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) || "shader");
    return s;
  };
  const p = g.createProgram();
  g.attachShader(p, shader(g.VERTEX_SHADER, VERT));
  g.attachShader(p, shader(g.FRAGMENT_SHADER, FRAG));
  g.linkProgram(p);
  if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) || "link");
  g.useProgram(p);
  g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
  const loc = g.getAttribLocation(p, "a_pos");
  g.enableVertexAttribArray(loc);
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
  v.u = {};
  for (const name of NAMES) v.u[name] = g.getUniformLocation(p, name);
  const tex = (unit) => {
    const t = g.createTexture();
    g.activeTexture(unit ? g.TEXTURE1 : g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, t);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    return t;
  };
  v.texA = tex(0);
  v.texB = tex(1);
  g.uniform1i(v.u.u_a, 0);
  g.uniform1i(v.u.u_b, 1);
  g.disable(g.BLEND);
  v.gl = g;
};
const upload = (v) => {
  const g = v.gl;
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, v.texA);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, run.a);
  g.activeTexture(g.TEXTURE1);
  g.bindTexture(g.TEXTURE_2D, v.texB);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, run.b);
  v.run = run.id;
};
const clear = (v) => {
  if (!v.gl) return;
  v.gl.clearColor(0, 0, 0, 0);
  v.gl.clear(v.gl.COLOR_BUFFER_BIT);
};
const drawView = (v, f, alpha) => {
  if (!v.gl || !v.px || v.gl.isContextLost()) return;
  const g = v.gl;
  if (v.canvas.width !== v.px) v.canvas.width = v.canvas.height = v.px;
  if (v.run !== run.id) upload(v);
  g.viewport(0, 0, v.px, v.px);
  const u = v.u;
  g.uniform1f(u.u_p, f.p);
  g.uniform1f(u.u_time, f.time);
  g.uniform1f(u.u_drop, f.drop);
  g.uniform1f(u.u_dropT, f.dropT);
  g.uniform1f(u.u_style, run.style);
  g.uniform1f(u.u_seed, run.seed);
  g.uniform1f(u.u_alpha, alpha);
  g.uniform1f(u.u_pad, v.pad);
  g.uniform1f(u.u_px, v.coverPx);
  g.uniform1f(u.u_radius, v.radius);
  g.uniform3fv(u.u_cb, run.cb);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
};
const end = (silent) => {
  const r = run;
  run = null;
  if (!r) return;
  for (const v of views.values()) clear(v);
  try { r.a.close(); r.b.close(); } catch (e) {}
  if (!silent) postMessage({ type: "done", id: r.id });
};
const frame = (now) => {
  if (!run) { looping = false; return; }
  requestAnimationFrame(frame);
  // Sixty pictures a second is plenty for this, whatever the screen can do
  if (now - lastDraw < 15) return;
  lastDraw = now;
  const f = frameAt(run.tr, mixerNow());
  let alpha = Math.min(1, (now - run.shownAt) / 250);
  if (run.leaving !== undefined) {
    alpha = Math.min(alpha, 1 - (now - run.leaving) / 350);
    if (alpha <= 0) { end(false); return; }
  }
  for (const v of views.values()) {
    try { drawView(v, f, Math.max(0, alpha)); } catch (e) { v.gl = null; postMessage({ type: "error", message: String(e && e.message || e) }); }
  }
};
onmessage = (e) => {
  const m = e.data;
  if (m.type === "add") {
    const v = { canvas: m.canvas, px: 0, pad: 0, coverPx: 0, radius: 0, run: 0 };
    try { setup(v); } catch (err) { postMessage({ type: "error", message: String(err && err.message || err) }); }
    views.set(m.id, v);
  } else if (m.type === "place") {
    const v = views.get(m.id);
    if (v) { v.px = m.px; v.pad = m.pad; v.coverPx = m.coverPx; v.radius = m.radius; }
  } else if (m.type === "remove") {
    const v = views.get(m.id);
    views.delete(m.id);
    try { v && v.gl && v.gl.getExtension("WEBGL_lose_context") && v.gl.getExtension("WEBGL_lose_context").loseContext(); } catch (err) {}
  } else if (m.type === "run") {
    end(true);
    run = { id: m.id, tr: m.tr, style: m.style, seed: m.seed, cb: m.cb, a: m.a, b: m.b, shownAt: performance.now(), leaving: undefined };
    if (!looping) { looping = true; requestAnimationFrame(frame); }
  } else if (m.type === "clock") {
    const at = performance.now();
    const offset = m.mixer - at / 1000;
    // Readings a few milliseconds apart are eased together, so the picture doesn't twitch with each one;
    // a real jump (a seek, coming back from a pause) is followed at once
    const eased = clock.running && m.running && Math.abs(offset - clock.offset) < 0.08 ? clock.offset + (offset - clock.offset) * 0.25 : offset;
    clock = { offset: eased, frozen: m.mixer, at: at, running: m.running };
  } else if (m.type === "leave") {
    if (run && run.id === m.id && run.leaving === undefined) run.leaving = performance.now() - (m.quick ? 150 : 0);
  } else if (m.type === "stop") {
    end(true);
  }
};
`;

// ------------------ STATE (the page's side) ------------------
type Target = { id: number; img: HTMLImageElement; canvas: HTMLCanvasElement; big: boolean; placed: string };
type Run = { id: number; tr: CoverTransition; toCover: string; leaving?: boolean; holdSince?: number };

let worker: Worker | undefined;
let workerBroken = false;
let run: Run | undefined;
let timer = 0;
let seq = 0;
let nextTarget = 1;
const targets = new Map<HTMLImageElement, Target>();

const getWorker = () => {
  if (worker || workerBroken) return worker;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const w = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    w.onmessage = (e) => {
      if (e.data?.type === "done" && run?.id === e.data.id) finish();
      else if (e.data?.type === "error") warn("Cover transition couldn't be drawn", e.data.message);
    };
    w.onerror = (e) => {
      warn("Cover transitions are off: their worker failed", e.message);
      workerBroken = true;
      worker = undefined;
      finish();
    };
    worker = w;
  } catch (err) {
    warn("Cover transitions are off: no worker", err);
    workerBroken = true;
  }
  return worker;
};

// ------------------ COVERS ------------------
const coverUrl = async (trackId: string, res: number) => {
  const item = await window.luna.lib!.MediaItem.fromId(trackId);
  const url = await item?.coverUrl({ res: String(res) as any });
  if (!url) throw new Error("no cover for " + trackId);
  return url;
};
const loadBitmap = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status + " for a cover");
  return createImageBitmap(await res.blob());
};
const averageColour = (bitmap: ImageBitmap): [number, number, number] => {
  try {
    const c = new OffscreenCanvas(4, 4).getContext("2d", { willReadFrequently: true })!;
    c.drawImage(bitmap, 0, 0, 4, 4);
    const d = c.getImageData(0, 0, 4, 4).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = (d.length / 4) * 255;
    // A touch brighter and more saturated than the plain average, so the light reads as the cover's colour
    const avg = [r / n, g / n, b / n];
    const mean = (avg[0] + avg[1] + avg[2]) / 3;
    return avg.map((v) => Math.max(0, Math.min(1, mean + (v - mean) * 1.6 + 0.12))) as [number, number, number];
  } catch {
    return [1, 1, 1];
  }
};
const coverIdOf = (src: string) => COVER_ID.exec(src)?.[1];

// ------------------ TARGETS (TIDAL's covers on screen) ------------------
const visible = (img: HTMLImageElement) => {
  if (!img.isConnected || img.offsetWidth < 20) return false;
  const r = img.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.width < 20) return false;
  // The player bar's cover is hidden (not removed) while the now playing view is open
  return !img.closest('[class*="_artworkHidden_"]');
};
const findTargets = () => {
  const found: { img: HTMLImageElement; big: boolean }[] = [];
  const bigs = document.querySelectorAll<HTMLImageElement>(BIG_COVER);
  for (let i = bigs.length - 1; i >= 0; i--) {
    if (visible(bigs[i])) {
      found.push({ img: bigs[i], big: true });
      break;
    }
  }
  const mini = document.querySelector<HTMLImageElement>(MINI_COVER);
  if (mini && visible(mini)) found.push({ img: mini, big: false });
  return found;
};
// Finding the covers and reading their size and position makes the browser work out the layout of the whole
// page there and then. Doing that on every frame (up to 180 times a second, with lyrics and everything else
// animating) made TIDAL stutter through transitions. It's done a few times a second, from a timer.
const syncTargets = () => {
  const w = worker;
  if (!w) return 0;
  const found = findTargets();
  for (const [img, t] of targets) {
    if (!found.some((f) => f.img === img)) {
      w.postMessage({ type: "remove", id: t.id });
      t.canvas.remove();
      targets.delete(img);
    }
  }
  for (const f of found) {
    let t = targets.get(f.img);
    if (!t) {
      const canvas = document.createElement("canvas");
      canvas.className = "visiuun-dj-coverfx";
      canvas.style.cssText = "position:absolute;pointer-events:none;z-index:3;display:block;";
      canvas.width = canvas.height = 2;
      t = { id: nextTarget++, img: f.img, canvas, big: f.big, placed: "" };
      targets.set(f.img, t);
      try {
        const off = canvas.transferControlToOffscreen();
        w.postMessage({ type: "add", id: t.id, canvas: off }, [off]);
      } catch (err) {
        warn("Cover transition canvas couldn't be handed to its worker", err);
        targets.delete(f.img);
        continue;
      }
    }
    // The big cover sits in a layer TIDAL tilts towards the mouse: the overlay goes in the same layer
    const host = (f.big ? f.img.closest<HTMLElement>(TILT) : null) ?? f.img.parentElement;
    if (!host) continue;
    if (t.canvas.parentElement !== host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(t.canvas);
    }
    // Everything is read first and written after, and only what has changed is written
    const width = f.img.offsetWidth;
    const left = f.img.offsetLeft;
    const top = f.img.offsetTop;
    const corner = getComputedStyle(f.img).borderTopLeftRadius;
    const padPx = f.big ? Math.round(width * PAD) : 0;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const px = Math.max(2, Math.min(900, Math.round((width + 2 * padPx) * ratio)));
    const placed = `${left - padPx}|${top - padPx}|${width + 2 * padPx}|${px}|${corner}`;
    if (placed !== t.placed) {
      t.placed = placed;
      const pad = f.big ? PAD / (1 + 2 * PAD) : 0;
      const coverPx = px * (1 - 2 * pad);
      const r = parseFloat(corner) || 0;
      const radius = f.big ? (corner.includes("%") ? (r / 100) * coverPx : (r / Math.max(1, width)) * coverPx) : 0;
      w.postMessage({ type: "place", id: t.id, px, pad, coverPx, radius });
      const st = t.canvas.style;
      st.left = `${left - padPx}px`;
      st.top = `${top - padPx}px`;
      st.width = st.height = `${width + 2 * padPx}px`;
      if (!f.big) st.borderRadius = corner;
    }
  }
  return targets.size;
};
const removeTargets = () => {
  for (const t of targets.values()) {
    worker?.postMessage({ type: "remove", id: t.id });
    t.canvas.remove();
  }
  targets.clear();
};

// ------------------ KEEPING THE WORKER IN STEP ------------------
// The worker is told the mixer's time a few times a second and carries it forward itself in between
let lastClock: { mixer: number; wall: number } | undefined;
const sendClock = () => {
  const mixer = mixerClock();
  const wall = performance.now();
  // (The mixer's clock stands still while paused)
  const running = !lastClock || mixer - lastClock.mixer > ((wall - lastClock.wall) / 1000) * 0.4;
  lastClock = { mixer, wall };
  worker?.postMessage({ type: "clock", mixer, running });
};

const finish = () => {
  clearInterval(timer);
  timer = 0;
  run = undefined;
  lastClock = undefined;
  worker?.postMessage({ type: "stop" });
  removeTargets();
};

const sync = () => {
  const r = run;
  if (!r || !worker) return;
  syncTargets();
  sendClock();
  if (mixerClock() >= r.tr.end && !r.leaving) {
    // Only leave once TIDAL's own cover underneath is the new one (it changes when TIDAL moves on)
    const now = performance.now();
    r.holdSince ??= now;
    const under: HTMLImageElement | undefined = targets.keys().next().value;
    const arrived = !under || coverIdOf(under.currentSrc || under.src) === r.toCover;
    if (arrived || now - r.holdSince > 4000) {
      r.leaving = true;
      worker.postMessage({ type: "leave", id: r.id });
      // (Should the worker's word that it has finished go missing)
      setTimeout(() => run === r && finish(), 1500);
    }
  }
};

const hashOf = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
let lastStyle = -1;
const styleFor = (tr: CoverTransition) => {
  if (tr.kind === "mashup") return STYLES.indexOf("duo");
  if (tr.kind === "drop" || tr.kind === "cut") return STYLES.indexOf("echo");
  if (tr.kind === "fade") return STYLES.indexOf("liquid");
  // Blends take turns through the looks, never the same one twice in a row
  const blends = [0, 1, 2, 3, 4];
  let style = blends[hashOf(tr.fromId + ":" + tr.toId) % blends.length];
  if (style === lastStyle) style = blends[(blends.indexOf(style) + 1) % blends.length];
  return style;
};

const begin = async (tr: CoverTransition) => {
  const mine = ++seq;
  // Nobody is looking while TIDAL's window can't be seen (the page says so when it is minimised; with
  // the Optimizer plugin, also when it is behind a game or another window): no covers are fetched and
  // nothing is drawn then
  if (document.hidden) return;
  try {
    const bigShown = findTargets().some((f) => f.big);
    const res = bigShown ? 1280 : 320;
    const [urlA, urlB] = await Promise.all([coverUrl(tr.fromId, res), coverUrl(tr.toId, res)]);
    const [a, b] = await Promise.all([loadBitmap(urlA), loadBitmap(urlB)]);
    const w = getWorker();
    if (mine !== seq || !w) {
      a.close();
      b.close();
      return;
    }
    const style = styleFor(tr);
    if (tr.kind === "blend") lastStyle = style;
    run = { id: mine, tr, toCover: coverIdOf(urlB) ?? "" };
    syncTargets();
    lastClock = undefined;
    sendClock();
    w.postMessage({ type: "run", id: mine, tr, style, seed: (hashOf(tr.toId) % 1000) / 37, cb: averageColour(b), a, b }, [a, b]);
    if (!timer) timer = window.setInterval(sync, 250);
  } catch (err) {
    warn("Cover transition skipped", err);
  }
};

const abort = () => {
  seq++;
  const r = run;
  if (r && !r.leaving) {
    r.leaving = true;
    worker?.postMessage({ type: "leave", id: r.id, quick: true });
    setTimeout(() => run === r && finish(), 1000);
  }
};

// ------------------ MOUNT ------------------
export const mountCoverFx = (unloads: Set<LunaUnload>) => {
  let lastSeq = -1;
  const off = onStatus((s) => {
    const tr = s.transition;
    if (!tr) {
      if (lastSeq !== -1) abort();
      lastSeq = -1;
      return;
    }
    if (tr.seq === lastSeq) return;
    lastSeq = tr.seq;
    if (settings.coverFx === false) return;
    void begin(tr);
  });
  // (one that is under way when the window goes out of sight is let go of)
  const onHidden = () => document.hidden && abort();
  document.addEventListener("visibilitychange", onHidden);
  unloads.add(() => {
    document.removeEventListener("visibilitychange", onHidden);
    off();
    seq++;
    finish();
    worker?.terminate();
    worker = undefined;
  });
};
