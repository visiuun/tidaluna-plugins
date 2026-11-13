// Runs in the Electron main process: tells whether TIDAL's window can actually be seen.
//
// TIDAL's page can't tell by itself. TIDAL switches off Chromium's background throttling for its window
// (a music player's timers must keep time in the background), and with it the page's own idea of being
// visible: minimised, or behind a full-screen game, it still says "visible" and still draws every frame.
//
// So a second page is put in the same window, one pixel large, see-through, with background throttling
// left on. Chromium tells that one the truth, including when the window is merely covered by other
// windows (it works that out for every window on Windows), and it says so here whenever it changes.
// The window's own minimise / hide events are listened to as well, for where the little page can't run.

// Through a variable so the build leaves it alone, and inside a try: TidaLunar may not hand out electron
const runtimeRequire = (id: string) => require(id);
const getElectron = (): any | null => {
  try {
    return runtimeRequire("electron");
  } catch {
    return null;
  }
};

const MARK = "optimizer-sentinel";
const SENTINEL =
  "data:text/html," +
  encodeURIComponent(`<title>${MARK}</title><script>const say=()=>console.log("${MARK}:"+document.visibilityState);document.addEventListener("visibilitychange",say);say()</script>`);

type Watch = {
  win: any;
  view?: any;
  /** What the little page says */
  seen: boolean;
  visible: boolean;
  waiting: Set<(visible: boolean | null) => void>;
  stop: () => void;
};
let watch: Watch | undefined;

const settle = (w: Watch) => {
  let visible = false;
  try {
    visible = !w.win.isDestroyed() && w.win.isVisible() && !w.win.isMinimized() && w.seen;
  } catch {}
  if (visible === w.visible) return;
  w.visible = visible;
  for (const tell of w.waiting) tell(visible);
  w.waiting.clear();
};

/** Little pages left in the window by an earlier load of this plugin */
const sweep = (win: any) => {
  try {
    for (const child of [...(win.contentView?.children ?? [])]) {
      const url: string = child?.webContents?.getURL?.() ?? "";
      if (!url.startsWith("data:text/html,") || !decodeURIComponent(url).includes(MARK)) continue;
      win.contentView.removeChildView(child);
      child.webContents.close();
    }
  } catch {}
};

/**
 * Starts watching TIDAL's window. Returns whether it can be seen right now, and whether being covered
 * by other windows is noticed (otherwise only being minimised or hidden is).
 */
export const startWatching = async (): Promise<{ visible: boolean; covered: boolean }> => {
  await stopWatching();
  const electron = getElectron();
  const win = electron?.BrowserWindow?.getAllWindows?.().find((x: any) => !x.isDestroyed() && /tidal\.com/i.test(x.webContents.getURL()));
  if (!win) throw new Error("TIDAL's window wasn't found");
  sweep(win);
  const w: Watch = { win, seen: true, visible: true, waiting: new Set(), stop: () => {} };
  const onWindow = () => settle(w);
  const events = ["minimize", "restore", "hide", "show"];
  for (const e of events) win.on(e, onWindow);
  let poll: ReturnType<typeof setInterval> | undefined;
  let covered = false;
  try {
    const view = new electron.WebContentsView({ webPreferences: { backgroundThrottling: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "visiuun-optimizer" } });
    w.view = view;
    view.setBackgroundColor("#00000000");
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    const heard = (state: unknown) => {
      w.seen = state !== "hidden";
      settle(w);
    };
    view.webContents.on("console-message", (event: any, _level: unknown, message: unknown) => {
      const text = String(event?.message ?? message ?? "");
      if (text.startsWith(MARK + ":")) heard(text.slice(MARK.length + 1));
    });
    await view.webContents.loadURL(SENTINEL);
    // (asked now and then as well, should a message go missing)
    const ask = () =>
      view.webContents
        .executeJavaScript("document.visibilityState")
        .then(heard)
        .catch(() => {});
    poll = setInterval(ask, 5000);
    await ask();
    covered = true;
  } catch {
    // (no little page: the window's own events will have to do)
    w.seen = true;
  }
  w.stop = () => {
    for (const e of events) {
      try {
        win.removeListener(e, onWindow);
      } catch {}
    }
    if (poll) clearInterval(poll);
    if (w.view) {
      try {
        win.contentView.removeChildView(w.view);
      } catch {}
      try {
        w.view.webContents.close();
      } catch {}
    }
    for (const tell of w.waiting) tell(null);
    w.waiting.clear();
  };
  watch = w;
  settle(w);
  return { visible: w.visible, covered };
};

/**
 * Resolves when the window's visibility is no longer `known` (with the new one), or after half a minute
 * with what it still is (so a call is never left hanging for hours). `null`: nothing is being watched.
 */
export const visibilityAfter = (known: boolean): Promise<boolean | null> => {
  const w = watch;
  if (!w) return Promise.resolve(null);
  if (w.visible !== known) return Promise.resolve(w.visible);
  return new Promise((resolve) => {
    const tell = (visible: boolean | null) => {
      clearTimeout(timer);
      resolve(visible);
    };
    const timer = setTimeout(() => {
      w.waiting.delete(tell);
      resolve(watch === w ? w.visible : null);
    }, 30000);
    w.waiting.add(tell);
  });
};

export const stopWatching = async () => {
  watch?.stop();
  watch = undefined;
};
