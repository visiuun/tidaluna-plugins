import { Tracer } from "@luna/core";
import { accessAllowed } from "./access";
import { appendLog } from "./native";

export const { trace } = Tracer("[DJ]");

let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
const flushLog = () => {
  timer = undefined;
  if (!buffer.length) return;
  // (not before Luna has been asked about the DJ's files: kept until then, the last few hundred lines of it)
  if (!accessAllowed()) {
    if (buffer.length > 500) buffer = buffer.slice(-500);
    timer = setTimeout(flushLog, 5000);
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
  timer ??= setTimeout(flushLog, 1500);
};
export const warn = (msg: string, err?: unknown) => log(`⚠ ${msg}${err ? `: ${(err as Error)?.message ?? err}` : ""}`);
/** Shown to the user as a TIDAL notification */
export const notify = (msg: string) => {
  trace.msg.log(msg);
  log(`(shown) ${msg}`);
};
export const flushLogNow = flushLog;
