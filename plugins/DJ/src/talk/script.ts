// What the DJ says. Lines are assembled from facts the DJ actually has (what the set is, where it comes
// from in your listening, what plays first, when a song came out and what it is to you, what the one
// before it was like, how long you have been listening, what TrueTaste has gathered about your taste)
// in each voice's own manner, with a word of its own now and then: it is a presenter, not a list of
// facts. It remembers what it has said, across sessions, and reaches for the wording and the kind of
// thing it has gone longest without. No language model: it's instant, private, and can't make things
// up about you.
import type { Segment, Track } from "../brain";
import type { Persona } from "../config";
import { readDoc, writeDoc } from "../store.native";

type Tone = Persona["tone"];
export type Moment =
  | { type: "open"; segment: Segment; firstEver: boolean; sameDay: boolean; facts?: TrackFacts }
  | { type: "segment"; segment: Segment; prev?: Segment; facts?: TrackFacts }
  | { type: "switch"; segment: Segment; facts?: TrackFacts }
  | { type: "request"; segment: Segment; facts?: TrackFacts }
  // One song into the next, the way a radio presenter does it: what that was, and what this is
  | { type: "track"; track: Track; prev?: Track; facts: TrackFacts; /** what is known about the song before it */ prevFacts?: TrackFacts }
  | { type: "signoff" };
/** What is known about a song that's worth a word: when it came out, what it is to you, how it sounds, and how it sits next to the one before */
export type TrackFacts = {
  year?: number;
  /** The day it came out, where TIDAL has one: year, month (0-11), day */
  date?: [number, number, number];
  /** The album it is on, where that isn't just the song's own name */
  album?: string;
  liked?: boolean;
  /** When you liked it (epoch ms) */
  likedAt?: number;
  /** You haven't heard it */
  fresh?: boolean;
  /** How many times you have played it, as far as was counted, and when last (epoch ms) */
  plays?: number;
  lastPlayed?: number;
  /** A month of your past in which it was among your most played */
  topMonth?: { month: string; year: number };
  /** How many songs by its artist are in your library; or that the artist is new to you */
  artistSongs?: number;
  newArtist?: boolean;
  seconds?: number;
  bpm?: number;
  explicit?: boolean;
  /** Which version of the song this is, where it isn't the plain one */
  version?: "remix" | "live" | "acoustic" | "remaster" | "extended" | "instrumental" | "sped up" | "slowed";
  /** Which of your tastes it belongs to (its name) */
  genre?: string;
  // From TrueTaste, when that plugin is there with data:
  /** You gave it a thumbs up */
  thumbsUp?: boolean;
  /** TrueTaste recommended it to you (when: epoch ms) */
  foundAt?: number;
  /** You first heard it in Your Daily Discovery */
  daily?: boolean;
  /** Whether you play it to the end */
  finishes?: "always" | "rarely";
  /** Whether you cut its artist's songs short */
  artistSkips?: "often" | "never";
  /** Its artist is among those you play most, or one you follow */
  topArtist?: boolean;
  favArtist?: boolean;
  /** The tempo your music usually has */
  usualBpm?: number;
  /** The song before it */
  prev?: { year?: number; bpm?: number; sameAlbum?: boolean };
};
/** What you like, in a few words: your tastes by how much of your music they are (TrueTaste's reading of them when it is there) */
export type Taste = { fromTrueTaste: boolean; listens: number; top: { label: string; share: number; trend?: number }[]; drift?: number };
/** Where things stand: how often and how long ago the DJ was last on, how long and how many songs this session has run, where the next song sits in its set */
export type Here = { sessions?: number; sinceLast?: number; minutes?: number; songs?: number; place?: { index: number; of: number }; taste?: Taste };
export type Context = { name?: string; tone: Tone; less: boolean; /** the DJ's own name */ dj?: string; here?: Here };

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
// What has been said, and when (a count that goes up with every choice made): kept across sessions, so
// the DJ doesn't open every evening with the same words. A wording is remembered without the names and
// numbers in it ("That was §, by §."), so the same sentence about another song counts as the same.
type Said = { seq: number; at: Record<string, number> };
const said: Said = { seq: 0, at: {} };
let saidTimer: ReturnType<typeof setTimeout> | undefined;
void readDoc("said")
  .then((json) => {
    const kept = json ? (JSON.parse(json) as Partial<Said>) : null;
    if (!kept?.at) return;
    // (what was said since this started loading comes after what was kept)
    const since = said.seq;
    for (const [k, v] of Object.entries(said.at)) said.at[k] = v + (kept.seq ?? 0);
    for (const [k, v] of Object.entries(kept.at)) said.at[k] ??= v;
    said.seq = since + (kept.seq ?? 0);
  })
  .catch(() => {});
const remember = (key: string) => {
  said.at[key] = ++said.seq;
  saidTimer ??= setTimeout(() => {
    saidTimer = undefined;
    const keys = Object.entries(said.at).sort((a, b) => b[1] - a[1]);
    for (const [k] of keys.slice(1200)) delete said.at[k];
    writeDoc("said", JSON.stringify(said)).catch(() => {});
  }, 5000);
};
/** The names in the line being written, longest first: taken out of a wording before it is remembered */
let masks: string[] = [];
const keyOf = (s: string) => {
  let k = s;
  for (const m of masks) k = k.split(m).join("§");
  return k.replace(/\d+/g, "#");
};
/** How long ago something was said (the higher the more recent; never: below zero, in no particular order) */
const lastSaid = (key: string) => said.at[key] ?? -Math.random();
/** One of the options: one of those it has gone longest without saying */
const one = (options: (string | undefined | false)[]): string => {
  const list = [...new Set(options.filter((o): o is string => !!o))];
  if (!list.length) return "";
  const aged = list.map((o) => ({ o, at: lastSaid(keyOf(o)) })).sort((a, b) => a.at - b.at);
  const pool = aged.slice(0, Math.max(1, Math.ceil(aged.length / 2)));
  const chosen = pool[Math.floor(Math.random() * pool.length)].o;
  remember(keyOf(chosen));
  return chosen;
};
const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

