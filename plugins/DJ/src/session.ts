// A DJ session: takes over the song that's playing, keeps sets coming in the same sound until asked for
// something else, has every track loaded and analysed before it's needed, plans and schedules each
// transition and talk break, and follows what you do with TIDAL's own controls.
import type { Analysis } from "./audio/analysis";
import { Mixer, type Clip, type Deck, type Loaded, type MashFit, type MashSide } from "./audio/mixer";
import { planNow, planTransition, type MashWay, type Mixing, type Move, type Plan } from "./audio/plan";
import { prepareSeparator, separate, separatorProgress, STEM_MARGIN, STEM_PIECE } from "./audio/stems";
import {
  anchorFromSegment,
  anchorFromTrack,
  continueSegment,
  ensureTracks,
  findTrack,
  initBrain,
  keyOf,
  lastSessionAt,
  markPlayed,
  markSession,
  mashupCandidates,
  nextSegment,
  request as brainRequest,
  sessionCount,
  tasteNotes,
  trackFacts,
  trackInfo,
  type Anchor,
  type Segment,
  type Track,
} from "./brain";
import { persona, settings } from "./config";
import { log, notify, warn } from "./log";
import { GENERIC, lineFor, mashupLine, type Context, type GenericKind, type Here, type Moment } from "./talk/script";
import { prepareStock, speak, stockLine, voiceState } from "./talk/voice";
import { TidalLink } from "./tidal";

