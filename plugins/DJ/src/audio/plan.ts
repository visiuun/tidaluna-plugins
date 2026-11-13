// Decides how one track hands over to the next, the way a DJ would: where to leave the outgoing track,
// where to bring the incoming one in, and which kind of transition the two tracks allow.
import type { Analysis, Grid } from "./analysis";

export type PlanKind = "blend" | "drop" | "fade" | "cut" | "mashup";
/** How the outgoing track leaves before a drop: filtered up and away, or braked like a record */
export type MashWay = "voice" | "carry" | "layer";
export type Move = "sweep" | "brake";
export type Plan = {
  kind: PlanKind;
  /** Position in the outgoing track (s) where the transition starts */
  aStart: number;
  /** Seconds from the start until the outgoing track is silent */
  duration: number;
  /** Position in the incoming track that starts playing */
  bStart: number;
  /** Seconds after the start when the incoming track starts (0 for blends and fades; the bar line for drops) */
  bAt: number;
  /** Seconds after the start when the incoming track counts as "now playing" */
  swapAt: number;
  // Beatmatched blends
  beats?: number;
  period?: number; // seconds per beat of the outgoing track
  speed?: number; // incoming track's tempo change during the overlap (input seconds per output second)
  glide?: number; // seconds over which the incoming track returns to its own tempo
  bassSwap?: number; // seconds after the start when the bass changes hands
  /** swap: bass handover in the middle. filter: also thins the outgoing track from the start (two dense songs) */
  style?: "swap" | "filter";
  fadeIn?: number; // seconds over which the incoming track comes up
  fadeOutFrom?: number; // seconds after the start when the outgoing track starts to leave
  // Drops
  move?: Move;
  // Mashups (see mixer.page.js). What one is depends on who sings (`way`):
  //   voice: from `pre` seconds after the start the incoming track's voice sings over the outgoing track's
  //          band for `bars1` bars; over the next `bars2` the incoming track's band takes over
  //   carry: only the outgoing track sings. The bands change over first (`bars2`), and its voice carries
  //          on over the incoming track's band for `bars1` bars
  //   layer: nobody sings. The incoming track plays over the outgoing one's bass for `bars1` bars, then
  //          the bass changes hands and the outgoing one leaves over `bars2`
  way?: MashWay;
  /** For a mashup: whether each song was heard singing where they meet, before it was set (a: the playing one, b: the other) */
  sings?: { a?: boolean; b?: boolean };
  pre?: number;
  bars1?: number;
  bars2?: number;
  /** How loud the incoming track's voice is where it sings (RMS, as in the file): a faint one is brought up */
  voiceLevel?: number;
  /** The two tracks' separated parts, by the names the mixer keeps them under */
  stemsA?: string;
  stemsB?: string;
  /** ...which come in pieces of `seg` samples: piece i of a track is from its sample base + i * seg, and pieces from..to are the ones the mashup plays */
  stems?: { seg: number; a?: { base: number; from: number; to: number }; b?: { base: number; from: number; to: number } };
  note: string;
};

export type Mixing = "auto" | "crossfade" | "none";
export type Key = { tonic: number; mode: "major" | "minor" } | undefined;

const MATCH_LIMIT = 0.08;
const usable = (g: Grid | null | undefined): g is Grid => !!g && g.resid < 0.03 && g.inlierShare > 0.5 && g.contrast > 1.25 && g.count >= 12;
const snap = (g: Grid, t: number) => g.phase + Math.round((t - g.phase) / g.period) * g.period;

/** Camelot wheel position: neighbours (and relative major/minor) mix harmonically */
const camelot = (k: NonNullable<Key>) => {
  // Number: fifths from C major (8B) / A minor (8A)
  const n = k.mode === "major" ? ((k.tonic * 7) % 12) + 8 : (((k.tonic + 3) * 7) % 12) + 8;
  return { n: ((n - 1) % 12) + 1, major: k.mode === "major" };
};
export const keysClash = (a: Key, b: Key) => {
  if (!a || !b) return false;
  const ca = camelot(a);
  const cb = camelot(b);
  const d = Math.min((ca.n - cb.n + 12) % 12, (cb.n - ca.n + 12) % 12);
  if (ca.major === cb.major) return d > 1;
  return d > 0;
};

