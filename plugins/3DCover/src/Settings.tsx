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
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("3DCover", {
  model: "small",
  intensity: 28,
  focal: 50,
  antiSmear: 10,
  mouseSmoothing: 85,
  invert: false,
});

// Older builds could store a React element here from the select's onChange
if (settings.model !== "small" && settings.model !== "base") settings.model = "small";

export const Settings = () => {
  // Read from window.luna rather than imported, for the same reason as @luna/lib in index.ts
  const { LunaButtonSetting, LunaNumberSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting } = window.luna.ui!;
  const [model, setModel] = React.useState(settings.model);
  const [invert, setInvert] = React.useState(settings.invert);
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