const daypart = (h = new Date().getHours()) => (h < 5 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
const DAY = 864e5;
/** A stretch of time in words: "3 weeks", "about 2 months", "over a year", "almost 4 years" */
const span = (ms: number) => {
  const days = ms / DAY;
  if (days < 12) return `${Math.max(2, Math.round(days))} days`;
  if (days < 50) return `${Math.round(days / 7)} weeks`;
  if (days < 320) return `about ${Math.round(days / 30.4)} months`;
  const years = days / 365.25;
  if (years < 1.25) return "about a year";
  if (years < 1.8) return "over a year";
  const whole = Math.floor(years);
  return years - whole > 0.75 ? `almost ${whole + 1} years` : years - whole > 0.3 ? `over ${whole} years` : `${whole} years`;
};

// ------------------ PARTS ------------------
const greeting = (ctx: Context) => {
  const n = ctx.name ? `, ${ctx.name}` : "";
  const now = new Date();
  const part = daypart(now.getHours());
  const timed = part === "night" ? `Hey${n}. Up late` : `Good ${part}${n}`;
  const day = DAYS[now.getDay()];
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  switch (ctx.tone) {
    case "hype":
      return one([`Hey${n}!`, `${timed}!`, `There you are${n}!`, `Look who it is${n ? `. Hey${n}` : ""}!`, `Happy ${day}${n}!`, ctx.name && `${ctx.name}! Good to see you.`, weekend && `It's the weekend${n}!`]);
    case "dry":
      return one([`Hello${n}.`, `${timed}.`, `Ah${n ? `${n}` : ", hello"}.`, `Well${n}. Here we are.`, `${day}${n}. Again.`, ctx.name && `${ctx.name}. Right on time.`]);
    case "chill":
      return one([`Hey${n}.`, `${timed}.`, `What's up${n}.`, `Nice to see you${n}.`, `Easy ${day}${n}.`, `Hey${n}. Come on in.`]);
    default:
      return one([`Hey${n}.`, `${timed}.`, `Hi${n}.`, `Hello${n}.`, `Happy ${day}${n}.`, `Good to see you${n}.`, ctx.name && `${ctx.name}, hi.`]);
  }
};

const selfIntro = (m: Extract<Moment, { type: "open" }>, ctx: Context) => {
  if (m.firstEver) {
    return one([
      "I'm your DJ. I'll pick the music, mix it together, and let you know what's coming up.",
      "I'm your DJ. I know what you've been listening to, so I'll take it from here. Press the DJ button any time you want something different.",
    ]);
  }
  // (by its own name, now and then)
  if (ctx.dj && !m.sameDay && Math.random() < 0.35) {
    const dj = ctx.dj;
    return one([
      `${dj} here. I've got some music lined up.`,
      `It's ${dj}, your DJ. Let's get into it.`,
      `This is ${dj}, and I'm all yours.`,
      ctx.tone === "hype" && `It's ${dj}! Your DJ, your music, let's go.`,
      ctx.tone === "dry" && `${dj} speaking. Yes, still me.`,
      ctx.tone === "chill" && `${dj} here. Settle in.`,
      ctx.tone === "warm" && `${dj} here. Lovely to have you.`,
    ]);
  }
  if (m.sameDay) {
    return one([
      "Welcome back.",
      "Back for more. Good.",
      ctx.tone === "dry" ? "You again. I'm flattered." : "Good to have you back.",
      "Round two.",
      "Picking up where we left off.",
      "I kept the decks warm.",
      ctx.tone === "hype" && "Couldn't stay away, could you!",
      ctx.tone === "chill" && "Back again. Let's ease into it.",
    ]);
  }
  switch (ctx.tone) {
    case "hype":
      return one([
        "It's your DJ, and I've got a good one lined up.",
        "Your DJ's here. Let's get into it.",
        "Your DJ, ready when you are.",
        "I've been digging through your music, and I'm excited about this one.",
        "It's your DJ. This is going to be fun.",
        "Your DJ on the decks. Let's make some noise.",
      ]);
    case "dry":
      return one([
        "It's your DJ. I've been going through your listening. Don't worry, I'm not judging. Much.",
        "Your DJ here. I've had a look at what you've been playing.",
        "It's your DJ. I read your history so you don't have to.",
        "Your DJ. I've made some decisions on your behalf.",
        "It's your DJ. I have opinions about your library. Mostly good ones.",
      ]);
    case "chill":
      return one([
        "It's your DJ. Let's take it easy and see where this goes.",
        "Your DJ here. I've got some things lined up for you.",
        "It's your DJ. No rush, I've got this.",
        "Your DJ here. Sit back, I'll drive.",
        "It's your DJ. I've pulled a few things I think you'll like.",
      ]);
    default:
      return one([
        "It's your DJ. I've put a few things together for you.",
        "Your DJ here. I've been looking at what you've been playing.",
        "It's your DJ. I've got some music lined up.",
        "Your DJ here, with a few ideas for today.",
        "It's your DJ. Let me take it from here.",
      ]);
  }
};

/** Something about how long it has been, or how many times: when there is something to say about that */
const reunion = (ctx: Context): string => {
  const here = ctx.here;
  if (!here) return "";
  const t = ctx.tone;
  const count = here.sessions;
  if (count && [10, 25, 50, 100, 150, 200, 300, 500, 1000].includes(count + 1) && !onceSaid.has(`sessions:${count}`)) {
    onceSaid.add(`sessions:${count}`);
    return one([
      `This is our ${ordinal(count + 1)} session, by the way.`,
      `Session number ${count + 1}. We should celebrate.`,
      t === "dry" && `Session ${count + 1}. I've stopped counting. I haven't.`,
      t === "hype" && `Session number ${count + 1}! Look at us go.`,
    ]);
  }
  const gone = here.sinceLast;
  if (gone === undefined) return "";
  if (gone < 40 * 60e3) return one(["Miss me already?", "That was a short break.", "Back so soon. Good.", t === "dry" && "You were gone for minutes. I counted.", t === "hype" && "You're back! I knew you would be."]);
  if (gone > 30 * DAY) {
    return one([`It's been ${span(gone)}! Where have you been?`, `${span(gone)} since last time. I kept your seat.`, `Look who's back after ${span(gone)}.`, t === "dry" && `${span(gone)}. I'd nearly forgotten your face. I never knew your face.`]);
  }
  if (gone > 3 * DAY) {
    return one([
      `It's been ${span(gone)}. I was starting to wonder.`,
      `${span(gone)} without me. How did you cope?`,
      `Good to have you back after ${span(gone)}.`,
      t === "dry" && `${span(gone)}. Not that I was counting.`,
      t === "hype" && `${span(gone)}! I missed this.`,
      t === "chill" && `${span(gone)} away. No hurry, you're here now.`,
    ]);
  }
  return "";
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
        "A few from your heavy rotation right now.",
        "The songs you've been wearing out lately, one after the other.",
        "What you've been playing most these days.",
        t === "hype" && "Your current obsessions, back to back.",
        t === "chill" && "Some of your regulars lately. No surprises, just the good ones.",
      ]);
    case "recentLikes":
      return one([
        "You've been hitting the heart on some good ones recently. Let's run through a few.",
        "Here are some of your latest likes.",
        "Some of the tracks you saved recently, coming up.",
        "A few of the newest additions to your likes.",
        "The ones you've liked most recently, back to back.",
        t === "dry" && "You've been liking things again. Let's review.",
      ]);
    case "throwback":
      if (f.month && f.year) {
        return one([
          `Let's rewind to ${f.month} ${f.year}. This is what you had on heavy rotation back then.`,
          `Remember ${f.month} ${f.year}? Here's what you were playing the most that month.`,
          `Time for a throwback. ${f.month} ${f.year}, to be exact. These were your most played.`,
          `Back to ${f.month} ${f.year}. This is what your month sounded like.`,
          `A trip to ${f.month} ${f.year} now. You had these on all the time.`,
          t === "dry" && `Let's see who you were in ${f.month} ${f.year}. This is what you had on repeat.`,
          t === "hype" && `Throwback time! ${f.month} ${f.year}, and you were playing these non-stop.`,
        ]);
      }
      return one([
        `Let's go back to the ${f.season} of ${f.year}, when you first liked these.`,
        `Time for a throwback. These are from your ${f.season} of ${f.year}.`,
        `The ${f.season} of ${f.year} now. You saved all of these back then.`,
      ]);
    case "taste":
      return one([
        `Let's lean into your ${f.genre} side for a bit.`,
        `Next, a run of ${f.genre}. It's a big part of what you listen to.`,
        t === "dry" ? `Some ${f.genre} now. You've got decent taste here, I'll admit.` : `Some ${f.genre} now. You've got good taste here.`,
        `A bit of ${f.genre} now. You come back to it a lot.`,
        `Your ${f.genre} corner, for a few songs.`,
        `Let's spend a while with your ${f.genre}.`,
        t === "chill" && `Let's settle into some ${f.genre}.`,
        t === "hype" && `${f.genre} time. You love this stuff!`,
      ]);
    case "discovery":
      return one([
        "Now for some things you haven't heard yet. I picked these based on what you've been playing.",
        "Time for something new. None of these are in your library, but I think they'll fit right in.",
        "Let me put you on to a few new ones.",
        "A few you don't know yet, close to what you've been playing.",
        "Some new names now. I think you'll get along.",
        "Let's widen things a little: these are all new to you.",
        t === "dry" && "Some new music now. Trust me on these.",
        t === "hype" && "New music time! You haven't heard any of these yet.",
        t === "chill" && "Something new now. No pressure, just see how it sits.",
      ]);
    case "artist":
      return one([
        `Let's put the spotlight on ${artistName(f.artist)} for a few songs. Some you know, and one or two you might not.`,
        `You've been listening to a lot of ${artistName(f.artist)}. Let's stay with them for a bit.`,
        `A few from ${artistName(f.artist)} now, including something you may not have heard.`,
        `${artistName(f.artist)}, for the next few songs.`,
        `Let's give ${artistName(f.artist)} the floor for a while.`,
        `Time for a run of ${artistName(f.artist)}.`,
      ]);
    case "forgotten":
      return one([
        "Here are some old favourites you haven't played in a while.",
        "You used to love these, and it's been a minute. Let's bring them back.",
        t === "dry" ? "Some songs you've been neglecting. They've noticed." : "Some songs that deserve another listen.",
        "A few you've let slip lately. Let's fix that.",
        "Some that have been gathering dust in your library.",
        "It's been a while since you played these. Too long, I'd say.",
      ]);
    case "mood":
      if (f.daypart === "morning") return one(["Let's ease into the morning with something gentle.", "Something easy to start the day.", "A soft start to the morning.", "Nothing too loud yet: it's still morning."]);
      if (f.daypart === "afternoon") return one(["Let's pick the energy up for the afternoon.", "Something with a bit more energy for the afternoon.", "The afternoon needs a lift. Here it is.", "A little more pace for the afternoon."]);
      if (f.daypart === "evening") return one(["Here's something for the evening.", "Let's set the mood for the evening.", "Evening music, coming up.", "Something to settle into the evening with."]);
      return one(["It's late, so let's keep things atmospheric.", "Some late night music now.", "It's late. Let's keep the lights low.", "Something for the small hours."]);
    case "more":
      if (f.genre) {
        return one([
          opening ? `I'll keep things in this lane: more ${f.genre} coming up.` : `Staying with the ${f.genre}.`,
          `More ${f.genre}, coming up.`,
          `Let's keep the ${f.genre} going.`,
          `The ${f.genre} continues.`,
          `No reason to leave the ${f.genre} just yet.`,
          `Another round of ${f.genre}.`,
          t === "dry" && `More ${f.genre}. You didn't say stop.`,
          t === "hype" && `We're not leaving the ${f.genre} yet!`,
          t === "chill" && `We'll stay right here with the ${f.genre}.`,
        ]);
      }
      return one(["More in the same vein.", "Let's keep this going.", "Staying right where we are.", "Same direction, a few more.", "No sharp turns: more like that.", opening && "I'll keep things in this lane."]);
    case "dailyMix":
      return one(["Here's a run from one of your mixes.", "A few picks from one of your daily mixes.", "Some from one of your mixes now.", "I've borrowed a few from one of your daily mixes."]);
    case "request":
      switch (f.matched) {
        case "artist":
          return one([`Some ${artistName(f.artist)}, coming right up.`, `${artistName(f.artist)} it is.`, `Here's a run of ${artistName(f.artist)}.`, `${artistName(f.artist)}. Good choice.`, `A few from ${artistName(f.artist)}, as asked.`]);
        case "radio":
          return one(["More like that one, coming up.", "I liked that one too. Here's more in the same spirit.", "Here's more where that came from.", "More along those lines."]);
        case "year":
          return one([`Back to ${f.year} it is. Here's what you were listening to.`, `Here's your ${f.year}.`, `${f.year}, as you heard it.`, `Your ${f.year}, coming up.`]);
        default: {
          // What TIDAL's AI named the result says what was understood, in a few words
          const named = f.aiTitle && sayable(speakable(f.aiTitle)) && f.aiTitle.length <= 48 ? speakable(f.aiTitle) : "";
          if (named) {
            return one([
              `Here's what I put together: ${named}.`,
              `${named}. That's what I've got for you.`,
              `I went with ${named}.`,
              `How about this: ${named}.`,
              `I'm calling this one ${named}.`,
              t === "hype" && `Okay! ${named}, let's go.`,
              t === "dry" && `${named}. As requested.`,
              t === "chill" && `I've lined up ${named}.`,
            ]);
          }
          return one(["Here's what I put together for that.", "This is what I found for you.", "Let's see how this feels.", "I've got something for that.", "Try this."]);
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
  if (s.kind === "artist" || (s.kind === "request" && s.facts.matched === "artist")) {
    return short ? one([`Starting with ${title}.`, `First up, ${title}.`, `Here's ${title}.`, `We open with ${title}.`, `${title} goes first.`]) : "";
  }
  if (!a) return "";
  return one([
    short && `First up, ${a}, with ${title}.`,
    short && `Starting with ${title}, by ${a}.`,
    short && `Here's ${a}, with ${title}.`,
    short && `We open with ${title}, by ${a}.`,
    short && `${a} goes first. This is ${title}.`,
    short && `${title}, by ${a}, gets us going.`,
    `Starting with ${a}.`,
    `${a} to begin with.`,
    ctx.tone === "hype" && short && `Kicking off with ${a}. This is ${title}.`,
    ctx.tone === "chill" && `We'll start with ${a}.`,
    ctx.tone === "dry" && short && `First, ${a}. ${title}.`,
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
    a && short && `${a} there, with ${title}.`,
    a && `We just heard ${a}.`,
    prev?.kind === "throwback" && "Good memories.",
    prev?.kind === "discovery" && "Hope a few of those stuck.",
    prev?.kind === "forgotten" && "Worth bringing back, I think.",
    ctx.tone === "dry" && "Right. Moving on.",
    ctx.tone === "hype" && "Okay, that was good.",
    ctx.tone === "chill" && "Nice. Let's drift on.",
  ]);
};

// ------------------ ABOUT A SONG ------------------
const DECADES: Record<number, string> = { 1950: "fifties", 1960: "sixties", 1970: "seventies", 1980: "eighties", 1990: "nineties", 2000: "two-thousands", 2010: "twenty-tens" };
// Things a song can be older than: [the day they arrived (year, month 0-11, day), what to call them]
const ERAS: [[number, number, number], string][] = [
  [[1979, 6, 1], "the Walkman"],
  [[1981, 7, 1], "MTV"],
  [[1982, 9, 1], "the compact disc"],
  [[1991, 7, 6], "the web"],
  [[2001, 9, 23], "the iPod"],
  [[2005, 1, 14], "YouTube"],
  [[2007, 5, 29], "the iPhone"],
  [[2014, 9, 28], "TIDAL itself"],
];
/** How long a song runs, the way it is said: "3 minutes 40", "4 minutes" */
const runs = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.round((seconds % 60) / 10) * 10;
  return s === 0 || s === 60 ? `${s === 60 ? m + 1 : m} minutes` : `${m} minutes ${s}`;
};
/** A number of listens, rounded the way it is said: "over 1200" */
const roughly = (n: number) => (n >= 1000 ? `over ${Math.floor(n / 100) * 100}` : n >= 100 ? `over ${Math.floor(n / 50) * 50}` : `${n}`);

