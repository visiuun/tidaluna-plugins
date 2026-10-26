import { ReactiveStore } from "@luna/core";

export type PluginSettings = {
  enabled: boolean;
  size: number; // tracks per playlist
  refreshHour: number; // local hour the new playlist is made
  exploration: number; // 0 = mostly artists you know, 100 = mostly brand new artists
  allowExplicit: boolean;
  excludeAI: boolean;
  useLastfm: boolean;
  notify: boolean;
};

export const settings = await ReactiveStore.getPluginStorage<PluginSettings>("TrueTaste", {
  enabled: true,
  size: 30,
  refreshHour: 6,
  exploration: 45,
  allowExplicit: true,
  excludeAI: true,
  useLastfm: true,
  notify: true,
});
