// BEST VERSIONS
// TIDAL often has the same recording more than once: the single and the album, a remaster, a HiRes release of a
// CD-quality one (the same song by its ISRC). The DJ plays each song it picks in the best of these: the version
// RealMAX would put on, when that plugin is on (so its lists of versions to keep and never to use hold), otherwise
// the one Luna's MediaItem.max() finds. Only the songs it plays are looked up, never the ones it chose between.
//
// And a track TIDAL goes to that is another version of the one the DJ expects is the same song to it, not something
// else you put on: RealMAX swaps what TIDAL moves to for its best version (an entry of the queue made another track
// where it stands, or the best version put on right after it as the player gets to it).
import type { MediaItem } from "@luna/lib";
import { settings } from "./config";
import { warn } from "./log";

const lib = () => window.luna.lib!;

type MaxLookup = (item: MediaItem) => Promise<MediaItem | undefined>;
/** RealMAX's own lookup (its exports, while that plugin is on): the version it puts on, by its lists too */
const realMax = (): MaxLookup | undefined => {
  const lookup = window.luna.core?.modules?.["RealMAX"]?.getMaxItemQuiet;
  return typeof lookup === "function" ? lookup : undefined;
};
export const realMaxOn = () => realMax() !== undefined;

/**
 * Whether the DJ plays best versions. The full DJ does, with the setting on. Transitions only plays what TIDAL plays:
 * the best version only where RealMAX is on to put it on in TIDAL, which it does as TIDAL gets to the song.
 */
export const playsBest = (follow: boolean) => settings.bestVersions !== false && (!follow || realMaxOn());

// ------------------ THE SAME SONG ------------------
/** Ids known to be versions of one song: each to the group it is in (the group's first id) */
const groupOf = new Map<string, string>();
const groups = new Map<string, Set<string>>();
/** `a` and `b` are versions of the same song */
export const noteSame = (a: string, b: string) => {
  const ga = groupOf.get(a) ?? a;
  const gb = groupOf.get(b) ?? b;
  if (ga === gb) return;
  const into = groups.get(ga) ?? new Set([ga]);
  for (const id of groups.get(gb) ?? [gb]) {
    into.add(id);
    groupOf.set(id, ga);
  }
  groupOf.set(ga, ga);
  groups.set(ga, into);
  groups.delete(gb);
};
/** `id` and every other version of its song the DJ knows of */
export const versionsOf = (id: string): string[] => [...(groups.get(groupOf.get(id) ?? id) ?? [id])];

const isrcOf = (id: string): string | undefined => {
  try {
    const isrc = (lib().redux.store.getState() as any).content?.mediaItems?.[id]?.item?.isrc;
    return typeof isrc === "string" && isrc ? isrc : undefined;
  } catch {
    return undefined;
  }
};
/** The same track, or another version of the same song: noted as one, or the same ISRC in TIDAL's store */
export const sameTrack = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const ga = groupOf.get(a);
  if (ga !== undefined && ga === groupOf.get(b)) return true;
  const isrc = isrcOf(a);
  return isrc !== undefined && isrc === isrcOf(b);
};
/** Where `id` is in `ids` from `from` on: the track itself, or failing that another version of it. -1: neither */
export const indexOfTrack = (ids: readonly string[], id: string | undefined, from = 0) => {
  if (id === undefined) return -1;
  const at = ids.indexOf(id, from);
  if (at >= 0) return at;
  for (let i = Math.max(0, from); i < ids.length; i++) if (sameTrack(ids[i], id)) return i;
  return -1;
};

/**
 * Which of `of` `id` is another version of (undefined: none). What is known is answered at once. Otherwise, while
 * RealMAX is on (nothing else puts another version on in TIDAL), each is asked for the version RealMAX puts on for
 * it, which is usually known already (RealMAX looked it up to put `id` on), waited for at most `ms`.
 */
export const versionAmong = async (id: string, of: string[], ms: number): Promise<string | undefined> => {
  const known = of.find((o) => sameTrack(id, o));
  if (known !== undefined || !of.length) return known;
  const ask = async () => {
    const { MediaItem } = lib();
    // (in TIDAL's store from then on: its ISRC can be compared)
    await MediaItem.fromId(id);
    const byIsrc = of.find((o) => sameTrack(id, o));
    const viaRealMax = realMax();
    if (byIsrc !== undefined || !viaRealMax) return byIsrc;
    for (const o of of) {
      const item = await MediaItem.fromId(o);
      if (!item || item.contentType !== "track") continue;
      const best = await viaRealMax(item);
      if (best !== undefined && String(best.id) === id) {
        noteSame(o, id);
        return o;
      }
    }
    return undefined;
  };
  return Promise.race([ask().catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
};

// ------------------ LOOKING THEM UP ------------------
type Lookup = { at: number; job: Promise<string> };
const lookups = new Map<string, Lookup>();
/** (how long an answer holds: RealMAX's lists can change) */
const KEEP_MS = 10 * 60e3;

const lookUp = async (id: string): Promise<string> => {
  try {
    const item = await lib().MediaItem.fromId(id);
    if (!item || item.contentType !== "track") return id;
    const viaRealMax = realMax();
    const best = viaRealMax ? await viaRealMax(item) : await item.max();
    if (!best || String(best.id) === id || best.contentType !== "track") return id;
    // (one that can't be streamed here is no better)
    const flags = best.tidalItem as { streamReady?: boolean; allowStreaming?: boolean };
    if (flags.streamReady === false || flags.allowStreaming === false) return id;
    noteSame(id, String(best.id));
    return String(best.id);
  } catch (err) {
    warn(`Couldn't look for a better version of ${id}`, err);
    return id;
  }
};

/** The id to play for `id`: its best version, or `id` itself (nothing better, RealMAX keeps it, or the lookup failed) */
export const bestVersion = (id: string): Promise<string> => {
  const key = `${realMaxOn() ? "realmax" : "max"}:${id}`;
  const had = lookups.get(key);
  if (had && Date.now() - had.at < KEEP_MS) return had.job;
  const job = lookUp(id);
  lookups.set(key, { at: Date.now(), job });
  return job;
};
/** Starts looking up the best versions of these, all at once (Luna sees to it that MusicBrainz is asked one at a time) */
export const lookAhead = (ids: string[]) => {
  for (const id of ids) void bestVersion(id);
};
/** bestVersion, waited for at most `ms`: `id` itself if it isn't known by then (the lookup goes on, for next time) */
export const bestVersionWithin = (id: string, ms: number): Promise<string> =>
  Promise.race([bestVersion(id), new Promise<string>((r) => setTimeout(() => r(id), ms))]);
