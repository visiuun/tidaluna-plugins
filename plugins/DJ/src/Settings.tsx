import React from "react";
import { JINGLES, jingleStyle, settings, voiceEngine, VOICES, type Commentary, type Jingle, type Mixing, type PluginSettings, type VoiceEngine } from "./config";
import { poweredByTrueTaste } from "./brain";
import { applyVoiceVolume, getStatus, onStatus, setTransitionOnly, startSession, stopSession } from "./session";
import { clearSongCache, clearVoiceFiles, getDataDir, openTrueTastePage, songCacheSize } from "./native";
import { prepareStock, voiceState, type VoiceState } from "./talk/voice";
import { clearVoiceModel } from "./native";

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
        : voice.online && !voice.onlineDown
          ? "Voice: online (Edge's voices), with the local one standing by"
          : voice.progress !== undefined
          ? `Voice: downloading the model (${voice.progress}%)`
          : !voice.downloaded
            ? "Voice: local model, downloaded the first time the DJ starts (about 330 MB, once)"
            : voice.busy
              ? "Voice: local model, preparing lines…"
              : `Voice: local model, ready${voice.error ? ` (last error: ${voice.error})` : ""}`;
  const standIn = voice?.onlineDown ? `The online voice isn't answering (${voice.onlineDown}): the local one reads until it is tried again shortly` : undefined;
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {status.phase === "off" ? "The DJ is off" : status.mode === "follow" ? "Transitions only is on: what you play is mixed together" : status.busy ? `${status.busy}…` : status.segment ? `On air: ${status.segment}` : "On air"}
      </div>
      <div style={{ opacity: 0.75 }}>{voiceLine}</div>
      {standIn && <div style={{ opacity: 0.75 }}>{standIn}</div>}
      <div style={{ opacity: 0.75 }}>
        Start it from the DJ button in the player bar or the card on Home. Press the button again to switch it up. The arrow next to it opens requests.
      </div>
      {poweredByTrueTaste() && (
        <div style={{ opacity: 0.55, marginTop: 6, fontSize: 12 }}>
          Powered by{" "}
          <a style={{ fontWeight: 700, color: "inherit", cursor: "pointer", textDecoration: "underline" }} title="Open TrueTaste on GitHub" onClick={() => void openTrueTastePage().catch(() => {})}>
            TrueTaste
          </a>
          : the DJ picks by what it has measured of your listening.
        </div>
      )}
    </div>
  );
};

/** The plugins the DJ works with: it shows what they make, it doesn't make it again */
const Credits = () => (
  <div style={{ opacity: 0.75, fontSize: 12, lineHeight: "18px", padding: "8px 0 12px" }}>
    <div style={{ fontWeight: 700, marginBottom: 2 }}>Works with</div>
    <div>
      <b>Radiant Lyrics</b> by meowarex (radiant-lyrics.org): the backdrop and the lyrics on the full screen are Radiant Lyrics' own, shown through it.
    </div>
    <div>
      <b>3D Cover</b> by visiuun: the depth on the full screen's cover.
    </div>
    <div>
      <b>TrueTaste</b> by visiuun: the thumbs on the full screen, and what the DJ knows of your listening.
    </div>
  </div>
);

