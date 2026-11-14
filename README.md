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
- **Voice:** seven voices with their own manner of speaking (Bella, bright and upbeat, is the one it starts with). By default the lines are read online, by the voices of Microsoft Edge's read aloud: nothing runs on your PC for it (so a game using the processor doesn't leave the DJ without a voice) and a line is usually back within a few seconds. The text of each line (song and artist names, what it says about your listening) is sent to Microsoft for that; the service is Edge's own and not an official offering, so it can stop working, and whenever it can't be had, for whatever reason, the local voice reads instead, for that line and the next minute or more. The local voice is a neural model that runs on your machine (Kokoro, ~330 MB, downloaded the first time it is needed); set Voice engine to On this PC to use only that one and send nothing anywhere. Its lines take a little longer to make than they last (several times longer while a game has the processor), so they're prepared ahead, and one whose moment has passed by the time its turn comes isn't made at all. Every line is kept on disk once made. Optionally an OpenAI key gives OpenAI's voices instead (only the text of each line is sent). Commentary can introduce every song like a radio presenter, every set, only say hello and goodbye ("less chatter"), or be off. The music is never cut off for a line: it is turned down under the voice and comes back after it, and when you skip to a song that gets an introduction, the song you are leaving stays on, low under the words, until the next one arrives. When it introduces a song it has something to say about it, from what it actually knows: the day it came out and how old it is (and its birthday, when that is near), the album, when you liked it, how often you have played it and when last, a month it was among your most played, how long and how fast it is, how far it is from the song before. It also looks back at the song that just played ("Six minutes, and I'd do it again"), keeps an eye on the session (half an hour in, ten songs in, how long since last time), and has a word of its own now and then, in its voice's manner: it lives in your computer and knows it. Each voice has about a thousand wordings to draw on, the bright ones (Bella, Puck) half as many again: their own sign-offs and mashup chatter, a word of encouragement, a thought about music. It also knows the day of the week a song came out, whether you liked it the year it was released or years later, a play count that is a round number, and a handful of days of the year (New Year, Halloween, Friday the 13th, the first of the month). With TrueTaste installed it picks by what TrueTaste has measured (TrueTaste does the measuring, the DJ only reads it): every set leans away from songs you keep cutting short and artists you keep skipping and towards songs you finish and gave a thumbs up; new music is ranked by the model TrueTaste has trained on how its own picks went with you; a taste you are playing more of lately comes up more often; and there is a set of its own, your usual, made of what you actually play at this hour on this kind of day (ask for "my usual" to get it). It also talks about what TrueTaste has gathered: how much of your listening each of your tastes is and which way it is going, songs you gave a thumbs up, songs TrueTaste or your Daily Discovery found for you, songs you always finish and artists you tend to skip; without it, it goes by your likes alone. It remembers what it has said, across sessions, and reaches for the kind of fact and the wording it has gone longest without, so it doesn't say the same things every time. The voice is levelled like a radio voice and set against the song it speaks over, which eases down under it (over a second or so, never cut) far enough for every word to be heard, however loud the record, and eases back up after the line.
- **Jingle** (off unless you choose one in the settings): before the DJ speaks, its signature plays, like a radio station's: two seconds, in one of five styles (a swell into a boom, brass stabs, a guitar power chord, a tom fill, a synth bass run), made on the spot from the song it comes over, so it is in tune with the music it interrupts and changes with it: its key note, its major or minor (played in the jingle's chord; left open where the key isn't clear enough to say), and its tuning (a track made from a sped-up sample can be a quarter tone off concert pitch, and the jingle then is too). The key is read off the notes that stand out in the track, each at its real pitch, so the kick drum and the bass don't decide it. Two lines close together share one.
- **Carries on through a crash:** when TIDAL's page dies or is reloaded (TIDAL brings it back by itself within seconds), the music doesn't stop. The mixer is a process of its own and plays on, with whatever transition was already scheduled; TIDAL's own player is kept stopped and silent meanwhile; and the DJ, loaded again in the page that comes back, picks its session up where it was: the song, the transition, the tracks that were queued, your volume. Tried by ending the page mid-song and mid-transition: the mixer's clock ran 42.76 s in 42.77 s of real time, and the DJ was back in six. (After a crash TIDAL 2.48 leaves its own controls dead until it is restarted; the Optimizer plugin repairs that.)
- **TIDAL keeps working as usual:** TIDAL's own player keeps playing the current track silently, so the player bar, queue, lyrics, scrobbling and play counts all work, and play/pause, seek, next/previous and the volume slider control the DJ. Playing something else ends the session; stopping the DJ hands the song back to TIDAL's player. While the full DJ is on, shuffle and repeat are switched off and greyed out (they would pull TIDAL's queue away from the mix); they come back as they were when it stops.
- The mixer, the voice and the vocal separator each run in a process of their own, not in TIDAL's page: TIDAL is a 32-bit app, and decoded audio in its page ran it out of memory.
- **What the mixer holds:** decoded audio is 20 MB a minute, and the mixer has the playing song, the next one and, for a mashup, a third, a tempo-shifted copy and the separated voices. The next song, which is decoded as soon as the one before it starts and then waits for minutes, is put aside meanwhile as the 16-bit numbers it was decoded from, half the size, and is audio again a tenth of a second after anything asks for it: bit for bit, checked sample by sample as it is put aside (anything that isn't exactly 16-bit audio stays as it is). And what a mashup or a lead-in has played is let go of when it has played, not when the song ends: the mixer used to keep both songs of the last mashup, whole, until the next one (150 MB and more).
- Sound goes to the system's default output device.
- Settings: voice, voice engine (online / on this PC), commentary, jingle, transitions (DJ mix / crossfades only / none), tracks per set, new music share, audio quality (Lossless / High), transitions only, cover art transitions, captions, Home card, explicit, cloud voice key, clear voice files. Data folder: `~/.cache/visiuun-dj` (includes a readable `log.txt`).

### 3D Cover (`@visiuun/3d-cover`)

Turns the now playing cover into a 2.5D parallax scene that moves with TIDAL's cover tilt when you hover it.

- Depth is generated **locally** with Depth-Anything-V2 (WebGPU when available, CPU otherwise). The model downloads once (~27MB for Small) and is kept on disk.
- The AI model runs in a background process of its own, outside TIDAL's window, and is closed eight seconds after its last cover. (It used to stay for five minutes, which is longer than a song: it never closed, and held about 250 MB all evening.) TIDAL is a 32-bit app with ~2-4GB of memory for its window, so running the model inside it eventually crashed TIDAL with "out of memory".
- Generation starts as soon as a track begins playing, if the now playing view (the only place the big cover is) is open and TIDAL's window can be seen; otherwise when it next is. Skipping drops the skipped track's queued work (a generation already running finishes and is saved). Hovering a cover that isn't ready yet generates it immediately.
- Preload Next Cover (on by default): the next track's cover is generated before it plays, near the end of the current track or as soon as you hover the next button.
- Every generated depth map is saved on disk (~7KB each), so a cover is only ever processed once.
- Rendering is a single WebGL shader that ray-marches the depth map, so foreground correctly covers background and the gaps behind edges are filled from the background.
- Break Out Of Frame (on by default): subjects standing in front of their background cross the cover's border as it tilts, instead of being cut off at it. Anything the artwork itself crops stays inside.
- AI Lighting (on by default): light, soft shadows, reflections and shine on glossy things like gold and chrome, lit from TIDAL's own moving cover glare and shaped by the AI depth map. At rest the cover is untouched.
- Settings: model (Small/Base), depth shift, focal plane, edge anti-smear, break out of frame, AI lighting and its strength, preload next cover, fallback mouse smoothing, invert direction, clear depth cache, clear downloaded model.

---

### Optimizer (`@visiuun/optimizer`)

Keeps TIDAL light, and keeps it going. Nothing is drawn while nobody can see it, and no more often than needed while somebody can; the memory TIDAL isn't using goes back to Windows; and TIDAL's page is watched from outside, cleaned before it fills up, and brought back, with the music, when it dies.

**While TIDAL is out of sight.** TIDAL keeps its window fully awake in the background, so minimised, or behind a game, TIDAL and every plugin go on drawing every frame of every animation, visualiser and 3D cover, and the whole window is put together and shown as often as the screen shows a frame. The Optimizer stops that and starts it again the moment the window shows.

- **Knows when the window is really out of sight:** minimised, hidden, or completely covered by another window (a full-screen game, say). A window on a second monitor that you can see is left alone.
- **While it is out of sight:** the page isn't rendered at all (the browser skips its contents and has everything where it was when the window is back: scrolling, lyrics, animations in time), animation frames are held (what was asked to be drawn is drawn once when the window is back), looping animations stand still, decoration that is a video (animated covers: muted, with no sound of their own) is paused, and the page says it is hidden, the way a background tab does, so TIDAL and plugins that ask can leave their own work undone. The DJ skips its cover art transitions and 3D Cover doesn't generate covers then.
- **What it never touches:** the music, timers, TIDAL's own player and anything with sound. Playback, scrobbling, the DJ's mixing and anything that keeps time carry on.
- Measured on a 180 Hz screen with TIDAL behind another window, music playing: without any of it, TIDAL used about one and a half processor cores. Holding frames and pausing animations (all that versions before 1.2 did) still left the page at 42% of a core and the graphics process at 55%: TIDAL's progress bar, an animation that runs as long as the song, kept the whole window being redrawn 180 times a second. With the page not rendered: the page at 5%, the graphics process at 1%, all of TIDAL together at 8%. (Versions before 1.2 reported processor figures as a share of all cores together, sixteen times too low on a sixteen-core machine; they are a share of one core now.)

**While TIDAL is in sight.** A fast screen (144, 180, 240 Hz) makes everything that moves redraw that often, and each redraw is the whole way through the page and the graphics card.

- **Frame limit (60 unless you set another):** scripts that draw (moving backgrounds, visualisers, lyrics) are given no more frames a second than the limit: every third frame of a 180 Hz screen. The frames in between are not asked of the browser at all.
- **Animations move in steps:** CSS animations, transitions and animations made in script move on the same beat instead of on every frame of the screen, and all at the same moment (six animations stepping sixty times a second each, every one at its own moment, still made the page redraw 170 times a second). TIDAL's progress bar and its knob, which move about two pixels a second, get two steps a pixel. Nothing else about an animation changes, and it is put back when the Optimizer is switched off. Left alone: one whose pace over its whole length was set in script, and one that follows scrolling.
- **What stays as fast as the screen:** scrolling, the pointer, video.
- Measured as if in sight on a 180 Hz screen, lyrics and a moving background on: all of TIDAL together between 265% and 292% of a processor core without the limit, between 148% and 158% with it. On a 60 Hz screen only the progress bar's steps make a difference.

**Memory.** TIDAL is a 32-bit program: its page stops for good ("Something went wrong") when it has filled up, somewhere around 2 GB, and with a lot of plugins and a long evening it gets there. TIDAL's own answer is to reload the page past 1500 MB, but only once nothing has played and nobody has touched the window for five minutes, which is never while you are listening.

- **Memory guard:** the page is looked at every 15 seconds, from outside it. At three quarters of the limit (1500 MB unless you set another) its garbage is collected, which the page puts off by itself for as long as it can: a page that stood at 1015 MB came back to 414 MB. Past the limit, if cleaning didn't help, the page is reloaded before it stops by itself: when it is out of sight or you have left it alone for two minutes, at once if it is about to go. What was playing comes back (see below).
- **Cleaning up:** the same cleaning is done when TIDAL has been out of sight for a minute, and from a button. TIDAL's cache on disk (covers, pages) is cleared when it passes a size you set (1 GB), with crash dumps older than a week; your login, settings and plugins are never touched.
- **Memory handed back to Windows (Windows only):** what a process holds and what it has in memory are two things. Most of what TIDAL's page holds lies in memory untouched, where it counts against TIDAL in the Task Manager and is not there for your game; Windows only takes it out when memory runs short. When TIDAL has been out of sight for a minute, and every ten minutes after, Windows is asked to take it out now, and each process takes back only what it really uses. Nothing is closed; what is needed again is back at once. Measured: the page from 391 MB in memory to 50, the graphics process from 60 to 5. Never asked of what makes the sound (TIDAL itself, the audio service, the DJ's mixer, any page that is playing). It is done by a PowerShell line, which Luna asks your permission for once ("start programs").
- **The settings page shows** what every one of TIDAL's processes holds, how much of that it has in memory, and how much of one processor core it uses (the page, the graphics process, the DJ's mixer and so on), and what the Optimizer has done and when.

