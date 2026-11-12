// TIDAL's side of the mixer. The mixer itself (mixer.page.js) runs in a process of its own; this drives
// it and mirrors what the session needs to know without asking: the audio clock and where each deck is.
import dspSource from "file://./dsp.js";
import pageSource from "file://./mixer.page.js";
import { cachedAnalysis, storeAnalysis, type Analysis } from "./analysis";
import { mixerCall, mixerClose, mixerOpen, mixerTrackUrl } from "./mixer.native";
import type { Plan } from "./plan";
import { log } from "../log";
import { normGain, trackStream } from "./source";

export type Loaded = { id: string; duration: number; analysis: Analysis; /** False while a placeholder stands in for the real analysis */ analysed: boolean };
/** A spoken line: 16-bit mono PCM (base64), levelled and trimmed */
export type Clip = { key: string; pcm: string; rate: number; duration: number };

type MapPoint = { t: number; pos: number; rate: number };

const placeholder = (duration: number): Analysis => ({
  v: 0,
  duration,
  firstSound: 0,
  lastSound: duration,
  loud: -12,
  bpm: 120,
  steady: false,
  pulse: 0,
  grid: null,
  head: null,
  tail: null,
  barPhase: 0,
  barConf: 0,
  phrasePhase: 0,
  bars: [],
  barEnergy: [],
  fullLevel: 0,
  firstBeat: 0,
  introEnd: 0,
  outroStart: duration,
  introBars: 0,
  outroBars: 0,
  fadeOut: false,
  key: { tonic: 0, mode: "major", conf: 0 },
});

let nextDeck = 0;
/** A deck in the mixer, with a local copy of its timeline */
export class Deck {
  readonly ref = `d${nextDeck++}`;
  map: MapPoint[] = [];
  stopAt = Infinity;
  gain = 1;
  disposed = false;
  constructor(readonly loaded: Loaded) {}
  get id() {
    return this.loaded.id;
  }
  get analysis() {
    return this.loaded.analysis;
  }
  get started() {
    return this.map.length > 0;
  }
  /** Track position (s) at mixer time t */
  positionAt(t: number) {
    if (!this.map.length) return 0;
    let p = this.map[0];
    for (const m of this.map) if (m.t <= t) p = m;
    return p.pos + Math.max(0, t - p.t) * p.rate;
  }
  /** Mixer time at which the track reaches `pos` */
  timeAt(pos: number) {
    if (!this.map.length) return Infinity;
    let p = this.map[0];
    for (const m of this.map) if (m.pos <= pos) p = m;
    return p.t + (pos - p.pos) / p.rate;
  }
  get endTime() {
    return this.timeAt(this.loaded.duration);
  }
}

type Reply = { ok: boolean; latency?: number; result?: any; error?: string; gone?: boolean; now: number; running: boolean; decks?: Record<string, { map: MapPoint[]; stopAt: number | null; gain: number }>; level?: number; voice?: number };

export class Mixer {
  private baseNow = 0;
  private basePerf = 0;
  running = false;
  /** Seconds between the mixer's clock and what's actually heard */
  latency = 0;
  level = 0;
  voice = 0;
  /** The mixer's process died or was closed */
  gone = false;
  readonly decks = new Set<Deck>();
  private clips = new Set<string>();
  private nextToken = 0;

  /** The mixer's audio clock, mirrored here (it only advances while playing) */
  get now() {
    return this.running ? this.baseNow + (performance.now() - this.basePerf) / 1000 : this.baseNow;
  }