export const Settings = () => {
  // Read from window.luna rather than imported (see 3DCover): avoids dependency registration issues on live reload
  const { LunaButtonSetting, LunaNumberSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting } = window.luna.ui!;
  const LunaSecureTextSetting = window.luna.ui!.LunaSecureTextSetting as React.ComponentType<any>;
  const [state, setState] = React.useState({ ...settings });
  const [status, setStatus] = React.useState(getStatus());
  const [dir, setDir] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [songs, setSongs] = React.useState<{ bytes: number; files: number } | null>(null);
  React.useEffect(() => {
    songCacheSize().then(setSongs, () => {});
  }, []);

  React.useEffect(() => {
    getDataDir().then(setDir).catch(() => {});
    const off = onStatus(setStatus);
    return () => void off();
  }, []);

  const set = <K extends keyof PluginSettings>(key: K, val: PluginSettings[K]) => {
    settings[key] = val;
    setState({ ...settings });
  };
  const toggle = (key: "homeCard" | "captions" | "allowExplicit" | "coverFx" | "transitionOnly" | "stageBackdrop" | "stageLyrics" | "stageCover3d" | "mashupMode", title: string, desc: string) => (
    <LunaSwitchSetting
      title={title}
      desc={desc}
      checked={state[key] !== false}
      value={state[key] !== false}
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

      <LunaSelectSetting
        title="Voice engine"
        desc="Who reads the DJ's lines. Online: the voices of Microsoft Edge's read aloud, which cost your PC nothing and answer in a few seconds; the text of each line is sent to Microsoft, and the local voice steps in whenever they can't be reached. On this PC: a voice model that runs here (about 330 MB, downloaded once), nothing sent anywhere, slower while a game has the processor"
        value={voiceEngine()}
        onChange={(e: any) => {
          set("voiceEngine", e.target.value as VoiceEngine);
          prepareStock();
        }}
      >
        <LunaSelectItem value="edge">Online</LunaSelectItem>
        <LunaSelectItem value="local">On this PC</LunaSelectItem>
      </LunaSelectSetting>

      <LunaSelectSetting title="Commentary" desc="How much the DJ talks" value={state.commentary} onChange={(e: any) => set("commentary", e.target.value as Commentary)}>
        <LunaSelectItem value="every">Every song, like a radio presenter</LunaSelectItem>
        <LunaSelectItem value="full">Every set, and why it picked it</LunaSelectItem>
        <LunaSelectItem value="less">Only a hello and a goodbye</LunaSelectItem>
        <LunaSelectItem value="off">No talking, just the mix</LunaSelectItem>
      </LunaSelectSetting>

      <LunaSelectSetting title="Jingle" desc="The DJ's signature before it speaks, if you want one: two seconds, in the key, the major or minor and the tuning of the song it comes over" value={jingleStyle()} onChange={(e: any) => set("jingle", e.target.value as Jingle)}>
        {JINGLES.map((j) => (
          <LunaSelectItem key={j.id} value={j.id}>
            {j.name}
          </LunaSelectItem>
        ))}
      </LunaSelectSetting>

      <LunaSelectSetting
        title="Transitions"
        desc="How one track moves into the next. DJ mix: beatmatched blends where the tracks allow it, drops and crossfades where they don't"
        value={state.mixing}
        onChange={(e: any) => set("mixing", e.target.value as Mixing)}
      >
        <LunaSelectItem value="auto">DJ mix</LunaSelectItem>
        <LunaSelectItem value="crossfade">Crossfades only</LunaSelectItem>
        <LunaSelectItem value="none">None: one after the other</LunaSelectItem>
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

      <LunaNumberSetting
        title="Voice volume"
        desc="How loud the DJ talks, in percent of its usual level (0 = silent, 150 = louder). The music follows TIDAL's own volume"
        min={0}
        max={150}
        value={state.voiceVolume ?? 100}
        onNumber={(n: number) => {
          set("voiceVolume", n);
          applyVoiceVolume();
        }}
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

      {toggle("mashupMode", "Mashup mode", "One mashup after another: each song that plays on its own gets a go at a mashup with one that fits it, and the DJ carries on as usual where none does")}
      {toggle("transitionOnly", "Transitions only", "No picks and no talking: whatever you play in TIDAL (an album, a playlist, your queue) is mixed together, track into track. Stays on across restarts; the DJ button still starts the full DJ on top of it")}
      {toggle("coverFx", "Cover art transitions", "The cover art turns into the next track's cover along with the mix")}
      {toggle("captions", "Captions", "Show what the DJ is saying above the DJ button")}
      {toggle("homeCard", "DJ card on Home", "Show the DJ at the top of TIDAL's Home page")}
      {toggle("allowExplicit", "Allow explicit", "Include tracks marked explicit")}

      {toggle("stageLyrics", "Full screen: lyrics", "The line being sung, under the song's name: the real line out of TIDAL's lyrics (Radiant Lyrics' own when that plugin is on, word by word as it draws them). It makes way while the DJ talks and while a mix is shown")}
      {toggle("stageBackdrop", "Full screen: Radiant Lyrics backdrop", "With Radiant Lyrics on, its moving cover backdrop is what is behind the full screen, in place of the DJ's own")}
      {toggle("stageCover3d", "Full screen: 3D cover", "With 3D Cover on, the cover on the full screen has its depth when the mouse is over it")}
      <Credits />

      <LunaSecureTextSetting
        title="Cloud voice (optional)"
        desc="An OpenAI API key. With it the DJ's lines are spoken by OpenAI's voices instead of either of the above. Only the text of each line is sent. Leave empty not to use it"
        value={state.cloudVoiceKey}
        onChange={(e: any) => set("cloudVoiceKey", String(e.target.value ?? ""))}
      />

      <LunaButtonSetting
        title="Clear song cache"
        desc={`Songs the DJ has played are kept on disk (up to 1.5 GB, the ones used longest ago going first), so they load at once the next time instead of being downloaded again.${songs ? ` Now: ${songs.files} song${songs.files === 1 ? "" : "s"}, ${Math.round(songs.bytes / 1024 ** 2)} MB.` : ""}`}
        disabled={!songs?.files}
        onClick={async () => {
          await clearSongCache().catch(() => {});
          setSongs(await songCacheSize().catch(() => null));
        }}
      >
        Clear
      </LunaButtonSetting>

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