// ------------------ STATUS (for the UI) ------------------
export type Status = {
  phase: "off" | "starting" | "playing" | "stopping";
  /** follow: transitions only (TIDAL's own queue, mixed); dj: the full DJ */
  mode?: "dj" | "follow";
  /** The DJ is speaking right now */
  talking: boolean;
  caption?: string;
  /** The set that's playing */
  segment?: string;
  /** Something the DJ is busy with ("Picking music") */
  busy?: string;
  /** A short message for the panel ("Couldn't find anything for that") */
  note?: string;
  /** The transition that's scheduled or under way (the cover art follows it) */
  transition?: CoverTransition;
};
/** Times are on the mixer's clock, in seconds (see mixerClock) */
export type CoverTransition = {
  seq: number;
  fromId: string;
  toId: string;
  kind: "blend" | "drop" | "fade" | "cut" | "mashup";
  /** A mashup: the two songs, to be shown together while it lasts, and when the incoming song starts taking over altogether */
  songs?: { a: string; b: string; artistA: string; artistB: string };
  mid?: number;
  start: number;
  /** The big moment: the bass changes hands (blend) or the new track lands (drop, cut) */
  swap: number;
  end: number;
  /** Seconds per beat, when the transition is on a beat */
  beat?: number;
};
let transitionSeq = 0;
/** How the outgoing track left at the last drop, so the next one leaves another way */
let lastMove: Move | undefined;
let status: Status = { phase: "off", talking: false };
const listeners = new Set<(s: Status) => void>();
export const getStatus = () => status;
export const onStatus = (fn: (s: Status) => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const setStatus = (patch: Partial<Status>) => {
  status = { ...status, ...patch };
  for (const fn of listeners) {
    try {
      fn(status);
    } catch {}
  }
};

// ------------------ TYPES ------------------
type Talk = {
  type: Moment["type"];
  text: string;
  clip: Promise<Clip | null>;
  ready?: Clip | null;
  /** A song's own introduction: the track it was written to follow */
  after?: string;
  /** Whether there is still a moment to say it at: a line that has none left by the time its turn comes isn't made */
  wanted?: () => boolean;
};
type Item = {
  track: Track;
  segment: Segment;
  /** First track of its set: the DJ talks before it */
  first: boolean;
  talk?: Talk;
  loading?: Promise<unknown>;
  ready?: Loaded;
  failed?: boolean;
};
type Playing = { item: Item; deck: Deck };
type Pending = Playing & { swap: number };
type Prep = { forId: string; fromId: string; plan?: Plan; stretchKey?: string; working?: boolean; /** The DJ introduces the incoming set over this transition */ voice?: boolean };

const TICK_MS = 200;
/** How far TIDAL's own position (and with it the lyrics) may be from the sound before it is put right, seconds */
const SYNC_SLACK = 0.11;
// A mashup the DJ picks itself has to be this good (see mashQuality); one that is this good ends the search
const MASH_OK = 0.4;
const MASH_GREAT = 0.75;
/**
 * How good a mashup of two tracks would be, from what was measured (see mashMatch in mixer.page.js).
 * Everything is taken relative to how well the two tracks' own bass and notes agree, which is what a
 * perfect fit scores (about 1 then): how close the fit comes to that, and how far it stands out from the
 * same two tracks in the wrong keys. Something is added for drum patterns that sit on each other, and
 * taken off when the key isn't among the best three of the twelve. (A voice sits on a band in its key far
 * more easily than one band's bass sits under another's chords, so the bar is no higher than it has to be:
 * what the voice really needs, that there is singing in the stretch, is checked once it has been taken out.)
 */
/** About how many seconds it is from asking for a mashup to its start: finding the song, and the first pieces through the vocal separator */
const MASH_LEAD = 30;
/**
 * How long the vocal separator takes over one piece (see STEM_PIECE), seconds: the average of the last
 * thirty or so, as measured (2.5 s before a mashup starts and 3.3 s while it plays, on the machine this
 * was written on: the average is what the planning needs, the last one would have it wait too long)
 */
let pieceSeconds = 3.2;
let piecesTimed = 4;
/** ...and how much longer than that each piece is allowed to take, when working out how soon a mashup can start */
const PIECE_SLACK = 1.1;
const mashQuality = (f: MashFit) => {
  const own = f.self.filter((v) => v > 0.05);
  const scale = own.length ? own.reduce((x, y) => x + y, 0) / own.length : 0.25;
  return 0.5 * (f.fit / scale) + 0.5 * ((f.fit - f.median) / scale) + 0.1 * Math.max(0, f.rhythm) - (f.beaten < 9 ? 0.2 : 0);
};
const describeFit = (f: MashFit) =>
  f.ok
    ? `notes fit ${f.fit.toFixed(2)} (halves ${f.halves.map((v) => v.toFixed(2)).join("/")}; other keys' middle ${f.median.toFixed(2)}, beats ${f.beaten} of 11; own ${f.self.map((v) => v.toFixed(2)).join("/")}), drums ${f.rhythm.toFixed(2)}, ${f.tempo.map((v) => v.toFixed(2)).join(" vs ")} BPM, tuned ${f.tuning.join(" vs ")} cents (clarity ${f.clarity.join("/")}), ${f.semitones} semitones, joins ${(f.joins * 100).toFixed(1)}%, off ${f.off.toFixed(0)} cents, drum lags ${f.lags.join("/") || "none"} ms${f.shift ? `, moved ${f.shift} beat(s)` : ""}, took ${f.ms?.join(" + ") ?? "?"} ms`
    : `no (${f.why}): ${f.tempo?.map((v) => v.toFixed(2)).join(" vs ")} BPM, tuned ${f.tuning?.join(" vs ")} cents`;
/** The "set" every track belongs to in transitions-only mode */
const FOLLOW_SEGMENT: Segment = { kind: "more", key: "queue", title: "Transitions only", tracks: [], facts: {} };
const ARM_LEAD = 5;

const context = (link: TidalLink, here?: Here): Context => ({
  name: link.firstName(),
  tone: persona().tone,
  less: settings.commentary === "less" || settings.commentary === "off",
  dj: persona().name,
  here: { ...here, taste: tasteNotes() },
});
/** The DJ introduces sets (and says why it picked them) */
const talksSets = () => settings.commentary === "full" || settings.commentary === "every";
/** ...and every song on its own as well, like a radio presenter */
const everySong = () => settings.commentary === "every";

/** The line for a moment (a set's introduction gets what is known about its first song to talk about) */
const lineOf = (m: Moment, link: TidalLink, here?: Here) => {
  if ("segment" in m && !m.facts && m.segment.tracks[0]) m.facts = trackFacts(m.segment.tracks[0]);
  return lineFor(m, context(link, here));
};
const makeTalk = (m: Moment, link: TidalLink, urgent: boolean, here?: Here): Talk => {
  const text = lineOf(m, link, here);
  const talk: Talk = { type: m.type, text, clip: speak(text, urgent, () => talk.wanted?.() ?? true) };
  talk.clip.then((c) => (talk.ready = c)).catch(() => (talk.ready = null));
  return talk;
};

// ------------------ SESSION ------------------
class Session {
  readonly mixer = new Mixer();
  private readonly link: TidalLink;
  private timer?: ReturnType<typeof setInterval>;
  private planned: Segment[] = []; // every set so far, including queued ones
  private items: Item[] = []; // upcoming, next first
  private known = new Map<string, Item>(); // every track of this session
  private current?: Playing;
  private pending?: Pending;
  private prep?: Prep;
  /** Start the next item as soon as it has loaded (optionally around a line being spoken) */
  private awaiting?: { voiceStart?: number; voiceEnd?: number };
  /** The song left on, low, under a line the DJ says between two songs (see talkBetween), and what takes it away */
  private bed?: Deck;
  private leaving?: ReturnType<typeof setTimeout>;
  /** After the DJ button or a request: mix the next track in on the next bar line rather than at the current track's end */
  private immediate = false;
  private immediateTries = 0;
  /** A set's introduction that wasn't ready when its transition was scheduled: spoken as soon as it is, while the transition lasts */
  private lateVoice?: { item: Item; until: number };
  private alt?: { segment: Segment; talk?: Talk; building?: boolean };
  /** The sound the DJ stays with until asked for something else */
  private anchor?: Anchor;
  private fetching = false;
  private opening = true;
  /** For the DJ to talk about: when this session began, how many songs it has played, and how things stood when it began */
  private readonly began = Date.now();
  private songs = 0;
  private readonly before = { sessions: sessionCount(), sinceLast: lastSessionAt() ? Date.now() - lastSessionAt() : undefined };
  private here(next?: Item): Here {
    const place = next ? { index: next.segment.tracks.indexOf(next.track), of: next.segment.tracks.length } : undefined;
    return { ...this.before, minutes: (Date.now() - this.began) / 60e3, songs: this.songs, place: place && place.index >= 0 ? place : undefined };
  }
  private greeted = false;
  private stopped = false;
  private lastTid?: string;
  private nextSeekAt = 0;
  private seekCheckAt = 0;
  private seekLead = 0.15;
  private offCount = 0;
  private justMoved = false;
  private pausedAt = 0;
  private talkUntil = 0;
  private captionTimer?: ReturnType<typeof setTimeout>;
  private starvedSince = 0;
  /** When a switch/request started: further ones wait until its first track is playing */
  private cutting = 0;
  /** A mashup is being put together */
  private mashing = false;
  /** This session was started by asking for a mashup */
  forMashup = false;
  /** Until when (on the mixer's clock) a mashup is playing out: nothing else is started over it */
  private mashUntil = 0;
  /** A mashup's voices are being taken out (see mashup): nothing else that is heavy on the processor is started meanwhile */
  private piecing = false;
  private failures = 0;

  // Everything that touches the mixer runs one at a time, in order: the loop, and whatever you do meanwhile
  /** Transitions only: what to play is TIDAL's business (its queue, whatever you put on); this only mixes it */
  readonly follow: boolean;
  private picking = false;
  private queueBusy = false;
  /** Tracks that couldn't be picked up just now: not tried again until the time given */
  private avoid = new Map<string, number>();

  private chain: Promise<unknown> = Promise.resolve();
  private run<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
    const job = this.chain.then(() => (this.stopped ? undefined : fn()));
    this.chain = job.catch((err) => warn("DJ error", err));
    return job as Promise<T | undefined>;
  }

  constructor(follow = false) {
    this.follow = follow;
    this.link = new TidalLink({
      seek: (t) => void this.run(() => this.onSeek(t)),
      playing: (p) => this.onPlaying(p),
      volume: (v, muted) => void this.mixer.setVolume(v, muted).catch(() => {}),
      device: () => {},
    });
  }

  /** Ends this session, whether or not it is (still) the current one */
  private endSelf(reason: string) {
    if (session === this) void stopSession(reason, true);
    else void this.stop(reason, { quick: true });
  }

  // ------------------ START ------------------
  async start() {
    if (this.follow) {
      // Nothing to pick and nothing to say: the mixer is opened and waits for TIDAL to play something
      setStatus({ phase: "playing", mode: "follow", busy: undefined, note: undefined, caption: undefined, segment: FOLLOW_SEGMENT.title });
      await this.mixer.open();
      const v = this.link.volumeState();
      await this.mixer.setVolume(v.percent, v.muted);
      await initBrain();
      if (this.stopped) return;
      this.timer = setInterval(() => this.tick(), TICK_MS);
      log("Transitions only: mixing whatever TIDAL plays");
      return;
    }
    setStatus({ phase: "starting", mode: "dj", busy: "Getting ready", note: undefined, caption: undefined, segment: undefined });
    await this.mixer.open();
    const vol = this.link.volumeState();
    await this.mixer.setVolume(vol.percent, vol.muted);

    const voice = await voiceState();
    const talkative = settings.commentary !== "off" && voice.usable;
    if (talkative && !voice.cloud && !voice.online && !voice.downloaded) notify("DJ: setting up the voice (one-time download, about 330 MB). The voice joins in a few minutes");
    // (Started for a mashup: the voice's stock lines are made once that is under way, not while it is
    // being put together, which the same processor has to do)
    if (talkative && !this.forMashup) prepareStock();
    await initBrain();
    if (this.stopped) return;

    // A song is playing: the DJ picks it up exactly where it is and carries on from there
    const playingId = this.link.playing ? this.link.currentTrackId() : undefined;
    if (!playingId) log("Nothing is playing: opening with a set of the DJ's own");
    if (playingId && (await this.takeOver(playingId))) return;
    if (this.stopped) return;

    // Nothing playing: open with a set of what you've been into lately
    setStatus({ busy: "Picking music" });
    const segment = await nextSegment([]);
    if (this.stopped) return;
    this.link.takeOver(true);
    this.anchor = anchorFromSegment(segment);
    this.greeted = true;
    this.queueSegment(segment, false);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.ensureLoading(this.items[0]);
    let said: { text: string; clip: Clip } | null = null;
    if (talkative) {
      const m: Moment = { type: "open", segment, firstEver: sessionCount() === 0, sameDay: Date.now() - lastSessionAt() < 8 * 3600e3 };
      const text = lineOf(m, this.link, this.before);
      // Only worth waiting for when it's quick (an online voice); otherwise a stock hello
      const clip = voice.quick ? await Promise.race([speak(text, true), new Promise<null>((r) => setTimeout(() => r(null), 6000))]) : null;
      said = clip ? { text, clip } : await stockLine("hello");
    }
    if (this.stopped) return;
    markSession();
    await this.run(async () => {
      if (said) {
        const t = await this.mixer.talk(said.clip, {});
        this.say(said.text, t.voiceStart, t.voiceEnd);
        this.awaiting = { voiceStart: t.voiceStart, voiceEnd: t.voiceEnd };
      } else this.awaiting = {};
    });
    setStatus({ busy: "Loading the first track" });
    log(`Session started with "${segment.title}"${said ? `, opening line: "${said.text}"` : ""}`);
  }

  /** Picks up the song TIDAL is playing, at the position it's at. TIDAL's own sound stays on until the mixer has it */
  private async takeOver(id: string) {
    if (!this.follow) setStatus({ busy: "Picking up this song" });
    try {
      await ensureTracks([id]);
      const track = trackInfo(id);
      if (!track) {
        log(`Couldn't read details of the playing song (${id})`);
        return false;
      }
      // (Not worth picking up a song for its last few seconds)
      if (this.follow && track.duration - this.link.position() < 8) return false;
      const loaded = await this.mixer.load(id, settings.quality, track.bpm, this.link.normalizes, true);
      if (this.stopped) return true;
      const engaged = await this.run(async () => {
        // Still the same song, still playing?
        if (this.link.currentTrackId() !== id || !this.link.playing) {
          log(this.follow ? "The song changed or was paused while it was loading" : "The song changed or was paused while the DJ was getting ready, starting fresh");
          await this.mixer.unload(id);
          return false;
        }
        const segment: Segment = this.follow ? FOLLOW_SEGMENT : { kind: "more", key: "now", title: "Now playing", tracks: [track], facts: {} };
        const item: Item = { track, segment, first: false, ready: loaded };
        const deck = this.mixer.createDeck(loaded);
        await this.mixer.startAlone(deck, Math.min(this.link.position() + 0.12, loaded.duration - 1), undefined, 0.1);
        this.link.takeOver(!this.follow);
        this.current = { item, deck };
        this.known.set(id, item);
        if (!this.follow) this.planned.push(segment);
        this.opening = false;
        this.lastTid = id;
        this.nextSeekAt = Date.now() + 4000;
        return true;
      });
      if (!engaged) return engaged === undefined;
      if (this.follow) {
        setStatus({ phase: "playing", mode: "follow", busy: undefined, segment: FOLLOW_SEGMENT.title });
        log(`Transitions only: picked up ${track.artists[0]?.name} - ${track.title}`);
        return true;
      }
      markSession();
      markPlayed(id);
      this.anchor = await anchorFromTrack(id);
      setStatus({ phase: "playing", busy: undefined, segment: this.anchor.label ? `Staying with ${this.anchor.label}` : "Now playing" });
      this.timer ??= setInterval(() => this.tick(), TICK_MS);
      log(`Session started on the playing song: ${track.artists[0]?.name} - ${track.title}, staying with "${this.anchor.label || "this sound"}"`);
      setTimeout(() => this.prepareAlt(), 4000);
      return true;
    } catch (err) {
      warn("Couldn't pick up the playing song", err);
      return false;
    }
  }

  // ------------------ TRANSITIONS ONLY ------------------
  /** Takes over the song TIDAL is playing (it keeps sounding from TIDAL's own player until the mixer has it) */
  private async pickUp(id: string) {
    this.picking = true;
    try {
      if (!(await this.takeOver(id))) this.avoid.set(id, Date.now() + 5000);
    } finally {
      this.picking = false;
    }
  }

  /**
   * Hands the sound straight back to TIDAL's own player and waits. Used when TIDAL goes somewhere the
   * mixer has nothing ready for (you put another track on, the queue ran out): TIDAL plays on at once,
   * and the mixer picks the song up again a moment later, where it is.
   */
  private async letGo(why: string) {
    log(`Transitions only: ${why}; TIDAL plays on, to be picked up again`);
    setStatus({ transition: undefined });
    this.pending = undefined;
    this.prep = undefined;
    this.awaiting = undefined;
    this.current = undefined;
    this.opening = true;
    this.offCount = 0;
    this.link.release();
    await this.mixer.killAll(0.05);
    this.discard(this.items);
    this.items = [];
  }

  /** The next tracks in TIDAL's queue after the one the mixer is on */
  private async followQueue() {
    if (this.queueBusy || !this.current || this.opening) return;
    const wanted = () => {
      if (this.link.repeatsOne) return [] as string[];
      const list = this.link.queueFromCurrent();
      const at = list.indexOf(this.current?.item.track.id ?? "");
      // (TIDAL somewhere else entirely is sorted out by reconcile, not here)
      if (at < 0) return undefined;
      const ids = list.slice(at + 1, at + 3);
      const blocked = ids.findIndex((id) => Date.now() < (this.avoid.get(id) ?? 0));
      return blocked < 0 ? ids : ids.slice(0, blocked);
    };
    const same = (ids: string[]) => ids.length === this.items.length && ids.every((id, i) => this.items[i].track.id === id);
    const want = wanted();
    if (!want || same(want)) return;
    this.queueBusy = true;
    try {
      await ensureTracks(want);
      if (this.stopped || !this.current) return;
      const now = wanted();
      if (!now || now.join() !== want.join()) return;
      const next: Item[] = [];
      for (const id of want) {
        const track = trackInfo(id);
        // (A video or something unavailable: the mix stops before it and TIDAL plays it itself)
        if (!track) break;
        next.push(this.items.find((i) => i.track.id === id) ?? { track, segment: FOLLOW_SEGMENT, first: false });
      }
      // A track already being mixed in stays, whatever the queue says now
      if (this.pending && !next.includes(this.pending.item)) return;
      const dropped = this.items.filter((i) => !next.includes(i));
      this.items = next;
      for (const item of next) this.known.set(item.track.id, item);
      this.discard(dropped);
      if (this.prep && this.prep.forId !== next[0]?.track.id) this.prep = undefined;
    } catch (err) {
      warn("Couldn't read TIDAL's queue", err);
    } finally {
      this.queueBusy = false;
    }
  }

  // ------------------ QUEUE ------------------
  /** `talk` is `item`'s: wanted for as long as the item is still to come, is coming in, or is waited for after its transition began */
  private give(item: Item, talk: Talk) {
    item.talk = talk;
    talk.wanted = () => !this.stopped && item.talk === talk && (this.items.includes(item) || this.pending?.item === item || this.lateVoice?.item === item);
  }

  private queueSegment(segment: Segment, withTalk: boolean, talk?: Talk) {
    const prev = this.planned[this.planned.length - 1];
    this.planned.push(segment);
    segment.tracks.forEach((track, i) => {
      const item: Item = { track, segment, first: i === 0 };
      if (i === 0) {
        if (talk) item.talk = talk;
        else if (!this.greeted && settings.commentary !== "off") {
          // The DJ's hello comes with the first set it brings in
          item.talk = makeTalk({ type: "open", segment, firstEver: sessionCount() <= 1, sameDay: false }, this.link, true, this.before);
        } else if (withTalk) item.talk = makeTalk({ type: "segment", segment, prev }, this.link, true, this.here());
        if (item.talk) this.give(item, item.talk);
      }
      this.items.push(item);
      this.known.set(track.id, item);
    });
    this.syncQueue();
  }

  private syncQueue() {
    // (Transitions only: TIDAL's queue is yours, never written to)
    if (this.opening || this.stopped || this.follow) return;
    const ids = this.items.map((i) => i.track.id);
    // After a skip TIDAL is already on the next item
    if (ids[0] === this.link.currentId()) ids.shift();
    this.link.setUpcoming(ids).catch((err) => warn("Couldn't update TIDAL's queue", err));
  }

  // Loading is strictly one track at a time, and only for tracks still wanted. The audio itself lives in
  // the mixer's process; anything dropped from the queue is unloaded there at once
  private loadChain: Promise<unknown> = Promise.resolve();
  private wanted(item: Item) {
    return !this.stopped && this.items.includes(item);
  }
  private inUse(id: string) {
    if (this.current?.item.track.id === id || this.pending?.item.track.id === id) return true;
    for (const d of this.mixer.decks) if (d.id === id) return true;
    return this.items.some((i) => i.track.id === id && (i.ready || i.loading));
  }
  private discard(items: Item[]) {
    for (const item of items) {
      const had = !!item.ready;
      item.ready = undefined;
      if (had && !this.inUse(item.track.id)) this.mixer.unload(item.track.id);
    }
  }

  private ensureLoading(item: Item) {
    if (item.loading || item.failed || item.ready) return;
    const job = this.loadChain.then(async () => {
      if (!this.wanted(item)) return;
      try {
        const loaded = await this.mixer.load(item.track.id, settings.quality, item.track.bpm, this.link.normalizes);
        if (!this.wanted(item)) {
          if (!this.inUse(item.track.id)) this.mixer.unload(item.track.id);
          return;
        }
        item.ready = loaded;
        this.failures = 0;
      } catch (err) {
        if (!this.wanted(item)) return;
        warn(`Couldn't load ${item.track.artists[0]?.name} - ${item.track.title}`, err);
        item.failed = true;
        // Several in a row isn't about one track: stop rather than keep trying
        if (++this.failures >= 3) {
          if (!this.follow) notify("DJ stopped: tracks couldn't be loaded");
          this.endSelf("tracks couldn't be loaded");
        }
      }
    });
    this.loadChain = job.catch(() => {});
    item.loading = job.finally(() => (item.loading = undefined));
  }

  private async fillQueue() {
    if (this.fetching || this.stopped) return;
    this.fetching = true;
    try {
      // More of the sound the DJ is staying with; a themed set only when there's nothing to stay with
      let segment: Segment | undefined;
      if (this.anchor) segment = await continueSegment(this.anchor, this.planned).catch((err) => (warn("Couldn't continue this sound", err), undefined));
      segment ??= await nextSegment(this.planned);
      if (this.stopped) return;
      this.anchor ??= anchorFromSegment(segment);
      this.queueSegment(segment, talksSets());
    } catch (err) {
      warn("Couldn't pick the next set", err);
    } finally {
      this.fetching = false;
    }
  }

  /** A different set kept ready, so the DJ button answers instantly */
  private async prepareAlt() {
    // (Not while a mashup is being put together: picking a set and voicing its introduction would slow that down)
    if (this.alt || this.stopped || this.mashing) return;
    const alt: NonNullable<Session["alt"]> = { segment: null!, building: true };
    this.alt = alt;
    try {
      const playing = this.current?.item.segment ?? this.planned[this.planned.length - 1];
      const segment = await nextSegment(this.planned, playing?.kind);
      alt.segment = segment;
      alt.building = false;
      if (settings.commentary !== "off") {
        const talk = makeTalk({ type: "switch", segment }, this.link, false);
        talk.wanted = () => !this.stopped && this.alt === alt;
        alt.talk = talk;
      }
    } catch {
      if (this.alt === alt) this.alt = undefined;
    }
  }

  // ------------------ SPEECH ------------------
  private say(text: string, start: number, end: number) {
    this.talkUntil = end;
    this.greeted = true;
    clearTimeout(this.captionTimer);
    const show = () => setStatus({ talking: true, caption: text });
    const wait = (start - this.mixer.now) * 1000;
    if (wait > 30) this.captionTimer = setTimeout(show, wait);
    else show();
  }

  // ------------------ THE LOOP ------------------
  private ticking = false;
  private tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    this.run(() => this.step()).finally(() => (this.ticking = false));
  }

  private async step() {
    await this.mixer.status().catch(() => {});
    if (this.mixer.gone) {
      // Whatever happened to it, the sound goes straight back to TIDAL's own player: never silence
      this.link.release();
      if (!this.follow) notify("DJ stopped: its mixer closed unexpectedly");
      this.endSelf("mixer gone");
      return;
    }
    const now = this.mixer.now;
    this.link.observe();
    if (status.talking && now > this.talkUntil + 0.2) setStatus({ talking: false, caption: undefined });

    // Decks that have finished
    for (const d of [...this.mixer.decks]) {
      if (d === this.current?.deck || d === this.pending?.deck) continue;
      if (d.stopAt < now - 0.4 || (d.started && d.endTime < now - 0.4)) {
        this.mixer.dispose(d);
        if (!this.inUse(d.id)) this.mixer.unload(d.id);
      }
    }

    // Tracks that couldn't be loaded leave the queue
    if (this.items.some((i) => i.failed)) {
      const dropped = this.items.filter((i) => i.failed);
      this.items = this.items.filter((i) => !i.failed);
      // (Transitions only: TIDAL plays that one itself; not tried again for a while)
      if (this.follow) for (const d of dropped) this.avoid.set(d.track.id, Date.now() + 20000);
      // The set's talk moves to its next track
      for (const d of dropped) {
        if (!d.first) continue;
        const heir = this.items.find((i) => i.segment === d.segment);
        if (heir) {
          heir.first = true;
          heir.talk = d.talk;
          if (d.talk) this.give(heir, d.talk);
        }
      }
      this.prep = undefined;
      this.syncQueue();
    }

    // The incoming track has taken over
    if (this.pending && now >= this.pending.swap) this.swap();

    // An introduction that wasn't ready when its transition was scheduled
    if (this.lateVoice) {
      const { item, until } = this.lateVoice;
      const involved = this.pending?.item === item || this.current?.item === item;
      if (now > until || !involved || !item.talk || item.talk.ready === null) this.lateVoice = undefined;
      else if (item.talk.ready) {
        this.lateVoice = undefined;
        await this.voiceOver(item, now + 0.1, until);
      }
    }

    if (this.follow) {
      // Whatever TIDAL is playing gets picked up; what comes next is read from its queue
      if (!this.current && !this.awaiting && !this.picking) {
        const id = this.link.playing ? this.link.currentTrackId() : undefined;
        if (id && Date.now() > (this.avoid.get(id) ?? 0)) void this.pickUp(id);
      }
      void this.followQueue();
    } else if (this.items.length < 2 && !this.mashing) this.fillQueue();
    const next = this.items[0];
    if (next) this.ensureLoading(next);

    // Waiting to start the next track (session start, DJ button, a skip, or the previous track ran out)
    if (this.awaiting && !this.pending && next?.ready) {
      const { voiceStart, voiceEnd } = this.awaiting;
      this.awaiting = undefined;
      this.starvedSince = 0;
      const deck = this.mixer.createDeck(next.ready);
      const a = next.ready.analysis;
      const pos = a.firstSound;
      const start =
        voiceEnd !== undefined && voiceStart !== undefined && now < voiceEnd ? await this.mixer.bringIn(deck, pos, Math.max(0, a.introEnd - pos), voiceStart, voiceEnd) : await this.mixer.startAlone(deck, pos);
      this.pending = { item: next, deck, swap: start };
      // Whatever was still playing underneath makes way as the new track arrives
      const old = this.current?.deck;
      if (old && (old.stopAt === Infinity || old === this.bed)) this.leaveAt(old, start, 0.9);
      this.bed = undefined;
      setStatus({ busy: undefined });
    }

    const cur = this.current;
    if (cur && !this.pending && !this.awaiting) {
      const pos = cur.deck.positionAt(now);
      const a = cur.deck.analysis;
      // Introducing every song: the line for the next one is written once it's certain what it follows
      // (the first song of a set has the set's introduction, which names it; a mashup needs no words)
      if (!this.piecing && !this.follow && everySong() && next && next.segment.key !== "mashup" && !(next.first && next.talk && !next.talk.after) && next.talk?.after !== cur.item.track.id) {
        const talk = makeTalk({ type: "track", track: next.track, prev: cur.item.track, facts: trackFacts(next.track, cur.item.track), prevFacts: trackFacts(cur.item.track) }, this.link, false, this.here(next));
        talk.after = cur.item.track.id;
        this.give(next, talk);
        if (this.prep?.forId === next.track.id) this.prep.voice = !this.immediate;
      }
      // (A song picked up mid-play is analysed after it starts: no planning until that's in)
      // (...and none while a mashup's voices are still being taken out, which is a race against the playing:
      // the next transition's tempo shift and the DJ's line for it can wait the few seconds that takes)
      if (next?.ready && cur.deck.loaded.analysed && !(this.piecing && this.prep?.forId !== next.track.id)) this.prepare(cur, next, pos);
      const prep = this.prep;
      if (next?.ready && prep && prep.forId === next.track.id && prep.fromId === cur.item.track.id && !prep.working) await this.arm(cur, next, prep, pos);
      // The track ran out with nothing ready to follow it
      if (!this.pending && pos >= a.lastSound - 0.05) {
        if (this.follow) {
          // Nothing to mix into: TIDAL carries on by itself (the next track, autoplay, a repeat, or nothing)
          await this.letGo("the track ended with nothing mixed in after it");
          return;
        }
        this.awaiting = {};
        this.starvedSince ||= Date.now();
        if (Date.now() - this.starvedSince > 1500) setStatus({ busy: "Loading the next track" });
      }
    }

    await this.reconcile();
  }

  /** Works out how `cur` hands over to `next`, ahead of time */
  private prepare(cur: Playing, next: Item, pos: number) {
    if (this.prep && this.prep.forId === next.track.id && this.prep.fromId === cur.item.track.id) return;
    const prep: Prep = { forId: next.track.id, fromId: cur.item.track.id };
    this.prep = prep;
    // A new set is introduced by the DJ, over the transition into it (after the DJ button or a request
    // the DJ has already spoken)
    prep.voice = !this.immediate && !!next.talk && settings.commentary !== "off" && (next.talk.after ? everySong() && next.talk.after === cur.item.track.id : next.first);
    const a = cur.deck.analysis;
    const b = next.ready!.analysis;
    const keys = { keyA: keyOf(cur.item.track), keyB: keyOf(next.track) };
    const immediate = this.immediate;
    // (Right away still means on the beat: a few seconds ahead, so the tempo shift can be worked out first)
    const make = (mixing: Mixing, at: number) => (immediate ? planNow(a, b, { mixing, from: at + 2.5, avoid: lastMove, ...keys }) : planTransition(a, b, { mixing, earliest: at + 1, avoid: lastMove, ...keys }));
    const plan = make(settings.mixing, pos);
    prep.plan = plan;
    log(`Transition ${cur.item.track.title} → ${next.track.title}: ${plan.kind} at ${plan.aStart.toFixed(1)}s (${plan.note})${prep.voice ? ", with the DJ over it" : ""}`);
    if (plan.kind === "blend" && Math.abs((plan.speed ?? 1) - 1) > 2e-5) {
      prep.working = true;
      const sr = 44100;
      this.mixer
        .stretch(next.track.id, Math.round(plan.bStart * sr), plan.speed!, Math.round(plan.duration * sr), Math.round((plan.glide ?? 0) * sr))
        .then((key) => (prep.stretchKey = key))
        .catch((err) => {
          warn("Tempo matching failed, crossfading instead", err);
          prep.plan = make("crossfade", cur.deck.positionAt(this.mixer.now));
        })
        .finally(() => (prep.working = false));
    }
  }

  /** Schedules the prepared transition once it's a few seconds away */
  private async arm(cur: Playing, next: Item, prep: Prep, pos: number) {
    const now = this.mixer.now;
    const a = cur.deck.analysis;
    let plan = prep.plan;
    if (!plan) return;
    let t0 = cur.deck.timeAt(plan.aStart);
    if (t0 - now > ARM_LEAD) return;
    let stretchKey = prep.stretchKey;
    if (plan.kind === "mashup" && t0 < now + 0.3) {
      // Too late for it: the track simply comes next, mixed in the usual way
      log("Missed the start of the mashup");
      setStatus({ note: "Missed the moment for that mashup. Try again" });
      this.prep = undefined;
      return;
    }
    if (t0 < now + 0.15) {
      if (this.immediate && this.immediateTries < 2) {
        // Missed the bar line (the tempo shift took longer than expected): take the next one
        this.immediateTries++;
        this.prep = undefined;
        log("Missed the bar line, taking the next one");
        return;
      }
      // Missed the planned point (a late load or a seek past it): take the next best exit
      const mixing = settings.mixing === "none" ? "none" : "crossfade";
      plan = this.immediate ? planNow(a, next.ready!.analysis, { mixing, from: pos + 0.4 }) : planTransition(a, next.ready!.analysis, { mixing, earliest: pos + 0.4 });
      stretchKey = undefined;
      t0 = Math.max(now + 0.15, cur.deck.timeAt(plan.aStart));
      log(`Late for the planned transition: ${plan.kind} now`);
    }
    const deck = this.mixer.createDeck(next.ready!);
    try {
      const sched = await this.mixer.transition(cur.deck, deck, plan, t0, stretchKey);
      this.pending = { item: next, deck, swap: sched.swap };
      if (plan.kind === "mashup") {
        this.mashUntil = sched.end;
        setStatus({ segment: next.segment.title, busy: undefined, note: undefined });
        log(`Mashup scheduled: it starts ${((sched.first ?? t0) - now).toFixed(1)}s from now (${plan.note}${sched.levels ? `; the voice at ${(20 * Math.log10(sched.levels.voice)).toFixed(1)} dBFS over a band at ${(20 * Math.log10(sched.levels.band)).toFixed(1)}, brought up by ${(20 * Math.log10(sched.lift ?? 1)).toFixed(1)} dB` : ""})`);
      }
      if (plan.kind === "drop") lastMove = sched.move ?? plan.move;
      this.announce(cur, next, plan, t0, sched);
      if (plan.kind === "blend") log(`Blend scheduled: drums lined up by moving the incoming track ${sched.nudgeMs ?? 0} ms${sched.beatShift ? `, and ${sched.beatShift} beat(s) later so the patterns match` : ""}; bass hands over on beat ${sched.bassBeat ?? "?"}`);
      // (The mixer has to have it worked out before it starts: if it ever hasn't, that should be known)
      const ahead = t0 - this.mixer.now;
      if (ahead < 0.3) warn(`The transition was scheduled late: ${ahead.toFixed(1)}s before its start`);
    } catch (err) {
      if (plan.kind === "mashup") {
        // (The current track is still playing untouched: nothing to rescue, the mashup just doesn't happen)
        warn("Couldn't schedule the mashup", err);
        this.mixer.dispose(deck);
        this.prep = undefined;
        setStatus({ note: "That mashup didn't work out. Try again", busy: undefined });
        return;
      }
      // Never leave silence because of a scheduling error: cut straight over
      warn("Couldn't schedule the transition, cutting over", err);
      this.mixer.dispose(deck);
      await this.mixer.kill(cur.deck, 0.2);
      const plain = this.mixer.createDeck(next.ready!);
      this.pending = { item: next, deck: plain, swap: await this.mixer.startAlone(plain, next.ready!.analysis.firstSound, this.mixer.now + 0.2) };
    }
    const key = prep.stretchKey;
    // (The tempo-shifted lead-in is let go of once it has been played. A mashup's is in use for as long as
    // the mashup lasts: its voice is still being taken out of it, piece by piece, while it plays)
    if (key) setTimeout(() => this.mixer.dropStretch(key), Math.max(60, plan.kind === "mashup" ? plan.duration + 30 : 0) * 1000);
    if (prep.voice) {
      // Over a blend the DJ comes in just after the new track does; around a quick handover, a little
      // before the new track lands
      const blend = plan.kind === "blend" && plan.duration > 6;
      const land = t0 + plan.bAt;
      const at = blend ? t0 + Math.min(1.2, plan.duration * 0.1) : Math.max(now + 0.1, land - 3);
      await this.voiceOver(next, at, blend ? t0 + plan.duration * 0.5 : land + 2.5);
    }
  }

  /** Tells the UI what's about to happen to the sound, so the cover art can do the same */
  private announce(cur: Playing, next: Item, plan: Plan, t0: number, sched: { swap: number; end: number; bStart: number; bassBeat?: number; first?: number; mid?: number }) {
    const beat = plan.period;
    let start = t0;
    let swap = sched.swap;
    let end = t0 + plan.duration;
    let songs: CoverTransition["songs"];
    let mid: number | undefined;
    if (plan.kind === "mashup") {
      // From where the other song's voice comes in to where that song is on its own
      start = sched.first ?? t0;
      end = sched.end;
      songs = { a: cur.item.track.title, b: next.track.title, artistA: cur.item.track.artists[0]?.name ?? "", artistB: next.track.artists[0]?.name ?? "" };
      mid = sched.mid ?? sched.end - (plan.bars2 ?? 4) * 4 * (beat ?? 0.5);
    } else if (plan.kind === "blend") {
      // The bass handover is the moment, unless the incoming track never brings a bass in during the blend
      if (beat && sched.bassBeat !== undefined && sched.bassBeat < (plan.beats ?? 0) - 1) swap = t0 + sched.bassBeat * beat;
    } else if (plan.kind === "drop") {
      // The cover builds up while the outgoing track leaves (at least three beats of it), and lands with the new one
      swap = sched.bStart;
      start = Math.min(t0, swap - (beat ? 3 * beat : 1.5));
      end = swap + 1.6;
    } else if (plan.kind === "cut") {
      swap = sched.bStart;
      start = swap - 0.6;
      end = swap + 1.3;
    } else swap = t0 + plan.duration / 2;
    setStatus({ transition: { seq: ++transitionSeq, fromId: cur.item.track.id, toId: next.track.id, kind: plan.kind, songs, mid, start, swap, end, beat } });
  }

  /** The DJ introduces `item`'s set over the music at `at`. If the line is still being made, it's said as soon as it's ready, up to `until` */
  private async voiceOver(item: Item, at: number, until: number) {
    const talk = item.talk;
    if (!talk || settings.commentary === "off") return;
    if (talk.ready) {
      try {
        const t = await this.mixer.aside(talk.ready, at);
        this.say(talk.text, t.voiceStart, t.voiceEnd);
        log(`The DJ over the transition into "${item.segment.title}": "${talk.text}"`);
      } catch (err) {
        warn("Couldn't speak over the transition", err);
      }
    } else if (talk.ready === undefined) this.lateVoice = { item, until };
  }

  private swap() {
    const p = this.pending!;
    this.pending = undefined;
    const previous = this.current;
    this.cutting = 0;
    this.immediate = false;
    this.current = { item: p.item, deck: p.deck };
    const i = this.items.indexOf(p.item);
    if (i >= 0) this.discard(this.items.splice(0, i + 1).filter((x) => x !== p.item));
    this.prep = undefined;
    markPlayed(p.item.track.id);
    this.songs++;
    if (previous) previous.item.ready = undefined;
    setStatus({ phase: "playing", segment: p.item.segment.title, busy: undefined });
    log(`Now playing: ${p.item.track.artists[0]?.name} - ${p.item.track.title} [${p.item.segment.title}]`);
    if (this.opening) {
      this.opening = false;
      const ids = [p.item.track.id, ...this.items.map((x) => x.track.id)];
      this.link.startQueue(ids).catch((err) => warn("Couldn't set TIDAL's queue", err));
    }
    if (p.item.first && !this.alt) setTimeout(() => this.prepareAlt(), 4000);
  }

  // ------------------ TIDAL ↔ MIXER ------------------
  private async reconcile() {
    if (this.opening || !this.current) return;
    const now = this.mixer.now;
    const want = this.current.item.track.id;
    const tid = this.link.currentId();
    const changed = tid !== this.lastTid;
    this.lastTid = tid;
    if (tid === want) {
      // Keep TIDAL's position where the music you hear actually is: lyrics, the progress bar and
      // everything else in TIDAL follow it. A tenth of a second or so is the most it may be out.
      const heard = this.current.deck.positionAt(now) - this.mixer.latency;
      const dur = this.current.deck.loaded.duration;
      const off = this.link.position() - heard;
      // How far TIDAL landed from where the last correction aimed tells how long its seeks take
      if (this.seekCheckAt && Date.now() > this.seekCheckAt) {
        this.seekCheckAt = 0;
        if (Math.abs(off) < 1.5) this.seekLead = Math.max(0, Math.min(1.2, this.seekLead - off * 0.7));
      }
      this.offCount = Math.abs(off) > SYNC_SLACK ? this.offCount + 1 : 0;
      // Right after TIDAL has been moved to a new track it starts from zero while the mixer is already
      // well into it: line it up at once instead of waiting to be sure
      if (this.justMoved && Math.abs(off) > SYNC_SLACK) this.offCount = 3;
      this.justMoved = false;
      if (this.link.playing && this.offCount >= 3 && Date.now() > this.nextSeekAt && heard > 0.3 && heard < dur - 3) {
        this.offCount = 0;
        this.nextSeekAt = Date.now() + 2500;
        this.seekCheckAt = Date.now() + 1200;
        this.link.seek(heard + this.seekLead);
      }
      return;
    }
    if (this.link.selfMoved || !tid) return;
    // TIDAL is already on the track the mixer is moving to
    const target = this.pending?.item ?? (this.awaiting ? this.items[0] : undefined);
    if (target && tid === target.track.id) return;
    if (!changed) {
      // The mixer moved on and TIDAL hasn't followed yet
      if (!this.link.moveTo(want)) {
        if (this.follow) return this.letGo("TIDAL's queue changed during the mix");
        this.syncQueue();
      }
      this.nextSeekAt = Date.now() + 500;
      this.justMoved = true;
      return;
    }
    // TIDAL changed track on its own: either it reached the end a moment before the mixer did, or you did it
    const index = this.items.findIndex((i) => i.track.id === tid);
    const pos = this.current.deck.positionAt(now);
    if (index === 0 && pos > this.current.deck.analysis.lastSound - 6) return;
    if (this.follow) {
      // The next track, already loaded: straight to it. Anything else: TIDAL plays it and the mixer picks it up
      const item = index >= 0 ? this.items[index] : undefined;
      if (item?.ready) return this.jump(item);
      return this.letGo("you put something else on");
    }
    if (index >= 0) return this.jump(this.items[index]);
    const known = this.known.get(tid);
    if (known) {
      // Back to something played earlier
      const again: Item = { track: known.track, segment: known.segment, first: false };
      this.items.unshift(again);
      return this.jump(again);
    }
    // You put something else on: that ends the session
    this.endSelf("you played something else");
  }

  /** Cuts to an item right away (next/previous or a click in the queue) */
  private async jump(item: Item) {
    log(`Jumping to ${item.track.title}`);
    setStatus({ transition: undefined });
    await this.dropPending();
    const i = this.items.indexOf(item);
    if (i > 0) this.discard(this.items.splice(0, i));
    this.prep = undefined;
    this.immediate = false;
    this.lateVoice = undefined;
    this.talkUntil = 0;
    await this.mixer.stopVoice();
    this.ensureLoading(item);
    // Skipping into a new set still gets its introduction, when the line is ready
    const clip = (item.first || everySong()) && settings.commentary !== "off" ? item.talk?.ready : null;
    if (clip) await this.talkBetween(clip, item.talk!.text);
    else {
      clearTimeout(this.leaving);
      this.bed = undefined;
      if (this.current) await this.mixer.kill(this.current.deck, 0.12);
      this.awaiting = {};
    }
    if (!item.ready) setStatus({ busy: "Loading" });
    this.syncQueue();
  }

  /**
   * The DJ says `clip` between two songs. The song being left is not cut off for it (that was the words
   * over nothing at all, for as long as the line lasts): it stays on, low under the voice, and leaves as
   * the next song arrives, or after the line if that one is still loading.
   */
  private async talkBetween(clip: Clip, text: string) {
    clearTimeout(this.leaving);
    const sounding = (d: Deck) => !d.disposed && d.started && d.stopAt > this.mixer.now + 0.5;
    const t = await this.mixer.talk(clip, [...this.mixer.decks].some(sounding) ? { t0: await this.mixer.duckAll() } : {});
    this.say(text, t.voiceStart, t.voiceEnd);
    this.awaiting = { voiceStart: t.voiceStart, voiceEnd: t.voiceEnd };
    const old = this.current?.deck;
    this.bed = old && sounding(old) ? old : undefined;
    if (this.bed) this.leaveAt(this.bed, t.voiceEnd + 0.2, 1.5);
  }
  /** Has `deck` fade away at `at` (on the mixer's clock). One at a time: asked again, the earlier one is off */
  private leaveAt(deck: Deck, at: number, fade: number) {
    clearTimeout(this.leaving);
    this.leaving = setTimeout(() => {
      if (!deck.disposed && deck.stopAt > this.mixer.now) void this.mixer.kill(deck, fade);
    }, Math.max(0, at - this.mixer.now) * 1000);
  }

  private async dropPending() {
    const p = this.pending;
    this.pending = undefined;
    if (!p) return;
    setStatus({ transition: undefined });
    await this.mixer.kill(p.deck, 0.08);
    setTimeout(() => this.mixer.dispose(p.deck), 400);
  }

  private async onSeek(time: number) {
    const cur = this.current;
    if (!cur || this.opening || this.stopped) return;
    log(`Seek to ${time.toFixed(1)}s (the mixer was at ${cur.deck.positionAt(this.mixer.now).toFixed(1)}s of ${cur.item.track.title})`);
    // A seek belongs to the track TIDAL shows: anything being mixed in is dropped and planned again
    setStatus({ transition: undefined });
    await this.dropPending();
    this.prep = undefined;
    this.awaiting = undefined;
    const loaded = cur.deck.loaded;
    const old = cur.deck;
    await this.mixer.kill(old, 0.06);
    setTimeout(() => this.mixer.dispose(old), 300);
    const deck = this.mixer.createDeck(loaded);
    await this.mixer.startAlone(deck, Math.max(0, Math.min(time, loaded.duration - 0.5)), undefined, 0.03);
    this.current = { item: cur.item, deck };
    this.nextSeekAt = Date.now() + 3000;
  }

  private onPlaying(playing: boolean) {
    if (this.opening || this.stopped) return;
    if (playing) {
      this.pausedAt = 0;
      this.mixer.resume().catch(() => {});
      return;
    }
    // TIDAL briefly reports "not playing" around track changes: only a pause that lasts is a pause
    const at = (this.pausedAt = Date.now());
    setTimeout(() => {
      if (this.pausedAt === at && !this.link.playing && !this.stopped) this.mixer.suspend().catch(() => {});
    }, 180);
  }

  // ------------------ DJ BUTTON / REQUESTS ------------------
  private busyCutting() {
    return this.mashing || this.mixer.now < this.mashUntil || (!!this.cutting && Date.now() - this.cutting < 20000);
  }

  // ------------------ MASHUP ------------------
  private dropExtra(id: string) {
    if (!this.inUse(id)) void this.mixer.unload(id);
  }

  /**
   * The DJ says something while a mashup is on its way: one of its stock lines of a kind, or a line of
   * its own. Only a voice that is quick is asked for a line it hasn't made before (the local one would
   * take the processor from the vocal separator, which needs all of it). Never over a line that is
   * still being spoken, and with `by` (on the mixer's clock) only if it is over by then. Returns
   * when the line ends, if it was said.
   */
  private async mashSay(line: GenericKind | { text: string }, by?: number): Promise<number | undefined> {
    if (settings.commentary === "off" || this.stopped) return undefined;
    try {
      const voice = await voiceState();
      if (!voice.usable) return undefined;
      const within = <T>(job: Promise<T>, ms: number) => Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
      let said: { text: string; clip: Clip } | null = null;
      if (typeof line === "string") {
        said = await stockLine(line);
        if (!said && voice.quick) {
          const text = GENERIC[line][Math.floor(Math.random() * GENERIC[line].length)];
          const clip = await within(speak(text, true), 6000);
          if (clip) said = { text, clip };
        }
      } else if (voice.quick) {
        const clip = await within(speak(line.text, true), 9000);
        if (clip) said = { text: line.text, clip };
      }
      if (!said) return undefined;
      const { text, clip } = said;
      return await this.run(async () => {
        const now = this.mixer.now;
        if (now < this.talkUntil + 0.5) return undefined;
        // (the music takes a second to make way before the first word)
        if (by !== undefined && now + clip.duration + 1.4 > by) return undefined;
        // (a line that has to be over by a given moment goes without the DJ's jingle before it)
        const t = await this.mixer.aside(clip, undefined, by === undefined);
        this.say(text, t.voiceStart, t.voiceEnd);
        log(`The DJ, about the mashup: "${text}"`);
        return t.voiceEnd;
      });
    } catch (err) {
      warn("Couldn't speak about the mashup", err);
      return undefined;
    }
  }

  /**
   * A mashup of the song that's on with another, which becomes the next track. Without `query` the DJ
   * finds the song: same vibe, same tempo, same key, and of those the one whose notes actually fit this
   * one's bar by bar. With `query` it is the song you named, moved in tempo and pitch as far as it takes
   * to fit. It lasts for as long as the two songs have room for (see mashMatch in mixer.page.js), the
   * two trading places as it goes: who sings where decides what is heard (the other song's voice over
   * this one's band, this one's voice over the other's band, or, where nobody sings, one band on top of
   * the other; see MASHUPS in mixer.page.js). Voices are found and taken out by a neural network (see
   * audio/stems.js), a few seconds of sound at a time, at about the pace the music plays: this song's
   * from the moment a mashup is asked for, the other's once it is found, and the rest while it plays.
   * The DJ says what it is doing meanwhile.
   */
  async mashup(query?: string) {
    if (this.follow || this.stopped) return;
    if (this.busyCutting() || this.pending) return setStatus({ note: "One moment, still busy with the last thing" });
    this.mashing = true;
    setStatus({ busy: query ? "Finding that song" : "Looking for a song that goes with this one", note: undefined });
    let keep: string | undefined;
    // Candidates are loaded straight away, not in turn with the queue, and one ahead of the one being tried
    const loads = new Map<string, Promise<Loaded>>();
    const fetch = (c: Track) => {
      let job = loads.get(c.id);
      if (!job) {
        job = this.mixer.load(c.id, settings.quality, c.bpm, this.link.normalizes);
        job.catch(() => {});
        loads.set(c.id, job);
      }
      return job;
    };
    // The separator gets ready meanwhile (the first time, that is a download of about 40 MB)
    const engine = prepareSeparator();
    engine.catch(() => {});
    // What the DJ says about it: that it is on it, that it is still on it (while nothing has been said
    // for a while and there is nothing to announce yet), what it found, and that it starts
    const chatty = talksSets();
    let lastWord = Date.now();
    let waiting = true;
    let nags = 0;
    const say = (line: GenericKind | { text: string }, by?: number) => {
      lastWord = Date.now();
      return this.mashSay(line, by).then((end) => {
        if (end !== undefined) lastWord = Date.now() + Math.max(0, end - this.mixer.now) * 1000;
        return end;
      });
    };
    const nag = setInterval(() => {
      if (!waiting || !chatty || nags >= 2 || Date.now() - lastWord < 13000) return;
      nags++;
      void say("mashWait");
    }, 1000);
    /** Nothing came of it: the reason on the panel, and a word from the DJ */
    const sorry = (note: string) => {
      waiting = false;
      setStatus({ note });
      if (chatty && !this.stopped) void say("mashFail");
    };
    // This song's voice is taken out ahead, from the moment a mashup is asked for (see below)
    let ahead = true;
    const sets: string[] = [];
    try {
      // The song has to be playing from the mixer, measured, and past any transition of its own
      const since = Date.now();
      const settled = () => {
        const cur = this.current;
        if (!cur || this.pending || this.awaiting || !cur.deck.loaded.analysed) return false;
        const last = cur.deck.map[cur.deck.map.length - 1];
        return !!last && last.rate === 1 && last.t <= this.mixer.now;
      };
      while (!this.stopped && !settled() && Date.now() - since < 30000) await new Promise((r) => setTimeout(r, 250));
      const cur = this.current;
      if (this.stopped) return;
      if (!cur || !settled()) return void setStatus({ note: "Nothing to mash up yet: wait until a song is playing on its own" });
      const track = cur.item.track;
      const a = cur.deck.analysis;
      if (!a.steady || !a.grid) return void setStatus({ note: "This one has no steady beat to build a mashup on" });
      const sr = 44100;
      const beat = a.grid.period;
      const bar = 4 * beat;
      const pre = 4 * beat;
      const ease = 2 * beat;
      const side = (an: Analysis, from: number): MashSide => ({ period: an.grid!.period, bar0: an.bars[0] ?? an.firstBeat, phrase: an.phrasePhase, body: an.introEnd, from, last: an.lastSound });
      // (The other song is left with its own ending to play, not joined so late that it is nearly over)
      const other = (an: Analysis): MashSide => ({ ...side(an, 0), last: Math.min(an.lastSound, an.outroStart + 4 * an.grid!.period) });
      const here = () => cur.deck.positionAt(this.mixer.now);
      const still = () => !this.stopped && this.current === cur && !this.pending && !this.awaiting;
      // It takes sixteen bars at the least, and about half a minute to get going
      const enough = () => a.lastSound - here() > MASH_LEAD + 18 * bar;
      const tooLate = "Not enough of this song left for a mashup (it takes about half a minute to get going). Try it earlier in the next one";
      if (!enough()) return void setStatus({ note: tooLate });
      const movedOn = () => {
        waiting = false;
        if (!this.stopped) setStatus({ note: "The song moved on before the mashup was ready" });
      };
      if (chatty) void say("mashStart");

      // Voices are taken out a piece at a time (see MASHUPS in mixer.page.js): piece i of a song is
      // STEM_PIECE samples from `base` + i pieces on
      const tag = `m${Date.now().toString(36)}`;
      const pieceS = STEM_PIECE / sr;
      let jobs = 0;
      type Stems = { name: string; what: { id?: string; key?: string }; base: number; band: boolean; voice: Map<number, number[]>; level: Map<number, number[]>; making: Map<number, Promise<number[]>> };
      const make = async (s: Stems, i: number) => {
        const began = Date.now();
        const job = `${tag}j${jobs++}`;
        const start = s.base + i * STEM_PIECE;
        // (with what is around it, for the separator to hear: see STEM_MARGIN)
        const out = await this.mixer.stemOut(job, s.what, start - STEM_MARGIN, start + STEM_PIECE + STEM_MARGIN);
        await separate(job);
        const made = await this.mixer.stemIn(job, s.name, s.what, out.from, { skip: start - out.from, keep: STEM_PIECE, index: i, band: s.band });
        s.level.set(i, made.level);
        const took = (Date.now() - began) / 1000;
        piecesTimed = Math.min(30, piecesTimed + 1);
        pieceSeconds += (took - pieceSeconds) / piecesTimed;
        s.voice.set(i, made.voice);
        return made.voice;
      };
      /** Makes piece `i` of `s` (unless it is there already, or on its way). Returns how much of each second of it is voice */
      const pieceOf = (s: Stems, i: number) => {
        const had = s.voice.get(i);
        if (had) return Promise.resolve(had);
        let job = s.making.get(i);
        if (!job) {
          job = make(s, i).finally(() => s.making.delete(i));
          s.making.set(i, job);
        }
        return job;
      };
      // The separator does one piece at a time, in the order they are asked for. The pieces of this
      // song that are made ahead give way while others are being waited for
      let waitedFor = 0;
      const stems = (name: string, what: Stems["what"], base: number, band: boolean): Stems => {
        sets.push(name);
        return { name, what, base, band, voice: new Map(), level: new Map(), making: new Map() };
      };
      // This song's voice, from where the mashup could start at the soonest: the search for the other
      // song is mostly waiting (for TIDAL, for the download), and by the time it is found a good
      // half minute of this one is done. Only its voice is kept: its band is what is left of the song
      // when the voice is taken out of it as it plays (see the transition).
      const A = stems(`${tag}a`, { id: track.id }, Math.round((here() + 26) * sr), false);
      const lastA = Math.floor((a.lastSound * sr - A.base) / STEM_PIECE) - 1;
      this.piecing = true;
      void (async () => {
        await engine;
        for (let i = 0; ahead && i <= lastA && still(); ) {
          if (waitedFor) await new Promise((r) => setTimeout(r, 40));
          else await pieceOf(A, i++);
        }
      })().catch((err) => warn("Mashup: couldn't take this song's voice out ahead", err));
      /** This song's pieces for `bars` bars of mashup from `pos` of it */
      const rangeA = (pos: number, bars: number) => [Math.floor(((pos - ease - 0.25) * sr - A.base) / STEM_PIECE), Math.ceil(((pos + bars * bar + 0.3) * sr - A.base) / STEM_PIECE)] as const;

      // A stretch counts as sung when the voice is 0.15 of the sound or more in four of every ten seconds.
      // (That is low for a lead vocal, which is usually over half: but of a processed voice, chopped or
      // through a vocoder, the separator only gets part, and such a song is still one with a singer.
      // What comes out faint is brought up where it is used: see the voice's level in the mixer.)
      const SUNG = 0.15;
      const sung = (voice: number[]) => voice.filter((v) => v >= SUNG).length / Math.max(1, voice.length) >= 0.4;
      const tenths = (voice: number[]) => voice.map((v) => Math.min(9, Math.round(v * 10))).join("");

      let candidates: Track[];
      if (query) {
        const found = await findTrack(query, track.id);
        if (!found) return void sorry(`Couldn't find "${query.trim()}"`);
        candidates = [found];
      } else {
        const keys = [keyOf(track), a.key.conf > 0.02 ? { tonic: a.key.tonic, mode: a.key.mode } : undefined].filter((k): k is NonNullable<typeof k> => !!k);
        candidates = (await mashupCandidates(track, a.grid.bpm, keys)).slice(0, 7);
        if (!candidates.length) return void sorry("Found nothing at this tempo and in this key that fits the vibe");
      }

      // Each candidate is measured against the song on the audio itself. The ones that really fit are
      // kept, best first.
      type Pick = { track: Track; loaded: Loaded; quality: number };
      let picks: Pick[] = [];
      let why: MashFit["why"];
      const searching = Date.now();
      for (const [i, c] of candidates.entries()) {
        if (!still()) return movedOn();
        if (!enough()) break;
        // (A good one ends the search once it has taken a while: every second spent looking is a
        // second less of the song for the mashup)
        if (picks[0] && Date.now() - searching > 4500) break;
        setStatus({ busy: `Trying it with ${c.title}` });
        let loaded: Loaded;
        try {
          const job = fetch(c);
          if (candidates[i + 1]) void fetch(candidates[i + 1]);
          loaded = await job;
        } catch (err) {
          warn(`Mashup: couldn't load ${c.title}`, err);
          continue;
        }
        if (!still()) return movedOn();
        const b = loaded.analysis;
        if (!b.steady || !b.grid) {
          log(`Mashup: ${c.title} has no steady beat`);
          why ??= "tempo";
          this.dropExtra(c.id);
          continue;
        }
        // (How well the two go together is judged on the stretch they would actually play together)
        const fit = await this.mixer.mashMatch(track.id, c.id, side(a, here() + MASH_LEAD), other(b), !!query);
        const quality = fit.ok ? mashQuality(fit) : -1;
        log(`Mashup: ${track.title} × ${c.title}: ${describeFit(fit)}${fit.ok ? `, quality ${quality.toFixed(2)}` : ""}`);
        if (!fit.ok) why ??= fit.why;
        // (A song you named is taken as it comes; one the DJ picks has to clear the bar)
        if (fit.ok && (query || quality >= MASH_OK)) {
          picks.push({ track: c, loaded, quality });
          picks.sort((x, y) => y.quality - x.quality);
          for (const dropped of picks.splice(3)) this.dropExtra(dropped.track.id);
        } else this.dropExtra(c.id);
        if (picks[0] && (picks[0].quality >= MASH_GREAT - 0.005 || Date.now() - searching > 4500)) break;
      }
      if (!still()) return movedOn();
      if (picks.length) {
        setStatus({ busy: "Getting the vocal separator ready" });
        const poll = setInterval(async () => {
          const p = await separatorProgress().catch(() => undefined);
          if (p?.downloading !== undefined && !this.stopped) setStatus({ busy: `Getting the vocal separator (one-time download, ${p.downloading}%)` });
        }, 700);
        try {
          const started = await engine;
          log(`Vocal separator ready (${started.threads} threads, ${started.ms} ms)`);
        } catch (err) {
          warn("The vocal separator couldn't be started", err);
          return void sorry("Couldn't get the vocal separator going, so no mashup for now");
        } finally {
          clearInterval(poll);
        }
      }

      // The pieces a mashup still needs, in the order they are heard (`at`: seconds after its start,
      // which is `pre` before the two meet), and how long it can be kept supplied with them: each has
      // to be in place READY seconds before it is heard, made one after the other from now on. With
      // two voices to take out the work is about as fast as the playing, so a long mashup lives off
      // the start it has: this song's pieces made so far, and the wait until the phrase it starts on.
      // (Should the work fall behind after all, the mixer ends the mashup early: see `wrapUp` there.)
      //
      // A song that isn't singing has no voice that needs taking out: where only the other one sings,
      // this song's pieces are made when there is time to spare (`spare`: should it start singing
      // further on, that is how it is found out), and the work is twice as fast as the playing.
      const READY = 6;
      type Need = { s: Stems; i: number; at: number; spare?: boolean };
      const needsFor = (aPos: number, bars: number, way: MashWay, singsA: boolean, B?: Stems): Need[] => {
        const need: Need[] = [];
        const countB = Math.ceil(((pre + bars * bar + 1) * sr) / STEM_PIECE);
        if (way === "voice") for (let i = 0; i < countB; i++) if (!B?.voice.has(i)) need.push({ s: B ?? A, i, at: Math.max(i * pieceS, pre - ease) });
        if (way !== "layer") {
          const [i0, i1] = rangeA(aPos, bars);
          for (let i = i0; i < i1; i++) if (!A.voice.has(i)) need.push({ s: A, i, at: Math.max((A.base + i * STEM_PIECE) / sr - (aPos - pre), pre - ease), spare: !singsA });
        }
        return need.sort((x, y) => x.at - y.at);
      };
      /** Of `bars` bars, how many the pieces will be there for, if it starts `lead` seconds from now (`busy`: seconds until the work on them can start) */
      const affordable = (need: Need[], lead: number, bars: number, busy = 0) => {
        const step = pieceSeconds * PIECE_SLACK;
        const must = need.filter((n) => !n.spare);
        for (const [j, n] of must.entries()) if (busy + (j + 1) * step + READY > lead + n.at) return Math.max(0, Math.floor((n.at - pre) / bar / 8) * 8);
        return bars;
      };
      /** Whether this song sings, going by what has been taken out of it so far (it is taken to, until enough is known) */
      const seemsToSing = () => {
        const known = [...A.voice.values()].flat();
        return known.length < 10 || sung(known);
      };
      const reach = (pos: number) => cur.deck.timeAt(pos - pre) - this.mixer.now;

      // The best of the songs that fit is the one (the next best, if it turns out there is no room for
      // it). One the DJ picked itself should have a singer in one of the two: if this song has none
      // and the other doesn't either, the next best is tried, and only when none of them sings is it
      // the best one after all, the two bands on top of each other.
      const tries = [...picks.map((pick) => ({ pick, plain: !!query || picks.length === 1 })), ...(query || picks.length < 2 ? [] : [{ pick: picks[0], plain: true }])];
      for (const { pick, plain } of tries) {
        if (!still()) return movedOn();
        if (!enough()) break;
        const partner = pick.track;
        const b = pick.loaded.analysis;
        setStatus({ busy: `Putting it together with ${partner.title}` });
        // Where: as soon as what has to be there by then can be. That is the other song at this one's
        // tempo and two pieces of its voice, to hear whether it sings (some seven seconds), and then
        // enough of a start on the rest for two minutes of mashup, or for all that is left of this
        // song if that is less: of the next phrases, the first one from which that works out.
        const busy = 4 + 2 * pieceSeconds * PIECE_SLACK;
        let lead = busy + 2;
        for (let k = 0; k < 6; k++, lead += 4 * bar) {
          const from = here() + lead + pre;
          const room = Math.min(128, Math.floor(((a.lastSound - from) / bar - 1) / 8) * 8);
          if (room < 16 || affordable(needsFor(from, room, "voice", seemsToSing()), lead, room, 4) >= Math.min(room, 64)) break;
        }
        const fit = await this.mixer.mashMatch(track.id, partner.id, { ...side(a, here() + lead + pre), starts: 2 }, other(b), !!query, true);
        if (!fit.ok) {
          why = fit.why;
          continue;
        }
        const whole = fit.bars1 + fit.bars2;
        const hold = pre + whole * bar;
        const x0 = Math.round((fit.bPos - pre * fit.speed) * sr);
        const moved = Math.abs(fit.speed - 1) > 2e-5 || Math.abs(fit.pitch - 1) > 2e-5;
        let stretchKey: string | undefined;
        if (moved) {
          // (A track moved in pitch finds its way back to its own slowly, so it isn't heard doing so)
          const glide = fit.semitones || Math.abs(fit.joins) > 0.01 ? 28 : 16;
          stretchKey = await this.mixer.stretch(partner.id, x0, fit.speed, Math.round(hold * sr), Math.round(glide * sr), fit.pitch);
        }
        if (!still()) return movedOn();
        // The other song from where it starts (unheard, a bar early) to just past where this one has
        // gone: at this song's tempo already, so its voice comes out ready to be sung over it
        const B = stems(`${tag}b${tries.findIndex((t) => t.pick === pick && t.plain === plain)}`, stretchKey ? { key: stretchKey } : { id: partner.id }, stretchKey ? 0 : x0, true);
        const allB = Math.ceil(((hold + 1) * sr) / STEM_PIECE);

        // Who sings where the two meet decides how it starts, and what has to be taken out at all.
        // The other song: its first two pieces, and if nobody sings in those, one from further on
        // (they are pieces the mashup needs anyway, if it sings)
        setStatus({ busy: `Listening for a singer in ${partner.title}` });
        const heardB: number[] = [];
        const loudB: number[] = [];
        const heardA: number[] = [];
        // (nothing is made ahead meanwhile: these are waited for)
        waitedFor++;
        try {
          for (const i of new Set([0, Math.min(1, allB - 1), Math.max(1, Math.min(allB - 1, Math.floor(allB * 0.4)))])) {
            if (i > 1 && sung(heardB)) break;
            const voice = await pieceOf(B, i);
            const from = i === 0 ? Math.floor(pre) : 0;
            heardB.push(...voice.slice(from));
            loudB.push(...(B.level.get(i) ?? []).slice(from));
            if (!still()) return movedOn();
          }
          // ...and this one: what has been taken out of it so far, of the stretch the two share
          const [i0, i1] = rangeA(fit.aPos, whole);
          const known = [...A.voice.keys()].filter((i) => i >= i0 && i < i1).sort((x, y) => x - y);
          for (const i of known.length >= 2 ? known : [i0, i0 + 1]) heardA.push(...(await pieceOf(A, i)));
        } catch (err) {
          warn("Couldn't listen for a singer", err);
        } finally {
          waitedFor--;
        }
        if (!still()) return movedOn();
        const singsB = sung(heardB);
        // (how loud the voice is where it sings: the middle one of those seconds)
        const sungB = loudB.filter((_, k) => heardB[k] >= SUNG).sort((x, y) => x - y);
        const voiceLevel = sungB.length ? sungB[sungB.length >> 1] : 0;
        const singsA = sung(heardA);
        const way: MashWay = singsB ? "voice" : singsA ? "carry" : "layer";
        log(`Mashup: ${partner.title} ${singsB ? "sings" : "doesn't sing"} there (voice in each second sampled, in tenths: ${tenths(heardB)}), ${track.title} ${singsA ? "does" : "doesn't"} (${tenths(heardA)})`);
        const leave = () => {
          void this.mixer.stemDrop(B.name);
          if (stretchKey) void this.mixer.dropStretch(stretchKey);
        };
        if (way !== "voice") void this.mixer.stemDrop(B.name);
        if (way === "layer" && !plain) {
          leave();
          continue;
        }

        // When it starts, and how long it is: on the phrase it was fitted to if the pieces can keep up
        // with all of it from there; if not, on whichever of the next ones makes for the longest
        // (each is four bars less of this song, and seven seconds more of a start)
        let best: { pos: number; bars: number; need: Need[] } | undefined;
        for (let k = 0; k < 4; k++) {
          const pos = fit.aPos + k * 4 * bar;
          const room = Math.floor((whole - 4 * k) / 8) * 8;
          if (room < 16) break;
          if (reach(pos) < 1.5) continue;
          const bars = Math.min(room, affordable(needsFor(pos, room, way, singsA, B), reach(pos), room));
          if (bars >= 16 && (!best || bars > best.bars)) best = { pos, bars, need: needsFor(pos, bars, way, singsA, B) };
          if (bars >= room) break;
        }
        if (!best) {
          leave();
          return void sorry(tooLate);
        }
        const { pos: aPos, bars: total, need } = best;
        const [i0, i1] = rangeA(aPos, total);
        const countB = Math.ceil(((pre + total * bar + 1) * sr) / STEM_PIECE);
        // (the last of it is its way out: the last sixteen bars of a long one, eight of a short one)
        const outBars = total >= 48 ? 16 : 8;

        const moves = `${fit.semitones ? `, ${fit.semitones > 0 ? "+" : ""}${fit.semitones} semitone${Math.abs(fit.semitones) > 1 ? "s" : ""}` : ""}, tempo ${((fit.speed - 1) * 100).toFixed(2)}%`;
        const how =
          (way === "voice"
            ? `${total} bars in which the two trade places, eight bars at a time by who is singing: one song's voice over the other's band`
            : way === "carry"
              ? `${total} bars of ${track.title}'s voice over ${partner.title}'s band where it sings, the two bands together where it doesn't (${partner.title} has no singer there)`
              : `no singer in either: ${total - outBars} bars of ${partner.title} on top of ${track.title}'s bass, then ${outBars} the other way round`) + moves;
        const plan: Plan = {
          kind: "mashup",
          aStart: aPos - pre,
          duration: pre + total * bar,
          bStart: x0 / sr,
          bAt: 0,
          swapAt: pre,
          beats: total * 4,
          period: beat,
          speed: fit.speed,
          way,
          sings: { a: singsA, b: singsB },
          voiceLevel,
          pre,
          bars1: total - outBars,
          bars2: outBars,
          stemsA: A.name,
          stemsB: B.name,
          stems: { seg: STEM_PIECE, a: { base: A.base, from: i0, to: i1 }, b: { base: B.base, from: 0, to: countB } },
          note: how,
        };
        const set = await this.run(() => {
          if (!still() || cur.deck.timeAt(plan.aStart) < this.mixer.now + 0.6) return false;
          const segment: Segment = { kind: "more", key: "mashup", title: `Mashup: ${track.title} × ${partner.title}`, tracks: [partner], facts: {} };
          const item: Item = { track: partner, segment, first: false, ready: pick.loaded };
          // It goes in front of whatever was coming, and counts as the set after the one playing
          this.items = [item, ...this.items.filter((i) => i.track.id !== partner.id)];
          this.known.set(partner.id, item);
          const at = this.planned.indexOf(cur.item.segment);
          this.planned.splice(at >= 0 ? at + 1 : this.planned.length, 0, segment);
          this.prep = { forId: partner.id, fromId: track.id, plan, stretchKey };
          this.immediate = false;
          this.lateVoice = undefined;
          this.syncQueue();
          return true;
        });
        if (!set) {
          leave();
          return void (still() && sorry("Missed the moment for that mashup. Try again"));
        }
        keep = partner.id;
        waiting = false;
        // (from here on this song's pieces are made in the order the mashup needs them, with the other's)
        ahead = false;
        const heardAt = cur.deck.timeAt(aPos) - ease;
        const wait = Math.max(0, heardAt - this.mixer.now);
        let over = cur.deck.timeAt(plan.aStart) + plan.duration;
        setStatus({ busy: `Mashup with ${partner.title} in ${Math.round(wait)}s` });
        log(`Mashup set: ${track.title} × ${partner.artists[0]?.name} - ${partner.title} in ${wait.toFixed(1)}s, ${((Date.now() - since) / 1000).toFixed(0)}s after it was asked for (${how}; ${whole} bars had room; ${need.filter((n) => !n.spare).length} pieces still to make at ${pieceSeconds.toFixed(1)}s each, ${A.voice.size} of ${track.title} made ahead; ${describeFit(fit)})`);
        setTimeout(() => !this.stopped && this.prep?.plan === plan && setStatus({ busy: `Mashup with ${partner.title} coming up` }), Math.max(0, wait - 5) * 1000);
        // The DJ says what it found, and, if there is still a while to go after that, that it starts
        if (settings.commentary !== "off") {
          void (async () => {
            const end = await say({ text: mashupLine(track, partner, wait, persona().tone) }, heardAt - 0.4);
            if (!chatty && end !== undefined) return;
            // (so that it ends as the mashup begins: its two seconds, and the second the music takes to make way)
            const at = heardAt - 3.6;
            if (at < Math.max(this.mixer.now, end ?? 0) + 1.5) return;
            await new Promise((r) => setTimeout(r, (at - this.mixer.now) * 1000));
            if (!this.stopped && this.prep?.plan === plan) void say("mashHere", heardAt + 0.6);
          })();
        }

        // The rest of the pieces, in the order they are heard, while the song plays on and into the
        // mashup itself (for as long as it is still on its way or playing)
        let gone = 0;
        const wanted = () => {
          if (this.stopped || this.mixer.now > over) return false;
          const on = this.prep?.plan === plan || this.pending?.item.track.id === partner.id || this.current?.item.track.id === partner.id;
          if (on) gone = 0;
          else gone ||= Date.now();
          return on || Date.now() - gone < 4000;
        };
        /** Whether the mixer has had to end it early (the pieces fell behind): then that is when it is over */
        let cut = 0;
        const cutShort = async () => {
          if (cut) return true;
          cut = (await this.mixer.feedState().catch(() => undefined))?.cut ?? 0;
          if (!cut) return false;
          over = cut;
          this.mashUntil = Math.min(this.mashUntil, cut);
          log(`Mashup: ended ${Math.max(0, cut - this.mixer.now).toFixed(0)}s from now, before its time: the voices weren't being made fast enough (${pieceSeconds.toFixed(1)}s a piece)`);
          // (the two songs are shown together until then, no longer)
          setTimeout(() => !this.stopped && getStatus().transition?.kind === "mashup" && getStatus().transition?.toId === partner.id && setStatus({ transition: undefined }), Math.max(0, cut - this.mixer.now) * 1000);
          return true;
        };
        // (a piece that is only wished for is made while the next one that is needed can wait for it,
        // and not at all once its moment has passed)
        let made = 0;
        const t0 = cur.deck.timeAt(plan.aStart);
        const must = need.filter((n) => !n.spare);
        const wished = need.filter((n) => n.spare);
        while (must.length || wished.length) {
          if (!wanted() || (await cutShort())) break;
          const step = pieceSeconds * PIECE_SLACK;
          const now = this.mixer.now;
          while (wished.length && t0 + wished[0].at < now + step + 1) wished.shift();
          const room = must.length ? t0 + must[0].at - READY - now - step : Infinity;
          const n = wished.length && room > step ? wished.shift() : must.shift();
          if (!n) continue;
          try {
            await pieceOf(n.s, n.i);
            made++;
          } catch (err) {
            warn("Mashup: a piece of the voice couldn't be made", err);
            break;
          }
        }
        this.piecing = false;
        const arrived = await this.mixer.feedState().catch(() => undefined);
        const counts = arrived?.feeds.map((f) => `${f.name === A.name ? track.title : partner.title}: ${f.played} of ${f.wanted} in place, ${f.late} late, ${f.missed} done without, the closest ${f.spare ?? "?"}s ahead of being heard`).join("; ");
        log(`Mashup: ${made} of ${need.length} pieces made after it was set (${need.filter((n) => n.spare).length} of them only if there was time), ${pieceSeconds.toFixed(1)}s a piece${counts ? ` (${counts})` : ""}`);
        // (how it went is known once it is over: its blocks are decided as they come up)
        while (!this.stopped && this.mixer.now < over && wanted()) {
          await new Promise((r) => setTimeout(r, 1000));
          await cutShort();
        }
        const went = (await this.mixer.feedState().catch(() => undefined))?.arrangement;
        if (went?.length) log(`Mashup as it went (A: ${track.title}, B: ${partner.title}): ${went.join("; ")}; then B on its own`);
        return;
      }
      if (!still()) return movedOn();

      // Nothing came of it: say why
      const name = candidates[0].title;
      sorry(
        why === "ending" || !enough()
          ? tooLate
          : !query
            ? "Nothing fits this one cleanly enough for a mashup. Try another song, or name one"
            : why === "tempo"
              ? `${name} is too far from this one in tempo to mash up`
              : why === "room"
                ? `No stretch of ${name} is long enough to go with what is left of this song`
                : why === "tuning"
                  ? `${name} can't be brought in tune with this one`
                  : `${name} couldn't be mashed up with this one`,
      );
    } catch (err) {
      warn("Mashup failed", err);
      sorry("That mashup didn't work out. Try again in a moment");
    } finally {
      clearInterval(nag);
      ahead = false;
      this.mashing = false;
      this.piecing = false;
      // Everything that was loaded for it and isn't the one goes again (also what was still on its way),
      // and so do the voices taken out for a mashup that didn't come about (one that did has the mixer
      // let go of them as they are played)
      for (const [id, job] of loads) void job.then(() => id !== keep && this.dropExtra(id)).catch(() => {});
      if (!keep) for (const name of sets) void this.mixer.stemDrop(name);
      if (!this.stopped && !this.alt) setTimeout(() => this.prepareAlt(), 6000);
      if (!this.stopped && this.forMashup) {
        this.forMashup = false;
        if (settings.commentary !== "off") void voiceState().then((v) => v.usable && !this.stopped && prepareStock());
      }
      if (!this.stopped && !this.prep?.plan?.pre) setStatus({ busy: undefined });
    }
  }

  /** Replaces what's coming with `segment`, has the DJ introduce it over the current track, and stays with its sound */
  private async cutTo(segment: Segment, talk: Talk | undefined, stock: "switch" | "request", alreadyAnswered = false) {
    if (this.follow) return;
    this.cutting = Date.now();
    let clip: Clip | null = null;
    let text = "";
    if (settings.commentary !== "off" && !(alreadyAnswered && !talk?.ready)) {
      // The line written for this set if it's ready, else a stock one, so there's never a wait
      clip = talk?.ready ?? null;
      text = talk?.text ?? "";
      if (!clip) {
        const s = await stockLine(stock);
        if (s) {
          clip = s.clip;
          text = s.text;
        }
      }
    }
    await this.run(async () => {
      await this.dropPending();
      this.prep = undefined;
      this.alt = undefined;
      this.discard(this.items);
      this.items = [];
      // Sets that were queued but never played don't count as history
      const playing = this.current?.item.segment;
      const at = playing ? this.planned.indexOf(playing) : -1;
      if (at >= 0) this.planned.length = at + 1;
      this.anchor = anchorFromSegment(segment);
      this.greeted = true;
      this.queueSegment(segment, false);
      this.ensureLoading(this.items[0]);
      this.lateVoice = undefined;
      const cur = this.current;
      if (cur && cur.deck.stopAt === Infinity && !this.awaiting) {
        // The current track keeps playing with the DJ speaking over it, and the new one is mixed in on
        // the beat as soon as it has loaded: a real transition, not a fade to a bed
        this.immediate = true;
        this.immediateTries = 0;
        if (clip) {
          const t = await this.mixer.aside(clip);
          this.say(text, t.voiceStart, t.voiceEnd);
        } else await this.mixer.stopVoice(0.08);
      } else if (clip) {
        // Nothing playing to mix out of (a track was already on its way out): the voice over what is left
        // of it, then the new track
        await this.talkBetween(clip, text);
      } else {
        await this.mixer.stopVoice(0.08);
        this.awaiting = {};
      }
      setStatus({ note: undefined, segment: segment.title });
      log(`Cut to "${segment.title}"${clip ? `: "${text}"` : ""}`);
    });
  }

  /** The DJ button: something different, now */
  async switchUp() {
    if (this.follow || this.stopped || this.opening || this.busyCutting()) return;
    this.cutting = Date.now();
    setStatus({ busy: "Switching it up" });
    try {
      let alt = this.alt;
      if (!alt || alt.building) {
        const playing = this.current?.item.segment;
        alt = { segment: await nextSegment(this.planned, playing?.kind) };
      }
      await this.cutTo(alt.segment, alt.talk, "switch");
    } catch (err) {
      this.cutting = 0;
      warn("Couldn't switch it up", err);
      setStatus({ note: "Couldn't find something different right now" });
    } finally {
      if (!this.stopped) setStatus({ busy: this.immediate ? "Mixing it in" : undefined });
    }
  }

  /** A typed request */
  async ask(text: string) {
    if (this.follow || this.stopped || this.opening) return;
    if (/^switch it up$/i.test(text.trim())) return this.switchUp();
    if (this.busyCutting()) return setStatus({ note: "One moment, still getting the last thing ready" });
    setStatus({ busy: "Finding that", note: undefined });
    try {
      const result = await brainRequest(text, this.current?.item.track, (stage) => !this.stopped && setStatus({ busy: stage }));
      if (this.stopped) return;
      if (!result) return setStatus({ note: `Couldn't find anything for "${text.trim()}". Try an artist, a genre or a mood` });
      if ("command" in result) {
        if (result.command === "stop") return void stopSession("you asked");
        if (result.command === "skip") return void this.skip();
        settings.commentary = result.command === "quiet" ? "less" : "full";
        return setStatus({ note: result.command === "quiet" ? "Okay, less talking" : "Okay, I'll talk more" });
      }
      // The DJ's answer is made for this request (what TIDAL's AI came back with, and what plays first).
      // It takes a few seconds to generate; if the voice can't manage it in time the music just starts
      let talk: Talk | undefined;
      if (settings.commentary !== "off" && (await voiceState()).usable) {
        setStatus({ busy: "Preparing what to say" });
        talk = makeTalk({ type: "request", segment: result }, this.link, true);
        await Promise.race([talk.clip, new Promise((r) => setTimeout(r, 25000))]);
      }
      if (this.stopped) return;
      setStatus({ busy: "Starting it" });
      await this.cutTo(result, talk, "request", true);
    } catch (err) {
      this.cutting = 0;
      warn("Request failed", err);
      setStatus({ note: "That didn't work. Try again in a moment" });
    } finally {
      if (!this.stopped) setStatus({ busy: this.immediate ? "Mixing it in" : undefined });
    }
  }

  skip() {
    return this.run(async () => {
      if (this.follow) return;
      const next = this.items[0];
      if (next) await this.jump(next);
    });
  }

  voiceLevel() {
    return this.mixer.voice;
  }

  // ------------------ STOP ------------------
  async stop(reason: string, opts: { quick?: boolean } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.captionTimer);
    clearTimeout(this.leaving);
    log(`Session ended (${reason})`);
    setStatus({ phase: "stopping", busy: undefined, transition: undefined });
    const mixer = this.mixer;
    try {
      if (!mixer.gone) {
        if (!opts.quick && !this.follow && settings.commentary !== "off" && mixer.running) {
          // A word of goodbye over the music, then the music carries on in TIDAL itself
          const bye = await stockLine("signoff").catch(() => null);
          if (bye) {
            const t = await mixer.talk(bye.clip, { t0: await mixer.duckAll() });
            setStatus({ talking: true, caption: bye.text });
            await new Promise((r) => setTimeout(r, Math.max(0, t.voiceEnd - mixer.now) * 1000 + 100));
          }
        }
        // Hand over to TIDAL's own player, which has been playing the same track silently all along.
        // Line it up with the mixer first so the music carries on from the same spot
        if (this.current && !this.opening && this.link.currentId() === this.current.item.track.id && this.link.playing) {
          await mixer.status().catch(() => {});
          const pos = this.current.deck.positionAt(mixer.now);
          if (pos < this.current.deck.loaded.duration - 3 && Math.abs(this.link.position() - pos) > 0.35) {
            this.link.seek(pos + 0.4);
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        const fade = opts.quick ? 0.08 : 0.35;
        await mixer.killAll(fade);
        await new Promise((r) => setTimeout(r, fade * 600));
      }
    } catch (err) {
      warn("Stopping wasn't clean", err);
    }
    this.link.release();
    this.link.restoreModes();
    // Closing the mixer's process hands back every byte of audio it held, and makes sure nothing can
    // keep sounding under TIDAL's own player
    await mixer.close();
    // (Unless another session has taken over meanwhile: then the status is its to set)
    if (!session || session === this) setStatus({ phase: "off", mode: undefined, talking: false, caption: undefined, segment: undefined, busy: undefined });
  }
}

