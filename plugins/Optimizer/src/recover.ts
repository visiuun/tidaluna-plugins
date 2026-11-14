// After TIDAL's page has died, frozen or been reloaded: carrying on from where it was.
//
// TIDAL brings the page back by itself, but as a page that has just been opened: after a crash nothing
// plays, and (in TIDAL 2.48) nothing can be played, its line to the player being down (see mendLine in
// guard.native.ts). What was playing is known outside the page (it is told there every couple of
// seconds), so the page that comes back can put it on again: at the place the music would have reached
// by now, and at the volume it had, which a page that has just started doesn't know yet (it starts at
// full volume).
//
// TIDAL's player is stopped the moment the page goes (also in guard.native.ts), so what is heard is a
// gap: about four seconds after a reload, about nine after a crash. With the DJ plugin on there is no
// gap at all: its mixer plays through and the DJ picks its session up again, and nothing is done here.
import { beat, notePlay, takeRecovery, unwatchPage, watchPage, type Recovery } from "./guard.native";
import { note, settings } from "./state";

const lib = () => (window as any).luna?.lib;
const state = () => lib()?.redux?.store?.getState?.();
const actions = () => lib().redux.actions as Record<string, (payload?: any) => unknown>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const currentId = (): string | undefined => {
  const pq = state()?.playQueue;
  const id = pq?.elements?.[pq.currentIndex]?.mediaItemId;
  return id === undefined ? undefined : String(id);
};
// Where the song is, from the player that is active now: Luna's PlayState.currentTime keeps hold of the
// first player it found, and stands still once TIDAL has changed to its other one (it has two)
let playerModule: { activePlayer?: { currentTime?: number } } | undefined;
const position = (): number => {
  try {
    playerModule ??= (window as any).luna?.core?.findModuleByProperty?.((key: unknown, value: unknown) => key === "activePlayer" && typeof value === "object" && value !== null && "currentTime" in (value as object)) ?? undefined;
    const t = Number(playerModule?.activePlayer?.currentTime);
    if (Number.isFinite(t)) return t;
  } catch {}
  return Number(lib()?.PlayState?.currentTime) || 0;
};
const isPlaying = () => state()?.playbackControls?.desiredPlaybackState === "PLAYING";

// ------------------ WHAT IS PLAYING, SAID OUTSIDE ------------------
let lastSaid = "";
const sayPlay = () => {
  try {
    const id = currentId();
    const pc = state()?.playbackControls;
    if (!id || !pc) return;
    const playing = isPlaying();
    const at = position();
    // (while paused, once is enough)
    const key = `${id}|${playing}|${playing ? Math.round(at) : ""}|${pc.volume}|${pc.muted}`;
    if (key === lastSaid) return;
    lastSaid = key;
    const duration = Number(pc.playbackContext?.actualDuration) || 0;
    notePlay({ id, position: at, duration, playing, at: Date.now(), volume: Number(pc.volume), muted: !!pc.muted }).catch(() => {});
  } catch {}
};

// ------------------ PUTTING IT BACK ON ------------------
const long = (ms: number) => (ms < 90000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60000)} minutes`);
const whatHappened = (r: Recovery) => {
  const held = r.memory ? ` (it held ${r.memory} MB)` : "";
  if (r.reason === "reload") return r.asked ? `TIDAL's page was reloaded by the memory guard: ${r.asked}` : "";
  if (r.reason === "hang") return `TIDAL's page had frozen${held}: it was ended, and a fresh one was back after ${long(r.away)}`;
  if (r.reason === "oom") return `TIDAL's page ran out of memory${held} and was back after ${long(r.away)}`;
  return `TIDAL's page stopped (${r.reason})${held} and was back after ${long(r.away)}`;
};