**When the page dies, freezes or is reloaded.** TIDAL brings a page that died back by itself, in a new window, after about six seconds. What it doesn't bring back is the music, and in TIDAL 2.48 not even the controls.

- **The music comes back:** the song that was playing is put on again at the place it would have got to by now, at the volume you had: about four seconds after a reload, about nine after a crash. With the DJ plugin on (1.10 or later) it doesn't stop at all: its mixer plays through and the DJ picks its session up again.
- **No full-volume moment:** a page that has just started sets the volume all the way up and only then to where you have it. TIDAL's player is therefore stopped the moment the page goes (as TIDAL does before its own reloads), and the volume is put right before anything plays.
- **TIDAL's controls work again:** after a crash, TIDAL takes down the line between its player and the new page (the old window's cleanup takes the new window's line with it): the play button spins and nothing can be played or paused until TIDAL is restarted. The Optimizer puts the line back. That uses a module of TIDAL's own, which Luna asks your permission for once.
- **A frozen page is ended:** the page says it is alive every five seconds; one that has said nothing for half a minute is ended, and TIDAL brings a fresh one. Never while the developer tools are open.

**Scripts.** A button measures for ten seconds where the page's processor time goes: TIDAL, Luna and every plugin by name. And, only if you switch it on, timers that repeat more than four times a second run once a second while TIDAL is out of sight (off by default: a plugin that fades the volume with such a timer would do it in steps).

- **For plugin authors:** `document.hidden` and the `visibilitychange` event work as they do in a browser while the Optimizer is on; `window.lunaOptimizer` (`{ visible, onChange(cb) }`) and the `optimizer:visibility` window event are there as well.
- Every measure can be switched off on its own.

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
