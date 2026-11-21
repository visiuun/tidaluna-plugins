import React from "react";
import { ReactiveStore } from "@luna/core";
import { clearDepthCache, clearModelCache, getDepthCacheStats } from "./depth";

export type DepthModel = "small" | "base";

export type PluginSettings = {
  model: DepthModel;
  intensity: number; // px of shift on a 500px cover (same unit as the Python "Depth Shift")
  focal: number; // 0-100 → focal plane 0.00-1.00
  antiSmear: number; // 2-30 → occlusion threshold 0.02-0.30
  mouseSmoothing: number; // only used when the cover has no tilt container to follow
  invert: boolean;
  lighting: boolean; // light, reflections and shadows from the AI depth
  lightStrength: number; // 0-100
  preloadNext: boolean; // generate the next track's cover before it plays
  breakout: boolean; // foreground can cross the cover's border
  autoTilt: boolean; // the cover sways slowly on its own while the mouse isn't on it
  autoTiltAmount: number; // 5-100, share of a full tilt
  autoTiltRev: number; // which default of autoTiltAmount has been applied
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("3DCover", {
  model: "small",
  intensity: 28,
  focal: 50,
  antiSmear: 10,
  mouseSmoothing: 85,
  invert: false,
  lighting: true,
  lightStrength: 60,
  preloadNext: true,
  breakout: true,
  autoTilt: true,
  autoTiltAmount: 70,
  autoTiltRev: 4,
});

// Older builds could store a React element here from the select's onChange
if (settings.model !== "small" && settings.model !== "base") settings.model = "small";
if (typeof settings.autoTilt !== "boolean") settings.autoTilt = true;
if (!Number.isFinite(settings.autoTiltAmount)) settings.autoTiltAmount = 70;
// Earlier builds swayed at 35 (1.0.18, 1.0.19), 50 (1.0.20) and 100 (1.0.22 to 1.0.24) by default: those left at it get the new one, once
if (settings.autoTiltRev !== 4) {
  if ([35, 50, 100].includes(settings.autoTiltAmount)) settings.autoTiltAmount = 70;
  settings.autoTiltRev = 4;
}

export const Settings = () => {
  // Read from window.luna rather than imported, for the same reason as @luna/lib in index.ts
  const { LunaButtonSetting, LunaNumberSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting } = window.luna.ui!;
  const [model, setModel] = React.useState(settings.model);
  const [invert, setInvert] = React.useState(settings.invert);
  const [lighting, setLighting] = React.useState(settings.lighting);
  const [preloadNext, setPreloadNext] = React.useState(settings.preloadNext);
  const [breakout, setBreakout] = React.useState(settings.breakout);
  const [autoTilt, setAutoTilt] = React.useState(settings.autoTilt);
  const [clearingDepth, setClearingDepth] = React.useState(false);
  const [clearingModel, setClearingModel] = React.useState(false);
  const [stats, setStats] = React.useState<{ count: number; bytes: number } | null>(null);

  const refreshStats = () => getDepthCacheStats().then(setStats).catch(() => setStats(null));
  React.useEffect(() => {
    refreshStats();
  }, []);

  const updateSetting = <K extends keyof PluginSettings>(key: K, val: PluginSettings[K]) => {
    settings[key] = val;
    window.dispatchEvent(new CustomEvent("luna:3dcover:updated"));
  };

  return (
    <LunaSettings>
      <LunaSelectSetting
        title="AI Depth Model"
        desc="Small is fast (~27MB one-time download). Base is higher quality but heavier (~100MB)."
        value={model}
        onChange={(e: any) => {
          // MUI's second onChange arg is the selected child element, not the value
          const selected = e.target.value as DepthModel;
          setModel(selected);
          updateSetting("model", selected);
        }}
      >
        <LunaSelectItem value="small">Depth-Anything-V2-Small (Fast)</LunaSelectItem>
        <LunaSelectItem value="base">Depth-Anything-V2-Base (Ultra Quality)</LunaSelectItem>
      </LunaSelectSetting>

      <LunaNumberSetting
        title="Depth Shift"
        desc="How far the layers move, in px on a 500px cover"
        min={5}
        max={80}
        value={settings.intensity}
        onNumber={(num: number) => updateSetting("intensity", num)}
      />

      <LunaNumberSetting
        title="Focal Plane"
        desc="Depth that stays still (0 = far, 100 = near)"
        min={0}
        max={100}
        value={settings.focal}
        onNumber={(num: number) => updateSetting("focal", num)}
      />

      <LunaNumberSetting
        title="Edge Anti-Smear"
        desc="Depth-edge threshold ×100. Lower fills more of the gaps behind foreground edges with background"
        min={2}
        max={30}
        value={settings.antiSmear}
        onNumber={(num: number) => updateSetting("antiSmear", num)}
      />

      <LunaSwitchSetting
        title="Break Out Of Frame"
        desc="Let subjects cross the cover's border as it tilts, instead of being cut off at it"
        checked={breakout}
        value={breakout}
        onChange={(e: any, checked?: boolean) => {
          const val = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !breakout);
          setBreakout(val);
          updateSetting("breakout", val);
        }}
      />

      <LunaSwitchSetting
        title="Auto Tilt"
        desc="The cover sways slowly on its own while the mouse isn't on it, so the depth can always be seen. Turn off to save processor and graphics work"
        checked={autoTilt}
        value={autoTilt}
        onChange={(e: any, checked?: boolean) => {
          const val = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !autoTilt);
          setAutoTilt(val);
          updateSetting("autoTilt", val);
        }}
      />

      {autoTilt && (
        <LunaNumberSetting
          title="Auto Tilt Amount"
          desc="How far the cover sways on its own, as a share of a full tilt"
          min={5}
          max={100}
          value={settings.autoTiltAmount}
          onNumber={(num: number) => updateSetting("autoTiltAmount", num)}
        />
      )}

      <LunaSwitchSetting
        title="AI Lighting"
        desc="Light, reflections and shadows that move with the tilt, from the AI depth map's surface shape"
        checked={lighting}
        value={lighting}
        onChange={(e: any, checked?: boolean) => {
          const val = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !lighting);
          setLighting(val);
          updateSetting("lighting", val);
        }}
      />

      {lighting && (
        <LunaNumberSetting
          title="Lighting Strength"
          desc="How strong the lighting, reflections and shadows are"
          min={0}
          max={100}
          value={settings.lightStrength}
          onNumber={(num: number) => updateSetting("lightStrength", num)}
        />
      )}

      <LunaSwitchSetting
        title="Preload Next Cover"
        desc="Prepare the next song's cover before it plays: near the end of the current song, or as soon as you hover the next button"
        checked={preloadNext}
        value={preloadNext}
        onChange={(e: any, checked?: boolean) => {
          const val = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !preloadNext);
          setPreloadNext(val);
          updateSetting("preloadNext", val);
        }}
      />

      <LunaNumberSetting
        title="Fallback Mouse Smoothing"
        desc="Normally the parallax follows TIDAL's cover tilt. Without a tilt it follows the mouse with this easing (0 = instant)"
        min={0}
        max={95}
        value={settings.mouseSmoothing}
        onNumber={(num: number) => updateSetting("mouseSmoothing", num)}
      />


      <LunaSwitchSetting
        title="Invert Perspective Direction"
        desc="Flip which way the foreground moves relative to the mouse"
        checked={invert}
        value={invert}
        onChange={(e: any, checked?: boolean) => {
          const val = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !invert);
          setInvert(val);
          updateSetting("invert", val);
        }}
      />

      <LunaButtonSetting
        title="Clear Depth Cache"
        desc={`Generated covers are saved so they never need regenerating${stats ? ` (${stats.count} saved, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB)` : ""}`}
        loading={clearingDepth}
        onClick={async () => {
          setClearingDepth(true);
          await clearDepthCache().catch(() => {});
          await refreshStats();
          setClearingDepth(false);
        }}
      >
        Clear
      </LunaButtonSetting>

      <LunaButtonSetting
        title="Clear Downloaded Model"
        desc="Delete the downloaded AI model and runtime (re-downloaded next time a cover needs generating)"
        loading={clearingModel}
        onClick={async () => {
          setClearingModel(true);
          await clearModelCache().catch(() => {});
          setClearingModel(false);
        }}
      >
        Clear
      </LunaButtonSetting>
    </LunaSettings>
  );
};
