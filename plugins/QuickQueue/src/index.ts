import { LunaUnload, Tracer } from "@luna/core";
import { redux } from "@luna/lib";
import { QueueAction, settings } from "./Settings";

export { Settings } from "./Settings";

export const { trace } = Tracer("[QuickQueue]");

export const unloads = new Set<LunaUnload>();

const STYLE_ID = "luna-quick-queue-styles";
const BUTTON_CLASS = "luna-quick-queue-btn";

const ICONS = {
  queue: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none!important;"><path d="M3 6h11M3 12h7M3 18h7" style="fill:none!important;"/><path d="M18 9v6M15 12h6" style="fill:none!important;"/></svg>`,
  playNext: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none!important;"><path d="M3 6h11M3 12h7M3 18h7" style="fill:none!important;"/><path d="M18 8l3 3-3 3M21 11h-5" style="fill:none!important;"/></svg>`,
  success: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="fill:none!important;"><path d="M20 6L9 17L4 12" style="fill:none!important;stroke:currentColor!important;stroke-width:2.5!important;"/></svg>`,
};

function injectStyles(): void {
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    div[class*="_contextColumn_"],
    div[class*="contextColumn"],
    div[class*="_flexWrapper_"],
    div[class*="flexWrapper"] {
      overflow: visible !important;
    }

    .${BUTTON_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      padding: 0;
      margin: 0;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 50%;
      color: rgba(255, 255, 255, 0.65);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
      flex-shrink: 0;
      user-select: none;
      align-self: center;
      box-sizing: border-box;
      line-height: 1;
      vertical-align: middle;
      z-index: 10;
      outline: none !important;
    }

    .${BUTTON_CLASS}:focus,
    .${BUTTON_CLASS}:focus-visible {
      outline: none !important;
      box-shadow: none !important;
    }

    .${BUTTON_CLASS} svg,
    .${BUTTON_CLASS} svg path,
    .${BUTTON_CLASS} svg polyline {
      display: block;
      pointer-events: none;
      fill: none !important;
    }

    div[role="row"]:hover .${BUTTON_CLASS},
    div[class*="tableRow"]:hover .${BUTTON_CLASS},
    div[class*="_tableRow_"]:hover .${BUTTON_CLASS},
    div[data-test="tracklist-row"]:hover .${BUTTON_CLASS},
    tr:hover .${BUTTON_CLASS},
    div[class*="contextColumn"]:hover .${BUTTON_CLASS},
    div[class*="_contextColumn_"]:hover .${BUTTON_CLASS},
    div[class*="flexWrapper"]:hover .${BUTTON_CLASS},
    div[class*="_flexWrapper_"]:hover .${BUTTON_CLASS} {
      opacity: 1;
    }

    .${BUTTON_CLASS}:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.12);
      transform: scale(1.08);
    }

    .${BUTTON_CLASS}:active {
      transform: scale(0.92);
    }

    .${BUTTON_CLASS}.success {
      opacity: 1 !important;
      color: #33ffee !important;
      background: rgba(51, 255, 238, 0.18) !important;
      border: 1px solid rgba(51, 255, 238, 0.35) !important;
      transform: scale(1.08);
    }
  `;

  unloads.add(() => {
    styleEl?.remove();
  });
}

function getReactFiber(dom: Element): any {
  const key = Object.keys(dom).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  return key ? (dom as any)[key] : null;
}

function extractTrackId(element: HTMLElement): string | number | null {
  const row = element.closest<HTMLElement>(
    'div[role="row"], div[class*="tableRow"], div[class*="_tableRow_"], div[data-test="tracklist-row"]'
  ) || element;

  let trackId: string | number | null = row.getAttribute("data-track-id") || row.getAttribute("data-id");

  if (!trackId) {
    const contextBtn = row.querySelector('[data-id]');
    if (contextBtn) {
      trackId = contextBtn.getAttribute('data-id');
    }
  }

  if (!trackId) {
    const trackLink = row.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
    if (trackLink) {
      const match = trackLink.href.match(/\/track\/(\d+)/);
      if (match) trackId = match[1];
    }
  }

  if (!trackId) {
    let fiber = getReactFiber(row);
    let depth = 0;
    while (fiber && depth < 30) {
      const p = fiber.memoizedProps;
      if (p) {
        if (p.track?.id) return p.track.id;
        if (p.mediaItem?.id) return p.mediaItem.id;
        if (p.item?.id) return p.item.id;
        if (p.data?.track?.id) return p.data.track.id;
        if (p.row?.original?.id) return p.row.original.id;
        if (p.id) return p.id;
      }
      fiber = fiber.return;
      depth++;
    }
  }

  return trackId;
}

