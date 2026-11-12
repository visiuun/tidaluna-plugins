import type { LunaUnload } from "@luna/core";
import { closeAnyMixer } from "./audio/mixer";
import { closeSeparator } from "./audio/stems";
import { stopRequests } from "./brain";
import { flushLogNow, log, trace } from "./log";
import { applyTransitionOnly, markUnloaded, stopSession } from "./session";
import { resetVoiceQueue } from "./talk/voice";
import { stopVoiceEngine } from "./talk/voice.native";
import { mountCoverFx } from "./cover";
import { mountUi } from "./ui";

export { Settings } from "./Settings";
export { trace };

export const unloads = new Set<LunaUnload>();

// A mixer left behind by an instance whose cleanup never ran would keep playing with nothing driving it
closeAnyMixer();
mountUi(unloads);
mountCoverFx(unloads);

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
