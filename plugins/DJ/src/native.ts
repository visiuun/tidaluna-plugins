// The DJ's native side as the rest of the page uses it: every call waits until Luna has been asked about all of it,
// at a moment chosen for that (see access.ts). Nothing on the page imports a .native file but this and access.ts.
import { gated } from "./access";
import * as mixer from "./audio/mixer.native";
import * as stems from "./audio/stems.native";
import * as store from "./store.native";
import * as edge from "./talk/edge.native";
import * as voice from "./talk/voice.native";

export const readDoc = gated(store.readDoc);
export const writeDoc = gated(store.writeDoc);
export const readVoice = gated(store.readVoice);
export const writeVoice = gated(store.writeVoice);
export const clearVoiceFiles = gated(store.clearVoiceFiles);
export const appendLog = gated(store.appendLog);
export const getDataDir = gated(store.getDataDir);
export const openTrueTastePage = gated(store.openTrueTastePage);

export const mixerOpen = gated(mixer.mixerOpen);
export const mixerTrackUrl = gated(mixer.mixerTrackUrl);
export const mixerCall = gated(mixer.mixerCall);
export const mixerClose = gated(mixer.mixerClose);
export const mixerCarry = gated(mixer.mixerCarry);
export const mixerCarried = gated(mixer.mixerCarried);
export const mixerAdopt = gated(mixer.mixerAdopt);

export const stemsReady = gated(stems.stemsReady);
export const stemsSeparate = gated(stems.stemsSeparate);
export const stemsProgress = gated(stems.stemsProgress);
export const stemsClose = gated(stems.stemsClose);

export const kokoroSpeak = gated(voice.kokoroSpeak);
export const voiceStatus = gated(voice.voiceStatus);
export const stopVoiceEngine = gated(voice.stopVoiceEngine);
export const clearVoiceModel = gated(voice.clearVoiceModel);
export const cloudSpeak = gated(voice.cloudSpeak);

export const edgeSpeak = gated(edge.edgeSpeak);
