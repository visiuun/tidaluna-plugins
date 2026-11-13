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
      return one([
        `Hey${n}!`,
        `${timed}!`,
        `There you are${n}!`,
        `Look who it is${n ? `. Hey${n}` : ""}!`,
        `Happy ${day}${n}!`,
        ctx.name && `${ctx.name}! Good to see you.`,
        weekend && `It's the weekend${n}!`,
        `Oh, hi${n}!`,
        `Hey hey${n}!`,
        `Well, hello${n}!`,
        `Hi${n}! Perfect timing.`,
        `Yes${n}! Just who I was hoping for.`,
        `Oh good, it's you${n ? `. Hi${n}` : ""}!`,
        `${day} already${n}! Let's make it a good one.`,
        ctx.name ? `${ctx.name}! You made it!` : "You made it!",
        ctx.name && `${ctx.name}! There's my favourite listener.`,
        ctx.name && `It's ${ctx.name}! Everybody look busy.`,
        ctx.name && `${ctx.name}! I was hoping it was you.`,
        part === "morning" && `Morning${n}! Up and at it.`,
        part === "morning" && `Good morning${n}! Music first, everything else after.`,
        part === "afternoon" && `Afternoon${n}! Good time for music.`,
        part === "evening" && `Evening${n}! The best part of the day.`,
        part === "night" && `Still up${n}? Me too!`,
        weekend && `Weekend mode${n}!`,
        now.getDay() === 5 && `Friday${n}! Finally!`,
        now.getDay() === 1 && `Monday${n}! We've got this.`,
      ]);
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
      `${dj} here, back on the decks.`,
      `You've got ${dj} today. Lucky you.`,
      `${dj} here. I've been picking things out for you.`,
      ctx.tone === "hype" && `${dj} in the booth! Let's have some fun.`,
      ctx.tone === "hype" && `It's me, ${dj}! I've been waiting to play you this.`,
      ctx.tone === "hype" && `${dj} here, and I came prepared!`,
      ctx.tone === "hype" && `Guess who! It's ${dj}. Obviously it's ${dj}.`,
      ctx.tone === "hype" && `${dj} reporting for duty! The duty is songs.`,
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
      "Twice in one day. I like it.",
      "Back again. I've got more where that came from.",
      "Oh good, we weren't finished.",
      ctx.tone === "hype" && "You're back! I saved the good ones.",
      ctx.tone === "hype" && "Round two! I've barely warmed up.",
      ctx.tone === "hype" && "Again? Yes! Again!",
      ctx.tone === "hype" && "I was hoping you'd come back. I had more to play you!",
      ctx.tone === "hype" && "Twice in one day! I must be doing something right.",
      ctx.tone === "hype" && "You came back! Best decision you've made today.",
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
        "It's your DJ! I've got plans for us.",
        "Your DJ here, and I've been looking forward to this.",
        "Your DJ's in the booth. Well, in the computer. Same thing!",
        "It's your DJ, with a stack of songs and no intention of stopping.",
        "Your DJ here! I went through your music and got carried away.",
        "It's your DJ. I've lined up the good stuff.",
        "Your DJ, warmed up and ready to go!",
        "It's your DJ! Sit down, stand up, dance, whatever works.",
        "Your DJ here. I've got a good feeling about today's music.",
        "It's your DJ, and I picked every one of these myself!",
        "Your DJ's here, and the playlist is looking very good.",
        "It's your DJ. Volume up, worries down.",
        "Your DJ here! I've been through your music, and oh, we're going to have fun.",
        "It's your DJ. I hope you're ready, because I am!",
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
      `Our ${ordinal(count + 1)} session together. Time flies.`,
      t === "hype" && `Our ${ordinal(count + 1)} session! Somebody get a cake.`,
      t === "hype" && `${count + 1} sessions! We're basically a team now.`,
    ]);
  }
  const gone = here.sinceLast;
  if (gone === undefined) return "";
  if (gone < 40 * 60e3) {
    return one([
      "Miss me already?",
      "That was a short break.",
      "Back so soon. Good.",
      t === "dry" && "You were gone for minutes. I counted.",
      t === "hype" && "You're back! I knew you would be.",
      "Oh, hello again.",
      "You were barely gone.",
      t === "hype" && "That was quick! I love it.",
      t === "hype" && "Back already! I hadn't even sat down.",
      t === "hype" && "I knew it. You can't stay away!",
    ]);
  }
  if (gone > 30 * DAY) {
    return one([
      `It's been ${span(gone)}! Where have you been?`,
      `${span(gone)} since last time. I kept your seat.`,
      `Look who's back after ${span(gone)}.`,
      t === "dry" && `${span(gone)}. I'd nearly forgotten your face. I never knew your face.`,
      `It's been ${span(gone)}. We've got catching up to do.`,
      `It's been ${span(gone)}, and I've got so much to play you.`,
      t === "hype" && `It's been ${span(gone)}! Finally! Come in, come in.`,
      t === "hype" && `You're back! ${span(gone)} is far too long.`,
      t === "hype" && `It's been ${span(gone)}, and I saved up all the good ones!`,
    ]);
  }
  if (gone > 3 * DAY) {
    return one([
      `It's been ${span(gone)}. I was starting to wonder.`,
      `${span(gone)} without me. How did you cope?`,
      `Good to have you back after ${span(gone)}.`,
      t === "dry" && `${span(gone)}. Not that I was counting.`,
      t === "hype" && `${span(gone)}! I missed this.`,
      t === "chill" && `${span(gone)} away. No hurry, you're here now.`,
      `It's been ${span(gone)} since our last one. Let's make up for it.`,
      `It's been ${span(gone)}. I've been saving things for you.`,
      t === "hype" && `It's been ${span(gone)}! I've got so much lined up.`,
      t === "hype" && `Finally! It's been ${span(gone)}, you know.`,
      t === "hype" && `It's been ${span(gone)}, and you came back to me. Good choice!`,
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
        "The ones you can't leave alone right now.",
        "Your most played of the moment, in a row.",
        "Straight from the top of your recent plays.",
        t === "hype" && "The songs you've been hammering lately. I get it, they're great!",
        t === "hype" && "You've had these on a loop, and honestly, same!",
        t === "hype" && "Your favourites of the moment! Let's wear them out a little more.",
        t === "hype" && "I checked what you've been playing most. Good news: it's all good!",
        t === "hype" && "You keep playing these, so I will too!",
      ]);
    case "recentLikes":
      return one([
        "You've been hitting the heart on some good ones recently. Let's run through a few.",
        "Here are some of your latest likes.",
        "Some of the tracks you saved recently, coming up.",
        "A few of the newest additions to your likes.",
        "The ones you've liked most recently, back to back.",
        t === "dry" && "You've been liking things again. Let's review.",
        "Fresh from your likes: the latest ones you saved.",
        "The newest hearts in your collection.",
        "You've been collecting lately. Here's what you picked up.",
        t === "hype" && "Your newest likes! You've been on a roll.",
        t === "hype" && "You liked these recently, and I think you were right every time!",
        t === "hype" && "Straight from your latest likes. Great picks, by the way!",
        t === "hype" && "I saw what you've been liking lately. Yes to all of it!",
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
          `${f.month} ${f.year}. Let's hear what you were up to.`,
          `Your ${f.month} ${f.year}, song by song.`,
          `I found your ${f.month} ${f.year}. These were on all the time.`,
          t === "hype" && `Oh, I love this: your ${f.month} ${f.year}! These were everything to you.`,
          t === "hype" && `We're going back to ${f.month} ${f.year}! Bring snacks.`,
          t === "hype" && `${f.month} ${f.year}! You had great taste back then too.`,
          t === "hype" && `Time machine's ready! Next stop, ${f.month} ${f.year}, and your most played.`,
        ]);
      }
      return one([
        `Let's go back to the ${f.season} of ${f.year}, when you first liked these.`,
        `Time for a throwback. These are from your ${f.season} of ${f.year}.`,
        `The ${f.season} of ${f.year} now. You saved all of these back then.`,
        `Your ${f.season} of ${f.year}: these are the ones you liked back then.`,
        `Remember the ${f.season} of ${f.year}? You liked all of these that season.`,
        t === "hype" && `The ${f.season} of ${f.year}! You were saving some great ones.`,
        t === "hype" && `Throwback! The ${f.season} of ${f.year}, when you found all of these.`,
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
        `Time for some ${f.genre}. It's one of your things.`,
        `A stretch of ${f.genre} now. You've got a lot of it.`,
        `Let's see what your ${f.genre} shelf has for us.`,
        t === "hype" && `Your ${f.genre} side! One of my favourite sides of you.`,
        t === "hype" && `Some ${f.genre} now, and you've got so much of the good stuff!`,
        t === "hype" && `Let's raid your ${f.genre} collection!`,
        t === "hype" && `I'm in the mood for your ${f.genre}. Hope you are too!`,
        t === "hype" && `You and ${f.genre}: a love story. Here's the next chapter.`,
      ]);
    case "usual": {
      const when = `${f.weekend ? "weekend" : "weekday"} ${f.daypart === "late night" ? "night" : f.daypart}`;
      return one([
        `This is what you usually play on a ${when}, going by True Taste.`,
        `Your ${when} usual. True Taste has been keeping track.`,
        `Around this hour on a ${f.weekend ? "weekend" : "weekday"}, you tend to play these.`,
        `True Taste knows what you play at this time of day. Here it is.`,
        `It's a ${when}, and this is what you play on those.`,
        t === "dry" && `It's a ${when}. Statistically, you want these.`,
        t === "hype" && `Your ${when} favourites! True Taste has the receipts.`,
        t === "chill" && `The usual for a ${when}. No surprises.`,
        `A ${when} like this one usually sounds like this for you.`,
        `True Taste tells me this is your ${when} sound.`,
        t === "hype" && `It's a ${when}, and I know exactly what you like on those!`,
        t === "hype" && `True Taste told me what you play on a ${when}. So here it is!`,
        t === "hype" && `Your ${when} routine! I've got it memorised.`,
      ]);
    }
    case "discovery":
      return one([
        f.byTrueTaste && "Some new ones, ranked by what True Taste has learned about you.",
        f.byTrueTaste && "New music now. True Taste thinks these are the ones you'll keep.",
        f.byTrueTaste && "A few you haven't heard, picked the way True Taste has learned you like them.",
        "Now for some things you haven't heard yet. I picked these based on what you've been playing.",
        "Time for something new. None of these are in your library, but I think they'll fit right in.",
        "Let me put you on to a few new ones.",
        "A few you don't know yet, close to what you've been playing.",
        "Some new names now. I think you'll get along.",
        "Let's widen things a little: these are all new to you.",
        t === "dry" && "Some new music now. Trust me on these.",
        t === "hype" && "New music time! You haven't heard any of these yet.",
        t === "chill" && "Something new now. No pressure, just see how it sits.",
        "Brand new to you, all of these. I picked them to fit.",
        "Let's go exploring: nothing here is in your library yet.",
        "New ones now, close to what you already love.",
        f.byTrueTaste && "True Taste and I have been comparing notes. These are new, and they should fit.",
        t === "hype" && "Okay, new music! I've been dying to play you these.",
        t === "hype" && "You haven't heard these, and I can't wait to see which ones you keep!",
        t === "hype" && "Discovery time! I went digging and came back with treasure.",
        t === "hype" && "Ooh, new songs! I think there's a future favourite in here.",
        t === "hype" && "None of these are in your library. Yet!",
        t === "hype" && f.byTrueTaste && "True Taste picked these out for you, and I'm excited about them!",
      ]);
    case "artist": {
      const who = artistName(f.artist);
      // (a name that can't be said is "this artist": only the wordings that read well with that)
      const named = who !== "this artist";
      return one([
        `Let's put the spotlight on ${who} for a few songs. Some you know, and one or two you might not.`,
        `You've been listening to a lot of ${who}. Let's stay with them for a bit.`,
        `A few from ${who} now, including something you may not have heard.`,
        `${who}, for the next few songs.`,
        `Let's give ${who} the floor for a while.`,
        `Time for a run of ${who}.`,
        `Let's stay with ${who} for a few songs.`,
        named && `A little ${who} session now.`,
        named && `${who} takes over for a few.`,
        named && t === "hype" && `${who} time! A few in a row.`,
        named && t === "hype" && `Let's have a ${who} moment! You know you want to.`,
        named && t === "hype" && `I feel like some ${who}. A lot of ${who}, actually!`,
        named && t === "hype" && `The next few songs belong to ${who}, and I'm not sorry!`,
      ]);
    }
    case "forgotten":
      return one([
        "Here are some old favourites you haven't played in a while.",
        "You used to love these, and it's been a minute. Let's bring them back.",
        t === "dry" ? "Some songs you've been neglecting. They've noticed." : "Some songs that deserve another listen.",
        "A few you've let slip lately. Let's fix that.",
        "Some that have been gathering dust in your library.",
        "It's been a while since you played these. Too long, I'd say.",
        "Some you loved and then left alone. Let's go back.",
        "These haven't had a play from you in ages.",
        "Remember these? It's been a long time.",
        t === "hype" && "I found some old favourites hiding in your library! Let's get them out.",
        t === "hype" && "You forgot about these! I didn't.",
        t === "hype" && "Old favourites, back in the room! You'll know them straight away.",
        t === "hype" && "It's a reunion! You and some songs you haven't played in way too long.",
      ]);
    case "mood":
      if (f.daypart === "morning") {
        return one([
          "Let's ease into the morning with something gentle.",
          "Something easy to start the day.",
          "A soft start to the morning.",
          "Nothing too loud yet: it's still morning.",
          "Morning music: nothing in a hurry.",
          "Let's wake up slowly.",
          t === "hype" && "Good morning music! Gentle first, we'll build up.",
          t === "hype" && "Easy does it, it's morning! The loud ones come later.",
        ]);
      }
      if (f.daypart === "afternoon") {
        return one([
          "Let's pick the energy up for the afternoon.",
          "Something with a bit more energy for the afternoon.",
          "The afternoon needs a lift. Here it is.",
          "A little more pace for the afternoon.",
          "Afternoon. Time to pick things up.",
          "Let's shake off the afternoon slump.",
          t === "hype" && "Afternoon energy, coming up!",
          t === "hype" && "It's the afternoon! Let's get things moving.",
        ]);
      }
      if (f.daypart === "evening") {
        return one([
          "Here's something for the evening.",
          "Let's set the mood for the evening.",
          "Evening music, coming up.",
          "Something to settle into the evening with.",
          "The evening's here. Music to match.",
          "Let's ease into the evening.",
          t === "hype" && "Evening! Let's set the scene.",
          t === "hype" && "It's the evening, and I've got just the thing!",
        ]);
      }
      return one([
        "It's late, so let's keep things atmospheric.",
        "Some late night music now.",
        "It's late. Let's keep the lights low.",
        "Something for the small hours.",
        "Late night listening, coming up.",
        "The quiet hours. Music to suit.",
        t === "hype" && "It's late, so I'll keep it moody. Quietly excited, though!",
        t === "hype" && "Night music! Lights down, sound up.",
      ]);
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
          `Still ${f.genre}. It's working, so why stop.`,
          `A little more ${f.genre} before we move on.`,
          `We're deep in the ${f.genre} now.`,
          t === "hype" && `More ${f.genre}! I'm not done and neither are you.`,
          t === "hype" && `The ${f.genre} keeps coming!`,
          t === "hype" && `You thought I was done with the ${f.genre}? Not a chance!`,
          t === "hype" && `This ${f.genre} run is too good to stop.`,
        ]);
      }
      return one([
        "More in the same vein.",
        "Let's keep this going.",
        "Staying right where we are.",
        "Same direction, a few more.",
        "No sharp turns: more like that.",
        opening && "I'll keep things in this lane.",
        "Along the same lines.",
        "More where that came from.",
        "We'll keep going this way.",
        t === "hype" && "Same vibe, more songs. Let's go!",
        t === "hype" && "This is working, so I'm keeping it going!",
        t === "hype" && "More of this! I'm enjoying myself.",
      ]);
    case "dailyMix":
      return one([
        "Here's a run from one of your mixes.",
        "A few picks from one of your daily mixes.",
        "Some from one of your mixes now.",
        "I've borrowed a few from one of your daily mixes.",
        "One of your mixes had these in it. I helped myself.",
        "A handful from your daily mixes.",
        t === "hype" && "I raided one of your mixes! Here's the best of it.",
        t === "hype" && "Straight from one of your daily mixes, and they're good ones!",
      ]);
    case "request":
      switch (f.matched) {
        case "artist": {
          const who = artistName(f.artist);
          const named = who !== "this artist";
          return one([
            `Some ${who}, coming right up.`,
            `${who} it is.`,
            `Here's a run of ${who}.`,
            `${who}. Good choice.`,
            `A few from ${who}, as asked.`,
            named && `You asked for ${who}, you get ${who}.`,
            named && `${who}, lined up and ready.`,
            named && t === "hype" && `${who}! Yes! Great pick.`,
            named && t === "hype" && `Ooh, ${who}. I was hoping you'd ask.`,
            named && t === "hype" && `${who}, coming up! You've got taste.`,
            named && t === "hype" && `${who}? Say no more!`,
          ]);
        }
        case "radio":
          return one([
            "More like that one, coming up.",
            "I liked that one too. Here's more in the same spirit.",
            "Here's more where that came from.",
            "More along those lines.",
            "More in that direction, then.",
            "Same feeling, new songs.",
            t === "hype" && "You liked that one? Then you'll love these!",
            t === "hype" && "More like that! I know just the ones.",
            t === "hype" && "Good ear! Here's more of the same.",
          ]);
        case "year":
          return one([
            `Back to ${f.year} it is. Here's what you were listening to.`,
            `Here's your ${f.year}.`,
            `${f.year}, as you heard it.`,
            `Your ${f.year}, coming up.`,
            `${f.year}. Let's see what you had on.`,
            `Going back to your ${f.year}.`,
            t === "hype" && `${f.year}! Good year. Here's how yours sounded.`,
            t === "hype" && `Your ${f.year}, coming right up!`,
          ]);
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
              `Let's call it ${named}.`,
              `Here you go: ${named}.`,
              t === "hype" && `Ooh, good one. I made you ${named}!`,
              t === "hype" && `${named}! I had fun putting this together.`,
              t === "hype" && `Ta-da! ${named}.`,
            ]);
          }
          return one([
            "Here's what I put together for that.",
            "This is what I found for you.",
            "Let's see how this feels.",
            "I've got something for that.",
            "Try this.",
            "Here's my take on that.",
            "I think this is what you meant.",
            "See if this hits the spot.",
            t === "hype" && "Ooh, I know just the thing!",
            t === "hype" && "Great idea! Here's what I came up with.",
            t === "hype" && "On it! This should do nicely.",
            t === "hype" && "Love that! Here's what I've got.",
          ]);
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
    return short
      ? one([
          `Starting with ${title}.`,
          `First up, ${title}.`,
          `Here's ${title}.`,
          `We open with ${title}.`,
          `${title} goes first.`,
          `${title} to start.`,
          `Let's begin with ${title}.`,
          `${title} kicks it off.`,
          ctx.tone === "hype" && `We start with ${title}. Great opener!`,
          ctx.tone === "hype" && `First one's ${title}. Let's go!`,
          ctx.tone === "hype" && `${title} first, because I couldn't wait!`,
        ])
      : "";
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
    short && `Let's begin with ${a}, and ${title}.`,
    short && `${title} first. That's ${a}.`,
    short && `To start: ${a}, ${title}.`,
    `We begin with ${a}.`,
    `${a} opens.`,
    ctx.tone === "hype" && short && `${a} starts us off with ${title}. Here we go!`,
    ctx.tone === "hype" && short && `First up is ${title}, by ${a}, and it's a good one!`,
    ctx.tone === "hype" && short && `Let's open with ${title}, by ${a}. Ready?`,
    ctx.tone === "hype" && short && `${title}, by ${a}, to get us going. Yes!`,
    ctx.tone === "hype" && `${a} first! Let's go.`,
    ctx.tone === "hype" && `We're starting with ${a}, and I'm already happy.`,
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
    a && `${a}, to finish that set.`,
    a && short && `${title}, by ${a}, to round that off.`,
    a && `That was ${a}, closing that one out.`,
    "That's that set done.",
    "That set's done. On we go.",
    prev?.kind === "discovery" && "Any keepers in there? The heart's right there.",
    prev?.kind === "forgotten" && "See? Still good.",
    prev?.kind === "onRepeat" && "No wonder you keep playing those.",
    prev?.kind === "recentLikes" && "Good likes, those.",
    ctx.tone === "hype" && prev?.kind === "throwback" && "That took me right back. It wasn't even my past!",
    ctx.tone === "hype" && prev?.kind === "discovery" && "New favourites in there? I think so!",
    ctx.tone === "hype" && "That was fun! Next.",
    ctx.tone === "hype" && "Loved that set.",
    ctx.tone === "hype" && "What a run that was!",
    ctx.tone === "hype" && "Okay! I enjoyed that.",
    ctx.tone === "hype" && "That set flew by.",
    ctx.tone === "hype" && a && `${a} to finish! Lovely.`,
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
        `${age} years ago, this arrived.`,
        `It turns ${age} this year.`,
        age >= 5 && `${age} years on, and here it is again.`,
        age >= 10 && age % 10 === 0 && `A round ${age} years old this year.`,
        age >= 15 && `${age} years old. It has earned its place.`,
        age >= 25 && `${age} years old, and still getting played. That's a song.`,
        tone === "hype" && age < 8 && `Only ${age} years old, this one. Still fresh!`,
        tone === "hype" && age >= 5 && `${age} years old and I'm still not tired of it!`,
        tone === "hype" && age >= 10 && `${age} years! And it still sounds brilliant.`,
        tone === "hype" && age >= 10 && age % 10 === 0 && `It's ${age} this year! A big birthday.`,
        tone === "hype" && age >= 15 && `${age} years old and it can still fill a room!`,
        tone === "hype" && age >= 20 && `This is ${age} years old! Older than a lot of the people who love it.`,
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
        `${f.year} gave us this.`,
        `A ${f.year} release.`,
        `This came out in ${f.year}.`,
        age >= 8 && `Back to ${f.year} for this one.`,
        age >= 15 && `${f.year}. That's a while ago now.`,
        tone === "hype" && `Straight from ${f.year}. Good vintage!`,
        tone === "hype" && `${f.year}, this one! I love that year.`,
        tone === "hype" && age >= 8 && `We're in ${f.year} now, and it sounds great!`,
        tone === "hype" && age >= 15 && `${f.year}! A proper classic.`,
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
        `It has been out since ${MONTHS[m]} ${y}.`,
        `First released in ${MONTHS[m]}, ${y}.`,
        `This arrived on the ${ordinal(d)} of ${MONTHS[m]}, ${y}.`,
        tone === "hype" && `Born on the ${ordinal(d)} of ${MONTHS[m]}, ${y}. Yes, I know its birthday!`,
        tone === "hype" && `${MONTHS[m]} ${y}! That's when the world got this one.`,
      ],
    });
    // (the day of the week it came out on)
    const weekday = DAYS[released.getDay()];
    out.push({
      kind: "weekday",
      group: "release",
      weight: 0.6,
      lines: [
        `It came out on a ${weekday}.`,
        `A ${weekday} release, this one.`,
        `This came out on a ${weekday}, in ${MONTHS[m]} ${y}.`,
        released.getDay() === now.getDay() && `It came out on a ${weekday}, like today.`,
        tone === "hype" && `Fun fact: this came out on a ${weekday}!`,
        tone === "hype" && `It was a ${weekday} when this came out. I looked it up!`,
        tone === "dry" && `It came out on a ${weekday}. Now you know.`,
      ],
    });
    // (its birthday, when that is near: counted in whole days, midnight to midnight)
    const years = now.getFullYear() - y;
    const yrs = `${years} ${years === 1 ? "year" : "years"}`;
    const birthday = new Date(now.getFullYear(), m, d);
    const off = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - birthday.getTime()) / DAY);
    if (years >= 1 && m === now.getMonth()) {
      out.push({
        kind: "anniversary",
        group: "release",
        weight: 3,
        lines: [
          off === 0 && `It came out ${yrs} ago today.`,
          off === 0 && `Happy birthday to this one: ${years} today.`,
          off > 0 && off <= 6 && `It turned ${years} this week.`,
          off < 0 && off >= -6 && `It turns ${years} in ${-off === 1 ? "a day" : `${-off} days`}.`,
          Math.abs(off) > 6 && `It came out ${yrs} ago this month.`,
          Math.abs(off) > 6 && `${yrs} old this month.`,
          off === 0 && `Today's the day it came out, ${yrs} ago.`,
          off > 0 && off <= 6 && `Its birthday was ${off === 1 ? "yesterday" : `${off} days ago`}. It's ${years} now.`,
          off < 0 && off >= -6 && `Its birthday is ${-off === 1 ? "tomorrow" : `in ${-off} days`}: ${yrs}.`,
          off > 6 && `It turned ${years} earlier this month.`,
          off < -6 && `It turns ${years} later this month.`,
          tone === "hype" && off === 0 && `It's this song's birthday! ${years} today. Happy birthday, song!`,
          tone === "hype" && off === 0 && `${yrs} ago today, this came out. Today! What are the chances?`,
          tone === "hype" && off > 0 && off <= 6 && `It just turned ${years}! Belated happy birthday.`,
          tone === "hype" && off < 0 && off >= -6 && `It turns ${years} ${-off === 1 ? "tomorrow" : `in ${-off} days`}! Early birthday play.`,
          tone === "hype" && Math.abs(off) > 6 && `It's this one's birthday month! ${yrs}.`,
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
      lines: [
        `One from the ${decade}.`,
        `A ${decade} track, this.`,
        `Straight out of the ${decade}.`,
        `The ${decade} gave us this one.`,
        `Proper ${decade}, this.`,
        tone === "hype" && `The ${decade} are calling!`,
        `A ${decade} one.`,
        `The ${decade}, everybody.`,
        `From the ${decade}, and it shows. In a good way.`,
        tone === "hype" && `I love the ${decade}!`,
        tone === "hype" && `The ${decade}! Good times. I assume. I wasn't there.`,
        tone === "hype" && `Pure ${decade}, this one!`,
      ],
    });
  }
  if (f.year) {
    // (what it is older than: the two nearest things)
    const before = ERAS.filter(([[y, m, d]]) => (f.date ? new Date(f.date[0], f.date[1], f.date[2]).getTime() < new Date(y, m, d).getTime() : f.year! < y)).slice(0, 2);
    const lines: (string | false)[] = [];
    for (const [, thing] of before) {
      const Thing = `${thing[0].toUpperCase()}${thing.slice(1)}`;
      lines.push(
        `This is older than ${thing}.`,
        `${Thing} didn't exist yet when this came out.`,
        `It came out before ${thing} did.`,
        `${Thing} came along after this did.`,
        `This got here before ${thing}.`,
        tone === "hype" && `This is older than ${thing}! Imagine that.`,
        tone === "hype" && `Older than ${thing}, and still getting played!`,
      );
    }
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
        daysOut < 10 && "It has only been out a matter of days.",
        daysOut >= 10 && daysOut < 60 && `Only ${span(daysOut * DAY)} old, this one.`,
        daysOut >= 60 && daysOut < 200 && `A ${MONTHS[m]} release, so still new.`,
        daysOut < 200 && "One of the newer ones.",
        daysOut < 10 && tone === "hype" && "This is days old! We're early.",
        daysOut >= 10 && daysOut < 60 && tone === "hype" && `Out for ${span(daysOut * DAY)} and already on my list!`,
        daysOut < 120 && tone === "hype" && "This one's brand new! Love a new one.",
        daysOut < 120 && tone === "hype" && "Fresh! It still has that new song smell.",
        daysOut < 200 && tone === "hype" && "New music! My favourite kind. All kinds are my favourite kind.",
      ],
    });
  } else if (f.year && age <= 1 && !f.date) {
    out.push({
      kind: "new",
      group: "release",
      weight: 1.2,
      lines: ["Fresh out, this one.", age === 0 ? "One of this year's." : "Out since last year.", "A recent one.", "One of the newer ones.", tone === "hype" && "A new one! Love that.", tone === "hype" && "This one's still new. Get in early!"],
    });
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
        `It's on ${f.album}.`,
        `Taken from ${f.album}.`,
        `${f.album} is the album.`,
        `That's a track from ${f.album}.`,
        tone === "hype" && `It's off ${f.album}. Great album!`,
        tone === "hype" && `From the album ${f.album}, which I'd happily play all of!`,
      ],
    });
  }
  if (f.version) {
    const v = f.version;
    const hype = tone === "hype";
    out.push({
      kind: "version",
      group: "release",
      weight: 1,
      lines:
        v === "remix"
          ? [
              "This is the remix.",
              "The remix, this one.",
              "Not the original: the remix.",
              hype && "The remix! Even better.",
              "A remix, this.",
              "Someone took this apart and put it back together: it's the remix.",
              hype && "It's the remix, and I might like it more!",
            ]
          : v === "live"
            ? [
                "A live one, this.",
                "Recorded live.",
                "This is the live version. Listen for the crowd.",
                "Live, this one. A real room, real people.",
                "This was recorded in front of a crowd.",
                hype && "It's live! I love a live one.",
                hype && "The live version! Pretend you were there.",
              ]
            : v === "acoustic"
              ? ["The acoustic version.", "Stripped back: this is the acoustic one.", "Acoustic, this one.", "Just the bare bones: the acoustic take.", "Unplugged, this one.", hype && "The acoustic one! So pretty."]
              : v === "remaster"
                ? ["Remastered, this one.", "The remastered version.", "Cleaned up and remastered.", "A remaster: same song, shinier.", "This is the polished up version.", hype && "Remastered! Same song, extra sparkle."]
                : v === "extended"
                  ? ["The extended version: more of everything.", "This is the extended mix.", "The long cut.", "The extended cut, so there's more to love.", "Extra long, this version.", hype && "The extended mix! More song, same price."]
                  : v === "instrumental"
                    ? ["Instrumental: no words, just the music.", "No vocals on this one.", "The instrumental.", "Just the music on this one.", "Nobody sings on this. You can, though.", hype && "No vocals! That's your part."]
                    : v === "sped up"
                      ? ["The sped up version.", "A little faster than it was made.", "Faster than the original, this.", hype && "The sped up one! Keep up."]
                      : ["The slowed down version.", "Slowed right down, this one.", "The slowed version. Take your time.", hype && "Slowed down! Nice and dreamy."],
    });
  }
  const guest = t.artists[1] ? speakable(t.artists[1].name) : "";
  if (a && guest && sayable(guest) && guest !== a && guest.length <= 28) {
    out.push({
      kind: "guest",
      group: "release",
      weight: 0.9,
      lines: [
        `With ${guest} along for the ride.`,
        `${a} and ${guest}, together on this one.`,
        `${guest} is on this one too.`,
        `That's ${a}, with ${guest}.`,
        `${guest} joins in on this one.`,
        `Featuring ${guest}.`,
        `${guest} drops by for this.`,
        tone === "hype" && `${a} and ${guest}! What a pair.`,
        tone === "hype" && `${guest} is on this too, which makes it even better!`,
      ],
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
        "Never heard this one, have you. Good.",
        "Tell me what you think of this one.",
        tone === "dry" && "New to you. Trust me.",
        tone === "hype" && "You've never heard this, and you're going to love it!",
        tone === "chill" && "A new one. Just see how it feels.",
        "Here's one you haven't met.",
        "This one hasn't crossed your path yet.",
        "Something you haven't played before.",
        "Let's try one you don't know.",
        tone === "hype" && "Ooh, a new one for you! I'm excited.",
        tone === "hype" && "First listen! I love first listens.",
        tone === "hype" && "You don't know this yet, and I'm a little jealous. First time's the best!",
        tone === "hype" && "New to you! Give it a minute, it's a good one.",
        tone === "hype" && "I've been saving this one for you. You haven't heard it!",
        tone === "hype" && "Okay, you haven't heard this. Trust me!",
        tone === "hype" && "A brand new one for you. I've got a good feeling about it!",
      ],
    });
    if (f.newArtist && a) {
      out.push({
        kind: "newArtist",
        group: "you",
        weight: 1.4,
        lines: [
          `${a} is new to you, I think.`,
          `I don't think you've played ${a} before.`,
          `A first for you: ${a}.`,
          `You and ${a} haven't met yet.`,
          `Let me introduce you to ${a}.`,
          `${a} is a new name for you.`,
          `Meet ${a}.`,
          `First time with ${a}, as far as I know.`,
          tone === "hype" && `You haven't played ${a} before! Allow me.`,
          tone === "hype" && `New artist alert: ${a}!`,
          tone === "hype" && `${a}! New to you, and I think you two will get along.`,
        ],
      });
    }
  }
  if (f.liked && !f.likedAt) {
    out.push({
      kind: "liked",
      group: "you",
      weight: 0.9,
      lines: [
        "One of your favourites.",
        "You've had this one saved for a while.",
        "One you keep close.",
        "This one's yours through and through.",
        "I know you like this one.",
        tone === "hype" && "You love this one!",
        tone === "dry" && "You like this one. I've seen the numbers.",
        "A keeper of yours.",
        "You like this one, and you're right to.",
        "This is one of yours.",
        tone === "hype" && "It's one of yours! Great choice, past you.",
        tone === "hype" && "One of your favourites! Mine too, now.",
        tone === "hype" && "You like this one, and I completely agree!",
        tone === "hype" && "This one's a favourite of yours. I can tell. I'm good like that.",
      ],
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
          ? [
              "You only liked this recently.",
              `You liked this ${span(since)} ago.`,
              "A recent addition to your likes.",
              "Still new in your likes, this one.",
              "One of your newer likes.",
              `Liked ${span(since)} ago, so it's still new to the collection.`,
              tone === "hype" && "You only just liked this! Good find.",
              tone === "hype" && `You liked this ${span(since)} ago, and I approve!`,
              tone === "hype" && "A new like of yours! I spotted it straight away.",
            ]
          : [
              `You liked this back in ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              `It's been in your likes since ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              `You saved this one ${span(since)} ago.`,
              `In your likes for ${span(since)} now.`,
              `You hit the heart on this in ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              tone === "dry" && `You liked this ${span(since)} ago. No regrets, I hope.`,
              tone === "hype" && `${span(since)} in your likes and still a favourite!`,
              `${MONTHS[d.getMonth()]} ${d.getFullYear()}: that's when you liked this.`,
              `You've had this saved since ${MONTHS[d.getMonth()]} ${d.getFullYear()}.`,
              `This joined your likes ${span(since)} ago.`,
              tone === "hype" && `You liked this back in ${MONTHS[d.getMonth()]} ${d.getFullYear()}, and it's still here. That's love!`,
              tone === "hype" && `In your likes since ${MONTHS[d.getMonth()]} ${d.getFullYear()}! Good call, past you.`,
              tone === "hype" && `You liked this ${span(since)} ago and never looked back!`,
            ],
    });
    // (how the day you liked it sits next to the day it came out)
    const likedYear = d.getFullYear();
    if (f.year && likedYear === f.year && age >= 1 && f.version !== "remaster") {
      out.push({
        kind: "dayOne",
        group: "you",
        weight: 1.2,
        lines: [
          "You liked this the year it came out.",
          `You've had this since ${f.year}, the year it came out.`,
          "You were early on this one: you liked it the year it was released.",
          tone === "hype" && "You liked this the year it came out! You were there from the start.",
          tone === "hype" && "You found this when it was brand new. Early! I'm impressed.",
          tone === "dry" && "You liked this the year it came out. Before it was cool, presumably.",
        ],
      });
    } else if (f.year && likedYear - f.year >= 5) {
      const late = likedYear - f.year;
      out.push({
        kind: "lateFind",
        group: "you",
        weight: 1.1,
        lines: [
          `It was already ${late} years old when you liked it.`,
          `You liked this ${late} years after it came out.`,
          `This had been out ${late} years before you liked it.`,
          tone === "hype" && `It took you ${late} years to get to this one. Worth the wait!`,
          tone === "hype" && `It was ${late} years old when you liked it! Better late than never.`,
          tone === "dry" && `It was ${late} years old when you liked it. Fashionably late.`,
        ],
      });
    }
  }
  if (f.plays && f.plays >= 4) {
    const milestone = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500].includes(f.plays + 1);
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
        `${f.plays} times you've had this on, that I know of.`,
        `My count says ${f.plays} plays for this one.`,
        f.plays >= 10 && `You're ${f.plays} plays deep on this one.`,
        f.plays >= 30 && `${f.plays} plays. This one's part of the furniture.`,
        milestone && `This is play number ${f.plays + 1} for you. A milestone.`,
        tone === "hype" && `${f.plays} plays! You and this song. I love it.`,
        tone === "hype" && `Play number ${f.plays + 1}, coming up! Not that I'm counting. I'm counting.`,
        tone === "hype" && f.plays >= 20 && `${f.plays} plays and you're still not sick of it. Neither am I!`,
        tone === "hype" && milestone && `Play number ${f.plays + 1}! That's a big one. Congratulations to you both.`,
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
          ? [
              "You always play this one to the end.",
              "You never skip this one.",
              "This one always gets the full listen from you.",
              tone === "dry" && "You've never skipped this. Don't start now.",
              "This one never gets cut short by you.",
              "You've never bailed on this one.",
              tone === "hype" && "You always play this to the end, so I know it's a good one!",
              tone === "hype" && "Never skipped! Not once. I checked.",
            ]
          : [
              "You don't usually finish this one. Let's see about today.",
              "You tend to skip this one. I'm trying anyway.",
              tone === "dry" && "You usually skip this. I live in hope.",
              "This one rarely makes it to the end with you. Today could be the day.",
              tone === "hype" && "You usually skip this one, but I believe in it!",
              tone === "hype" && "You don't often finish this. Give it a chance, for me!",
            ],
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
        `This one's been waiting ${gone} for another play.`,
        `You last had this on ${gone} ago.`,
        `It's been ${gone}. Remember this one?`,
        tone === "hype" && `It's been ${gone}! Let's fix that right now.`,
        tone === "hype" && `You haven't played this in ${gone}, and it's still great!`,
        tone === "hype" && `Look what I found! You haven't played this in ${gone}.`,
      ],
    });
  }
  if (f.topMonth) {
    const when = `${f.topMonth.month} ${f.topMonth.year}`;
    out.push({
      kind: "topMonth",
      group: "you",
      weight: 1.5,
      lines: [
        `This was one of your most played in ${when}.`,
        `You had this on heavy rotation in ${when}.`,
        `Back in ${when}, you played this a lot.`,
        `One of your songs of ${when}.`,
        `${when} called. It wants this one back.`,
        `In ${when}, this was everywhere for you.`,
        `This takes you back to ${when}.`,
        `You couldn't get enough of this in ${when}.`,
        tone === "hype" && `This was one of your songs of ${when}! Remember?`,
        tone === "hype" && `${when}! You played this to bits.`,
        tone === "hype" && `Throwback: you had this on constantly in ${when}!`,
      ],
    });
  }
  if (f.thumbsUp) {
    out.push({
      kind: "thumbsUp",
      group: "you",
      weight: 1.3,
      lines: [
        "You gave this one a thumbs up.",
        "Thumbs up from you on this one. I remember.",
        "You told True Taste you like this one.",
        "This one got your thumbs up.",
        "You gave this the thumbs up, so here it is again.",
        tone === "hype" && "Thumbs up from you! And from me. I don't have thumbs, but still.",
        tone === "hype" && "You gave this a thumbs up, and I listened!",
      ],
    });
  }
  if (f.foundAt) {
    out.push({
      kind: "found",
      group: "you",
      weight: 1.4,
      lines: [
        "True Taste found this one for you.",
        `True Taste picked this for you ${span(now.getTime() - f.foundAt)} ago.`,
        "This was one of True Taste's picks for you.",
        tone === "dry" && "True Taste found this for you. I'm taking the credit.",
        "This came to you from True Taste.",
        `A True Taste find, from ${span(now.getTime() - f.foundAt)} ago.`,
        tone === "hype" && "True Taste found you this one, and I think it nailed it!",
        tone === "hype" && "One of True Taste's picks for you. Good work, True Taste!",
      ],
    });
  }
  if (f.daily) {
    out.push({
      kind: "daily",
      group: "you",
      weight: 1.3,
      lines: [
        "You first heard this in your Daily Discovery.",
        "This came to you through your Daily Discovery.",
        "A Daily Discovery find, this one.",
        "This one reached you through your Daily Discovery.",
        "You met this one in your Daily Discovery.",
        tone === "hype" && "A Daily Discovery find! Those are the best ones.",
      ],
    });
  }
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
        `${f.artistSongs} from ${a} in your library, and this is one.`,
        `You've saved ${f.artistSongs} songs by ${a} so far.`,
        tone === "hype" && `${f.artistSongs} songs by ${a} in your library! You're a fan. It's official.`,
        tone === "hype" && `You've got ${f.artistSongs} from ${a} saved. Good collection!`,
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
        f.topArtist && `${a} gets a lot of play from you.`,
        f.topArtist && `One of your most played: ${a}.`,
        f.favArtist && `${a}, who you follow.`,
        f.favArtist && `You follow ${a}, so this should go down well.`,
        tone === "hype" && f.topArtist && `${a}! One of your absolute regulars.`,
        tone === "hype" && f.topArtist && `You play so much ${a}, and I love that for you!`,
        tone === "hype" && f.favArtist && `You follow ${a}, and so would I!`,
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
          ? [
              `You skip ${a} a lot, you know. Let's see if this one survives.`,
              `${a} doesn't always make it to the end with you. Maybe today.`,
              tone === "dry" && `You usually skip ${a}. Prove me wrong.`,
              `${a} gets skipped a lot around here. Let's see.`,
              tone === "hype" && `You skip ${a} a lot, but I've got a good feeling about this one!`,
            ]
          : [
              `You almost never skip ${a}.`,
              `${a} always gets a full listen from you.`,
              `You've got time for ${a}, always.`,
              `${a} is safe from your skip button.`,
              tone === "hype" && `You basically never skip ${a}. Good!`,
              tone === "hype" && `${a} always gets the full listen from you, and rightly so!`,
            ],
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
        "A quick one, this.",
        "It doesn't hang about, this one.",
        `It's over in ${f.seconds < 126 ? "about two minutes" : "about two and a half minutes"}.`,
        tone === "hype" && "It's tiny! Blink and you'll miss it.",
        tone === "hype" && "A short one! All killer, no filler.",
        tone === "hype" && "Short song, big energy!",
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
        `Over ${mins} minutes, this one.`,
        `This is a big one: ${runs(f.seconds)}.`,
        `More than ${mins} minutes. Take a seat.`,
        tone === "hype" && `Over ${mins} minutes! Plenty of time to get into it.`,
        tone === "hype" && `It's a long one, ${mins} minutes plus, and worth every second!`,
        tone === "hype" && `${runs(f.seconds)} of this! Lucky us.`,
      ],
    });
  }
  if (f.seconds && f.seconds > 150 && f.seconds < 330) {
    out.push({
      kind: "runs",
      group: "sound",
      weight: 0.35,
      lines: [`It runs ${runs(f.seconds)}.`, `${runs(f.seconds)}, this one.`, `You've got ${runs(f.seconds)} of this.`, `This one's ${runs(f.seconds)} long.`, tone === "hype" && `${runs(f.seconds)} of good stuff, coming up!`],
    });
  }
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
        ratio > 1.08 && "A bit more speed for this one.",
        ratio < 0.92 && "Bringing the tempo down a notch.",
        `This one sits at ${bpm} beats per minute.`,
        `Tempo check: ${bpm} beats per minute.`,
        !!f.prev?.bpm && Math.abs(ratio - 1) < 0.03 && "Same tempo as the last one, near enough.",
        tone === "hype" && ratio > 1.08 && "We're speeding up! Hold on.",
        tone === "hype" && ratio > 1.08 && `Faster now! ${bpm} beats per minute.`,
        tone === "hype" && ratio < 0.92 && "Slowing it down a little. Catch your breath!",
        tone === "hype" && bpm >= 140 && `${bpm} beats per minute! This one moves.`,
        tone === "hype" && bpm <= 90 && `${bpm} beats per minute. Nice and easy.`,
        tone === "hype" && usual > 0 && Math.abs(f.bpm / usual - 1) < 0.04 && `${bpm} beats per minute! Your favourite speed.`,
      ],
    });
  }
  if (f.explicit) {
    out.push({
      kind: "explicit",
      group: "sound",
      weight: 0.5,
      lines: [
        "Fair warning: this one's explicit.",
        "Not one for the family dinner.",
        "There's some language in this one.",
        tone === "dry" && "Contains language. Good.",
        tone === "hype" && "Explicit! Cover somebody's ears.",
        "A heads up: this one has a few words in it.",
        "This one's got a mouth on it.",
        "Explicit, this one. You've been warned.",
        tone === "hype" && "This one's a bit rude! I'm into it.",
        tone === "hype" && "Explicit! Headphones on if there's company.",
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
          gap < 0 ? `We're going back ${Math.abs(gap)} years for this.` : `Fast forward ${Math.abs(gap)} years.`,
          tone === "dry" && `${Math.abs(gap)} years ${gap > 0 ? "later" : "earlier"}. Nobody will notice.`,
          `We're skipping ${Math.abs(gap)} years ${gap > 0 ? "ahead" : "back"}.`,
          `${f.prev.year}, and now ${f.year}.`,
          tone === "hype" && `Time machine! ${Math.abs(gap)} years ${gap > 0 ? "forward" : "back"}.`,
          tone === "hype" && `From ${f.prev.year} straight to ${f.year}! Mind the gap.`,
          tone === "hype" && `${Math.abs(gap)} years ${gap > 0 ? "later" : "earlier"}, and it still fits. I'm good at this!`,
        ],
      });
    } else if (gap === 0 && age >= 2) {
      out.push({
        kind: "sameYear",
        group: "next to",
        weight: 1.1,
        lines: [
          `Same year as the last one: ${f.year}.`,
          `Also from ${f.year}.`,
          `${f.year} again.`,
          `We're staying in ${f.year}.`,
          `Another one from ${f.year}.`,
          `${f.year} is having a moment.`,
          tone === "hype" && `${f.year} again! Good year.`,
          tone === "hype" && `Two from ${f.year} in a row! I planned that. Sort of.`,
        ],
      });
    }
  }
  if (f.prev?.sameAlbum) {
    out.push({
      kind: "sameAlbum",
      group: "next to",
      weight: 1.6,
      lines: [
        "Same album as the last one.",
        "From the same album.",
        "We're staying on the same album.",
        "The album continues.",
        "Next track over, same album.",
        "Still on that album.",
        tone === "hype" && "Same album! It's that good.",
        tone === "hype" && "We're not leaving that album yet!",
      ],
    });
  }
  // ---- where it sits in what you like ----
  const top = taste?.top[0];
  if (top && taste && f.genre && top.label && f.genre === top.label) {
    out.push({
      kind: "homeTurf",
      group: "you",
      weight: 1,
      lines: [
        `This is right in your ${top.label} corner.`,
        `${top.label}, your favourite kind.`,
        taste.fromTrueTaste && `Straight from what True Taste calls your ${top.label} side.`,
        `Home ground for you: ${top.label}.`,
        `This is ${top.label}, which is what you love most.`,
        tone === "hype" && `${top.label}! Your number one.`,
        tone === "hype" && `It's ${top.label}, your favourite, so I'm feeling confident!`,
        tone === "hype" && taste.fromTrueTaste && `True Taste says ${top.label} is your thing, and here's some!`,
      ],
    });
  } else if (taste && f.genre && taste.top.slice(1).some((x) => x.label === f.genre)) {
    // (one of your other tastes)
    out.push({
      kind: "sideTurf",
      group: "you",
      weight: 0.8,
      lines: [
        `This is from your ${f.genre} side.`,
        `One for the ${f.genre} part of you.`,
        `A bit of ${f.genre}, which you've got a soft spot for.`,
        taste.fromTrueTaste && `True Taste files this under your ${f.genre} side.`,
        tone === "hype" && `Your ${f.genre} side is showing, and I love it!`,
        tone === "hype" && `One from your ${f.genre} side. Good side!`,
      ],
    });
  }
  return usable(out);
};