// ------------------ ONE SESSION AT A TIME ------------------
let session: Session | undefined;
let starting = false;
/** A session on its way out (its goodbye, the hand-back to TIDAL, closing its mixer): nothing starts until that's done */
let stopping: Promise<unknown> | undefined;
let unloaded = false;
export const markUnloaded = () => (unloaded = true);

export const isActive = () => !!session || starting;

/** Starts the full DJ, or (mode "follow") transitions only. The DJ takes the place of a transitions-only session */
export const startSession = async (mode: "dj" | "follow" = "dj", forMashup = false) => {
  while (stopping) await stopping;
  if (starting || unloaded) return;
  if (session) {
    if (!(session.follow && mode === "dj")) return;
    const old = session;
    session = undefined;
    starting = true;
    await old.stop("making way for the DJ", { quick: true }).catch(() => {});
    starting = false;
    if (unloaded) return;
  }
  starting = true;
  const s = new Session(mode === "follow");
  s.forMashup = forMashup;
  session = s;
  try {
    await s.start();
  } catch (err) {
    warn(mode === "follow" ? "Couldn't start transitions only" : "Couldn't start the DJ", err);
    if (mode === "dj") notify(`DJ couldn't start: ${(err as Error)?.message ?? err}`);
    await s.stop("failed to start", { quick: true });
    if (session === s) session = undefined;
  } finally {
    starting = false;
  }
};