/** Bar line at or before t (bars from the analysis; extended on the grid outside them) */
const barAtOrBefore = (a: Analysis, g: Grid, t: number) => {
  let best: number | undefined;
  for (const b of a.bars) {
    if (b <= t + 0.02) best = b;
    else break;
  }
  if (best === undefined) {
    const first = a.bars[0] ?? a.firstBeat;
    const barLen = 4 * g.period;
    best = first - Math.ceil((first - t) / barLen - 1e-6) * barLen;
  }
  return snap(g, best);
};

/** The line where a four-bar phrase starts, at or before t: where arrangements change, and where a DJ comes in */
const phraseAtOrBefore = (a: Analysis, g: Grid, t: number) => {
  let best: number | undefined;
  a.bars.forEach((bar, i) => {
    if (bar <= t + 0.02 && ((i - a.phrasePhase) % 4 + 4) % 4 === 0) best = bar;
  });
  const plain = barAtOrBefore(a, g, t);
  // Only when a phrase line is close by: otherwise the nearest bar line keeps the blend its intended length
  return best !== undefined && plain - best <= 8 * g.period + 0.05 ? snap(g, best) : plain;
};

/** Where the incoming track is brought in: the bar line where its sound starts */
const mixInPoint = (b: Analysis, g: Grid) => {
  const barLen = 4 * g.period;
  let t = snap(g, b.firstBeat);
  // Sound that starts before the first full bar (a pickup): take the bar before, if the track has it
  if (b.firstSound < t - 0.15) {
    if (t - barLen >= -0.01) t -= barLen;
    else while (t - g.period >= Math.max(0, b.firstSound - g.period)) t -= g.period;
  }
  return Math.max(0, t);
};

type Options = {
  mixing: Mixing;
  /** Earliest position in the outgoing track the transition may start (now + a little) */
  earliest: number;
  keyA?: Key;
  keyB?: Key;
  /** The move the last drop used: not the same one twice in a row */
  avoid?: Move;
};

const fade = (a: Analysis, b: Analysis, earliest: number, seconds: number, note: string): Plan => {
  const end = a.lastSound;
  let d = Math.max(0.3, Math.min(seconds, end - earliest));
  let aStart = Math.max(earliest, end - d);
  // A track that fades itself out: come in while it's still audible rather than after it has gone
  if (a.fadeOut && a.outroStart > earliest && a.outroStart < end - 2) {
    aStart = Math.max(aStart - 2, Math.min(aStart, a.outroStart + 2));
    d = Math.min(d, end - aStart);
  }
  return { kind: "fade", aStart, duration: d, bStart: b.firstSound, bAt: 0, swapAt: d / 2, note };
};

const cut = (a: Analysis, b: Analysis, earliest: number, note: string): Plan => {
  const aStart = Math.max(earliest, a.lastSound - 0.06);
  return { kind: "cut", aStart, duration: 0.06, bStart: b.firstSound, bAt: 0.03, swapAt: 0.03, note };
};

/**
 * Tempos too far apart to blend: the two tracks never play together. The outgoing one leaves over the beats
 * before a bar line, and the incoming one lands on that line with its own first beat. How it leaves follows
 * where the tempo is going (up: filtered thinner and thinner, so the new track arrives as a release; down:
 * braked like a record), and is never the same twice in a row.
 *   aCut: the bar line; room: seconds available before it; longest: the most beats a move may take
 */
