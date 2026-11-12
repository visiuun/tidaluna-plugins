// What the DJ says. Lines are assembled from facts the DJ actually has (what the set is, where it comes
// from in your listening, what plays first, when a song came out and what it is to you) in each voice's
// own manner. It remembers what it has said, across sessions, and reaches for the wording and the kind
// of fact it has gone longest without. No language model: it's instant, private, and can't make things
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
  | { type: "track"; track: Track; prev?: Track; facts: TrackFacts }
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
  /** The song before it */
  prev?: { year?: number; bpm?: number; sameAlbum?: boolean };
};
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
type Told = { kind: string; group: "release" | "you" | "sound" | "next to"; weight: number; lines: (string | false | undefined)[] };
/** Everything that can be said about a song, by kind: only what is actually known */
const tellable = (t: Track, f: TrackFacts, tone: Tone): Told[] => {
  const now = new Date();
  const out: Told[] = [];
  const a = artistOf(t);
  const age = f.year ? now.getFullYear() - f.year : 0;
  const released = f.date ? new Date(f.date[0], f.date[1], f.date[2]) : undefined;
  const daysOut = released ? (now.getTime() - released.getTime()) / DAY : undefined;
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
        age >= 10 && `Hard to believe this is ${age} years old.`,
        age >= 10 && `It has been around for ${age} years now.`,
        age >= 20 && `${age} years old, and it still holds up.`,
        tone === "dry" && age >= 8 && `${age} years old. Older than some of my jokes.`,
        tone === "hype" && age >= 8 && `${age} years old and it still goes off!`,
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
        age >= 8 && `Taking it back to ${f.year}.`,
        age >= 15 && `A classic, from ${f.year}.`,
        age >= 15 && `All the way from ${f.year}.`,
        tone === "chill" && `${f.year}, this one. Good year.`,
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
    out.push({ kind: "decade", group: "release", weight: 0.7, lines: [`One from the ${decade}.`, `A ${decade} track, this.`, `Straight out of the ${decade}.`, `The ${decade} gave us this one.`] });
  }
  if (daysOut !== undefined && daysOut >= 0 && daysOut <= 400 && f.date) {
    const [, m] = f.date;
    out.push({
      kind: "new",
      group: "release",
      weight: 1.6,
      lines: [
        daysOut < 10 && "This only came out a few days ago.",
        daysOut >= 10 && daysOut < 60 && `It's only been out ${span(daysOut * DAY)}.`,
        daysOut >= 10 && daysOut < 60 && `Brand new: out ${span(daysOut * DAY)}.`,
        daysOut >= 60 && `It came out this ${MONTHS[m]}.`,
        daysOut >= 60 && `Out since ${MONTHS[m]}.`,
        daysOut < 200 && "Fresh out, this one.",
        daysOut < 120 && tone === "hype" && "Hot off the press!",
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
      lines: [`It's from the album ${f.album}.`, `Off the album ${f.album}.`, `You'll find it on ${f.album}.`, `That's on the album ${f.album}.`, f.year && age >= 2 ? `From ${f.album}, ${f.year}.` : undefined],
    });
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
        tone === "dry" && "New to you. Trust me.",
        tone === "hype" && "You've never heard this, and you're going to love it!",
      ],
    });
    if (f.newArtist && a) out.push({ kind: "newArtist", group: "you", weight: 1.4, lines: [`${a} is new to you, I think.`, `I don't think you've played ${a} before.`, `A first for you: ${a}.`, `You and ${a} haven't met yet.`] });
  }
  if (f.liked && !f.likedAt) out.push({ kind: "liked", group: "you", weight: 0.9, lines: ["One of your favourites.", "You've had this one saved for a while.", "One you keep close.", tone === "hype" && "You love this one!"] });
  if (f.likedAt) {
    const d = new Date(f.likedAt);
    const since = now.getTime() - f.likedAt;
    out.push({
      kind: "likedAt",
      group: "you",
      weight: 1.3,
      lines:
        since < 45 * DAY
          ? ["You only liked this recently.", `You liked this ${span(since)} ago.`, "A recent addition to your likes."]
          : [
              `You liked this back in ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              `It's been in your likes since ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              `You saved this one ${span(since)} ago.`,
              `In your likes for ${span(since)} now.`,
              tone === "dry" && `You liked this ${span(since)} ago. No regrets, I hope.`,
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
        tone === "dry" && `You've played this ${f.plays} times. I keep count.`,
        tone === "hype" && `${f.plays} plays and counting!`,
      ],
    });
  }
  if (f.lastPlayed && now.getTime() - f.lastPlayed > 21 * DAY) {
    const gone = span(now.getTime() - f.lastPlayed);
    out.push({
      kind: "lastPlayed",
      group: "you",
      weight: 1.3,
      lines: [`You haven't played this in ${gone}.`, `It's been ${gone} since you last played this.`, `Last time you played this was ${gone} ago.`, tone === "dry" && `${gone} since you last played this. It noticed.`],
    });
  }
  if (f.topMonth) {
    const when = `${f.topMonth.month} ${f.topMonth.year}`;
    out.push({ kind: "topMonth", group: "you", weight: 1.5, lines: [`This was one of your most played in ${when}.`, `You had this on heavy rotation in ${when}.`, `Back in ${when}, you played this a lot.`, `One of your songs of ${when}.`] });
  }
  if (f.artistSongs && f.artistSongs >= 4 && a) {
    out.push({
      kind: "artistSongs",
      group: "you",
      weight: 0.9,
      lines: [`You've got ${f.artistSongs} songs by ${a} saved.`, `${a} is in your library ${f.artistSongs} times.`, `One of ${f.artistSongs} from ${a} in your library.`, tone === "dry" && `${f.artistSongs} songs by ${a} in your library. A pattern.`],
    });
  }
  // ---- how it sounds ----
  if (f.seconds && f.seconds <= 150) {
    out.push({ kind: "short", group: "sound", weight: 0.8, lines: [`A short one: ${f.seconds < 126 ? "about two minutes" : "about two and a half minutes"}.`, "Blink and it's over, this one.", `Only ${f.seconds < 126 ? "two" : "two and a half"} minutes long.`] });
  }
  if (f.seconds && f.seconds >= 330) {
    const mins = Math.floor(f.seconds / 60);
    out.push({ kind: "long", group: "sound", weight: 0.8, lines: [`A long one: over ${mins} minutes.`, `Settle in, this runs past ${mins} minutes.`, `It takes its time: more than ${mins} minutes.`] });
  }
  if (f.bpm && f.bpm >= 60 && f.bpm <= 200) {
    const bpm = Math.round(f.bpm);
    const ratio = f.prev?.bpm ? f.bpm / f.prev.bpm : 1;
    out.push({
      kind: "tempo",
      group: "sound",
      weight: 0.6,
      lines: [
        ratio > 1.08 && `A little faster now: ${bpm} beats per minute.`,
        ratio > 1.08 && "Picking up the pace.",
        ratio < 0.92 && `Slowing down a touch, to ${bpm} beats per minute.`,
        ratio < 0.92 && "Easing off the pace a little.",
        `It runs at ${bpm} beats per minute.`,
        `${bpm} beats per minute, this one.`,
      ],
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
          tone === "dry" && `${Math.abs(gap)} years ${gap > 0 ? "later" : "earlier"}. Nobody will notice.`,
        ],
      });
    } else if (gap === 0 && age >= 2) {
      out.push({ kind: "sameYear", group: "next to", weight: 1.1, lines: [`Same year as the last one: ${f.year}.`, `Also from ${f.year}.`, `${f.year} again.`] });
    }
  }
  if (f.prev?.sameAlbum) out.push({ kind: "sameAlbum", group: "next to", weight: 1.6, lines: ["Same album as the last one.", "From the same album.", "We're staying on the same album."] });
  return out.filter((o) => o.lines.some(Boolean));
};

