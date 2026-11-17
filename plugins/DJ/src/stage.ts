// THE STAGE: the DJ full screen, in TIDAL's own look (its fonts, colours and controls, from TIDAL's design tokens where
// the page has them), with everything the DJ does shown as it happens:
//   - the cover of what's playing, as big as there is room for (it makes room when the DJ talks, or a mix is shown)
//   - a mix coming up: the cover moves aside and the next one comes out of "Up next" beside it, two decks, with what
//     the DJ worked out for the two between them (their tempos and how far one is moved to meet the other, their keys,
//     the kind of mix and its length, how the drums were lined up); just before the mix they come together in the
//     middle and merge into one cover, on which the mix is played out the way the cover in TIDAL's player plays it
//     (see cover.ts: the same transition, drawn by the same worker, on the mixer's clock); after it, one cover again
//   - a mashup: the same, with both songs shown for as long as the two play together
//   - the breakdown underneath: both tracks on one timeline as the mixer plays them, each split into its top and its
//     bass (or, in a mashup, its voice and its band), each half lit for as long as it is heard; the tempo each is
//     heard at (slowed down or sped up to meet the other, and back); every move marked where it happens: the mix in,
//     the filter, the bass swap, the drop, the glide back, the way out; their beats ticked off against each other
//   - picking music: records flick past over the cover; a new set: its name comes up, its tracks land in "Up next"
//   - what the DJ says, the way TIDAL shows lyrics
//   - a track's name carries TIDAL's marks for it (explicit, made with AI, an upload, Dolby Atmos)
//   - on top: TrueTaste's thumbs for what is playing (when that plugin is there), the DJ's buttons, and its panel
//     (requests, the voice, how much it talks); they go out of sight while the mouse is still
// It never changes TIDAL's window: no full screen of the browser's own (TIDAL uses that for its now-playing view, and
// leaving it from here took TIDAL out of that view half-way). It covers the window, and is gone again when closed.
import type { LunaUnload } from "@luna/core";
import type { MashArrangement, MashBlock, Wave } from "./audio/mixer";
import { lookingForMusic, type CoverTransition, type Stage, type StageDeck, type Status } from "./session";

export type StageSource = {
  status: () => Status;
  onStatus: (fn: (s: Status) => void) => () => void;
  stage: () => Stage | undefined;
  /** A loaded track's waveform */
  waveform: (id: string) => Promise<Wave | undefined>;
  /** A mashup under way: block by block as the mixer decides it, and how far ahead the taking out of the voices is */
  mash: () => Promise<Mash | undefined>;
  /** The DJ's name ("Bella") */
  persona: () => string;
  cover: (trackId: string) => Promise<string | undefined>;
  /** Where the cover transitions are to be drawn while the stage is open (see coverFxStage in cover.ts); undefined: closed */
  fxSurface: (img: HTMLImageElement | undefined) => void;
  start: () => void;
  startFollow: () => void;
  switchUp: () => void;
  /** A mashup of what's playing with a song the DJ picks for it */
  mashup: () => void;
  /** How TIDAL marks a track: explicit, made with AI, an upload, in Dolby Atmos */
  marks: (trackId: string) => Promise<Marks | undefined>;
  /**
   * TrueTaste's thumbs on what is playing: which is pressed (0: neither; undefined: TrueTaste isn't there, or nothing
   * is playing), and pressing one (again takes it back; a thumbs down also skips the song, as TrueTaste has it)
   */
  feedback: { state: () => 1 | -1 | 0 | undefined; give: (v: 1 | -1) => void };
  /** The DJ's panel (requests, the voice, how much it talks, transitions only): opened under `anchor`, or closed if it is open there */
  panel: { toggle: (anchor: HTMLElement) => void; isOpen: () => boolean; close: () => void };
  skip: () => void;
  stop: () => void;
};

export type Marks = { explicit?: boolean; ai?: boolean; upload?: boolean; atmos?: boolean };
export type Mash = { plan?: MashArrangement; cut?: number; feeds: { wanted: number; played: number; late: number; missed: number; spare: number | null }[] };

const R = "visiuun-dj-stage";
// TIDAL's design tokens, with their values as fallbacks
const T = {
  display: `"Square Sans Display VF", "Square Sans Display", Helvetica, Arial, sans-serif`,
  text: `"Square Sans Text VF", "Square Sans Text", Helvetica, Arial, sans-serif`,
  secondary: "var(--wave-color-solid-contrast-darker, #afafb6)",
  tertiary: "var(--wave-color-solid-contrast-darkest, #787887)",
  accent: "var(--wave-color-solid-accent-fill, #3fe)",
  ultraThin: "var(--wave-color-opacity-contrast-fill-ultra-thin, #ffffff1a)",
  material: "var(--wave-color-material-dark, #25252580)",
};
type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const ACCENT: RGB = [51, 255, 238];
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const ease = (dt: number, speed: number) => 1 - Math.exp(-dt * speed);
const GLIDE = "cubic-bezier(.2, .8, .2, 1)";
/**
 * How long before a mix the two decks show (s), and how long the two covers take to come together (s). A mix that
 * comes up with less than SPLIT_MIN to go (one asked for right now: a switch-up, a request) isn't worth moving the
 * covers apart for, only to bring them back together at once: the next cover goes under the playing one instead.
 */
const LEAD = 20;
const TRAVEL = 2.6;
const SPLIT_MIN = 7;

const css = `
  .${R} { position: fixed; inset: 0; z-index: 2147483000; background: #000; color: #fff; overflow: hidden; display: none; font-family: ${T.text}; font-size: 14px; line-height: 20px; font-weight: 500; -webkit-font-smoothing: antialiased; user-select: none; }
  .${R}.open { display: block; animation: ${R}-in .3s ease both; }
  @keyframes ${R}-in { from { opacity: 0; } to { opacity: 1; } }
  .${R} * { box-sizing: border-box; }
  .${R} .bg { position: absolute; inset: -120px; }
  .${R} .bg div { position: absolute; inset: 0; background-size: cover; background-position: center; filter: blur(100px) saturate(1.4); opacity: 0; transition: opacity 2s ease; }
  .${R} .bg div.on { opacity: .7; }
  .${R} .shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.3) 0%, rgba(0,0,0,.5) 55%, rgba(0,0,0,.85) 100%); }

  /* (one column, the width of the window: a long queue in "Up next" is cut off at its edge, it never widens the page) */
  .${R} .frame { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: 64px 1fr 0px 120px 72px; padding: 0 56px 20px; }
  .${R} .frame > * { min-width: 0; }
  .${R} .top { position: relative; display: flex; align-items: center; gap: 12px; min-width: 0; }
  .${R} .top .sp { flex: 1; }
  .${R} .icon { width: 40px; height: 40px; border-radius: 1000px; border: 0; background: transparent; color: #fff; display: grid; place-items: center; cursor: pointer; padding: 0; flex: none; }
  .${R} .icon:hover { background: ${T.ultraThin}; }
  .${R} .icon svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .${R} .icon.thumb svg { width: 20px; height: 20px; }
  .${R} .icon.thumb.down svg { transform: rotate(180deg); }
  .${R} .icon.thumb.on svg { fill: currentColor; }
  .${R} .icon.thumb + .icon.thumb { margin-left: -8px; }
  .${R} .icon[disabled] { opacity: .35; cursor: default; }
  /* The buttons go out of sight (and the pointer with them) once the mouse has been still for a while */
  .${R} .top .btn, .${R} .top .icon { transition: opacity .4s ease, background-color .15s ease; }
  .${R}.resting { cursor: none; }
  .${R}.resting .top .btn, .${R}.resting .top .icon { opacity: 0; pointer-events: none; }
  .${R} .who { display: flex; align-items: baseline; gap: 10px; color: ${T.secondary}; white-space: nowrap; min-width: 0; overflow: hidden; transition: opacity .3s ease; }
  .${R} .who strong { color: #fff; font-weight: 600; }
  .${R} .who span { overflow: hidden; text-overflow: ellipsis; }
  .${R} .banner { position: absolute; left: 0; top: 50%; display: flex; align-items: baseline; gap: 14px; pointer-events: none; white-space: nowrap; opacity: 0; transform: translateY(-50%); }
  .${R} .banner small { font-size: 14px; color: ${T.accent}; font-weight: 600; }
  .${R} .banner strong { font-family: ${T.display}; font-size: 28px; line-height: 32px; font-weight: 700; }
  .${R} .top.announcing .who { opacity: 0; }
  .${R} .btn { height: 36px; padding: 0 18px; border-radius: 1000px; border: 0; background: ${T.ultraThin}; color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; flex: none; }
  .${R} .btn:hover { background: var(--wave-color-opacity-contrast-fill-thin, #fff3); }
  .${R} .btn.primary { background: #fff; color: #000; }
  .${R} .btn.primary:hover { background: var(--wave-color-solid-contrast-dark, #e4e4e7); }

  .${R} .main { position: relative; min-height: 0; }
  .${R} .cv { position: absolute; left: 0; top: 0; border-radius: 4px; overflow: hidden; background: #18181b; box-shadow: 0 24px 64px rgba(0,0,0,.5); transform-origin: 50% 50%; will-change: transform, opacity; }
  .${R} .cv img { width: 100%; height: 100%; object-fit: cover; display: block; }
  /* a cover that can't be had: the track's name on a plain plate */
  .${R} .cv, .${R} .dig .rec, .${R} .card .ph { container-type: inline-size; }
  .${R} .blank { position: absolute; inset: 0; display: grid; place-items: center; padding: 8cqw; text-align: center; overflow: hidden; background: linear-gradient(145deg, #2c2c33, #18181b); color: ${T.secondary}; font-family: ${T.display}; font-weight: 700; font-size: clamp(8px, 9cqw, 52px); line-height: 1.1; overflow-wrap: anywhere; }
  .${R} .card .ph { position: relative; }
  .${R} .card .ph .blank { font-size: 0; }
  .${R} .cv b { position: absolute; left: 10px; bottom: 10px; font-size: 12px; line-height: 16px; font-weight: 600; padding: 4px 10px; border-radius: 1000px; background: rgba(0,0,0,.6); backdrop-filter: blur(12px); opacity: 0; transition: opacity .3s ease; }
  .${R} .cv.tagged b { opacity: 1; }
  /* where the two covers merge: the transition is drawn here, over them (see cover.ts) */
  .${R} .fx { position: absolute; left: 0; top: 0; z-index: 5; pointer-events: none; opacity: 0; transition: opacity .25s ease; }
  .${R} .fx.on { opacity: 1; }
  .${R} .fx > img { width: 100%; height: 100%; display: block; opacity: 0; }
  .${R} .main.digging .cv { filter: brightness(.35) blur(2px); }
  .${R} .main .cv { transition: filter .5s ease; }
  .${R} .dig { position: absolute; left: 0; top: 0; z-index: 6; pointer-events: none; opacity: 0; transition: opacity .4s ease; }
  .${R} .dig.on { opacity: 1; }
  .${R} .dig .stack { position: absolute; left: 24%; top: 16%; width: 52%; height: 52%; }
  .${R} .dig .rec { position: absolute; inset: 0; border-radius: 4px; overflow: hidden; background: #303036; box-shadow: 0 12px 32px rgba(0,0,0,.5); }
  .${R} .dig .rec img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .${R} .dig p { position: absolute; left: 6%; right: 6%; bottom: 7%; margin: 0; text-align: center; font-size: 15px; line-height: 20px; font-weight: 600; text-shadow: 0 1px 8px rgba(0,0,0,.8); }
  .${R} .dig p i { font-style: normal; display: inline-block; width: 1.2em; text-align: left; }

  /* what the DJ worked out for the two, between the two decks */
  .${R} .match { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; pointer-events: none; z-index: 4; }
  .${R} .match .m { border-radius: 12px; background: ${T.material}; backdrop-filter: blur(20px); padding: 10px 12px; text-align: center; opacity: 0; transform: translateY(10px) scale(.96); transition: opacity .45s ease, transform .55s ${GLIDE}; }
  .${R} .match.on .m { opacity: 1; transform: none; }
  .${R} .match .m strong { display: flex; align-items: center; justify-content: center; gap: 8px; font-family: ${T.display}; font-size: 17px; line-height: 22px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .${R} .match .m strong i { font-style: normal; color: ${T.accent}; }
  .${R} .match .m span { display: block; margin-top: 2px; color: ${T.secondary}; font-size: 12px; line-height: 16px; }
  .${R} .match .m.good span { color: ${T.accent}; }

  .${R} .ttl { position: absolute; left: 0; top: 0; text-align: center; will-change: transform, opacity; }
  .${R} .ttl .label { color: ${T.secondary}; font-size: 13px; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .${R} .ttl .label.accent { color: ${T.accent}; font-weight: 600; }
  .${R} .ttl h1 { margin: 0; font-family: ${T.display}; font-weight: 700; line-height: 1.1; letter-spacing: -.01em; white-space: nowrap; display: flex; align-items: center; justify-content: center; gap: .22em; }
  .${R} .ttl h1 .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .${R} .ttl h1 .x2 { color: ${T.secondary}; font-weight: 500; }
  /* TIDAL's marks on a track (explicit, made with AI, an upload, Dolby Atmos), after its name as TIDAL has them */
  /* (TIDAL's drawings take their white and black from these two of its colours: given here as what they are, so a
     badge is never drawn in nothing) */
  .${R} .ttl h1 .marks { flex: none; display: inline-flex; align-items: center; gap: max(4px, .07em); --market-core-fill-white-color: #fff; --market-core-fill-black-color: #000; }
  .${R} .ttl h1 .marks:empty { display: none; }
  /* (TIDAL's are 16px beside its 16px names: here they grow with the name) */
  .${R} .ttl h1 .marks i { flex: none; display: inline-flex; height: max(16px, .36em); }
  .${R} .ttl h1 .marks svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .${R} .ttl .by { margin-top: 4px; color: ${T.secondary}; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .${R} .tags { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; min-height: 28px; }
  .${R} .tags span { display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px; border-radius: 1000px; background: ${T.ultraThin}; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .${R} .tags .beat { box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0); }

  .${R} .said { align-self: center; justify-self: center; text-align: center; max-width: 1000px; font-family: ${T.display}; font-weight: 700; font-size: clamp(18px, 1.6vw, 26px); line-height: 1.3; max-height: 2.6em; overflow: hidden; scroll-behavior: smooth; opacity: 0; transition: opacity .3s ease; }
  .${R} .said.on { opacity: 1; }
  .${R} .said .w { color: rgba(255,255,255,.35); transition: color .25s ease; }
  .${R} .said .w.done { color: #fff; }

  .${R} .timeline { position: relative; min-height: 0; }
  .${R} .timeline canvas { position: absolute; inset: 0; width: 100%; height: 100%; }

  .${R} .next { display: flex; align-items: center; gap: 24px; min-height: 0; }
  .${R} .next h3 { margin: 0; flex: none; font-family: ${T.display}; font-size: 17px; line-height: 24px; font-weight: 700; }
  .${R} .cards { position: relative; flex: 1; min-width: 0; display: flex; gap: 24px; overflow: hidden; height: 100%; align-items: center; -webkit-mask: linear-gradient(90deg, #000 88%, transparent); mask: linear-gradient(90deg, #000 88%, transparent); }
  .${R} .card { flex: none; width: 220px; display: flex; gap: 12px; align-items: center; transition: transform .6s ${GLIDE}, opacity .4s ease; }
  .${R} .card .ph { width: 48px; height: 48px; border-radius: 4px; flex: none; background: #303036; overflow: hidden; }
  .${R} .card .ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .${R} .card > div:last-child { min-width: 0; }
  .${R} .card strong { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .${R} .card span { display: block; color: ${T.secondary}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .${R} .card em { display: block; font-style: normal; font-size: 12px; line-height: 16px; color: ${T.accent}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* (one that leaves is taken out of the row as it goes, so that the ones coming in land in their own places) */
  .${R} .card.gone { position: absolute; opacity: 0; transform: translateY(-16px) !important; }
  .${R} .card.lifted { opacity: 0 !important; }
  .${R} .cards .none { color: ${T.secondary}; }

  .${R} .idle { position: absolute; inset: 64px 0 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 16px; text-align: center; padding: 0 32px; }
  .${R}[data-mode="off"] .idle { display: flex; }
  .${R}[data-mode="off"] .main, .${R}[data-mode="off"] .timeline, .${R}[data-mode="off"] .next, .${R}[data-mode="off"] .said { visibility: hidden; }
  .${R} .idle h2 { margin: 0; font-family: ${T.display}; font-size: 48px; line-height: 1.1; font-weight: 700; }
  .${R} .idle p { margin: 0; color: ${T.secondary}; font-size: 16px; line-height: 24px; max-width: 520px; }
  .${R} .idle div { display: flex; gap: 12px; justify-content: center; margin-top: 8px; }
  .${R} .idle .btn { height: 40px; padding: 0 20px; }
`;

