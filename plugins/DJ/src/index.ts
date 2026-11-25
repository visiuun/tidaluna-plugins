import { watchAccess } from "./access";
import { closeAnyMixer } from "./audio/mixer";
import { closeSeparator } from "./audio/stems";
import { stopRequests } from "./brain";
import { flushLogNow, log } from "./log";
import { unloads } from "./index.safe";
import { every, later } from "./later";
import { persona, settings } from "./config";
import { dropOwnUpcoming, underNowPlaying } from "./tidal";
import { applyTransitionOnly, flipMashup, getMash, getStage, getWaveform, getStatus, isActive, markUnloaded, mashup, onStatus, resumeCarried, seekTo, setTransitionOnly, shareCode, skip, startSession, stopSession, switchUp } from "./session";
import { mountStage } from "./stage";
import { resetVoiceQueue } from "./talk/voice";
import { stopVoiceEngine } from "./native";
import { coverFxStage, mountCoverFx } from "./cover";
import { mountUi } from "./ui";

export { Settings } from "./Settings";
export { errSignal, trace, unloads } from "./index.safe";

// Luna's questions about the DJ's native side are asked once you are there to answer them, and nothing native is
// done before (see access.ts)
unloads.add(watchAccess());

/** TrueTaste's thumbs in the player bar (the pair of the instance that is running), when that plugin is there */
const thumbs = () => {
  const wrap = [...document.querySelectorAll<HTMLElement>(".true-taste-feedback")].find((w) => getComputedStyle(w).display !== "none");
  const [up, down] = wrap ? [...wrap.querySelectorAll("button")] : [];
  return up && down && !up.disabled ? { up, down } : undefined;
};
let ui: ReturnType<typeof mountUi> | undefined;
const tidalState = () => window.luna.lib?.redux.store.getState() as any;
const tidalAction = (type: string, payload?: unknown) => {
  try {
    (window.luna.lib!.redux.actions as Record<string, (p?: unknown) => unknown>)[type]?.(payload);
  } catch (err) {
    log(`Couldn't ${type}: ${String((err as Error)?.message ?? err)}`);
  }
};

// The DJ full screen: what it's doing, as it does it
const stage = mountStage(unloads, {
  status: getStatus,
  onStatus,
  stage: getStage,
  waveform: getWaveform,
  mash: getMash,
  fxSurface: coverFxStage,
  persona: () => persona().name,
  cover: async (id) => (await window.luna.lib!.MediaItem.fromId(id))?.coverUrl({ res: "640" as any }),
  start: () => void startSession(),
  startFollow: () => setTransitionOnly(true),
  switchUp,
  mashup: () => void mashup(),
  flipMashup: () => void flipMashup(),
  shareMashup: shareCode,
  marks: async (id) => {
    const item = (await window.luna.lib!.MediaItem.fromId(id))?.tidalItem as { explicit?: boolean; ai?: boolean; upload?: boolean; audioModes?: string[] } | undefined;
    return item && { explicit: !!item.explicit, ai: !!item.ai, upload: !!item.upload, atmos: !!item.audioModes?.includes("DOLBY_ATMOS") };
  },
  // (TrueTaste keeps its own books: its thumbs are pressed for it, here, the way a click on them would)
  feedback: {
    state: () => {
      const t = thumbs();
      return t && (t.up.getAttribute("aria-pressed") === "true" ? 1 : t.down.getAttribute("aria-pressed") === "true" ? -1 : 0);
    },
    give: (v) => thumbs()?.[v > 0 ? "up" : "down"].click(),
  },
  panel: {
    toggle: (under) => ui?.panel.toggle(under),
    isOpen: () => !!ui?.panel.isOpen(),
    close: () => ui?.panel.close(),
  },
  skip,
  // TIDAL's own controls, the way its player bar works them (the DJ follows TIDAL's seeks and moves as it always does)
  player: {
    playing: () => tidalState()?.playbackControls?.desiredPlaybackState === "PLAYING",
    toggle: () => tidalAction("playbackControls/TOGGLE_PLAYBACK"),
    previous: () => tidalAction("playbackControls/SKIP_PREVIOUS"),
    // (the full DJ plays its own queue and is skipped through; with transitions only it follows TIDAL, which is
    // skipped the way its own next button does, and the DJ mixes into whatever comes. The DJ's skip does nothing then)
    next: () => {
      const s = getStatus();
      if (s.phase !== "off" && s.mode !== "follow") skip();
      else tidalAction("playbackControls/SKIP_NEXT");
    },
    seek: (s) => void (seekTo(Math.max(0, s)) || tidalAction("playbackControls/SEEK", Math.max(0, s))),
    volume: () => {
      const pc = tidalState()?.playbackControls;
      return { percent: Number(pc?.volume) || 0, muted: !!pc?.muted };
    },
    setVolume: (p) => {
      if (tidalState()?.playbackControls?.muted && p > 0) tidalAction("playbackControls/SET_MUTE", false);
      tidalAction("playbackControls/SET_VOLUME", { volume: Math.max(0, Math.min(100, Math.round(p))) });
    },
  },
  stop: () => void stopSession("stopped from the full screen"),
  // What other plugins bring to the full screen (it shows through to them: see THROUGH in stage.ts)
  guests: () => ({ backdrop: settings.stageBackdrop !== false, lyrics: settings.stageLyrics !== false, cover3d: settings.stageCover3d !== false }),
  setLyrics: (on) => (settings.stageLyrics = on),
  under: underNowPlaying,
});
ui = mountUi(unloads, () => stage.open());
mountCoverFx(unloads);
// The mixer plays on when TIDAL's page dies or is reloaded: the session is picked up again where it was
// (see CARRIED OVER in mixer.native.ts). Any other mixer left behind, by an instance whose cleanup never
// ran, would keep playing with nothing driving it: closed.
void resumeCarried().then((picked) => {
  if (picked) return;
  void closeAnyMixer();
  // Tracks a DJ session put in TIDAL's queue and left there when it ended without this page (TIDAL closed or
  // restarted) come out, once TIDAL has its queue back: with no DJ on they would play before your own queue.
  // (Transitions only does the same as it picks up a song; a DJ that is on by then has them as its own)
  later(() => {
    if (isActive()) return;
    const left = dropOwnUpcoming();
    if (left) log(`Took ${left} track${left === 1 ? "" : "s"} the DJ had left in TIDAL's queue out of it`);
  }, 8000);
});

// Transitions only stays on across restarts: it's picked up again a moment after TIDAL has loaded, and
// kept in step with its setting from then on
every(applyTransitionOnly, 4000);
later(applyTransitionOnly, 2500);

unloads.add(() => {
  markUnloaded();
  // Hands the sound straight back to TIDAL's own player
  stopSession("plugin unloaded", true).catch(() => {});
  resetVoiceQueue();
  stopRequests();
  stopVoiceEngine().catch(() => {});
  closeSeparator();
  flushLogNow();
});

log("DJ loaded");
// Whether this TIDAL can use the graphics card (WebGPU): it can't unless started with --enable-unsafe-webgpu
void (async () => {
  try {
    const adapter = await (navigator as any).gpu?.requestAdapter();
    log(adapter ? `WebGPU: available (${[adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(" ") || "GPU"}); the DJ's vocal separator still runs on the processor` : "WebGPU: not available here (TIDAL has to be started with --enable-unsafe-webgpu); the vocal separator runs on the processor");
  } catch (err) {
    log(`WebGPU: not available here (${String((err as Error)?.message ?? err)})`);
  }
})();
