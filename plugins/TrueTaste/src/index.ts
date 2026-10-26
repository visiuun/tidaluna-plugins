import { LunaUnload, Tracer } from "@luna/core";
import { stopRequests, tapHomeFeed } from "./api";
import { settings } from "./config";
import { flush, flushLog, loadAll, markDirty, state, writeLog } from "./db";
import { discoveryDay, isRunning, runDiscovery, setLogger, setNotifier } from "./engine";
import { mountFeedbackButtons } from "./buttons";
import { playingOurPlaylist, startTracking } from "./history";
import { engagement } from "./profile";
import { migrateLegacyData, removeLegacyModels } from "./store.native";

export { Settings } from "./Settings";

export const { trace } = Tracer("[TrueTaste]");
export const unloads = new Set<LunaUnload>();

setLogger((msg) => {
  trace.log(msg);
  writeLog(msg);
});
setNotifier((msg) => trace.msg.log(msg));

// Data from before the rename moves over, so nothing learned is lost
const migrated = await migrateLegacyData().catch((err) => (writeLog(`Migration from the old data folder failed: ${err}`), false));
if (migrated) writeLog("Moved your learned taste over from the old Daily Discovery data folder");
await loadAll();
// Early builds downloaded an ONNX model (~50MB); the taste space is bundled now
removeLegacyModels().catch(() => {});
startTracking(unloads);
mountFeedbackButtons(unloads);
// Opening TIDAL's Home page hands us your "My Most Listened" months
unloads.add(
  tapHomeFeed((mixes) => {
    const refs = new Map((state.historyRefs ?? []).map((m) => [m.id, m]));
    const before = refs.size;
    for (const m of mixes) refs.set(m.id, { ...refs.get(m.id), ...m, at: m.at ?? refs.get(m.id)?.at });
    if (refs.size === before) return;
    state.historyRefs = [...refs.values()];
    // Read them on the next run
    state.librarySyncAt = 0;
    markDirty("state");
    writeLog(`Found ${refs.size - before} "My Most Listened" mixes on the Home page`);
  }),
);
writeLog(`Loaded: ${state.events.length} listens tracked, last playlist ${state.lastRun?.day ?? "never"}, next check in 45s`);

// ------------------ SCHEDULER ------------------
// Checks every 15 minutes whether today's playlist exists, or whether today's needs redoing because your
// taste moved. The first check waits for TIDAL to settle, so starting the app never competes with it.
const STARTUP_DELAY_MS = 45000;
const CHECK_EVERY_MS = 15 * 60000;
const HOUR = 3600e3;

// discoveryDay() rolls over at the refresh hour, so this also catches up on a day TIDAL was closed
const due = () => state.lastRun?.day !== discoveryDay();

/**
 * Active adaptation: don't wait for tomorrow when today's picks clearly aren't landing. At most every
 * 4 hours, and never within 3 hours of the last playlist.
 */
const adaptReason = () => {
  const run = state.lastRun;
  const now = Date.now();
  if (!run || now - run.at < 3 * HOUR || now - (state.lastAdaptAt ?? 0) < 4 * HOUR) return null;
  const picks = state.events.filter((e) => e.dd && e.t > run.at);
  const mean = picks.reduce((s, e) => s + engagement(e.ms, e.ratio), 0) / Math.max(1, picks.length);
  if (picks.length >= 5 && mean < -0.15) return `you skipped most of today's picks (${picks.length} played)`;
  const downs = Object.values(state.feedback).filter((f) => f.v < 0 && f.at > run.at).length;
  if (downs >= 3) return `${downs} 👎 since the last playlist`;
  // Lots of fresh listening since the last playlist: worth re-reading where your taste is now
  const fresh = state.events.filter((e) => e.t > run.at && engagement(e.ms, e.ratio) > 0.5).length;
  if (fresh >= 60) return `${fresh} tracks played through since the last playlist`;
  return null;
};

const check = () => {
  if (!settings.enabled || isRunning()) return;
  if (due()) return void runDiscovery("daily").catch(() => {});
  // Never swap the playlist out from under you while you're listening to it
  const reason = playingOurPlaylist() ? null : adaptReason();
  if (!reason) return;
  state.lastAdaptAt = Date.now();
  runDiscovery(`adapting: ${reason}`).catch(() => {});
};

const startup = setTimeout(check, STARTUP_DELAY_MS);
const interval = setInterval(check, CHECK_EVERY_MS);

unloads.add(() => {
  clearTimeout(startup);
  clearInterval(interval);
  stopRequests();
  flushLog();
  flush().catch(() => {});
});
