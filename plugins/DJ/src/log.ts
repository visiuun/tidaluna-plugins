import type { LunaUnload } from "@luna/core";
import { accessAllowed } from "./access";
import { trace, unloads } from "./index.safe";
import { later } from "./later";
import { appendLog } from "./native";

export { trace };

let buffer: string[] = [];
let timer: LunaUnload | undefined;
// (once the plugin has unloaded, lines that can't be written yet are not waited with any more)
let unloaded = false;
unloads.add(() => void (unloaded = true));
const flushLog = () => {
  timer?.();
  timer = undefined;
  if (!buffer.length) return;
  // (not before Luna has been asked about the DJ's files: kept until then, the last few hundred lines of it)
  if (!accessAllowed()) {
    if (buffer.length > 500) buffer = buffer.slice(-500);
    if (!unloaded) timer = later(flushLog, 5000);
    return;
  }
  const text = buffer.join("\n") + "\n";
  buffer = [];
  appendLog(text).catch(() => {});
};

/** To the console and to log.txt in the data folder */
export const log = (msg: string) => {
  trace.log(msg);
  buffer.push(`[${new Date().toISOString()}] ${msg}`);
  timer ??= later(flushLog, 1500);
};
export const warn = (msg: string, err?: unknown) => log(`⚠ ${msg}${err ? `: ${(err as Error)?.message ?? err}` : ""}`);
/** Shown to the user as a TIDAL notification */
export const notify = (msg: string) => {
  trace.msg.log(msg);
  log(`(shown) ${msg}`);
};
export const flushLogNow = flushLog;
