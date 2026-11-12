import { ReactiveStore } from "@luna/core";

export type Commentary = "full" | "less" | "off";
export type Mixing = "auto" | "crossfade" | "none";

export type PluginSettings = {
  voice: string; // one of VOICES' ids
  commentary: Commentary;
  mixing: Mixing;
  setLength: number; // tracks per set, between two talk breaks
  discovery: number; // 0-100: how much of the music is new to you
  quality: "LOSSLESS" | "HIGH";
  homeCard: boolean;
  captions: boolean;
  coverFx: boolean; // the cover art follows the transitions
  /** Transitions only: no picks and no talking, just whatever TIDAL plays mixed together. Stays on across restarts */
  transitionOnly: boolean;
  allowExplicit: boolean;
  cloudVoiceKey: string; // optional OpenAI API key: a cloud voice instead of the local one
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("DJ", {
  voice: "nova",
  commentary: "full",
  mixing: "auto",
  setLength: 5,
  discovery: 30,
  quality: "LOSSLESS",
  homeCard: true,
  captions: true,
  coverFx: true,
  transitionOnly: false,
  allowExplicit: true,
  cloudVoiceKey: "",
});

// The DJ's voices. `kokoro` is the local model's voice, `cloud` the one used with a cloud key.
// Each has its own way of talking (see talk/script.ts).
export type Persona = { id: string; name: string; desc: string; kokoro: string; cloud: string; tone: "warm" | "hype" | "dry" | "chill"; speed: number };
export const VOICES: Persona[] = [
  { id: "nova", name: "Nova", desc: "Warm and easygoing", kokoro: "af_heart", cloud: "coral", tone: "warm", speed: 1 },
  { id: "miles", name: "Miles", desc: "Laid-back, late-night radio", kokoro: "am_michael", cloud: "ash", tone: "chill", speed: 0.97 },
  { id: "bella", name: "Bella", desc: "Bright and upbeat", kokoro: "af_bella", cloud: "nova", tone: "hype", speed: 1.04 },
  { id: "fen", name: "Fen", desc: "Deep voice, dry humour", kokoro: "am_fenrir", cloud: "onyx", tone: "dry", speed: 1 },
  { id: "puck", name: "Puck", desc: "Quick and playful", kokoro: "am_puck", cloud: "echo", tone: "hype", speed: 1.05 },
  { id: "emma", name: "Emma", desc: "British, calm", kokoro: "bf_emma", cloud: "shimmer", tone: "warm", speed: 1 },
  { id: "george", name: "George", desc: "British, wry", kokoro: "bm_george", cloud: "fable", tone: "dry", speed: 1 },
];
export const persona = () => VOICES.find((v) => v.id === settings.voice) ?? VOICES[0];
