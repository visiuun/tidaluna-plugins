import { MediaItem, observe, redux, safeTimeout, StyleTag } from "@luna/lib";
import { trace, unloads } from "./index.safe";
import { QueueAction, settings } from "./Settings";

export { Settings } from "./Settings";
export { trace, unloads };

const STYLE_ID = "luna-quick-queue-styles";
const BUTTON_CLASS = "luna-quick-queue-btn";

const ICONS = {
  queue: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none!important;"><path d="M3 6h11M3 12h7M3 18h7" style="fill:none!important;"/><path d="M18 9v6M15 12h6" style="fill:none!important;"/></svg>`,
  playNext: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none!important;"><path d="M3 6h11M3 12h7M3 18h7" style="fill:none!important;"/><path d="M18 8l3 3-3 3M21 11h-5" style="fill:none!important;"/></svg>`,
  success: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="fill:none!important;"><path d="M20 6L9 17L4 12" style="fill:none!important;stroke:currentColor!important;stroke-width:2.5!important;"/></svg>`,
};

function injectStyles(): void {
  new StyleTag(STYLE_ID, unloads, `
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
  `);
}

function getReactFiber(dom: Element): any {
  const key = Object.keys(dom).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  return key ? (dom as any)[key] : null;
}

const ROW = 'div[role="row"], div[class*="tableRow"], div[class*="_tableRow_"], div[data-test="tracklist-row"]';

function extractTrackId(element: HTMLElement): string | number | null {
  const row = element.closest<HTMLElement>(ROW) || element;

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

/** Where the row's track list is from (the playlist, the album...), as TIDAL's own menu passes it on with the track */
function extractContext(element: HTMLElement): { type: any; id?: string } {
  const row = element.closest<HTMLElement>(ROW) || element;
  let fiber = getReactFiber(row);
  for (let depth = 0; fiber && depth < 8; depth++, fiber = fiber.return) {
    const p = fiber.memoizedProps;
    if (p && typeof p.contextType === "string" && p.contextType) return p.contextId != null ? { type: p.contextType, id: String(p.contextId) } : { type: p.contextType };
  }
  return { type: "UNKNOWN" };
}

const queueUids = (): string[] => (redux.store.getState().playQueue?.elements ?? []).map((e: { uid: unknown }) => String(e.uid));

/**
 * The track of this row added to TIDAL's queue the way TIDAL's own Add to queue / Play next does it (the action its menu
 * sends): a track that isn't loaded yet is loaded first, one that can't be played here isn't added (TIDAL says why),
 * and TIDAL says "Added to queue". Returns whether it went in.
 */
async function executeDirectQueue(element: HTMLElement, actionType: QueueAction): Promise<boolean> {
  const id = extractTrackId(element);
  if (!id) {
    trace.warn(`Couldn't tell which track this row is: nothing was added`);
    return false;
  }
  const mediaItemIds = [String(id)];
  try {
    // (TIDAL only queues a track it has loaded: the row's track usually is, being on the page)
    if (!redux.store.getState().content?.mediaItems?.[String(id)]) await MediaItem.fromId(String(id));
    const before = new Set(queueUids());
    const isIn = () => (redux.store.getState().playQueue?.elements ?? []).some((e: { uid: unknown; mediaItemId: unknown }) => !before.has(String(e.uid)) && String(e.mediaItemId) === String(id));
    redux.actions["playQueue/ADD_MEDIA_ITEMS_TO_QUEUE"]({ mediaItemIds, position: actionType === "playNext" ? "next" : "last", sourceContext: extractContext(element) as any });
    // (TIDAL adds it there and then, as the action is sent; looked for a moment longer, should that ever change)
    for (let i = 0; i < 10 && !isIn(); i++) await new Promise((r) => setTimeout(r, 100));
    const added = isIn();
    if (!added) trace.warn(`TIDAL didn't add ${id} to the queue`);
    return added;
  } catch (err) {
    trace.err.withContext(actionType === "playNext" ? "playing a track next" : "adding a track to the queue")(err);
    return false;
  }
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

  // (dblclick too: two quick clicks here reached the row as a double-click, and TIDAL plays a row's track on that,
  // straight away and from its list, which puts that list in place of what was queued)
  ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"].forEach((evt) => {
    btn.addEventListener(evt, stopRowEvent);
  });

  let busy = false;
  const handleAction = async (e: MouseEvent, isSecondary: boolean) => {
    // (a second click while the first is under way or its tick shows is one click too many: it would add it twice)
    if (busy || btn.classList.contains("success")) return;
    let targetAction: QueueAction = settings.defaultAction;
    if (isSecondary) {
      targetAction = settings.defaultAction === "queue" ? "playNext" : "queue";
    }

    busy = true;
    let added = false;
    try {
      added = await executeDirectQueue(flexWrapper, targetAction);
    } finally {
      busy = false;
    }
    // The tick only when the track is really in the queue (it showed before anything was tried, added or not)
    if (!added || !btn.isConnected) return;
    btn.classList.add("success");
    btn.innerHTML = ICONS.success;

    safeTimeout(unloads, () => {
      btn.classList.remove("success");
      const currentDefault = settings.defaultAction;
      btn.innerHTML = currentDefault === "playNext" ? ICONS.playNext : ICONS.queue;
    }, 850);
  };

  btn.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const isShift = settings.secondaryActionOnShift && e.shiftKey;
    void handleAction(e, isShift);
  });

  btn.addEventListener("contextmenu", (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (settings.secondaryActionOnRightClick) {
      void handleAction(e, true);
    }
  });

  return btn;
}

function processFlexWrapper(flexWrapper: HTMLElement): void {
  if (flexWrapper.querySelector(`.${BUTTON_CLASS}`)) return;

  const btn = createQuickQueueButton(flexWrapper);
  flexWrapper.prepend(btn);
}

const FLEX_WRAPPERS =
  'div[class*="_contextColumn_"] > div[class*="_flexWrapper_"], div[class*="contextColumn"] > div[class*="flexWrapper"], div[class*="_contextColumn_"] > div, div[class*="contextColumn"] > div';

function processRow(flex: HTMLElement): void {
  if (flex.closest('[class*="header"]') || flex.closest('[role="columnheader"]')) return;
  processFlexWrapper(flex);
}

function scanTrackRows(): void {
  document.querySelectorAll<HTMLElement>(FLEX_WRAPPERS).forEach(processRow);
}

function refreshAllButtons(): void {
  const existingButtons = document.querySelectorAll(`.${BUTTON_CLASS}`);
  existingButtons.forEach((b) => b.remove());
  scanTrackRows();
}

injectStyles();

// Rows already on the page (Luna's observer only sees what changes after this), and every one that comes after
scanTrackRows();
observe<HTMLElement>(unloads, FLEX_WRAPPERS, processRow);

unloads.add(() => {
  document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
});

const onSettingsUpdated = () => {
  refreshAllButtons();
};

window.addEventListener("luna:quickqueue:updated", onSettingsUpdated);
unloads.add(() => {
  window.removeEventListener("luna:quickqueue:updated", onSettingsUpdated);
});
