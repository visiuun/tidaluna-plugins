import type { LunaUnload } from "@luna/core";
import { watchAccess } from "./access";
import { closeAnyMixer } from "./audio/mixer";
import { closeSeparator } from "./audio/stems";
import { stopRequests } from "./brain";
import { flushLogNow, log, trace } from "./log";
import { persona, settings } from "./config";
import { underNowPlaying } from "./tidal";
import { applyTransitionOnly, flipMashup, getMash, getStage, getWaveform, getStatus, markUnloaded, mashup, onStatus, resumeCarried, setTransitionOnly, skip, startSession, stopSession, switchUp } from "./session";
import { mountStage } from "./stage";
import { resetVoiceQueue } from "./talk/voice";
import { stopVoiceEngine } from "./native";
import { coverFxStage, mountCoverFx } from "./cover";
import { mountUi } from "./ui";

export { Settings } from "./Settings";
export { trace };

export const unloads = new Set<LunaUnload>();

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
  if (!picked) void closeAnyMixer();
});

// Transitions only stays on across restarts: it's picked up again a moment after TIDAL has loaded, and
// kept in step with its setting from then on
const followTimer = setInterval(applyTransitionOnly, 4000);
const followStart = setTimeout(applyTransitionOnly, 2500);
unloads.add(() => {
  clearInterval(followTimer);
  clearTimeout(followStart);
});

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
