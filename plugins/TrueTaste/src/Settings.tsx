import React from "react";
import { settings, type PluginSettings } from "./config";
import { flush, markDirty, resetAll, state } from "./db";
import { getStatus, onStatus, runDiscovery } from "./engine";
import { clearProfile, getDataDir } from "./store.native";

export { settings };

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

const box: React.CSSProperties = { padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.05)", fontSize: 13, lineHeight: 1.6 };

const TasteProfile = () => {
  const [status, setStatus] = React.useState(getStatus());
  const [, rerender] = React.useState(0);
  React.useEffect(() => {
    const off = onStatus((s) => {
      setStatus(s);
      rerender((n) => n + 1);
    });
    return () => void off();
  }, []);

  const run = state.lastRun;
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {status.running ? `⏳ ${status.stage}…` : status.error ? `⚠️ ${status.stage}: ${status.error}` : run ? `✅ Last made ${ago(run.at)}` : `${status.stage}`}
      </div>
      {run && (
        <>
          <div style={{ opacity: 0.75 }}>
            {run.tracks} tracks picked from {run.candidates} candidates · {Math.round(run.ms / 1000)}s · {run.requests} requests · {run.engine}
          </div>
          <div style={{ opacity: 0.75 }}>
            Ranker trained on {state.trainedExamples} of your reactions · {state.events.length} listens tracked · {Object.keys(state.feedback).length} 👍/👎
          </div>
          {run.listeningShare !== undefined && (
            <div style={{ opacity: 0.75 }}>
              Taste from {Math.round(run.listeningShare * 100)}% listening, {Math.round((1 - run.listeningShare) * 100)}% saved library · {run.newArtists ?? "?"}/{run.tracks} picks by artists new to you
            </div>
          )}
          {run.drift !== undefined && (
            <div style={{ opacity: 0.75 }}>
              {run.drift > 0.35 ? `🔀 New phase detected (${Math.round(run.drift * 100)}% drift): following what you play lately` : `Taste drift ${Math.round(run.drift * 100)}%: steady`}
            </div>
          )}
          <div style={{ marginTop: 10, fontWeight: 600 }}>Your taste right now (↑ rising lately, ↓ fading)</div>
          {run.clusters.map((c) => (
            <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <div style={{ width: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.label || "unlabelled"}
                {(c.trend ?? 0) > 0.08 ? " ↑" : (c.trend ?? 0) < -0.08 ? " ↓" : ""}
              </div>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.1)" }}>
                <div style={{ width: `${Math.round(c.share * 100)}%`, height: "100%", borderRadius: 3, background: "#33ffee" }} />
              </div>
              <div style={{ width: 70, textAlign: "right", opacity: 0.75 }}>{c.tracks} tracks</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
};

export const Settings = () => {
  // Read from window.luna rather than imported (see 3DCover): avoids dependency registration issues on live reload
  const { LunaButtonSetting, LunaNumberSetting, LunaSettings, LunaSwitchSetting } = window.luna.ui!;
  const [running, setRunning] = React.useState(getStatus().running);
  const [busy, setBusy] = React.useState(false);
  const [dir, setDir] = React.useState("");
  const [switches, setSwitches] = React.useState({ ...settings });

  React.useEffect(() => {
    getDataDir().then(setDir).catch(() => {});
    const off = onStatus((s) => setRunning(s.running));
    return () => void off();
  }, []);

  const set = <K extends keyof PluginSettings>(key: K, val: PluginSettings[K]) => {
    settings[key] = val;
    setSwitches({ ...settings });
  };
  const toggle = (key: "enabled" | "allowExplicit" | "excludeAI" | "useLastfm" | "notify", desc: string, title: string) => (
    <LunaSwitchSetting
      title={title}
      desc={desc}
      checked={switches[key]}
      value={switches[key]}
      onChange={(e: any, checked?: boolean) => set(key, typeof checked === "boolean" ? checked : (e?.target?.checked ?? !switches[key]))}
    />
  );

  return (
    <LunaSettings>
      <TasteProfile />

      <LunaButtonSetting
        title="Make it now"
        desc="Build a fresh Your Daily Discovery right away (runs in the background, a few minutes)"
        loading={running}
        onClick={() => runDiscovery("manual")}
      >
        Generate
      </LunaButtonSetting>

      <LunaButtonSetting
        title="Open playlist"
        desc={state.playlistId ? "Your Daily Discovery in your library" : "Created on the first run"}
        disabled={!state.playlistId}
        onClick={() => window.luna.lib!.redux.actions["router/PUSH"]({ pathname: `/playlist/${state.playlistId}`, search: "", replace: false })}
      >
        Open
      </LunaButtonSetting>

      {toggle("enabled", "Make a new playlist every day in the background", "Daily refresh")}

      <LunaNumberSetting
        title="Refresh hour"
        desc="Local hour (0-23) when the new day's playlist is made. If TIDAL is closed then, it's made the next time it opens"
        min={0}
        max={23}
        value={settings.refreshHour}
        onNumber={(n: number) => set("refreshHour", n)}
      />

      <LunaNumberSetting title="Playlist length" desc="Number of tracks" min={10} max={60} value={settings.size} onNumber={(n: number) => set("size", n)} />

      <LunaNumberSetting
        title="Adventurousness"
        desc="0 = deeper cuts from artists you already like · 100 = mostly artists you've never heard"
        min={0}
        max={100}
        value={settings.exploration}
        onNumber={(n: number) => set("exploration", n)}
      />

      {toggle("excludeAI", "Leave out tracks TIDAL marks as AI-generated", "Skip AI-generated music")}
      {toggle("allowExplicit", "Include tracks marked explicit", "Allow explicit")}
      {toggle("useLastfm", "Use Last.fm tags and listener data to understand artists' sound (only artist/track names are sent)", "Use Last.fm")}
      {toggle("notify", "Show a notification when a new playlist is ready", "Notify")}

      <LunaButtonSetting
        title="Reset learned taste"
        desc={`Forget tracked listens, the trained ranker and cached artist descriptions. Your TIDAL library is untouched. Data folder: ${dir}`}
        loading={busy}
        disabled={running}
        onClick={async () => {
          setBusy(true);
          const playlistId = state.playlistId;
          resetAll();
          state.playlistId = playlistId;
          await clearProfile().catch(() => {});
          markDirty("state");
          await flush().catch(() => {});
          setBusy(false);
        }}
      >
        Reset
      </LunaButtonSetting>

    </LunaSettings>
  );
};