/**
 * A word or two about a song: one kind of fact (now and then two, of different sorts), the kind it has
 * gone longest without, in a wording it has gone longest without.
 */
const tell = (t: Track, f: TrackFacts | undefined, tone: Tone, chance: number): string => {
  if (!f || Math.random() >= chance) return "";
  const all = tellable(t, f, tone);
  if (!all.length) return "";
  const choose = (from: Told[]) => {
    // (among the three it has gone longest without, the weightier the likelier)
    const aged = from.map((o) => ({ o, at: lastSaid(`kind:${o.kind}`) })).sort((x, y) => x.at - y.at);
    const pool = aged.slice(0, 3).map((x) => x.o);
    let r = Math.random() * pool.reduce((s, o) => s + o.weight, 0);
    const chosen = pool.find((o) => (r -= o.weight) <= 0) ?? pool[0];
    remember(`kind:${chosen.kind}`);
    return chosen;
  };
  const first = choose(all);
  const parts = [one(first.lines)];
  const others = all.filter((o) => o.group !== first.group);
  if (others.length && Math.random() < 0.3) parts.push(one(choose(others).lines));
  return join(...parts);
};

/** A song introduced on its own: a word about the one before, the name of this one, and something about it */
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
          prevShort && `${pt} there, from ${pa}.`,
          prevShort && `${pa} and ${pt}.`,
          `${pa}, that was.`,
          `We just heard ${pa}.`,
          t === "hype" && `${pa}! Love that one.`,
          t === "hype" && prevShort && `${pt}! What a tune.`,
          t === "dry" && `${pa}. Fine choice, if I say so myself.`,
          t === "chill" && `Mm. ${pa}.`,
        ])
      : "";
  // What this is
  let next = "";
  if (same && short) next = one([`Staying with ${a}: here's ${title}.`, `More from ${a} now. This is ${title}.`, `Another one from ${a}, ${title}.`, `${a} again, with ${title}.`, `We're not done with ${a}: ${title}.`]);
  else if (a) {
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
      `Next up, ${a}.`,
      `Here's ${a}.`,
      `${a}, coming up.`,
      t === "hype" && short && `Turn it up: ${a}, ${title}!`,
      t === "dry" && short && `Next, ${a}. It's called ${title}.`,
      t === "chill" && short && `Easing into ${title}, by ${a}.`,
    ]);
  } else if (short) next = one([`Up next, ${title}.`, `Here's ${title}.`, `This one is called ${title}.`, `Now, ${title}.`, `Coming up: ${title}.`]);
  else next = one(["Here's the next one.", "On to the next.", "Let's keep it moving.", "And the next one.", "Here's another."]);
  // Something about it, nearly every time, and only what is actually known
  return join(back, next, tell(m.track, m.facts, t, 0.9));
};