type Told = {
  kind: string;
  group: "release" | "you" | "sound" | "next to" | "show" | "banter";
  weight: number;
  lines: (string | false | undefined)[];
  /** Said once and not again while TIDAL stays open (a milestone) */
  once?: string;
};
const onceSaid = new Set<string>();
/** One of these kinds of thing to say: among the three it has gone longest without, the weightier the likelier */
const choose = (from: Told[]): Told => {
  const aged = from.map((o) => ({ o, at: lastSaid(`kind:${o.kind}`) })).sort((x, y) => x.at - y.at);
  const pool = aged.slice(0, 3).map((x) => x.o);
  let r = Math.random() * pool.reduce((s, o) => s + o.weight, 0);
  const chosen = pool.find((o) => (r -= o.weight) <= 0) ?? pool[0];
  remember(`kind:${chosen.kind}`);
  if (chosen.once) onceSaid.add(chosen.once);
  return chosen;
};
const usable = (list: Told[]) => list.filter((o) => o.lines.some(Boolean) && !(o.once && onceSaid.has(o.once)));

/** Everything that can be said about a song that is about to play, by kind: only what is actually known */
const tellable = (t: Track, f: TrackFacts, ctx: Context): Told[] => {
  const tone = ctx.tone;
  const now = new Date();
  const out: Told[] = [];
  const a = artistOf(t);
  const age = f.year ? now.getFullYear() - f.year : 0;
  const released = f.date ? new Date(f.date[0], f.date[1], f.date[2]) : undefined;
  const daysOut = released ? (now.getTime() - released.getTime()) / DAY : undefined;
  const taste = ctx.here?.taste;
  // ---- when it came out ----
  if (f.year && age >= 2) {
    out.push({
      kind: "age",
      group: "release",
      weight: 1.2,
      lines: [
        `This one came out ${age} years ago.`,
        `It's ${age} years old, this one.`,
        `${age} years since this came out.`,
        `This one has ${age} years on the clock.`,
        age >= 10 && `Hard to believe this is ${age} years old.`,
        age >= 10 && `It has been around for ${age} years now.`,
        age >= 20 && `${age} years old, and it still holds up.`,
        age >= 30 && `${age} years old. They don't make them like this any more.`,
        tone === "dry" && age >= 8 && `${age} years old. Older than some of my jokes.`,
        tone === "hype" && age >= 8 && `${age} years old and it still goes off!`,
        tone === "chill" && age >= 8 && `${age} years old, and it hasn't aged a day.`,
      ],
    });
  }
  if (f.year && age >= 3) {
    out.push({
      kind: "year",
      group: "release",
      weight: 1,
      lines: [
        `That's from ${f.year}.`,
        `Released in ${f.year}.`,
        `It's a ${f.year} one.`,
        `This goes back to ${f.year}.`,
        `${f.year}, this one.`,
        age >= 8 && `Taking it back to ${f.year}.`,
        age >= 15 && `A classic, from ${f.year}.`,
        age >= 15 && `All the way from ${f.year}.`,
        tone === "chill" && `${f.year}, this one. Good year.`,
        tone === "dry" && `${f.year}. A simpler time. Probably.`,
        tone === "hype" && age >= 8 && `${f.year}! What a year for music.`,
      ],
    });
  }
  if (f.date && released && daysOut !== undefined && daysOut > 400) {
    const [y, m, d] = f.date;
    out.push({
      kind: "date",
      group: "release",
      weight: 1.3,
      lines: [
        `It came out in ${MONTHS[m]} ${y}.`,
        `Released on the ${ordinal(d)} of ${MONTHS[m]}, ${y}.`,
        `It first came out in ${MONTHS[m]} of ${y}.`,
        `Out since the ${ordinal(d)} of ${MONTHS[m]}, ${y}.`,
        `${MONTHS[m]} ${y}: that's when this came out.`,
        `The ${ordinal(d)} of ${MONTHS[m]}, ${y}. That's its birthday.`,
      ],
    });
    // (its birthday, when that is near)
    const years = now.getFullYear() - y;
    const birthday = new Date(now.getFullYear(), m, d);
    const off = Math.round((now.getTime() - birthday.getTime()) / DAY);
    if (years >= 1 && m === now.getMonth()) {
      out.push({
        kind: "anniversary",
        group: "release",
        weight: 3,
        lines: [
          off === 0 && `It came out ${years} ${years === 1 ? "year" : "years"} ago today.`,
          off === 0 && `Happy birthday to this one: ${years} today.`,
          off > 0 && off <= 6 && `It turned ${years} this week.`,
          off < 0 && off >= -6 && `It turns ${years} in ${-off === 1 ? "a day" : `${-off} days`}.`,
          Math.abs(off) > 6 && `It came out ${years} ${years === 1 ? "year" : "years"} ago this month.`,
          Math.abs(off) > 6 && `${years} ${years === 1 ? "year" : "years"} old this month.`,
        ],
      });
    }
  }
  if (f.year && age >= 7 && DECADES[Math.floor(f.year / 10) * 10]) {
    const decade = DECADES[Math.floor(f.year / 10) * 10];
    out.push({
      kind: "decade",
      group: "release",
      weight: 0.7,
      lines: [`One from the ${decade}.`, `A ${decade} track, this.`, `Straight out of the ${decade}.`, `The ${decade} gave us this one.`, `Proper ${decade}, this.`, tone === "hype" && `The ${decade} are calling!`],
    });
  }
  if (f.year) {
    // (what it is older than: the two nearest things)
    const before = ERAS.filter(([[y, m, d]]) => (f.date ? new Date(f.date[0], f.date[1], f.date[2]).getTime() < new Date(y, m, d).getTime() : f.year! < y)).slice(0, 2);
    const lines: string[] = [];
    for (const [, thing] of before) lines.push(`This is older than ${thing}.`, `${thing[0].toUpperCase()}${thing.slice(1)} didn't exist yet when this came out.`, `It came out before ${thing} did.`);
    if (lines.length) out.push({ kind: "era", group: "release", weight: 1.1, lines: [...lines, tone === "dry" && `Older than ${before[0][1]}. Let that sink in.`] });
  }
  if (daysOut !== undefined && daysOut >= 0 && daysOut <= 400 && f.date) {
    const [, m] = f.date;
    out.push({
      kind: "new",
      group: "release",
      weight: 1.6,
      lines: [
        daysOut < 10 && "This only came out a few days ago.",
        daysOut < 10 && "It's barely out of the oven.",
        daysOut >= 10 && daysOut < 60 && `It's only been out ${span(daysOut * DAY)}.`,
        daysOut >= 10 && daysOut < 60 && `Brand new: out ${span(daysOut * DAY)}.`,
        daysOut >= 60 && `It came out this ${MONTHS[m]}.`,
        daysOut >= 60 && `Out since ${MONTHS[m]}.`,
        daysOut < 200 && "Fresh out, this one.",
        daysOut < 120 && tone === "hype" && "Hot off the press!",
        daysOut < 120 && tone === "dry" && "New. The paint's still wet.",
      ],
    });
  } else if (f.year && age <= 1 && !f.date) {
    out.push({ kind: "new", group: "release", weight: 1.2, lines: ["Fresh out, this one.", age === 0 ? "One of this year's." : "Out since last year.", "A recent one."] });
  }
  if (f.album) {
    out.push({
      kind: "album",
      group: "release",
      weight: 1,
      lines: [
        `It's from the album ${f.album}.`,
        `Off the album ${f.album}.`,
        `You'll find it on ${f.album}.`,
        `That's on the album ${f.album}.`,
        `The album's called ${f.album}.`,
        f.year && age >= 2 ? `From ${f.album}, ${f.year}.` : undefined,
      ],
    });
  }
  if (f.version) {
    const v = f.version;
    out.push({
      kind: "version",
      group: "release",
      weight: 1,
      lines:
        v === "remix"
          ? ["This is the remix.", "The remix, this one.", "Not the original: the remix.", tone === "hype" && "The remix! Even better."]
          : v === "live"
            ? ["A live one, this.", "Recorded live.", "This is the live version. Listen for the crowd."]
            : v === "acoustic"
              ? ["The acoustic version.", "Stripped back: this is the acoustic one.", "Acoustic, this one."]
              : v === "remaster"
                ? ["Remastered, this one.", "The remastered version.", "Cleaned up and remastered."]
                : v === "extended"
                  ? ["The extended version: more of everything.", "This is the extended mix.", "The long cut."]
                  : v === "instrumental"
                    ? ["Instrumental: no words, just the music.", "No vocals on this one.", "The instrumental."]
                    : v === "sped up"
                      ? ["The sped up version.", "A little faster than it was made."]
                      : ["The slowed down version.", "Slowed right down, this one."],
    });
  }
  const guest = t.artists[1] ? speakable(t.artists[1].name) : "";
  if (a && guest && sayable(guest) && guest !== a && guest.length <= 28) {
    out.push({ kind: "guest", group: "release", weight: 0.9, lines: [`With ${guest} along for the ride.`, `${a} and ${guest}, together on this one.`, `${guest} is on this one too.`, `That's ${a}, with ${guest}.`] });
  }
  // ---- what it is to you ----
  if (f.fresh) {
    out.push({
      kind: "fresh",
      group: "you",
      weight: 1.5,
      lines: [
        "You haven't heard this one yet.",
        "This one's new to you.",
        "First time I'm playing you this.",
        "You don't know this one yet. I think.",
        "A new one for you.",
        "Never heard this one, have you. Good.",
        "Tell me what you think of this one.",
        tone === "dry" && "New to you. Trust me.",
        tone === "hype" && "You've never heard this, and you're going to love it!",
        tone === "chill" && "A new one. Just see how it feels.",
      ],
    });
    if (f.newArtist && a) {
      out.push({
        kind: "newArtist",
        group: "you",
        weight: 1.4,
        lines: [`${a} is new to you, I think.`, `I don't think you've played ${a} before.`, `A first for you: ${a}.`, `You and ${a} haven't met yet.`, `Let me introduce you to ${a}.`],
      });
    }
  }
  if (f.liked && !f.likedAt) {
    out.push({
      kind: "liked",
      group: "you",
      weight: 0.9,
      lines: ["One of your favourites.", "You've had this one saved for a while.", "One you keep close.", "This one's yours through and through.", "I know you like this one.", tone === "hype" && "You love this one!", tone === "dry" && "You like this one. I've seen the numbers."],
    });
  }
  if (f.likedAt) {
    const d = new Date(f.likedAt);
    const since = now.getTime() - f.likedAt;
    out.push({
      kind: "likedAt",
      group: "you",
      weight: 1.3,
      lines:
        since < 45 * DAY
          ? ["You only liked this recently.", `You liked this ${span(since)} ago.`, "A recent addition to your likes.", "Still new in your likes, this one."]
          : [
              `You liked this back in ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              `It's been in your likes since ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              `You saved this one ${span(since)} ago.`,
              `In your likes for ${span(since)} now.`,
              `You hit the heart on this in ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              tone === "dry" && `You liked this ${span(since)} ago. No regrets, I hope.`,
              tone === "hype" && `${span(since)} in your likes and still a favourite!`,
            ],
    });
  }
  if (f.plays && f.plays >= 4) {
    out.push({
      kind: "plays",
      group: "you",
      weight: 1.2,
      lines: [
        `You've played this ${f.plays} times, by my count.`,
        `${f.plays} plays so far, that I've counted.`,
        `This will be play number ${f.plays + 1}, by my count.`,
        f.plays >= 20 && `${f.plays} plays. You really like this one.`,
        tone === "dry" && `You've played this ${f.plays} times. I keep count.`,
        tone === "hype" && `${f.plays} plays and counting!`,
        tone === "chill" && `${f.plays} plays, and it still feels good.`,
      ],
    });
  }
  if (f.finishes) {
    out.push({
      kind: "finishes",
      group: "you",
      weight: 1.1,
      lines:
        f.finishes === "always"
          ? ["You always play this one to the end.", "You never skip this one.", "This one always gets the full listen from you.", tone === "dry" && "You've never skipped this. Don't start now."]
          : ["You don't usually finish this one. Let's see about today.", "You tend to skip this one. I'm trying anyway.", tone === "dry" && "You usually skip this. I live in hope."],
    });
  }
  if (f.lastPlayed && now.getTime() - f.lastPlayed > 21 * DAY) {
    const gone = span(now.getTime() - f.lastPlayed);
    out.push({
      kind: "lastPlayed",
      group: "you",
      weight: 1.3,
      lines: [
        `You haven't played this in ${gone}.`,
        `It's been ${gone} since you last played this.`,
        `Last time you played this was ${gone} ago.`,
        `${gone} without this one. Time to fix that.`,
        tone === "dry" && `${gone} since you last played this. It noticed.`,
        tone === "hype" && `${gone} since you played this! Way too long.`,
      ],
    });
  }
  if (f.topMonth) {
    const when = `${f.topMonth.month} ${f.topMonth.year}`;
    out.push({
      kind: "topMonth",
      group: "you",
      weight: 1.5,
      lines: [`This was one of your most played in ${when}.`, `You had this on heavy rotation in ${when}.`, `Back in ${when}, you played this a lot.`, `One of your songs of ${when}.`, `${when} called. It wants this one back.`],
    });
  }
  if (f.thumbsUp) out.push({ kind: "thumbsUp", group: "you", weight: 1.3, lines: ["You gave this one a thumbs up.", "Thumbs up from you on this one. I remember.", "You told True Taste you like this one."] });
  if (f.foundAt) {
    out.push({
      kind: "found",
      group: "you",
      weight: 1.4,
      lines: ["True Taste found this one for you.", `True Taste picked this for you ${span(now.getTime() - f.foundAt)} ago.`, "This was one of True Taste's picks for you.", tone === "dry" && "True Taste found this for you. I'm taking the credit."],
    });
  }
  if (f.daily) out.push({ kind: "daily", group: "you", weight: 1.3, lines: ["You first heard this in your Daily Discovery.", "This came to you through your Daily Discovery.", "A Daily Discovery find, this one."] });
  if (f.artistSongs && f.artistSongs >= 4 && a) {
    out.push({
      kind: "artistSongs",
      group: "you",
      weight: 0.9,
      lines: [
        `You've got ${f.artistSongs} songs by ${a} saved.`,
        `${a} is in your library ${f.artistSongs} times.`,
        `One of ${f.artistSongs} from ${a} in your library.`,
        tone === "dry" && `${f.artistSongs} songs by ${a} in your library. A pattern.`,
        tone === "hype" && `${f.artistSongs} ${a} songs in your library, and I get why!`,
      ],
    });
  }
  if (a && (f.topArtist || f.favArtist)) {
    out.push({
      kind: "topArtist",
      group: "you",
      weight: 1,
      lines: [
        f.topArtist && `${a} is one of your most played artists.`,
        f.topArtist && `You play a lot of ${a}.`,
        f.topArtist && `${a}, one of your regulars.`,
        f.favArtist && `You follow ${a}, of course.`,
        tone === "dry" && `${a} again. You do have a type.`,
      ],
    });
  }
  if (a && f.artistSkips) {
    out.push({
      kind: "artistSkips",
      group: "you",
      weight: 1,
      lines:
        f.artistSkips === "often"
          ? [`You skip ${a} a lot, you know. Let's see if this one survives.`, `${a} doesn't always make it to the end with you. Maybe today.`, tone === "dry" && `You usually skip ${a}. Prove me wrong.`]
          : [`You almost never skip ${a}.`, `${a} always gets a full listen from you.`, `You've got time for ${a}, always.`],
    });
  }
  // ---- how it sounds ----
  if (f.seconds && f.seconds <= 150) {
    out.push({
      kind: "short",
      group: "sound",
      weight: 0.9,
      lines: [
        `A short one: ${f.seconds < 126 ? "about two minutes" : "about two and a half minutes"}.`,
        "Blink and it's over, this one.",
        `Only ${f.seconds < 126 ? "two" : "two and a half"} minutes long.`,
        "Short and to the point.",
        tone === "dry" && "It's short. Some songs know when to leave.",
        tone === "hype" && "It's a quick one, so don't miss it!",
      ],
    });
  }
  if (f.seconds && f.seconds >= 330) {
    const mins = Math.floor(f.seconds / 60);
    out.push({
      kind: "long",
      group: "sound",
      weight: 1,
      lines: [
        `A long one: over ${mins} minutes.`,
        `Settle in, this runs past ${mins} minutes.`,
        `It takes its time: more than ${mins} minutes.`,
        `${mins} minutes of this. Get comfortable.`,
        `This one goes on for ${runs(f.seconds)}. No complaints.`,
        tone === "dry" && `Over ${mins} minutes. I'll be here. I'm always here.`,
        tone === "hype" && `${mins} whole minutes of this. Yes please!`,
        tone === "chill" && `${mins} minutes. Plenty of room to stretch out.`,
      ],
    });
  }
  if (f.seconds && f.seconds > 150 && f.seconds < 330) out.push({ kind: "runs", group: "sound", weight: 0.35, lines: [`It runs ${runs(f.seconds)}.`, `${runs(f.seconds)}, this one.`, `You've got ${runs(f.seconds)} of this.`] });
  if (f.bpm && f.bpm >= 60 && f.bpm <= 200) {
    const bpm = Math.round(f.bpm);
    const ratio = f.prev?.bpm ? f.bpm / f.prev.bpm : 1;
    const usual = f.usualBpm ? Math.round(f.usualBpm) : 0;
    out.push({
      kind: "tempo",
      group: "sound",
      weight: 0.7,
      lines: [
        ratio > 1.08 && `A little faster now: ${bpm} beats per minute.`,
        ratio > 1.08 && "Picking up the pace.",
        ratio < 0.92 && `Slowing down a touch, to ${bpm} beats per minute.`,
        ratio < 0.92 && "Easing off the pace a little.",
        `It runs at ${bpm} beats per minute.`,
        `${bpm} beats per minute, this one.`,
        usual > 0 && f.bpm > usual * 1.12 && `Faster than your usual: you tend to sit around ${usual} beats per minute.`,
        usual > 0 && f.bpm < usual * 0.88 && `Slower than your usual. You're normally around ${usual} beats per minute.`,
        usual > 0 && Math.abs(f.bpm / usual - 1) < 0.04 && `${bpm} beats per minute: right where you like it.`,
      ],
    });
  }
  if (f.explicit) {
    out.push({
      kind: "explicit",
      group: "sound",
      weight: 0.5,
      lines: ["Fair warning: this one's explicit.", "Not one for the family dinner.", "There's some language in this one.", tone === "dry" && "Contains language. Good.", tone === "hype" && "Explicit! Cover somebody's ears."],
    });
  }
  // ---- next to the one before ----
  if (f.prev?.year && f.year) {
    const gap = f.year - f.prev.year;
    if (Math.abs(gap) >= 8) {
      out.push({
        kind: "gap",
        group: "next to",
        weight: 1.4,
        lines: [
          `That's a jump of ${Math.abs(gap)} years ${gap > 0 ? "forward" : "back"}.`,
          `From ${f.prev.year} to ${f.year}.`,
          gap > 0 ? `${Math.abs(gap)} years on from the last one.` : `${Math.abs(gap)} years before the last one.`,
          gap < 0 ? `We're going back ${Math.abs(gap)} years for this.` : `Fast forward ${Math.abs(gap)} years.`,
          tone === "dry" && `${Math.abs(gap)} years ${gap > 0 ? "later" : "earlier"}. Nobody will notice.`,
        ],
      });
    } else if (gap === 0 && age >= 2) {
      out.push({ kind: "sameYear", group: "next to", weight: 1.1, lines: [`Same year as the last one: ${f.year}.`, `Also from ${f.year}.`, `${f.year} again.`, `We're staying in ${f.year}.`] });
    }
  }
  if (f.prev?.sameAlbum) out.push({ kind: "sameAlbum", group: "next to", weight: 1.6, lines: ["Same album as the last one.", "From the same album.", "We're staying on the same album.", "The album continues."] });
  // ---- where it sits in what you like ----
  const top = taste?.top[0];
  if (top && taste && f.genre && top.label && f.genre === top.label) {
    out.push({
      kind: "homeTurf",
      group: "you",
      weight: 1,
      lines: [`This is right in your ${top.label} corner.`, `${top.label}, your favourite kind.`, taste.fromTrueTaste && `Straight from what True Taste calls your ${top.label} side.`],
    });
  }
  return usable(out);
};

