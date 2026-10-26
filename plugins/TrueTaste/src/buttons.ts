// 👍 / 👎 in the player bar, next to TIDAL's own controls. They copy the queue button's classes so they
// pick up whatever theme is active.
import type { LunaUnload } from "@luna/core";
import { currentTrackId, feedbackFor, giveFeedback, onTrackChange } from "./history";

const WRAP_CLASS = "true-taste-feedback";
const STYLE_ID = "true-taste-feedback-style";
const ANCHOR = '[data-test="play-queue-button"]';

const thumb = (down: boolean, filled: boolean) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${down ? ' style="transform:rotate(180deg)"' : ""}><path d="M7 10v11H3V10h4Z"/><path d="M7 10l4.2-7.4c.4-.7 1.3-.9 1.9-.5.9.6 1.3 1.6 1.1 2.6L13.6 9h6c1.2 0 2.1 1.1 1.9 2.3l-1.3 7.5c-.2 1.3-1.3 2.2-2.6 2.2H7"/></svg>`;

const css = `
  .${WRAP_CLASS} { display: inline-flex; align-items: center; gap: 2px; }
  .${WRAP_CLASS} button { opacity: .75; transition: opacity .15s ease, transform .12s ease; }
  .${WRAP_CLASS} button:hover { opacity: 1; }
  .${WRAP_CLASS} button:active { transform: scale(.9); }
  .${WRAP_CLASS} button[aria-pressed="true"] { opacity: 1; }
  /* TIDAL's button styles fill every svg: keep the thumbs outlined until pressed */
  .${WRAP_CLASS} svg, .${WRAP_CLASS} svg path { fill: none !important; stroke: currentColor !important; }
  .${WRAP_CLASS} button[aria-pressed="true"] svg, .${WRAP_CLASS} button[aria-pressed="true"] svg path { fill: currentColor !important; }
`;

// Only one plugin instance may own the buttons: a live reload whose cleanup didn't run must not leave
// a second pair behind
declare global {
  interface Window {
    __trueTasteFeedbackDispose?: () => void;
  }
}

export const mountFeedbackButtons = (unloads: Set<LunaUnload>) => {
  window.__trueTasteFeedbackDispose?.();
  document.getElementById(STYLE_ID)?.remove();
  // Buttons of a stale instance (whose cleanup never ran) are hidden rather than removed: removing them
  // would make its observer put them back, and the two would fight forever
  const instance = Math.random().toString(36).slice(2);
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${css}
  .${WRAP_CLASS}:not([data-instance="${instance}"]) { display: none !important; }`;
  document.head.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = WRAP_CLASS;
  wrap.dataset.instance = instance;
  const up = document.createElement("button");
  const down = document.createElement("button");
  for (const b of [up, down]) {
    b.type = "button";
    wrap.appendChild(b);
  }

  const render = () => {
    const v = feedbackFor(currentTrackId());
    const off = currentTrackId() === null;
    up.innerHTML = thumb(false, v === 1);
    down.innerHTML = thumb(true, v === -1);
    up.setAttribute("aria-pressed", String(v === 1));
    down.setAttribute("aria-pressed", String(v === -1));
    up.title = v === 1 ? "TrueTaste: more like this (click to undo)" : "TrueTaste: more like this";
    down.title = v === -1 ? "TrueTaste: less like this (click to undo)" : "TrueTaste: less like this (skips the song)";
    up.disabled = down.disabled = off;
  };
  up.addEventListener("click", (e) => {
    e.stopPropagation();
    giveFeedback(1);
    render();
  });
  down.addEventListener("click", (e) => {
    e.stopPropagation();
    giveFeedback(-1);
    render();
  });

  // Keep the buttons in place: TIDAL re-renders the player bar now and then
  let disposed = false;
  const place = () => {
    // A placement queued for the next frame can land after cleanup: it must not bring the buttons back
    if (disposed) return;
    const anchor = document.querySelector<HTMLElement>(ANCHOR);
    // Already in the bar: leave it, so other scripts moving things around can't trigger a loop
    if (!anchor || (wrap.isConnected && wrap.parentElement === anchor.parentElement)) return;
    for (const b of [up, down]) b.className = anchor.className;
    anchor.parentElement?.insertBefore(wrap, anchor);
  };
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  render();
  place();

  const offTrack = onTrackChange(render);
  const dispose = () => {
    disposed = true;
    observer.disconnect();
    offTrack();
    wrap.remove();
    style.remove();
    if (window.__trueTasteFeedbackDispose === dispose) delete window.__trueTasteFeedbackDispose;
  };
  window.__trueTasteFeedbackDispose = dispose;
  unloads.add(dispose);
};