const drop = (aCut: number, room: number, longest: number, pA: number, pB: number, bStart: number, avoid: Move | undefined, where: string): Plan | undefined => {
  // The filter move takes two bars (one when two would run past five seconds, or there's no room)
  let filterBeats = 0;
  for (const n of [8, 4]) {
    if (!filterBeats && n <= longest && n * pA <= 5 && n * pA <= room) filterBeats = n;
  }
  // A brake takes about as long as a record does to stop
  const brakeBeats = pA < 0.6 ? 2 : 1;
  const length: Record<Move, number> = { sweep: filterBeats, brake: brakeBeats * pA <= room ? brakeBeats : 0 };
  const order: Move[] = pB < pA ? ["sweep", "brake"] : ["brake", "sweep"];
  const possible = order.filter((m) => length[m] > 0);
  const move = possible.find((m) => m !== avoid) ?? possible[0];
  if (!move) return undefined;
  const beats = length[move];
  const L = beats * pA;
  const how = move === "sweep" ? `filtered away over ${beats} beats` : `record brake over ${beats} beat${beats > 1 ? "s" : ""}`;
  return { kind: "drop", move, aStart: aCut - L, duration: L, bStart, bAt: L, swapAt: L, beats, period: pA, note: `${how}, new track lands on ${where}, ${(60 / pA).toFixed(1)} → ${(60 / pB).toFixed(1)} BPM` };
};

const barAtOrAfter = (a: Analysis, g: Grid, t: number) => {
  const bar = barAtOrBefore(a, g, t);
  return bar >= t - 0.02 ? bar : bar + 4 * g.period;
};

/** The next four-bar phrase line from t on, if one is coming within two bars; else the next bar line */
const phraseAtOrAfter = (a: Analysis, g: Grid, t: number) => {
  const bar = barAtOrAfter(a, g, t);
  const i = a.bars.findIndex((x, k) => x >= t - 0.02 && ((k - a.phrasePhase) % 4 + 4) % 4 === 0);
  return i >= 0 && a.bars[i] - bar <= 8 * g.period + 0.05 ? Math.max(bar, snap(g, a.bars[i])) : bar;
};

type NowOptions = {
  mixing: Mixing;
  /** Position in the outgoing track from which the move may start */
  from: number;
  keyA?: Key;
  keyB?: Key;
  /** The move the last drop used: not the same one twice in a row */
  avoid?: Move;
};

/**
 * A move to the next track right away (the DJ button, a request) instead of at the outgoing track's own
 * mix-out point. It is still a DJ's move: the incoming track comes in on the next phrase or bar line,
 * locked to the beat, over eight bars (four if the keys clash) with the outgoing one filtered thin, since
 * it is in full swing. Tempos too far apart to match get a drop on the next bar line (see drop).
 */