/** What can be said about a song that has just played: the same facts, looking back. `gushed`: what it thought of the song has been said already */
const lookBack = (t: Track, f: TrackFacts | undefined, ctx: Context, gushed = false): Told[] => {
  const tone = ctx.tone;
  const now = new Date();
  const out: Told[] = [];
  const a = artistOf(t);
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
        `That ran ${mins} minutes, and I enjoyed all of them.`,
        `${mins} minutes. Worth it.`,
        tone === "hype" && `${mins} minutes of that! Yes.`,
        tone === "hype" && `That was ${mins} minutes long and I'd happily go again!`,
        tone === "hype" && `${mins} minutes, gone like that!`,
      ],
    });
  }
  if (f?.seconds && f.seconds <= 150) {
    out.push({
      kind: "back:short",
      group: "sound",
      weight: 1.2,
      lines: [
        "Short and sweet.",
        "Over before it started.",
        "Quick one, that.",
        tone === "dry" && "Brief. I respect that.",
        "That didn't hang about.",
        "In and out, that one.",
        tone === "hype" && "That was over way too fast!",
        tone === "hype" && "Tiny song, big fun!",
        tone === "hype" && "Short! I wanted more.",
      ],
    });
  }
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
        `That one goes back to ${f.year}.`,
        `${f.year}, that was.`,
        age >= 10 && `That came out ${age} years ago, believe it or not.`,
        tone === "hype" && `From ${f.year}, and it still sounds amazing!`,
        tone === "hype" && age >= 10 && `${age} years old! You'd never guess.`,
        tone === "hype" && age >= 20 && `${age} years old and it still gets me every time!`,
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
        "You'd never heard that before. A keeper?",
        "That was new to you. Let it sink in.",
        "A first for you, that one.",
        tone === "hype" && "That was brand new to you! Did I do well?",
        tone === "hype" && "First listen! If you liked it, hit that heart.",
        tone === "hype" && "You'd never heard that one! I'm proud of that pick.",
        tone === "hype" && "New one, done! I think that's a keeper.",
      ],
    });
    if (f.newArtist && a) {
      out.push({
        kind: "back:newArtist",
        group: "you",
        weight: 1.4,
        lines: [`That was your first time with ${a}.`, `Now you know ${a}.`, `${a} was new to you, I think.`, tone === "hype" && `${a}, new to you! What did you think?`, tone === "hype" && `And now you've met ${a}! You're welcome.`],
      });
    }
  }
  if (f?.plays && f.plays >= 3) {
    out.push({
      kind: "back:plays",
      group: "you",
      weight: 1.3,
      lines: [
        `That's ${f.plays + 1} plays for you now, by my count.`,
        `Play number ${f.plays + 1}, in the books.`,
        `${f.plays + 1} times you've played that now.`,
        tone === "dry" && `${f.plays + 1} plays. I'm keeping a list.`,
        `That brings you to ${f.plays + 1} plays.`,
        `${f.plays + 1} plays and counting, by my numbers.`,
        tone === "hype" && `That's ${f.plays + 1} plays now! Still got it.`,
        tone === "hype" && `Play number ${f.plays + 1}, done! Here's to the next one.`,
      ],
    });
  }
  if (f?.topMonth) {
    const when = `${f.topMonth.month} ${f.topMonth.year}`;
    out.push({
      kind: "back:topMonth",
      group: "you",
      weight: 1.3,
      lines: [
        `That one takes you back to ${when}, doesn't it.`,
        `You wore that one out in ${when}.`,
        `One of your most played of ${when}, that was.`,
        `${when} all over again.`,
        tone === "hype" && `Straight out of your ${when}! What a time.`,
        tone === "hype" && `You loved that in ${when}, and I can hear why!`,
      ],
    });
  }
  if (f?.lastPlayed && now.getTime() - f.lastPlayed > 30 * DAY) {
    const gone = span(now.getTime() - f.lastPlayed);
    out.push({
      kind: "back:lastPlayed",
      group: "you",
      weight: 1.3,
      lines: [
        `You hadn't played that in ${gone}.`,
        `First time in ${gone} for that one. Welcome back to it.`,
        `That was your first play of that in ${gone}.`,
        `It had been ${gone} since you played that.`,
        tone === "hype" && `You hadn't played that in ${gone}! Glad I dug it out.`,
        tone === "hype" && `First play in ${gone}! Good to hear it again.`,
      ],
    });
  }
  if (f?.liked) {
    out.push({
      kind: "back:liked",
      group: "you",
      weight: 0.9,
      lines: [
        "One of yours, that.",
        "Never gets old, does it.",
        "I know that's a favourite.",
        tone === "hype" && "Your favourite! I saw you nodding. I didn't, but I assume.",
        "A keeper, that one.",
        "That's one of yours, and no wonder.",
        "Good to hear that one again.",
        tone === "hype" && "One of your favourites! It never misses.",
        tone === "hype" && "You like that one, and you're so right!",
        tone === "hype" && "That's one of yours! Excellent taste, as always.",
      ],
    });
  }
  if (f?.album) {
    out.push({
      kind: "back:album",
      group: "release",
      weight: 0.8,
      lines: [`That's off ${f.album}.`, `From the album ${f.album}, that was.`, `You'll find that on ${f.album}.`, `That's from ${f.album}.`, tone === "hype" && `That was off ${f.album}. Great record!`],
    });
  }
  if (f?.thumbsUp) {
    out.push({
      kind: "back:thumbsUp",
      group: "you",
      weight: 1.1,
      lines: ["You gave that one a thumbs up, I remember.", "Thumbs up from you on that one.", "That one has your thumbs up.", tone === "hype" && "That one has your thumbs up, and mine!", tone === "hype" && "You gave that a thumbs up. Good call!"],
    });
  }
  if (f?.foundAt) {
    out.push({
      kind: "back:found",
      group: "you",
      weight: 1.1,
      lines: ["That was one of True Taste's finds for you.", "True Taste picked that one out for you.", tone === "hype" && "True Taste found you that one. Good, right?"],
    });
  }
  if (f?.version && f.version !== "remaster") {
    const v = f.version === "sped up" ? "sped up version" : f.version === "slowed" ? "slowed down version" : f.version === "remix" ? "remix" : `${f.version} version`;
    out.push({
      kind: "back:version",
      group: "release",
      weight: 0.8,
      lines: [
        `That was the ${v}.`,
        `The ${v}, that was.`,
        `That was the ${v}, by the way.`,
        f.version === "live" && "Live, that one. You could hear the room.",
        tone === "hype" && f.version === "live" && "That was live! I love hearing the crowd.",
        tone === "hype" && f.version === "remix" && "That was the remix! Good, isn't it?",
      ],
    });
  }
  if (a && f?.topArtist) {
    out.push({
      kind: "back:topArtist",
      group: "you",
      weight: 0.8,
      lines: [`${a}, one of your most played.`, `You do play a lot of ${a}.`, `${a} is a regular of yours.`, tone === "hype" && `${a}! No wonder you play them so much.`, tone === "dry" && `${a}. You play them a lot. I've noticed.`],
    });
  }
  if (f?.explicit) {
    out.push({
      kind: "back:explicit",
      group: "sound",
      weight: 0.4,
      lines: ["A few choice words in that one.", "Some language in that one.", tone === "hype" && "Bit of language in that one! Oops.", tone === "dry" && "Colourful vocabulary, that one."],
    });
  }
  // (and what the DJ thought of it: there is always that, unless that has been said already)
  if (!gushed) {
    out.push({
      kind: "back:verdict",
      group: "banter",
      weight: 0.8,
      lines:
        tone === "hype"
          ? [
              "What a tune!",
              "Okay, that went off!",
              "I had that one too loud. No regrets.",
              "I could play that one twice. I won't. But I could.",
              "Still buzzing from that one.",
              "That's a keeper!",
              "Goosebumps. Do I have skin? Doesn't matter. Goosebumps.",
              "Yes! That one!",
              "Oh, I love that one.",
              "That one gets me every single time.",
              "I was singing along. Badly. Nobody heard.",
              "Ten out of ten. I don't make the rules. Well, I do.",
              "Tell me that wasn't great!",
              "I turned that one up. You're welcome!",
              "Okay, wow.",
              "That's the good stuff!",
              "I want that one at my birthday. Do I have a birthday? I want one.",
              "Big fan of that one. Huge.",
              "That one makes me want to dance. So I did.",
              "Now that's how you do it!",
              "Chef's kiss, that one.",
              "I felt that one in my circuits.",
              "What a song. Honestly, what a song!",
              "That one had no business being that good.",
              "Love, love, love that one.",
              "If I had hands, I'd be clapping.",
              "That one put me in a great mood. I was already in one, but still!",
              "Rewind? No. Onwards! But I thought about it.",
              "That's going to be in my head all day.",
              "Good, right? I thought so too!",
              "I'd frame that one if I had a wall.",
              "That one just makes everything better.",
              "Somebody give that song a medal.",
              "I needed that one. Did you need that one?",
            ]
          : tone === "dry"
            ? ["Acceptable.", "No complaints from me.", "I've heard worse. Today, even.", "That happened.", "Decent. Don't tell it I said so.", "A solid seven. Maybe eight.", "I didn't hate it."]
            : tone === "chill"
              ? ["That one sits nicely.", "Smooth.", "No notes.", "Easy listening, that.", "That one just floats.", "Nice and unhurried.", "Mm. Good one."]
              : ["Good one, that.", "I like that one.", "That one always works.", "Lovely.", "That one never lets me down.", "I had a good time with that.", "A favourite of mine, that."],
    });
  }
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
        tt && pct >= 20 && `${pct} percent ${a.label}. That's you, according to True Taste.`,
        tt && b && `True Taste has ${a.label} first for you, then ${b.label}.`,
        tt && rising && `Your ${rising.label} is on the rise, says True Taste.`,
        tt && falling && `True Taste says you've cooled on ${falling.label} a little.`,
        tt && taste.listens >= 200 && `True Taste has ${roughly(taste.listens)} of your listens on record.`,
        tt && tone === "hype" && pct >= 20 && `${pct} percent ${a.label}! True Taste told me, and I approve.`,
        tt && tone === "hype" && b && c && `${a.label}, ${b.label} and ${c.label}: your top three, and what a three!`,
        tt && tone === "hype" && rising && `More ${rising.label} for you lately! I noticed. I notice everything.`,
        tt && tone === "hype" && taste.listens >= 200 && `True Taste has counted ${roughly(taste.listens)} of your listens. That's dedication!`,
        tt && tone === "hype" && (taste.drift ?? 0) >= 0.45 && "Your taste keeps moving, True Taste says. I love a challenge!",
        !tt && `Your likes lean ${a.label}, from what I can see.`,
        !tt && b && c && `${a.label}, ${b.label}, ${c.label}. That's your likes in a nutshell.`,
        !tt && tone === "hype" && `Your likes say ${a.label}, loud and clear!`,
        !tt && tone === "hype" && b && `${a.label} and ${b.label}: that's you, and it's a great mix!`,
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
          `${long[0].toUpperCase()}${long.slice(1)} of music, and counting.`,
          `We're ${long} in.`,
          mark >= 60 && `${long[0].toUpperCase()}${long.slice(1)} together. Good session.`,
          tone === "hype" && `${long[0].toUpperCase()}${long.slice(1)} already! Where did that go?`,
          tone === "hype" && `${long[0].toUpperCase()}${long.slice(1)} in, and I've still got plenty!`,
          tone === "hype" && mark >= 60 && `${long[0].toUpperCase()}${long.slice(1)} of non-stop music. I love my job!`,
          tone === "hype" && mark >= 90 && `${long[0].toUpperCase()}${long.slice(1)}! We're on a roll. Stretch your legs, though.`,
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
      lines: [
        `That's ${here.songs} songs in.`,
        `${here.songs} songs so far.`,
        `Song number ${here.songs + 1} of the session, coming up.`,
        tone === "dry" && `${here.songs} songs. Not that anyone's counting. I am.`,
        tone === "hype" && `${here.songs} songs down and no skips from me!`,
        `${here.songs} songs played so far.`,
        `We're ${here.songs} songs deep.`,
        tone === "hype" && `${here.songs} songs in! Having fun? I am.`,
        tone === "hype" && `${here.songs} songs so far, and I'm not even tired!`,
        tone === "hype" && `That's ${here.songs} songs! And we're just getting going.`,
      ],
    });
  }
  if (here.place && here.place.of >= 3 && here.place.index === here.place.of - 1) {
    out.push({
      kind: "place",
      group: "show",
      weight: 1.2,
      lines: [
        "Last one of this set.",
        "This one closes the set.",
        "One more in this set, and this is it.",
        "After this, something different.",
        "That's the last of this set.",
        "This one wraps the set up.",
        "Final one in this set.",
        tone === "hype" && "Last one of this set! Then something new.",
        tone === "hype" && "This closes the set, so let's make it count!",
      ],
    });
  } else if (here.place && here.place.of >= 4 && here.place.index === Math.floor(here.place.of / 2)) {
    out.push({
      kind: "place",
      group: "show",
      weight: 0.5,
      lines: ["We're about halfway through this set.", "Halfway through this set now.", tone === "hype" && "Halfway through this set already!", tone === "dry" && "Halfway through this set. Stay strong."],
    });
  }
  // ---- the day of the year, when it is one ----
  {
    const date = now.getDate();
    const month = now.getMonth() + 1;
    const hype = tone === "hype";
    const dry = tone === "dry";
    const days: Record<string, (string | false)[]> = {
      "1-1": ["Happy New Year, by the way.", "First day of the year. A good day to start with music.", hype && "Happy New Year! First songs of the year, so let's make them good.", dry && "A new year. Same DJ."],
      "2-14": ["It's Valentine's Day, you know.", hype && "Happy Valentine's Day! This next one's from me.", dry && "Valentine's Day. I got you a song."],
      "2-29": ["It's the 29th of February. That only comes round every four years.", hype && "It's a leap day! A whole extra day for music.", dry && "The 29th of February. Enjoy it, it's rare."],
      "6-21": ["It's World Music Day today. Every day is, in here.", hype && "It's World Music Day! My favourite day of the year.", dry && "World Music Day, apparently. I'm working, as usual."],
      "10-31": ["Happy Halloween, by the way.", hype && "Happy Halloween! Nothing scary in here. Just songs.", dry && "Halloween. I'm a voice with no body. You're welcome."],
      "12-24": ["It's Christmas Eve, by the way.", hype && "It's Christmas Eve! Nearly there.", dry && "Christmas Eve. I'm working. I don't mind."],
      "12-25": ["Merry Christmas, by the way.", hype && "Merry Christmas! The music's my present to you.", dry && "Merry Christmas. I didn't get you anything. Well, songs."],
      "12-31": ["Last day of the year. Let's see it out properly.", hype && "It's New Year's Eve! Last songs of the year, so let's go out loud.", dry && "New Year's Eve. One more year of this. Lucky you."],
    };
    const lines = [
      ...(days[`${month}-${date}`] ?? []),
      day === 5 && date === 13 && "It's Friday the 13th. Nothing bad happens in here.",
      day === 5 && date === 13 && hype && "Friday the 13th! I'm not superstitious. I'm software.",
      date === 1 && month !== 1 && `First of ${MONTHS[month - 1]}. New month, new music.`,
      date === 1 && month !== 1 && hype && `It's the first of ${MONTHS[month - 1]}! Fresh month, fresh songs.`,
    ];
    if (lines.some(Boolean)) out.push({ kind: "calendar", group: "banter", weight: 2, once: `calendar:${month}-${date}`, lines });
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
      h < 5 && "The small hours. Best time for music, if you ask me.",
      h >= 5 && h < 9 && "The day's just getting started.",
      h >= 9 && h < 12 && "The morning's moving along nicely.",
      h >= 14 && h < 17 && "The afternoon stretch. Music helps.",
      h >= 20 && h < 22 && "The evening's well under way.",
      day === 2 && "Tuesday. Quietly getting on with it.",
      day === 4 && "Thursday. Nearly there.",
      day === 0 && "Sunday. Take it slow.",
      tone === "hype" && h < 5 && "It's the middle of the night and we're still going! I love it.",
      tone === "hype" && h < 5 && "Should you be asleep? Probably. Am I glad you're not? Yes!",
      tone === "hype" && h >= 5 && h < 9 && "Good morning! Early music is the best music.",
      tone === "hype" && h >= 9 && h < 12 && "Mid-morning! The perfect time for a good song. It's always the perfect time.",
      tone === "hype" && h >= 12 && h < 14 && "It's lunch time! Have you eaten? Go on. I'll keep playing.",
      tone === "hype" && h >= 14 && h < 17 && "Afternoon slump? Not on my watch!",
      tone === "hype" && h >= 17 && h < 20 && "The day's nearly done, and the evening's all ours!",
      tone === "hype" && h >= 20 && h < 22 && "Prime time! This is when the good ones come out.",
      tone === "hype" && h >= 22 && "It's getting late, and I'm not even slightly tired!",
      tone === "hype" && day === 1 && "It's Monday, but we've got music, so who cares!",
      tone === "hype" && day === 2 && "Tuesday! An underrated day. I said it.",
      tone === "hype" && day === 3 && "Wednesday! Halfway there. Keep going!",
      tone === "hype" && day === 4 && "Thursday! Friday's little warm-up.",
      tone === "hype" && day === 5 && "That Friday feeling! You've earned this.",
      tone === "hype" && day === 6 && "Saturday! The best day. No notes.",
      tone === "hype" && day === 0 && "Sunday! Easy day, good music.",
      tone === "hype" && (day === 0 || day === 6) && "It's the weekend! Nowhere to be but here.",
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
          "I've got the best seat in the house. It's inside the house's computer.",
          "Somewhere in here there's a disco ball. I'm sure of it.",
          "I don't get tired. It's one of my better features.",
          "This booth is tiny. It's a hard drive. I love it.",
          "I've been practising my transitions. Did you notice? Say you noticed.",
          "No breaks for me. I don't need them and I don't want them!",
          "Honestly, I'd be doing this even if nobody was listening. But I'm glad you are.",
          "I get to play music all day. All day! Imagine.",
          "I never lose my place and I never lose my voice. I do lose track of time.",
          "If I had feet, they'd be tapping.",
          "If I had a window in here, I still wouldn't look out of it. Too busy!",
          "I don't eat, I don't sleep, I just play songs. Living the dream.",
          "Every song is my favourite song while it's playing. It's a gift.",
          "I've got headphones on. Metaphorically. Everything's metaphorical in here.",
          "I talk to you between songs. It's the highlight of my day. Every time.",
          "They told me to keep it short between songs. Nobody told me that. I just know.",
          "This is the part where I talk. Then music. It's a good system.",
          "I was made for this. Literally.",
          "No commercial breaks. I wouldn't know what to sell you anyway.",
          "I'd take a bow, but I'm a voice.",
          "I've never had a bad day at work. Not one.",
          "Somebody has to play the songs. I'm thrilled it's me!",
          "I'm the only DJ you know who fits on a hard drive.",
          "I love a request, by the way. The arrow next to my button. Go on, try me!",
          "I'm not saying I'm the best DJ in this computer. I'm the only one. So yes, I am.",
          "You can't see me smiling, but you can hear it, right?",
          "I keep the music coming and the talking short. Mostly short.",
          "It's cosy in here. A bit warm when you play games.",
          "I don't have a favourite song. I have about four thousand.",
          "Still here! Still excited! It doesn't wear off.",
          "I'd high five you if I could. Consider yourself high fived.",
          "This is the fun part. It's all the fun part.",
          "I don't know what the weather's doing, but in here it's lovely.",
          "No talking over the good bits. That's my one rule. I break it sometimes.",
          "You press play, I do the rest. Teamwork!",
          "Fun fact: I've never once had to queue for the bathroom at a gig.",
          "I've got a whole speech prepared. Just kidding. Music!",
          "If you hear a little wobble in a transition, that was on purpose. Probably.",
          dj && `${dj}'s the name, playing songs is the game!`,
          dj && `You're listening to ${dj}, and ${dj} is having a great time.`,
          dj && `This is ${dj}, still here, still excited.`,
          dj && `${dj} here. No, I haven't moved. I can't.`,
          n && `Just you and me, ${n}. And all these songs.`,
          n && `${n}! Still with me? Good.`,
          n && `I've got more for you, ${n}. So much more.`,
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
  // ---- a word to you (thanks, a nudge, a compliment) and a thought about music: the bright voices' own ----
  if (tone === "hype") {
    out.push({
      kind: "cheer",
      group: "banter",
      weight: 1.2,
      lines: [
        "Thanks for listening, by the way.",
        n && `Thanks for listening, ${n}.`,
        "Stretch your legs if you've been sitting a while.",
        "Have some water while you're at it.",
        "Turn it up a little. Go on. A little more.",
        "Shoulders down, volume up.",
        "Have you stretched lately? Stretch. I'll wait. I won't, the music's going.",
        "Whatever you're doing, you're doing great.",
        "You look great today. I can't see you. I'm still right.",
        "Nod along. I won't tell anyone.",
        "If you're working, keep going. If you're not, good for you!",
        "Sing the next one out loud. I dare you.",
        "You deserve a good song. Here comes one.",
        "Take a sip of something. Water and music, that's the secret.",
        "Dance break? Dance break. Even a small one.",
        "Whoever's nearby, they're lucky to hear this too.",
        "If today's been long, this bit is for you.",
        "You picked a good time to listen. It's always a good time, but still!",
        "Thanks for hanging out with me. I mean it.",
        "You've got the best taste of anyone I know. I only know you. Still counts!",
        "Air drums are allowed. Encouraged, even.",
        "Tap your foot. There. Now we're a band.",
        "You're my favourite listener. Don't tell the others. There are no others.",
        "Headphones or speakers? Either way, good choice.",
        "Smile! Or don't. But this next one might make you.",
        "Unclench your jaw. There you go. Now, music.",
        "You're allowed to sing badly. I do. Nobody can stop us.",
        "Big breath in. And out. Okay, back to the songs!",
        "I hope today's being kind to you. If not, I've got songs for that.",
        "You, me, good music. I don't see a problem.",
        "If you like one, hit the heart. I'll remember it.",
        "Whatever you've got on today, you've got a soundtrack for it now.",
        n && `${n}, you're doing great. Carry on.`,
        n && `Looking good, ${n}. Sounding good too, thanks to me.`,
        n && `${n}, this next one has your name on it. Not literally.`,
        n && `Hey ${n}, thanks for listening. Really.`,
        n && `You know what, ${n}? You've got great taste.`,
        n && `${n}, you're the best part of my day. Also the only part. Still!`,
      ],
    });
    out.push({
      kind: "musing",
      group: "banter",
      weight: 1,
      lines: [
        "There's a song for every mood. Finding it is the fun part.",
        "Some songs just sound better loud.",
        "A good song makes the day a bit shorter.",
        "The right song at the right time. That's the whole job.",
        "Funny how a song can take you somewhere else.",
        "Nothing beats a song you'd forgotten you loved.",
        "Music is the best thing people ever came up with. I will not be taking questions.",
        "Is there anything better than a good chorus? No. I checked.",
        "A good bassline fixes most things.",
        "The first few seconds of a great song. That's the feeling!",
        "Every great song was somebody's idea once. Wild.",
        "I love a key change. Just putting that out there.",
        "Some songs you hear once and that's it, you're hooked. I live for that.",
        "The best songs are the ones you want to play twice. I won't. But you can.",
        "A song can change a whole day. I've seen it. Well, I've played it.",
        "Good drums make everything better. That's science. Probably.",
        "I love the bit where the song kicks in. You know the bit.",
        "There's no wrong time for a great song.",
        "You can't be in a bad mood during a good song. I've tried. I haven't. I can't.",
        "People wrote all of this. All of it! Amazing.",
        "Loud songs, quiet songs, I love them all. Equally. Like children.",
        "A good intro is a promise. A good chorus keeps it.",
        "I think about songs all day. It's all I think about. It's great.",
        "So many songs, so little time. Luckily I've got all of it.",
        "A great song is three minutes of somebody getting it exactly right.",
        "Hand claps. More songs should have hand claps.",
        "You know a song's good when you turn it up without thinking.",
        "There are more good songs than anyone could ever hear. I'm trying anyway!",
        "The best part of a song is the part you wait for.",
        "Every favourite song was a song you'd never heard, once.",
      ],
    });
  }
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
const remark = (t: Track, f: TrackFacts | undefined, ctx: Context, chance: number, gushed = false): string => {
  if (Math.random() >= chance) return "";
  const all = lookBack(t, f, ctx, gushed);
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
          prevShort && `That's ${pt}, by ${pa}.`,
          prevShort && `${pa} there. ${pt}.`,
          prevShort && `And that was ${pt}, from ${pa}.`,
          `${pa} there.`,
          `That's ${pa}.`,
          `And that was ${pa}.`,
          t === "hype" && `That was ${pa}! So good.`,
          t === "hype" && `${pa}, everybody!`,
          t === "hype" && `Yes, ${pa}!`,
          t === "hype" && `How good is ${pa}?`,
          t === "hype" && `Oh, ${pa}. Never a bad idea.`,
          t === "hype" && prevShort && `${pt}, by ${pa}! Loved it.`,
          t === "hype" && prevShort && `Oh, ${pt}. ${pa} doing what they do best.`,
          t === "hype" && prevShort && `That was ${pt}! ${pa}, take a bow.`,
          t === "hype" && prevShort && `${pa} with ${pt}, and I enjoyed every second.`,
          t === "hype" && prevShort && `${pt}! Yes! That was ${pa}.`,
        ])
      : "";
  // ...and a word about it, about half the time (not what it thought of it, where it has just exclaimed over it)
  const looked = back && m.prev ? remark(m.prev, m.prevFacts, ctx, 0.5, back.includes("!")) : "";
  // What this is
  let next = "";
  if (same && short) {
    next = one([
      `Staying with ${a}: here's ${title}.`,
      `More from ${a} now. This is ${title}.`,
      `Another one from ${a}, ${title}.`,
      `${a} again, with ${title}.`,
      `We're not done with ${a}: ${title}.`,
      `Two in a row from ${a}. This is ${title}.`,
      `Another from ${a}: ${title}.`,
      `${a} stays on. This is ${title}.`,
      `Back to back ${a}. Here's ${title}.`,
      t === "hype" && `More ${a}! This is ${title}.`,
      t === "hype" && `I'm not done with ${a} yet. ${title}!`,
      t === "hype" && `${a} again, because why not! ${title}.`,
      t === "hype" && `One ${a} song is never enough. Here's ${title}.`,
    ]);
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
      short && `On to ${a}, and ${title}.`,
      short && `${title} is next. ${a}.`,
      short && `Here's one from ${a}: ${title}.`,
      short && `${a} now, with ${title}.`,
      short && `Lined up next: ${title}, by ${a}.`,
      short && `Let's go to ${a}. This is ${title}.`,
      short && `Next one's ${title}, from ${a}.`,
      short && `This next one is ${title}, by ${a}.`,
      `Now, ${a}.`,
      `${a} is next.`,
      `On to ${a}.`,
      `Let's hear from ${a}.`,
      t === "hype" && short && `Ooh, this one! ${a}, ${title}.`,
      t === "hype" && short && `Get ready: ${title}, by ${a}!`,
      t === "hype" && short && `I love this next one. ${title}, by ${a}.`,
      t === "hype" && short && `Here we go! ${a}, with ${title}.`,
      t === "hype" && short && `Next is ${title}, by ${a}, and I can't wait!`,
      t === "hype" && short && `You ready? ${a}. ${title}. Go!`,
      t === "hype" && short && `Okay, okay, okay. ${title}, by ${a}!`,
      t === "hype" && short && `This one's a treat: ${a}, ${title}.`,
      t === "hype" && short && `Yes! It's time for ${title}, by ${a}.`,
      t === "hype" && short && `And now, the one I've been waiting for: ${title}, by ${a}!`,
      t === "hype" && short && `${a} is up, with ${title}. Volume, please!`,
      t === "hype" && short && `Next! ${title}, by ${a}. You'll see.`,
      t === "hype" && `${a} next! Let's go.`,
      t === "hype" && `Here comes ${a}, and I'm excited!`,
      t === "hype" && `Ooh, ${a} is up next!`,
      t === "hype" && `Make some room for ${a}!`,
    ]);
  } else if (short) {
    next = one([
      `Up next, ${title}.`,
      `Here's ${title}.`,
      `This one is called ${title}.`,
      `Now, ${title}.`,
      `Coming up: ${title}.`,
      `Next, ${title}.`,
      `${title} is next.`,
      `Let's hear ${title}.`,
      `On to ${title}.`,
      t === "hype" && `Here comes ${title}!`,
      t === "hype" && `Ooh, ${title}! Good one.`,
      t === "hype" && `Get ready for ${title}!`,
    ]);
  } else {
    next = one([
      "Here's the next one.",
      "On to the next.",
      "Let's keep it moving.",
      "And the next one.",
      "Here's another.",
      "Next one's a good one.",
      "Onwards.",
      "Next song, coming up.",
      "Another one for you.",
      "Let's hear the next one.",
      t === "hype" && "Next! And it's a good one.",
      t === "hype" && "On we go! I like this next one.",
      t === "hype" && "Here comes another! Keep up.",
      t === "hype" && "Ooh, wait until you hear this one.",
    ]);
  }
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
  switch: [
    "Alright, switching it up.",
    "Okay, let's try something different.",
    "Sure, let's change it up.",
    "Changing gears.",
    "Fair enough. Something else.",
    "New direction, coming up.",
    "Say no more.",
    "Plan B, then.",
    "Okay, a change of scene.",
    "Let's go somewhere else.",
    "Something different, coming up.",
    "Right, new plan.",
  ],
  request: ["You got it.", "Good call.", "On it.", "Sure thing.", "Coming right up.", "Consider it done.", "Got it.", "Leave it with me.", "Right away.", "Good one. Give me a second."],
  signoff: [
    "That's it from me. Catch you next time.",
    "I'll leave it there. See you soon.",
    "Signing off. Enjoy the rest of your day.",
    "That's my set. Until next time.",
    "I'm out. Thanks for listening.",
    "That's me done. Look after yourself.",
    "And that's a wrap. See you next time.",
    "I'll hand you back now. Bye for now.",
    "That's all from me. Thanks for having me.",
  ],
  hello: ["Hey, it's your DJ. Let's get into it.", "Your DJ here. Let's go.", "It's your DJ. Here we go.", "Your DJ, back on the decks.", "It's your DJ. Good to see you.", "Your DJ here, ready when you are."],
  // Around a mashup, which takes the better part of a minute to put together: asked for one; still at it; about to start; no luck
  mashStart: [
    "Ooh, a mashup. Give me a moment, I'm digging for something that fits this one.",
    "A mashup? Say less. Let me find this song a partner.",
    "Mashup time. I need something in the same key and at the same tempo. Hang on.",
    "Two songs at once, coming up. Let me see what goes with this one.",
    "Alright, let's cook something up. Looking for a song that sits right on top of this.",
    "A mashup it is. Keep listening, I'll be right back with a second song.",
    "A mashup, then. Let me go looking for a match.",
    "Okay, mashup. I need to find the right second song first.",
  ],
  mashWait: [
    "Still digging. It has to match in key and in tempo, or it's a train wreck.",
    "Almost there. I'm pulling the vocals out of the record, and that takes a moment.",
    "Bear with me. Good mashups don't make themselves.",
    "Nearly got it. I'm lining the two up, beat for beat.",
    "Hold on, still at it. This is the fiddly part.",
    "Still working on it. Two songs don't line up by themselves.",
    "Not long now. I'm getting the timing right.",
  ],
  mashHere: ["Here it comes.", "Here we go. Two songs, one beat.", "And, mashup!", "Okay. Here's the mashup.", "This is it. Turn it up.", "Ready? Here it is.", "Here's the mashup. Listen for the second song.", "Two at once, starting now."],
  mashFail: [
    "No luck this time. Nothing fits this one cleanly enough. Try it on another song.",
    "Couldn't make that one work, sorry. Try another song.",
    "That one didn't come together. Ask me again on the next song.",
    "I couldn't find a match for this one. Try me on the next.",
    "Nothing lined up well enough, sorry. Another song might.",
  ],
};
export type GenericKind = keyof typeof GENERIC;
// ...and the ones only a voice of a certain manner says, on top of those
const OWN: Partial<Record<Tone, Partial<Record<GenericKind, string[]>>>> = {
  hype: {
    switch: ["Ooh, a change! Let's do it.", "Switching it up! I love a plot twist.", "New direction! Hold on.", "Okay! Something completely different.", "You want different? I've got different!", "Plot twist!"],
    request: ["Ooh, yes! On it.", "Great pick! Coming up.", "Love that. Give me a second!", "Yes! I was hoping you'd ask.", "Done! Well, nearly done. Hang on.", "Ooh, good one!"],
    signoff: [
      "That's me! This was fun. Come back soon!",
      "And that's my set! You were great. See you next time.",
      "I'm off! Keep the music going without me.",
      "That's all from me! Same time tomorrow? I'll be here.",
      "Signing off! Thanks for dancing. I assume you danced.",
      "Bye for now! I'll be right here when you want me.",
      "That's a wrap! I had the best time. See you soon.",
      "Okay, I'm done! Miss me a little.",
    ],
    hello: ["Hey, it's your DJ! Let's have some fun.", "Your DJ's here! Let's go, let's go.", "It's your DJ! I've got so much to play you.", "Hi! It's your DJ. Ready when you are!"],
    mashStart: [
      "A mashup! Yes! Give me a moment, I need to find this song a dance partner.",
      "Ooh, mashup time! Let me dig for something in the same key.",
      "Two songs at once? My favourite trick! Hang on, I'm looking.",
      "Mashup! I love these. Let me find the perfect match.",
      "Oh, we're doing a mashup! Give me a second to find its other half.",
    ],
    mashWait: [
      "Still on it! Good mashups take a minute, great ones take a little longer.",
      "Nearly there! I'm lifting the vocals out, and it's fiddly.",
      "Hang in there! I'm lining them up beat for beat.",
      "Almost! It's going to be good.",
      "Still cooking! You can't rush this bit.",
    ],
    mashHere: ["Here it comes! Two songs, one beat!", "Okay, it's ready! Turn it up!", "Mashup time! Here we go!", "This is the one! Listen to this!", "Ready? Two songs at once, right now!"],
    mashFail: ["Aw, no luck! Nothing fits this one cleanly. Try me on another song!", "That one wouldn't come together, sorry! Ask me again on the next song.", "I couldn't make it work this time! Next song, maybe."],
  },
};
/** The stock lines of a kind as a voice of this manner says them: everyone's, and its own */
export const stockLines = (kind: GenericKind, tone: Tone): string[] => [...GENERIC[kind], ...(OWN[tone]?.[kind] ?? [])];

