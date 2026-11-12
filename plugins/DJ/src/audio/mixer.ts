// TIDAL's side of the mixer. The mixer itself (mixer.page.js) runs in a process of its own; this drives
// it and mirrors what the session needs to know without asking: the audio clock and where each deck is.
import dspSource from "file://./dsp.js";
import pageSource from "file://./mixer.page.js";
import { cachedAnalysis, storeAnalysis, type Analysis } from "./analysis";
import { mixerCall, mixerClose, mixerOpen, mixerTrackUrl } from "./mixer.native";
import type { Move, Plan } from "./plan";
import { log } from "../log";
import { normGain, trackStream } from "./source";

type Spoken = { voiceStart: number; voiceEnd: number; start?: number; voice: number; music: number; under: number };

export type Loaded = { id: string; duration: number; analysis: Analysis; /** False while a placeholder stands in for the real analysis */ analysed: boolean };
/** A spoken line: 16-bit mono PCM (base64), levelled and trimmed */
export type Clip = { key: string; pcm: string; rate: number; duration: number };

type MapPoint = { t: number; pos: number; rate: number };

/** One track's side of a mashup: its beat, a bar line, which of every four bars starts a phrase, and the stretch of it that may be used (seconds) */
export type MashSide = { period: number; bar0: number; phrase: number; body: number; from: number; last: number; /** How many of the next phrase lines it may start on (4 if not given) */ starts?: number; /** The most bars the mashup may last */ most?: number };
/** How two tracks go together (see mashMatch in mixer.page.js) */
export type MashFit = {
  ok: boolean;
  /** Why not: the tempos or the tunings are too far apart, or there's no room left in the track */
  why?: "tempo" | "tuning" | "room" | "ending";
  /** How well one track's bass fits the other's notes, bar by bar (-1 to 1), and for each of the two parts */
  fit: number;
  halves: [number, number];
  /** The same for the other eleven keys the second track could have been in: the middle one, and how many score lower */
  median: number;
  beaten: number;
  /** How well each track's own bass and top agree (what a perfect fit would score) */
  self: [number, number];
  rhythm: number;
  semitones: number;
  pitch: number;
  joins: number;
  speed: number;
  off: number;
  bars1: number;
  bars2: number;
  aPos: number;
  bPos: number;
  shift: number;
  lags: number[];
  tempo: [number, number];
  tuning: [number, number];
  clarity: [number, number];
  /** Milliseconds spent reading the two tracks' notes, and on the matching itself */
  ms?: [number, number];
  ways?: { k: number; joins: number; fit: number }[];
  pattern?: number[];
};

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
  /** `pitch`: how much of the speed is plain resampling (the part that moves the pitch); left out, as much of it as sounds untouched */
  async stretch(id: string, x0: number, speed: number, holdOut: number, glideOut: number, pitch?: number) {
    const key = `${id}:${x0}:${speed.toFixed(6)}:${holdOut}:${glideOut}${pitch ? `:${pitch.toFixed(6)}` : ""}`;
    const r = await this.call<{ joins?: number; bassJoins?: number; cached?: boolean }>("stretch", { key, id, x0, speed, holdOut, glideOut, pitch });
    if (!r.cached)
      log(
        `Tempo of ${id} moved ${((speed - 1) * 100).toFixed(2)}%${pitch ? `, pitch ${(1200 * Math.log2(pitch)).toFixed(0)} cents` : ""}: ${r.joins ? `varispeed plus ${r.joins} joins${r.bassJoins ? ` (${r.bassJoins} in the bass)` : ""}` : "varispeed only, nothing cut"}`,
      );
    return key;
  }
  /** Leaves a stretch of a track (or, by its key, of a tempo-shifted lead-in) where the vocal separator picks it up under `job` */
  stemOut(job: string, what: { id?: string; key?: string }, from: number, to: number) {
    return this.call<{ from: number; samples: number }>("stemOut", { job, ...what, from, to });
  }
  /**
   * Picks the voice up again and keeps it as piece `index` of the set `name` (its voice, and with `band`
   * the rest): of what was handed over, from sample `from`, the `keep` samples after the first `skip`.
   * `voice`: how much of each second of the piece is voice (0-1)
   */
  stemIn(job: string, name: string, what: { id?: string; key?: string }, from: number, piece: { skip: number; keep: number; index: number; band: boolean }) {
    return this.call<{ seconds: number; voice: number[]; /** how loud the voice is in each second (RMS) */ level: number[] }>("stemIn", { job, name, ...what, from, ...piece });
  }
  stemDrop(name: string) {
    return this.call("stemDrop", { name }).catch(() => {});
  }
  /** How the pieces of a mashup under way have been arriving */
  feedState() {
    return this.call<{ feeds: { name: string; wanted: number; played: number; late: number; missed: number; /** the least time a piece arrived before it was heard, seconds */ spare: number | null }[] }>("feedState", {});
  }
  /** How track `b` would best go on top of track `a` (both loaded), and how good a mashup that makes */
  mashMatch(a: string, b: string, A: MashSide, B: MashSide, free: boolean, exact = false) {
    return this.call<MashFit>("mashMatch", { a, b, A, B, free, exact });
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
    return this.call<{ swap: number; end: number; bStart: number; nudgeMs?: number; beatShift?: number; bassBeat?: number; move?: Move; first?: number; mid?: number; lift?: number; levels?: { voice: number; band: number } }>("transition", { a: a.ref, b: b.ref, track: b.id, plan, t0, stretchKey });
  }
  /** The DJ speaks, optionally over a deck that fades away and/or into a deck that starts under the line */
  async talk(clip: Clip, opts: { a?: Deck; t0?: number; b?: Deck; pos?: number; intro?: number }) {
    await this.ensureClip(clip);
    return this.spoke(await this.call<Spoken>("talk", { clip: clip.key, a: opts.a?.ref, t0: opts.t0, b: opts.b?.ref, track: opts.b?.id, pos: opts.pos, intro: opts.intro }));
  }
  /** Notes how a line sits against the music */
  private spoke(r: Spoken) {
    const db = (v: number) => (20 * Math.log10(Math.max(v, 1e-6))).toFixed(1);
    log(`Voice level: speaking at ${db(r.voice)} dBFS, the music at full ${db(r.music)} dBFS and ${db(r.music * r.under)} under the voice: the words are ${db(r.voice / (r.music * r.under))} dB above it`);
    return r;
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
  /** A line over the music, now or at `at`: the music eases down under it, the line starts a moment into that, and the music comes back after it */
  async aside(clip: Clip, at?: number) {
    await this.ensureClip(clip);
    const dip = await this.call<{ voiceAt: number }>("dipMusic", { seconds: clip.duration + 0.2, at });
    return this.spoke(await this.call<Spoken>("talk", { clip: clip.key, t0: dip.voiceAt }));
  }
  /** Everything eases down under the voice from now on. Returns when the line should start (on the mixer's clock) */
  async duckAll() {
    return (await this.call<{ voiceAt: number }>("duckAll", {}).catch(() => undefined))?.voiceAt;
  }
  killAll(fade = 0.12) {
    return this.call("killAll", { fade }).catch(() => {});
  }
}

export const closeAnyMixer = () => mixerClose().catch(() => {});
