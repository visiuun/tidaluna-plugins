import { pictureBox } from "./box";

// While a cover's depth map is being made: a white line that runs round the cover's edge, just outside it,
// over a faint outline of the whole edge. It sits beside the <img>, in the same tilted box, so it tilts with it,
// and it is placed again on every frame, so it stays on the cover as that grows, shrinks or scales.

const CLASS = "luna-3d-cover-loader";
const SVG_NS = "http://www.w3.org/2000/svg";
const OUTSET = 5; // px between the cover's edge and the line
const STROKE = 2.5;
const FADE_MS = 250;

export const LOADER_CSS = `
  .${CLASS} {
    position: absolute !important;
    pointer-events: none !important;
    overflow: visible;
    z-index: 3;
    opacity: 0;
    transition: opacity ${FADE_MS}ms ease;
  }
  .${CLASS}.visible { opacity: 1; }
  .${CLASS} rect { fill: none; stroke: #fff; stroke-width: ${STROKE}px; vector-effect: non-scaling-stroke; }
  .${CLASS} .track { stroke-opacity: 0.22; }
  .${CLASS} .run {
    stroke-linecap: round;
    stroke-dasharray: 26 74;
    filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.95));
    animation: luna-3d-cover-run 1.6s linear infinite;
  }
  @keyframes luna-3d-cover-run { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -100; } }
`;

export class CoverLoader {
  readonly el: SVGSVGElement;
  private readonly rects: SVGRectElement[];
  private hideTimer = 0;
  private img: HTMLImageElement | null = null;
  private followId = 0;
  private placed = "";

  constructor() {
    this.el = document.createElementNS(SVG_NS, "svg");
    this.el.setAttribute("class", CLASS);
    this.rects = ["track", "run"].map((name) => {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("class", name);
      // The dash pattern and its offset are in hundredths of the way round
      rect.setAttribute("pathLength", "100");
      this.el.appendChild(rect);
      return rect;
    });
  }

  /** Put it round this cover and fade it in; it follows the cover from then on (see follow) */
  show(img: HTMLImageElement) {
    clearTimeout(this.hideTimer);
    if (this.el.previousElementSibling !== img) img.insertAdjacentElement("afterend", this.el);
    this.img = img;
    this.place();
    if (!this.followId) this.followId = requestAnimationFrame(this.follow);
    // Fade in from hidden, once it's in the page
    if (!this.el.classList.contains("visible")) requestAnimationFrame(() => this.el.isConnected && this.el.classList.add("visible"));
  }

  // The cover can change size or scale while it shows (TIDAL animates the now playing cover's box as the view
  // or the window changes, and its own transform): it's placed again on every frame, while it's in the page
  private follow = () => {
    this.followId = 0;
    if (!this.img || !this.el.isConnected) return;
    if (this.img.isConnected) this.place();
    this.followId = requestAnimationFrame(this.follow);
  };

  private place() {
    const img = this.img;
    if (!img) return;
    // Round the picture, which can be smaller than the <img> (see box.ts)
    const { x, y, w, h, radius } = pictureBox(img);
    const cs = getComputedStyle(img);
    const pad = OUTSET + STROKE;
    const [originX, originY] = cs.transformOrigin.split(" ").map(parseFloat);
    const key = [img.offsetLeft, img.offsetTop, x, y, w, h, radius, cs.transform, originX, originY].join("|");
    if (key === this.placed) return;
    this.placed = key;
    Object.assign(this.el.style, {
      left: `${img.offsetLeft + x - pad}px`,
      top: `${img.offsetTop + y - pad}px`,
      width: `${w + 2 * pad}px`,
      height: `${h + 2 * pad}px`,
      transform: cs.transform === "none" ? "" : cs.transform,
      transformOrigin: `${originX - x + pad}px ${originY - y + pad}px`,
    });
    this.el.setAttribute("viewBox", `0 0 ${w + 2 * pad} ${h + 2 * pad}`);
    for (const rect of this.rects) {
      rect.setAttribute("x", `${STROKE}`);
      rect.setAttribute("y", `${STROKE}`);
      rect.setAttribute("width", `${w + 2 * OUTSET}`);
      rect.setAttribute("height", `${h + 2 * OUTSET}`);
      rect.setAttribute("rx", `${radius + OUTSET}`);
    }
  }

  /** Fade out, then leave the page */
  hide() {
    if (!this.el.isConnected) return;
    this.el.classList.remove("visible");
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.remove(), FADE_MS);
  }

  /** Gone at once */
  remove() {
    clearTimeout(this.hideTimer);
    cancelAnimationFrame(this.followId);
    this.followId = 0;
    this.img = null;
    this.placed = "";
    this.el.classList.remove("visible");
    this.el.remove();
  }
}
