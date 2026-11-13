import { ReactiveStore } from "@luna/core";

/** every: introduces every song, like a radio presenter; full: every set; less: a hello and a goodbye; off: nothing */
export type Commentary = "every" | "full" | "less" | "off";
export type Mixing = "auto" | "crossfade" | "none";
/** The DJ's signature sound before it speaks (see the mixer's page for what each is) */
export type Jingle = "off" | "swell" | "brass" | "guitar" | "drums" | "pulse";
export const JINGLES: { id: Jingle; name: string }[] = [
  { id: "swell", name: "Swell: a rush of air into a deep boom" },
  { id: "brass", name: "Brass: two stabs from a horn section" },
  { id: "guitar", name: "Guitar: two chugs and a power chord" },
  { id: "drums", name: "Drums: a tom fill and a boom" },
  { id: "pulse", name: "Pulse: a synth bass run and a stab" },
  { id: "off", name: "Off" },
];

export type VoiceEngine = "edge" | "local";

export type PluginSettings = {
  voice: string; // one of VOICES' ids
  commentary: Commentary;
  mixing: Mixing;
  setLength: number; // tracks per set, between two talk breaks
  discovery: number; // 0-100: how much of the music is new to you
  quality: "LOSSLESS" | "HIGH";
  homeCard: boolean;
  captions: boolean;
  jingle: Jingle;
  coverFx: boolean; // the cover art follows the transitions
  /** Transitions only: no picks and no talking, just whatever TIDAL plays mixed together. Stays on across restarts */
  transitionOnly: boolean;
  allowExplicit: boolean;
  cloudVoiceKey: string; // optional OpenAI API key: a cloud voice instead of the local one
  /** Who reads the lines: Edge's online voices (the local one steps in whenever they can't be had), or only the model on this machine */
  voiceEngine: VoiceEngine;
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("DJ", {
  voice: "bella",
  commentary: "every",
  mixing: "auto",
  setLength: 5,
  discovery: 30,
  quality: "LOSSLESS",
  homeCard: true,
  captions: true,
  jingle: "swell",
  coverFx: true,
  transitionOnly: true,
  allowExplicit: true,
  cloudVoiceKey: "",
  voiceEngine: "edge",
});

// The DJ's voices. `edge` is who reads it online (one of Edge's read-aloud voices), `kokoro` the local model's voice,
// `cloud` the one used with a cloud key: the same character each time, as near as each of the three has one.
// (`edgePitch`: Hz the online voice is raised by; `edgeBright`: decibels its top end is lifted by. Bella's online
// voice is Edge's brightest grown-up one, raised a touch: 212 Hz, next to the local Bella's 206. Raised by 20 it
// measured 233 Hz, which was too high.)
// Each has its own way of talking (see talk/script.ts).
export type Persona = { id: string; name: string; desc: string; edge: string; edgePitch?: number; edgeBright?: number; kokoro: string; cloud: string; tone: "warm" | "hype" | "dry" | "chill"; speed: number };
export const VOICES: Persona[] = [
  { id: "nova", name: "Nova", desc: "Warm and easygoing", edge: "en-US-AvaMultilingualNeural", kokoro: "af_heart", cloud: "coral", tone: "warm", speed: 1 },
  { id: "miles", name: "Miles", desc: "Laid-back, late-night radio", edge: "en-US-AndrewMultilingualNeural", kokoro: "am_michael", cloud: "ash", tone: "chill", speed: 0.97 },
  { id: "bella", name: "Bella", desc: "Bright and upbeat", edge: "en-US-AriaNeural", edgePitch: 5, edgeBright: 3, kokoro: "af_bella", cloud: "nova", tone: "hype", speed: 1.04 },
  { id: "fen", name: "Fen", desc: "Deep voice, dry humour", edge: "en-US-ChristopherNeural", kokoro: "am_fenrir", cloud: "onyx", tone: "dry", speed: 1 },
  { id: "puck", name: "Puck", desc: "Quick and playful", edge: "en-US-BrianMultilingualNeural", kokoro: "am_puck", cloud: "echo", tone: "hype", speed: 1.05 },
  { id: "emma", name: "Emma", desc: "British, calm", edge: "en-GB-SoniaNeural", kokoro: "bf_emma", cloud: "shimmer", tone: "warm", speed: 1 },
  { id: "george", name: "George", desc: "British, wry", edge: "en-GB-RyanNeural", kokoro: "bm_george", cloud: "fable", tone: "dry", speed: 1 },
];
/** (settings saved before there was a choice have none: the online voices, then) */
export const voiceEngine = (): VoiceEngine => (settings.voiceEngine === "local" ? "local" : "edge");
export const jingleStyle = (): Jingle => (JINGLES.some((j) => j.id === settings.jingle) ? settings.jingle : "swell");
export const persona = () => VOICES.find((v) => v.id === settings.voice) ?? VOICES.find((v) => v.id === "bella")!;
