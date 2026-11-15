import type { LunaUnload } from "@luna/core";
import { watchAccess } from "./access";
import { closeAnyMixer } from "./audio/mixer";
import { closeSeparator } from "./audio/stems";
import { stopRequests } from "./brain";
import { flushLogNow, log, trace } from "./log";
import { persona } from "./config";
import { applyTransitionOnly, getMash, getStage, getWaveform, getStatus, markUnloaded, onStatus, resumeCarried, setTransitionOnly, skip, startSession, stopSession, switchUp } from "./session";
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
  skip,
  stop: () => void stopSession("stopped from the full screen"),
});
mountUi(unloads, () => stage.open());
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
