// Turns the DJ's lines into audio. Every spoken line is kept on disk, so a line is only ever generated
// once, and the short stock lines ("Alright, switching it up") are made ahead of time: the local model
// takes a little longer than the line lasts, so the DJ prepares what it's going to say before the
// moment comes.
//
// Who reads a line: Edge's online voices unless the settings say to stay on this machine (they cost this machine
// nothing and are back in a few seconds: see edge.native.ts), and whenever those can't be had, for whatever reason, the
// local model, so the DJ is never left without a voice. With a cloud key, that voice instead.
import type { Clip } from "../audio/mixer";
import { persona, settings, voiceEngine, type Persona } from "../config";
import { log, warn } from "../log";
import { brighten, carry } from "./level";
import { readVoice, writeVoice } from "../store.native";
import { GENERIC, type GenericKind } from "./script";
import { edgeSpeak } from "./edge.native";
import { cloudSpeak, kokoroSpeak, voiceStatus } from "./voice.native";

const RATE = 24000;

const STYLE: Record<Persona["tone"], string> = {
  warm: "You are a friendly radio DJ talking to one listener. Warm, relaxed, natural pacing, a smile in the voice.",
  hype: "You are an upbeat radio DJ talking to one listener. Energetic and bright, but natural, never shouting.",
  dry: "You are a radio DJ with dry, understated humour talking to one listener. Calm, low-key, a little wry.",
  chill: "You are a late-night radio DJ talking to one listener. Laid-back, unhurried, soft-spoken.",
};

type Engine = "cloud" | "edge" | "local";
const ENGINE_NAME: Record<Engine, string> = { cloud: "cloud", edge: "online", local: "local" };
const keyFor = (text: string, p: Persona, engine: Engine) =>
  engine === "cloud" ? `cloud|${p.cloud}|${p.tone}|${text}` : engine === "edge" ? `edge|${p.edge}${p.edgePitch ? `|${p.edgePitch}Hz` : ""}|${p.speed}|${text}` : `kokoro|${p.kokoro}|${p.speed}|${text}`;
/** How far a voice's top end is lifted (dB) as this engine reads it */
const shine = (p: Persona, engine: Engine) => (engine === "edge" ? (p.edgeBright ?? 0) : 0);
const usingCloud = () => settings.cloudVoiceKey.trim().length > 20;
/** Who reads the lines, in the order they are asked */
const engines = (): Engine[] => (usingCloud() ? ["cloud"] : voiceEngine() === "edge" ? ["edge", "local"] : ["local"]);
// The online voice having just failed, it isn't asked again for a while: the local one reads meanwhile. A minute the
// first time, twice as long each time it fails again on being tried, up to ten
const EDGE_RETRY_MS = 60_000;
let edgeFails = 0;
let edgeDownUntil = 0;
let edgeFailure: string | undefined;
const edgeDown = () => Date.now() < edgeDownUntil;
/** The engines whose lines already made can be used right now: the first one's, and the stand-in's too while it is standing in */
const usableNow = (order: Engine[]) => (order[0] === "edge" && edgeDown() ? order : order.slice(0, 1));

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768) as unknown as number[]);
  return btoa(out);
};
/** An MP3 file (base64) as 16-bit mono samples at RATE (base64), which is how lines are kept */
const mp3ToPcm = async (base64: string) => {
  const bin = atob(base64);
  const file = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) file[i] = bin.charCodeAt(i);
  // (decoded at the rate of the context it is decoded in)
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(file.buffer);
  const x = audio.getChannelData(0);
  const bytes = new Uint8Array(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
    bytes[2 * i] = v & 255;
    bytes[2 * i + 1] = (v >> 8) & 255;
  }
  return toBase64(bytes);
};

const fromPcm = (base64: string, rate: number, key: string, bright = 0): Clip => {
  const bin = atob(base64);
  const n = bin.length >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    samples[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  return polish(samples, rate, key, bright);
};

/** Trims silence, makes the line carry over music at the level every line has (see level.ts) and softens the edges. `bright`: decibels its top end is lifted by first */
const polish = (x: Float32Array, rate: number, key: string, bright = 0): Clip => {
  const thresh = 0.012;
  let a = 0;
  while (a < x.length && Math.abs(x[a]) < thresh) a++;
  let b = x.length - 1;
  while (b > a && Math.abs(x[b]) < thresh) b--;
  a = Math.max(0, a - Math.round(rate * 0.03));
  b = Math.min(x.length - 1, b + Math.round(rate * 0.08));
  const n = Math.max(1, b - a + 1);
  const y = x.subarray(a, a + n);
  if (bright) brighten(y, rate, 4200, bright);
  carry(y, rate);
  const bytes = new Uint8Array(n * 2);
  const edge = Math.min(Math.round(rate * 0.01), n >> 1);
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < edge) g = i / edge;
    else if (i >= n - edge) g = (n - 1 - i) / edge;
    const v = Math.max(-32768, Math.min(32767, Math.round(y[i] * g * 32767)));
    bytes[2 * i] = v & 255;
    bytes[2 * i + 1] = (v >> 8) & 255;
  }
  return { key, pcm: toBase64(bytes), rate, duration: n / rate };
};