  private async call<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const sent = performance.now();
    if (this.hostId === undefined) throw new Error("The DJ's mixer isn't open");
    const reply = JSON.parse(await mixerCall(method, JSON.stringify(args), this.hostId)) as Reply;
    const received = performance.now();
    if (reply.gone) this.gone = true;
    if (typeof reply.now === "number" && !reply.gone) {
      // The reply was stamped somewhere between sending and receiving: assume the middle
      this.baseNow = reply.now;
      this.basePerf = (sent + received) / 2 + (received - sent) / 4;
      this.running = reply.running;
    }
    if (reply.level !== undefined) this.level = reply.level;
    if (typeof reply.latency === "number") this.latency = Math.min(0.5, Math.max(0, reply.latency));
    if (reply.voice !== undefined) this.voice = reply.voice;
    if (reply.decks) {
      for (const d of this.decks) {
        const info = reply.decks[d.ref];
        if (!info) continue;
        d.map = info.map;
        d.stopAt = info.stopAt ?? Infinity;
        d.gain = info.gain;
      }
    }
    if (!reply.ok) throw new Error(reply.error ?? "mixer error");
    return reply.result as T;
  }

  /** The id of this mixer's page in the host (see mixer.native.ts) */
  private hostId?: number;
  async open() {
    this.hostId = await mixerOpen(pageSource);
    await this.call("init", { dsp: dspSource });
  }
  async close() {
    this.gone = true;
    // Only ever its own: never the mixer of a session that started meanwhile
    if (this.hostId !== undefined) await mixerClose(this.hostId).catch(() => {});
  }
  /** Refreshes the clock and levels */
  status() {
    return this.call("status");
  }
  setVolume(percent: number, muted: boolean) {
    return this.call("setVolume", { percent, muted });
  }
  suspend() {
    return this.call("suspend");
  }
  resume() {
    return this.call("resume");
  }

  // ------------------ TRACKS ------------------
  /** Loads a track into the mixer: fetched, decoded and (the first time) analysed there */
  async load(id: string, quality: "LOSSLESS" | "HIGH", hintBpm: number | undefined, tidalNormalizes: boolean, playFirst = false): Promise<Loaded> {
    const t0 = performance.now();
    const stream = await trackStream(id, quality);
    const tInfo = performance.now() - t0;
    const known = await cachedAnalysis(id);
    const url = await mixerTrackUrl(`t${this.nextToken++}-${id}`, { urls: stream.urls, encryptionType: stream.encryptionType, keyId: stream.keyId });
    const r = await this.call<{ duration: number; analysis?: unknown; ms?: { fetch: number; decode: number; analyse: number } }>("load", { id, url, gain: normGain(stream, tidalNormalizes), hintBpm, analyse: !known && !playFirst });
    if (!known && playFirst) {
      // The track has to start now: a stand-in until the real analysis arrives a few seconds later
      const loaded: Loaded = { id, duration: r.duration, analysis: placeholder(r.duration), analysed: false };
      this.call<{ analysis: unknown }>("analyse", { id, hintBpm })
        .then(async (a) => {
          loaded.analysis = await storeAnalysis(id, a.analysis);
          loaded.analysed = true;
        })
        .catch(() => {});
      log(`Loaded ${id} in ${Math.round(performance.now() - t0)}ms to play right away (fetch ${r.ms?.fetch}, decode ${r.ms?.decode}), analysing meanwhile`);
      return loaded;
    }
    const analysis = known ?? (await storeAnalysis(id, r.analysis));
    log(`Loaded ${id} in ${Math.round(performance.now() - t0)}ms (stream info ${Math.round(tInfo)}, fetch ${r.ms?.fetch}, decode ${r.ms?.decode}, analysis ${known ? "cached" : r.ms?.analyse})`);
    return { id, duration: r.duration, analysis, analysed: true };
  }
  unload(id: string) {
    return this.call("unload", { id }).catch(() => {});
  }
  async stretch(id: string, x0: number, speed: number, holdOut: number, glideOut: number) {
    const key = `${id}:${x0}:${speed.toFixed(5)}:${holdOut}:${glideOut}`;
    const r = await this.call<{ joins?: number; bassJoins?: number; cached?: boolean }>("stretch", { key, id, x0, speed, holdOut, glideOut });
    if (!r.cached) log(`Tempo of ${id} moved ${((speed - 1) * 100).toFixed(1)}% for the blend: ${r.joins ? `varispeed plus ${r.joins} joins${r.bassJoins ? ` (${r.bassJoins} in the bass)` : ""}` : "varispeed only, nothing cut"}`);
    return key;
  }
  dropStretch(key: string) {
    return this.call("dropStretch", { key }).catch(() => {});
  }
  private async ensureClip(clip: Clip) {
    if (this.clips.has(clip.key)) return;
    await this.call("clip", { key: clip.key, pcm: clip.pcm, rate: clip.rate });
    this.clips.add(clip.key);
    if (this.clips.size > 30) this.clips.delete(this.clips.values().next().value!);
  }

  // ------------------ DECKS ------------------
  createDeck(loaded: Loaded) {
    const d = new Deck(loaded);
    this.decks.add(d);
    return d;
  }
  async startAlone(deck: Deck, pos: number, when?: number, fade?: number) {
    return (await this.call<{ start: number }>("startAlone", { deck: deck.ref, track: deck.id, pos, when, fade })).start;
  }
  transition(a: Deck, b: Deck, plan: Plan, t0: number, stretchKey?: string) {
    return this.call<{ swap: number; end: number; bStart: number; nudgeMs?: number; beatShift?: number; bassBeat?: number }>("transition", { a: a.ref, b: b.ref, track: b.id, plan, t0, stretchKey });
  }
  /** The DJ speaks, optionally over a deck that fades away and/or into a deck that starts under the line */
  async talk(clip: Clip, opts: { a?: Deck; t0?: number; b?: Deck; pos?: number; intro?: number }) {
    await this.ensureClip(clip);
    return this.call<{ voiceStart: number; voiceEnd: number; start?: number }>("talk", { clip: clip.key, a: opts.a?.ref, t0: opts.t0, b: opts.b?.ref, track: opts.b?.id, pos: opts.pos, intro: opts.intro });
  }
  async bringIn(b: Deck, pos: number, intro: number, voiceStart: number, voiceEnd: number) {
    return (await this.call<{ start: number }>("bringIn", { b: b.ref, track: b.id, pos, intro, voiceStart, voiceEnd })).start;
  }
  kill(deck: Deck, fade = 0.1) {
    return this.call("kill", { deck: deck.ref, fade }).catch(() => {});
  }
  dispose(deck: Deck) {
    if (deck.disposed) return;
    deck.disposed = true;
    this.decks.delete(deck);
    this.call("dispose", { deck: deck.ref }).catch(() => {});
  }
  stopVoice(fade = 0.12) {
    return this.call("stopVoice", { fade }).catch(() => {});
  }
  /** A line over the music, now or at `at`: the music dips for the length of the clip and comes back */
  async aside(clip: Clip, at?: number) {
    await this.ensureClip(clip);
    await this.call("dipMusic", { level: 0.4, seconds: clip.duration + 0.2, at });
    return this.call<{ voiceStart: number; voiceEnd: number }>("talk", { clip: clip.key, t0: at });
  }
  duckAll(level: number) {
    return this.call("duckAll", { level }).catch(() => {});
  }
  killAll(fade = 0.12) {
    return this.call("killAll", { fade }).catch(() => {});
  }
}

export const closeAnyMixer = () => mixerClose().catch(() => {});