export const stopSession = async (reason = "stopped", quick = false) => {
  const s = session;
  if (!s) return;
  session = undefined;
  const job = s.stop(reason, { quick }).catch((err) => warn("Stopping failed", err));
  const mine: Promise<unknown> = (stopping = job.finally(() => {
    if (stopping === mine) stopping = undefined;
  }));
  await mine;
  // With transitions only switched on, that's what's left when the DJ stops
  if (!s.follow) {
    followRetryAt = 0;
    setTimeout(applyTransitionOnly, 400);
  }
};

/**
 * Makes what's running match the "transitions only" setting: on, and nothing running, starts it; off,
 * and it's running, stops it. Called when the plugin loads (so it comes back after a restart), when the
 * setting changes, and every few seconds.
 */
let followRetryAt = 0;
export const applyTransitionOnly = () => {
  if (unloaded || starting || stopping) return;
  if (!settings.transitionOnly) {
    if (session?.follow) void stopSession("transitions only switched off", true);
    return;
  }
  if (session || Date.now() < followRetryAt) return;
  // (Not in a loop, should it keep failing)
  followRetryAt = Date.now() + 20000;
  void startSession("follow");
};
export const setTransitionOnly = (on: boolean) => {
  settings.transitionOnly = on;
  followRetryAt = 0;
  applyTransitionOnly();
};

/** Mashes the playing song up with another: one you name, or one the DJ finds. Starts the DJ if it isn't on */
export const mashup = async (query?: string) => {
  if (!session || session.follow) await startSession("dj", true);
  await session?.mashup(query?.trim() || undefined);
};
export const switchUp = () => session?.switchUp();
export const ask = (text: string) => session?.ask(text);
export const skip = () => session?.skip();
/** 0-1, how loud the DJ's voice is right now */
export const voiceLevel = () => session?.voiceLevel() ?? 0;
/** The mixer's clock at what is being heard right now, seconds (it stands still while paused) */
export const mixerClock = () => (session ? session.mixer.now - session.mixer.latency : 0);

