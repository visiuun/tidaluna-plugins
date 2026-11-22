import React from "react";
import { ReactiveStore } from "@luna/core";

export type PluginSettings = {
  /** how bright the glows are (0-100) */
  intensity: number;
  /** how small a sound off to a side still lights up (0-100) */
  sensitivity: number;
  /** how big each glow is (0-100) */
  size: number;
  /** the most glows at once */
  maxGlows: number;
  /** how far pitch lifts a sound up the screen or brings it down (0-100) */
  height: number;
  /** how long a glow takes to fade (ms) */
  fade: number;
  /** moves the glows earlier (−) or later (+) against the sound (ms) */
  offset: number;
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("ImmersiveBloom", {
  intensity: 70,
  sensitivity: 50,
  size: 50,
  maxGlows: 4,
  height: 50,
  fade: 260,
  offset: 0,
});

/** Settings that change what is measured (not only how it is drawn) */
export const MEASURED: (keyof PluginSettings)[] = ["height"];
export const SETTINGS_EVENT = "luna:immersive-bloom:updated";

const clampTo = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));

export const Settings = () => {
  // Read from window.luna rather than imported (see the note on @luna/lib in index.ts)
  const { LunaNumberSetting, LunaSettings } = window.luna.ui!;
  const update = <K extends keyof PluginSettings>(key: K, val: PluginSettings[K]) => {
    settings[key] = val;
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: key }));
  };
  const num = (key: keyof PluginSettings, title: string, desc: string, min: number, max: number) => (
    <LunaNumberSetting
      title={title}
      desc={desc}
      min={min}
      max={max}
      value={settings[key]}
      onNumber={(v: number) => update(key, clampTo(v, min, max))}
    />
  );
  return (
    <LunaSettings>
      {num("intensity", "Brightness", "How bright the glows are", 5, 100)}
      {num(
        "sensitivity",
        "Sensitivity",
        "How quiet a sound off to a side can be and still light up. Higher shows more, lower only the clearest",
        0,
        100,
      )}
      {num("size", "Glow Size", "How far each glow reaches into the window", 0, 100)}
      {num("maxGlows", "Most Glows At Once", "Only the strongest places light up, so the whole border never does", 1, 8)}
      {num(
        "height",
        "Height From Pitch",
        "Stereo has no up or down of its own; higher sounds are heard higher. How far pitch lifts a glow up the screen, or brings it down (0: not at all)",
        0,
        100,
      )}
      {num("fade", "Fade", "How long a glow takes to fade after its sound, in ms", 60, 1500)}
      {num(
        "offset",
        "Sync Offset",
        "Moves the glows earlier (−) or later (+) against what you hear, in ms. For an output device with a long delay, such as Bluetooth headphones",
        -500,
        500,
      )}
    </LunaSettings>
  );
};