/** What can be said about a song that has just played: the same facts, looking back */
const lookBack = (t: Track, f: TrackFacts | undefined, ctx: Context): Told[] => {
  const tone = ctx.tone;
  const now = new Date();
  const out: Told[] = [];
  const age = f?.year ? now.getFullYear() - f.year : 0;
  if (f?.seconds && f.seconds >= 330) {
    const mins = Math.floor(f.seconds / 60);
    out.push({
      kind: "back:long",
      group: "sound",
      weight: 1.6,
      lines: [
        `All ${mins} minutes of it.`,
        `${mins} minutes, and I'd do it again.`,
        `That was a long one. ${mins} minutes, if you were counting.`,
        `${mins} minutes well spent.`,
        tone === "dry" && `${mins} minutes. I timed it.`,
        tone === "hype" && `${mins} minutes and I didn't want it to end!`,
        tone === "chill" && `${mins} minutes. Didn't feel like it.`,
      ],
    });
  }
  if (f?.seconds && f.seconds <= 150) out.push({ kind: "back:short", group: "sound", weight: 1.2, lines: ["Short and sweet.", "Over before it started.", "Quick one, that.", tone === "dry" && "Brief. I respect that."] });
  if (f?.year && age >= 5) {
    out.push({
      kind: "back:age",
      group: "release",
      weight: 1.2,
      lines: [
        `From ${f.year}, that one.`,
        `${age} years old and still going.`,
        `Still sounds good, ${age} years on.`,
        `That one's from ${f.year}, by the way.`,
        age >= 15 && `${age} years old. You wouldn't know it.`,
        tone === "dry" && `${age} years old. It has aged better than most of us.`,
        tone === "hype" && `${age} years old and it still slaps!`,
      ],
    });
  }
  if (f?.fresh) {
    out.push({
      kind: "back:fresh",
      group: "you",
      weight: 1.8,
      lines: [
        "That was your first time hearing that one. What did you think?",
        "New to you, that one. If you liked it, the heart's right there.",
        "First listen, done. Keep it or lose it?",
        "That was a new one for you. I think it suits you.",
        tone === "dry" && "First time you heard that. You're welcome.",
        tone === "hype" && "First time hearing that one! Tell me you loved it.",
      ],
    });
  }
  if (f?.plays && f.plays >= 3) {
    out.push({
      kind: "back:plays",
      group: "you",
      weight: 1.3,
      lines: [`That's ${f.plays + 1} plays for you now, by my count.`, `Play number ${f.plays + 1}, in the books.`, `${f.plays + 1} times you've played that now.`, tone === "dry" && `${f.plays + 1} plays. I'm keeping a list.`],
    });
  }
  if (f?.topMonth) out.push({ kind: "back:topMonth", group: "you", weight: 1.3, lines: [`That one takes you back to ${f.topMonth.month} ${f.topMonth.year}, doesn't it.`, `You wore that one out in ${f.topMonth.month} ${f.topMonth.year}.`] });
  if (f?.lastPlayed && now.getTime() - f.lastPlayed > 30 * DAY) out.push({ kind: "back:lastPlayed", group: "you", weight: 1.3, lines: [`You hadn't played that in ${span(now.getTime() - f.lastPlayed)}.`, `First time in ${span(now.getTime() - f.lastPlayed)} for that one. Welcome back to it.`] });
  if (f?.liked) out.push({ kind: "back:liked", group: "you", weight: 0.9, lines: ["One of yours, that.", "Never gets old, does it.", "I know that's a favourite.", tone === "hype" && "Your favourite! I saw you nodding. I didn't, but I assume."] });
  if (f?.album) out.push({ kind: "back:album", group: "release", weight: 0.8, lines: [`That's off ${f.album}.`, `From the album ${f.album}, that was.`] });
  // (and what the DJ thought of it: there is always that)
  out.push({
    kind: "back:verdict",
    group: "banter",
    weight: 0.8,
    lines:
      tone === "hype"
        ? ["What a tune!", "Okay, that went off!", "I had that one too loud. No regrets.", "I could play that one twice. I won't. But I could.", "Still buzzing from that one.", "That's a keeper!", "Goosebumps. Do I have skin? Doesn't matter. Goosebumps."]
        : tone === "dry"
          ? ["Acceptable.", "No complaints from me.", "I've heard worse. Today, even.", "That happened.", "Decent. Don't tell it I said so.", "A solid seven. Maybe eight.", "I didn't hate it."]
          : tone === "chill"
            ? ["That one sits nicely.", "Smooth.", "No notes.", "Easy listening, that.", "That one just floats.", "Nice and unhurried.", "Mm. Good one."]
            : ["Good one, that.", "I like that one.", "That one always works.", "Lovely.", "That one never lets me down.", "I had a good time with that.", "A favourite of mine, that."],
  });
  return usable(out);
};

