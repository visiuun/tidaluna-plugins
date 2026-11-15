// LUNA'S QUESTIONS
// Luna lets a plugin's native code (the parts that run in TIDAL's main process: the mixer, the voices, the files)
// into fs, os, https and electron only once you have allowed it, and asks with a box that stops ALL of TIDAL until
// it is answered: once for each module, for each of the DJ's six native files (one is TrueTaste's), and again for every new version.
// Asked whenever the DJ first happened to need each one (a line written to its log, the mixer starting, the first
// spoken line), those boxes came up one after another for minutes after an install or an update, at moments
// nobody was looking, often behind TIDAL's window, with TIDAL and the music standing still meanwhile. And a "Block"
// isn't kept: Luna asks again at the next call, which for the mixer was every ten seconds and for the log every
// second and a half, so TIDAL never got going again.
//
// So nothing is asked of the native side until all of it has been asked about here, at once, with TIDAL's window in
// front of you and in use (Luna puts its box on the window that has the keyboard: with none it comes up on its own,
// wherever that may be). Until then whatever wants the native side waits (the log keeps its lines). Once everything
// was allowed, that is remembered for this version and nothing waits at the next start; if anything was blocked, the
// DJ leaves the native side alone for the rest of this run (pressing the DJ button asks again).
import { Tracer } from "@luna/core";
import { appendLog as trueTasteLog, getDataDir as trueTasteDir } from "../../TrueTaste/src/store.native";
import pkg from "../package.json";
import { askAccess as mixerAccess } from "./audio/mixer.native";
import { askAccess as stemsAccess } from "./audio/stems.native";
import { settings } from "./config";
import { askAccess as storeAccess } from "./store.native";
import { askAccess as edgeAccess } from "./talk/edge.native";
import { askAccess as voiceAccess } from "./talk/voice.native";

const { trace } = Tracer("[DJ]");
const VERSION = String(pkg.version);
const BLOCKED = /Access Denied|Security/;
// TrueTaste's files, read with what it has measured of your listening, are a native file of their own in the DJ
// too: asked about through two of its calls that touch nothing (its folder's name, and nothing added to its log)
const trueTasteAccess = async () => {
  try {
    await trueTasteDir();
    await trueTasteLog("");
    return true;
  } catch (err) {
    return !BLOCKED.test(String((err as Error)?.message ?? err));
  }
};
const ASKS: Array<() => Promise<boolean>> = [storeAccess, trueTasteAccess, mixerAccess, edgeAccess, voiceAccess, stemsAccess];

type State = "waiting" | "asking" | "allowed" | "blocked";
let state: State = "waiting";
let open!: () => void;
let shut!: (err: Error) => void;
let gate: Promise<void>;
const newGate = () => {
  gate = new Promise<void>((resolve, reject) => {
    open = resolve;
    shut = reject;
  });
  gate.catch(() => {});
};
newGate();
if (settings.accessFor === VERSION) {
  state = "allowed";
  open();
}
let unloaded = false;

/** The native side may be used (everything was allowed, in this run or for this version before) */
export const accessAllowed = () => state === "allowed";

const there = () => document.visibilityState === "visible" && document.hasFocus();
const ask = async () => {
  state = "asking";
  trace.msg.log("DJ: Luna asks once for each new version of the DJ whether it may use files, the network and TIDAL's windows. Allow each, or the DJ stays off");
  // (one box at a time: the next isn't asked until the one before is answered)
  for (const askOne of ASKS) {
    const ok = await askOne().catch(() => true);
    if (unloaded) return;
    if (!ok) {
      state = "blocked";
      trace.msg.err("DJ is off: Luna's access was blocked. Press the DJ button to be asked again");
      shut(new Error("Luna's access was blocked for the DJ"));
      return;
    }
  }
  settings.accessFor = VERSION;
  state = "allowed";
  open();
};
const askIfThere = () => {
  if (state === "waiting" && !unloaded && there()) void ask();
};

/**
 * Resolves once the native side may be used. `again`: you asked for something just now (pressed the DJ
 * button): after a "Block", Luna is asked once more.
 */
export const nativeReady = (again = false): Promise<void> => {
  if (again && state === "blocked") {
    state = "waiting";
    newGate();
  }
  askIfThere();
  return gate;
};

/** A native call that waits for nativeReady() first */
export const gated =
  <A extends unknown[], R>(call: (...args: A) => R) =>
  async (...args: A): Promise<Awaited<R>> => {
    await nativeReady();
    return await call(...args);
  };

/** Asks as soon as you are there: now, when TIDAL's window comes to the front, and every few seconds */
export const watchAccess = () => {
  if (state === "allowed") return () => {};
  const first = setTimeout(askIfThere, 1000);
  const timer = setInterval(askIfThere, 3000);
  window.addEventListener("focus", askIfThere);
  document.addEventListener("visibilitychange", askIfThere);
  return () => {
    unloaded = true;
    clearTimeout(first);
    clearInterval(timer);
    window.removeEventListener("focus", askIfThere);
    document.removeEventListener("visibilitychange", askIfThere);
  };
};