// (TIDAL's own "close the now-playing view" chevron)
const ICON_CLOSE = `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`;
const ICON_OPTIONS = `<svg viewBox="0 0 24 24"><path d="M4 7h8.5M19.5 7h.5M4 17h.5M11.5 17H20"/><circle cx="16" cy="7" r="3"/><circle cx="8" cy="17" r="3"/></svg>`;
// (TrueTaste's thumb)
const ICON_THUMB = `<svg viewBox="0 0 24 24"><path d="M7 10v11H3V10h4Z"/><path d="M7 10l4.2-7.4c.4-.7 1.3-.9 1.9-.5.9.6 1.3 1.6 1.1 2.6L13.6 9h6c1.2 0 2.1 1.1 1.9 2.3l-1.3 7.5c-.2 1.3-1.3 2.2-2.6 2.2H7"/></svg>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const mmss = (s: number) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const NOTES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
type Key = { tonic: number; mode: "major" | "minor" };
const camelotOf = (k: Key) => {
  const n = k.mode === "major" ? ((k.tonic * 7) % 12) + 8 : (((k.tonic + 3) * 7) % 12) + 8;
  return { n: ((n - 1) % 12) + 1, major: k.mode === "major" };
};
const camelot = (k: Key) => {
  const c = camelotOf(k);
  return `${c.n}${c.major ? "B" : "A"}`;
};
/** How two keys sit together on the Camelot wheel */
const keyFit = (a: Key, b: Key) => {
  const x = camelotOf(a);
  const y = camelotOf(b);
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (d === 0 && x.major === y.major) return "same key";
  if (d === 0) return "relative major and minor";
  if (d === 1 && x.major === y.major) return "next door on the wheel";
  return d <= 2 ? "close keys" : "different keys";
};
/** "Blue Berries'", "Clarity's", and "Beggin's" of "Beggin'" */
const poss = (name: string) => (/['’]$/.test(name) ? `${name}s` : /s$/i.test(name) ? `${name}'` : `${name}'s`);
const artistsOf = (d: { track: { artists: { name: string }[] } }) => d.track.artists.map((a) => a.name).join(", ");
const titleOf = (d: { track: { title: string; version?: string } }) => d.track.title + (d.track.version ? ` (${d.track.version})` : "");
type MapPoint = StageDeck["map"][number];
/** Mixer time at which a track reaches `pos` (see Deck.timeAt) */
const timeAt = (map: MapPoint[], pos: number) => {
  if (!map.length) return Infinity;
  let p = map[0];
  for (const m of map) if (m.pos <= pos) p = m;
  return p.t + (pos - p.pos) / p.rate;
};
/** Where in a track it is at mixer time `time`, and how fast it is playing then (see Deck.positionAt) */
const posAt = (map: MapPoint[], time: number) => {
  let p = map[0];
  for (const m of map) if (m.t <= time) p = m;
  return p.pos + (time - p.t) * p.rate;
};
const rateAt = (map: MapPoint[], time: number) => {
  let p = map[0];
  for (const m of map) if (m.t <= time) p = m;
  return p.rate;
};
type Kind = CoverTransition["kind"];
const KIND: Record<Kind, string> = { blend: "Blend", drop: "Drop", fade: "Fade", cut: "Cut", mashup: "Mashup" };
const NEXT: Record<Kind, string> = { blend: "Blending in", drop: "Dropping in", fade: "Fading in", cut: "Cutting to", mashup: "Mashing up with" };
type Live = CoverTransition & { p: number };
/**
 * How far a mix is, 0-1: half-way at the swap, all the way at its end. (For when the cover transition can't be drawn:
 * then the incoming cover fades over the other by it.)
 */
const mixed = (tr: Live, t: number) =>
  t <= tr.start
    ? 0
    : t >= tr.end
      ? 1
      : t < tr.swap
        ? 0.5 * smooth(clamp((t - tr.start) / Math.max(0.1, tr.swap - tr.start)))
        : 0.5 + 0.5 * smooth(clamp((t - tr.swap) / Math.max(0.1, tr.end - tr.swap)));

// ------------------ WHAT IS HEARD OF EACH TRACK ------------------
// For the breakdown: how much of each half of each track is heard at mixer time t (0-1). The top half of a track's lane
// is its top (mids and highs; in a mashup its voice), the bottom half its bass (in a mashup its band). Worked out from
// what the DJ planned (see TransitionDetail); without it, a plain cross-fade with the bass changing hands at the swap.
type Half = "top" | "low";
/** The mashup block playing at t, as the mixer decided it */
const blockAt = (arr: MashArrangement | undefined, t: number): MashBlock | undefined => arr?.blocks.find((b) => t >= b.from && t < b.to);
/** From where on a mashup's blocks haven't been decided yet (they are decided as they come up) */
const undecidedFrom = (arr: MashArrangement) => (arr.blocks.length ? Math.max(...arr.blocks.map((b) => b.to)) : arr.from);
const heardOf = (tr: Live, side: "a" | "b", half: Half, t: number, arr?: MashArrangement): number => {
  const d = tr.detail;
  const ramp = (from: number, to: number) => clamp((t - from) / Math.max(0.05, to - from));
  const beat = tr.beat ?? 0.5;
  if (tr.kind === "mashup" && arr) {
    if (t < arr.from) return side === "a" ? 1 : ramp(arr.from - 2 * beat, arr.from) * 0.3;
    if (t >= arr.end) return side === "a" ? 0 : 1;
    const b = blockAt(arr, t);
    if (b) return clamp(b[side][half]);
  }
  if (tr.kind === "mashup") {
    const mid = tr.mid ?? tr.swap;
    const way = d?.way ?? "voice";
    const outA = 1 - ramp(mid, tr.end);
    if (way === "carry") {
      // the playing song's voice over the other's band
      if (side === "a") return half === "top" ? (t < tr.start ? 1 : outA) : 1 - ramp(tr.start - beat, tr.start);
      return half === "low" ? ramp(tr.start - beat, tr.start) : 0;
    }
    if (way === "layer") {
      // the other song over this one's bass, then the bass changes hands
      const bassAt = tr.start + (d?.bars1 ?? 8) * 4 * beat;
      if (side === "a") return half === "low" ? 1 - ramp(bassAt, bassAt + beat) : 1 - ramp(tr.start, tr.start + 2 * beat) * 0.6 - ramp(bassAt, tr.end) * 0.4;
      return half === "top" ? ramp(tr.start - beat, tr.start) : ramp(bassAt, bassAt + beat);
    }
    // voice: the other song's voice over this one's band, until the other takes over with its own band
    if (side === "a") return half === "low" ? outA : t < tr.start ? 1 : 0.15 * outA;
    return half === "top" ? ramp(tr.start - beat, tr.start) : ramp(mid, mid + 2 * beat);
  }
  if (tr.kind === "drop" || tr.kind === "cut") {
    const at = tr.swap;
    return side === "a" ? 1 - ramp(at - (d?.move === "brake" ? 2 * beat : 0.05), at) : ramp(at - 0.05, at);
  }
  if (tr.kind === "fade") return side === "a" ? 1 - ramp(tr.start, tr.end) : ramp(tr.start, tr.end);
  // a blend
  const bassAt = d?.bassAt ?? tr.swap;
  const outFrom = d?.outFrom ?? tr.start;
  const outEnd = d?.outEnd ?? tr.end;
  if (side === "a") {
    if (half === "low") return 1 - ramp(bassAt, bassAt + beat);
    const thin = d?.style === "filter" && t >= tr.start ? 0.55 : 1;
    return thin * (1 - ramp(outFrom, outEnd));
  }
  if (half === "low") return 0.12 + 0.88 * ramp(bassAt, bassAt + beat);
  return ramp(tr.start, Math.max(tr.start + beat, d?.inUntil ?? tr.start + (tr.end - tr.start) * 0.4));
};

/** About how long a word takes to say (in syllables), with the pause after it */
const spokenLength = (word: string) => {
  const bare = word.toLowerCase().replace(/[^a-z0-9']/g, "");
  // (numbers are said as words: "2018" is four or five syllables)
  const digits = (bare.match(/[0-9]/g) ?? []).length;
  const letters = bare.replace(/[0-9]/g, "");
  const syllables = letters ? Math.max(1, (letters.replace(/e$/, "").match(/[aeiouy]+/g) ?? []).length) : 0;
  let n = syllables + digits * 1.1 + 0.35;
  if (/[,;:\u2013\u2014-]$/.test(word)) n += 1.2;
  else if (/[.!?]["')\]]*$/.test(word)) n += 2;
  return n;
};

export const mountStage = (unloads: Set<LunaUnload>, src: StageSource) => {
  const style = el("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ------------------ DOM ------------------
  const root = el("div", R);
  const bg = el("div", "bg");
  const bgA = el("div");
  const bgB = el("div");
  bg.append(bgA, bgB);
  const frame = el("div", "frame");

  const top = el("div", "top");
  const who = el("div", "who");
  const whoName = el("strong");
  const whoSet = el("span");
  who.append(whoName, whoSet);
  const banner = el("div", "banner");
  const bannerLabel = el("small");
  const bannerTitle = el("strong");
  banner.append(bannerLabel, bannerTitle);
  const switchBtn = el("button", "btn primary", "Switch it up");
  const mashBtn = el("button", "btn", "Mashup");
  const skipBtn = el("button", "btn", "Skip");
  const djBtn = el("button", "btn primary", "Start the DJ");
  const stopBtn = el("button", "btn", "Stop DJ");
  const closeBtn = el("button", "icon");
  const upBtn = el("button", "icon thumb");
  const downBtn = el("button", "icon thumb down");
  const optionsBtn = el("button", "icon");
  for (const b of [switchBtn, mashBtn, skipBtn, djBtn, stopBtn, closeBtn, upBtn, downBtn, optionsBtn]) b.type = "button";
  mashBtn.title = "Mash this song up with one the DJ picks for it";
  closeBtn.title = "Close (Esc)";
  closeBtn.innerHTML = ICON_CLOSE;
  upBtn.innerHTML = downBtn.innerHTML = ICON_THUMB;
  optionsBtn.title = "DJ: requests and options";
  optionsBtn.innerHTML = ICON_OPTIONS;
  top.append(who, banner, el("div", "sp"), upBtn, downBtn, djBtn, switchBtn, mashBtn, skipBtn, stopBtn, optionsBtn, closeBtn);

  const main = el("div", "main");
  const fx = el("div", "fx");
  const fxImg = el("img");
  fxImg.alt = "";
  // (a picture Luna's cover transitions can measure: it is never seen)
  fxImg.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  fx.appendChild(fxImg);
  const dig = el("div", "dig");
  const digStack = el("div", "stack");
  const digText = el("p");
  dig.append(digStack, digText);
  const match = el("div", "match");
  main.append(fx, dig, match);

  const said = el("div", "said");
  const timeline = el("div", "timeline");
  const canvas = el("canvas");
  timeline.appendChild(canvas);
  const next = el("div", "next");
  const cards = el("div", "cards");
  next.append(el("h3", undefined, "Up next"), cards);

  const idle = el("div", "idle");
  const idleStart = el("button", "btn primary", "Start the DJ");
  const idleFollow = el("button", "btn", "Transitions only");
  for (const b of [idleStart, idleFollow]) b.type = "button";
  const idleActions = el("div");
  idleActions.append(idleStart, idleFollow);
  idle.append(el("h2", undefined, "DJ"), el("p", undefined, "Music picked for you and mixed track into track. Everything the DJ does shows here as it happens."), idleActions);

  frame.append(top, main, said, timeline, next);
  root.append(bg, el("div", "shade"), frame, idle);
  document.body.appendChild(root);
  const g = canvas.getContext("2d")!;

  // ------------------ STATE ------------------
  let open = false;
  let raf = 0;
  let status = src.status();
  let lastNow = 0;
  let lastNowAt = 0;
  let paused = false;
  let shownBg: string | undefined;
  let bgFront = bgA;
  let lastBeat = -1;
  const covered = new Map<string, string | null>();
  const asked = new Map<string, ((url: string) => void)[]>();
  const waves = new Map<string, Wave | null>();
  const waveAsked = new Map<string, number>();

  const coverFor = (id: string, then: (url: string) => void) => {
    const known = covered.get(id);
    if (known) return then(known);
    const list = asked.get(id);
    if (list) return void list.push(then);
    asked.set(id, [then]);
    covered.set(id, null);
    src
      .cover(id)
      .then((url) => {
        if (!url) return;
        covered.set(id, url);
        for (const fn of asked.get(id) ?? []) fn(url);
      })
      .catch(() => {})
      .finally(() => asked.delete(id));
  };
  /** What each track is called (for a cover that can't be had) */
  const names = new Map<string, string>();
  /** The cover of a track as an <img> inside `into` */
  const img = (id: string, into: HTMLElement) => {
    into.dataset.cover = id;
    coverFor(id, (url) => {
      if (into.dataset.cover !== id) return;
      let im = into.querySelector("img");
      if (!im) {
        im = el("img");
        im.alt = "";
        // (a cover TIDAL doesn't hand out, which happens: a plate with the track's name, not a broken picture)
        im.addEventListener("error", (e) => {
          (e.currentTarget as HTMLElement).remove();
          if (into.dataset.cover === id && !into.querySelector(".blank")) into.prepend(el("div", "blank", names.get(id) ?? ""));
        });
        into.querySelector(".blank")?.remove();
        into.prepend(im);
      }
      if (im.src !== url) im.src = url;
    });
  };
  /** A track's waveform, asked of the mixer once it has the track (and again a little later if it didn't yet) */
  const waveOf = (id: string) => {
    const w = waves.get(id);
    if (w) return w;
    const at = waveAsked.get(id) ?? 0;
    if (performance.now() - at > 4000) {
      waveAsked.set(id, performance.now());
      src
        .waveform(id)
        .then((wv) => {
          if (wv?.peak?.length) waves.set(id, wv);
        })
        .catch(() => {});
    }
    return undefined;
  };
  const setText = (e: HTMLElement | null, text: string) => {
    if (e && e.textContent !== text) e.textContent = text;
  };
  let mash: Mash | undefined;
  let mashAsked = 0;
  let mashBusy = false;
  /** The mashup under way, as the mixer has it (only if it is this one: the last one's is kept there too) */
  const mashOf = (tr: Live | undefined) => {
    if (!tr || tr.kind !== "mashup") return undefined;
    if (!mashBusy && performance.now() - mashAsked > 450) {
      mashAsked = performance.now();
      mashBusy = true;
      src
        .mash()
        .then((m) => (mash = m))
        .catch(() => {})
        .finally(() => (mashBusy = false));
    }
    const arr = mash?.plan;
    return arr && Math.abs(arr.from - tr.start) < 4 ? arr : undefined;
  };

  // ------------------ WHAT IS ON ------------------
  // The two tracks of the transition, whichever of them the session calls current by now (a mashup's partner is
  // "current" long before the first song stops), and where it is at
  type Scene = {
    phase: "" | "one" | "decks" | "join" | "merged";
    tr?: Live;
    a?: StageDeck;
    b?: StageDeck;
    lead?: StageDeck;
    k: number;
    /** A mix that is seconds away and came up too late for two decks (see SPLIT_MIN): the next cover waits under the playing one */
    near?: boolean;
  };
  /** Whether the two tracks of a mix are (or were) put side by side before it: decided when the mix is first seen */
  let split: { pair: string; yes: boolean } | undefined;
  const sceneOf = (st: Stage | undefined, tr: Live | undefined, t: number): Scene => {
    if (!st) return { phase: "", k: 0 };
    const byId = new Map<string, StageDeck>();
    // (the next track as it is planned to play, until it has a deck of its own)
    for (const d of [st.planned?.deck, st.outgoing, st.current, st.incoming]) if (d) byId.set(d.id, d);
    const a = tr && byId.get(tr.fromId);
    const b = tr && byId.get(tr.toId);
    if (tr && a && b && a.id !== b.id && t < tr.end && t >= tr.start - LEAD) {
      const lead = t >= tr.swap ? b : a;
      if (t >= tr.start) return { phase: "merged", tr, a, b, lead, k: 1 };
      const pair = `${a.id}>${b.id}`;
      if (split?.pair !== pair) split = { pair, yes: tr.start - t >= SPLIT_MIN };
      if (!split.yes) return { phase: "one", tr, a, b, lead, k: 0, near: true };
      const k = smooth(clamp((t - (tr.start - TRAVEL)) / TRAVEL));
      return { phase: k > 0 ? "join" : "decks", tr, a, b, lead, k };
    }
    // after a mix and until the session says so, the one that came in is the one playing
    const lead = tr && b && t >= tr.swap ? b : st.current;
    return { phase: lead ? "one" : "", tr: tr && a && b ? tr : undefined, a, b, lead, k: 0 };
  };

  // ------------------ LAYOUT ------------------
  // The cover is as big as there is room for: the DJ talking and a mix being broken down take room from it
  let geo = { W: 0, H: 0, S: 0, top: 0, C: 0, L: 0, R: 0, gap: 0 };
  let capH = 0;
  let tlH = 120;
  let sNow = 0;
  const layout = (sc: Scene, dt: number) => {
    const H = root.clientHeight;
    const W = main.clientWidth;
    const capWant = said.classList.contains("on") ? Math.min(78, said.scrollHeight + 8) : 0;
    const showing = sc.phase === "decks" || sc.phase === "join" || sc.phase === "merged" || (!!sc.tr && sc.phase === "one");
    const tlWant = showing ? Math.min(270, Math.max(190, H * 0.27)) : Math.min(140, Math.max(96, H * 0.13));
    const k = ease(dt, 5);
    capH += (capWant - capH) * k;
    tlH += (tlWant - tlH) * k;
    const mainH = Math.max(160, H - 64 - 20 - 72 - capH - tlH);
    frame.style.gridTemplateRows = `64px ${mainH.toFixed(1)}px ${capH.toFixed(1)}px ${tlH.toFixed(1)}px 72px`;
    const two = sc.phase === "decks" || sc.phase === "join";
    // (room under the cover for its name, artist and tags, with some air before the breakdown: a deck's name is
    // small and has no tags, and grows into the full one as the two come together)
    const titleRoom = two ? lerp(132, 204, sc.k) : 204;
    const sWant = Math.max(120, Math.min(mainH - titleRoom, W * 0.34));
    // (it grows into room at its ease, and makes room at once: what takes the room is eased in itself, and a cover
    // that lagged behind it would push its name into what the DJ says)
    sNow = !sNow || sWant < sNow ? sWant : sNow + (sWant - sNow) * k;
    const S = Math.round(sNow);
    const gap = Math.max(120, Math.min(170, W * 0.11));
    const topY = Math.max(4, Math.round((mainH - S - titleRoom) / 2));
    geo = { W, H: mainH, S, top: topY, C: W / 2, L: W / 2 - S / 2 - gap, R: W / 2 + S / 2 + gap, gap };
    for (const e of [fx, dig]) {
      e.style.width = e.style.height = `${S}px`;
      e.style.transform = `translate(${geo.C - S / 2}px, ${topY}px)`;
    }
    match.style.width = `${gap * 2 - 24}px`;
    match.style.height = `${S}px`;
    match.style.transform = `translate(${geo.C - gap + 12}px, ${topY}px)`;
  };

  // ------------------ COVERS ------------------
  type Pose = { x: number; scale: number; opacity: number; z: number };
  type Cv = { el: HTMLElement; tag: HTMLElement; seen: boolean; intro: boolean; pose?: Pose };
  const coverEls = new Map<string, Cv>();
  const setPose = (c: Cv, p: Pose, tag = "") => {
    c.pose = p;
    if (c.el.style.width !== `${geo.S}px`) c.el.style.width = c.el.style.height = `${geo.S}px`;
    c.el.style.transform = `translate(${(p.x - geo.S / 2).toFixed(1)}px, ${geo.top}px) scale(${p.scale.toFixed(4)})`;
    c.el.style.opacity = p.opacity.toFixed(3);
    c.el.style.zIndex = String(p.z);
    if (tag) c.tag.textContent = tag;
    c.el.classList.toggle("tagged", !!tag);
  };
  /** A new cover: lifted out of its place in "Up next" when it's there, else faded in where it goes */
  const coverEl = (id: string) => {
    let c = coverEls.get(id);
    if (!c) {
      const e = el("div", "cv");
      const tag = el("b");
      e.appendChild(tag);
      e.style.width = e.style.height = `${geo.S}px`;
      main.insertBefore(e, fx);
      img(id, e);
      c = { el: e, tag, seen: false, intro: true };
      coverEls.set(id, c);
      const card = cards.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(id)}"] .ph`);
      const box = main.getBoundingClientRect();
      if (card && box.width) {
        const r = card.getBoundingClientRect();
        const k = r.width / geo.S;
        const cx = r.left + r.width / 2 - box.left;
        const cy = r.top + r.height / 2 - box.top;
        e.style.transform = `translate(${cx - geo.S / 2}px, ${cy - geo.S / 2}px) scale(${k})`;
        card.closest(".card")?.classList.add("lifted");
      } else {
        e.style.transform = `translate(${geo.C - geo.S / 2}px, ${geo.top}px) scale(.9)`;
        e.style.opacity = "0";
      }
      void e.offsetWidth;
      e.style.transition = `transform 1s ${GLIDE}, opacity .6s ease`;
      const mine = c;
      setTimeout(() => {
        if (coverEls.get(id) === mine) {
          e.style.transition = "";
          mine.intro = false;
        }
      }, 1050);
    }
    c.seen = true;
    return c;
  };
  /** For a moment, whatever the covers do next is eased into (two decks appearing, one cover again) */
  const glide = (ms: number) => {
    for (const c of coverEls.values()) {
      if (c.intro) continue;
      c.el.style.transition = `transform ${ms}ms ${GLIDE}, opacity .6s ease`;
      clearTimeout((c.el as any).__glide);
      (c.el as any).__glide = setTimeout(() => (c.el.style.transition = ""), ms + 50);
    }
  };
  let phase = "";
  let onStage = "";
  const placeCovers = (sc: Scene, t: number) => {
    for (const c of coverEls.values()) c.seen = false;
    onStage = "";
    const { a, b, tr, k } = sc;
    if (sc.phase === "decks" || sc.phase === "join") {
      onStage = b!.id;
      setPose(coverEl(a!.id), { x: lerp(geo.L, geo.C, k), scale: 1, opacity: 1, z: 2 });
      setPose(coverEl(b!.id), { x: lerp(geo.R, geo.C, k), scale: lerp(0.9, 1, k), opacity: 1, z: 1 });
    } else if (sc.phase === "merged") {
      onStage = b!.id;
      setPose(coverEl(a!.id), { x: geo.C, scale: 1, opacity: 1, z: 2 });
      // (under the transition, which covers both; should it not be drawn, the incoming cover fades over the other)
      setPose(coverEl(b!.id), { x: geo.C, scale: 1, opacity: mixed(tr!, t), z: 3 });
    } else if (sc.lead) {
      setPose(coverEl(sc.lead.id), { x: geo.C, scale: 1, opacity: 1, z: 2 });
      // (a mix seconds away: the next cover comes out of "Up next" and waits under this one)
      if (sc.near && b && b.id !== sc.lead.id) {
        onStage = b.id;
        setPose(coverEl(b.id), { x: geo.C, scale: 1, opacity: 1, z: 1 });
      }
    }
    fx.classList.toggle("on", sc.phase === "merged");
    if (sc.phase !== phase) {
      if (sc.phase === "decks" || (sc.phase === "one" && phase !== "merged")) glide(900);
      phase = sc.phase;
    }
    for (const [id, c] of coverEls) {
      if (c.seen) {
        delete c.el.dataset.leaving;
        continue;
      }
      if (c.el.dataset.leaving) continue;
      // (gone: faded where it was)
      c.el.dataset.leaving = "1";
      c.el.style.transition = `transform .7s ${GLIDE}, opacity .5s ease`;
      if (c.pose) c.el.style.transform = `translate(${(c.pose.x - geo.S / 2).toFixed(1)}px, ${geo.top}px) scale(.94)`;
      c.el.style.opacity = "0";
      setTimeout(() => {
        if (coverEls.get(id)?.el === c.el && c.el.dataset.leaving) {
          c.el.remove();
          coverEls.delete(id);
        }
      }, 750);
    }
  };

  // ------------------ THE MATCH ------------------
  // Between the two decks: what the DJ worked out for the two of them, one card after another
  let matchKey = "";
  const renderMatch = (sc: Scene) => {
    const show = (sc.phase === "decks" || sc.phase === "join") && sc.k < 0.35;
    match.classList.toggle("on", show);
    if (!sc.tr || !sc.a || !sc.b) return;
    const tr = sc.tr;
    const d = tr.detail;
    // (a planned mix and the same one once it is scheduled: then how the drums were lined up is known too)
    const key = `${tr.seq}|${tr.fromId}|${tr.toId}`;
    if (key === matchKey) return;
    matchKey = key;
    const cards: { big: (string | HTMLElement)[]; small: string; good?: boolean }[] = [];
    const bpmA = d?.bpmA || sc.a.bpm;
    const bpmB = d?.bpmB || sc.b.bpm;
    const speed = d?.mash?.speed ?? d?.speed ?? 1;
    if (tr.kind !== "cut") {
      const moved = (speed - 1) * 100;
      cards.push({
        big: [`${bpmB.toFixed(0)}`, el("i", undefined, "→"), `${(bpmB * speed).toFixed(0)} BPM`],
        small: Math.abs(moved) < 0.1 ? "already at the same tempo" : `${moved < 0 ? "slowed down" : "sped up"} ${Math.abs(moved).toFixed(1)}% to meet ${bpmA.toFixed(0)}`,
        good: true,
      });
    }
    const kA = d?.keyA ?? sc.a.key;
    const kB = d?.keyB ?? sc.b.key;
    const semis = d?.mash?.semitones ?? 0;
    if (kA && kB && semis) {
      const moved: Key = { tonic: (((kB.tonic + semis) % 12) + 12) % 12, mode: kB.mode };
      cards.push({ big: [camelot(kB), el("i", undefined, "→"), camelot(moved)], small: `moved ${Math.abs(semis)} semitone${Math.abs(semis) > 1 ? "s" : ""} ${semis > 0 ? "up" : "down"} into ${camelot(kA)}'s key`, good: true });
    } else if (kA && kB) {
      const fit = keyFit(kA, kB);
      cards.push({ big: [camelot(kA), el("i", undefined, "→"), camelot(kB)], small: fit, good: fit !== "different keys" });
    }
    if (d?.mash) {
      const f = d.mash.fit;
      cards.push({ big: [`Notes fit ${Math.round(clamp(f) * 100)}%`], small: `${sc.b.track.title} over ${poss(sc.a.track.title)} bass, bar by bar`, good: f > 0.3 });
      cards.push({ big: ["Drums together"], small: `${Math.round(clamp(d.mash.rhythm) * 100)}% in step${d.mash.shift ? `, moved ${d.mash.shift} beat${Math.abs(d.mash.shift) > 1 ? "s" : ""}` : ""}` });
    }
    if (tr.kind === "blend") {
      const beats = d?.beats ?? Math.round((tr.end - tr.start) / (tr.beat ?? 0.5));
      const swapBar = d?.bassAt && tr.beat ? Math.round((d.bassAt - tr.start) / tr.beat / 4) + 1 : undefined;
      // (the bar the bass changes hands on is found when the mix is scheduled: a planned one doesn't name it yet)
      cards.push({ big: [`${Math.round(beats / 4)}-bar blend`], small: `${d?.style === "filter" ? "filtered, " : ""}${swapBar ? `bass swap on bar ${swapBar}` : tr.seq ? "bass swap in the middle" : "with a bass swap"}` });
    } else if (tr.kind === "mashup") {
      const way = d?.way ?? "voice";
      cards.push({
        big: ["Mashup"],
        small: way === "carry" ? `${poss(sc.a.track.title)} voice over ${poss(sc.b.track.title)} band` : way === "layer" ? `${sc.b.track.title} over ${poss(sc.a.track.title)} bass, then the bass swaps` : `${poss(sc.b.track.title)} voice over ${poss(sc.a.track.title)} band`,
      });
    } else cards.push({ big: [KIND[tr.kind]], small: tr.kind === "drop" ? (d?.move === "brake" ? "the old one brakes to a stop" : d?.move === "sweep" ? "the old one is swept away" : "the new one lands on the one") : tr.kind === "cut" ? "straight over, on the beat" : "one fades into the other" });
    if (d?.nudgeMs !== undefined && tr.kind === "blend") cards.push({ big: ["Drums lined up"], small: `moved ${d.nudgeMs} ms${d.beatShift ? `, ${d.beatShift} beat${d.beatShift > 1 ? "s" : ""} on` : ""}` });
    match.replaceChildren(
      ...cards.map((c, i) => {
        const m = el("div", c.good ? "m good" : "m");
        const big = el("strong");
        big.append(...c.big);
        m.append(big, el("span", undefined, c.small));
        m.style.transitionDelay = `${i * 140}ms`;
        return m;
      }),
    );
  };

  // ------------------ TITLES ------------------
  type Ttl = { el: HTMLElement; label: HTMLElement; h1: HTMLElement; /** the name, and TIDAL's marks after it */ t: HTMLElement; marks: HTMLElement; by: HTMLElement; tags?: HTMLElement; key: string };
  const ttl = (withTags: boolean): Ttl => {
    const e = el("div", "ttl");
    const label = el("div", "label");
    const h1 = el("h1");
    const t = el("span", "t");
    const marks = el("span", "marks");
    h1.append(t, marks);
    const by = el("div", "by");
    e.append(label, h1, by);
    const tags = withTags ? el("div", "tags") : undefined;
    if (tags) e.appendChild(tags);
    main.appendChild(e);
    return { el: e, label, h1, t, marks, by, tags, key: "" };
  };
  const nowTtl = ttl(true);
  const nextTtl = ttl(false);
  // How TIDAL marks each track (asked once a track)
  const marked = new Map<string, Marks | null>();
  const marksAsked = new Map<string, ((m: Marks) => void)[]>();
  const marksFor = (id: string, then: (m: Marks) => void) => {
    const known = marked.get(id);
    if (known) return then(known);
    const list = marksAsked.get(id);
    if (list) return void list.push(then);
    marksAsked.set(id, [then]);
    src
      .marks(id)
      .then((m) => {
        if (!m) return;
        marked.set(id, m);
        for (const fn of marksAsked.get(id) ?? []) fn(m);
      })
      .catch(() => {})
      .finally(() => marksAsked.delete(id));
  };
  // TIDAL's own badges, drawn as its page draws them (see its badge component: an <i> with the svg in it). The ones
  // TIDAL keeps in its page are used from there, so they are whatever TIDAL has now; the same drawings are kept
  // here for a page that doesn't have them. (The AI badge TIDAL writes out in place, as here.)
  const PLATE = "var(--profile-content-color, var(--market-core-fill-white-color, #fff))";
  const INK = "var(--profile-background, var(--market-core-fill-black-color, #000))";
  const BADGES: Record<keyof Marks, { title: string; symbol?: string; ratio: number; svg: string }> = {
    explicit: {
      title: "Explicit",
      symbol: "explicit-badge",
      ratio: 1,
      svg: `<svg viewBox="0 0 16 16" fill="none"><rect width="16" height="16" rx="4" fill="${PLATE}"/><path d="M5.97215 11V4.7H10.1392V5.627H7.05215V7.301H9.70715V8.21H7.05215V10.073H10.1932V11H5.97215Z" fill="${INK}"/></svg>`,
    },
    ai: {
      title: "AI-generated",
      ratio: 1,
      svg: `<svg viewBox="0 0 16 16" fill="none"><rect width="16" height="16" rx="4" fill="${PLATE}"/><path d="M3.77102 11L6.18302 4.7H7.40702L9.81902 11H8.68502L7.06502 6.563L6.83102 5.834H6.75902L6.53402 6.563L4.90502 11H3.77102ZM4.95002 9.488V8.57H8.64002V9.488H4.95002ZM10.6128 11V4.7H11.6928V11H10.6128Z" fill="${INK}"/></svg>`,
    },
    upload: {
      title: "Uploaded",
      symbol: "uploaded-badge",
      ratio: 1,
      svg: `<svg viewBox="0 0 16 16" fill="none"><rect width="16" height="16" rx="4" fill="var(--profile-content-color, white)" fill-opacity="0.1"/><path d="M11.8042 6.91092C12.0621 7.16013 12.0698 7.57163 11.8208 7.82986C11.5718 8.08787 11.1603 8.09511 10.9019 7.84646L8.64995 5.67459V11.8543C8.64952 12.2129 8.35824 12.5037 7.99956 12.5037C7.64083 12.5037 7.34959 12.2129 7.34917 11.8543L7.34917 5.67654L5.09819 7.84646C4.83987 8.09521 4.42835 8.08778 4.17924 7.82986C3.93026 7.57158 3.93789 7.16011 4.19584 6.91092L7.54936 3.67849C7.80114 3.43581 8.19994 3.43579 8.4517 3.67849L11.8042 6.91092Z" fill="var(--profile-content-color, white)" fill-opacity="0.55"/></svg>`,
    },
    // (Dolby's double D)
    atmos: {
      title: "Dolby Atmos",
      symbol: "atmos-logo",
      ratio: 15 / 14,
      svg: `<svg viewBox="0 0 15 14" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.88264 4H3V9.99999H3.88264C5.53074 9.99999 6.87419 8.65274 6.87419 6.99998C6.87419 5.34725 5.53074 4 3.88264 4ZM10.628 10H11.5106V4.00001H10.628C8.97986 4.00001 7.6364 5.34726 7.6364 7C7.6364 8.65275 8.97986 10 10.628 10Z" fill="#B2B2BF"/><rect x="0.5" y="0.5" width="13.5106" height="13" rx="1.5" stroke="#EBEBFF" stroke-opacity="0.2"/></svg>`,
    },
  };
  const MARKS = ["explicit", "ai", "upload", "atmos"] as const;
  const badge = (key: keyof Marks) => {
    const b = BADGES[key];
    const mark = el("i");
    mark.title = b.title;
    mark.dataset.mark = key;
    mark.style.aspectRatio = String(b.ratio);
    mark.innerHTML = b.symbol && document.getElementById(b.symbol) ? `<svg><use href="#${b.symbol}" width="100%" height="100%"></use></svg>` : b.svg;
    return mark;
  };
  const fillTrack = (d: StageDeck) => (b: Ttl) => {
    b.t.textContent = titleOf(d);
    b.by.textContent = artistsOf(d);
    b.marks.replaceChildren();
    marksFor(d.id, (m) => {
      // (the name may have changed hands since it was asked)
      if (b.key !== d.id || b.t.textContent !== titleOf(d)) return;
      b.marks.replaceChildren(...MARKS.filter((key) => m[key]).map(badge));
    });
  };
  /** The title changes (at the swap, a skip, a mashup): the old one lifts away, the new one comes up */
  const replace = (b: Ttl, key: string, fill: (b: Ttl) => void, unseen = false) => {
    if (b.key === key) return;
    // (one that isn't in sight is simply filled in: the last name it had isn't shown leaving)
    if (!b.key || unseen) {
      b.key = key;
      for (const p of [b.h1, b.by]) for (const an of p.getAnimations()) an.cancel();
      return fill(b);
    }
    b.key = key;
    const parts = [b.h1, b.by];
    for (const p of parts) p.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-12px)" }], { duration: 220, easing: "ease-in", fill: "forwards" });
    setTimeout(() => {
      // (it has changed again meanwhile: that one fills it in)
      if (b.key !== key) return;
      fill(b);
      for (const p of parts) p.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: GLIDE, fill: "forwards" });
    }, 230);
  };
  const placeTtl = (b: Ttl, x: number, width: number, size: number, opacity: number) => {
    b.el.style.width = `${Math.round(width)}px`;
    b.el.style.transform = `translate(${(x - width / 2).toFixed(1)}px, ${geo.top + geo.S + 12}px)`;
    b.el.style.opacity = opacity.toFixed(3);
    b.h1.style.fontSize = `${size.toFixed(1)}px`;
    b.by.style.fontSize = `${Math.max(14, size * 0.42).toFixed(1)}px`;
  };
  let tagsKey = "";
  let nextSeen = false;
  const NOTE_FOR = 8000;
  let noteShown: string | undefined;
  let noteAt = 0;
  let beatPill: HTMLElement | undefined;
  /** "15 Jun 2012"; only the year when that is all there is (a release dated the first of January is one with only a year on it) */
  const released = (date?: string) => {
    const m = /^(\d{4})(?:-(\d{2})-(\d{2}))?/.exec(date ?? "");
    if (!m || Number(m[1]) <= 1900) return "";
    if (!m[2] || (m[2] === "01" && m[3] === "01")) return m[1];
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
    return month ? `${m[3] ? `${Number(m[3])} ` : ""}${month} ${m[1]}` : m[1];
  };
  const renderTitles = (sc: Scene, t: number) => {
    const { tr, b, k } = sc;
    const mashing = tr?.kind === "mashup" && !!tr.songs && sc.phase === "merged";
    const lead = sc.lead;
    const big = clamp(geo.S * 0.14, 28, 64);
    const small = clamp(geo.S * 0.085, 18, 30);
    const two = sc.phase === "decks" || sc.phase === "join";
    if (mashing) {
      setText(nowTtl.label, "Mashup");
      nowTtl.label.classList.remove("accent");
      replace(nowTtl, `m|${tr!.songs!.a}|${tr!.songs!.b}`, (bl) => {
        bl.t.replaceChildren(tr!.songs!.a, el("span", "x2", " × "), tr!.songs!.b);
        bl.marks.replaceChildren();
        bl.by.textContent = [tr!.songs!.artistA, tr!.songs!.artistB].filter(Boolean).join(" × ");
      });
    } else if (lead) {
      // Over the name: the mix that is seconds away, else what the DJ is busy with (when the records over the cover
      // aren't saying it), else what it had to say about the last thing asked of it
      const doing = !two && status.mode !== "follow" && !dig.classList.contains("on") ? status.busy : undefined;
      const coming = tr && b && lead.id !== b.id && (sc.near || sc.phase === "merged") ? `${NEXT[tr.kind]} ${titleOf(b)}${t < tr.start ? ` · ${mmss(tr.start - t)}` : ""}` : undefined;
      // (what it had to say stays up for a few seconds: the session keeps it until the next thing is asked)
      const note = !two && status.note && performance.now() - noteAt < NOTE_FOR ? status.note : undefined;
      setText(nowTtl.label, coming ?? (doing ? `${doing}…` : (note ?? "Now playing")));
      nowTtl.label.classList.toggle("accent", !!(coming ?? doing));
      replace(nowTtl, lead.id, fillTrack(lead));
    } else {
      setText(nowTtl.label, status.phase === "starting" ? "Getting ready" : "");
      nowTtl.label.classList.remove("accent");
      nowTtl.key = "";
      setText(nowTtl.t, "");
      nowTtl.marks.replaceChildren();
      setText(nowTtl.by, "");
    }
    if (two) {
      placeTtl(nowTtl, lerp(geo.L, geo.C, k), lerp(geo.S + 80, geo.W * 0.8, k), lerp(small, big, k), clamp(1 - Math.sin(Math.PI * k) * 0.6));
      replace(nextTtl, b!.id, fillTrack(b!), !nextSeen);
      nextSeen = true;
      setText(nextTtl.label, `${NEXT[tr!.kind]} ${mmss(Math.max(0, tr!.start - t))}`);
      nextTtl.label.classList.add("accent");
      placeTtl(nextTtl, lerp(geo.R, geo.C, k), geo.S + 80, small, clamp(1 - k * 3));
    } else {
      placeTtl(nowTtl, geo.C, geo.W * 0.8, big, 1);
      nextTtl.el.style.opacity = "0";
      nextSeen = false;
    }
    // tempo (as it is heard: a track sped up or slowed down shows it), key, when it came out, where it's at
    const tags = nowTtl.tags!;
    if (lead) {
      const shift = (lead.rate - 1) * 100;
      const parts = [
        `${(lead.bpm * lead.rate).toFixed(0)} BPM${Math.abs(shift) >= 0.1 ? ` (${shift > 0 ? "+" : "−"}${Math.abs(shift).toFixed(1)}%)` : ""}`,
        lead.key ? `${camelot(lead.key)} · ${NOTES[lead.key.tonic]} ${lead.key.mode}` : "",
        released(lead.track.album?.releaseDate),
        `${mmss(lead.pos)} / ${mmss(lead.duration)}`,
      ].filter(Boolean);
      const key = parts.join("|");
      if (key !== tagsKey) {
        tagsKey = key;
        tags.replaceChildren(
          ...parts.map((part, i) => {
            const s = el("span");
            if (i === 0) {
              s.classList.add("beat");
              beatPill = s;
            }
            s.append(part);
            return s;
          }),
        );
      }
      // the tempo's outline flashes on the beat
      if (lead.period > 0 && !paused && lead.started && (lead.startsAt ?? 0) <= t) {
        const beat = Math.floor((lead.pos - lead.phase) / lead.period);
        if (beat !== lastBeat) {
          lastBeat = beat;
          beatPill?.animate([{ boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,.9)" }, { boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0)" }], { duration: Math.min(400, lead.period * 900), easing: "ease-out" });
        }
      }
    } else if (tagsKey) {
      tagsKey = "";
      tags.replaceChildren();
    }
    tags.style.opacity = two ? String(k) : "1";
  };

  // ------------------ DIGGING ------------------
  // While the DJ looks for music (picking a set, asking TIDAL, finding a song to mash up with), records flick past
  // over the cover. A record it has pulled out (a song it is trying for a mashup, the one it then puts it together
  // with) lands on top and stays there for as long as it is busy with it. Only while one cover is on the stage with
  // no mix on or coming up: two decks, and a mix being played out, are never covered.
  type Dig = { text: string; hold?: string; pool: string[] };
  let digTimer: ReturnType<typeof setInterval> | undefined;
  let digDots: ReturnType<typeof setInterval> | undefined;
  let digClear: ReturnType<typeof setTimeout> | undefined;
  let digLabel: HTMLElement | undefined;
  let digHeld: string | undefined;
  let stack: HTMLElement[] = [];
  const DEPTH = 6;
  const place = (i: number) => `translate(${i * 2}px, ${-i * 3}px) rotate(${(i % 2 ? 1 : -1) * i * 1.2}deg)`;
  const restack = () =>
    stack.forEach((c, i) => {
      c.style.transform = place(i);
      c.style.zIndex = String(10 - i);
    });
  const record = (id: string) => {
    const card = el("div", "rec");
    card.dataset.id = id;
    img(id, card);
    digStack.appendChild(card);
    return card;
  };
  /** The one on top flicks away and goes to the back */
  const flick = () => {
    if (stack.length < 2) return;
    const topCard = stack.shift()!;
    stack.push(topCard);
    topCard.animate(
      [
        { transform: topCard.style.transform, opacity: 1 },
        { transform: "translate(-70%, -18%) rotate(-16deg)", opacity: 0, offset: 0.55 },
        { transform: place(stack.length - 1), opacity: 0 },
      ],
      { duration: 520, easing: "cubic-bezier(.3,.1,.3,1)" },
    );
    for (const c of stack) c.style.transition = `transform .4s ${GLIDE}`;
    restack();
  };
  /** A record is pulled out: it lands on top of the others */
  const pull = (id: string) => {
    let card = stack.find((c) => c.dataset.id === id);
    if (card && card === stack[0]) return;
    if (card) stack.splice(stack.indexOf(card), 1);
    else card = record(id);
    stack.unshift(card);
    for (const c of stack.splice(DEPTH)) c.remove();
    for (const c of stack) c.style.transition = `transform .4s ${GLIDE}`;
    restack();
    card.animate(
      [
        { transform: "translate(70%, -18%) rotate(16deg)", opacity: 0 },
        { transform: place(0), opacity: 1 },
      ],
      { duration: 520, easing: GLIDE },
    );
  };
  /** The records that flick past: what is coming up (never what is playing, or has played), as far as their covers are at hand */
  const fillStack = (pool: string[]) => {
    const ids = pool.filter((id) => covered.get(id) && !stack.some((c) => c.dataset.id === id)).sort(() => Math.random() - 0.5);
    if (!ids.length) return;
    for (const id of ids.slice(0, DEPTH - stack.length)) stack.push(record(id));
    restack();
  };
  const digging = (d: Dig | undefined) => {
    const on = !!d;
    if (on !== dig.classList.contains("on")) {
      dig.classList.toggle("on", on);
      main.classList.toggle("digging", on);
      clearInterval(digTimer);
      digTimer = undefined;
      clearInterval(digDots);
      clearTimeout(digClear);
      digHeld = undefined;
      const empty = () => {
        stack = [];
        digStack.replaceChildren();
      };
      // (the records stay as they are while they fade away)
      if (!on) return void (digClear = setTimeout(empty, 450));
      empty();
      digLabel = el("span");
      const dots = el("i", undefined, "");
      digText.replaceChildren(digLabel, dots);
      let n = 0;
      digDots = setInterval(() => (dots.textContent = ".".repeat((n++ % 3) + 1)), 350);
    }
    if (!d) return;
    setText(digLabel ?? null, d.text);
    if (stack.length < DEPTH) fillStack(d.pool);
    if (d.hold) {
      clearInterval(digTimer);
      digTimer = undefined;
      if (digHeld !== d.hold) pull((digHeld = d.hold));
    } else {
      digHeld = undefined;
      digTimer ??= setInterval(flick, 560);
    }
  };

  // ------------------ THE BREAKDOWN ------------------
  const draw = (sc: Scene, st: Stage | undefined, t: number) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = timeline.clientWidth;
    const H = timeline.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!st || H < 40) return;
    const tr = sc.tr;
    const pair = !!tr && !!sc.a && !!sc.b;
    // what's shown: 40 s around now; for a mix that's coming, from now to just past its end
    const span = pair && tr!.end - t > 30 ? Math.min(90, tr!.end - t + 12) / 0.7 : 40;
    const playX = Math.round(W * 0.3);
    const pps = W / span;
    const xOf = (time: number) => playX + (time - t) * pps;
    const tOf = (x: number) => t + (x - playX) / pps;
    g.font = `500 12px ${T.text}`;
    const mashing = tr?.kind === "mashup";
    const arr = mashOf(tr);

    // rows: the tempo (when there's room), the marks, then a lane for each track
    const tempoH = pair && H > 170 ? 48 : 0;
    // (two rows of labels: ones that would run into each other go one under the other)
    const marksH = pair ? 46 : 18;
    const lanesTop = tempoH + marksH;
    const gap = pair ? 12 : 0;
    const laneH = pair ? Math.max(30, (H - lanesTop - 22 - gap) / 2) : Math.max(30, H - lanesTop - 10);
    const lanes: { d: StageDeck; color: RGB; side: "a" | "b"; y: number }[] = [];
    if (pair) {
      lanes.push({ d: sc.a!, color: WHITE, side: "a", y: lanesTop });
      lanes.push({ d: sc.b!, color: ACCENT, side: "b", y: lanesTop + laneH + gap });
    } else if (sc.lead) lanes.push({ d: sc.lead, color: WHITE, side: "a", y: lanesTop });

    // the stretch the two overlap
    if (pair) {
      const x0 = Math.max(0, xOf(tr!.start));
      const x1 = Math.min(W, xOf(tr!.end));
      if (x1 > x0) {
        const grd = g.createLinearGradient(x0, 0, x1, 0);
        grd.addColorStop(0, "rgba(255,255,255,.06)");
        grd.addColorStop(1, "rgba(51,255,238,.08)");
        g.fillStyle = grd;
        g.beginPath();
        g.roundRect(x0, lanesTop - 4, x1 - x0, laneH * 2 + gap + 8, 6);
        g.fill();
      }
    }

    // each track's waveform, its top half and its bass half each lit for as long as they are heard
    const col = 2;
    for (const { d, color, side, y } of lanes) {
      const map = d.map?.length ? d.map : [{ t: (d.swap ?? t) - d.pos, pos: 0, rate: 1 }];
      const mid = y + laneH / 2;
      const half = laneH / 2 - 1;
      const wave = waveOf(d.id);
      for (let x = 0; x < W; x += col) {
        const tm = tOf(x);
        const p = posAt(map, tm);
        if (p < 0 || p > d.duration) continue;
        let pk = 0.5;
        let rm = 0.4;
        if (wave) {
          const i = Math.floor(p * wave.rate);
          const n = Math.max(1, Math.ceil((col / pps) * wave.rate * rateAt(map, tm)));
          pk = 0;
          rm = 0;
          for (let k = 0; k < n; k++) {
            pk = Math.max(pk, wave.peak[i + k] ?? 0);
            rm = Math.max(rm, wave.rms[i + k] ?? 0);
          }
          // (a little fuller than linear, so quiet passages still have a shape)
          pk = Math.pow(pk / 255, 0.75);
          rm = Math.pow(rm / 255, 0.75);
        }
        const past = tm < t ? 0.35 : 1;
        for (const h of ["top", "low"] as Half[]) {
          const on = pair ? heardOf(tr!, side, h, tm, arr) : 1;
          const a = past * (0.12 + 0.78 * on);
          const s = 0.3 + 0.7 * on;
          const dir = h === "top" ? -1 : 1;
          g.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(a * 0.45).toFixed(3)})`;
          g.fillRect(x, dir < 0 ? mid - pk * half * s : mid, col - 0.6, pk * half * s);
          g.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${a.toFixed(3)})`;
          g.fillRect(x, dir < 0 ? mid - rm * half * s : mid, col - 0.6, rm * half * s);
        }
      }
      // what the halves are, at the start of the lane
      if (pair) {
        g.textAlign = "left";
        g.font = `600 11px ${T.text}`;
        g.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},.85)`;
        const voiced = mashing && arr?.halves !== "bass";
        g.fillText(voiced ? "voice" : "top", 4, mid - half + 11);
        g.fillText(voiced ? "band" : "bass", 4, mid + half - 3);
        g.font = `500 12px ${T.text}`;
      }
    }

    // beats: each track's ticked off beside its lane, where the two overlap; there they meet, one above the other
    if (pair && !mashing) {
      for (const { d, color, side, y } of lanes) {
        if (!(d.period > 0) || !d.map?.length) continue;
        const map = d.map;
        const from = Math.max(tr!.start, tOf(0)) - 1;
        const to = Math.min(tr!.end, tOf(W)) + 1;
        const k0 = Math.ceil((posAt(map, from) - d.phase) / d.period);
        const edge = side === "a" ? y + laneH + 1 : y - 1;
        for (let k = k0; ; k++) {
          const tm = timeAt(map, d.phase + k * d.period);
          if (tm > to || k - k0 > 600) break;
          if (tm < tr!.start || tm > tr!.end) continue;
          const x = xOf(tm);
          if (x < 0 || x > W) continue;
          const down = ((k % 4) + 4) % 4 === 0;
          const len = down ? gap / 2 : gap / 4;
          g.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${down ? 0.9 : 0.45})`;
          g.fillRect(Math.round(x) - 0.5, side === "a" ? edge : edge - len, 1, len);
        }
      }
    }

    // the tempo each is heard at: slowed down or sped up to meet the other, and back to its own
    if (tempoH) {
      const decks = [lanes[0], lanes[1]];
      let lo = Infinity;
      let hi = -Infinity;
      const bpmAt = (d: StageDeck, tm: number) => {
        const map = d.map?.length ? d.map : [{ t: (d.swap ?? t) - d.pos, pos: 0, rate: 1 }];
        let r = rateAt(map, tm);
        // (where the mixer's own record of it runs out, the plan says how it glides back)
        const det = tr!.detail;
        if (d === sc.b && det?.glideAt !== undefined && det.glide && map.length < 3 && tm > det.glideAt) r = lerp(det.speed ?? r, 1, smooth(clamp((tm - det.glideAt) / det.glide)));
        return d.bpm * r;
      };
      const samples = decks.map(({ d, side }) =>
        Array.from({ length: Math.ceil(W / 6) + 1 }, (_, i) => {
          const tm = tOf(i * 6);
          const p = posAt(d.map?.length ? d.map : [{ t: (d.swap ?? t) - d.pos, pos: 0, rate: 1 }], tm);
          const heard = p >= 0 && p <= d.duration && (heardOf(tr!, side, "top", tm, arr) > 0.05 || heardOf(tr!, side, "low", tm, arr) > 0.2);
          const v = bpmAt(d, tm);
          if (heard) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
          return heard ? v : NaN;
        }),
      );
      if (Number.isFinite(lo)) {
        const pad = Math.max(2, (hi - lo) * 0.25);
        lo -= pad;
        hi += pad;
        const yOf = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (tempoH - 14);
        decks.forEach(({ color }, di) => {
          g.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},.9)`;
          g.lineWidth = 2;
          g.beginPath();
          let down = false;
          samples[di].forEach((v, i) => {
            if (!Number.isFinite(v)) return void (down = false);
            const x = i * 6;
            if (!down) g.moveTo(x, yOf(v));
            else g.lineTo(x, yOf(v));
            down = true;
          });
          g.stroke();
        });
        // the tempos now
        g.textAlign = "left";
        g.font = `600 12px ${T.text}`;
        let lx = playX + 8;
        decks.forEach(({ d, color, side }) => {
          if (!(heardOf(tr!, side, "top", t, arr) > 0.05 || heardOf(tr!, side, "low", t, arr) > 0.2)) return;
          const v = bpmAt(d, t);
          const label = `${v.toFixed(1)} BPM`;
          g.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},1)`;
          g.fillText(label, lx, 14);
          lx += g.measureText(label).width + 14;
        });
        g.font = `500 12px ${T.text}`;
      }
    }

    // every move, where it happens
    if (pair) {
      const d = tr!.detail;
      const marks: { at: number; label: string; strong?: boolean }[] = [];
      const bpmB = d?.bpmB || sc.b!.bpm;
      if (mashing && arr) {
        const short = (x: StageDeck) => (x.track.title.length > 18 ? `${x.track.title.slice(0, 17)}…` : x.track.title);
        const named = (what: string) =>
          what
            .replace(/\bA's\b/g, poss(short(sc.a!)))
            .replace(/\bB's\b/g, poss(short(sc.b!)))
            .replace(/\bA\b/g, short(sc.a!))
            .replace(/\bB\b/g, short(sc.b!));
        // (said once for as long as it stays the same: blocks that follow each other doing the same thing are one stretch)
        const playing = blockAt(arr, t);
        let stretch: { at: number; label: string; strong?: boolean } | undefined;
        let until = -Infinity;
        for (const b of [...arr.blocks].sort((x, y) => x.from - y.from)) {
          const label = named(b.what);
          if (!stretch || stretch.label !== label || b.cut || b.from > until + 0.05) marks.push((stretch = { at: b.from, label, strong: b.cut }));
          if (b === playing) stretch.strong = true;
          until = b.to;
        }
        // who sings where
        for (const b of arr.blocks) {
          for (const { side, y, color } of lanes) {
            if (!b.sings?.[side]) continue;
            const x0 = Math.max(0, xOf(b.from) + 6);
            if (x0 > W - 40 || xOf(b.to) < 0) continue;
            g.font = `600 11px ${T.text}`;
            g.textAlign = "left";
            g.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},.95)`;
            g.fillText("♪ sings", x0 + 40, y + 11);
            g.font = `500 12px ${T.text}`;
          }
        }
        // what is still to be decided
        const u0 = undecidedFrom(arr);
        if (u0 < arr.end - 0.5) {
          const x0 = Math.max(0, xOf(u0));
          const x1 = Math.min(W, xOf(arr.end));
          if (x1 > x0) {
            g.save();
            g.beginPath();
            g.rect(x0, lanesTop, x1 - x0, laneH * 2 + gap);
            g.clip();
            g.strokeStyle = "rgba(255,255,255,.08)";
            g.lineWidth = 6;
            for (let x = x0 - (laneH * 2 + gap); x < x1; x += 16) {
              g.beginPath();
              g.moveTo(x, lanesTop + laneH * 2 + gap);
              g.lineTo(x + laneH * 2 + gap, lanesTop);
              g.stroke();
            }
            g.restore();
            marks.push({ at: u0, label: "decided as it comes up, by who sings" });
          }
        }
        if (mash?.cut) marks.push({ at: mash.cut, label: "cut short: the voices weren't ready", strong: true });
        marks.push({ at: arr.end, label: `${short(sc.b!)} on its own` });
        // how the taking out of the voices keeps up
        const feeds = mash?.feeds ?? [];
        if (feeds.length && t < arr.end) {
          const parts = feeds.map((f) => `${Math.min(f.played, f.wanted)}/${f.wanted}`);
          const ahead = Math.min(...feeds.map((f) => (f.spare === null ? Infinity : f.spare)));
          const text = `Voices taken out: ${parts.join(" · ")} pieces${Number.isFinite(ahead) ? ` · ${ahead.toFixed(1)} s ahead` : ""}${feeds.some((f) => f.missed) ? ` · ${feeds.reduce((n, f) => n + f.missed, 0)} done without` : ""}`;
          g.textAlign = "right";
          g.fillStyle = "#afafb6";
          g.fillText(text, W - 4, tempoH ? 14 : lanesTop - 30);
        }
      } else if (mashing) {
        marks.push({ at: tr!.start, label: d?.way === "carry" ? "Voice over the other band" : d?.way === "layer" ? "Layered over the bass" : "Voice over the band", strong: true });
        if (tr!.mid) marks.push({ at: tr!.mid, label: "Takeover" });
      } else if (tr!.kind === "blend") {
        marks.push({ at: tr!.start, label: d?.style === "filter" ? "Mix in · filtered" : "Mix in" });
        marks.push({ at: d?.bassAt ?? tr!.swap, label: d?.bassAt !== undefined || tr!.seq ? "Bass swap" : "Bass swap, about here", strong: true });
      } else marks.push({ at: tr!.swap, label: tr!.kind === "drop" ? (d?.move === "brake" ? "Brake · drop" : d?.move === "sweep" ? "Sweep · drop" : "Drop") : tr!.kind === "cut" ? "Cut" : "Handover", strong: true });
      if (d?.glideAt !== undefined && d.glide && d.speed && Math.abs(d.speed - 1) > 0.001) marks.push({ at: d.glideAt + d.glide, label: `Back to ${bpmB.toFixed(0)} BPM` });
      // (a mashup ends on the other song on its own: said above)
      if (!(mashing && arr)) marks.push({ at: d?.outEnd ?? tr!.end, label: "Out" });
      marks.sort((x, y) => x.at - y.at);
      let lastRight = -Infinity;
      let row = 0;
      for (const m of marks) {
        const x = xOf(m.at);
        if (x < -40 || x > W + 40) continue;
        g.fillStyle = m.strong ? "rgba(255,255,255,.8)" : "rgba(255,255,255,.35)";
        g.fillRect(Math.round(x) - 0.5, tempoH + 4, 1, H - tempoH - 8);
        const w = g.measureText(m.label).width + 14;
        row = x - w / 2 < lastRight + 6 ? 1 - row : 0;
        const ly = tempoH + 2 + row * 21;
        const lx = clamp(x - w / 2, 0, W - w);
        g.fillStyle = m.strong ? "#fff" : "rgba(37,37,37,.85)";
        g.beginPath();
        g.roundRect(lx, ly, w, 18, 9);
        g.fill();
        g.fillStyle = m.strong ? "#000" : "#e4e4e7";
        g.textAlign = "center";
        g.fillText(m.label, lx + w / 2, ly + 13);
        if (row === 0) lastRight = lx + w;
      }
    }

    // now
    g.fillStyle = "#fff";
    g.fillRect(playX - 1, Math.max(0, lanesTop - 6), 2, H - Math.max(0, lanesTop - 6));
    if (!pair) {
      g.textAlign = "center";
      g.fillText("Now", playX, lanesTop - 4);
    }
  };

  // ------------------ A NEW SET ------------------
  let bannerAnim: Animation | undefined;
  const announce = (label: string, title: string) => {
    bannerLabel.textContent = label;
    bannerTitle.textContent = title;
    bannerAnim?.cancel();
    top.classList.add("announcing");
    bannerAnim = banner.animate(
      [
        { opacity: 0, transform: "translate(-12px, -50%)" },
        { opacity: 1, transform: "translate(0, -50%)", offset: 0.08 },
        { opacity: 1, transform: "translate(0, -50%)", offset: 0.88 },
        { opacity: 0, transform: "translate(0, -50%)" },
      ],
      { duration: 5000, easing: "ease" },
    );
    bannerAnim.finished.then(
      () => top.classList.remove("announcing"),
      () => {},
    );
  };

  // ------------------ UP NEXT ------------------
  let queueKey = "";
  const renderQueue = (st: Stage | undefined) => {
    // (the one beside the cover as the next deck is on the stage already)
    const list = (st?.upcoming ?? []).filter((u) => u.track.id !== onStage);
    const key = list.map((u) => u.track.id + u.set).join(",") + (st?.follow ? "f" : "") + (st ? "" : "-");
    if (key === queueKey) return;
    queueKey = key;
    // (the ones that stay move to their new places from where they were; new ones come in one after another)
    const before = new Map<string, DOMRect>();
    const old = new Map<string, HTMLElement>();
    for (const c of [...cards.children] as HTMLElement[]) {
      if (!c.dataset.id || c.classList.contains("gone")) continue;
      before.set(c.dataset.id, c.getBoundingClientRect());
      old.set(c.dataset.id, c);
    }
    const kept: HTMLElement[] = [];
    let lastSet = st?.current?.set;
    for (const u of list) {
      let c = old.get(u.track.id);
      if (c) old.delete(u.track.id);
      else {
        c = el("div", "card");
        c.dataset.id = u.track.id;
        const ph = el("div", "ph");
        const text = el("div");
        text.append(el("strong", undefined, u.track.title), el("span", undefined, artistsOf(u)));
        c.append(ph, text);
        img(u.track.id, ph);
      }
      c.classList.remove("lifted");
      c.querySelector("em")?.remove();
      // (where a new set begins, its name)
      if (u.set !== lastSet && !st?.follow) {
        c.lastElementChild?.prepend(el("em", undefined, u.set));
        lastSet = u.set;
      }
      kept.push(c);
    }
    // (the ones that go are taken out of the row where they are, so that what comes in doesn't queue up behind them
    // and jump into place once they are gone)
    const leaving = [...old.values()].map((c) => ({ c, x: c.offsetLeft, y: c.offsetTop }));
    for (const { c, x, y } of leaving) {
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
      c.classList.add("gone");
      setTimeout(() => c.remove(), 500);
    }
    cards.querySelector(".none")?.remove();
    for (const c of kept) cards.appendChild(c);
    if (!list.length) cards.prepend(el("div", "none", st?.follow ? "Whatever plays next in TIDAL is mixed in" : st ? "Picking what's next…" : ""));
    let fresh = 0;
    for (const c of kept) {
      const was = before.get(c.dataset.id!);
      const is = c.getBoundingClientRect();
      c.style.transition = "none";
      c.style.transform = was ? `translateX(${was.left - is.left}px)` : "translateY(24px)";
      if (!was) c.style.opacity = "0";
      c.dataset.delay = was ? "0" : String(fresh++ * 90);
    }
    void cards.offsetWidth;
    for (const c of kept) {
      c.style.transition = "";
      c.style.transitionDelay = `${c.dataset.delay}ms`;
      c.style.transform = "";
      c.style.opacity = "";
    }
  };

  // ------------------ EACH FRAME ------------------
  const transitionNow = (s: Status, t: number): Live | undefined => {
    const tr = s.phase === "playing" || s.phase === "starting" ? s.transition : undefined;
    if (!tr || t > tr.end + 1) return undefined;
    return { ...tr, p: clamp((t - tr.start) / Math.max(0.1, tr.end - tr.start)) };
  };
  let lastFrame = 0;
  const tick = (time: number) => {
    raf = 0;
    if (!open) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, lastFrame ? (time - lastFrame) / 1000 : 1);
    lastFrame = time;
    status = src.status();
    const st = status.phase === "off" ? undefined : src.stage();
    const t = st?.now ?? 0;
    // (the mixer's clock stands still while TIDAL is paused)
    if (Math.abs(t - lastNow) > 1e-4) {
      lastNow = t;
      lastNowAt = time;
    }
    paused = !!st && time - lastNowAt > 350;
    for (const d of [st?.current, st?.outgoing, st?.incoming, st?.planned?.deck, ...(st?.upcoming ?? [])]) if (d && !names.has(d.track.id)) names.set(d.track.id, d.track.title);
    // The mix that is scheduled, or, until it is (which is only seconds ahead), the one that is planned
    const armed = transitionNow(status, t);
    const ahead = !armed && status.phase === "playing" && st?.planned && st.planned.transition.start - t <= LEAD ? st.planned.transition : undefined;
    const sc = sceneOf(st, armed ?? (ahead ? { ...ahead, p: 0 } : undefined), t);
    layout(sc, dt);
    placeCovers(sc, t);
    renderMatch(sc);
    // Records flick past while the DJ looks for music, with one cover on the stage and no mix on or coming up
    const busy = status.mode !== "follow" ? status.busy : undefined;
    const calm = sc.phase === "" || (sc.phase === "one" && !sc.tr);
    const pool = (st?.upcoming ?? []).map((u) => u.track.id);
    digging(status.phase === "starting" ? { text: busy ?? "Getting ready", pool } : busy && calm && (lookingForMusic(busy) || status.busyTrack) ? { text: busy, hold: status.busyTrack, pool } : undefined);
    renderTitles(sc, t);
    draw(sc, st, t);
    renderQueue(st);
    followCaption(t);
    showThumbs(time);

    // background: the cover of what is playing (the incoming one once it has taken over)
    const bgUrl = sc.lead ? covered.get(sc.lead.id) : undefined;
    if (bgUrl && bgUrl !== shownBg) {
      shownBg = bgUrl;
      const back = bgFront === bgA ? bgB : bgA;
      back.style.backgroundImage = `url("${bgUrl.replace(/"/g, "%22")}")`;
      back.classList.add("on");
      bgFront.classList.remove("on");
      bgFront = back;
    }
  };

  // ------------------ STATUS ------------------
  /** The caption's words and when each is heard (the mixer's clock at what is heard, as Stage.now) */
  let caption: { words: { el: HTMLElement; at: number }[]; shown: number } | undefined;
  const showWords = (words: HTMLElement[], shown: number) => {
    words.forEach((w, i) => w.classList.toggle("done", i < shown));
    // (two lines are shown: the words being said are kept in them)
    const at = words[Math.min(words.length - 1, shown - 1)];
    if (at) said.scrollTop = Math.max(0, at.offsetTop - said.offsetTop - said.clientHeight / 2);
  };
  const followCaption = (t: number) => {
    if (!caption) return;
    let shown = 0;
    while (shown < caption.words.length && caption.words[shown].at <= t) shown++;
    if (shown === caption.shown) return;
    caption.shown = shown;
    showWords(
      caption.words.map((w) => w.el),
      shown,
    );
  };
  let captionShown = "";
  let captionTimer: ReturnType<typeof setInterval> | undefined;
  let segmentShown: string | undefined;
  let setShown: string | undefined;
  let mashShown = -1;
  const render = (s: Status, first = false) => {
    status = s;
    const mode = s.phase === "off" ? "off" : s.mode === "follow" ? "follow" : "dj";
    root.dataset.mode = mode;
    setText(whoName, mode === "follow" ? "Transitions only" : mode === "off" ? "DJ" : `DJ ${src.persona()}`);
    setText(whoSet, mode === "dj" ? (s.segment ?? "") : mode === "follow" ? "Mixing whatever you play" : "");
    // a new set (the DJ's pick, a switch-up, a request): its name comes up
    if (s.note !== noteShown) {
      noteShown = s.note;
      // (one that was there before the full screen was opened is old news)
      noteAt = first ? 0 : performance.now();
    }
    // (not the set a mashup's other song goes back into: that one was on already)
    const segment = mode === "dj" ? s.segment : undefined;
    if (segment !== segmentShown) {
      if (segment && !/^Mashup:/.test(segment)) {
        if (!first && segment !== setShown) announce("New set", segment);
        setShown = segment;
      } else if (!segment) setShown = undefined;
      segmentShown = segment;
    }
    if (s.transition?.kind === "mashup" && s.transition.seq !== mashShown && s.transition.songs) {
      if (!first) announce("Mashup", `${s.transition.songs.a} × ${s.transition.songs.b}`);
      mashShown = s.transition.seq;
    }
    switchBtn.style.display = mode === "dj" ? "" : "none";
    mashBtn.style.display = mode === "dj" ? "" : "none";
    skipBtn.style.display = mode === "dj" ? "" : "none";
    stopBtn.style.display = mode === "dj" ? "" : "none";
    djBtn.style.display = mode === "follow" ? "" : "none";
    // what the DJ says, word by word as it is heard, as TIDAL shows lyrics
    const text = s.caption ?? "";
    if (text !== captionShown) {
      captionShown = text;
      clearInterval(captionTimer);
      said.replaceChildren();
      said.scrollTop = 0;
      caption = undefined;
      if (text) {
        const parts = text.split(/\s+/).filter(Boolean);
        const words = parts.map((w) => {
          const span = el("span", "w", w + " ");
          said.appendChild(span);
          return span;
        });
        if (s.captionSpan && s.captionSpan.end > s.captionSpan.start) {
          // Where each word falls in the line: the line's first sound to its last are known to the sample (see the
          // session's say), and the words share that time by how long each takes to say (and the pauses after them)
          const weights = parts.map(spokenLength);
          const total = weights.reduce((x, y) => x + y, 0) || 1;
          const { start, end } = s.captionSpan;
          let acc = 0;
          caption = {
            words: words.map((w, i) => {
              const at = start + (acc / total) * (end - start);
              acc += weights[i];
              return { el: w, at };
            }),
            shown: -1,
          };
        } else {
          // (a line whose timing isn't known: at about the pace the DJ speaks)
          const began = performance.now();
          const step = () => {
            const shown = Math.floor((performance.now() - began) / 320) + 1;
            showWords(words, shown);
            if (shown >= words.length) clearInterval(captionTimer);
          };
          step();
          captionTimer = setInterval(step, 100);
        }
      }
    }
    said.classList.toggle("on", !!text);
  };

  // ------------------ OPEN / CLOSE ------------------
  const onKey = (e: KeyboardEvent) => {
    if (!open || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // (Esc closes the panel first, when it is open over this)
    if (src.panel.isOpen()) src.panel.close();
    else close();
  };

  // The buttons go out of sight once the mouse has been still for a while (not while it is on one of them, or the
  // DJ's panel is open), and are back the moment it moves
  const REST_AFTER = 3000;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMouse = "";
  const stir = () => {
    root.classList.remove("resting");
    clearTimeout(restTimer);
    if (!open) return;
    restTimer = setTimeout(() => {
      if (!open) return;
      if (src.panel.isOpen() || top.querySelector(".btn:hover, .icon:hover")) return stir();
      root.classList.add("resting");
    }, REST_AFTER);
  };
  const onMouse = (e: MouseEvent) => {
    // (a mouse that hasn't moved still reports a move when what is under it changes)
    const at = `${e.screenX},${e.screenY}`;
    if (e.type === "mousemove" && at === lastMouse) return;
    lastMouse = at;
    stir();
  };
  root.addEventListener("mousemove", onMouse);
  root.addEventListener("mousedown", onMouse);

  // TrueTaste's thumbs on what is playing, as they are in the player bar
  let thumbsAt = 0;
  let thumbsShown: 1 | -1 | 0 | undefined | null = null;
  const showThumbs = (now: number, force = false) => {
    if (!force && now - thumbsAt < 400) return;
    thumbsAt = now;
    const v = status.phase === "off" ? undefined : src.feedback.state();
    if (v === thumbsShown) return;
    thumbsShown = v;
    upBtn.style.display = downBtn.style.display = v === undefined ? "none" : "";
    upBtn.classList.toggle("on", v === 1);
    downBtn.classList.toggle("on", v === -1);
    upBtn.title = v === 1 ? "TrueTaste: more like this (click to undo)" : "TrueTaste: more like this";
    downBtn.title = v === -1 ? "TrueTaste: less like this (click to undo)" : "TrueTaste: less like this (skips the song)";
  };
  for (const [b, v] of [
    [upBtn, 1],
    [downBtn, -1],
  ] as const)
    b.addEventListener("click", () => {
      src.feedback.give(v);
      showThumbs(performance.now(), true);
    });
  optionsBtn.addEventListener("click", () => src.panel.toggle(optionsBtn));

  let offStatus: (() => void) | undefined;
  const openStage = () => {
    if (open) return;
    open = true;
    root.classList.add("open");
    stir();
    showThumbs(performance.now(), true);
    queueKey = "";
    tagsKey = "";
    matchKey = "";
    nowTtl.key = "";
    nextTtl.key = "";
    phase = "";
    sNow = 0;
    lastFrame = 0;
    offStatus = src.onStatus((s) => render(s));
    render(src.status(), true);
    raf = requestAnimationFrame(tick);
    // (once it is laid out: the cover transitions are drawn on it from now on)
    requestAnimationFrame(() => requestAnimationFrame(() => open && src.fxSurface(fxImg)));
  };
  const close = () => {
    if (!open) return;
    open = false;
    root.classList.remove("open", "resting");
    clearTimeout(restTimer);
    if (src.panel.isOpen()) src.panel.close();
    cancelAnimationFrame(raf);
    raf = 0;
    offStatus?.();
    offStatus = undefined;
    clearInterval(captionTimer);
    digging(undefined);
    src.fxSurface(undefined);
  };

  closeBtn.addEventListener("click", close);
  switchBtn.addEventListener("click", () => src.switchUp());
  mashBtn.addEventListener("click", () => src.mashup());
  skipBtn.addEventListener("click", () => src.skip());
  stopBtn.addEventListener("click", () => src.stop());
  djBtn.addEventListener("click", () => src.start());
  idleStart.addEventListener("click", () => src.start());
  idleFollow.addEventListener("click", () => src.startFollow());
  window.addEventListener("keydown", onKey, true);

  const dispose = () => {
    close();
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    style.remove();
  };
  unloads.add(dispose);
  return { open: openStage, close, isOpen: () => open };
};
