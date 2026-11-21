// Where the cover's picture is drawn inside its <img>. With object-fit: contain (TIDAL's now playing cover) a box
// that isn't the picture's shape (some layouts and themes make it taller or wider) shows the picture smaller than
// the box, placed by object-position, with empty space beside it. Anything laid over the cover goes on the picture.

export type PictureBox = {
  /** Offset from the <img>'s own top left corner (offsetLeft/offsetTop), untransformed px */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner rounding: the <img>'s own, if the picture fills its box; else none (it is the box that's rounded) */
  radius: number;
};

// One of object-position's two parts: a share of the free space, or a length from the start
const place = (value: string | undefined, free: number) => {
  if (!value) return free / 2;
  if (value.endsWith("%")) return (parseFloat(value) / 100) * free;
  const px = parseFloat(value);
  return Number.isFinite(px) ? px : free / 2;
};

export const pictureBox = (img: HTMLImageElement): PictureBox => {
  const cs = getComputedStyle(img);
  const px = (v: string) => parseFloat(v) || 0;
  const left = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const top = px(cs.borderTopWidth) + px(cs.paddingTop);
  const boxW = img.offsetWidth - left - px(cs.borderRightWidth) - px(cs.paddingRight);
  const boxH = img.offsetHeight - top - px(cs.borderBottomWidth) - px(cs.paddingBottom);
  const r = px(cs.borderTopLeftRadius);
  const rounded = cs.borderTopLeftRadius.includes("%") ? (r / 100) * img.offsetWidth : r;

  let w = boxW;
  let h = boxH;
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (nw > 0 && nh > 0 && boxW > 0 && boxH > 0) {
    const fit = cs.objectFit;
    if (fit === "contain" || fit === "scale-down") {
      let scale = Math.min(boxW / nw, boxH / nh);
      if (fit === "scale-down") scale = Math.min(scale, 1);
      w = nw * scale;
      h = nh * scale;
    } else if (fit === "none") {
      w = Math.min(nw, boxW);
      h = Math.min(nh, boxH);
    }
  }
  const [posX, posY] = cs.objectPosition.split(/\s+/);
  const x = left + place(posX, boxW - w);
  const y = top + place(posY, boxH - h);
  const fills = Math.abs(w - img.offsetWidth) < 1 && Math.abs(h - img.offsetHeight) < 1;
  return { x, y, w, h, radius: fills ? rounded : 0 };
};