export const planNow = (a: Analysis, b: Analysis, opts: NowOptions): Plan => {
  const { from } = opts;
  const remaining = a.lastSound - from;
  if (opts.mixing === "none" || remaining < 1.2) return { kind: "cut", aStart: Math.min(from, a.lastSound - 0.06), duration: 0.06, bStart: b.firstSound, bAt: 0.03, swapAt: 0.03, note: opts.mixing === "none" ? "mixing off" : "no time left" };
  const fadeNow = (seconds: number, note: string): Plan => {
    const d = Math.max(0.3, Math.min(seconds, remaining));
    return { kind: "fade", aStart: from, duration: d, bStart: b.firstSound, bAt: 0, swapAt: d / 2, note };
  };
  if (opts.mixing === "crossfade") return fadeNow(4, "crossfade only");

  // In the middle of a track the grid fitted to all of it is the one to go by; near the end, the tail's
  const whole = usable(a.grid) ? a.grid : null;
  const tail = usable(a.tail) ? a.tail : null;
  const gA = from > a.lastSound - 60 ? (tail ?? whole) : (whole ?? tail);
  const gB = usable(b.head) ? b.head : usable(b.grid) ? b.grid : null;
  if (!gA || !gB) return fadeNow(5, "no steady beat");

  const pA = gA.period;
  let mult = 1;
  let speed = gB.period / pA;
  for (const m of [2, 0.5]) {
    const v = (gB.period * m) / pA;
    if (Math.abs(Math.log(v)) < Math.abs(Math.log(speed))) {
      speed = v;
      mult = m;
    }
  }
  const pB = gB.period * mult;
  const bIn = mixInPoint(b, gB);
  const introBeats = Math.max(0, Math.round((b.introEnd - bIn) / pB));

  if (Math.abs(speed - 1) <= MATCH_LIMIT) {
    const bar = barAtOrAfter(a, gA, from);
    const phrase = phraseAtOrAfter(a, gA, from);
    for (const beats of keysClash(opts.keyA, opts.keyB) ? [16, 8] : [32, 16, 8]) {
      for (const aStart of phrase > bar + 0.05 ? [phrase, bar] : [bar]) {
        if (aStart + beats * pA > a.lastSound + 0.5 * pA) continue;
        const duration = beats * pA;
        // A long lead-in is skipped so that the incoming track's main section arrives as the window ends
        let bStart = bIn;
        if (introBeats > beats) bStart = bIn + Math.min(Math.floor(60 / pB / 4) * 4, Math.floor((introBeats - beats) / 4) * 4) * pB;
        const bodyAt = Math.round((b.introEnd - bStart) / pB / 4) * 4;
        const middle = Math.round(beats / 2 / 8) * 8 || Math.round(beats / 2 / 4) * 4;
        const swapBeat = bodyAt >= beats * 0.3 && bodyAt < middle ? bodyAt : middle;
        const stretched = Math.abs(speed - 1) > 2e-5;
        return {
          kind: "blend",
          aStart,
          duration,
          bStart,
          bAt: 0,
          swapAt: swapBeat * pA,
          beats,
          period: pA,
          speed,
          glide: stretched ? Math.min(32 * pA, 16) : 0,
          bassSwap: swapBeat * pA,
          fadeIn: swapBeat * pA * 0.85,
          fadeOutFrom: swapBeat * pA,
          style: beats >= 16 ? "filter" : "swap",
          note: `${beats}-beat (${Math.round(beats / 4)}-bar) blend right away at ${(60 / pA).toFixed(1)} BPM, bass swap on beat ${swapBeat}, incoming ${speed >= 1 ? "+" : ""}${((speed - 1) * 100).toFixed(1)}%${mult !== 1 ? ` (${mult}x time)` : ""}, intro ${introBeats} beats`,
        };
      }
    }
  }

  // Tempos too far apart (or no room left): the outgoing track leaves over the next beats, and the new one
  // lands on the bar line after them. Kept short, since this was asked for right now.
  const aCut = barAtOrAfter(a, gA, from + pA);
  if (aCut > a.lastSound - 0.1) return fadeNow(3, "too close to the end");
  let bStart = bIn;
  if (introBeats > 16) bStart = bIn + Math.floor((introBeats - 16) / 4) * 4 * pB;
  let plan = drop(aCut, aCut - from, 4, pA, gB.period, bStart, opts.avoid, "the next bar");
  // (A bar further on, if that's what it takes not to leave the same way as last time)
  const later = aCut + 4 * pA;
  if (plan && plan.move === opts.avoid && later <= a.lastSound - 0.1) plan = drop(later, later - from, 4, pA, gB.period, bStart, opts.avoid, "the next bar") ?? plan;
  return plan ?? fadeNow(3, "no room for a move");
};