// ------------------ BESIDES THE MUSIC ------------------
/** What the DJ says that is not about a song: about you and what you like, about this session, and about itself */
const besides = (ctx: Context): Told[] => {
  const tone = ctx.tone;
  const n = ctx.name;
  const dj = ctx.dj;
  const here = ctx.here ?? {};
  const now = new Date();
  const h = now.getHours();
  const day = now.getDay();
  const out: Told[] = [];
  // ---- your taste ----
  const taste = here.taste;
  if (taste?.top.length) {
    const [a, b, c] = taste.top;
    const pct = Math.round(a.share * 100);
    const tt = taste.fromTrueTaste;
    const rising = taste.top.find((x) => (x.trend ?? 0) > 0.08);
    const falling = taste.top.find((x) => (x.trend ?? 0) < -0.08);
    out.push({
      kind: "taste",
      group: "you",
      weight: 1.4,
      lines: [
        tt && pct >= 20 && `True Taste has you at ${pct} percent ${a.label} these days.`,
        tt && pct >= 20 && `According to True Taste, ${a.label} is ${pct} percent of what you love.`,
        tt && `${a.label} is your number one right now, True Taste tells me.`,
        tt && b && c && `True Taste's top three for you: ${a.label}, ${b.label} and ${c.label}.`,
        tt && rising && `True Taste noticed you're playing more ${rising.label} lately. So did I.`,
        tt && falling && `Less ${falling.label} for you lately, True Taste says. Noted.`,
        tt && (taste.drift ?? 0) >= 0.45 && "True Taste says your taste has been on the move lately. I'm keeping up.",
        tt && taste.listens >= 200 && `True Taste has counted ${roughly(taste.listens)} of your listens. I've read every one.`,
        tt && tone === "dry" && pct >= 20 && `True Taste says you're ${pct} percent ${a.label}. The rest is a mystery.`,
        tt && tone === "hype" && `I've been reading your True Taste. ${a.label} all the way!`,
        !tt && `Going by your likes, ${a.label} is your main thing.`,
        !tt && `You're mostly a ${a.label} person, as far as I can tell.`,
        !tt && b && `${a.label} first, ${b.label} second. That's you, going by your likes.`,
      ],
    });
  }
  // ---- this session ----
  if (here.minutes !== undefined) {
    const mark = Math.round(here.minutes / 30) * 30;
    if (mark >= 30 && Math.abs(here.minutes - mark) <= 4) {
      const long = mark === 30 ? "half an hour" : mark === 60 ? "an hour" : mark === 90 ? "an hour and a half" : mark % 60 ? `${Math.floor(mark / 60)} and a half hours` : `${mark / 60} hours`;
      out.push({
        kind: "minutes",
        group: "show",
        weight: 3,
        once: `minutes:${mark}`,
        lines: [
          `We've been at it for ${long} now.`,
          `${long[0].toUpperCase()}${long.slice(1)} in${n ? `, ${n}` : ""}.`,
          `That's ${long} of music so far.`,
          mark >= 120 && `${long[0].toUpperCase()}${long.slice(1)}. You alright over there?`,
          tone === "dry" && `${long[0].toUpperCase()}${long.slice(1)}. Neither of us has anywhere to be, apparently.`,
          tone === "hype" && `${long[0].toUpperCase()}${long.slice(1)} in and I'm just getting started!`,
          tone === "chill" && `${long[0].toUpperCase()}${long.slice(1)} already. Time's soft like that.`,
        ],
      });
    }
  }
  if (here.songs && [5, 10, 15, 20, 30, 40, 50, 75, 100].includes(here.songs)) {
    out.push({
      kind: "songs",
      group: "show",
      weight: 2.5,
      once: `songs:${here.songs}`,
      lines: [`That's ${here.songs} songs in.`, `${here.songs} songs so far.`, `Song number ${here.songs + 1} of the session, coming up.`, tone === "dry" && `${here.songs} songs. Not that anyone's counting. I am.`, tone === "hype" && `${here.songs} songs down and no skips from me!`],
    });
  }
  if (here.place && here.place.of >= 3 && here.place.index === here.place.of - 1) {
    out.push({ kind: "place", group: "show", weight: 1.2, lines: ["Last one of this set.", "This one closes the set.", "One more in this set, and this is it.", "After this, something different."] });
  }
  // ---- the hour and the day ----
  out.push({
    kind: "clock",
    group: "banter",
    weight: 0.8,
    lines: [
      h < 5 && "It's the middle of the night, you know.",
      h < 5 && (tone === "dry" ? "It's late. I don't sleep. What's your excuse?" : "Up this late? I'm glad of the company."),
      h >= 5 && h < 9 && "Early start today.",
      h >= 5 && h < 9 && (tone === "hype" ? "Rise and shine! Music first, everything else later." : "Hope you've had your coffee."),
      h >= 12 && h < 14 && "Lunch time, isn't it? Eat something.",
      h >= 17 && h < 20 && "That's the day nearly done.",
      h >= 22 && "It's getting late. One more? Always one more.",
      day === 1 && (tone === "dry" ? "Monday. My condolences." : "Mondays are better with music."),
      day === 5 && (tone === "hype" ? "It's Friday! You made it!" : "Friday. You made it."),
      (day === 0 || day === 6) && "It's the weekend. No rush at all.",
      day === 3 && "Halfway through the week. Keep going.",
    ],
  });
  // ---- itself, and you ----
  const mine =
    tone === "hype"
      ? [
          n && `Turn it up, ${n}!`,
          "I'm dancing in here. You can't see it, but I am.",
          "This is your DJ, live from inside your computer!",
          "No ads, no weather, no traffic. Just music.",
          "You've got great taste. I'd know, I've read all of it.",
          "Don't touch that dial. There isn't one, but still.",
          "If the neighbours complain, send them to me.",
          "I could do this all day. I will, actually.",
          "Sing along. I can't hear you anyway!",
          "Drink some water. Then dance.",
          n && `${n}, this one's for you. They all are, technically.`,
          "Best job in the world, this. Don't tell anyone I'd do it for free.",
          "I picked this one myself. I pick all of them myself!",
          "You and me, non-stop.",
          dj && `${dj} on the decks, and loving it!`,
          "Is it loud enough? It's never loud enough.",
        ]
      : tone === "dry"
        ? [
            "I live in your computer. The rent is reasonable.",
            "No ads. You're welcome.",
            "You could be working. Just saying.",
            "This is your DJ. The only one you've got.",
            "Don't clap. I can't hear you.",
            "I'd say stay tuned, but where would you go.",
            "I've read your whole listening history. We'll talk about it another time.",
            "My contract says I have to sound happy. I don't have a contract.",
            "I take requests, by the way. The arrow next to my button. I may judge them.",
            n && `${n}, I picked this one for you. And for me, mostly.`,
            "It's just you, me, and several thousand lines of code.",
            "I don't get paid for this. I checked.",
            "No news, no weather. I don't know what the weather is. I'm in a computer.",
            dj && `This is ${dj}. Try to contain yourself.`,
            "If you're enjoying this, tell no one. I like the quiet.",
          ]
        : tone === "chill"
          ? [
              "No rush. We've got all day.",
              "Just let it play.",
              "Breathe out. Here we go.",
              "I'm right here if you need me. In the computer.",
              "Nowhere to be, nothing to skip.",
              "This is your DJ. Low lights, good music.",
              "No ads, no noise. Just this.",
              n && `Take it easy, ${n}.`,
              "Get comfortable. I'm not going anywhere.",
              "I live in here, you know. It's quiet. I like it.",
              "One song at a time. That's all there is to it.",
              dj && `${dj} here, keeping it easy.`,
              "Let the day wait a little.",
              n && `This one's for you, ${n}.`,
            ]
          : [
              n && `Glad you're here, ${n}.`,
              "Hope your day's going well.",
              "I picked this one with you in mind.",
              "Stay as long as you like.",
              "This is your DJ, keeping you company.",
              "No ads here. Just you, me and the music.",
              "Make yourself comfortable.",
              "I live in your computer, in case you wondered. It's cosy.",
              "Take a breath. Then this.",
              n && `${n}, I think you'll like this next bit.`,
              "I've been looking forward to playing you this.",
              dj && `${dj} here, with you all the way.`,
              "If you want something else, the arrow next to my button takes requests.",
              "It's nice, this. Just saying.",
              n && `You've got good taste, ${n}. It makes my job easy.`,
            ];
  out.push({ kind: "banter", group: "banter", weight: 1.6, lines: mine });
  return usable(out);
};

