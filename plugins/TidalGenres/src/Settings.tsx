import React from "react";
import { ReactiveStore } from "@luna/core";
import { LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";

export type GenrePosition = "right" | "under" | "over";

export type PluginSettings = {
  showBackground: boolean;
  showBorder: boolean;
  matchQualityColor: boolean;
  position: GenrePosition;
  showMultiple: boolean;
  showInTracklist: boolean;
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("TidalGenres", {
  showBackground: true,
  showBorder: false,
  matchQualityColor: false,
  position: "right",
  showMultiple: true,
  showInTracklist: true,
});

export const Settings = () => {
  const [showBackground, setShowBackground] = React.useState(settings.showBackground);
  const [showBorder, setShowBorder] = React.useState(settings.showBorder);
  const [matchQualityColor, setMatchQualityColor] = React.useState(settings.matchQualityColor);
  const [position, setPosition] = React.useState(settings.position);
  const [showMultiple, setShowMultiple] = React.useState(settings.showMultiple);
  const [showInTracklist, setShowInTracklist] = React.useState(settings.showInTracklist);

  const updateSetting = <K extends keyof PluginSettings>(key: K, val: PluginSettings[K]) => {
    settings[key] = val;
    window.dispatchEvent(new CustomEvent("luna:genres:updated"));
  };

  return (
    <LunaSettings>
      <LunaSelectSetting
        title="Badge Position"
        desc="Where to display the genre badges inside the player bar"
        value={position}
        selected={position}
        onChange={(e: any) => {
          const val = (e?.target?.value ?? e) as GenrePosition;
          setPosition(val);
          updateSetting("position", val);
        }}
      >
        <LunaSelectItem value="right">To the Right (Next to Favorite)</LunaSelectItem>
        <LunaSelectItem value="under">Below Artist</LunaSelectItem>
        <LunaSelectItem value="over">Above Track Title</LunaSelectItem>
      </LunaSelectSetting>

      <LunaSwitchSetting
        title="Show in Tracklist"
        desc="Display genre tags next to track titles in playlists and albums"
        checked={showInTracklist}
        value={showInTracklist}
        onChange={(_, checked) => {
          const val = checked ?? !showInTracklist;
          setShowInTracklist(val);
          updateSetting("showInTracklist", val);
        }}
      />

      <LunaSwitchSetting
        title="Background Pill"
        desc="Display genre tags inside a dark pill badge"
        checked={showBackground}
        value={showBackground}
        onChange={(_, checked) => {
          const val = checked ?? !showBackground;
          setShowBackground(val);
          updateSetting("showBackground", val);
        }}
      />

      <LunaSwitchSetting
        title="Show Border"
        desc="Add a subtle border outline around the genre badges"
        checked={showBorder}
        value={showBorder}
        onChange={(_, checked) => {
          const val = checked ?? !showBorder;
          setShowBorder(val);
          updateSetting("showBorder", val);
        }}
      />

      <LunaSwitchSetting
        title="Quality Matching Background"
        desc="Color-code the badge to match track quality"
        checked={matchQualityColor}
        value={matchQualityColor}
        onChange={(_, checked) => {
          const val = checked ?? !matchQualityColor;
          setMatchQualityColor(val);
          updateSetting("matchQualityColor", val);
        }}
      />

      <LunaSwitchSetting
        title="Show Multiple Genres"
        desc="Display up to 3 genres when available instead of only the primary one"
        checked={showMultiple}
        value={showMultiple}
        onChange={(_, checked) => {
          const val = checked ?? !showMultiple;
          setShowMultiple(val);
          updateSetting("showMultiple", val);
        }}
      />
    </LunaSettings>
  );
};