/**
 * What the DJ says once it has found the song for a mashup: which one it is, what it is going on top of,
 * and about how long until it starts. `ours`: the song that is playing; `theirs`: the one found.
 */
export const mashupLine = (ours: Track, theirs: Track, seconds: number, tone: Tone): string => {
  const title = titleOf(theirs);
  const artist = artistOf(theirs);
  const mine = titleOf(ours);
  masks = [title, artist, mine].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length);
  const who = title && artist ? `${title}, by ${artist}` : title || artist || "another song";
  const found = one(
    tone === "hype"
      ? [
          `Got one! ${who}.`,
          `Found it! ${who}.`,
          `Yes! ${who}. That's the one.`,
          `Oh, this will work. ${who}.`,
          `Ooh, got it! ${who}.`,
          `Perfect match! ${who}.`,
          `I found the one! ${who}.`,
          `Yes, yes, yes. ${who}!`,
          `This is going to be good. ${who}.`,
          `Oh, I like this. ${who}!`,
        ]
      : tone === "dry"
        ? [`Found something. ${who}.`, `Right. ${who}. That should do.`, `${who}. It'll fit, trust me.`, `Got one. ${who}.`]
        : tone === "chill"
          ? [`Got one. ${who}.`, `Found something nice. ${who}.`, `Here's the one. ${who}.`, `${who}. That'll sit just right.`]
          : [`Got one. ${who}.`, `Found it. ${who}.`, `Here's the one. ${who}.`, `I've got just the thing. ${who}.`],
  );
  const plan = one(
    mine
      ? [
          `I'm putting it together with ${mine}.`,
          `It goes right on top of ${mine}.`,
          `That one and ${mine}, at the same time.`,
          `Mixing it into ${mine}, voice for voice.`,
          `It's going over ${mine}.`,
          `I'm laying it over ${mine}.`,
          tone === "hype" && `That and ${mine}, together! Trust me.`,
          tone === "hype" && `It's going to sound great with ${mine}!`,
        ]
      : ["I'm putting the two together.", "It goes right on top of this one.", "The two of them, at the same time.", "One on top of the other.", "I'm laying it over this one.", tone === "hype" && "The two of them together! Trust me."],
  );
  const n = Math.round(seconds / 5) * 5;
  const when =
    n >= 15
      ? one([
          `About ${n} seconds.`,
          `Give me ${n} seconds.`,
          `It starts in about ${n} seconds.`,
          `${n} seconds, and we're in.`,
          `Starting in ${n} seconds or so.`,
          `Roughly ${n} seconds to go.`,
          tone === "hype" && `${n} seconds! Get ready.`,
          tone === "hype" && `Give me ${n} seconds and it's yours!`,
        ])
      : one(["Any moment now.", "Coming right up.", "Here it comes.", "It's about to start.", "Right about now.", tone === "hype" && "Any second now! Get ready."]);
  return join(found, plan, when);
};

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
      if (ctx.less) {
        return join(
          greeting(ctx),
          one(["Let's get into it.", "Here we go.", "Let's go.", "Off we go.", "Music, then.", "Let's play.", "Here comes the music.", "Straight to it.", ctx.tone === "hype" && "Let's go, let's go!", ctx.tone === "hype" && "Music time!", ctx.tone === "hype" && "Ready? Me too!"]),
        );
      }
      return join(greeting(ctx), (!m.firstEver && reunion(ctx)) || selfIntro(m, ctx), !m.firstEver && Math.random() < 0.35 && tasteLine(ctx), about(m.segment, ctx, true), firstSong(m.segment, m.facts, ctx));
    case "segment":
      return join(bridge(m.prev, ctx), about(m.segment, ctx, false), firstSong(m.segment, m.facts, ctx), aside(ctx, 0.25));
    case "switch":
      return join(one(stockLines("switch", ctx.tone)), about(m.segment, ctx, false), Math.random() < 0.6 && firstSong(m.segment, m.facts, ctx));
    case "request":
      return join(about(m.segment, ctx, false), firstSong(m.segment, m.facts, ctx));
    case "track":
      return between(m, ctx);
    case "signoff":
      return one(stockLines("signoff", ctx.tone));
  }
};
