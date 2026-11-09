import { backgroundFor, reachFor } from "./background";
import type { DepthMap } from "./depth";
import { surfaceFor } from "./lighting";
import { DEPTH_SIZE, EDGE_RANGE, FOREGROUND_BIAS, INK, borderProfile } from "./postprocess";

export type ParallaxParams = {
  nx: number; // normalized mouse [-1, 1]
  ny: number;
  intensity: number; // px of shift on a 500px cover
  focal: number; // 0..1
  suppress: number; // depth-cliff threshold for hole filling, 0.02..0.30
  lighting: number; // 0 = off, 1 = full strength
  lightX: number; // where the light is, over the cover box (0..1, can be outside)
  lightY: number;
};

/**
 * How far past the frame anything can land at full tilt, as a fraction of the frame. The overscan
 * hides `margin` on each side and the nearest layer travels another `margin`, so 2 × margin of the
 * zoomed image, which is 2 × margin / (1 - 2 × margin) of the frame.
 */
export const overflowFor = (intensity: number, focal: number) => {
  const margin = (intensity / 500) * Math.max(focal, 1 - focal);
  return (2 * margin) / (1 - 2 * margin);
};

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// GPU version of PerfectParallaxApp._render_parallax, upgraded to a depth ray-march.
// Each output pixel marches from the near plane to the far plane along the parallax direction and
// takes the first surface it hits, so foreground correctly covers background (no ghost copies).
// Where the ray hits the side of a depth cliff (a disocclusion hole) it shows the background layer,
// which has the background grown in behind every foreground edge, instead of stretching the foreground.
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform sampler2D uDepth; // r = smooth depth, g/b = far/near side of the edge it's on
uniform sampler2D uBg;    // rgb = background colour, a = background depth
uniform sampler2D uNear;  // per edge: near side's colour × trust, a = trust (colour matte, see edgeSides)
uniform sampler2D uFar;   // far side's colour × trust, a = the darker side's brightness
uniform sampler2D uRim;   // rgb = background pixels tinted by the foreground's anti-aliased edge, repainted; a = rim
uniform sampler2D uSurface; // rg = surface normal xy, b = gloss, a = blurred depth (see buildSurface)
uniform float uLight;       // lighting strength, 0 = off
uniform vec2 uLightPos;     // the light's position over the cover box (TIDAL's glare), 0..1
uniform vec2 uMouse;
uniform float uIntensity;
uniform float uFocal;
uniform float uSuppress;
uniform vec2 uCover;  // object-fit: cover scale
uniform float uPixel; // one output pixel in image uv
uniform sampler2D uBorder; // how near the artwork is along its top, bottom, left and right sides (rgba)
uniform vec2 uPad;     // canvas area beyond the frame on each side, as a fraction of the frame
uniform vec2 uBox;     // the frame in output pixels
uniform float uRadius; // the frame's corner radius in output pixels

const int STEPS = 40;
vec2 gx, gy; // screen-space uv derivatives, for mip selection
vec2 lightUv; // uLightPos in image uv