export const planTransition = (a: Analysis, b: Analysis, opts: Options): Plan => {
  const { earliest } = opts;
  const remaining = a.lastSound - earliest;
  if (opts.mixing === "none" || remaining < 1.2) return cut(a, b, earliest, opts.mixing === "none" ? "mixing off" : "no time left");
  if (opts.mixing === "crossfade") return fade(a, b, earliest, 6, "crossfade only");

  const gA = usable(a.tail) ? a.tail : usable(a.grid) ? a.grid : null;
  const gB = usable(b.head) ? b.head : usable(b.grid) ? b.grid : null;
  // Tracks without a steady grid (ambient, classical, rubato, a tempo that moves): a plain crossfade suits them best
  if (!gA || !gB) return fade(a, b, earliest, 7, "no steady beat");

  const pA = gA.period;
  // The incoming tempo may relate as double or half time
  let mult = 1;
  let speed = gB.period / pA;
  for (const m of [2, 0.5]) {
    const s = (gB.period * m) / pA;
    if (Math.abs(Math.log(s)) < Math.abs(Math.log(speed))) {
      speed = s;
      mult = m;
    }
  }
  const pB = gB.period * mult; // incoming seconds per outgoing beat, at its own tempo
  // Up to 8% apart the incoming track can be brought to the same tempo and still sound like itself
  const matchable = Math.abs(speed - 1) <= MATCH_LIMIT;

  const bIn = mixInPoint(b, gB);
  const introBeats = Math.max(0, Math.round((b.introEnd - bIn) / pB));
  const lastBar = barAtOrBefore(a, gA, a.lastSound - 0.25 * pA);
  const outro = snap(gA, Math.min(a.outroStart, lastBar));
  const outroBeats = Math.max(0, Math.round((a.lastSound - outro) / pA));

  if (matchable) {
    // A DJ's blend, the way Spotify's mixes do it: sixteen bars where both tracks play locked to one
    // beat. The window ends where the outgoing track runs out of song, and (when the incoming track has
    // the intro for it) where the incoming track's own main section starts, so that section lands just as
    // the old track leaves. Volumes move gradually across the whole window; the bass changes hands on a
    // bar line so there are never two basslines.
    const tail = Math.floor(Math.min(outroBeats, 16) / 4) * 4;
    let blendEnd = outro + tail * pA;
    const hardEnd = Math.min(a.lastSound + 0.5 * pA, lastBar + 4 * pA);
    while (blendEnd > hardEnd + 1e-3) blendEnd -= 4 * pA;
    // Not before the outgoing track has had its own main section for a while
    const notBefore = Math.max(earliest + 0.5, Math.min(a.introEnd + 16 * pA, blendEnd - 16 * pA));

    // Two songs in full swing with no intro or outro between them: sixteen bars of both is too much.
    // Those get eight bars at most, with the outgoing one filtered thin from the start so the incoming
    // one's vocals have room.
    const dense = introBeats < 16 && outroBeats < 16;
    for (let n = dense ? 32 : 64; n >= 16; n /= 2) {
      if (n * pA > 36) continue;
      if (n > 32 && keysClash(opts.keyA, opts.keyB)) continue;
      const aStart = phraseAtOrBefore(a, gA, blendEnd - n * pA + 0.02);
      const beats = Math.round((blendEnd - aStart) / pA);
      if (aStart < notBefore || beats < n - 4 || beats > n + 8) continue;
      const duration = beats * pA;
      // The incoming window ends where its main section starts, when its intro is long enough for that
      let bStart = bIn;
      // (A long lead-in is skipped so its end meets the end of the window, up to a minute of it)
      if (introBeats > beats) bStart = bIn + Math.min(Math.floor(60 / pB / 4) * 4, Math.floor((introBeats - beats) / 4) * 4) * pB;
      const bodyAt = Math.round(((b.introEnd - bStart) / pB) / 4) * 4;
      // The bass (and with it the kick) changes hands on the phrase line in the middle: the first half
      // is the old track with the new one's percussion over it, the second half the new track's low end
      // with the old one thinning out above it. If the incoming main section arrives a little earlier
      // than that, the swap happens there.
      const middle = Math.round(beats / 2 / 8) * 8 || Math.round(beats / 2 / 4) * 4;
      const swapBeat = bodyAt >= beats * 0.3 && bodyAt < middle ? bodyAt : middle;
      const stretched = Math.abs(speed - 1) > 2e-5;
      return {
        kind: "blend",
        aStart,
        duration,
        bStart,
        bAt: 0,
        swapAt: swapBeat * pA,
        beats,
        period: pA,
        speed,
        glide: stretched ? Math.min(32 * pA, 16) : 0,
        bassSwap: swapBeat * pA,
        fadeIn: swapBeat * pA * 0.85,
        fadeOutFrom: swapBeat * pA,
        style: dense ? "filter" : "swap",
        note: `${dense ? "filtered " : ""}${beats}-beat (${Math.round(beats / 4)}-bar) blend at ${(60 / pA).toFixed(1)} BPM, bass swap on beat ${swapBeat}, incoming ${speed >= 1 ? "+" : ""}${((speed - 1) * 100).toFixed(1)}%${mult !== 1 ? ` (${mult}x time)` : ""}, intro ${introBeats} / outro ${outroBeats} beats`,
      };
    }
    // No room for a long one: an eight-beat blend on the last bars
    {
      const aStart = barAtOrBefore(a, gA, blendEnd - 8 * pA + 0.02);
      if (aStart >= earliest + 0.5) {
        const stretched = Math.abs(speed - 1) > 2e-5;
        const duration = Math.round((blendEnd - aStart) / pA) * pA;
        return {
          kind: "blend",
          aStart,
          duration,
          bStart: bIn,
          bAt: 0,
          swapAt: duration / 2,
          beats: Math.round(duration / pA),
          period: pA,
          speed,
          glide: stretched ? Math.min(32 * pA, 16) : 0,
          bassSwap: Math.round(duration / pA / 2) * pA,
          fadeIn: duration * 0.5,
          fadeOutFrom: duration * 0.4,
          note: `short ${Math.round(duration / pA)}-beat blend at ${(60 / pA).toFixed(1)} BPM, incoming ${speed >= 1 ? "+" : ""}${((speed - 1) * 100).toFixed(1)}%`,
        };
      }
    }
    // Too close to the end for a real blend: a quick beatmatched four-beat handover
    {
      const aStart = barAtOrBefore(a, gA, Math.min(blendEnd, hardEnd) - 4 * pA + 0.02);
      if (aStart >= earliest + 0.5 && aStart + 4 * pA <= a.lastSound + 0.75 * pA) {
        const stretched = Math.abs(speed - 1) > 2e-5;
        return {
          kind: "blend",
          aStart,
          duration: 4 * pA,
          bStart: bIn,
          bAt: 0,
          swapAt: 2 * pA,
          beats: 4,
          period: pA,
          speed,
          glide: stretched ? Math.min(32 * pA, 16) : 0,
          bassSwap: 2 * pA,
          note: `quick 4-beat handover at ${(60 / pA).toFixed(1)} BPM, incoming ${speed >= 1 ? "+" : ""}${((speed - 1) * 100).toFixed(1)}%`,
        };
      }
    }
  }

  // Tempos too far apart to match: the outgoing track leaves ahead of a bar line, and the next one lands on it
  let aCut: number;
  if (outroBeats >= 8) aCut = outro + 8 * pA;
  else if (outroBeats >= 4) aCut = outro + 4 * pA;
  else aCut = lastBar;
  if (aCut > a.lastSound - 0.1) aCut = lastBar;
  if (aCut - pA < earliest + 0.3) return fade(a, b, earliest, 5, "past the mix-out point");
  let bStart = bIn;
  // Don't follow a hard cut with a long sparse intro
  if (introBeats > 16) bStart = bIn + Math.floor((introBeats - 16) / 4) * 4 * pB;
  return drop(aCut, aCut - earliest - 0.3, 8, pA, gB.period, bStart, opts.avoid, "the bar") ?? fade(a, b, earliest, 5, "past the mix-out point");
};