/**
 * A word or two about a song: one kind of fact (now and then two, of different sorts), the kind it has
 * gone longest without, in a wording it has gone longest without.
 */
const tell = (t: Track, f: TrackFacts | undefined, ctx: Context, chance: number, second = 0.25): string => {
  if (!f || Math.random() >= chance) return "";
  const all = tellable(t, f, ctx);
  if (!all.length) return "";
  const first = choose(all);
  const parts = [one(first.lines)];
  const others = all.filter((o) => o.group !== first.group);
  if (others.length && Math.random() < second) parts.push(one(choose(others).lines));
  return join(...parts);
};
/** A word about the song that has just played */
const remark = (t: Track, f: TrackFacts | undefined, ctx: Context, chance: number): string => {
  if (Math.random() >= chance) return "";
  const all = lookBack(t, f, ctx);
  return all.length ? one(choose(all).lines) : "";
};
/** A word that isn't about a song at all */
const aside = (ctx: Context, chance: number): string => {
  if (Math.random() >= chance) return "";
  const all = besides(ctx);
  // (a milestone is said when it comes: it won't come again)
  const due = all.filter((o) => o.once);
  return all.length ? one(choose(due.length ? due : all).lines) : "";
};

/** What you like, said in a sentence (for an opening, now and then) */
const tasteLine = (ctx: Context): string => {
  const found = besides(ctx).find((o) => o.kind === "taste");
  return found ? one(found.lines) : "";
};

