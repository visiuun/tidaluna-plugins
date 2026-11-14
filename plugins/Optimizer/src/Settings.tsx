import React from "react";
import { tuneAll } from "./animations";
import { scriptRate } from "./frames";
import { askTrim, check, checkDisk, clean, clearDisk, trim } from "./memory";
import { rewatch } from "./recover";
import { installTimers, measure, removeTimers, type Usage } from "./scripts";
import { onStatus, settings, status, type PluginSettings } from "./state";

const box: React.CSSProperties = { padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.05)", fontSize: 13, lineHeight: 1.6, marginBottom: 10 };
const dim: React.CSSProperties = { opacity: 0.75 };
const head: React.CSSProperties = { fontWeight: 600, marginBottom: 4 };
const table: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr auto auto", columnGap: 18, rowGap: 1, marginTop: 6, fontVariantNumeric: "tabular-nums" };
const wide: React.CSSProperties = { ...table, gridTemplateColumns: "1fr auto auto auto" };
const right: React.CSSProperties = { textAlign: "right" };

const long = (ms: number) => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${(minutes / 60).toFixed(1)} hours`;
};
const ago = (at: number) => {
  const ms = Date.now() - at;
  if (ms < 60000) return "just now";
  if (ms < 36e5) return `${Math.round(ms / 60000)} min ago`;
  if (ms < 864e5) return `${Math.round(ms / 36e5)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(2)} GB` : `${n} MB`);

/** Redraws when the Optimizer's status changes, and every few seconds while the page is open */
const useStatus = () => {
  const [, redraw] = React.useState(0);
  React.useEffect(() => {
    const off = onStatus(() => redraw((n) => n + 1));
    const timer = setInterval(() => redraw((n) => n + 1), 5000);
    // (the page is open: a fresh look now rather than at the next turn)
    void check();
    void checkDisk();
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
};

const Watching = () => {
  const pausedMs = status.pausedMs + (status.pausedSince ? Date.now() - status.pausedSince : 0);
  const given = Math.round(scriptRate());
  return (
    <div style={box}>
      <div style={head}>{status.problem ? "Not watching the window" : "Watching TIDAL's window"}</div>
      <div style={dim}>
        {status.problem
          ? `Nothing is paused: ${status.problem}`
          : status.covered
            ? "Nothing is drawn when TIDAL is minimised or completely covered by another window (a full-screen game, say), and it is all back the moment it shows."
            : "Nothing is drawn when TIDAL is minimised. Being covered by another window can't be told on this system."}
      </div>
      {!status.problem && (
        <div style={dim}>
          Since TIDAL started: paused {status.pauses} time{status.pauses === 1 ? "" : "s"}, {long(pausedMs)} in all; {status.framesHeld.toLocaleString()} animation frame{status.framesHeld === 1 ? "" : "s"} not drawn
          {status.videosPaused ? `, ${status.videosPaused} video${status.videosPaused === 1 ? "" : "s"} paused` : ""}
          {status.timersSkipped ? `, ${status.timersSkipped.toLocaleString()} timer runs left out` : ""}.
        </div>
      )}
      {settings.frameLimit > 0 && status.screenRate > 0 && (
        <div style={dim}>
          In sight: the screen shows {status.screenRate} frames a second, scripts draw on {given >= status.screenRate ? "every one" : `${given} of them`}
          {status.framesSpared ? ` (${status.framesSpared.toLocaleString()} left out so far)` : ""}
          {status.animationsStepped ? `; ${status.animationsStepped.toLocaleString()} animation${status.animationsStepped === 1 ? " moves" : "s move"} in steps` : ""}.
        </div>
      )}
    </div>
  );
};

const Memory = () => {
  const s = status.sample;
  const limit = Math.max(600, settings.guardLimit || 1500);
  const level = Math.max(0, Math.min(1.2, status.level || (s ? s.page / limit : 0)));
  const colour = level >= 1 ? "#e5484d" : level >= 0.75 ? "#f5a524" : "#3dd68c";
  return (
    <div style={box}>
      <div style={head}>Memory</div>
      {!s ? (
        <div style={dim}>{status.guardProblem ? `Can't be read: ${status.guardProblem}` : "Looking…"}</div>
      ) : (
        <>
          <div style={dim}>
            TIDAL's page holds {mb(s.page)}
            {status.heap ? ` (${mb(status.heap)} of it scripts, which may reach about ${mb(Math.round(status.heapLimit * 0.9))})` : ""}. {settings.guard ? `The guard keeps it under ${mb(limit)}.` : "The guard is off."}
          </div>
          <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.1)", margin: "8px 0 4px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round((level / 1.2) * 100)}%`, background: colour, transition: "width 0.4s" }} />
          </div>
          {status.guard && <div style={{ color: colour }}>{status.guard}</div>}
          {status.cleaned && (
            <div style={dim}>
              Last cleaned {ago(status.cleaned.at)} ({status.cleaned.why}): {mb(status.cleaned.before)} before, {mb(status.cleaned.after)} after.
            </div>
          )}
          {status.trimmed && (
            <div style={dim}>
              Last handed back to Windows {ago(status.trimmed.at)}: {mb(status.trimmed.before)} in memory before, {mb(status.trimmed.after)} after.
            </div>
          )}
          <div style={{ ...wide, ...dim }}>
            <div />
            <div style={{ ...right, fontSize: 12 }}>holds</div>
            <div style={{ ...right, fontSize: 12 }}>in memory</div>
            <div style={{ ...right, fontSize: 12 }}>processor</div>
            {s.rows.map((r) => (
              <React.Fragment key={r.pid}>
                <div style={r.page ? { fontWeight: 600 } : undefined}>{r.what}</div>
                <div style={right}>{mb(r.memory)}</div>
                <div style={right}>{mb(r.ram)}</div>
                <div style={right}>{r.cpu.toFixed(1)}%</div>
              </React.Fragment>
            ))}
            <div style={{ fontWeight: 600 }}>All of TIDAL</div>
            <div style={{ ...right, fontWeight: 600 }}>{mb(s.total)}</div>
            <div style={{ ...right, fontWeight: 600 }}>{mb(s.ram)}</div>
            <div style={{ ...right, fontWeight: 600 }}>{s.cpu.toFixed(1)}%</div>
          </div>
          <div style={{ ...dim, fontSize: 12, marginTop: 4 }}>
            What each one holds as its own; what it has in memory right now (this counts what processes share once for each, so it adds up to more than the Task Manager shows); and how much of one processor core it has been using since the last look
            (100% is one core kept busy).
          </div>
        </>
      )}
    </div>
  );
};

const History = () => {
  const notes = [...(settings.history ?? [])].reverse().slice(0, 8);
  return (
    <div style={box}>
      <div style={head}>What the Optimizer has done</div>
      {notes.length === 0 ? (
        <div style={dim}>Nothing yet: no crash, no full page, nothing to clear.</div>
      ) : (
        notes.map((n, i) => (
          <div key={`${n.at}-${i}`} style={dim}>
            <span style={{ opacity: 0.7 }}>{ago(n.at)}:</span> {n.text}
          </div>
        ))
      )}
    </div>
  );
};

const Scripts = ({ usage, error }: { usage?: Usage; error?: string }) => {
  if (error) return <div style={{ ...box, ...dim }}>Couldn't measure: {error}</div>;
  if (!usage) return null;
  return (
    <div style={box}>
      <div style={head}>
        Scripts, over {usage.seconds.toFixed(0)} seconds: {(usage.busy * 100).toFixed(1)}% of a processor core
      </div>
      <div style={dim}>How long the processor was in each one's code (what it had the browser do counts as its own){usage.gc >= 0.005 ? `; ${(usage.gc * 100).toFixed(1)}% went to collecting garbage` : ""}.</div>
      <div style={{ ...table, ...dim }}>
        {usage.rows.slice(0, 14).map((r) => (
          <React.Fragment key={r.name}>
            <div>{r.name}</div>
            <div style={right}>{r.ms} ms</div>
            <div style={right}>{(r.share * 100).toFixed(1)}%</div>
          </React.Fragment>
        ))}
      </div>
      {usage.rows.length === 0 && <div style={dim}>Nothing ran long enough to show.</div>}
    </div>
  );
};

export const Settings = () => {
  // Read from window.luna rather than imported: avoids dependency registration issues on live reload
  const { LunaButtonSetting, LunaNumberSetting, LunaSettings, LunaSwitchSetting } = window.luna.ui!;
  const [state, setState] = React.useState({ ...settings });
  const [busy, setBusy] = React.useState("");
  const [usage, setUsage] = React.useState<Usage | undefined>();
  const [usageError, setUsageError] = React.useState<string | undefined>();
  const [said, setSaid] = React.useState<Record<string, string>>({});
  useStatus();
  type Flag = { [K in keyof PluginSettings]: PluginSettings[K] extends boolean ? K : never }[keyof PluginSettings];
  const toggle = (key: Flag, title: string, desc: string, then?: () => void) => (
    <LunaSwitchSetting
      title={title}
      desc={desc}
      checked={state[key]}
      value={state[key]}
      onChange={(e: any, checked?: boolean) => {
        settings[key] = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !state[key]);
        setState({ ...settings });
        then?.();
      }}
    />
  );
  const run = async (what: string, job: () => Promise<string>) => {
    setBusy(what);
    try {
      const text = await job();
      setSaid((s) => ({ ...s, [what]: text }));
    } catch (err) {
      setSaid((s) => ({ ...s, [what]: `Didn't work: ${(err as Error)?.message ?? err}` }));
    }
    setBusy("");
  };
  const disk = status.disk;
  return (
    <LunaSettings>
      <Memory />
      <History />

      {toggle(
        "guard",
        "Memory guard",
        "Watches how much TIDAL's page holds. As it nears the limit its memory is cleaned; past it, if cleaning didn't help, the page is reloaded before it runs out and stops (TIDAL's \"Something went wrong\")",
        () => void check(),
      )}
      <LunaNumberSetting
        title="Memory limit (MB)"
        desc="How much TIDAL's page may hold. TIDAL itself calls 1500 too much; the page stops for good somewhere around 2000. Cleaning starts at three quarters of this"
        min={800}
        max={1900}
        value={state.guardLimit}
        onNumber={(n: number) => {
          settings.guardLimit = n;
          setState({ ...settings });
          void check();
        }}
      />
      {toggle(
        "guardReload",
        "Reload a full page",
        "Past the limit the page is reloaded: when it is out of sight or you have left it alone for two minutes, or at once if it is about to stop. What was playing comes back; with the DJ plugin the music doesn't stop at all. Off: you are only told",
      )}
      {toggle("cleanHidden", "Clean memory while out of sight", "When TIDAL has been minimised or covered for a minute, its page gives back the memory it no longer needs (at most every ten minutes)")}
      {toggle(
        "trim",
        "Hand memory back to Windows while out of sight",
        status.canTrim === false
          ? "Not possible here: this is done on Windows, and Luna has to allow this plugin to start a program (it asks once)"
          : "When TIDAL has been out of sight for a minute, and every ten minutes after, Windows is asked to take what TIDAL holds but isn't using out of memory: the Task Manager's figure drops to what TIDAL really needs, and the rest is there for your game. Nothing is closed; what is needed again is back at once. Never asked of what makes the sound",
        () => settings.trim && void askTrim(),
      )}
      <LunaButtonSetting
        title="Hand memory back now"
        desc={said.trim ?? "The same, now. With TIDAL in sight it takes back what it needs to draw itself within seconds, so the figure climbs again"}
        loading={busy === "trim"}
        onClick={() =>
          run("trim", async () => {
            if (!(await askTrim())) return "Not possible here";
            const r = await trim("by hand");
            void check();
            return `Handed back: ${mb(r.before)} in memory before, ${mb(r.after)} after`;
          })
        }
      >
        Hand back
      </LunaButtonSetting>
      <LunaButtonSetting
        title="Clean memory now"
        desc={said.memory ?? "Has TIDAL's page give back what it no longer needs. Nothing that is in use is touched; the page may stand still for a fraction of a second"}
        loading={busy === "memory"}
        onClick={() =>
          run("memory", async () => {
            const r = await clean("by hand");
            void check();
            return r.before - r.after >= 1 ? `Cleaned: ${mb(r.before)} before, ${mb(r.after)} after` : `Nothing to give back: still ${mb(r.after)}`;
          })
        }
      >
        Clean
      </LunaButtonSetting>

      {toggle(
        "recover",
        "Bring the music back",
        "When TIDAL's page has died, frozen or been reloaded, the song that was playing is put back on where it had got to, as soon as the page is there again (a gap of a second or two; none at all with the DJ plugin, which plays through)",
      )}
      {toggle("unfreeze", "End a frozen page", "A page that hasn't answered for half a minute is ended, and TIDAL brings a fresh one. Never while the developer tools are open", () => void rewatch())}

      <LunaButtonSetting
        title="Clear the cache on disk"
        desc={said.disk ?? (disk ? `TIDAL's cache holds ${mb(disk.cache)}${disk.dumps ? `, and there are ${mb(disk.dumps)} of crash dumps older than a week` : ""}. Covers and pages are downloaded again when needed; your login, settings and plugins are not touched` : "What TIDAL has downloaded and kept: covers, pages, scripts")}
        loading={busy === "disk"}
        onClick={() => run("disk", async () => `Cleared: ${mb(await clearDisk())} freed`)}
      >
        Clear
      </LunaButtonSetting>
      <LunaNumberSetting
        title="Keep the cache under (MB)"
        desc="Cleared by itself once it passes this. 0: never by itself"
        min={0}
        max={8192}
        value={state.cacheLimit}
        onNumber={(n: number) => {
          settings.cacheLimit = n;
          setState({ ...settings });
        }}
      />

      <LunaButtonSetting
        title="Measure the scripts"
        desc="Ten seconds of where the page's processor time goes: TIDAL, Luna and every plugin by name. Use TIDAL as usual meanwhile, or leave it alone to see what runs by itself"
        loading={busy === "scripts"}
        onClick={async () => {
          setBusy("scripts");
          setUsageError(undefined);
          try {
            setUsage(await measure(10));
          } catch (err) {
            setUsageError(String((err as Error)?.message ?? err));
          }
          setBusy("");
        }}
      >
        Measure
      </LunaButtonSetting>
      <Scripts usage={usage} error={usageError} />

      <Watching />
      {toggle(
        "render",
        "Draw nothing out of sight",
        "While TIDAL can't be seen its page isn't drawn at all, and is all there again the moment the window shows. The biggest saving: TIDAL's progress bar alone kept the whole window being redrawn as often as the screen shows a frame, all song long, behind whatever was in front of it. Turn off if you record or stream TIDAL's window while something covers it",
      )}
      <LunaNumberSetting
        title="Frame limit, in sight"
        desc="How many times a second scripts may draw (moving backgrounds, visualisers, lyrics) and animations move. A fast screen (144, 180, 240 Hz) makes every one of them redraw that often, at the cost of a whole processor core or more; 60 looks the same for nearly all of it. Scrolling stays as fast as the screen. With a limit, TIDAL's progress bar also moves in steps of half a pixel instead of on every frame. 0: no limit, everything runs as it did"
        min={0}
        max={480}
        value={state.frameLimit}
        onNumber={(n: number) => {
          settings.frameLimit = n > 0 && n < 10 ? 10 : n;
          setState({ ...settings });
          tuneAll();
        }}
      />
      {toggle("frames", "Hold animation frames", "While TIDAL can't be seen, scripts that draw are not run: animations, visualisers, 3D covers and effects from TIDAL and every plugin wait, and carry on when the window is back")}
      {toggle("css", "Pause looping animations", "Spinners, spinning covers, moving backgrounds and other endless animations stand still while TIDAL can't be seen")}
      {toggle("videos", "Pause silent videos", "Animated covers and other videos without sound are paused while TIDAL can't be seen. Videos with sound are never touched")}
      {toggle("pageVisibility", "Tell the page it is hidden", "TIDAL and plugins that ask whether the page is visible are told the truth, so they can leave their own work undone (the DJ skips its cover art transitions, 3D Cover doesn't generate covers). Turn off if something misbehaves in the background")}
      {toggle(
        "slowTimers",
        "Slow fast timers out of sight",
        "Timers that repeat more than four times a second (nearly always there to look at the page or draw something) run once a second while TIDAL can't be seen. Off by default: a plugin that fades the volume with such a timer would do it in steps then. Applies to timers started after this is switched on",
        () => (settings.slowTimers ? installTimers() : removeTimers()),
      )}
    </LunaSettings>
  );
};
