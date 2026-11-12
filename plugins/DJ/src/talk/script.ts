// What the DJ says. Lines are assembled from facts the DJ actually has (what the set is, where it comes
// from in your listening, what plays first) in each voice's own manner, and never the same wording twice
// in a row. No language model: it's instant, private, and can't make things up about you.
import type { Segment, Track } from "../brain";
import type { Persona } from "../config";

type Tone = Persona["tone"];
export type Moment =
  | { type: "open"; segment: Segment; firstEver: boolean; sameDay: boolean }
  | { type: "segment"; segment: Segment; prev?: Segment }
  | { type: "switch"; segment: Segment }
  | { type: "request"; segment: Segment }
  // One song into the next, the way a radio presenter does it: what that was, and what this is
  | { type: "track"; track: Track; prev?: Track; facts: TrackFacts }
  | { type: "signoff" };
/** What is known about a song that's worth a word: when it came out, and what it is to you */
export type TrackFacts = { year?: number; liked?: boolean; fresh?: boolean };
export type Context = { name?: string; tone: Tone; less: boolean };

// ------------------ SAYING NAMES ------------------
/** Titles and artist names in a form a voice can read: no brackets, credits or symbols */
export const speakable = (s: string) => {
  let out = s
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "")
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo|bonus|deluxe|single|from ).*$/i, "")
    .replace(/\bfeat\.?\s.*$/i, "")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[/\\|_*~^<>{}=#]+/g, " ")
    .replace(/\$/g, "s")
    .replace(/\s+/g, " ")
    .trim();
  // SHOUTED NAMES are read letter by letter otherwise; short ones may really be initials
  out = out.replace(/\b[\p{Lu}]{5,}\b/gu, (w) => w[0] + w.slice(1).toLowerCase());
  // The sentence around it brings its own punctuation
  out = out.replace(/[.!?,;:\s]+$/, "");
  return out || s;
};
/** The voice speaks English: names in other scripts, or made of symbols, are left unsaid rather than mangled */
const sayable = (s: string) => /\p{Script=Latin}{2}/u.test(s) && !/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}]/u.test(s);
const artistOf = (t: Track) => {
  const a = speakable(t.artists[0]?.name ?? "");
  return sayable(a) ? a : "";
};
const titleOf = (t: Track) => {
  const title = speakable(t.title);
  return sayable(title) ? title : "";
};
const artistName = (name?: string) => {
  const a = speakable(name ?? "");
  return sayable(a) ? a : "this artist";
};

// ------------------ VARIETY ------------------
const recent: string[] = [];
/** A random option, avoiding the ones used most recently */
const one = (options: (string | undefined | false)[]): string => {
  const list = options.filter((o): o is string => !!o);
  if (!list.length) return "";
  const fresh = list.filter((o) => !recent.includes(o));
  const pickFrom = fresh.length ? fresh : list;
  const chosen = pickFrom[Math.floor(Math.random() * pickFrom.length)];
  recent.push(chosen);
  if (recent.length > 40) recent.shift();
  return chosen;
};
const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