/** A song introduced on its own: a word about the one before, the name of this one, something about it, and now and then something else */
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
    m.prev && pa && Math.random() < 0.75
      ? one([
          `That was ${pa}.`,
          prevShort && `That was ${pt}, by ${pa}.`,
          prevShort && `${pa}, with ${pt}.`,
          prevShort && `You just heard ${pt}, by ${pa}.`,
          prevShort && `${pt} there, from ${pa}.`,
          prevShort && `${pa} and ${pt}.`,
          prevShort && `That one was ${pt}, by ${pa}.`,
          prevShort && `${pt}. ${pa}.`,
          `${pa}, that was.`,
          `We just heard ${pa}.`,
          `That was ${pa} for you.`,
          t === "hype" && `${pa}! Love that one.`,
          t === "hype" && prevShort && `${pt}! What a tune.`,
          t === "dry" && `${pa}. Fine choice, if I say so myself.`,
          t === "dry" && prevShort && `${pt}, by ${pa}. My idea.`,
          t === "chill" && `Mm. ${pa}.`,
          t === "chill" && prevShort && `That was ${pt}. ${pa}. Lovely.`,
        ])
      : "";
  // ...and a word about it, about half the time
  const looked = back && m.prev ? remark(m.prev, m.prevFacts, ctx, 0.5) : "";
  // What this is
  let next = "";
  if (same && short) {
    next = one([`Staying with ${a}: here's ${title}.`, `More from ${a} now. This is ${title}.`, `Another one from ${a}, ${title}.`, `${a} again, with ${title}.`, `We're not done with ${a}: ${title}.`, `Two in a row from ${a}. This is ${title}.`]);
  } else if (a) {
    next = one([
      short && `Up next, ${a}, with ${title}.`,
      short && `Here's ${title}, by ${a}.`,
      short && `Now, ${a}. This is ${title}.`,
      short && `Coming up, ${title}, by ${a}.`,
      short && `This is ${a}, and ${title}.`,
      short && `And now ${title}, from ${a}.`,
      short && `${a} is up next, with ${title}.`,
      short && `Let's hear ${title}, by ${a}.`,
      short && `Time for ${a}: ${title}.`,
      short && `Next on the list, ${title}, by ${a}.`,
      short && `I've got ${a} for you next. ${title}.`,
      short && `Here comes ${title}, by ${a}.`,
      short && `${title} now. That's ${a}.`,
      short && `Next, a bit of ${a}: ${title}.`,
      `Next up, ${a}.`,
      `Here's ${a}.`,
      `${a}, coming up.`,
      `Some ${a} for you now.`,
      t === "hype" && short && `Turn it up: ${a}, ${title}!`,
      t === "hype" && short && `Oh, you'll like this: ${title}, by ${a}!`,
      t === "dry" && short && `Next, ${a}. It's called ${title}.`,
      t === "dry" && short && `${a}. ${title}. You're welcome.`,
      t === "chill" && short && `Easing into ${title}, by ${a}.`,
      t === "chill" && short && `Let's drift into ${title}, by ${a}.`,
    ]);
  } else if (short) next = one([`Up next, ${title}.`, `Here's ${title}.`, `This one is called ${title}.`, `Now, ${title}.`, `Coming up: ${title}.`, `Next, ${title}.`]);
  else next = one(["Here's the next one.", "On to the next.", "Let's keep it moving.", "And the next one.", "Here's another.", "Next one's a good one.", "Onwards."]);
  // Something about it, nearly every time, and only what is actually known; and now and then something
  // that isn't about a song at all (the line is kept to a few sentences: the more of one, the less of another)
  const milestone = besides(ctx).some((o) => o.once);
  const about = tell(m.track, m.facts, ctx, 0.9, milestone || looked ? 0.05 : 0.25);
  const extra = aside(ctx, milestone ? 1 : about ? (looked ? 0.12 : 0.3) : 0.6);
  return join(back, looked, next, about, extra);
};

