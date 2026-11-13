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
4. Press Enter to load **Vis's Luna Plugins**, then click **Install** on the plugins you want (e.g. `@visiuun/dj`, `@visiuun/true-taste`, `@visiuun/3d-cover`, `@visiuun/tidal-genres`, `@visiuun/quick-queue`, `@visiuun/optimizer`).

---

## Plugins

### TrueTaste (`@visiuun/true-taste`)

**Your Daily Discovery** that actually knows you: a daily playlist of music that's new to you, built from what you actually listen to. TIDAL's own Daily Discovery is a fixed list computed on its servers that the app only displays, so this plugin builds its own.

- **Only new music:** everything you've liked or put in any playlist (yours or followed) is read in full before every run, and other releases of those songs (single vs album, remasters, same ISRC) are excluded too. If the library can't be read, it doesn't run.
- **Built from what you play, not what you saved:** your monthly "My Most Listened" history, recently played, and every play it tracks, scored on a continuous curve by how long you listened. Bailing in the first seconds is a strong "no", leaving after half a minute a mild one, and beyond that it counts more the more you hear. Years of old likes and playlists only count lightly (down to 10% once there's enough listening).
- **Follows your phases:** signals decay on three clocks (months, weeks, days). Each run measures how far your recent listening has moved from your long-term taste and shifts weight to the recent clocks accordingly. If you skip most of the day's picks or 👎 several, it rebuilds early instead of waiting for tomorrow.
- **New artists, not just new songs:** at the default setting at most ~4 of 15 picks may come from artists already in your library.
- **👍 / 👎 in the player bar:** the strongest training signal. 👎 also skips the song, and two 👎 on the same artist keeps them out.
- **Local AI taste space:** artists are described by their Last.fm tags plus TIDAL's genres and placed in a semantic space (MiniLM sentence embeddings of ~2,900 music tags, precomputed and bundled, so nothing heavy runs inside TIDAL). A separate "feel" profile (mood, tempo, major/minor) matches tracks that feel alike across genres. Your listening is clustered into separate tastes, named after real genres, and each gets a fair share of the playlist.
- **Many sources:** TIDAL's similar tracks, track radio and similar artists, Last.fm listener data, and TIDAL's own Daily Discovery and daily mixes, all re-ranked against your taste.
- **Gets better every day:** a small ranking model is trained on how you react to its picks.
- **Flows:** one track per artist, diversity-aware selection, ordered by sound, tempo and harmonic key (Camelot wheel). AI-generated tracks, karaoke/tribute versions and artists you always skip are left out. Sped-up/slowed, live and remix versions only appear if you listen to those.
- Runs in the background once a day (default 6:00, or the next time TIDAL opens) with paced requests, into an unlisted playlist called **Your Daily Discovery**.
- Settings: generate now, refresh hour, length, adventurousness, explicit, AI filter, Last.fm, reset learned taste, and **Export all / Import all** to back up or move everything TrueTaste has learned as one JSON file. Everything is stored locally in `~/.cache/visiuun-true-taste` (`C:\Users\<you>\.cache\visiuun-true-taste` on Windows), including a readable `log.txt`.

### DJ (`@visiuun/dj`)

A personal DJ for TIDAL: it picks the music, mixes each track into the next, and tells you what's coming up.

- **Start it on any song:** press the DJ button in the player bar (or the DJ card on Home). The DJ picks up the song that's playing exactly where it is and carries on from there, staying with that sound until you ask for something else. With nothing playing it opens with what you've had on repeat.
- **Press the button again to switch it up:** a different set, introduced by the DJ over the current track and mixed in on the next bar line, and it stays with that. The arrow next to the button opens requests.
- **Requests that understand you:** "brazilian funk", "some kawaii music", "something for a rainy Sunday morning", an artist, "make it more upbeat". Requests go to TIDAL's own AI playlist generator, which knows the catalogue; the DJ answers at once over the music, starts the new sound when TIDAL replies (15-30 s), and stays with it, asking for more when it runs low. For each request a temporary unlisted playlist is created for TIDAL to fill and deleted again straight away. "Throwbacks", "my favourites", "something new" and "more like this" come from your own listening instead.
- **Real mixing:** every track is analysed locally (tempo, beat grid, bars, intro and outro). Tracks with tempos within 8% get a beatmatched blend: the incoming track is brought to the same tempo, laid over the outgoing one on the beat, and the bass changes hands on a bar line. Up to 2% the tempo is moved the way a turntable does it (played slightly faster or slower, a third of a semitone at most), which leaves the sound untouched; beyond that the rest is made up by skipping or repeating a few milliseconds at a time in the gaps between hits. Tracks that can't be matched never play over each other: the outgoing one leaves over the beats before a bar line (filtered up and away, or braked like a record, never the same way twice in a row) and the next one lands on that line; tracks without a steady beat get a crossfade. New sets, "switch it up" and requests are mixed in the same way, with the DJ speaking over the transition. Sets are ordered by tempo and key so more transitions can be blends. A track playing on its own reaches the output sample for sample as it is in the file: every start lands exactly on a sample, the deck's filters are true bypasses at rest, its level is left alone unless TIDAL's own loudness normalisation is on, and the output limiter only acts above full scale, which takes two tracks together.
- **Mashups:** the Mashup button in the DJ panel plays the song that's on together with another one, which then carries on as the next track. Leave the box empty and the DJ finds the song (same vibe, same tempo, same key, and of those the one whose notes fit this one's bar by bar, measured on the audio), or type the song you want, which is moved in tempo and pitch as far as it takes. A mashup lasts as long as the two songs have room for: from the next phrase of the song that's on to where it runs out, up to 128 bars (about four minutes), sixteen at the least. For as long as it lasts the two songs trade places, eight bars at a time: one song's singer over the other's band, the bass changing hands with the band. Which way round each block goes is decided as it comes up, by who is singing there: a voice that sings goes over the other song's band, two that sing take turns of sixteen bars each, and where nobody sings one song's band plays on top of the other's, so there is something of both to hear from the first bar to the last. It ends on the other song, whole. Voices are taken out by a neural network that runs locally (UVR MDX-Net on ONNX Runtime, about 40 MB, downloaded once), a few seconds of sound at a time and at about the pace the music plays: the playing song's from the moment you ask, the other's once it is found, the rest while the mashup plays (a song that isn't singing needs no work, which makes it twice as fast). So it starts about half a minute after you ask, and the DJ talks you through the wait: that it is looking, what it found, and that it starts. Should the processor be taken by something else and the voices fall behind, the mashup ends early and cleanly instead of playing on with voices missing. The voice is set against the band it now sings over (one that sits low in its own song is brought up, by as much as 9 dB, the band under it eased down a little, and what is left of its own record's kick taken out of it), so it is heard; the cover splits between the two covers and the title shows both songs.
- **Transitions only:** a mode with no picks and no talking. Whatever you play in TIDAL (an album, a playlist, your queue) is mixed together, track into track, with the same beatmatched blends and cover art transitions. It never touches your queue, follows skips, seeks and anything you put on, and stays on across restarts. Switch it on in the DJ panel or in settings; the button then reads MIX, and pressing it starts the full DJ on top (stopping the DJ returns to transitions only).
- **The cover art mixes too:** while one track is taken into the next, the cover in the now playing view (and the small one in the player bar) turns into the next cover along with the sound. It starts when the incoming track does, sends a wave across the cover at the song change, and has arrived when the old track has gone. Blends take turns through five looks (liquid, slices, swirl, mosaic, wave); a drop makes the old cover repeat outwards before the new one lands. Can be turned off in settings. The DJ button turns while a mix is under way.
- **Sets:** more of the sound you're in (each named after what's in it: its sub-genre, its decade, that it's new to you), on repeat, recently liked, a month from your listening history, one of your genres, an artist spotlight, lost favourites, new music. Uses TrueTaste's taste data when that plugin is installed (read-only), otherwise your likes, recently played and listening history from TIDAL.
- **Voice:** seven voices with their own manner of speaking (Bella, bright and upbeat, is the one it starts with). By default the lines are read online, by the voices of Microsoft Edge's read aloud: nothing runs on your PC for it (so a game using the processor doesn't leave the DJ without a voice) and a line is usually back within a few seconds. The text of each line (song and artist names, what it says about your listening) is sent to Microsoft for that; the service is Edge's own and not an official offering, so it can stop working, and whenever it can't be had, for whatever reason, the local voice reads instead, for that line and the next minute or more. The local voice is a neural model that runs on your machine (Kokoro, ~330 MB, downloaded the first time it is needed); set Voice engine to On this PC to use only that one and send nothing anywhere. Its lines take a little longer to make than they last (several times longer while a game has the processor), so they're prepared ahead, and one whose moment has passed by the time its turn comes isn't made at all. Every line is kept on disk once made. Optionally an OpenAI key gives OpenAI's voices instead (only the text of each line is sent). Commentary can introduce every song like a radio presenter, every set, only say hello and goodbye ("less chatter"), or be off. When it introduces a song it has something to say about it, from what it actually knows: the day it came out and how old it is (and its birthday, when that is near), the album, when you liked it, how often you have played it and when last, a month it was among your most played, how long and how fast it is, how far it is from the song before. It also looks back at the song that just played ("Six minutes, and I'd do it again"), keeps an eye on the session (half an hour in, ten songs in, how long since last time), and has a word of its own now and then, in its voice's manner: it lives in your computer and knows it. With TrueTaste installed it picks by what TrueTaste has measured (TrueTaste does the measuring, the DJ only reads it): every set leans away from songs you keep cutting short and artists you keep skipping and towards songs you finish and gave a thumbs up; new music is ranked by the model TrueTaste has trained on how its own picks went with you; a taste you are playing more of lately comes up more often; and there is a set of its own, your usual, made of what you actually play at this hour on this kind of day (ask for "my usual" to get it). It also talks about what TrueTaste has gathered: how much of your listening each of your tastes is and which way it is going, songs you gave a thumbs up, songs TrueTaste or your Daily Discovery found for you, songs you always finish and artists you tend to skip; without it, it goes by your likes alone. It remembers what it has said, across sessions, and reaches for the kind of fact and the wording it has gone longest without, so it doesn't say the same things every time. The voice is levelled like a radio voice and set against the song it speaks over, which eases down under it (over a second or so, never cut) far enough for every word to be heard, however loud the record, and eases back up after the line.
- **Jingle:** before the DJ speaks, its signature plays, like a radio station's: two seconds, in one of five styles (a swell into a boom, brass stabs, a guitar power chord, a tom fill, a synth bass run), made on the spot in the key of the song it comes over, so it is in tune with the music it interrupts. Two lines close together share one. Can be switched off.
- **TIDAL keeps working as usual:** TIDAL's own player keeps playing the current track silently, so the player bar, queue, lyrics, scrobbling and play counts all work, and play/pause, seek, next/previous and the volume slider control the DJ. Playing something else ends the session; stopping the DJ hands the song back to TIDAL's player. While the full DJ is on, shuffle and repeat are switched off and greyed out (they would pull TIDAL's queue away from the mix); they come back as they were when it stops.
- The mixer, the voice and the vocal separator each run in a process of their own, not in TIDAL's page: TIDAL is a 32-bit app, and decoded audio in its page ran it out of memory.
- Sound goes to the system's default output device.
- Settings: voice, voice engine (online / on this PC), commentary, jingle, transitions (DJ mix / crossfades only / none), tracks per set, new music share, audio quality (Lossless / High), transitions only, cover art transitions, captions, Home card, explicit, cloud voice key, clear voice files. Data folder: `~/.cache/visiuun-dj` (includes a readable `log.txt`).

### 3D Cover (`@visiuun/3d-cover`)

Turns the now playing cover into a 2.5D parallax scene that moves with TIDAL's cover tilt when you hover it.

- Depth is generated **locally** with Depth-Anything-V2 (WebGPU when available, CPU otherwise). The model downloads once (~27MB for Small) and is kept on disk.
- The AI model runs in a background process of its own, outside TIDAL's window, and is closed when idle. TIDAL is a 32-bit app with ~2-4GB of memory for its window, so running the model inside it eventually crashed TIDAL with "out of memory".
- Generation starts as soon as a track begins playing. Skipping drops the skipped track's queued work (a generation already running finishes and is saved). Hovering a cover that isn't ready yet generates it immediately.
- Preload Next Cover (on by default): the next track's cover is generated before it plays, near the end of the current track or as soon as you hover the next button.
- Every generated depth map is saved on disk (~7KB each), so a cover is only ever processed once.
- Rendering is a single WebGL shader that ray-marches the depth map, so foreground correctly covers background and the gaps behind edges are filled from the background.
- Break Out Of Frame (on by default): subjects standing in front of their background cross the cover's border as it tilts, instead of being cut off at it. Anything the artwork itself crops stays inside.
- AI Lighting (on by default): light, soft shadows, reflections and shine on glossy things like gold and chrome, lit from TIDAL's own moving cover glare and shaped by the AI depth map. At rest the cover is untouched.
- Settings: model (Small/Base), depth shift, focal plane, edge anti-smear, break out of frame, AI lighting and its strength, preload next cover, fallback mouse smoothing, invert direction, clear depth cache, clear downloaded model.

---

### Optimizer (`@visiuun/optimizer`)

Nothing is animated or drawn while nobody can see it. TIDAL keeps its window fully awake in the background, so minimised, or behind a game, TIDAL and every plugin go on drawing every frame of every animation, visualiser and 3D cover. The Optimizer stops that, for TIDAL itself and for every plugin, and starts it again the moment the window shows.

- **Knows when the window is really out of sight:** minimised, hidden, or completely covered by another window (a full-screen game, say). A window on a second monitor that you can see is left alone.
- **While it is out of sight:** animation frames are held (what was asked to be drawn is drawn once when the window is back), looping animations stand still, videos without sound are paused, and the page says it is hidden, the way a background tab does, so TIDAL and plugins that ask can leave their own work undone. The DJ skips its cover art transitions and 3D Cover doesn't generate covers then.
- **What it never touches:** the music, timers, and videos with sound. Playback, scrobbling, the DJ's mixing and anything that keeps time carry on.
- **For plugin authors:** `document.hidden` and the `visibilitychange` event work as they do in a browser while the Optimizer is on; `window.lunaOptimizer` (`{ visible, onChange(cb) }`) and the `optimizer:visibility` window event are there as well.
- Measured with TIDAL behind another window and some ninety plugins loaded: the page went from about 7.5% of a processor core to 1.3%, and the graphics process from 8.2% to 2.8%.
- Settings: each of the four measures can be switched off on its own; the page shows how often and for how long things were paused.

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

Copyright (C) 2026 visiuun. Licensed under the [GNU Affero General Public License, version 3](LICENSE), with the attribution terms in [NOTICE](NOTICE).

In short:

- **You can** use the plugins for anything, read the code, change it, and share it.
- **You must** keep the credit: "visiuun" and a link to this repository stay in your README and in your plugin's description, and your version says it is modified.
- **You must** share alike: if you distribute a changed version, or build on this code, your source has to be public under the same license.
- **You can't** make it closed source, put it under another license, or pass it off as your own.

The summary is not the license: the [LICENSE](LICENSE) and [NOTICE](NOTICE) files are. Versions released before this change were under the MIT License and stay so. Bundled libraries and downloaded models keep their own licenses.
