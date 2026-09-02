import React from "react";
import { ReactiveStore } from "@luna/core";
import { LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";

export type QueueAction = "queue" | "playNext";

export type PluginSettings = {
  defaultAction: QueueAction;
  secondaryActionOnShift: boolean;
  secondaryActionOnRightClick: boolean;
};

const STORAGE_KEY = "QuickQueue_settings";

const defaultSettings: PluginSettings = {
  defaultAction: "queue",
  secondaryActionOnShift: true,
  secondaryActionOnRightClick: true,
};

function getPersistedSettings(): PluginSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...defaultSettings, ...JSON.parse(raw) };
    }
  } catch {}
  return defaultSettings;
}

const initialSettings = getPersistedSettings();

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("QuickQueue", initialSettings);

if (initialSettings) {
  Object.assign(settings, initialSettings);
}

export const Settings = () => {
  const [defaultAction, setDefaultAction] = React.useState<QueueAction>(settings.defaultAction);
  const [secondaryActionOnShift, setSecondaryActionOnShift] = React.useState(settings.secondaryActionOnShift);
  const [secondaryActionOnRightClick, setSecondaryActionOnRightClick] = React.useState(settings.secondaryActionOnRightClick);

  const updateSetting = <K extends keyof PluginSettings>(key: K, val: PluginSettings[K]) => {
    settings[key] = val;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {}
    window.dispatchEvent(new CustomEvent("luna:quickqueue:updated"));
  };

  return (
    <LunaSettings>
      <LunaSelectSetting
        title="Default Left-Click Action"
        desc="Action performed when clicking the quick queue button normally"
        value={defaultAction}
        selected={defaultAction}
        onChange={(e: any, val?: any) => {
          const selected = (val ?? e?.target?.value ?? e) as QueueAction;
          setDefaultAction(selected);
          updateSetting("defaultAction", selected);
        }}
      >
        <LunaSelectItem value="queue">Add to Queue</LunaSelectItem>
        <LunaSelectItem value="playNext">Play Next</LunaSelectItem>
      </LunaSelectSetting>

      <LunaSwitchSetting
        title="Shift + Click Alternative"
        desc="Hold Shift while clicking to trigger the opposite action (e.g. Play Next if default is Add to Queue)"
        checked={secondaryActionOnShift}
        value={secondaryActionOnShift}
        onChange={(e: any, checked?: boolean) => {
          const val = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !secondaryActionOnShift);
          setSecondaryActionOnShift(val);
          updateSetting("secondaryActionOnShift", val);
        }}
      />

      <LunaSwitchSetting
        title="Right-Click Alternative"
        desc="Right-click the quick queue button to trigger the opposite action"
        checked={secondaryActionOnRightClick}
        value={secondaryActionOnRightClick}
        onChange={(e: any, checked?: boolean) => {
          const val = typeof checked === "boolean" ? checked : (e?.target?.checked ?? !secondaryActionOnRightClick);
          setSecondaryActionOnRightClick(val);
          updateSetting("secondaryActionOnRightClick", val);
        }}
      />
    </LunaSettings>
  );
};