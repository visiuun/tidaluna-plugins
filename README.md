# Vis's Luna Plugins

A collection of plugins for **[TidaLuna](https://github.com/Inrixia/TidaLuna)**.

---

## Installing into TIDAL

1. Open **TIDAL** with **TidaLuna** installed.
2. Navigate to **Luna Settings** > **Plugin Store**.
3. In the **Install from URL** field, paste:
   ```text
   https://github.com/visiuun/tidaluna-plugins/releases/download/latest/store.json
   ```
4. Press Enter to load **Vis's Luna Plugins**, then click **Install** on the plugins you want (e.g. `@visiuun/true-taste`, `@visiuun/3d-cover`, `@visiuun/tidal-genres`, `@visiuun/quick-queue`).

---

## Plugins

### TrueTaste (`@visiuun/true-taste`)

**Your Daily Discovery** that actually knows you: a daily playlist of music that's new to you, built from what you actually listen to. TIDAL's own Daily Discovery is a fixed list computed on its servers that the app only displays, so this plugin builds its own.

- **Only new music:** everything you've liked or put in any playlist (yours or followed) is read in full before every run, and other releases of those songs (single vs album, remasters, same ISRC) are excluded too. If the library can't be read, it doesn't run.
- **Built from what you play, not what you saved:** your monthly "My Most Listened" history, recently played, and every play it tracks, scored on a continuous curve by how long you listened. Bailing in the first seconds is a strong "no", leaving after half a minute a mild one, and beyond that it counts more the more you hear. Years of old likes and playlists only count lightly (down to 10% once there's enough listening).
- **Follows your phases:** signals decay on three clocks (months, weeks, days). Each run measures how far your recent listening has moved from your long-term taste and shifts weight to the recent clocks accordingly. If you skip most of the day's picks or 👎 several, it rebuilds early instead of waiting for tomorrow.
- **New artists, not just new songs:** at the default setting at most ~7 of 30 picks may come from artists already in your library.
- **👍 / 👎 in the player bar:** the strongest training signal. 👎 also skips the song, and two 👎 on the same artist keeps them out.
- **Local AI taste space:** artists are described by their Last.fm tags plus TIDAL's genres and placed in a semantic space (MiniLM sentence embeddings of ~2,900 music tags, precomputed and bundled, so nothing heavy runs inside TIDAL). A separate "feel" profile (mood, tempo, major/minor) matches tracks that feel alike across genres. Your listening is clustered into separate tastes, named after real genres, and each gets a fair share of the playlist.
- **Many sources:** TIDAL's similar tracks, track radio and similar artists, Last.fm listener data, and TIDAL's own Daily Discovery and daily mixes, all re-ranked against your taste.
- **Gets better every day:** a small ranking model is trained on how you react to its picks.
- **Flows:** one track per artist, diversity-aware selection, ordered by sound, tempo and harmonic key (Camelot wheel). AI-generated tracks, karaoke/tribute versions and artists you always skip are left out. Sped-up/slowed, live and remix versions only appear if you listen to those.
- Runs in the background once a day (default 6:00, or the next time TIDAL opens) with paced requests, into an unlisted playlist called **Your Daily Discovery**.
- Settings: generate now, refresh hour, length, adventurousness, explicit, AI filter, Last.fm, reset learned taste. Everything is stored locally in `~/.cache/visiuun-true-taste` (`C:\Users\<you>\.cache\visiuun-true-taste` on Windows), including a readable `log.txt`.

### 3D Cover (`@visiuun/3d-cover`)

Turns the now playing cover into a 2.5D parallax scene that moves with TIDAL's cover tilt when you hover it.

- Depth is generated **locally** with Depth-Anything-V2 (WebGPU when available, CPU otherwise). The model downloads once (~27MB for Small) and is kept on disk.
- Generation starts 1.5s after a track begins playing (skipped tracks are never processed), and the next track is prepared ahead of time. Hovering a cover that isn't ready yet generates it immediately.
- Every generated depth map is saved on disk (~7KB each), so a cover is only ever processed once.
- Rendering is a single WebGL shader that ray-marches the depth map, so foreground correctly covers background and the gaps behind edges are filled from the background.
- Settings: model (Small/Base), depth shift, focal plane, edge anti-smear, fallback mouse smoothing, invert direction, clear depth cache, clear downloaded model.

---

## Local Development

### Prerequisites

- Node.js (v20+ recommended)
- pnpm package manager

```sh
corepack enable
corepack prepare pnpm@latest --activate
```

### Setup and Build

1. Clone the repository:
   ```sh
   git clone https://github.com/visiuun/tidaluna-plugins.git
   cd tidaluna-plugins
   ```

2. Install dependencies:
   ```sh
   pnpm install
   ```

3. Start development mode with hot-reloading:
   ```sh
   pnpm run watch
   ```

4. Test changes live in TIDAL under **Luna Settings** > **Plugin Store** > **DEV**.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
