export type Track = {
  id: string;
  title: string;
  version?: string;
  artists: { id: string; name: string }[];
  album?: { id: string; title: string; releaseDate?: string };
  duration: number; // seconds
  explicit: boolean;
  popularity?: number; // 0-1
  bpm?: number;
  key?: string;
  keyScale?: string;
  tones: string[];
  genres: string[];
  ai: boolean;
  isrc?: string;
  available: boolean;
  fetchedAt: number;
};

export type ArtistInfo = {
  name: string;
  tags?: { name: string; count: number }[];
  tagsAt?: number;
};

export type ListenKind = "complete" | "partial" | "skip";
export type ListenEvent = {
  id: string;
  t: number; // epoch ms the track started
  ms: number; // actually listened
  ratio: number; // listened / duration
  kind: ListenKind;
  dd?: 1; // played from Your Daily Discovery
};

export type ClusterSummary = { label: string; share: number; tracks: number; trend?: number };

export type Feedback = { v: 1 | -1; at: number; artists: string[] };

export type Recommendation = {
  at: number;
  x: number[]; // feature vector at recommendation time, so outcomes can train the ranker
  learned?: 1;
};

export type State = {
  version: 1;
  events: ListenEvent[];
  likes: Record<string, number>; // trackId → liked at
  unlikes: Record<string, number>;
  playlistTracks: Record<string, number>; // trackId → last update of the newest of your playlists it's in
  followedTracks: Record<string, 1>; // in playlists you follow: never recommended, but not taste seeds
  // "artist|title" keys and ISRCs of everything in your library, so other releases of a song you
  // already have (single vs album, remaster, deluxe...) are never "discovered" either
  libraryKeys: string[];
  libraryIsrcs: string[];
  libraryArtists: Record<string, number>; // artistId → songs of theirs in your library
  recentTracks: Record<string, number>; // TIDAL "recently played" (all devices) → estimated time
  recentArtists: Record<string, number>; // artists/albums you recently played → estimated time
  feedback: Record<string, Feedback>; // 👍/👎 from the player bar
  lastAdaptAt?: number; // last early refresh because your taste moved
  favArtists: string[];
  historyTracks: Record<string, number>; // from TIDAL's history mixes → seen at
  // "My Most Listened" per month/year/all time: dated blocks of real, play-count-ranked listening
  historyMonths: { id: string; type: string; at: number; tracks: string[] }[];
  historyRefs: { id: string; mixType: string; title: string; at?: number }[]; // "My Most Listened" mixes seen so far
  recommended: Record<string, Recommendation>;
  seedsUsed: Record<string, number>;
  weights?: number[];
  trainedExamples: number;
  playlistId?: string;
  librarySyncAt?: number;
  lastRun?: {
    at: number;
    day: string;
    tracks: number;
    clusters: ClusterSummary[];
    ms: number;
    candidates: number;
    requests: number;
    engine: string;
    drift?: number; // 0 = same as always, 1 = completely new phase
    listeningShare?: number; // how much of the taste came from listening vs your saved library
    newArtists?: number; // picks by artists not in your library
  };
};

export const emptyState = (): State => ({
  version: 1,
  events: [],
  likes: {},
  unlikes: {},
  playlistTracks: {},
  followedTracks: {},
  libraryKeys: [],
  libraryIsrcs: [],
  libraryArtists: {},
  recentTracks: {},
  recentArtists: {},
  feedback: {},
  favArtists: [],
  historyTracks: {},
  historyMonths: [],
  historyRefs: [],
  recommended: {},
  seedsUsed: {},
  trainedExamples: 0,
});