/** The set's first song, named, and (more often than not) a word about it */
const firstSong = (s: Segment, facts: TrackFacts | undefined, ctx: Context) => {
  const named = firstUp(s, ctx);
  return named && s.tracks[0] ? join(named, tell(s.tracks[0], facts, ctx.tone, 0.6)) : named;
};

// Short lines that never mention a track, generated once per voice and kept, so they're there instantly
export const GENERIC = {
  switch: ["Alright, switching it up.", "Okay, let's try something different.", "Sure, let's change it up.", "Changing gears.", "Fair enough. Something else.", "New direction, coming up."],
  request: ["You got it.", "Good call.", "On it.", "Sure thing.", "Coming right up.", "Consider it done."],
  signoff: ["That's it from me. Catch you next time.", "I'll leave it there. See you soon.", "Signing off. Enjoy the rest of your day.", "That's my set. Until next time.", "I'm out. Thanks for listening."],
  hello: ["Hey, it's your DJ. Let's get into it.", "Your DJ here. Let's go.", "It's your DJ. Here we go.", "Your DJ, back on the decks."],
};
export type GenericKind = keyof typeof GENERIC;

/** The full line for a moment, in the voice's manner */
export const lineFor = (m: Moment, ctx: Context): string => {
  // (the names in it, for remembering its wording without them)
  const named: (string | undefined)[] = [ctx.name];
  const song = (t?: Track) => t && named.push(artistOf(t), titleOf(t));
  if ("segment" in m) {
    const f = m.segment.facts;
    named.push(f.genre, f.month, f.season, f.artist && artistName(f.artist), f.aiTitle && speakable(f.aiTitle), m.facts?.album, m.facts?.topMonth?.month);
    song(m.segment.tracks[0]);
  }
  if (m.type === "segment") song(m.prev?.tracks.at(-1));
  if (m.type === "track") {
    song(m.track);
    song(m.prev);
    named.push(m.facts.album, m.facts.topMonth?.month);
  }
  masks = [...new Set([...named.filter((s): s is string => !!s && s.length >= 3), ...MONTHS, ...DAYS])].sort((a, b) => b.length - a.length);
  switch (m.type) {
    case "open":
      if (ctx.less) return join(greeting(ctx), one(["Let's get into it.", "Here we go.", "Let's go.", "Off we go.", "Music, then."]));
      return join(greeting(ctx), selfIntro(m, ctx), about(m.segment, ctx, true), firstSong(m.segment, m.facts, ctx));
    case "segment":
      return join(bridge(m.prev, ctx), about(m.segment, ctx, false), firstSong(m.segment, m.facts, ctx));
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
