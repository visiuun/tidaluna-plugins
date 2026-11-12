import React from "react";
import { JINGLES, jingleStyle, settings, VOICES, type Commentary, type Jingle, type Mixing, type PluginSettings } from "./config";
import { getStatus, onStatus, setTransitionOnly, startSession, stopSession } from "./session";
import { clearVoiceFiles, getDataDir } from "./store.native";
import { prepareStock, voiceState, type VoiceState } from "./talk/voice";
import { clearVoiceModel } from "./talk/voice.native";

export { settings };

const box: React.CSSProperties = { padding: "12px 14px", borderRadius: 8, background: "rgba(255,255,255,0.05)", fontSize: 13, lineHeight: 1.6 };

const Overview = () => {
  const [status, setStatus] = React.useState(getStatus());
  const [voice, setVoice] = React.useState<VoiceState | null>(null);
  React.useEffect(() => {
    const off = onStatus(setStatus);
    let alive = true;
    const poll = () => voiceState().then((v) => alive && setVoice(v)).catch(() => {});
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, []);
  const voiceLine = !voice
    ? "Checking the voice…"
    : !voice.usable
      ? "Voice unavailable here: the DJ will mix without talking"
      : voice.cloud
        ? "Voice: cloud (your OpenAI key)"
        : voice.progress !== undefined
          ? `Voice: downloading the model (${voice.progress}%)`
          : !voice.downloaded
            ? "Voice: local model, downloaded the first time the DJ starts (about 330 MB, once)"
            : voice.busy
              ? "Voice: local model, preparing lines…"
              : `Voice: local model, ready${voice.error ? ` (last error: ${voice.error})` : ""}`;
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {status.phase === "off" ? "The DJ is off" : status.mode === "follow" ? "Transitions only is on: what you play is mixed together" : status.busy ? `${status.busy}…` : status.segment ? `On air: ${status.segment}` : "On air"}
      </div>
      <div style={{ opacity: 0.75 }}>{voiceLine}</div>
      <div style={{ opacity: 0.75 }}>
        Start it from the DJ button in the player bar or the card on Home. Press the button again to switch it up. The arrow next to it opens requests.
      </div>
    </div>
  );
};

