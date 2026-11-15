// Runs in the Electron main process, inside each of the DJ's native modules (see access.ts for why).
// Luna checks every call into a Node module outside its short list (fs, os, https, electron) against what
// you allowed for that exact code, and asks with a box that stops all of TIDAL until it is answered. Each
// native module is asked about on its own, once for every module it uses, and again for every new version.
// Calling each of them once here is what has Luna ask: all its questions at once, at a moment chosen for it.

const BLOCKED = /Access Denied|Security/;

/** Calls each once (nothing they do matters): false as soon as one was blocked in Luna's box (the rest aren't asked) */
export const tryAccess = (tries: Array<() => unknown>): boolean => {
  for (const attempt of tries) {
    try {
      const r: any = attempt();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (err) {
      // (anything else, a module that isn't there for one, is not Luna's no)
      if (BLOCKED.test(String((err as Error)?.message ?? err))) return false;
    }
  }
  return true;
};
