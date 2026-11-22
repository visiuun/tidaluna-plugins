// Timers that end with the plugin: Luna's safeTimeout and safeInterval, on the DJ's unloads. (Read from window.luna,
// as the rest of @luna/lib is here: see the note on it in 3DCover)
import type { LunaUnload } from "@luna/core";
import { unloads } from "./index.safe";

/** `cb` once, in `ms`, unless the plugin unloads first. The returned function cancels it */
export const later = (cb: () => void, ms: number): LunaUnload => window.luna.lib!.safeTimeout(unloads, cb, ms);
/** `cb` every `ms` until the plugin unloads. The returned function stops it */
export const every = (cb: () => void, ms: number): LunaUnload => window.luna.lib!.safeInterval(unloads, cb, ms);

/**
 * A save put off: `save` runs `ms` after the first call since it last ran. When the plugin unloads with one due, it
 * runs then and there instead of being lost (or of running after the plugin is gone).
 */
export const putOff = (save: () => void, ms: number) => {
  let due: LunaUnload | undefined;
  const run = () => {
    due = undefined;
    save();
  };
  unloads.add(() => {
    if (!due) return;
    due();
    run();
  });
  return () => {
    due ??= later(run, ms);
  };
};