export const Settings = () => {
  // Read from window.luna rather than imported (see 3DCover): avoids dependency registration issues on live reload
  const { LunaButtonSetting, LunaNumberSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting } = window.luna.ui!;
  const LunaSecureTextSetting = window.luna.ui!.LunaSecureTextSetting as React.ComponentType<any>;
  const [state, setState] = React.useState({ ...settings });
  const [status, setStatus] = React.useState(getStatus());
  const [dir, setDir] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    getDataDir().then(setDir).catch(() => {});
    const off = onStatus(setStatus);
    return () => void off();
  }, []);

  const set = <K extends keyof PluginSettings>(key: K, val: PluginSettings[K]) => {
    settings[key] = val;
    setState({ ...settings });
  };
  const toggle = (key: "homeCard" | "captions" | "allowExplicit" | "coverFx" | "transitionOnly", title: string, desc: string) => (
    <LunaSwitchSetting
      title={title}
      desc={desc}
      checked={state[key]}
      value={state[key]}
      onChange={(e: any, checked?: boolean) => {
        const on = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !state[key]);
        set(key, on);
        // (This one starts or stops something, not just a preference)
        if (key === "transitionOnly") setTransitionOnly(on);
      }}
    />
  );

  // (Transitions only running on its own doesn't count as the DJ being on)
  const djOn = status.phase !== "off" && status.mode !== "follow";
  return (
    <LunaSettings>
      <Overview />

      <LunaButtonSetting
        title={djOn ? "Stop the DJ" : "Start the DJ"}
        desc="The same as the DJ button in the player bar"
        loading={status.phase === "starting" || status.phase === "stopping"}
        onClick={() => (djOn ? stopSession("stopped from settings") : startSession())}
      >
        {djOn ? "Stop" : "Start"}
      </LunaButtonSetting>

      <LunaSelectSetting
        title="Voice"
        desc="Each voice has its own way of talking"
        value={state.voice}
        onChange={(e: any) => {
          set("voice", String(e.target.value));
          prepareStock();
        }}
      >
        {VOICES.map((v) => (
          <LunaSelectItem key={v.id} value={v.id}>
            {v.name}: {v.desc}
          </LunaSelectItem>
        ))}
      </LunaSelectSetting>

      <LunaSelectSetting title="Commentary" desc="How much the DJ talks" value={state.commentary} onChange={(e: any) => set("commentary", e.target.value as Commentary)}>
        <LunaSelectItem value="every">Introduces every song, like a radio presenter</LunaSelectItem>
        <LunaSelectItem value="full">Introduces every set and says why it picked it</LunaSelectItem>
        <LunaSelectItem value="less">Less chatter: only a hello and a goodbye</LunaSelectItem>
        <LunaSelectItem value="off">No talking, just the mix</LunaSelectItem>
      </LunaSelectSetting>

      <LunaSelectSetting title="Jingle" desc="The DJ's signature before it speaks: two seconds, in the key of the song it comes over" value={jingleStyle()} onChange={(e: any) => set("jingle", e.target.value as Jingle)}>
        {JINGLES.map((j) => (
          <LunaSelectItem key={j.id} value={j.id}>
            {j.name}
          </LunaSelectItem>
        ))}
      </LunaSelectSetting>

      <LunaSelectSetting title="Transitions" desc="How one track moves into the next" value={state.mixing} onChange={(e: any) => set("mixing", e.target.value as Mixing)}>
        <LunaSelectItem value="auto">DJ mix: beatmatched blends where the tracks allow it, drops and crossfades where they don't</LunaSelectItem>
        <LunaSelectItem value="crossfade">Crossfades only</LunaSelectItem>
        <LunaSelectItem value="none">None: one track after the other</LunaSelectItem>
      </LunaSelectSetting>

      <LunaNumberSetting title="Tracks per set" desc="How many tracks play between two talk breaks" min={3} max={8} value={state.setLength} onNumber={(n: number) => set("setLength", n)} />

      <LunaNumberSetting
        title="New music"
        desc="0 = only music you know · 100 = mostly music you've never heard"
        min={0}
        max={100}
        value={state.discovery}
        onNumber={(n: number) => set("discovery", n)}
      />

      <LunaSelectSetting
        title="Audio quality"
        desc="What the DJ mixes with. Lossless is CD quality (16-bit / 44.1 kHz); High is 320 kbps AAC and loads faster on a slow connection"
        value={state.quality}
        onChange={(e: any) => set("quality", e.target.value as PluginSettings["quality"])}
      >
        <LunaSelectItem value="LOSSLESS">Lossless</LunaSelectItem>
        <LunaSelectItem value="HIGH">High</LunaSelectItem>
      </LunaSelectSetting>

      {toggle("transitionOnly", "Transitions only", "No picks and no talking: whatever you play in TIDAL (an album, a playlist, your queue) is mixed together, track into track. Stays on across restarts; the DJ button still starts the full DJ on top of it")}
      {toggle("coverFx", "Cover art transitions", "The cover art turns into the next track's cover along with the mix")}
      {toggle("captions", "Captions", "Show what the DJ is saying above the DJ button")}
      {toggle("homeCard", "DJ card on Home", "Show the DJ at the top of TIDAL's Home page")}
      {toggle("allowExplicit", "Allow explicit", "Include tracks marked explicit")}

      <LunaSecureTextSetting
        title="Cloud voice (optional)"
        desc="An OpenAI API key. With it the DJ's lines are spoken by a cloud voice, which is quicker and more expressive than the local one. Only the text of each line is sent. Leave empty to keep everything on this machine"
        value={state.cloudVoiceKey}
        onChange={(e: any) => set("cloudVoiceKey", String(e.target.value ?? ""))}
      />

      <LunaButtonSetting
        title="Clear voice files"
        desc={`Delete the downloaded voice model and every generated line (they're made again when needed). Data folder: ${dir}`}
        loading={busy}
        disabled={djOn}
        onClick={async () => {
          setBusy(true);
          await clearVoiceModel().catch(() => {});
          await clearVoiceFiles().catch(() => {});
          setBusy(false);
        }}
      >
        Clear
      </LunaButtonSetting>
    </LunaSettings>
  );
};