// ------------------ GENERATION QUEUE ------------------
// One line at a time; lines needed soon jump ahead of the stock lines being prepared in the background. A line whose
// moment has passed by the time its turn comes isn't made at all: it would only keep the next one waiting (when lines
// are slow to make, as with a game using the processor, each one being late is what made the next one late too).
type Job = { text: string; p: Persona; /** who reads it, in the order they are asked */ engines: Engine[]; urgent: boolean; /** asked for by these: made while any of them still wants it (none: always) */ wanted?: Array<() => boolean>; resolve: (b: Clip | null) => void };
const stillWanted = (job: Job) =>
  !job.wanted?.length ||
  job.wanted.some((w) => {
    try {
      return w();
    } catch {
      return true;
    }
  });
const queue: Job[] = [];
const pendingByKey = new Map<string, Promise<Clip | null>>();
const memory = new Map<string, Clip>();
let working = false;
let disabledUntil = 0;
let lastFailure: string | undefined;

/** The line as one engine reads it: 16-bit mono samples (base64) and their rate */
const read = async (engine: Engine, job: Job): Promise<{ pcm: string; rate: number }> => {
  if (engine === "cloud") return cloudSpeak(settings.cloudVoiceKey.trim(), job.text, job.p.cloud, STYLE[job.p.tone]);
  if (engine === "local") return kokoroSpeak(job.text, job.p.kokoro, job.p.speed);
  return { pcm: await mp3ToPcm((await edgeSpeak(job.text, job.p.edge, job.p.speed, job.p.edgePitch ?? 0)).mp3), rate: RATE };
};

const generate = async (job: Job): Promise<Clip | null> => {
  for (let i = 0; i < job.engines.length; i++) {
    const engine = job.engines[i];
    const last = i === job.engines.length - 1;
    if (engine === "edge" && !last && edgeDown()) continue;
    const key = keyFor(job.text, job.p, engine);
    try {
      // (standing in for another: it may have read this very line before)
      if (i > 0) {
        const stored = await readVoice(key).catch(() => null);
        if (stored) return fromPcm(stored, RATE, key, shine(job.p, engine));
      }
      const t0 = Date.now();
      const r = await read(engine, job);
      const buffer = fromPcm(r.pcm, r.rate || RATE, key, shine(job.p, engine));
      if (buffer.duration < 0.25) throw new Error("the voice returned no audio");
      writeVoice(key, r.pcm).catch(() => {});
      lastFailure = undefined;
      if (engine === "edge") {
        edgeFailure = undefined;
        edgeFails = 0;
      }
      log(`Voice: ${buffer.duration.toFixed(1)}s of speech in ${((Date.now() - t0) / 1000).toFixed(1)}s (${ENGINE_NAME[engine]}): "${job.text}"`);
      return buffer;
    } catch (err) {
      const why = String((err as Error)?.message ?? err);
      if (!last) {
        // Whatever it was (no connection, the service refusing, a sound that can't be read): the next one reads this
        // line, and the lines of the next few minutes
        const minutes = Math.min(10, 2 ** edgeFails++);
        edgeDownUntil = Date.now() + minutes * EDGE_RETRY_MS;
        edgeFailure = why;
        warn(`The ${ENGINE_NAME[engine]} voice failed: the ${ENGINE_NAME[job.engines[i + 1]]} one reads for the next ${minutes} minute${minutes > 1 ? "s" : ""}`, err);
        continue;
      }
      lastFailure = why;
      warn("The DJ's voice failed", err);
      // Don't hammer a broken engine: try again in a while
      disabledUntil = Date.now() + 60_000;
      return null;
    }
  }
  return null;
};

const work = async () => {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const i = queue.findIndex((j) => j.urgent);
      const job = queue.splice(i < 0 ? 0 : i, 1)[0];
      if (Date.now() < disabledUntil) {
        job.resolve(null);
        continue;
      }
      if (!stillWanted(job)) {
        log(`Voice: not made, its moment has passed: "${job.text}"`);
        job.resolve(null);
        continue;
      }
      const online = job.engines[0] === "edge" && !edgeDown();
      job.resolve(await generate(job));
      // (the stock lines of a voice are a couple of dozen at once: not all in one breath, of a service that is someone else's)
      if (online && !job.urgent && queue.length) await new Promise((r) => setTimeout(r, 700));
    }
  } finally {
    working = false;
  }
};