function executeDirectQueue(element: HTMLElement, actionType: QueueAction): void {
  const id = extractTrackId(element);
  if (!id) return;

  const rawId = typeof id === "number" ? id : parseInt(String(id), 10) || id;
  const actions = redux?.actions;
  if (!actions) return;

  const fallbackContext = {
    type: "TRACK",
    id: String(rawId),
  };

  const activeContext = (redux as any)?.state?.playQueue?.context || fallbackContext;

  const payload = {
    mediaItemIds: [String(rawId)],
    context: activeContext,
  };

  try {
    if (actionType === "playNext") {
      if (typeof actions["playQueue/ADD_NEXT"] === "function") {
        actions["playQueue/ADD_NEXT"](payload);
      } else if (typeof actions["playbackControls/PLAY_NEXT"] === "function") {
        actions["playbackControls/PLAY_NEXT"]({ id: rawId, itemType: "track" });
      }
    } else {
      if (typeof actions["playQueue/ADD_LAST"] === "function") {
        actions["playQueue/ADD_LAST"](payload);
      } else if (typeof actions["playQueue/ADD"] === "function") {
        actions["playQueue/ADD"](payload);
      } else if (typeof actions["playQueue/ADD_TO_QUEUE"] === "function") {
        actions["playQueue/ADD_TO_QUEUE"](payload);
      }
    }
  } catch {}
}

function createQuickQueueButton(flexWrapper: HTMLElement): HTMLElement {
  const btn = document.createElement("button");
  btn.className = BUTTON_CLASS;

  const defaultAction = settings.defaultAction;
  const isPlayNext = defaultAction === "playNext";
  btn.title = isPlayNext ? "Play Next" : "Add to Queue";
  btn.innerHTML = isPlayNext ? ICONS.playNext : ICONS.queue;

  const stopRowEvent = (e: Event) => {
    e.stopPropagation();
  };

  ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((evt) => {
    btn.addEventListener(evt, stopRowEvent);
  });

  const handleAction = (e: MouseEvent, isSecondary: boolean) => {
    let targetAction: QueueAction = settings.defaultAction;
    if (isSecondary) {
      targetAction = settings.defaultAction === "queue" ? "playNext" : "queue";
    }

    btn.classList.add("success");
    btn.innerHTML = ICONS.success;

    executeDirectQueue(flexWrapper, targetAction);

    setTimeout(() => {
      btn.classList.remove("success");
      const currentDefault = settings.defaultAction;
      btn.innerHTML = currentDefault === "playNext" ? ICONS.playNext : ICONS.queue;
    }, 850);
  };

  btn.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const isShift = settings.secondaryActionOnShift && e.shiftKey;
    handleAction(e, isShift);
  });

  btn.addEventListener("contextmenu", (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (settings.secondaryActionOnRightClick) {
      handleAction(e, true);
    }
  });

  return btn;
}

function processFlexWrapper(flexWrapper: HTMLElement): void {
  if (flexWrapper.querySelector(`.${BUTTON_CLASS}`)) return;

  const btn = createQuickQueueButton(flexWrapper);
  flexWrapper.prepend(btn);
}

function scanTrackRows(): void {
  const flexWrappers = document.querySelectorAll<HTMLElement>(
    'div[class*="_contextColumn_"] > div[class*="_flexWrapper_"], div[class*="contextColumn"] > div[class*="flexWrapper"], div[class*="_contextColumn_"] > div, div[class*="contextColumn"] > div'
  );

  for (let i = 0; i < flexWrappers.length; i++) {
    const flex = flexWrappers[i];
    if (flex.closest('[class*="header"]') || flex.closest('[role="columnheader"]')) {
      continue;
    }
    processFlexWrapper(flex);
  }
}

function refreshAllButtons(): void {
  const existingButtons = document.querySelectorAll(`.${BUTTON_CLASS}`);
  existingButtons.forEach((b) => b.remove());
  scanTrackRows();
}

injectStyles();

const observer = new MutationObserver(() => {
  scanTrackRows();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

unloads.add(() => {
  observer.disconnect();
  document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
});

const onSettingsUpdated = () => {
  refreshAllButtons();
};

window.addEventListener("luna:quickqueue:updated", onSettingsUpdated);
unloads.add(() => {
  window.removeEventListener("luna:quickqueue:updated", onSettingsUpdated);
});

scanTrackRows();