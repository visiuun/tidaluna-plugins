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
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("TidalGenres", {
  showBackground: true,
  showBorder: false,
  matchQualityColor: false,
  position: "right",
  showMultiple: true,
});

export const Settings = () => {
  const [showBackground, setShowBackground] = React.useState(settings.showBackground);
  const [showBorder, setShowBorder] = React.useState(settings.showBorder);
  const [matchQualityColor, setMatchQualityColor] = React.useState(settings.matchQualityColor);
  const [position, setPosition] = React.useState(settings.position);
  const [showMultiple, setShowMultiple] = React.useState(settings.showMultiple);

  return (
    <LunaSettings>
      <LunaSelectSetting
        title="Badge Position"
        desc="Where to display the genre badges inside the player bar"
        value={position}
        onChange={(e: any) => {
          const val = e.target.value as GenrePosition;
          setPosition((settings.position = val));
          window.dispatchEvent(new CustomEvent("luna:genres:updated"));
        }}
      >
        <LunaSelectItem value="right">To the Right (Next to Favorite)</LunaSelectItem>
        <LunaSelectItem value="under">Below Artist</LunaSelectItem>
        <LunaSelectItem value="over">Above Track Title</LunaSelectItem>
      </LunaSelectSetting>

      <LunaSwitchSetting
        title="Background Pill"
        desc="Display genre tags inside a dark pill badge"
        value={showBackground}
        onChange={(_, checked) => {
          setShowBackground((settings.showBackground = checked));
          window.dispatchEvent(new CustomEvent("luna:genres:updated"));
        }}
      />

      <LunaSwitchSetting
        title="Show Border"
        desc="Add a subtle border outline around the genre badges"
        value={showBorder}
        onChange={(_, checked) => {
          setShowBorder((settings.showBorder = checked));
          window.dispatchEvent(new CustomEvent("luna:genres:updated"));
        }}
      />

      <LunaSwitchSetting
        title="Quality Matching Background"
        desc="Color-code the badge to match track quality"
        value={matchQualityColor}
        onChange={(_, checked) => {
          setMatchQualityColor((settings.matchQualityColor = checked));
          window.dispatchEvent(new CustomEvent("luna:genres:updated"));
        }}
      />

      <LunaSwitchSetting
        title="Show Multiple Genres"
        desc="Display up to 3-4 genres when available instead of only the primary one"
        value={showMultiple}
        onChange={(_, checked) => {
          setShowMultiple((settings.showMultiple = checked));
          window.dispatchEvent(new CustomEvent("luna:genres:updated"));
        }}
      />
    </LunaSettings>
  );
};