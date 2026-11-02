import { backgroundFor, reachFor } from "./background";
import type { DepthMap } from "./depth";

export type ParallaxParams = {
  nx: number; // normalized mouse [-1, 1]
  ny: number;
  intensity: number; // px of shift on a 500px cover
  focal: number; // 0..1
  suppress: number; // depth-cliff threshold for hole filling, 0.02..0.30
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
uniform sampler2D uDepth;
uniform sampler2D uBg;    // rgb = background colour, a = background depth
uniform sampler2D uRim;   // rgb = background pixels tinted by the foreground's anti-aliased edge, repainted; a = rim
uniform vec2 uMouse;
uniform float uIntensity;
uniform float uFocal;
uniform float uSuppress;
uniform vec2 uCover;  // object-fit: cover scale

const int STEPS = 40;

void main() {
  vec2 dir = uMouse * uIntensity;

  // Overscan that grows with the tilt: every sample stays inside the image, so no smeared borders,
  // and at rest (dir = 0) the output is pixel-identical to the original cover.
  float margin = max(abs(dir.x), abs(dir.y)) * max(uFocal, 1.0 - uFocal);
  vec2 p = (vUv - 0.5) * uCover * (1.0 - 2.0 * margin) + 0.5;

  // March t from near (1) to far (0); the ray position is where depth t would come from
  float stepT = 1.0 / float(STEPS);
  float t = 1.0;
  vec2 uv = p - dir * (t - uFocal);
  float d = texture(uDepth, uv).r;
  float prevT = t;
  vec2 prevUv = uv;
  float prevD = d;
  for (int i = 0; i < STEPS && d < t; i++) {
    prevT = t; prevUv = uv; prevD = d;
    t -= stepT;
    uv = p - dir * (t - uFocal);
    d = texture(uDepth, uv).r;
  }

  // Refine the hit between the last two samples
  float a = max(prevT - prevD, 0.0);
  float b = max(d - t, 0.0);
  float hitT = mix(prevT, t, a / (a + b + 1e-5));
  vec2 hitUv = p - dir * (hitT - uFocal);
  vec3 col = texture(uImage, hitUv).rgb;

  // Once the foreground has moved off it, its anti-aliased rim left on the background would show as
  // a ghost outline, so once tilted, show those pixels repainted from their own surface
  vec4 rim = texture(uRim, hitUv);
  col = mix(col, rim.rgb, rim.a * smoothstep(0.0, 0.004, length(dir)));

  // Hit the wall of a depth cliff → disocclusion: show where the ray meets the background layer.
  // Consecutive samples are under a texel apart, so on a real surface their depths barely differ;
  // a big jump means the ray went through a cliff wall (wherever on the filtered edge it landed).
  float hole = smoothstep(uSuppress * 0.3, uSuppress * 0.6, d - prevD);
  if (hole > 0.0) {
    // Where the layer behind the wall lands. If the cover really shows that layer there, use the
    // sharp original; only where it's hidden take the grown-in background (which may hold a layer
    // even further back, e.g. the floor under a dog's back when the hole is behind its head).
    // The layer is whichever is farther: the one the ray just passed over, or the nearest one the
    // background layer has behind this wall (the ray's last sample can sit partway up the edge).
    float bd = min(prevD, texture(uBg, hitUv).a);
    vec2 bgUv = p - dir * (bd - uFocal);
    float hidden = smoothstep(0.03, 0.06, abs(texture(uDepth, bgUv).r - bd));
    vec4 bgRim = texture(uRim, bgUv);
    vec3 shown = mix(texture(uImage, bgUv).rgb, bgRim.rgb, bgRim.a);
    // The grown-in background can hold a different layer than this one (wide gaps between stacked
    // layers): then continue the layer's colour from just before the wall rather than show the wrong one
    vec4 grown = texture(uBg, bgUv);
    vec4 edgeRim = texture(uRim, prevUv);
    vec3 edge = mix(texture(uImage, prevUv).rgb, edgeRim.rgb, edgeRim.a);
    vec3 behind = mix(grown.rgb, edge, smoothstep(0.03, 0.06, abs(grown.a - bd)));
    col = mix(col, mix(shown, behind, hidden), hole);
  }
  outColor = vec4(col, 1.0);
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
    const gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "low-power" });
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

    for (const name of ["uImage", "uDepth", "uMouse", "uIntensity", "uFocal", "uSuppress", "uCover", "uBg", "uRim"]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(this.uniforms.uImage, 0);
    gl.uniform1i(this.uniforms.uDepth, 1);
    gl.uniform1i(this.uniforms.uBg, 2);
    gl.uniform1i(this.uniforms.uRim, 3);

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
    if (image !== this.currentImage || depth !== this.currentDepth) this.bgReach = 0;
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
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, depth.size, depth.size, 0, gl.RED, gl.UNSIGNED_BYTE, depth.data);
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
    this.bgReach = bg.reach;
  }

  resize(cssW: number, cssH: number) {
    // Match the screen (capped at the 1280px source) so it's as sharp as TIDAL's own <img>
    const scale = Math.min(window.devicePixelRatio || 1, 1280 / Math.max(cssW, cssH, 1));
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(p: ParallaxParams) {
    const gl = this.init();
    if (!this.currentImage || !this.currentDepth) return;
    this.syncBackground(gl, p.intensity);
    const { width: w, height: h } = this.canvas;
    gl.viewport(0, 0, w, h);

    const boxAspect = w / h;
    const cover = this.imageAspect > boxAspect ? [boxAspect / this.imageAspect, 1] : [1, this.imageAspect / boxAspect];
    gl.uniform2f(this.uniforms.uCover, cover[0], cover[1]);
    gl.uniform2f(this.uniforms.uMouse, p.nx, p.ny);
    gl.uniform1f(this.uniforms.uIntensity, p.intensity / 500);
    gl.uniform1f(this.uniforms.uFocal, p.focal);
    gl.uniform1f(this.uniforms.uSuppress, p.suppress);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    this.canvas.remove();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
    this.currentImage = this.currentDepth = undefined;
  }
}