const daypart = (h = new Date().getHours()) => (h < 5 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening");

// ------------------ PARTS ------------------
const greeting = (ctx: Context) => {
  const n = ctx.name ? `, ${ctx.name}` : "";
  const part = daypart();
  const timed = part === "night" ? `Hey${n}. Up late` : `Good ${part}${n}`;
  switch (ctx.tone) {
    case "hype":
      return one([`Hey${n}!`, `${timed}!`, `There you are${n}!`]);
    case "dry":
      return one([`Hello${n}.`, `${timed}.`, `Ah${n ? `${n}` : ", hello"}.`]);
    case "chill":
      return one([`Hey${n}.`, `${timed}.`, `What's up${n}.`]);
    default:
      return one([`Hey${n}.`, `${timed}.`, `Hi${n}.`]);
  }
};

const selfIntro = (m: Extract<Moment, { type: "open" }>, ctx: Context) => {
  if (m.firstEver) {
    return one([
      "I'm your DJ. I'll pick the music, mix it together, and let you know what's coming up.",
      "I'm your DJ. I know what you've been listening to, so I'll take it from here. Press the DJ button any time you want something different.",
    ]);
  }
  if (m.sameDay) return one(["Welcome back.", "Back for more. Good.", ctx.tone === "dry" ? "You again. I'm flattered." : "Good to have you back."]);
  switch (ctx.tone) {
    case "hype":
      return one(["It's your DJ, and I've got a good one lined up.", "Your DJ's here. Let's get into it."]);
    case "dry":
      return one(["It's your DJ. I've been going through your listening. Don't worry, I'm not judging. Much.", "Your DJ here. I've had a look at what you've been playing."]);
    case "chill":
      return one(["It's your DJ. Let's take it easy and see where this goes.", "Your DJ here. I've got some things lined up for you."]);
    default:
      return one(["It's your DJ. I've put a few things together for you.", "Your DJ here. I've been looking at what you've been playing."]);
  }
};

/** What this set is and why it was picked */
const about = (s: Segment, ctx: Context, opening: boolean): string => {
  const f = s.facts;
  const t = ctx.tone;
  switch (s.kind) {
    case "onRepeat":
      return one([
        opening ? "Let's start with what you've had on repeat lately." : "Back to what you've had on repeat lately.",
        "These are the ones you keep coming back to at the moment.",
        t === "dry" ? "Here's the stuff you can't seem to stop playing. I've noticed." : "Here's the stuff you can't seem to stop playing.",
        t === "hype" && "Your current obsessions, back to back.",
      ]);
    case "recentLikes":
      return one(["You've been hitting the heart on some good ones recently. Let's run through a few.", "Here are some of your latest likes.", "Some of the tracks you saved recently, coming up."]);
    case "throwback":
      if (f.month && f.year) {
        return one([
          `Let's rewind to ${f.month} ${f.year}. This is what you had on heavy rotation back then.`,
          `Remember ${f.month} ${f.year}? Here's what you were playing the most that month.`,
          `Time for a throwback. ${f.month} ${f.year}, to be exact. These were your most played.`,
          t === "dry" && `Let's see who you were in ${f.month} ${f.year}. This is what you had on repeat.`,
        ]);
      }
      return one([`Let's go back to the ${f.season} of ${f.year}, when you first liked these.`, `Time for a throwback. These are from your ${f.season} of ${f.year}.`]);
    case "taste":
      return one([
        `Let's lean into your ${f.genre} side for a bit.`,
        `Next, a run of ${f.genre}. It's a big part of what you listen to.`,
        t === "dry" ? `Some ${f.genre} now. You've got decent taste here, I'll admit.` : `Some ${f.genre} now. You've got good taste here.`,
        t === "chill" && `Let's settle into some ${f.genre}.`,
      ]);
    case "discovery":
      return one([
        "Now for some things you haven't heard yet. I picked these based on what you've been playing.",
        "Time for something new. None of these are in your library, but I think they'll fit right in.",
        "Let me put you on to a few new ones.",
        t === "dry" && "Some new music now. Trust me on these.",
        t === "hype" && "New music time! You haven't heard any of these yet.",
      ]);
    case "artist":
      return one([
        `Let's put the spotlight on ${artistName(f.artist)} for a few songs. Some you know, and one or two you might not.`,
        `You've been listening to a lot of ${artistName(f.artist)}. Let's stay with them for a bit.`,
        `A few from ${artistName(f.artist)} now, including something you may not have heard.`,
      ]);
    case "forgotten":
      return one([
        "Here are some old favourites you haven't played in a while.",
        "You used to love these, and it's been a minute. Let's bring them back.",
        t === "dry" ? "Some songs you've been neglecting. They've noticed." : "Some songs that deserve another listen.",
      ]);
    case "mood":
      if (f.daypart === "morning") return one(["Let's ease into the morning with something gentle.", "Something easy to start the day."]);
      if (f.daypart === "afternoon") return one(["Let's pick the energy up for the afternoon.", "Something with a bit more energy for the afternoon."]);
      if (f.daypart === "evening") return one(["Here's something for the evening.", "Let's set the mood for the evening."]);
      return one(["It's late, so let's keep things atmospheric.", "Some late night music now."]);
    case "more":
      if (f.genre) {
        return one([
          opening ? `I'll keep things in this lane: more ${f.genre} coming up.` : `Staying with the ${f.genre}.`,
          `More ${f.genre}, coming up.`,
          `Let's keep the ${f.genre} going.`,
          t === "dry" && `More ${f.genre}. You didn't say stop.`,
          t === "hype" && `We're not leaving the ${f.genre} yet!`,
          t === "chill" && `We'll stay right here with the ${f.genre}.`,
        ]);
      }
      return one(["More in the same vein.", "Let's keep this going.", "Staying right where we are.", opening && "I'll keep things in this lane."]);
    case "dailyMix":
      return one(["Here's a run from one of your mixes.", "A few picks from one of your daily mixes."]);
    case "request":
      switch (f.matched) {
        case "artist":
          return one([`Some ${artistName(f.artist)}, coming right up.`, `${artistName(f.artist)} it is.`, `Here's a run of ${artistName(f.artist)}.`]);
        case "radio":
          return one(["More like that one, coming up.", "I liked that one too. Here's more in the same spirit."]);
        case "year":
          return one([`Back to ${f.year} it is. Here's what you were listening to.`, `Here's your ${f.year}.`]);
        default: {
          // What TIDAL's AI named the result says what was understood, in a few words
          const named = f.aiTitle && sayable(speakable(f.aiTitle)) && f.aiTitle.length <= 48 ? speakable(f.aiTitle) : "";
          if (named) {
            return one([
              `Here's what I put together: ${named}.`,
              `${named}. That's what I've got for you.`,
              `I went with ${named}.`,
              t === "hype" && `Okay! ${named}, let's go.`,
              t === "dry" && `${named}. As requested.`,
              t === "chill" && `I've lined up ${named}.`,
            ]);
          }
          return one(["Here's what I put together for that.", "This is what I found for you.", "Let's see how this feels."]);
        }
      }
  }
  return "";
};

const firstUp = (s: Segment, ctx: Context) => {
  const t = s.tracks[0];
  if (!t) return "";
  const a = artistOf(t);
  const title = titleOf(t);
  // Long or unpronounceable titles: just the artist
  const short = !!title && title.length <= 34;
  if (s.kind === "artist" || (s.kind === "request" && s.facts.matched === "artist")) return short ? one([`Starting with ${title}.`, `First up, ${title}.`, `Here's ${title}.`]) : "";
  if (!a) return "";
  return one([
    short && `First up, ${a}, with ${title}.`,
    short && `Starting with ${title}, by ${a}.`,
    short && `Here's ${a}, with ${title}.`,
    `Starting with ${a}.`,
    ctx.tone === "hype" && short && `Kicking off with ${a}. This is ${title}.`,
    ctx.tone === "chill" && `We'll start with ${a}.`,
  ]);
};

const bridge = (prev: Segment | undefined, ctx: Context) => {
  const last = prev?.tracks.at(-1);
  if (!last || Math.random() < 0.35) return "";
  const a = artistOf(last);
  const title = titleOf(last);
  const short = !!title && title.length <= 30;
  return one([
    a && `That was ${a}.`,
    a && short && `That was ${title}, by ${a}.`,
    prev?.kind === "throwback" && "Good memories.",
    prev?.kind === "discovery" && "Hope a few of those stuck.",
    ctx.tone === "dry" && "Right. Moving on.",
    ctx.tone === "hype" && "Okay, that was good.",
  ]);
};

/** A song introduced on its own: a word about the one before, the name of this one, and now and then something about it */
const between = (m: Extract<Moment, { type: "track" }>, ctx: Context) => {
  const t = ctx.tone;
  const a = artistOf(m.track);
  const title = titleOf(m.track);
  const short = !!title && title.length <= 34;
  const pa = m.prev ? artistOf(m.prev) : "";
  const pt = m.prev ? titleOf(m.prev) : "";
  const prevShort = !!pt && pt.length <= 30;
  const same = !!a && a === pa;
  // What that was (not every time: a presenter doesn't either)
  const back =
    m.prev && pa && Math.random() < 0.7
      ? one([
          `That was ${pa}.`,
          prevShort && `That was ${pt}, by ${pa}.`,
          prevShort && `${pa}, with ${pt}.`,
          prevShort && `You just heard ${pt}, by ${pa}.`,
          t === "hype" && `${pa}! Love that one.`,
          t === "dry" && `${pa}. Fine choice, if I say so myself.`,
        ])
      : "";
  // What this is
  let next = "";
  if (same && short) next = one([`Staying with ${a}: here's ${title}.`, `More from ${a} now. This is ${title}.`, `Another one from ${a}, ${title}.`]);
  else if (a) {
    next = one([
      short && `Up next, ${a}, with ${title}.`,
      short && `Here's ${title}, by ${a}.`,
      short && `Now, ${a}. This is ${title}.`,
      short && `Coming up, ${title}, by ${a}.`,
      short && `This is ${a}, and ${title}.`,
      `Next up, ${a}.`,
      `Here's ${a}.`,
      t === "hype" && short && `Turn it up: ${a}, ${title}!`,
      t === "dry" && short && `Next, ${a}. It's called ${title}.`,
      t === "chill" && short && `Easing into ${title}, by ${a}.`,
    ]);
  } else if (short) next = one([`Up next, ${title}.`, `Here's ${title}.`, `This one is called ${title}.`]);
  else next = one(["Here's the next one.", "On to the next.", "Let's keep it moving."]);
  // Something about it, every other time or so, and only what is actually known
  const f = m.facts;
  const age = f.year ? new Date().getFullYear() - f.year : 0;
  const colour =
    Math.random() < 0.55
      ? one([
          f.fresh && "You haven't heard this one yet.",
          f.fresh && "This one's new to you.",
          f.fresh && t === "dry" && "New to you. Trust me.",
          f.liked && "One of your favourites.",
          f.liked && "You've had this one saved for a while.",
          f.liked && t === "hype" && "You love this one!",
          !!f.year && age >= 3 && `That's from ${f.year}.`,
          !!f.year && age >= 8 && `Taking it back to ${f.year}.`,
          !!f.year && age >= 15 && `A classic, from ${f.year}.`,
          !!f.year && age <= 1 && "Fresh out, this one.",
        ])
      : "";
  return join(back, next, colour);
};

// Short lines that never mention a track, generated once per voice and kept, so they're there instantly
export const GENERIC = {
  switch: ["Alright, switching it up.", "Okay, let's try something different.", "Sure, let's change it up.", "Changing gears."],
  request: ["You got it.", "Good call.", "On it.", "Sure thing."],
  signoff: ["That's it from me. Catch you next time.", "I'll leave it there. See you soon.", "Signing off. Enjoy the rest of your day."],
  hello: ["Hey, it's your DJ. Let's get into it.", "Your DJ here. Let's go."],
};
export type GenericKind = keyof typeof GENERIC;

/** The full line for a moment, in the voice's manner */
export const lineFor = (m: Moment, ctx: Context): string => {
  switch (m.type) {
    case "open":
      if (ctx.less) return join(greeting(ctx), one(["Let's get into it.", "Here we go.", "Let's go."]));
      return join(greeting(ctx), selfIntro(m, ctx), about(m.segment, ctx, true), firstUp(m.segment, ctx));
    case "segment":
      return join(bridge(m.prev, ctx), about(m.segment, ctx, false), firstUp(m.segment, ctx));
    case "switch":
      return join(one(GENERIC.switch), about(m.segment, ctx, false), Math.random() < 0.6 && firstUp(m.segment, ctx));
    case "request":
      return join(about(m.segment, ctx, false), firstUp(m.segment, ctx));
    case "track":
      return between(m, ctx);
    case "signoff":
      return one(GENERIC.signoff);
  }
};
