// Turns the DJ's lines into audio. Every spoken line is kept on disk, so a line is only ever generated
// once, and the short stock lines ("Alright, switching it up") are made ahead of time: the local model
// takes a little longer than the line lasts, so the DJ prepares what it's going to say before the
// moment comes.
import type { Clip } from "../audio/mixer";
import { persona, settings, type Persona } from "../config";
import { log, warn } from "../log";
import { carry } from "./level";
import { readVoice, writeVoice } from "../store.native";
import { GENERIC, type GenericKind } from "./script";
import { cloudSpeak, kokoroSpeak, voiceStatus } from "./voice.native";

const RATE = 24000;

const STYLE: Record<Persona["tone"], string> = {
  warm: "You are a friendly radio DJ talking to one listener. Warm, relaxed, natural pacing, a smile in the voice.",
  hype: "You are an upbeat radio DJ talking to one listener. Energetic and bright, but natural, never shouting.",
  dry: "You are a radio DJ with dry, understated humour talking to one listener. Calm, low-key, a little wry.",
  chill: "You are a late-night radio DJ talking to one listener. Laid-back, unhurried, soft-spoken.",
};

const keyFor = (text: string, p: Persona, cloud: boolean) => (cloud ? `cloud|${p.cloud}|${p.tone}|${text}` : `kokoro|${p.kokoro}|${p.speed}|${text}`);
const usingCloud = () => settings.cloudVoiceKey.trim().length > 20;

const fromPcm = (base64: string, rate: number, key: string): Clip => {
  const bin = atob(base64);
  const n = bin.length >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    samples[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  return polish(samples, rate, key);
};

/** Trims silence, makes the line carry over music at the level every line has (see level.ts) and softens the edges */
const polish = (x: Float32Array, rate: number, key: string): Clip => {
  const thresh = 0.012;
  let a = 0;
  while (a < x.length && Math.abs(x[a]) < thresh) a++;
  let b = x.length - 1;
  while (b > a && Math.abs(x[b]) < thresh) b--;
  a = Math.max(0, a - Math.round(rate * 0.03));
  b = Math.min(x.length - 1, b + Math.round(rate * 0.08));
  const n = Math.max(1, b - a + 1);
  const y = x.subarray(a, a + n);
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
  let out = "";
  for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768) as unknown as number[]);
  return { key, pcm: btoa(out), rate, duration: n / rate };
};

// ------------------ GENERATION QUEUE ------------------
// One line at a time; lines needed soon jump ahead of the stock lines being prepared in the background
type Job = { text: string; p: Persona; cloud: boolean; urgent: boolean; resolve: (b: Clip | null) => void };
const queue: Job[] = [];
const pendingByKey = new Map<string, Promise<Clip | null>>();
const memory = new Map<string, Clip>();
let working = false;
let disabledUntil = 0;
let lastFailure: string | undefined;

const generate = async (job: Job): Promise<Clip | null> => {
  const key = keyFor(job.text, job.p, job.cloud);
  try {
    const t0 = Date.now();
    const r = job.cloud ? await cloudSpeak(settings.cloudVoiceKey.trim(), job.text, job.p.cloud, STYLE[job.p.tone]) : await kokoroSpeak(job.text, job.p.kokoro, job.p.speed);
    const buffer = fromPcm(r.pcm, r.rate || RATE, key);
    if (buffer.duration < 0.25) throw new Error("the voice returned no audio");
    writeVoice(key, r.pcm).catch(() => {});
    lastFailure = undefined;
    log(`Voice: ${buffer.duration.toFixed(1)}s of speech in ${((Date.now() - t0) / 1000).toFixed(1)}s (${job.cloud ? "cloud" : "local"}): "${job.text}"`);
    return buffer;
  } catch (err) {
    lastFailure = String((err as Error)?.message ?? err);
    warn("The DJ's voice failed", err);
    // Don't hammer a broken engine: try again in a while
    disabledUntil = Date.now() + 60_000;
    return null;
  }
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
      job.resolve(await generate(job));
    }
  } finally {
    working = false;
  }
};

/**
 * Audio for a line in the current voice, or null if the voice can't be used right now.
 * `urgent` lines go ahead of background preparation.
 */
export const speak = (text: string, urgent = true): Promise<Clip | null> => {
  text = text.trim();
  if (!text) return Promise.resolve(null);
  const p = persona();
  const cloud = usingCloud();
  const key = keyFor(text, p, cloud);
  const ready = memory.get(key);
  if (ready) return Promise.resolve(ready);
  const running = pendingByKey.get(key);
  if (running) {
    if (urgent) for (const j of queue) if (j.text === text) j.urgent = true;
    return running;
  }
  const job = (async () => {
    const stored = await readVoice(key).catch(() => null);
    if (stored) {
      try {
        return fromPcm(stored, RATE, key);
      } catch {}
    }
    return new Promise<Clip | null>((resolve) => {
      queue.push({ text, p, cloud, urgent, resolve });
      work();
    });
  })().then((buffer) => {
    pendingByKey.delete(key);
    if (buffer) {
      memory.set(key, buffer);
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
  const key = keyFor(text.trim(), p, usingCloud());
  const ready = memory.get(key);
  if (ready) return ready;
  const stored = await readVoice(key).catch(() => null);
  if (!stored) return null;
  try {
    const buffer = fromPcm(stored, RATE, key);
    memory.set(key, buffer);
    return buffer;
  } catch {
    return null;
  }
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
  for (const kind of ["switch", "request", "signoff", "hello"] as GenericKind[]) for (const text of GENERIC[kind]) speak(text, false).catch(() => {});
};

export type VoiceState = { usable: boolean; cloud: boolean; downloaded: boolean; busy: boolean; progress?: number; error?: string };
export const voiceState = async (): Promise<VoiceState> => {
  const cloud = usingCloud();
  const s = await voiceStatus().catch(() => ({ available: false, downloaded: false, everReady: false, busy: false, progress: undefined, error: "voice engine unavailable" }));
  return { usable: cloud || s.available, cloud, downloaded: s.downloaded, busy: s.busy || working, progress: s.progress, error: lastFailure ?? s.error };
};

export const resetVoiceQueue = () => {
  for (const j of queue.splice(0)) j.resolve(null);
};
