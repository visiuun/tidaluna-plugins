import React from "react";
import { ReactiveStore } from "@luna/core";
import { LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";

export type QueueAction = "queue" | "playNext";

export type PluginSettings = {
  defaultAction: QueueAction;
  secondaryActionOnShift: boolean;
  secondaryActionOnRightClick: boolean;
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("QuickQueue", {
  defaultAction: "queue",
  secondaryActionOnShift: true,
  secondaryActionOnRightClick: true,
});

export const Settings = () => {
  const [defaultAction, setDefaultAction] = React.useState<QueueAction>(settings.defaultAction);
  const [secondaryActionOnShift, setSecondaryActionOnShift] = React.useState(settings.secondaryActionOnShift);
  const [secondaryActionOnRightClick, setSecondaryActionOnRightClick] = React.useState(settings.secondaryActionOnRightClick);

  return (
    <LunaSettings>
      <LunaSelectSetting
        title="Default Left-Click Action"
        desc="Action performed when clicking the quick queue button normally"
        value={defaultAction}
        onChange={(_, val) => {
          const selected = val as QueueAction;
          setDefaultAction((settings.defaultAction = selected));
          window.dispatchEvent(new CustomEvent("luna:quickqueue:updated"));
        }}
      >
        <LunaSelectItem value="queue">Add to Queue</LunaSelectItem>
        <LunaSelectItem value="playNext">Play Next</LunaSelectItem>
      </LunaSelectSetting>

      <LunaSwitchSetting
        title="Shift + Click Alternative"
        desc="Hold Shift while clicking to trigger the opposite action (e.g. Play Next if default is Add to Queue)"
        value={secondaryActionOnShift}
        onChange={(_, checked) => {
          setSecondaryActionOnShift((settings.secondaryActionOnShift = checked));
          window.dispatchEvent(new CustomEvent("luna:quickqueue:updated"));
        }}
      />

      <LunaSwitchSetting
        title="Right-Click Alternative"
        desc="Right-click the quick queue button to trigger the opposite action"
        value={secondaryActionOnRightClick}
        onChange={(_, checked) => {
          setSecondaryActionOnRightClick((settings.secondaryActionOnRightClick = checked));
          window.dispatchEvent(new CustomEvent("luna:quickqueue:updated"));
        }}
      />
    </LunaSettings>
  );
};