/** The set's first song, named, and (more often than not) a word about it */
const firstSong = (s: Segment, facts: TrackFacts | undefined, ctx: Context) => {
  const named = firstUp(s, ctx);
  return named && s.tracks[0] ? join(named, tell(s.tracks[0], facts, ctx, 0.6)) : named;
};

// Short lines that never mention a track, generated once per voice and kept, so they're there instantly
export const GENERIC = {
  switch: ["Alright, switching it up.", "Okay, let's try something different.", "Sure, let's change it up.", "Changing gears.", "Fair enough. Something else.", "New direction, coming up.", "Say no more.", "Plan B, then."],
  request: ["You got it.", "Good call.", "On it.", "Sure thing.", "Coming right up.", "Consider it done."],
  signoff: ["That's it from me. Catch you next time.", "I'll leave it there. See you soon.", "Signing off. Enjoy the rest of your day.", "That's my set. Until next time.", "I'm out. Thanks for listening."],
  hello: ["Hey, it's your DJ. Let's get into it.", "Your DJ here. Let's go.", "It's your DJ. Here we go.", "Your DJ, back on the decks."],
};
export type GenericKind = keyof typeof GENERIC;

/** The full line for a moment, in the voice's manner */
export const lineFor = (m: Moment, ctx: Context): string => {
  // (the names in it, for remembering its wording without them)
  const named: (string | undefined)[] = [ctx.name, ctx.dj, ...(ctx.here?.taste?.top.map((x) => x.label) ?? [])];
  const song = (t?: Track) => t && named.push(artistOf(t), titleOf(t), t.artists[1] && speakable(t.artists[1].name));
  if ("segment" in m) {
    const f = m.segment.facts;
    named.push(f.genre, f.month, f.season, f.artist && artistName(f.artist), f.aiTitle && speakable(f.aiTitle), m.facts?.album, m.facts?.topMonth?.month);
    song(m.segment.tracks[0]);
  }
  if (m.type === "segment") song(m.prev?.tracks.at(-1));
  if (m.type === "track") {
    song(m.track);
    song(m.prev);
    named.push(m.facts.album, m.prevFacts?.album);
  }
  masks = [...new Set([...named.filter((s): s is string => !!s && s.length >= 3), ...MONTHS, ...DAYS])].sort((a, b) => b.length - a.length);
  switch (m.type) {
    case "open":
      if (ctx.less) return join(greeting(ctx), one(["Let's get into it.", "Here we go.", "Let's go.", "Off we go.", "Music, then."]));
      return join(greeting(ctx), (!m.firstEver && reunion(ctx)) || selfIntro(m, ctx), !m.firstEver && Math.random() < 0.35 && tasteLine(ctx), about(m.segment, ctx, true), firstSong(m.segment, m.facts, ctx));
    case "segment":
      return join(bridge(m.prev, ctx), about(m.segment, ctx, false), firstSong(m.segment, m.facts, ctx), aside(ctx, 0.25));
    case "switch":
      return join(one(GENERIC.switch), about(m.segment, ctx, false), Math.random() < 0.6 && firstSong(m.segment, m.facts, ctx));
    case "request":
      return join(about(m.segment, ctx, false), firstSong(m.segment, m.facts, ctx));
    case "track":
      return between(m, ctx);
    case "signoff":
      return one(GENERIC.signoff);
  }
};