/**
 * Audio for a line in the current voice, or null if the voice can't be used right now.
 * `urgent` lines go ahead of background preparation. With `wanted`, the line is only made if that still holds when
 * its turn comes (null otherwise).
 */
export const speak = (text: string, urgent = true, wanted?: () => boolean): Promise<Clip | null> => {
  text = text.trim();
  if (!text) return Promise.resolve(null);
  const p = persona();
  const order = engines();
  const key = keyFor(text, p, order[0]);
  for (const engine of usableNow(order)) {
    const ready = memory.get(keyFor(text, p, engine));
    if (ready) return Promise.resolve(ready);
  }
  const running = pendingByKey.get(key);
  if (running) {
    for (const j of queue) {
      if (j.text !== text) continue;
      if (urgent) j.urgent = true;
      if (!wanted) j.wanted = undefined;
      else j.wanted?.push(wanted);
    }
    return running;
  }
  const job = (async () => {
    const stored = await readVoice(key).catch(() => null);
    if (stored) {
      try {
        return fromPcm(stored, RATE, key, shine(p, order[0]));
      } catch {}
    }
    return new Promise<Clip | null>((resolve) => {
      queue.push({ text, p, engines: order, urgent, wanted: wanted ? [wanted] : undefined, resolve });
      work();
    });
  })().then((buffer) => {
    pendingByKey.delete(key);
    if (buffer) {
      memory.set(buffer.key, buffer);
      // A handful of recent lines in memory is plenty: the rest are on disk
      if (memory.size > 40) memory.delete(memory.keys().next().value!);
    }
    return buffer;
  });
  pendingByKey.set(key, job);
  return job;
};

/** A line that's already available right now (in memory or on disk), without generating anything */
export const speakIfReady = async (text: string): Promise<Clip | null> => {
  const p = persona();
  for (const engine of usableNow(engines())) {
    const key = keyFor(text.trim(), p, engine);
    const ready = memory.get(key);
    if (ready) return ready;
    const stored = await readVoice(key).catch(() => null);
    if (!stored) continue;
    try {
      const buffer = fromPcm(stored, RATE, key, shine(p, engine));
      memory.set(key, buffer);
      return buffer;
    } catch {}
  }
  return null;
};

/** One of the stock lines of a kind, if any has been prepared for the current voice */
export const stockLine = async (kind: GenericKind): Promise<{ text: string; clip: Clip } | null> => {
  const options = [...GENERIC[kind]].sort(() => Math.random() - 0.5);
  for (const text of options) {
    const clip = await speakIfReady(text);
    if (clip) return { text, clip };
  }
  return null;
};

/** Prepares the stock lines for the current voice in the background (a few minutes of light work, once per voice) */
export const prepareStock = () => {
  for (const kind of ["switch", "request", "signoff", "hello", "mashStart", "mashHere", "mashWait", "mashFail"] as GenericKind[]) for (const text of GENERIC[kind]) speak(text, false).catch(() => {});
};

/** Who is reading the lines right now: Edge's online voices, the local one standing in for them, the local one by choice, or a cloud voice */
export const readingNow = (): "online" | "standin" | "local" | "cloud" => (usingCloud() ? "cloud" : voiceEngine() !== "edge" ? "local" : edgeDown() ? "standin" : "online");

export type VoiceState = {
  usable: boolean;
  cloud: boolean;
  /** Edge's online voices are the ones in use */
  online: boolean;
  /** ...but they just failed (why), and the local voice is reading until they are tried again */
  onlineDown?: string;
  /** A line is back within seconds of being asked for */
  quick: boolean;
  /** The local model is on disk */
  downloaded: boolean;
  busy: boolean;
  progress?: number;
  error?: string;
};
export const voiceState = async (): Promise<VoiceState> => {
  const cloud = usingCloud();
  const online = !cloud && voiceEngine() === "edge";
  const down = online && edgeDown();
  const s = await voiceStatus().catch(() => ({ available: false, downloaded: false, everReady: false, busy: false, progress: undefined, error: "voice engine unavailable" }));
  return {
    usable: cloud || online || s.available,
    cloud,
    online,
    onlineDown: down ? (edgeFailure ?? "no answer") : undefined,
    quick: cloud || (online && !down),
    downloaded: s.downloaded,
    busy: s.busy || working,
    progress: s.progress,
    error: lastFailure ?? s.error,
  };
};

export const resetVoiceQueue = () => {
  for (const j of queue.splice(0)) j.resolve(null);
};