/** Puts the song that was playing back on. Returns what was done, in words */
const resume = async (r: Recovery): Promise<string> => {
  const play = r.play!;
  // TIDAL's player and queue are not there in the first moments of a page
  const until = Date.now() + 15000;
  while (!(Array.isArray(state()?.playQueue?.elements) && state()?.playbackControls) && Date.now() < until) await wait(250);
  if (!state()?.playQueue) return "TIDAL's player didn't come back in time to put the music on again";
  // (after a reload TIDAL puts the song back on by itself, a few seconds in: that is waited for, not raced)
  const settled = Date.now() + (r.reason === "reload" ? 4500 : 1200);
  while (Date.now() < settled && !isPlaying()) await wait(150);
  if (isPlaying()) return "the music was already playing again";
  if (currentId() !== play.id) {
    // (TIDAL remembers its queue a little late: it can come back one song behind)
    const index = (state().playQueue.elements ?? []).findIndex((e: any) => String(e.mediaItemId) === play.id);
    if (index < 0) return "TIDAL came back on another song: left as it is";
    actions()["playQueue/MOVE_TO"](index);
    const moved = Date.now() + 4000;
    while (currentId() !== play.id && Date.now() < moved) await wait(100);
    if (currentId() !== play.id) return "TIDAL came back on another song: left as it is";
  }
  // TIDAL's page comes back with its volume at full, and only finds yours again a little later: the song
  // is not to be put on at full volume. The volume it had is set first.
  try {
    const pc = state().playbackControls;
    if (typeof play.volume === "number" && Number.isFinite(play.volume) && Number(pc.volume) !== play.volume) actions()["playbackControls/SET_VOLUME"]({ volume: play.volume });
    if (play.muted && !pc.muted) actions()["playbackControls/SET_MUTE"](true);
  } catch {}
  // Where the music would be by now, had nothing happened
  const at = () => play.position + (Date.now() - play.at) / 1000;
  if (play.duration && at() > play.duration - 3) {
    actions()["playQueue/MOVE_NEXT"]();
    actions()["playbackControls/PLAY"]();
    return "the song had ended meanwhile: the next one was started";
  }
  actions()["playbackControls/PLAY"]();
  // It starts from the beginning, and TIDAL may load it more than once on the way: moved on only once it
  // is really running (playing, on this song, its position moving, and still so a moment later)
  const running = () => state()?.playbackControls?.playbackState === "PLAYING" && currentId() === play.id && position() > 0.2;
  const started = Date.now() + 8000;
  while (Date.now() < started) {
    await wait(150);
    if (!running()) continue;
    await wait(700);
    if (running()) break;
  }
  if (at() > 2 && Math.abs(position() - at()) > 1.5) actions()["playbackControls/SEEK"](Math.max(0, at() + 0.3));
  return "the song was put back on where it had got to";
};

export const startRecovery = (opts: { notify: (msg: string) => void; log: (msg: string) => void }) => {
  let alive = true;
  let reporter: ReturnType<typeof setInterval> | undefined;
  const beats = setInterval(() => beat().catch(() => {}), 5000);
  (async () => {
    try {
      const r = await takeRecovery();
      // The page is watched from here on, and, first of all, TIDAL's line to it is put back if the page
      // before this one died (see mendLine in guard.native.ts): until then the page hears nothing from
      // TIDAL's player, and putting a song back on would only pile up requests it can't follow
      await watchPage(settings.unfreeze).catch((err) => opts.log(`Couldn't watch the page: ${(err as Error)?.message ?? err}`));
      if (r && alive) {
        const what = whatHappened(r);
        let music = "";
        if (r.djCarried) music = "the music played on (the DJ kept it going)";
        else if (settings.recover && r.play?.playing && Date.now() - r.play.at < 120000) music = await resume(r).catch((err) => `the music couldn't be put back on (${(err as Error)?.message ?? err})`);
        opts.log(`The page before this one went: ${r.reason}${r.asked ? ` (asked for: ${r.asked})` : ""}, ${r.memory} MB, away ${r.away} ms; ${music || "nothing was playing"}`);
        if (what) {
          const text = music ? `${what}; ${music}` : what;
          note(text);
          opts.notify(`Optimizer: ${text}`);
        }
      }
    } catch (err) {
      opts.log(`Couldn't look into what happened to the page before this one: ${(err as Error)?.message ?? err}`);
    }
    if (!alive) return;
    reporter = setInterval(sayPlay, 2000);
  })();
  return () => {
    alive = false;
    clearInterval(reporter);
    clearInterval(beats);
    unwatchPage().catch(() => {});
  };
};
/** The "end a frozen page" setting changed */
export const rewatch = () => watchPage(settings.unfreeze).catch(() => {});
