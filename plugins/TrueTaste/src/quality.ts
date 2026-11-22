// Best quality versions of the picks. The same song is often on TIDAL several times (single, album, deluxe, remaster),
// not all of them in Max/HiRes. With RealMAX enabled its own lookup is used, so its "keep this version" and "never use"
// lists apply and the playlist gets the versions it would play; without it, Luna's MediaItem.max() (the same search).
import { modules, type LunaUnload } from "@luna/core";
import { MediaItem, safeTimeout } from "@luna/lib";
import { politely } from "./api";
import { unloads } from "./index.safe";

type MaxLookup = (mediaItem: MediaItem) => Promise<MediaItem | undefined>;

// RealMAX's exports are only there while it's enabled, so they're read for every lookup
const realMax = (): MaxLookup | undefined => {
  const lookup = modules["RealMAX"]?.getMaxItemQuiet;
  return typeof lookup === "function" ? lookup : undefined;
};

// A lookup that never answers must not hold up the playlist (the pick is kept)
const LOOKUP_TIMEOUT_MS = 30000;

/**
 * The best quality version of a track, `undefined` when there's none better (or it's to be kept). One at a time, in
 * the same paced queue as every other request. Throws if the lookup fails
 */
export const bestVersion = (id: string) =>
  politely(async () => {
    const lookup = realMax();
    const find = async () => {
      const item = await MediaItem.fromId(id, "track");
      if (item?.contentType !== "track") return undefined;
      const max = await (lookup ? lookup(item) : item.max());
      if (max?.contentType !== "track" || String(max.id) === id) return undefined;
      return String(max.id);
    };
    let stop: LunaUnload | undefined;
    const timedOut = new Promise<undefined>((res) => (stop = safeTimeout(unloads, () => res(undefined), LOOKUP_TIMEOUT_MS)));
    const found = await Promise.race([find(), timedOut]).finally(() => stop?.());
    return found === undefined ? undefined : { id: found, by: lookup ? "RealMAX" : "Luna" };
  });

export const bestVersionSource = () => (realMax() ? "RealMAX" : "Luna");