// Snap to the near or far side of a depth edge on the filtered value, so the edge follows a smooth
// sub-texel curve (same rule as sharpenEdges on the CPU, faded in over the edge-range threshold).
// Where the edge's two sides have clearly different colours, decide by the cover's own pixel
// instead, at full resolution: the silhouette then follows the artwork's outline exactly.
float depthAt(vec2 uv) {
  // Past the artwork there's nothing to hit (rays can only get here from beyond the frame)
  if (any(lessThan(uv, vec2(-0.002))) || any(greaterThan(uv, vec2(1.002)))) return -1.0;
  vec3 s = texture(uDepth, uv).rgb;
  float range = s.b - s.g;
  float a = (s.r - s.g) / max(range, 1e-4);
  vec4 far = texture(uFar, uv);
  if (far.a > 0.004) {
    vec3 c = textureGrad(uImage, uv, gx, gy).rgb;
    vec4 near = texture(uNear, uv);
    if (near.a > 0.004) {
      vec3 nearCol = near.rgb / near.a;
      vec3 farCol = far.rgb / near.a;
      vec3 e = nearCol - farCol;
      float byColour = clamp(dot(c - farCol, e) / max(dot(e, e), 1e-4), 0.0, 1.0);
      a = clamp(mix(a, byColour, near.a), a - 0.6, a + 0.6);
    }
    // Ink lines (darker than both sides) go with the near side, so outlines stay whole
    a = max(a, smoothstep(${(INK[0] / 255).toFixed(4)}, ${(INK[1] / 255).toFixed(4)}, far.a - dot(c, vec3(0.299, 0.587, 0.114))));
  }
  float snapped = a > ${FOREGROUND_BIAS.toFixed(3)} ? s.b : s.g;
  return mix(s.r, snapped, smoothstep(${((EDGE_RANGE * 0.75) / 255).toFixed(4)}, ${(EDGE_RANGE / 255).toFixed(4)}, range));
}

// Lighting from the AI depth, lit by the same light TIDAL's glare shows moving over the cover: relief
// facing it catches light and the rest falls into shade, glossy surfaces and highlights flare near it,
// surfaces turned away from the viewer pick up reflections, and foreground casts soft shadows away
// from it (also into the gaps that open behind it). Everything scales with the tilt: at rest the cover
// is untouched.
vec3 shade(vec3 col, vec2 uv, float here, float flatten) {
  float tilt = min(length(uMouse), 1.0);
  if (tilt < 1e-3) return col;
  vec2 toSpot = lightUv - uv;
  vec2 toLight = toSpot / max(length(toSpot), 1e-3);
  vec3 L = normalize(vec3(toSpot, 0.6));
  vec4 surf = texture(uSurface, uv);
  vec2 nxy = (surf.rg * 2.0 - 1.0) * (1.0 - flatten);
  vec3 n = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  float amt = uLight * tilt;
  vec3 base = col;

  // Highlights already in the artwork (gold, chrome, glass, eyes, wet skin): pixels much brighter than
  // their surroundings. Shiny materials are made of these, so they're what shines.
  // Measured at the depth map's scale, so grain (pores, stubble, leather) doesn't sparkle, and only
  // strong ones: a lit patch of skin is brighter than its surroundings too, but not by this much.
  // Not along silhouettes: there a bright background next to a dark subject would count as one.
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  float texels = float(textureSize(uImage, 0).x);
  float lum = dot(textureLod(uImage, uv, log2(texels / ${DEPTH_SIZE}.0)).rgb, LUMA);
  float around = dot(textureLod(uImage, uv, log2(texels / 96.0)).rgb, LUMA);
  vec3 sides = texture(uDepth, uv).rgb;
  float highlight = smoothstep(0.08, 0.3, lum - around) * smoothstep(0.35, 0.75, lum)
                  * (1.0 - smoothstep(${((EDGE_RANGE * 0.4) / 255).toFixed(4)}, ${((EDGE_RANGE * 0.8) / 255).toFixed(4)}, sides.b - sides.g));
  float shiny = max(surf.b * (1.0 - flatten), highlight);

  // Diffuse, relative to the light at rest: surfaces turned towards the light brighten, those turned
  // away darken a little (mostly a lift, so covers don't just get darker), flat areas stay as they are
  // Brightening works on the midtones (bright areas can't blow out)
  float diffuse = dot(nxy, L.xy) * tilt * 2.0 * uLight;
  col = diffuse > 0.0 ? col + col * (1.0 - col) * diffuse * 2.0 : col * (1.0 + diffuse * 0.35);

  // Soft shadows: anything well above this point, towards the light, blocks it. The occluders come
  // from blurred depth, so the shadow fades out gradually instead of copying the silhouette
  float shadow = 0.0;
  for (int k = 1; k <= 4; k++) {
    float dist = float(k) * 0.008 * tilt;
    float occluder = texture(uSurface, uv + toLight * dist).a;
    shadow += smoothstep(0.02, 0.25, occluder - here - dist * 2.0);
  }
  shadow *= smoothstep(0.0, 0.08, length(toSpot)); // no direction to cast in right under the light
  col *= 1.0 - shadow * 0.05 * amt;

  // Reflection of the (blurred) cover around it, mostly on surfaces turned away from the viewer
  vec3 env = textureLod(uImage, 0.5 + (uv - 0.5) * 0.5 - nxy * 0.7 + uMouse * 0.2, 5.0).rgb;
  float fresnel = 0.04 + 0.96 * pow(1.0 - n.z, 3.0);
  col = mix(col, max(col, env), min(1.0, fresnel * shiny * 0.6) * amt);

  // Shine: highlights brighten as the cover tilts and flare where the light passes over them (bent by
  // the surface shape), so gold, chrome and glass glint like the real thing
  vec2 off = uv - lightUv + nxy * 0.25;
  float band = exp(-dot(off, off) / (0.22 * 0.22));
  vec3 shine = mix(base, vec3(1.0), 0.25) * highlight * (0.3 + 1.6 * band) * amt;
  col = 1.0 - (1.0 - col) * (1.0 - clamp(shine, 0.0, 1.0));

  // Glare spot: the light's reflection, shaped by the surface
  vec3 H = normalize(normalize(vec3(toSpot, 0.5)) + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, H), 0.0), mix(16.0, 60.0, shiny)) * (0.03 + 0.12 * shiny);
  vec3 glare = mix(vec3(1.0), col, 0.3) * spec * amt;
  return 1.0 - (1.0 - min(col, 1.0)) * (1.0 - clamp(glare, 0.0, 1.0));
}

