import React from "react";
import { onStatus, settings, status, type PluginSettings } from "./state";

const box: React.CSSProperties = { padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.05)", fontSize: 13, lineHeight: 1.6 };

const long = (ms: number) => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${(minutes / 60).toFixed(1)} hours`;
};

const Overview = () => {
  const [, redraw] = React.useState(0);
  React.useEffect(() => {
    const off = onStatus(() => redraw((n) => n + 1));
    const timer = setInterval(() => redraw((n) => n + 1), 5000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
  const pausedMs = status.pausedMs + (status.pausedSince ? Date.now() - status.pausedSince : 0);
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{status.problem ? "Not watching the window" : "Watching TIDAL's window"}</div>
      <div style={{ opacity: 0.75 }}>
        {status.problem
          ? `Nothing is paused: ${status.problem}`
          : status.covered
            ? "Animations stop when TIDAL is minimised or completely covered by another window (a full-screen game, say), and start again the moment it shows."
            : "Animations stop when TIDAL is minimised. Being covered by another window can't be told on this system."}
      </div>
      {!status.problem && (
        <div style={{ opacity: 0.75 }}>
          Since TIDAL started: paused {status.pauses} time{status.pauses === 1 ? "" : "s"}, {long(pausedMs)} in all; {status.framesHeld.toLocaleString()} animation frame{status.framesHeld === 1 ? "" : "s"} not drawn
          {status.videosPaused ? `, ${status.videosPaused} video${status.videosPaused === 1 ? "" : "s"} paused` : ""}.
        </div>
      )}
    </div>
  );
};

export const Settings = () => {
  // Read from window.luna rather than imported: avoids dependency registration issues on live reload
  const { LunaSettings, LunaSwitchSetting } = window.luna.ui!;
  const [state, setState] = React.useState({ ...settings });
  const toggle = (key: keyof PluginSettings, title: string, desc: string) => (
    <LunaSwitchSetting
      title={title}
      desc={desc}
      checked={state[key]}
      value={state[key]}
      onChange={(e: any, checked?: boolean) => {
        settings[key] = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !state[key]);
        setState({ ...settings });
      }}
    />
  );
  return (
    <LunaSettings>
      <Overview />
      {toggle("frames", "Hold animation frames", "While TIDAL can't be seen, nothing is drawn: animations, visualisers, 3D covers and effects from TIDAL and every plugin wait, and carry on when the window is back. The biggest saving")}
      {toggle("css", "Pause looping animations", "Spinners, spinning covers, moving backgrounds and other endless animations stand still while TIDAL can't be seen")}
      {toggle("videos", "Pause silent videos", "Animated covers and other videos without sound are paused while TIDAL can't be seen. Videos with sound are never touched")}
      {toggle("pageVisibility", "Tell the page it is hidden", "TIDAL and plugins that ask whether the page is visible are told the truth, so they can leave their own work undone (the DJ skips its cover art transitions, 3D Cover doesn't generate covers). Turn off if something misbehaves in the background")}
    </LunaSettings>
  );
};
