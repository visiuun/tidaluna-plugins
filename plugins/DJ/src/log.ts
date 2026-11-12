import { Tracer } from "@luna/core";
import { appendLog } from "./store.native";

export const { trace } = Tracer("[DJ]");

let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
const flushLog = () => {
  timer = undefined;
  if (!buffer.length) return;
  const text = buffer.join("\n") + "\n";
  buffer = [];
  appendLog(text).catch(() => {});
};

/** To the console and to log.txt in the data folder */
export const log = (msg: string) => {
  trace.log(msg);
  buffer.push(`[${new Date().toISOString()}] ${msg}`);
  timer ??= setTimeout(flushLog, 1500);
};
export const warn = (msg: string, err?: unknown) => log(`⚠ ${msg}${err ? `: ${(err as Error)?.message ?? err}` : ""}`);
/** Shown to the user as a TIDAL notification */
export const notify = (msg: string) => {
  trace.msg.log(msg);
  log(`(shown) ${msg}`);
};
export const flushLogNow = flushLog;