// Whether a surface hit outside the frame may be drawn there: only if it's clearly nearer than what the
// artwork shows at the side(s) it crossed. That's a subject standing in front of its background; the
// background itself, and subjects the artwork crops at that side, stay inside.
float popOut(vec2 q, vec2 uv, float d) {
  vec2 along = texture(uBorder, vec2(uv.x, 0.5)).rg;
  vec2 across = texture(uBorder, vec2(uv.y, 0.5)).ba;
  // In the frame's rounded corners, q is still inside the box: both nearest sides count
  bool corner = q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0;
  float side = 0.0;
  if (q.y < 0.0 || (corner && q.y < 0.5)) side = max(side, along.r);
  if (q.y > 1.0 || (corner && q.y >= 0.5)) side = max(side, along.g);
  if (q.x < 0.0 || (corner && q.x < 0.5)) side = max(side, across.r);
  if (q.x > 1.0 || (corner && q.x >= 0.5)) side = max(side, across.g);
  return smoothstep(side + 0.1, side + 0.22, d);
}

void main() {
  vec2 dir = uMouse * uIntensity;
  // Position in the frame (0..1 inside it; the canvas extends past it so things can leave it)
  vec2 q = (vUv - 0.5) * (1.0 + 2.0 * uPad) + 0.5;
  vec2 fromEdge = abs(q - 0.5) * uBox - 0.5 * uBox + uRadius;
  float inFrame = clamp(0.5 - (length(max(fromEdge, 0.0)) + min(max(fromEdge.x, fromEdge.y), 0.0) - uRadius), 0.0, 1.0);

  // Overscan that grows with the tilt: every sample stays inside the image, so no smeared borders,
  // and at rest (dir = 0) the output is pixel-identical to the original cover.
  float margin = max(abs(dir.x), abs(dir.y)) * max(uFocal, 1.0 - uFocal);
  vec2 p = (q - 0.5) * uCover * (1.0 - 2.0 * margin) + 0.5;
  // Mip level from the screen, not from where the rays land: neighbouring rays can land far apart
  // (one hits the foreground, the next the background behind it), which would pick a blurry mip that
  // mixes the foreground's colour into the background and draws faint lines along the tilt
  gx = dFdx(p);
  gy = dFdy(p);
  lightUv = (uLightPos - 0.5) * uCover * (1.0 - 2.0 * margin) + 0.5;

  // March t from near (1) to far (0); the ray position is where depth t would come from
  float stepT = 1.0 / float(STEPS);
  float t = 1.0;
  vec2 uv = p - dir * (t - uFocal);
  float d = depthAt(uv);
  float prevT = t;
  float prevD = d;
  for (int i = 0; i < STEPS && d < t; i++) {
    prevT = t; prevD = d;
    t -= stepT;
    uv = p - dir * (t - uFocal);
    d = depthAt(uv);
  }

  // A step can span a couple of screen pixels on a large cover, so binary-search the crossing inside it:
  // silhouettes land within a fraction of a pixel instead of snapping to steps (jagged combs).
  // A = last point above the surface, B = first point on or under it.
  float tA = prevT, dA = prevD, tB = t, dB = d;
  for (int i = 0; i < 5; i++) {
    float tm = 0.5 * (tA + tB);
    float dm = depthAt(p - dir * (tm - uFocal));
    if (dm >= tm) { tB = tm; dB = dm; } else { tA = tm; dA = dm; }
  }
  vec2 hitUv = p - dir * (tB - uFocal);
  vec3 col = textureGrad(uImage, hitUv, gx, gy).rgb;

  // Once the foreground has moved off it, its anti-aliased rim left on the background would show as
  // a ghost outline, so once tilted, show those pixels repainted from their own surface
  vec4 rim = texture(uRim, hitUv);
  // Doubled, since the filtered mask only reaches half strength on the edge itself, and limited to hits
  // on the far side of the edge so the foreground's own outline is never painted over
  vec3 sides = texture(uDepth, hitUv).rgb;
  float farSide = step(dB, mix(sides.g, sides.b, 0.5));
  col = mix(col, rim.rgb, min(rim.a * 2.0, 1.0) * farSide * smoothstep(0.0, 0.004, length(dir)));

  // Hit the wall of a depth cliff → disocclusion: show where the ray meets the background layer.
  // A and B are a hair apart, so a big depth jump between them means the ray crossed a cliff wall.
  // How far under the top of the wall it went grows by uPixel / |dir| per screen pixel away from the
  // silhouette, so fading in over that gives the silhouette a one-pixel anti-aliased edge.
  float wall = smoothstep(uSuppress * 0.3, uSuppress * 0.6, dB - dA);
  float hole = wall * smoothstep(0.0, uPixel / max(length(dir), 1e-5), dB - tB);

  // Inside the frame everything is drawn. Outside it only what pops out, with the silhouette's
  // anti-aliasing going into the alpha: there's no background layer there to blend towards.
  float coverage = inFrame;
  if (inFrame < 1.0) coverage = max(inFrame, (1.0 - hole) * popOut(q, hitUv, dB));
  if (coverage <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  hole *= inFrame;

  float bd = dA;
  vec2 bgUv = p - dir * (bd - uFocal);
  float hidden = 0.0;
  if (hole > 0.0) {
    // The layer behind the wall is the one the ray just passed over (edges are snapped per sample, so
    // that depth is clean). Where the cover really shows that layer, use the sharp original; where it's
    // hidden, take the grown-in background.
    hidden = smoothstep(0.03, 0.06, abs(depthAt(bgUv) - bd));
    vec4 bgRim = texture(uRim, bgUv);
    vec3 shown = mix(textureGrad(uImage, bgUv, gx, gy).rgb, bgRim.rgb, min(bgRim.a * 2.0, 1.0));
    // Averaged across the tilt: neighbouring texel rows can have grown from different sources, which
    // would show as bars along the tilt direction
    vec2 across = normalize(vec2(-dir.y, dir.x)) * ${(2 / DEPTH_SIZE).toFixed(5)};
    vec4 grown = (texture(uBg, bgUv - 2.0 * across) + texture(uBg, bgUv - across) + texture(uBg, bgUv)
                + texture(uBg, bgUv + across) + texture(uBg, bgUv + 2.0 * across)) * 0.2;
    // The background layer holds one layer per spot, which isn't always the one the ray passed over:
    // where three stack (antler, head, sky) and the middle one is thin, the far one grows over it;
    // behind a letter whose parts sit at slightly different depths, its own lower part grows in
    // instead of the sky. Either way, continue the passed layer's colour from just before the wall.
    vec2 aboveUv = p - dir * (tA - uFocal);
    vec4 aboveRim = texture(uRim, aboveUv);
    vec3 above = mix(textureGrad(uImage, aboveUv, gx, gy).rgb, aboveRim.rgb, min(aboveRim.a * 2.0, 1.0));
    vec3 behind = mix(grown.rgb, above, smoothstep(0.05, 0.1, abs(bd - grown.a)));
    col = mix(col, mix(shown, behind, hidden), hole);
  }
  // Grown-in background has no surface of its own in the map (that spot holds the foreground's): light it flat
  if (uLight > 0.0) {
    bool gap = hole > 0.5;
    col = shade(col, gap ? bgUv : hitUv, gap ? bd : dB, hole * hidden);
  }
  outColor = vec4(clamp(col, 0.0, 1.0) * coverage, coverage);
}`;

// One shared canvas/GL context, moved onto whichever cover is hovered.
export class ParallaxRenderer {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private imageTex: WebGLTexture | null = null;
  private depthTex: WebGLTexture | null = null;
  private bgTex: WebGLTexture | null = null;
  private rimTex: WebGLTexture | null = null;
  private nearTex: WebGLTexture | null = null;
  private farTex: WebGLTexture | null = null;
  private surfaceTex: WebGLTexture | null = null;
  private borderTex: WebGLTexture | null = null;
  private surfaceDepth?: DepthMap;
  // The cover's frame within the canvas, in canvas pixels
  private frame = { w: 1, h: 1, padX: 0, padY: 0, radius: 0 };
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private imageAspect = 1;
  private currentImage?: ImageBitmap;
  private currentDepth?: DepthMap;
  private bgReach = 0;

  constructor() {
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.gl = null;
    });
  }

  private init(): WebGL2RenderingContext {
    if (this.gl && !this.gl.isContextLost()) return this.gl;
    const gl = this.canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) throw new Error("WebGL2 unavailable");

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader error");
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link error");
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const name of ["uImage", "uDepth", "uMouse", "uIntensity", "uFocal", "uSuppress", "uCover", "uPixel", "uBg", "uRim", "uNear", "uFar", "uSurface", "uLight", "uLightPos", "uBorder", "uPad", "uBox", "uRadius"]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(this.uniforms.uImage, 0);
    gl.uniform1i(this.uniforms.uDepth, 1);
    gl.uniform1i(this.uniforms.uBg, 2);
    gl.uniform1i(this.uniforms.uRim, 3);
    gl.uniform1i(this.uniforms.uNear, 4);
    gl.uniform1i(this.uniforms.uFar, 5);
    gl.uniform1i(this.uniforms.uSurface, 6);
    gl.uniform1i(this.uniforms.uBorder, 7);

    const makeTex = () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      return tex;
    };
    this.imageTex = makeTex();
    this.depthTex = makeTex();
    this.bgTex = makeTex();
    this.rimTex = makeTex();
    this.nearTex = makeTex();
    this.farTex = makeTex();
    this.surfaceTex = makeTex();
    this.borderTex = makeTex();

    this.gl = gl;
    this.program = program;
    // Re-upload after a context restore
    const image = this.currentImage;
    const depth = this.currentDepth;
    this.currentImage = this.currentDepth = undefined;
    if (image && depth) this.setSource(image, depth);
    return gl;
  }

  setSource(image: ImageBitmap, depth: DepthMap) {
    const gl = this.init();
    if (image !== this.currentImage || depth !== this.currentDepth) {
      this.bgReach = 0;
      this.surfaceDepth = undefined;
    }
    if (image !== this.currentImage) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      // Mipmaps keep small covers crisp when the 640px source is minified
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.imageAspect = image.width / image.height;
      this.currentImage = image;
    }
    if (depth !== this.currentDepth) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, depth.size, depth.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, depth.edges);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, this.borderTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, depth.size, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, borderProfile(depth.edges, depth.size));
      this.currentDepth = depth;
    }
  }

  // Background layer wide enough for this Depth Shift (usually prebuilt, so just an upload)
  private syncBackground(gl: WebGL2RenderingContext, intensity: number) {
    const image = this.currentImage!;
    const depth = this.currentDepth!;
    const reach = reachFor(intensity, depth.size);
    if (this.bgReach >= reach) return;
    const bg = backgroundFor(image, depth, reach);
    const { size } = depth;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bg.layer);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.rimTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bg.rim);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.nearTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bg.near);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.farTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bg.far);
    this.bgReach = bg.reach;
  }

  // Surface map for lighting, built only once lighting is on
  private syncSurface(gl: WebGL2RenderingContext) {
    if (this.surfaceDepth === this.currentDepth) return;
    const depth = this.currentDepth!;
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const surface = surfaceFor(this.currentImage!, depth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, surface.size, surface.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, surface.data);
    this.surfaceDepth = depth;
  }

  /** Sizes the canvas for a frame of this size plus `overflow` of it on each side. Returns that margin in CSS px. */
  resize(cssW: number, cssH: number, overflow: number, cssRadius: number) {
    // Match the screen (capped at the 1280px source) so it's as sharp as TIDAL's own <img>
    const scale = Math.min(window.devicePixelRatio || 1, 1280 / Math.max(cssW, cssH, 1));
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    // Whole pixels, so the frame stays on the pixel grid and is as sharp as without the margin
    const padX = Math.ceil(w * overflow);
    const padY = Math.ceil(h * overflow);
    this.frame = { w, h, padX, padY, radius: cssRadius * (w / Math.max(cssW, 1)) };
    if (this.canvas.width !== w + 2 * padX || this.canvas.height !== h + 2 * padY) {
      this.canvas.width = w + 2 * padX;
      this.canvas.height = h + 2 * padY;
    }
    return { x: (padX / w) * cssW, y: (padY / h) * cssH };
  }

  draw(p: ParallaxParams) {
    const gl = this.init();
    if (!this.currentImage || !this.currentDepth) return;
    this.syncBackground(gl, p.intensity);
    if (p.lighting > 0) this.syncSurface(gl);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    const { w, h, padX, padY, radius } = this.frame;
    const boxAspect = w / h;
    const cover = this.imageAspect > boxAspect ? [boxAspect / this.imageAspect, 1] : [1, this.imageAspect / boxAspect];
    gl.uniform2f(this.uniforms.uCover, cover[0], cover[1]);
    gl.uniform1f(this.uniforms.uPixel, cover[0] / w);
    gl.uniform2f(this.uniforms.uPad, padX / w, padY / h);
    gl.uniform2f(this.uniforms.uBox, w, h);
    gl.uniform1f(this.uniforms.uRadius, radius);
    gl.uniform2f(this.uniforms.uMouse, p.nx, p.ny);
    gl.uniform1f(this.uniforms.uIntensity, p.intensity / 500);
    gl.uniform1f(this.uniforms.uFocal, p.focal);
    gl.uniform1f(this.uniforms.uSuppress, p.suppress);
    gl.uniform1f(this.uniforms.uLight, p.lighting);
    gl.uniform2f(this.uniforms.uLightPos, p.lightX, p.lightY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    this.canvas.remove();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.currentImage = this.currentDepth = undefined;
  }
}
