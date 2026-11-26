// The DJ's mixer. Runs in a hidden page with a process of its own, never inside TIDAL's page: TIDAL is a
// 32-bit app whose page can use about 2 GB, and decoded audio (75 MB a track) pushed it over the edge.
// Here the audio has its own memory, and all of it is handed back when the page is closed.
//
// Decks each have a bass EQ, a filter and a fader; there is a voice channel and a limiter on the way out.
// Everything is scheduled on the Web Audio clock, so transitions land on the exact sample.
// The host calls window.__mixer.call(method, args); every reply carries the clock so the host can mirror it.
(() => {
  "use strict";
  const SR = 44100;
  const BASS_CUT_DB = -28;
  // A deck's filter at rest is set to 0 Hz, where it is no filter at all: every sample passes as it is.
  // This is where a sweep starts from (ramps can't start at zero): far enough below the music to leave bass alone
  const HP_IDLE = 1;
  const curve = (fn, n = 96) => Float32Array.from({ length: n }, (_, i) => fn(i / (n - 1)));
  const FADE_IN = curve((x) => Math.sin((x * Math.PI) / 2));
  const FADE_OUT = curve((x) => Math.cos((x * Math.PI) / 2));

  let ctx, music, voice, voiceHp, voiceTrim, master, outMeter, voiceMeter;
  let volume = 1;
  const tracks = new Map(); // id → { buffer, gain, loud, duration } (see TRACKS AT REST: `buffer` brings the audio back if it was put aside)
  const stretches = new Map(); // key → { buffer, x0, speed, holdOut, spliceOut, spliceIn }
  const profiles = new Map(); // track id → its notes and drum hits in detail (see dsp.js), for mashups
  const stemSets = new Map(); // name → { id, pieces: index → { from, n, voc, inst } }: stretches of a track as its voice and the rest (for mashups)
  const feeds = []; // what a mashup that is under way plays of those, piece by piece as they arrive (see MASHUPS)
  const clips = new Map(); // key → AudioBuffer
  const decks = new Map(); // id → deck
  const voices = new Set();

  // ------------------ DSP WORKERS ------------------
  // Two of them, so that a track being analysed doesn't hold up another being measured for a mashup
  // (each job goes to the one with less to do)
  const workers = []; // { worker, busy } (null once workers have turned out not to work here)
  let noWorkers = false;
  let dsp;
  let dspSource = "";
  let nextJob = 0;
  const jobs = new Map();
  const startWorker = () => {
    const entry = { worker: new Worker(URL.createObjectURL(new Blob([dspSource], { type: "text/javascript" }))), busy: 0 };
    entry.worker.onmessage = (e) => {
      const j = jobs.get(e.data.id);
      if (!j) return;
      jobs.delete(e.data.id);
      entry.busy--;
      if (e.data.error) j.reject(new Error(e.data.error));
      else j.resolve(e.data.result);
    };
    entry.worker.onerror = () => {
      noWorkers = true;
      workers.length = 0;
      for (const j of jobs.values()) j.reject(new Error("DSP worker failed"));
      jobs.clear();
    };
    workers.push(entry);
    return entry;
  };
  const runDsp = (msg, direct) => {
    let entry;
    if (!noWorkers) {
      try {
        entry = workers.find((w) => !w.busy) || (workers.length < 2 ? startWorker() : workers.reduce((x, y) => (y.busy < x.busy ? y : x)));
      } catch {
        noWorkers = true;
      }
    }
    if (entry) {
      return new Promise((resolve, reject) => {
        const id = nextJob++;
        jobs.set(id, { resolve, reject });
        entry.busy++;
        entry.worker.postMessage({ ...msg, id });
      }).catch((err) => {
        if (!noWorkers) throw err;
        dsp = dsp || new Function(dspSource + "; return DSP;")();
        return direct(dsp);
      });
    }
    dsp = dsp || new Function(dspSource + "; return DSP;")();
    return Promise.resolve(direct(dsp));
  };

  // ------------------ LIMITER ------------------
  // Runs on the audio thread. The sound is delayed by the look-ahead; the gain is the smallest one any
  // sample in that window needs, smoothed over the same window, so it is already down when a peak
  // arrives and nothing is ever clipped. While no peak goes over, the gain is exactly 1.
  const LOOKAHEAD = 220 / 44100; // 5 ms
  const LIMITER_SOURCE = `
class Limiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    const L = (this.L = Math.max(8, Math.round(o.lookahead * sampleRate)));
    this.ceiling = o.ceiling;
    this.rel = 1 - Math.exp(-1 / (o.release * sampleRate));
    this.dl = new Float32Array(L);
    this.dr = new Float32Array(L);
    this.di = 0;
    this.cap = L + 2;
    this.qv = new Float32Array(this.cap);
    this.qn = new Float64Array(this.cap);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.n = 0;
    this.env = 1;
    this.box = new Float32Array(L).fill(1);
    this.bi = 0;
    this.sum = L;
    this.quiet = L;
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    const il = inp[0];
    const ir = inp[1] || inp[0];
    const ol = out[0];
    const or = out[1];
    const L = this.L;
    const cap = this.cap;
    const ceiling = this.ceiling;
    for (let i = 0; i < ol.length; i++) {
      const l = il ? il[i] : 0;
      const r = ir ? ir[i] : 0;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const need = peak > ceiling ? ceiling / peak : 1;
      // Smallest gain needed by any of the last L + 1 samples
      while (this.count > 0 && this.qv[(this.tail + cap - 1) % cap] >= need) {
        this.tail = (this.tail + cap - 1) % cap;
        this.count--;
      }
      this.qv[this.tail] = need;
      this.qn[this.tail] = this.n;
      this.tail = (this.tail + 1) % cap;
      this.count++;
      if (this.qn[this.head] < this.n - L) {
        this.head = (this.head + 1) % cap;
        this.count--;
      }
      const lowest = this.qv[this.head];
      this.n++;
      // Down at once, back up slowly
      let env = this.env + (1 - this.env) * this.rel;
      if (env > 0.99999) env = 1;
      if (lowest < env) env = lowest;
      this.env = env;
      // Smoothed over the look-ahead, so the move is a ramp that ends as the peak arrives
      this.sum += env - this.box[this.bi];
      this.box[this.bi] = env;
      this.bi = (this.bi + 1) % L;
      this.quiet = env === 1 ? this.quiet + 1 : 0;
      if (this.quiet >= L) this.sum = L;
      const g = this.sum / L;
      ol[i] = this.dl[this.di] * g;
      if (or) or[i] = this.dr[this.di] * g;
      this.dl[this.di] = l;
      this.dr[this.di] = r;
      this.di = (this.di + 1) % L;
    }
    return true;
  }
}
registerProcessor("dj-limiter", Limiter);
`;
  let limiterDelay = 0;

  // ------------------ SETUP ------------------
  const init = async (args) => {
    dspSource = args.dsp;
    if (ctx) return {};
    ctx = new AudioContext({ sampleRate: SR, latencyHint: "playback" });
    music = ctx.createGain();
    voice = ctx.createGain();
    voiceHp = ctx.createBiquadFilter();
    voiceHp.type = "highpass";
    voiceHp.frequency.value = 75;
    voiceMeter = ctx.createAnalyser();
    voiceMeter.fftSize = 512;
    // Two tracks overlapping can exceed full scale, so the way out goes through a limiter, set at full
    // scale itself: a track on its own can't exceed that, so every sample of it comes out as it went in
    // (delayed by the look-ahead, nothing else). It must do nothing at all to a track playing on its
    // own: the first one here (Web Audio's compressor, set just under full scale) was pulling every loud
    // hit of an ordinary track down by 2-4 dB, which is heard as the sound pumping. This one looks 5 ms
    // ahead and only moves when a peak would actually go over.
    let limiter;
    try {
      const url = URL.createObjectURL(new Blob([LIMITER_SOURCE], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      limiter = new AudioWorkletNode(ctx, "dj-limiter", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        processorOptions: { lookahead: LOOKAHEAD, ceiling: 1, release: 0.12 },
      });
      limiterDelay = LOOKAHEAD;
    } catch (err) {
      // No worklet: the built-in compressor, set so that it only acts above full scale
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = 0;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.12;
      limiterDelay = 0.006;
    }
    master = ctx.createGain();
    master.gain.value = 0;
    outMeter = ctx.createAnalyser();
    outMeter.fftSize = 2048;
    music.connect(limiter);
    // (the voice's own volume, set in the DJ's settings: after the meter's level is measured it is still the line as spoken)
    voiceTrim = ctx.createGain();
    voiceHp.connect(voiceTrim).connect(voice).connect(limiter);
    voice.connect(voiceMeter);
    limiter.connect(master).connect(ctx.destination);
    limiter.connect(outMeter);
    await ctx.resume();
    return {};
  };

  const rms = (an) => {
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    return Math.sqrt(s / buf.length);
  };

  // ------------------ TRACKS ------------------
  const monoHalf = (buffer) => {
    const n = Math.floor(buffer.length / 2);
    const out = new Float32Array(n);
    const chans = buffer.numberOfChannels;
    for (let c = 0; c < chans; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += ch[2 * i] + ch[2 * i + 1];
    }
    const k = 0.5 / chans;
    for (let i = 0; i < n; i++) out[i] *= k;
    return out;
  };

  const analyseBuffer = async (buffer, hintBpm) => {
    const mono = monoHalf(buffer);
    const sr = buffer.sampleRate / 2;
    const hint = { bpm: hintBpm };
    const r = await runDsp({ type: "analyze", mono, sr, hint }, (d) => d.analyze(mono, sr, hint));
    // Typed arrays don't survive the trip to the host as JSON
    return { ...r, beats: undefined, bars: Array.from(r.bars), barEnergy: Array.from(r.barEnergy), barBass: undefined };
  };
  /** Analyses a track that is already loaded (used when it had to start playing first) */
  const analyse = async ({ id, hintBpm }) => {
    const t = tracks.get(id);
    if (!t) throw new Error("track not loaded");
    return { analysis: await analyseBuffer(t.buffer, hintBpm) };
  };

  /**
   * How loud a record is where it is loud: the RMS (per channel) of its louder half, taken in blocks of
   * 0.4 s from every fourth sample. This is what the DJ's voice is set against (see VOICE).
   */
  const loudness = (buffer) => {
    const block = Math.round(buffer.sampleRate * 0.4);
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const powers = [];
    for (let i = 0; i + block <= buffer.length; i += block) {
      let s = 0;
      let n = 0;
      for (const ch of chans) {
        for (let j = i; j < i + block; j += 4) {
          s += ch[j] * ch[j];
          n++;
        }
      }
      powers.push(s / n);
    }
    if (!powers.length) return 0;
    powers.sort((a, b) => a - b);
    let s = 0;
    const half = powers.length >> 1;
    for (let i = half; i < powers.length; i++) s += powers[i];
    return Math.sqrt(s / (powers.length - half));
  };

  // ------------------ TRACKS AT REST ------------------
  // A decoded track is 20 MB a minute: four bytes for every sample, where the file had two. The song that
  // comes next is decoded as soon as the one before it starts (it is analysed, and the way into it worked
  // out), and then lies there untouched for minutes. A track nothing has asked for in a while, and that
  // isn't on a deck, is therefore put aside as the 16-bit numbers it was decoded from, half the size, and
  // made into samples again the moment anything asks for it (a tenth of a second for a long song).
  //
  // Bit for bit: each sample is written as its 16-bit number only if turning that number back gives
  // exactly the sample that was there (the same sum the browser's decoder does: a negative number over
  // 32768, a positive one times 1/32767). One sample that doesn't come back the same (24-bit audio, a
  // lossy file, anything that was worked on) and the track stays as it is, for good. What plays is what
  // would have played.
  const REST_AFTER = 20000;
  const POSITIVE = Math.fround(1 / 32767);
  const moment = () => new Promise((r) => setTimeout(r, 0));
  const track = (id, buffer, gain) => ({
    id,
    gain,
    loud: loudness(buffer),
    duration: buffer.duration,
    /** When it was last asked for */
    used: performance.now(),
    audio: buffer,
    /** Put aside: { channels: Int16Array[], rate } */
    rest: null,
    /** Not 16-bit audio: never put aside */
    asIs: false,
    packing: false,
    get buffer() {
      this.used = performance.now();
      if (!this.audio && this.rest) {
        const { channels, rate } = this.rest;
        const n = channels[0].length;
        const buffer = ctx.createBuffer(channels.length, n, rate);
        for (let c = 0; c < channels.length; c++) {
          const from = channels[c];
          const to = buffer.getChannelData(c);
          for (let i = 0; i < n; i++) {
            const v = from[i];
            to[i] = v < 0 ? v / 32768 : v * POSITIVE;
          }
        }
        this.audio = buffer;
        this.rest = null;
      }
      return this.audio;
    },
  });
  /** Nothing is using this track's audio, and nothing has asked for it in a while */
  const atRest = (t) => {
    if (performance.now() - t.used < REST_AFTER || feeds.length || arrangers.length) return false;
    for (const d of decks.values()) if (d.trackId === t.id) return false;
    for (const set of stemSets.values()) if (set.id === t.id) return false;
    return true;
  };
  /** Puts a track's audio aside as 16-bit numbers, a little at a time so that nothing else here waits for it */
  const putAside = async (t) => {
    const buffer = t.audio;
    if (!buffer || t.asIs || t.packing || !atRest(t)) return;
    t.packing = true;
    try {
      const n = buffer.length;
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const from = buffer.getChannelData(c);
        const to = new Int16Array(n);
        for (let i = 0; i < n; ) {
          const end = Math.min(n, i + 1000000);
          for (; i < end; i++) {
            const x = from[i];
            const v = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
            // (the 16-bit number has to give back exactly this sample, or the track isn't touched)
            if (!(v >= -32768 && v <= 32767) || Math.fround(v < 0 ? v / 32768 : v * POSITIVE) !== x) {
              t.asIs = true;
              return;
            }
            to[i] = v;
          }
          await moment();
          // (asked for meanwhile: it stays as it is)
          if (t.audio !== buffer || tracks.get(t.id) !== t || !atRest(t)) return;
        }
        channels.push(to);
      }
      t.rest = { channels, rate: buffer.sampleRate };
      t.audio = null;
    } finally {
      t.packing = false;
    }
  };
  let resting = 0;
  const restTracks = () => {
    for (const t of tracks.values()) if (t.audio && !t.asIs && !t.packing && atRest(t)) void putAside(t).catch(() => {});
  };
  /** Before an operation runs: the tracks it names have their audio back, so that nothing it then times waits for that */
  const wake = (method, args) => {
    if (method === "unload" || !args) return;
    for (const v of Object.values(args)) {
      if (typeof v !== "string") continue;
      const t = tracks.get(v);
      if (t) void t.buffer;
    }
  };

  /** Fetches (through the host, which decrypts), decodes and, unless already known, analyses a track */
  const load = async ({ id, url, gain, hintBpm, analyse }) => {
    const t0 = performance.now();
    const res = await fetch(url);
    if (!res.ok) {
      // (The host answers 502 with the reason as text: TIDAL's own status, a network error...)
      const why = await res.text().catch(() => "");
      throw new Error("Couldn't fetch the audio: " + (why || "HTTP " + res.status));
    }
    const bytes = await res.arrayBuffer();
    const t1 = performance.now();
    const buffer = await ctx.decodeAudioData(bytes);
    // (The level is the host's to say: 1 unless TIDAL's own loudness normalisation is on. Nothing is
    // taken off for headroom: the limiter sits at full scale, which a track on its own can't exceed.)
    const t2 = performance.now();
    let analysis;
    if (analyse) analysis = await analyseBuffer(buffer, hintBpm);
    tracks.set(id, track(id, buffer, gain));
    if (!resting) resting = setInterval(restTracks, 5000);
    return { duration: buffer.duration, analysis, ms: { fetch: Math.round(t1 - t0), decode: Math.round(t2 - t1), analyse: Math.round(performance.now() - t2) } };
  };

  const unload = ({ id }) => {
    tracks.delete(id);
    profiles.delete(id);
    for (const [name, set] of stemSets) if (set.id === id) stemSets.delete(name);
    for (const [key, st] of stretches) if (st.id === id) stretches.delete(key);
    return {};
  };

  /** Tempo-shifted lead-in for a blend (see dsp.js) */
  const stretch = async ({ key, id, x0, speed, holdOut, glideOut, pitch }) => {
    if (stretches.has(key)) return { cached: true };
    const t = tracks.get(id);
    if (!t) throw new Error("track not loaded");
    const buffer = t.buffer;
    const lead = 2048;
    const from = Math.max(0, Math.floor(x0) - lead);
    const need = Math.ceil(Math.max(speed, 1) * (holdOut + glideOut) + 8192 + 4096) + lead;
    if (from + need > buffer.length + 4096) throw new Error("not enough of the track left for that");
    const to = Math.min(buffer.length, from + need);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice(from, to));
    const local = x0 - from;
    const sr = buffer.sampleRate;
    const r = await runDsp({ type: "stretch", channels, sr, x0: local, speed, holdOut, glideOut, pitch }, (d) => d.stretch(channels, sr, local, speed, holdOut, glideOut, pitch));
    const out = ctx.createBuffer(r.out.length, r.spliceOut, sr);
    for (let c = 0; c < r.out.length; c++) out.copyToChannel(r.out[c].subarray(0, r.spliceOut), c);
    let peak = 0;
    for (let c = 0; c < r.out.length; c++) {
      const ch = r.out[c];
      for (let i = 0; i < r.spliceOut; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > peak) peak = v;
      }
    }
    stretches.set(key, { id, buffer: out, x0, speed, holdOut, spliceOut: r.spliceOut, spliceIn: r.spliceIn + from, peak });
    return { joins: r.joins, bassJoins: r.bassJoins };
  };
  const dropStretch = ({ key }) => (stretches.delete(key), {});

  const clip = ({ key, pcm, rate }) => {
    // 16-bit mono PCM, base64, already levelled by the host
    const bin = atob(pcm);
    const n = bin.length >> 1;
    const buffer = ctx.createBuffer(1, Math.max(1, n), rate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
    }
    clips.set(key, buffer);
    if (clips.size > 30) clips.delete(clips.keys().next().value);
    return { duration: buffer.duration };
  };

  // ------------------ DECKS ------------------
  const makeDeck = (id, trackId) => {
    const t = tracks.get(trackId);
    if (!t) throw new Error("track not loaded: " + trackId);
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 180;
    low.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 0;
    hp.Q.value = 0.7;
    const fader = ctx.createGain();
    const trim = ctx.createGain();
    trim.gain.value = t.gain;
    // (post: where a move's own filters go in, after the fader. At rest it passes the sound through as it is)
    const post = ctx.createGain();
    low.connect(hp).connect(fader).connect(post).connect(trim).connect(music);
    const deck = { id, trackId, buffer: t.buffer, low, hp, fader, post, trim, sources: [], map: [], stopAt: Infinity };
    decks.set(id, deck);
    return deck;
  };
  const getDeck = (id, trackId) => decks.get(id) || makeDeck(id, trackId);
  // A deck's sources were kept until the deck itself was closed, at the end of its song, and each holds
  // the audio it played: the tempo-shifted lead-in (some 15 MB), and after a mashup every separated piece
  // of the song that carries on (voice and band, for as long as the mashup lasted). One that has finished
  // is let go of at once.
  const keep = (deck, s) => {
    deck.sources.push(s);
    s.onended = () => {
      const i = deck.sources.indexOf(s);
      if (i >= 0) deck.sources.splice(i, 1);
      try {
        s.disconnect();
        s.buffer = null;
      } catch {}
    };
    return s;
  };
  const source = (deck, buffer) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(deck.low);
    return keep(deck, s);
  };
  // Every start lands exactly on a sample, in time and in the track. A source started between two
  // samples is not just late by a fraction of one: the browser then works every sample of it out from
  // its two neighbours, for as long as it plays, which takes the top off the sound (3 dB at 11 kHz and
  // more above, when it falls half-way). On a sample, what comes out is what is in the file.
  const onSample = (t) => Math.round(t * ctx.sampleRate) / ctx.sampleRate;
  const play = (deck, when, pos) => {
    when = onSample(when);
    pos = onSample(Math.max(0, pos));
    source(deck, deck.buffer).start(when, pos);
    deck.map = [{ t: when, pos, rate: 1 }];
  };
  /** `skip`: seconds of the tempo-shifted lead-in to leave out at the start (joining it a beat or more in) */
  const playStretched = (deck, when, st, skip = 0) => {
    const sr = deck.buffer.sampleRate;
    const first = Math.round(when * sr);
    const skipped = Math.round(skip * sr);
    when = first / sr;
    skip = skipped / sr;
    source(deck, st.buffer).start(when, skip);
    // (The untouched track takes over on the very next sample after the lead-in's last)
    const joinAt = (first + st.spliceOut - skipped) / sr;
    source(deck, deck.buffer).start(joinAt, st.spliceIn / sr);
    const hold = Math.max(0, st.holdOut / sr - skip);
    deck.map = [
      { t: when, pos: st.x0 / sr + st.speed * skip, rate: st.speed },
      { t: when + hold, pos: st.x0 / sr + st.speed * (hold + skip), rate: (st.speed + 1) / 2 },
      { t: joinAt, pos: st.spliceIn / sr, rate: 1 },
    ];
  };
  // A tempo-shifted lead-in peaks a little higher than the track itself (its waves are redrawn between
  // the original samples). Rather than have the limiter shave those peaks all the way through it, the
  // deck sits that much lower, and comes back up over twelve seconds once the untouched track has taken over.
  const settleTrim = (deck, st, when, skip = 0) => {
    const full = deck.trim.gain.value;
    const k = Math.max(0.7, Math.min(1, 1 / ((st.peak || 1) * full)));
    if (k >= 0.999) return;
    const joinAt = when + st.spliceOut / st.buffer.sampleRate - skip;
    deck.trim.gain.setValueAtTime(full * k, when);
    deck.trim.gain.setValueAtTime(full * k, joinAt);
    deck.trim.gain.linearRampToValueAtTime(full, joinAt + 12);
  };
  // One track's loudest hits were never mastered against another's: together they go over full scale
  // now and then. Rather than have the limiter working on those all the way through a transition, both
  // decks sit half a decibel lower while they share the mix (a whole one in a mashup, where one track's
  // kick and bass sit right under the other's top); the limiter takes care of what little is left.
  // Nothing steps: the outgoing one gets there
  // over the whole first half of the transition, while the incoming one is being added to it (taken
  // down in two seconds, it was heard as the volume dropping the moment a transition began); the
  // incoming one comes back up slowly once it is alone, to exactly where it belongs.
  const ROOM_BACK = 6;
  const makeRoom = (a, b, from, ease, until, room = 0.944, roomA = room) => {
    a.post.gain.setValueAtTime(1, from);
    a.post.gain.linearRampToValueAtTime(roomA, from + ease);
    b.post.gain.setValueAtTime(room, from);
    b.post.gain.setValueAtTime(room, until);
    b.post.gain.linearRampToValueAtTime(1, until + ROOM_BACK);
  };
  /**
   * A deck that is alone again from T comes back up to where it belongs, slowly, from `at` (what it is at T: see
   * makeRoom). (Held at T and set there: a ramp only starts where the event before it is, and with none at T that was
   * seconds before, the level moving from the moment this was asked.)
   */
  const roomBack = (deck, T, at) => {
    const g = deck.post.gain;
    try {
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(T);
      else g.cancelScheduledValues(T);
      g.setValueAtTime(at, T);
      g.linearRampToValueAtTime(1, T + ROOM_BACK);
    } catch {}
  };
  // The bass changes hands in one move (see the blend, below), and whichever track carries the low end
  // carries it at full level. The faders are for everything over the bass; left to them, the outgoing bass
  // was down 3 dB by the middle of a blend and the incoming one arrived 3 dB down (measured: the level fell
  // from the first second of every blend on, which is heard as the volume dropping as soon as a transition
  // starts). So the bass EQ gives each track's low end back exactly what its fader takes: the outgoing
  // one's up to the handover, the incoming one's from it on, back to nothing by the time it is alone.
  //   aCurve: the outgoing fader's curve over the window [t0, t0 + D]; the incoming one's is FADE_IN
  const handBass = (a, b, aCurve, t0, D, swapFrom, swapTo, end) => {
    const lift = (level) => Math.min(12, -20 * Math.log10(Math.max(level, 0.05)));
    const along = (curve, x) => {
      const f = Math.max(0, Math.min(1, x)) * (curve.length - 1);
      const i = Math.floor(f);
      return curve[i] + (curve[Math.min(curve.length - 1, i + 1)] - curve[i]) * (f - i);
    };
    const STEPS = 48;
    const xFrom = (swapFrom - t0) / D;
    const xTo = (swapTo - t0) / D;
    if (swapFrom - t0 > 0.3) {
      a.low.gain.setValueCurveAtTime(
        Float32Array.from({ length: STEPS }, (_, i) => lift(along(aCurve, (xFrom * i) / (STEPS - 1)))),
        t0,
        swapFrom - t0 - 0.004,
      );
    }
    a.low.gain.setValueAtTime(lift(along(aCurve, xFrom)), swapFrom);
    a.low.gain.linearRampToValueAtTime(BASS_CUT_DB, swapTo);
    b.low.gain.setValueAtTime(BASS_CUT_DB, t0);
    b.low.gain.setValueAtTime(BASS_CUT_DB, swapFrom);
    b.low.gain.linearRampToValueAtTime(lift(along(FADE_IN, xTo)), swapTo);
    if (end - swapTo > 0.3) {
      b.low.gain.setValueCurveAtTime(
        Float32Array.from({ length: STEPS }, (_, i) => lift(along(FADE_IN, xTo + ((1 - xTo) * i) / (STEPS - 1)))),
        swapTo + 0.002,
        end - swapTo - 0.004,
      );
    }
    // (...and exactly nothing from then on: the incoming track's bass is its own again)
    b.low.gain.setValueAtTime(0, end);
  };
  const positionAt = (deck, t) => {
    if (!deck.map.length) return 0;
    let p = deck.map[0];
    for (const m of deck.map) if (m.t <= t) p = m;
    return p.pos + Math.max(0, t - p.t) * p.rate;
  };
  const stopSources = (deck, when) => {
    for (const s of deck.sources) {
      try {
        s.stop(when + 0.03);
      } catch {}
    }
    deck.stopAt = Math.min(deck.stopAt, when);
  };
  const fadeOutAt = (deck, when, fade) => {
    deck.fader.gain.setValueAtTime(1, when);
    deck.fader.gain.linearRampToValueAtTime(0, when + fade);
    stopSources(deck, when + fade);
  };
  /**
   * Cuts a deck off, over `fade`. Both its fader and its way out go down: a voice taken out for a mashup
   * joins the deck after the fader (see the transition). And a mashup the deck is part of is over: none
   * of its blocks to come is decided any more, which would move the faders of both its songs again.
   */
  const killDeck = (deck, fade) => {
    const now = ctx.currentTime;
    for (const g of [deck.fader.gain, deck.post.gain]) {
      try {
        const v = g.value;
        g.cancelScheduledValues(now);
        g.setValueAtTime(v, now);
        g.linearRampToValueAtTime(0, now + fade);
      } catch {}
    }
    for (let k = arrangers.length - 1; k >= 0; k--) if (arrangers[k].deck === deck || arrangers[k].other === deck) arrangers.splice(k, 1);
    stopSources(deck, now + fade);
  };
  const disposeDeck = (deck) => {
    for (const s of deck.sources) {
      try {
        s.stop();
      } catch {}
      s.disconnect();
      s.buffer = null;
    }
    deck.sources = [];
    deck.trim.disconnect();
    deck.buffer = null;
    decks.delete(deck.id);
  };
  const soon = (t, lead = 0.06) => Math.max(t, ctx.currentTime + lead);

  // ------------------ BEAT LOCK ------------------
  // The grids from the analysis put two tracks within a few milliseconds of each other. This closes the
  // rest: it compares where the drums actually hit in both tracks across the overlap and returns how
  // much later (seconds) the incoming track's hits are, so its start can be moved by exactly that.
  const bandEnvelope = (buffer, fromSec, seconds, loHz, hiHz) => {
    dsp = dsp || new Function(dspSource + "; return DSP;")();
    const N = 512;
    const H = 64;
    const sr = buffer.sampleRate;
    const i0 = Math.max(0, Math.round(fromSec * sr));
    const n = Math.max(0, Math.min(Math.floor((seconds * sr) / 2), Math.floor((buffer.length - i0) / 2)));
    const mono = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i0 + 2 * i] + ch[i0 + 2 * i + 1];
    }
    const fft = dsp.makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const frames = Math.max(0, Math.floor((n - N) / H));
    const env = new Float32Array(frames);
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    let prev = new Float32Array(N / 2);
    let cur = new Float32Array(N / 2);
    const binHz = sr / 2 / N;
    const k0 = Math.max(1, Math.round((loHz ?? 0) / binHz));
    const k1 = Math.min(N / 2 - 1, Math.round((hiHz ?? 1e9) / binHz));
    for (let t = 0; t < frames; t++) {
      for (let i = 0; i < N; i++) {
        re[i] = mono[t * H + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      let f = 0;
      for (let k = k0; k <= k1; k++) {
        const m = Math.log1p(300 * Math.hypot(re[k], im[k]));
        cur[k] = m;
        const d = m - prev[k];
        if (d > 0) f += d;
      }
      env[t] = f;
      const tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return { env, fps: sr / 2 / H };
  };
  const hitEnvelope = (buffer, fromSec, seconds) => bandEnvelope(buffer, fromSec, seconds, 30, 9000);
  const beatNudge = (aBuffer, aPos, bBuffer, bPos, seconds) => {
    try {
      const A = hitEnvelope(aBuffer, aPos, seconds);
      const B = hitEnvelope(bBuffer, bPos, seconds);
      const n = Math.min(A.env.length, B.env.length);
      const maxLag = Math.round(0.04 * A.fps);
      if (n < A.fps * 4) return 0;
      const scores = [];
      for (let l = -maxLag; l <= maxLag; l++) {
        let s = 0;
        let na = 0;
        let nb = 0;
        for (let t = Math.max(0, -l); t < Math.min(n, n - l); t++) {
          s += A.env[t] * B.env[t + l];
          na += A.env[t] * A.env[t];
          nb += B.env[t + l] * B.env[t + l];
        }
        scores.push(s / Math.sqrt(na * nb + 1e-9));
      }
      let best = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
      const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
      // Only a clear peak inside the range counts: at the edge, or barely above the rest, means the two
      // don't share enough drums to tell, and the grids are the better guide
      if (best === 0 || best === scores.length - 1 || scores[best] < 0.12 || scores[best] < mean * 1.15) return 0;
      const y0 = scores[best - 1];
      const y1 = scores[best];
      const y2 = scores[best + 1];
      const frac = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
      return (best - maxLag + Math.max(-0.5, Math.min(0.5, frac))) / A.fps;
    } catch {
      return 0;
    }
  };

  // Kicks lining up is half of it; the other half is the pattern. With one track a beat out, its claps
  // (beats two and four) land on the other's kicks (one and three). This compares the two tracks' drum
  // patterns beat by beat across the overlap and says how many whole beats (0-3) the incoming track
  // should join later for its pattern to sit on the outgoing one's.
  const beatPattern = (buffer, fromSec, beatLen, count) => {
    const { env: lowEnv, fps } = bandEnvelope(buffer, fromSec, beatLen * count + 0.2, 30, 160);
    const { env: snapEnv } = bandEnvelope(buffer, fromSec, beatLen * count + 0.2, 1500, 8000);
    const at = (env, i) => {
      const c = i * beatLen * fps;
      let m = 0;
      for (let t = Math.max(0, Math.floor(c - 0.02 * fps)); t <= Math.min(env.length - 1, Math.ceil(c + 0.06 * fps)); t++) if (env[t] > m) m = env[t];
      return m;
    };
    const kick = [];
    const snap = [];
    for (let i = 0; i < count; i++) {
      kick.push(at(lowEnv, i));
      snap.push(at(snapEnv, i));
    }
    return { kick, snap };
  };
  const corr = (x, y, shift) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i + shift < y.length && i < x.length; i++) {
      sx += x[i];
      sy += y[i + shift];
      n++;
    }
    if (n < 12) return 0;
    const mx = sx / n;
    const my = sy / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
      const a = x[i] - mx;
      const b = y[i + shift] - my;
      num += a * b;
      dx += a * a;
      dy += b * b;
    }
    return num / (Math.sqrt(dx * dy) + 1e-9);
  };
  const patternShift = (aBuffer, aPos, bBuffer, bPos, beatLen, beats) => {
    try {
      const n = Math.min(beats, 48);
      const A = beatPattern(aBuffer, aPos, beatLen, n);
      const B = beatPattern(bBuffer, bPos, beatLen, n + 3);
      const score = (k) => corr(A.snap, B.snap, k) + 0.6 * corr(A.kick, B.kick, k);
      const scores = [0, 1, 2, 3].map(score);
      let best = 0;
      for (let k = 1; k < 4; k++) if (scores[k] > scores[best]) best = k;
      // Only on clear evidence: an intro with no drums has no pattern to compare
      return best !== 0 && scores[best] > 0.35 && scores[best] - scores[0] > 0.3 ? best : 0;
    } catch {
      return 0;
    }
  };

  // How loud a stretch of a track is above the bass, beat by beat (mean power, bass filtered out)
  const beatEnergy = (buffer, fromSec, beatLen, count, bass = false) => {
    const sr = buffer.sampleRate;
    const out = new Float64Array(count);
    const i0 = Math.max(0, Math.round(fromSec * sr));
    const per = beatLen * sr;
    if (bass) {
      // The low end only (one-pole low-pass at 150 Hz, twice)
      const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const ch = buffer.getChannelData(c);
        let y1 = 0;
        let y2 = 0;
        for (let b = 0; b < count; b++) {
          const from = i0 + Math.round(b * per);
          const to = Math.min(ch.length, i0 + Math.round((b + 1) * per));
          let sum = 0;
          for (let i = from; i < to; i++) {
            y1 += a * (ch[i] - y1);
            y2 += a * (y1 - y2);
            sum += y2 * y2;
          }
          if (to > from) out[b] += sum / (to - from);
        }
      }
      return out;
    }
    const k = 1 / (1 + (2 * Math.PI * 200) / sr); // one-pole high-pass at 200 Hz
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      let y = 0;
      let prev = ch[i0] || 0;
      for (let b = 0; b < count; b++) {
        const from = i0 + Math.round(b * per);
        const to = Math.min(ch.length, i0 + Math.round((b + 1) * per));
        let sum = 0;
        for (let i = from; i < to; i++) {
          y = k * (y + ch[i] - prev);
          prev = ch[i];
          sum += y * y;
        }
        if (to > from) out[b] += sum / (to - from);
      }
    }
    return out;
  };
  /**
   * The outgoing track's fader through a blend. A plain crossfade assumes both tracks are equally full;
   * an intro usually isn't, and the mix sags while it's all there is. So the outgoing track is held up
   * for as long as the incoming one is thin, and leaves as the incoming one fills in: the level above the
   * bass moves smoothly from where the old track was to where the new one will be.
   */
  const holdCurve = (aBuffer, aPos, bBuffer, bPos, beatLen, beats) => {
    const n = Math.max(4, Math.round(beats));
    const plain = (i) => Math.cos(((i / n) * Math.PI) / 2);
    try {
      const EA = beatEnergy(aBuffer, aPos, beatLen, n);
      const EB = beatEnergy(bBuffer, bPos, beatLen, n + 8);
      const mean = (arr, from, to) => {
        let sum = 0;
        let c = 0;
        for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) {
          sum += arr[i];
          c++;
        }
        return c ? sum / c : 0;
      };
      const start = mean(EA, 0, 8);
      // Where the new track is heading: its level just after the window
      const after = Math.max(mean(EB, n, n + 8), mean(EB, n - 4, n));
      if (!(start > 0) || !(after > 0)) throw new Error("silent");
      const g = new Float32Array(n + 1);
      for (let i = 0; i <= n; i++) {
        const x = i / n;
        const target = Math.exp(Math.log(start) * (1 - x) + Math.log(after) * x);
        const gb = Math.sin((x * Math.PI) / 2);
        const eb = mean(EB, i - 1, i + 2);
        const ea = Math.max(mean(EA, i - 1, i + 2), start * 0.05);
        const need = Math.sqrt(Math.max(0, (target - gb * gb * eb) / ea));
        // Never below the plain crossfade, never above full
        g[i] = Math.min(1, Math.max(plain(i), need));
      }
      // Only ever going down, smoothly, and out by the end
      for (let i = 1; i <= n; i++) g[i] = Math.min(g[i], g[i - 1]);
      for (let pass = 0; pass < 2; pass++) for (let i = 1; i < n; i++) g[i] = (g[i - 1] + 2 * g[i] + g[i + 1]) / 4;
      const tail = Math.min(4, n / 4);
      for (let i = 0; i <= n; i++) g[i] *= Math.min(1, (n - i) / tail);
      g[0] = 1;
      g[n] = 0;
      return g;
    } catch {
      return Float32Array.from({ length: n + 1 }, (_, i) => plain(i));
    }
  };

  /**
   * The beat on which the bass changes hands. The plan says the middle of the window; but if the incoming
   * track has no bass there yet (a break, a drumless intro), handing over would leave a hole in the low end.
   * So it's the first phrase line from the planned one onwards where the incoming bass is actually there,
   * or the very end of the window if it never arrives, in which case the outgoing bass simply stays.
   */
  const bassSwapBeat = (aBuffer, aPos, bBuffer, bPos, beatLen, beats, planned) => {
    try {
      const n = Math.round(beats);
      const A = beatEnergy(aBuffer, aPos, beatLen, Math.min(n, 16), true);
      const B = beatEnergy(bBuffer, bPos, beatLen, n + 8, true);
      const mean = (arr, from, to) => {
        let sum = 0;
        let c = 0;
        for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) {
          sum += arr[i];
          c++;
        }
        return c ? sum / c : 0;
      };
      const need = mean(A, 0, 16) * 0.2; // within about 7 dB of the outgoing bass
      for (let c = Math.round(planned); c <= n - 4; c += 4) if (mean(B, c, c + 8) >= need) return c;
      return n;
    } catch {
      return planned;
    }
  };

  // ------------------ MASHUPS ------------------
  // A mashup is two songs made into one for a moment, the way a DJ does it: a build and a drop. For eight
  // or sixteen bars one song's singer rides on the other song's band, and then the other song lands, whole
  // and at full level, on a line both songs were heading for (see mashMatch for how that line is found: in
  // the other song a drop, in this one its own drop, the start of a section, or a phrase line).
  //   - which way round the build is, the session chooses by who is singing there: this song's singer
  //     over the other song's band, or the other song's singer over this song's band. The listener can
  //     turn it round while the build plays (see mashFlip)
  //   - only the playing song has a singer: the other is not taken apart at all, and plays as it is
  //   - nobody sings: the other song's build plays on top of this one, which is wound up and gone on the line
  //   - if this song's singer is still singing when the other song lands, it rides on over the drop for
  //     eight bars more
  // (It used to be one song's singer over the other's band for as long as the two had room for, a hundred
  // bars and more from the next four-bar line, with nothing to arrive at: two songs at once, not one.)
  //
  // The voices are taken out of both songs by a neural network in a page of its own (see stems.js): this
  // page hands it a stretch of sound and gets the voice back. The band is then the sound minus the voice,
  // so voice and band always add up to exactly the song. What has to be right is the pairing: that the
  // one song's notes fit the other's where they meet, that the two are on one beat, and that the singer
  // is in the band's key. That is measured here, on the audio itself.
  //
  // Taking a voice out takes time (a tenth of the stretch's length on a graphics card, half of it on a
  // processor), so it is done in pieces of a few seconds: each piece is put in its place, to the sample,
  // as it arrives, the work staying ahead of the playing (see the feeds, below). A piece that doesn't make
  // it in time is done without: of the song coming in, that stretch plays whole; of the one playing, its
  // voice stays. And if the work falls behind for good, the mashup is ended early, on a bar line, the way
  // it would have ended anyway (see `wrapUp` in the transition).
  const arrangers = []; // the mashups under way whose blocks are still being decided (see the transition)
  // What the last one did, for the log: { said, cut }. Only that: the arrangement itself reaches, through
  // what it decides with, the whole of both songs and the tempo-shifted copy, and kept here it kept them
  // all after the mashup was over and the songs were unloaded (150 MB and more, until the next mashup).
  let lastArrangement;
  // The mashup that is playing, for turning it round: { flip, deck, end } (let go of when it is over, for the same reason)
  let liveMash = null;
  const pcm16 = (buffer, from, n) => {
    const l = buffer.getChannelData(0);
    const r = buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0);
    const out = new Int16Array(2 * n);
    for (let i = 0; i < n; i++) {
      out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l[from + i] * 32768)));
      out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r[from + i] * 32768)));
    }
    return out;
  };
  /**
   * A voice moved in pitch without its timing moving: by `ratio` (1.0595 is a semitone up). This is what
   * brings a singer into the other song's key where the two songs are at the same tempo already and a
   * semitone or two apart: the song itself can't be moved that far without its tempo going with it, and
   * leaving bits of a whole song out to make up for that is heard (see mashMatch). A voice on its own can
   * be: it is one note at a time, so it repeats itself every few milliseconds, and a grain of it can be
   * put a whole number of those repeats earlier or later without a seam. So: the voice is played faster
   * (or slower) in grains of 46 ms that overlap by half, each starting where the one before it would have
   * carried on for as long as that stays within 12 ms of where it belongs in time, and otherwise at the
   * place within that reach that sounds most like the carrying on.
   *   v: the separated voice (16 bit, left and right in turn), of which samples skip..skip+n are the piece
   *      and the rest is what is around it
   * The pieces of a song are made one at a time and have to join: the grain that straddles the line
   * between two pieces has to be the same one in both. So a piece starts where the one before it ended
   * (`startAt`: how far from its place in time that one's last grain was, in samples; 0 with no piece
   * before it), and says where it ended itself (`end`). Made before the piece that comes before it, which
   * is rare, a piece has to end where the next one started instead (`endAt`): its last grain is put
   * there, and the one before that is chosen to lead into it (a seam that doesn't quite match, once).
   */
  const shiftVoice = (v, skip, n, ratio, sr, startAt = 0, endAt = undefined) => {
    const total = v.length >> 1;
    const H = 1024;
    const W = 2 * H;
    const x = [new Float32Array(total), new Float32Array(total)];
    const mono = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const l = v[2 * i] / 32768;
      const r = v[2 * i + 1] / 32768;
      x[0][i] = l;
      x[1][i] = r;
      mono[i] = l + r;
    }
    const out = [new Float32Array(n), new Float32Array(n)];
    const win = new Float32Array(W);
    for (let m = 0; m < W; m++) win[m] = 0.5 - 0.5 * Math.cos((2 * Math.PI * m) / W);
    const reach = Math.round(0.012 * sr);
    const L = Math.round(H * ratio);
    const G = Math.ceil(n / H);
    const fixed = endAt !== undefined && G >= 3;
    /** How alike the sound from p and the sound from q are, over what two grains share (-1 to 1; -2: not there) */
    const alike = (p, q) => {
      if (p < 0 || q < 0 || p + L >= total || q + L >= total) return -2;
      let sum = 0;
      let ea = 0;
      let eb = 0;
      for (let i = 0; i < L; i += 2) {
        const a = mono[p + i];
        const b = mono[q + i];
        sum += a * b;
        ea += a * a;
        eb += b * b;
      }
      return ea > 1e-7 && eb > 1e-7 ? sum / Math.sqrt(ea * eb) : 0;
    };
    const place = (g) => skip + g * H + (1 - ratio) * H;
    const home = Math.round((ratio > 1 ? -0.7 : 0.7) * reach);
    let prev = 0;
    for (let g = -1; g < G; g++) {
      let s = place(g);
      if (g < 0) s += startAt;
      else if (fixed && g === G - 1) s += endAt;
      else {
        const carry = prev + ratio * H;
        const s0 = Math.round(s);
        const lead = fixed && g === G - 2;
        if (!lead && Math.abs(carry - s) <= reach) s = carry;
        else {
          const c = Math.round(carry);
          const next = Math.round(place(g + 1) + (endAt || 0));
          let best = -3;
          let at = 0;
          for (let d = -reach; d <= reach; d++) {
            const q = s0 + d;
            let score = alike(c, q);
            if (score < -1) continue;
            // (the last one before a grain that is already set also has to lead into it)
            if (lead) score += Math.max(-1, alike(q + L, next));
            // (of places that are as good, the one furthest back on the side it drifts away from: it is
            // then longest until the next such step, and as often early as late)
            score -= (0.02 * Math.abs(d - home)) / reach;
            if (score > best) {
              best = score;
              at = d;
            }
          }
          s = best > -3 ? s0 + at : s0;
        }
      }
      prev = s;
      const o0 = g * H;
      for (let m = 0; m < W; m++) {
        const o = o0 + m;
        if (o < 0 || o >= n) continue;
        const pos = s + ratio * m;
        const i = Math.floor(pos);
        if (i < 1 || i + 2 >= total) continue;
        const f = pos - i;
        const w = win[m];
        for (let c = 0; c < 2; c++) {
          const ch = x[c];
          const y0 = ch[i - 1];
          const y1 = ch[i];
          const y2 = ch[i + 1];
          const y3 = ch[i + 2];
          // (a curve through four samples: straight lines between two take the top off a voice)
          out[c][o] += w * (y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0))));
        }
      }
    }
    return { out, end: prev - place(G - 1) };
  };
  /** A piece's voice as its set has it moved in pitch (see stemShift): made when it is first needed, and again if the set is moved elsewhere */
  const upOf = (set, piece, index) => {
    if (!set || !set.cents || !piece.raw) return null;
    if (piece.upCents !== set.cents) {
      const sr = piece.voc.sampleRate;
      // (where the pieces either side of it start and end, if they have been made: see shiftVoice)
      const seams = (set.seams ||= new Map());
      const before = seams.get(index - 1);
      const after = seams.get(index + 1);
      const startAt = before && before.to === piece.from ? before.end : 0;
      const made = shiftVoice(piece.raw, piece.skip, piece.n, Math.pow(2, set.cents / 1200), sr, startAt, after && after.from === piece.from + piece.n && piece.n % 1024 === 0 ? after.start : undefined);
      seams.set(index, { from: piece.from, to: piece.from + piece.n, start: startAt, end: made.end });
      const up = ctx.createBuffer(2, piece.n, sr);
      up.copyToChannel(made.out[0], 0);
      up.copyToChannel(made.out[1], 1);
      piece.up = up;
      piece.upCents = set.cents;
    }
    return piece.up;
  };
  /**
   * The voices of the set `name` are wanted `cents` higher (lower, below zero) as well as as they are: for
   * the pieces that are there, and for every one still to come (0: no longer).
   */
  const stemShift = async ({ name, cents }) => {
    let set = stemSets.get(name);
    if (!set) {
      set = { id: undefined, pieces: new Map() };
      stemSets.set(name, set);
    }
    cents = Math.round(cents) || 0;
    if (set.cents !== cents) set.seams = new Map();
    set.cents = cents;
    if (!cents) return {};
    // (in the order they are heard: each then starts where the one before it ended)
    for (const [i, p] of [...set.pieces].sort((x, y) => x[0] - y[0])) {
      if (set.cents !== cents) break;
      upOf(set, p, i);
      await new Promise((r) => setTimeout(r, 0));
    }
    return {};
  };
  /** Leaves a stretch of a track (or of a tempo-shifted lead-in, by its key) where the separator picks it up */
  const stemOut = async ({ job, id, key, from, to }) => {
    const buffer = key ? (stretches.get(key) || {}).buffer : (tracks.get(id) || {}).buffer;
    if (!buffer) throw new Error("nothing to separate");
    from = Math.max(0, Math.round(from));
    const n = Math.min(buffer.length, Math.round(to)) - from;
    if (n < ctx.sampleRate) throw new Error("too short a stretch to separate");
    const res = await fetch("/blob/" + job, { method: "POST", body: pcm16(buffer, from, n).buffer });
    if (!res.ok) throw new Error("couldn't hand the sound over");
    return { from, samples: n };
  };
  /**
   * Picks the voice up again and keeps it as a piece of the set `name`: the voice, and (with `band`) the
   * sound minus the voice. What was handed over started at sample `from` of the track (or lead-in);
   * the first `skip` samples of it and whatever comes after `keep` more were only there for the separator
   * to hear what is around the piece. A mashup that is playing from the set gets the piece at once.
   */
  const stemIn = async ({ job, name, id, key, from, skip = 0, keep, index = 0, band = true }) => {
    const res = await fetch("/blob/" + job + ".v");
    if (!res.ok) throw new Error("the separated voice didn't arrive");
    const v = new Int16Array(await res.arrayBuffer());
    const got = (v.length >> 1) - skip;
    const n = Math.min(keep ?? got, got);
    const src = key ? (stretches.get(key) || {}).buffer : (tracks.get(id) || {}).buffer;
    if (!src || n <= 0 || from + skip + n > src.length) throw new Error("the track the voice belongs to has gone");
    const sr = src.sampleRate;
    const voc = ctx.createBuffer(2, n, sr);
    const inst = band ? ctx.createBuffer(2, n, sr) : null;
    // How much of each second is voice (its level against the whole sound's), for judging where there is singing
    const seconds = Math.ceil(n / sr);
    const ev = new Float64Array(seconds);
    const es = new Float64Array(seconds);
    for (let c = 0; c < 2; c++) {
      const whole = src.getChannelData(Math.min(c, src.numberOfChannels - 1));
      const vo = voc.getChannelData(c);
      const io = inst && inst.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const x = v[2 * (skip + i) + c] / 32768;
        const w = whole[from + skip + i];
        vo[i] = x;
        if (io) io[i] = w - x;
        const k = (i / sr) | 0;
        ev[k] += x * x;
        es[k] += w * w;
      }
    }
    let set = stemSets.get(name);
    if (!set) {
      set = { id: undefined, pieces: new Map() };
      stemSets.set(name, set);
      while (stemSets.size > 6) stemSets.delete(stemSets.keys().next().value);
    }
    set.id ??= key ? stretches.get(key).id : id;
    // (...and how loud the voice itself is in each second: RMS per channel)
    const per = (k) => 2 * Math.min(sr, n - k * sr);
    const share = Array.from(ev, (e, k) => (es[k] > 1e-7 ? Math.round(Math.sqrt(e / es[k]) * 100) / 100 : 0));
    const level = Array.from(ev, (e, k) => Math.round(Math.sqrt(e / per(k)) * 10000) / 10000);
    // (what the separator gave is kept with what is around the piece: a voice moved in pitch is made from that)
    const piece = { from: from + skip, n, voc, inst, share, level, raw: v, skip };
    set.pieces.set(index, piece);
    upOf(set, piece, index);
    for (const f of feeds) if (f.name === name) playPiece(f, index, piece);
    return { seconds: n / sr, voice: share, level };
  };
  const stemDrop = ({ name }) => (stemSets.delete(name), {});

  // A feed is one song's separated pieces going into a mashup that is already scheduled:
  //   { name, deck, frameOf(sample of the track) → frame of the output it is heard at,
  //     parts: [{ which: "voc" | "inst", to: node }], grid: { base, seg, from, to } (piece i is `seg`
  //     samples from base + i * seg; pieces from..to are wanted), whole?: { buffer, to } (what plays
  //     instead of a piece that isn't there in time), audible: from when it is heard, end: when it is
  //     over, played (the pieces that are in place), late, missed }
  let feedTimer = 0;
  const playPiece = (f, index, piece) => {
    if (f.played.has(index) || index < f.grid.from || index >= f.grid.to) return;
    const sr = ctx.sampleRate;
    let frame = f.frameOf(piece.from);
    let offset = 0;
    const soonest = Math.round((ctx.currentTime + 0.08) * sr);
    // (how long before it is heard the piece got here: the least of those says how close the race was.
    // A piece can begin before its feed is heard at all, which is not being late)
    const heard = Math.max(frame, Math.round((f.audible || 0) * sr));
    f.spare = Math.min(f.spare, (heard - soonest) / sr);
    if (frame < soonest) {
      // (It joins in where the song has got to, on the sample)
      offset = soonest - frame;
      frame = soonest;
      if (heard < soonest) f.late++;
    }
    f.played.add(index);
    if (offset >= piece.n) return;
    for (const part of f.parts) {
      // ("up": the voice moved in pitch, where the set has it so; the voice as it is where it hasn't)
      const buffer = part.which === "up" ? upOf(stemSets.get(f.name), piece, index) || piece.voc : piece[part.which];
      if (!buffer) continue;
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(part.to);
      keep(f.deck, s);
      s.start(frame / sr, offset / sr);
      if (f.deck.stopAt < Infinity) {
        try {
          s.stop(f.deck.stopAt + 0.03);
        } catch {}
      }
    }
  };
  const watchFeeds = () => {
    const sr = ctx.sampleRate;
    const now = ctx.currentTime;
    for (let k = arrangers.length - 1; k >= 0; k--) {
      const m = arrangers[k];
      if (decks.get(m.deck.id) !== m.deck || now > m.end) {
        arrangers.splice(k, 1);
        continue;
      }
      try {
        while (m.k < m.blocks && now >= m.at(m.k)) m.decide(m.k++);
      } catch (err) {
        arrangers.splice(k, 1);
      }
      if (m.k >= m.blocks) arrangers.splice(k, 1);
    }
    for (let k = feeds.length - 1; k >= 0; k--) {
      const f = feeds[k];
      const set = stemSets.get(f.name);
      if (now > f.end + 1 || decks.get(f.deck.id) !== f.deck || f.deck.stopAt <= now) {
        feeds.splice(k, 1);
        stemSets.delete(f.name);
        continue;
      }
      if (f.whole) {
        for (let i = f.grid.from; i < f.grid.to; i++) {
          if (f.played.has(i)) continue;
          const from = f.grid.base + i * f.grid.seg;
          let frame = f.frameOf(from);
          if (frame / sr - now > 0.45) break;
          // Not there in time: this stretch of the song plays as it is
          f.played.add(i);
          f.gone.add(i);
          f.missed++;
          const soonest = Math.round((now + 0.08) * sr);
          const offset = Math.max(0, soonest - frame);
          if (offset >= f.grid.seg) continue;
          frame += offset;
          const s = ctx.createBufferSource();
          s.buffer = f.whole.buffer;
          s.connect(f.whole.to);
          keep(f.deck, s);
          s.start(frame / sr, (from + offset) / sr, (f.grid.seg - offset) / sr);
          if (f.deck.stopAt < Infinity) {
            try {
              s.stop(f.deck.stopAt + 0.03);
            } catch {}
          }
        }
      }
      // (What has been heard is let go of: a piece is some megabytes)
      if (set) for (const [i, p] of set.pieces) if (f.frameOf(p.from + p.n) / sr < now - 0.5) set.pieces.delete(i);
    }
    if (liveMash && (now > liveMash.end || decks.get(liveMash.deck.id) !== liveMash.deck)) liveMash = null;
    if (!feeds.length && !arrangers.length) {
      clearInterval(feedTimer);
      feedTimer = 0;
    }
  };
  const addFeed = (f) => {
    f.played = new Set();
    f.gone = new Set(); // (of those, the ones that weren't there in time and were done without)
    f.late = 0;
    f.missed = 0;
    f.spare = Infinity;
    feeds.push(f);
    const set = stemSets.get(f.name);
    if (set) for (const [i, p] of set.pieces) playPiece(f, i, p);
    if (!feedTimer) feedTimer = setInterval(watchFeeds, 150);
    return f;
  };
  /** How the pieces of the mashups under way have been arriving */
  const feedState = () => ({
    arrangement: lastArrangement ? lastArrangement.said.slice() : [],
    cut: lastArrangement ? lastArrangement.cut : 0,
    // (ended where the listener stopped it, with that song left: "a" or "b"; cut is then where)
    stopped: lastArrangement ? lastArrangement.stopped : undefined,
    plan: lastArrangement
      ? { halves: lastArrangement.halves, from: lastArrangement.from, end: lastArrangement.end, planned: lastArrangement.planned, per: lastArrangement.per, bar: lastArrangement.bar, bed: lastArrangement.bed, land: lastArrangement.land, flippable: !!lastArrangement.flippable && !!liveMash && ctx.currentTime < (lastArrangement.flipUntil ?? lastArrangement.end - (lastArrangement.per || 8) * (lastArrangement.bar || 2)), blocks: (lastArrangement.blocks || []).slice() }
      : undefined, feeds: feeds.map((f) => ({ name: f.name, wanted: f.grid.to - f.grid.from, played: f.played.size, late: f.late, missed: f.missed, spare: f.spare === Infinity ? null : Math.round(f.spare * 10) / 10 })) });

  const profileOf = (id) => {
    let p = profiles.get(id);
    if (!p) {
      const t = tracks.get(id);
      if (!t) throw new Error("track not loaded: " + id);
      const mono = monoHalf(t.buffer);
      const sr = t.buffer.sampleRate / 2;
      p = runDsp({ type: "profile", mono, sr }, (d) => d.profile(mono, sr));
      profiles.set(id, p);
      p.catch(() => profiles.get(id) === p && profiles.delete(id));
      if (profiles.size > 8) profiles.delete(profiles.keys().next().value);
    }
    return p;
  };

  /** What each bar holds: the notes of its bass and of everything above it, how loud both are, where its drums hit */
  const barsOf = (p, bar0, barLen, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const t0 = bar0 + i * barLen;
      const f0 = Math.max(0, Math.ceil((t0 - p.win / 2) / p.hop));
      const f1 = Math.min(p.frames, Math.ceil((t0 + barLen - p.win / 2) / p.hop));
      const bass = new Float32Array(12);
      const top = new Float32Array(12);
      let eb = 0;
      let et = 0;
      for (let f = f0; f < f1; f++) {
        for (let pc = 0; pc < 12; pc++) {
          bass[pc] += p.bass[f * 12 + pc];
          top[pc] += p.top[f * 12 + pc];
        }
        eb += p.eBass[f];
        et += p.eTop[f];
      }
      const n = Math.max(1, f1 - f0);
      const kick = new Float32Array(16);
      const snap = new Float32Array(16);
      for (let s = 0; s < 16; s++) {
        const c = (t0 + (s * barLen) / 16 - p.drumWin / 2) * p.fps;
        let mk = 0;
        let ms = 0;
        for (let f = Math.max(0, Math.floor(c - 0.015 * p.fps)); f <= Math.min(p.low.length - 1, Math.ceil(c + 0.04 * p.fps)); f++) {
          if (p.low[f] > mk) mk = p.low[f];
          if (p.high[f] > ms) ms = p.high[f];
        }
        kick[s] = mk;
        snap[s] = ms;
      }
      out.push({ bass: clear(bass), top: clear(top), eb: eb / n, et: et / n, kick, snap, real: f1 > f0 && t0 >= 0 });
    }
    return out;
  };
  // How well a note sits on a bass note, by how many semitones it is above it: the same note and the
  // fifth best, thirds and sixths well, a semitone or a tritone above not at all
  const CONSONANCE = [1, -1, 0.05, 0.6, 0.6, 0.4, -0.7, 0.8, 0.4, 0.45, 0.15, -0.3];
  /** A bar's notes with what every pitch has of it (drums, noise) taken off */
  const clear = (v) => {
    const sorted = Array.from(v).sort((x, y) => x - y);
    const floor = (sorted[5] + sorted[6]) / 2;
    const out = new Float32Array(12);
    for (let p = 0; p < 12; p++) out[p] = Math.max(0, v[p] - floor);
    return out;
  };
  /**
   * How well the notes above sit on the bass below them (-1 to 1): every note against every bass note,
   * by the interval between them. `up`: the bass / the notes above are heard that many semitones higher.
   */
  const noteFit = (bass, top, bassUp, topUp) => {
    let sb = 0;
    let st = 0;
    for (let p = 0; p < 12; p++) {
      sb += bass[p];
      st += top[p];
    }
    if (!(sb > 0) || !(st > 0)) return 0;
    let sum = 0;
    for (let p = 0; p < 12; p++) {
      if (!bass[p]) continue;
      for (let q = 0; q < 12; q++) if (top[q]) sum += bass[p] * top[q] * CONSONANCE[(((q + topUp - p - bassUp) % 12) + 12) % 12];
    }
    return sum / (sb * st);
  };
  const stepFit = (x, y) => {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < 16; i++) {
      mx += x[i];
      my += y[i];
    }
    mx /= 16;
    my /= 16;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < 16; i++) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) * (x[i] - mx);
      dy += (y[i] - my) * (y[i] - my);
    }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  };
  /** The level a track's bars reach when it is in full swing (the upper end of what its bars hold) */
  const fullLevel = (bars, key) => {
    const v = bars
      .filter((b) => b.real)
      .map((b) => b[key])
      .sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length * 0.75)] : 0;
  };
  /** 1 while a part is there in force, 0 once it's about 10 dB down (a break, an intro) */
  const presence = (e, full) => (full > 0 && e > 0 ? Math.max(0, Math.min(1, (10 * Math.log10(e / full) + 10) / 6)) : 0);

  /**
   * How much later (seconds) track B's drums hit than track A's, with B played at `rate`, over a stretch
   * of both. null when the two don't share enough drums there to tell.
   */
  const drumLag = (aBuffer, aPos, bBuffer, bPos, rate, seconds) => {
    const A = hitEnvelope(aBuffer, aPos, seconds);
    const B = hitEnvelope(bBuffer, bPos - 0.1, seconds * rate + 0.3);
    const n = A.env.length;
    if (n < A.fps * 4 || B.env.length < n * rate) return null;
    const lead = 0.1 * A.fps;
    const at = (x) => {
      const i = Math.floor(x);
      if (i < 0 || i + 1 >= B.env.length) return 0;
      return B.env[i] + (B.env[i + 1] - B.env[i]) * (x - i);
    };
    const maxLag = Math.round(0.04 * A.fps);
    const scores = [];
    for (let l = -maxLag; l <= maxLag; l++) {
      let s = 0;
      let na = 0;
      let nb = 0;
      for (let t = 0; t < n; t++) {
        const b = at(t * rate + lead + l);
        s += A.env[t] * b;
        na += A.env[t] * A.env[t];
        nb += b * b;
      }
      scores.push(s / Math.sqrt(na * nb + 1e-9));
    }
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
    if (best === 0 || best === scores.length - 1 || scores[best] < 0.12 || scores[best] < mean * 1.15) return null;
    const y0 = scores[best - 1];
    const y1 = scores[best];
    const y2 = scores[best + 1];
    const frac = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
    // (A hit is smeared over the window it is measured in; played at another speed, B's is smeared over
    // that much more or less than A's, which would otherwise read as a lag)
    const skew = (512 / (aBuffer.sampleRate / 2)) * (1 - 1 / rate);
    return (best - maxLag + Math.max(-0.5, Math.min(0.5, frac))) / A.fps - skew;
  };

  /**
   * The same from the drum hits the two profiles already hold: nothing new to work out, so it is quick,
   * and good to a millisecond or two. For telling candidates apart; the one that is chosen gets drumLag.
   */
  const quickLag = (pa, aPos, pb, bPos, rate, seconds) => {
    const fps = pa.fps;
    const exactA = (aPos - pa.drumWin / 2) * fps;
    const a0 = Math.round(exactA);
    // (A is read on whole frames; B from wherever that puts it, between frames)
    const b0 = (bPos - pb.drumWin / 2) * fps + (a0 - exactA) * rate;
    const n = Math.floor(seconds * fps);
    if (a0 < 0 || a0 + n >= pa.high.length || n < fps * 4) return null;
    // (Kick and top end count alike, each against its own level)
    const mean = (env, from, count) => {
      let sum = 0;
      for (let i = 0; i < count; i++) sum += env[Math.min(env.length - 1, Math.max(0, from + i))];
      return sum / count + 1e-12;
    };
    const al = mean(pa.low, a0, n);
    const ah = mean(pa.high, a0, n);
    const bl = mean(pb.low, Math.round(b0), Math.round(n * rate));
    const bh = mean(pb.high, Math.round(b0), Math.round(n * rate));
    const A = new Float32Array(n);
    for (let t = 0; t < n; t++) A[t] = pa.low[a0 + t] / al + pa.high[a0 + t] / ah;
    const at = (x) => {
      const i = Math.floor(x);
      if (i < 0 || i + 1 >= pb.high.length) return 0;
      const f = x - i;
      return (pb.low[i] + (pb.low[i + 1] - pb.low[i]) * f) / bl + (pb.high[i] + (pb.high[i + 1] - pb.high[i]) * f) / bh;
    };
    const maxLag = Math.round(0.045 * fps);
    const scores = [];
    for (let l = -maxLag; l <= maxLag; l++) {
      let sum = 0;
      let na = 0;
      let nb = 0;
      for (let t = 0; t < n; t++) {
        const b = at(b0 + t * rate + l);
        sum += A[t] * b;
        na += A[t] * A[t];
        nb += b * b;
      }
      scores.push(sum / Math.sqrt(na * nb + 1e-9));
    }
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    const avg = scores.reduce((x, y) => x + y, 0) / scores.length;
    if (best === 0 || best === scores.length - 1 || scores[best] < 0.12 || scores[best] < avg * 1.15) return null;
    const y0 = scores[best - 1];
    const y1 = scores[best];
    const y2 = scores[best + 1];
    const frac = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
    return (best - maxLag + Math.max(-0.5, Math.min(0.5, frac))) / fps;
  };

  /**
   * Finds where and how track `b` is best mashed into track `a` (which is playing), and how good that is.
   *
   * A mashup is a build and a drop, as a DJ plays one: for eight or sixteen bars one song's singer rides on
   * the other song's band, and then the other song's drop lands, on the bar line, and it is that song. So
   * what is looked for is a place to land: in B, where its bass arrives (a drop, the beat coming in after
   * the intro, a section starting); in A, a line the listener's ear is waiting for something on (its own
   * drop best of all, then where one of its sections starts, then a phrase line: eight bars on from where
   * its section started). The bars before the two landings are the build, and are what has to go together:
   * the notes of the two there, with the singer moved to the key of the band it rides on.
   *   A, B: { period, bar0 (a bar line), phrase, body, from, last, sections: where the track changes (see
   *         dsp.js) } (positions in seconds: `from` is where the build may start in A at the soonest, `last`
   *         where each track's music ends); A.stems: the name its voice is kept under as far as it has been
   *         taken out (see stemIn), for knowing where it sings; A.horizon: how far ahead it may land (seconds)
   *   free: the second track was asked for by name: it is taken further in tempo and pitch to fit
   *   exact: the drums are lined up to the fraction of a millisecond (takes a few seconds; for the pair
   *         that is going to be played)
   */
  const mashMatch = async ({ a, b, A, B, free, exact }) => {
    const ta = tracks.get(a);
    const tb = tracks.get(b);
    if (!ta || !tb) throw new Error("track not loaded");
    const began = performance.now();
    const [pa, pb] = await Promise.all([profileOf(a), profileOf(b)]);
    const profiled = performance.now();
    const barA = 4 * A.period;
    const barB = 4 * B.period;
    const R = B.period / A.period; // how fast B has to play for its beat to match A's
    const tuneA = pa.clarity > 0.12 ? pa.tuning : 0;
    const tuneB = pb.clarity > 0.12 ? pb.tuning : 0;
    const natural = 1200 * Math.log2(R);
    const detail = { tempo: [60 / A.period, 60 / B.period], tuning: [Math.round(pa.tuning), Math.round(pb.tuning)], clarity: [pa.clarity, pb.clarity].map((v) => Math.round(v * 100) / 100), ms: [Math.round(profiled - began), 0] };

    // Ways to bring B to A's tempo and the two into one key. The band that plays is never touched beyond
    // being played a little faster or slower, the way a record is (its pitch goes with it; up to 6%, a
    // semitone, which is what a DJ's pitch fader has): nothing is cut out of it and nothing repeated, so it
    // sounds like itself. What is brought into key is the singer, alone: a voice is one note at a time and
    // can be moved without a seam (see shiftVoice), by the semitones the keys are apart and by however far
    // the two records are out of tune with each other. The two bands are then in different keys, which
    // doesn't matter: they are never heard together (see the transition).
    // (Before, a song a semitone off was resampled into key and had bits left out of it to keep the tempo,
    // nine joins a second for minutes, and one further off in tempo than 1.2% was turned down.)
    const SPEED = free ? 0.085 : 0.06;
    const SEMITONES = free ? 3 : 2;
    const ways = [];
    if (Math.abs(R - 1) <= SPEED) {
      for (let k = -SEMITONES; k <= SEMITONES; k++) {
        const voice = 100 * k + tuneA - tuneB - natural;
        if (Math.abs(voice) > 100 * SEMITONES + 35) continue;
        ways.push(Math.abs(voice) < 9 ? { k, pitch: R, joins: 0, off: voice, voice: 0 } : { k, pitch: R, joins: 0, off: 0, voice });
      }
    } else if (free) {
      // Further apart than that, and asked for by name: the song itself is moved to a pitch that is in tune,
      // and the rest of the tempo is made up by leaving out or repeating a few milliseconds here and there
      // (see dsp.js). It is heard, on held notes; it is that or no mashup of these two.
      for (let k = -2; k <= 2; k++) {
        const pitch = Math.pow(2, (100 * k + tuneA - tuneB) / 1200);
        const joins = R / pitch - 1;
        if (Math.abs(joins) <= 0.08) ways.push({ k, pitch, joins, off: 0, voice: 0 });
      }
    }
    if (!ways.length) return { ok: false, why: "tempo", ...detail };

    // Every bar of both on their own grids, for the level each reaches in full swing
    const nA = Math.max(0, Math.floor((A.last - A.bar0) / barA));
    const nB = Math.max(0, Math.floor((B.last - B.bar0) / barB));
    const barsA = barsOf(pa, A.bar0, barA, nA);
    const barsB = barsOf(pb, B.bar0, barB, nB);
    const full = { ab: fullLevel(barsA, "eb"), at: fullLevel(barsA, "et"), bb: fullLevel(barsB, "eb"), bt: fullLevel(barsB, "et") };
    const onBeatA = (t) => A.bar0 + Math.round((t - A.bar0) / A.period) * A.period;
    const onBeatB = (t) => B.bar0 + Math.round((t - B.bar0) / B.period) * B.period;
    const meanOf = (bars, from, to, key) => {
      let sum = 0;
      let n = 0;
      for (let x = from; x < to; x++) {
        if (!bars[x] || !bars[x].real) continue;
        sum += bars[x][key];
        n++;
      }
      return n ? sum / n : 0;
    };
    const BUILDS = [16, 8];
    const RIDE = 8;
    const TAIL = 45; // seconds of B that are left for it alone after it has landed
    const HORIZON = A.horizon || 100;

    // Where B can land: where its bass arrives and stays (a drop), where a section of it starts, where its
    // intro ends. On the beat the change itself is on, wherever its bar lines were put. Wherever it is, what
    // follows has to be the song in full swing, its bass and everything over it within a few dB of the most
    // it reaches: landing is arriving, and a line the song goes quiet on, or picks up on only half-way, is
    // nowhere to arrive (a mashup that lands there is followed by less than what it left).
    const landsB = [];
    const dBOf = (x, full) => (full > 0 && x > 0 ? 10 * Math.log10(x / full) : -60);
    const landB = (t, kind, change) => {
      t = onBeatB(t);
      if (t - 9 * barB < 0.1 || B.last - t < TAIL) return;
      const near8 = barsOf(pb, t - 8 * barB, barB, 24);
      const before = meanOf(near8, 0, 8, "eb");
      // (the bass has to be there from the line on: over the two bars from it as over the eight. A line a few
      // bars ahead of the real drop has the eight bars after it full of bass too, and nothing on it)
      const after = Math.min(meanOf(near8, 8, 10, "eb"), meanOf(near8, 8, 16, "eb"));
      const lift = 10 * Math.log10((after + 1e-12) / (before + 1e-12));
      // (how far under its full swing it is from the line on: its bass, and everything over it)
      // (...and it has to last: the eight bars after those as well, give or take. A drop that is over after eight
      // bars leaves the listener in a break before the song has had its say)
      const under = Math.min(dBOf(after, full.bb), dBOf(Math.min(meanOf(near8, 8, 10, "et"), meanOf(near8, 8, 16, "et")), full.bt) + 1, dBOf(meanOf(near8, 16, 24, "eb"), full.bb) + 2);
      if (under < -4.5) return;
      if (kind === "section") {
        if (lift >= 6) kind = "drop";
        else if (change < 8) return;
      }
      const near = landsB.findIndex((l) => Math.abs(l.t - t) < 2 * barB);
      const land = { t, kind, lift: Math.max(-6, Math.min(24, lift)), under: Math.min(0, under) };
      if (near < 0) landsB.push(land);
      else if (land.kind === "drop" && (landsB[near].kind !== "drop" || land.lift > landsB[near].lift)) landsB[near] = land;
    };
    // (a change that is not on one of the track's own bar lines is taken at its word only if it is a big one: then
    // it is the bar lines that are out; a small one is a fill, or a beat of something starting early)
    const OFF_BAR = 12;
    for (const s of B.sections || []) if (s.bar >= 0 || s.change >= OFF_BAR) landB(s.t, "section", s.change);
    landB(B.body, "body", 0);
    if (!landsB.some((l) => l.kind === "drop")) {
      // (a song that never drops: every eight bars from where its intro ends is where something of it starts)
      for (let t = onBeatB(B.body) + 8 * barB; t < B.last - TAIL; t += 8 * barB) landB(t, "phrase", 0);
    }
    if (!landsB.length) return { ok: false, why: "room", ...detail };

    // Where it can land in A: its own drops and section starts (on the beat they are on), and its phrase
    // lines: the bar lines eight bars on (four, at a pinch) from where the section they are in started
    const landsA = [];
    const firstLand = A.from + 8 * barA - 1e-3;
    const lastLand = Math.min(A.last - 2 * barA, A.from + 16 * barA + HORIZON);
    const starts = (A.sections || []).filter((s) => s.bar >= 0).map((s) => onBeatA(s.t));
    for (const s of A.sections || []) {
      const t = onBeatA(s.t);
      if (t < firstLand || t > lastLand || s.change < (s.bar >= 0 ? 6 : OFF_BAR)) continue;
      landsA.push({ t, kind: s.rise >= 5 ? "drop" : "section", rise: s.rise });
    }
    for (let i = Math.ceil((firstLand - A.bar0) / barA); i < nA; i++) {
      const t = A.bar0 + i * barA;
      if (t > lastLand) break;
      if (landsA.some((l) => Math.abs(l.t - t) < 1.5 * A.period)) continue;
      let from = -Infinity;
      for (const s of starts) if (s <= t + 0.05) from = s;
      const since = from > -Infinity ? Math.round((t - from) / barA) : (((i - A.phrase) % 8) + 8) % 8;
      if (since % 8 === 0) landsA.push({ t, kind: "phrase", rise: 0 });
      else if (since % 4 === 0) landsA.push({ t, kind: "half", rise: 0 });
    }
    if (!landsA.length) return { ok: false, why: "ending", ...detail };

    // Where A sings, as far as its voice has been taken out: the share of the seconds between two moments
    // that are sung (a lead voice: 0.3 of the sound and more), or undefined where too little is known
    const voiceA = [];
    {
      const set = A.stems && stemSets.get(A.stems);
      if (set) for (const p of set.pieces.values()) if (p.share) for (let s = 0; s < p.share.length; s++) voiceA.push({ t: (p.from + s * ctx.sampleRate) / ctx.sampleRate, v: p.share[s] });
    }
    const sungA = (t0, t1) => {
      let known = 0;
      let sung = 0;
      for (const x of voiceA) {
        if (x.t < t0 - 0.5 || x.t >= t1 - 0.5) continue;
        known++;
        if (x.v >= 0.3) sung++;
      }
      return known >= 0.5 * (t1 - t0) ? sung / known : undefined;
    };

    // The 24 bars around a landing: 16 before it (the build is the last 8 or 16 of those) and 8 after
    const around = (p, t, barLen) => barsOf(p, t - 16 * barLen, barLen, 24);
    /** How alike the notes of bars from..to of the two are (-1 to 1), B heard k semitones higher: which notes they are made of, whatever the order */
    const na = new Float64Array(12);
    const nb = new Float64Array(12);
    const sameNotes = (WA, WB, from, to, k) => {
      na.fill(0);
      nb.fill(0);
      for (let x = from; x < to; x++) {
        const ba = WA[x];
        const bb = WB[x];
        if (!ba.real || !bb.real) continue;
        let st = 0;
        let sb = 0;
        let ut = 0;
        let ub = 0;
        for (let p = 0; p < 12; p++) {
          st += ba.top[p];
          sb += ba.bass[p];
          ut += bb.top[p];
          ub += bb.bass[p];
        }
        for (let p = 0; p < 12; p++) {
          na[p] += (st > 0 ? ba.top[p] / st : 0) + (sb > 0 ? (0.5 * ba.bass[p]) / sb : 0);
          nb[p] += (ut > 0 ? bb.top[p] / ut : 0) + (ub > 0 ? (0.5 * bb.bass[p]) / ub : 0);
        }
      }
      let ma = 0;
      let mb = 0;
      for (let p = 0; p < 12; p++) {
        ma += na[p];
        mb += nb[p];
      }
      ma /= 12;
      mb /= 12;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let p = 0; p < 12; p++) {
        const x = na[p] - ma;
        const y = nb[(((p - k) % 12) + 12) % 12] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
      }
      return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    };
    /** One song's notes on the other's bass, bar by bar (aBelow: B's on A's bass); a bar where either part is missing adds nothing */
    const half = (WA, WB, from, to, k, aBelow) => {
      let sum = 0;
      for (let x = from; x < to; x++) {
        const ba = WA[x];
        const bb = WB[x];
        if (!ba.real || !bb.real) continue;
        const w = aBelow ? Math.min(presence(ba.eb, full.ab), presence(bb.et, full.bt)) : Math.min(presence(bb.eb, full.bb), presence(ba.et, full.at));
        sum += w * (aBelow ? noteFit(ba.bass, bb.top, 0, k) : noteFit(bb.bass, ba.top, k, 0));
      }
      return sum / (to - from);
    };
    /** How much of each song's notes fall outside the other's scale (its seven strongest pitch classes) there: [B's outside A's, A's outside B's] */
    const outsideOf = (WA, WB, from, to, k) => {
      sameNotes(WA, WB, from, to, 0);
      const x = Array.from(na);
      const y = Array.from({ length: 12 }, (_, p) => nb[(((p - k) % 12) + 12) % 12]);
      const scale = (v) => {
        const order = v.map((_, p) => p).sort((p, q) => v[q] - v[p]);
        const inside = new Uint8Array(12);
        for (let q = 0; q < 7; q++) inside[order[q]] = 1;
        return inside;
      };
      const inA = scale(x);
      const inB = scale(y);
      let outB = 0;
      let outA = 0;
      let sa = 0;
      let sb = 0;
      for (let p = 0; p < 12; p++) {
        sa += x[p];
        sb += y[p];
        if (!inA[p]) outB += y[p];
        if (!inB[p]) outA += x[p];
      }
      return [sb > 0 ? outB / sb : 0, sa > 0 ? outA / sa : 0];
    };

    // Every landing of A against every landing of B, with a build of sixteen bars or eight, every way. What
    // counts: the notes first (over the build, and over the 24 bars around the landing, which says more
    // about the key than eight bars can); then what kind of place it is in each song (a drop that comes up
    // out of nothing is worth most, and landing it on A's own drop is what makes the two one song); a
    // singer in A's build, where that is known; and the sooner the better.
    const KIND_A = { drop: 0.22, section: 0.12, phrase: 0.05, half: -0.08 };
    const KIND_B = { drop: 0.1, section: 0.06, body: 0.05, phrase: 0 };
    const windowsA = new Map();
    const windowsB = new Map();
    let best = null;
    const byWay = new Map();
    for (const la of landsA) {
      let WA = windowsA.get(la.t);
      if (!WA) windowsA.set(la.t, (WA = around(pa, la.t, barA)));
      for (const lb of landsB) {
        let WB = windowsB.get(lb.t);
        if (!WB) windowsB.set(lb.t, (WB = around(pb, lb.t, barB)));
        for (const n of BUILDS) {
          // (A has to be that far along, and B needs the build and the bar it starts in, unheard, before it)
          if (la.t - n * barA < A.from - 1e-3 || lb.t - (n + 1) * barB < 0.1) continue;
          const sung = sungA(la.t - n * barA, la.t);
          const place =
            KIND_A[la.kind] +
            KIND_B[lb.kind] +
            (lb.kind === "drop" ? 0.012 * Math.min(18, lb.lift) : 0) +
            0.04 * lb.under +
            (sung === undefined ? 0 : sung >= 0.5 ? 0.2 : sung >= 0.25 ? 0.05 : -0.1) +
            (n === 16 ? (sung === undefined || sung >= 0.5 ? 0.03 : -0.05) : 0) -
            (0.05 * (la.t - firstLand)) / (8 * barA) -
            (0.01 * lb.t) / 60;
          for (const way of ways) {
            const build = sameNotes(WA, WB, 16 - n, 16, way.k);
            const wide = sameNotes(WA, WB, 0, 24, way.k);
            const notes = 0.5 * build + 0.5 * wide;
            const s1 = half(WA, WB, 16 - n, 24, way.k, true);
            const s2 = half(WA, WB, 16 - n, 24, way.k, false);
            const fit = (s1 + s2) / 2;
            const score = notes + 0.4 * fit + place - 0.03 * Math.abs(way.k) - 3 * Math.abs(way.joins) - 0.004 * Math.max(0, Math.abs(way.off) - 3) - (way.voice ? 0.01 + 0.0002 * Math.abs(way.voice) : 0);
            const seen = byWay.get(way);
            if (!seen || notes > seen.notes) byWay.set(way, { notes, fit });
            if (!best || score > best.score) best = { score, notes, build, wide, fit, s1, s2, la, lb, n, way, WA, WB, sung, place };
          }
        }
      }
    }
    detail.ways = [...byWay].map(([w, v]) => ({ k: w.k, voice: !!w.voice, joins: Math.round(w.joins * 1000) / 10, fit: Math.round(v.fit * 100) / 100, notes: Math.round(v.notes * 100) / 100 }));
    if (!best) return { ok: false, why: "room", ...detail };
    const { la, lb, n, way, WA, WB } = best;

    // What that is worth against the other eleven keys B could have been in: a real match stands out
    const others = [];
    const elsewhere = [];
    for (let k = 1; k < 12; k++) {
      others.push((half(WA, WB, 16 - n, 24, way.k + k, true) + half(WA, WB, 16 - n, 24, way.k + k, false)) / 2);
      elsewhere.push(0.5 * sameNotes(WA, WB, 16 - n, 16, way.k + k) + 0.5 * sameNotes(WA, WB, 0, 24, way.k + k));
    }
    others.sort((x, y) => x - y);
    elsewhere.sort((x, y) => y - x);
    const median = (others[5] + others[4]) / 2;
    const beaten = others.filter((v) => v < best.fit).length;

    // Whether A's singer can ride on over B's drop for eight bars more: both have that much left, and the
    // notes of the two go together there as well
    const rideNotes = sameNotes(WA, WB, 16, 24, way.k);
    const ride = A.last - la.t >= (RIDE + 2) * barA && B.last - lb.t >= TAIL + RIDE * barB && rideNotes >= 0.5 ? RIDE : 0;

    // Drums on drums, where both have them
    let rhythm = 0;
    {
      let count = 0;
      for (let x = 16 - n; x < 24; x++) {
        if (!WA[x].real || !WB[x].real || presence(WA[x].eb, full.ab) < 0.5 || presence(WB[x].eb, full.bb) < 0.5) continue;
        rhythm += 0.5 * stepFit(WA[x].kick, WB[x].kick) + 0.5 * stepFit(WA[x].snap, WB[x].snap);
        count++;
      }
      rhythm = count ? rhythm / count : 0;
    }

    // The last milliseconds, and the tempo to the last hundredth of a percent: where the drums of both
    // actually hit, in five places from the start of the build to sixteen bars past the landing (a build
    // often has no drums to read; what comes after it has)
    const aPos = la.t - n * barA;
    let bPos = lb.t - n * barB;
    let speed = R;
    const span = Math.min((n + 16) * barA, A.last - aPos - 1, (B.last - bPos - 1) / R);
    const lags = [];
    let places = [];
    // (Two tracks whose grids are on their kicks, to the millisecond (see refineKick in dsp.js), are together
    // when their grids are: there is nothing left to measure, and a build without drums has nothing to read.
    // Reading the drums of both against each other is for the tracks without a kick on every beat.)
    const onKicks = !!A.kick && !!B.kick;
    try {
      const W = Math.min(14, span / 2);
      places = [0, (span - W) / 4, (span - W) / 2, (3 * (span - W)) / 4, span - W];
      for (const off of onKicks ? [] : places) {
        // (Where the fine measurement finds nothing to go by, the quick one still may)
        const lag = (exact ? drumLag(ta.buffer, aPos + off, tb.buffer, bPos + off * R, R, W) : null) ?? quickLag(pa, aPos + off, pb, bPos + off * R, R, W);
        if (lag !== null) lags.push({ t: off + W / 2, lag });
      }
      // (A reading far from the others is a stretch where the two don't share drums, not a real lag)
      if (lags.length >= 2) {
        const sorted = lags.map((l) => l.lag).sort((x, y) => x - y);
        const middle = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        for (let i = lags.length - 1; i >= 0; i--) if (Math.abs(lags[i].lag - middle) > 0.006) lags.splice(i, 1);
      }
      if (lags.length >= 2) {
        // A line through them: where B should start, and how much faster or slower it should run
        const mt = lags.reduce((x, l) => x + l.t, 0) / lags.length;
        const ml = lags.reduce((x, l) => x + l.lag, 0) / lags.length;
        let num = 0;
        let den = 0;
        for (const l of lags) {
          num += (l.t - mt) * (l.lag - ml);
          den += (l.t - mt) * (l.t - mt);
        }
        const drift = den ? num / den : 0;
        if (Math.abs(drift) <= 0.0012) {
          speed = R * (1 + drift);
          bPos += (ml - drift * mt) * R;
        } else bPos += ml * R;
      } else if (lags.length === 1) bPos += lags[0].lag * R;
    } catch {}
    detail.ms[1] = Math.round(performance.now() - profiled);
    return {
      ok: true,
      fit: best.fit,
      // (one's notes on the other's bass: B's on A's, then A's on B's)
      halves: [best.s1, best.s2],
      median,
      beaten,
      // (the notes of the two: over the build and around the landing, and the best that any other key would have made of them)
      notes: best.notes,
      notesBuild: best.build,
      notesElsewhere: elsewhere[0],
      // (how much of each song's notes are outside the other's scale: B's, then A's)
      outside: outsideOf(WA, WB, 0, 24, way.k),
      // (in how many of the places looked at the two songs' drums could be read against each other)
      locked: [onKicks ? places.length : lags.length, places.length],
      onKicks,
      // (the build, and how long A's singer may ride on over B's drop after it)
      bars: n + ride,
      bars1: n,
      bars2: ride,
      rideNotes,
      // (what the landing is in each song, how far B's bass rises there (dB), and how much of A's build is sung, where that is known)
      at: { a: la.kind, b: lb.kind, lift: Math.round(lb.lift * 10) / 10, sung: best.sung === undefined ? undefined : Math.round(best.sung * 100) / 100 },
      landA: la.t,
      landB: lb.t,
      self: [0, 0],
      rhythm,
      semitones: way.k,
      // (As it is: the pitch simply follows the speed. Moved: the pitch stays where it was put)
      pitch: way.joins === 0 ? speed : way.pitch,
      joins: way.joins === 0 ? 0 : speed / way.pitch - 1,
      speed,
      off: way.off,
      // (how far its singer is moved on its own, in cents: the song itself stays where it is)
      voice: way.voice ? Math.round(way.voice + 1200 * Math.log2(R / speed)) : 0,
      aPos,
      bPos,
      shift: 0,
      lags: lags.map((l) => Math.round(l.lag * 10000) / 10),
      ...detail,
    };
  };

  // ------------------ VOICE ------------------
  // The DJ has to be heard over the music without shouting over quiet music. Every line arrives at one
  // level (VOICE_LEVEL: its speaking, not its pauses, as dense as a radio voice; see talk/level.ts). It
  // goes out a little louder (OVER) than the music it is talking over is at full level, and the music
  // under it is brought down to UNDER of that, or further: as far as it takes for the words to sit 15 dB
  // above the song (APART), whatever the record's master and whether or not TIDAL is evening the
  // loudness out. A line can't go out above the level it was made at (its peaks are at full scale
  // there), so over the loudest masters it is the music that gives way.
  const VOICE_LEVEL = 0.32;
  const OVER = 1.4;
  const UNDER = 0.2;
  const APART = 5.6;
  let lastLoud = 0.25;
  /** How loud the music the voice goes over is at full level: the loudest of the decks that are playing, or of `also` (a track about to start) */
  const musicLoudness = (when, also) => {
    let loud = 0;
    const count = (trackId) => {
      const t = tracks.get(trackId);
      if (t && t.loud * t.gain > loud) loud = t.loud * t.gain;
    };
    for (const d of decks.values()) if (d.sources.length && d.stopAt > when) count(d.trackId);
    if (also) count(also);
    if (loud > 0) lastLoud = loud;
    return lastLoud;
  };
  // The music makes way for the voice gradually: it takes DOWN seconds to get down, the voice comes in LEAD
  // seconds into that, when the music is most of the way there, and the music comes back over UP
  // seconds once the line is over. (It used to drop in a quarter of a second, which is heard as the
  // volume being cut, the more so the further it drops.)
  const DOWN = 1.3;
  const LEAD = 1;
  const UP = 1.6;
  /**
   * Moves a gain from `from` to `to` over `d` seconds from `t`: evenly to the ear (so in decibels, not
   * in a straight line, which is heard as nothing much and then a drop), easing into it and out of it.
   */
  const along = (from, to, x) => Math.exp(Math.log(Math.max(from, 1e-3)) + ((Math.log(Math.max(to, 1e-3)) - Math.log(Math.max(from, 1e-3))) * (1 - Math.cos(Math.PI * x))) / 2);
  const glide = (param, from, to, t, d) => {
    if (Math.abs(from - to) < 1e-6) return void param.setValueAtTime(to, t);
    const N = 64;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) curve[i] = along(from, to, i / (N - 1));
    curve[0] = from;
    curve[N - 1] = to;
    param.setValueCurveAtTime(curve, t, d);
  };
  /**
   * Stops whatever a gain was going to do from `t` on, leaving it where it has got to by then. (Just
   * cancelling takes a curve that is under way out altogether, so the gain would be back where the
   * curve started until `t`.)
   */
  const holdAt = (param, t) => {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else param.cancelScheduledValues(t);
  };
  // Where the music as a whole has been sent (see dipMusic), so that a line that comes while it is
  // still on its way somewhere starts from where it will be
  let musicMoves = [];
  const musicAt = (t) => {
    let v = 1;
    for (const m of musicMoves) if (m.t <= t) v = t >= m.t + m.d ? m.to : along(m.from, m.to, (t - m.t) / m.d);
    return v;
  };
  const voiceGain = (when, also) => Math.max(0.5, Math.min(1, (musicLoudness(when, also) * OVER) / VOICE_LEVEL));
  /** What the music is turned down to under a line */
  const under = (when, also) => {
    const music = musicLoudness(when, also);
    return Math.max(0.1, Math.min(UNDER, (voiceGain(when, also) * VOICE_LEVEL) / (music * APART)));
  };
  let spoken = { voice: 0, music: 0 }; // the last line's speaking level and the music's at full level, for the log
  const speak = (key, when, also) => {
    const buffer = clips.get(key);
    if (!buffer) throw new Error("clip not loaded");
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = voiceGain(when, also);
    spoken = { voice: level.gain.value * VOICE_LEVEL, music: lastLoud };
    s.connect(level).connect(voiceHp);
    s.start(when);
    voices.add(s);
    s.onended = () => {
      voices.delete(s);
      s.disconnect();
      level.disconnect();
    };
    return when + buffer.duration;
  };
  // ------------------ JINGLE ------------------
  // The DJ's signature, heard before it speaks: two seconds, the same shape every time (that is what is
  // remembered) in the colour of the song it comes over, in one of five styles (`style`), each with its
  // accent a quarter to half a second in:
  //   swell   a soft rush of air and a string ensemble winding up, which stutter and are sucked away for a
  //           moment, landing on a deep boom with the air rushing back out and a softly strummed chord over it
  //   brass   a horn section: a short stab a tone below the key note and a long one on it ("ba-DAAH")
  //   guitar  two muted chugs and an overdriven power chord, with kick, snare and a dark cymbal
  //   drums   four toms going down and a boom
  //   pulse   four quick notes on a synth bass, its filter opening, and a stab that closes again
  // All of them take their sound from the song they come over, so they are in tune with the music they
  // interrupt and change with it: its key note (`tonic`: 0 = C ... 11 = B, C when there is none), its
  // major or minor (`third`: 4 or 3 semitones, played in each style's chord, the toms coming down it; 0
  // where the key isn't known well enough to say, and the chord is left open: key note and fifth), and its
  // tuning (`cents` from concert pitch: a track made from a sped-up sample can be a quarter tone out).
  // They are made by an offline audio context (the same oscillators and filters as the live one, run
  // as fast as they go), the plucked strings sample by sample; once for each key asked for.
  const JINGLE_IN = 0.45; // its start, from when the music starts to go down (its first half second needs the music partly out of the way)
  const JINGLE_TO_VOICE = { swell: 1.15, brass: 0.95, guitar: 1.05, drums: 1.05, pulse: 1.05 }; // from its start to the DJ's first word
  const toVoice = (style) => JINGLE_TO_VOICE[style] || 1.15;
  const JINGLE_LEVEL = 0.24; // RMS of its loudest third of a second (the voice speaks at VOICE_LEVEL)
  const JINGLE_GAP = 45; // not again within this many seconds: two lines in a row share one
  const JINGLE_SECONDS = 2.1;
  const renderJingle = async (sr, tonic, third, style, cents = 0) => {
    // (the key note between the F two octaves below middle C and the E above it, as far from concert pitch as the song is)
    const root = 41 + (((((tonic | 0) - 5) % 12) + 12) % 12);
    const hz = (semis) => 440 * Math.pow(2, (root + semis - 69 + cents / 100) / 12);
    // (the same noise every time, so the jingle is the same every time)
    let seed = 20231;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x40000000) - 1;
    const oc = new OfflineAudioContext(2, Math.round(JINGLE_SECONDS * sr), sr);
    const gain = (v) => {
      const g = oc.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type, f, q, db) => {
      const b = oc.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      if (q !== undefined) b.Q.value = q;
      if (db !== undefined) b.gain.value = db;
      return b;
    };
    const panned = (v) => {
      const p = oc.createStereoPanner();
      p.pan.value = v;
      return p;
    };
    const osc = (type, f, t, d, cents = 0) => {
      const o = oc.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = cents;
      o.start(t);
      o.stop(t + d);
      return o;
    };
    const mono = (x) => {
      const b = oc.createBuffer(1, x.length, sr);
      b.copyToChannel(x, 0);
      return b;
    };
    const hiss = mono(Float32Array.from({ length: 2 * sr }, rand));
    let turn = 0;
    const noise = (t, d) => {
      const s = oc.createBufferSource();
      s.buffer = hiss;
      s.loop = true;
      s.start(t, (turn++ * 0.137) % 1.5);
      s.stop(t + d);
      return s;
    };
    /** A level that is `v` at `t` (after `attack`), has fallen to `left` of that `d` later, and is then let go */
    const hitEnv = (param, t, v, d, attack, left = 0.003) => {
      param.setValueAtTime(0, 0);
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(v, t + attack);
      param.exponentialRampToValueAtTime(Math.max(1e-4, v * left), t + d);
      param.linearRampToValueAtTime(0, t + d + 0.05);
    };
    // The way out: a gentle compressor that holds it together; one echo, to one side and then the
    // other; and a room
    const out = oc.createDynamicsCompressor();
    out.threshold.value = -12;
    out.knee.value = 12;
    out.ratio.value = 2.5;
    out.attack.value = 0.01;
    out.release.value = 0.15;
    out.connect(oc.destination);
    const echo = gain(1);
    {
      const left = oc.createDelay(1);
      const right = oc.createDelay(1);
      left.delayTime.value = 0.33;
      right.delayTime.value = 0.33;
      const level = gain(0.5);
      echo.connect(filter("bandpass", 900, 0.5)).connect(left);
      left.connect(gain(0.5)).connect(right);
      left.connect(panned(-0.7)).connect(level);
      right.connect(panned(0.7)).connect(level);
      level.connect(out);
    }
    const room = oc.createConvolver();
    {
      const n = Math.round(1.2 * sr);
      const ir = oc.createBuffer(2, n, sr);
      for (let c = 0; c < 2; c++) {
        const x = ir.getChannelData(c);
        for (let i = 0; i < n; i++) x[i] = rand() * Math.exp(-i / (0.28 * sr)) * Math.min(1, i / (0.006 * sr));
      }
      room.buffer = ir;
      room.connect(filter("highpass", 300)).connect(filter("lowpass", 4500)).connect(gain(0.2)).connect(out);
    }
    const kick = (t, level, d = 0.3) => {
      const o = osc("sine", 120, t, d + 0.1);
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.08);
      const g = gain(0);
      hitEnv(g.gain, t, level, d, 0.004);
      o.connect(g).connect(out);
    };
    /** The floor dropping away: a low note sliding down an octave */
    const boom = (t, level) => {
      const o = osc("sine", hz(0), t, 1);
      o.frequency.setValueAtTime(hz(0), t);
      o.frequency.exponentialRampToValueAtTime(Math.max(36, hz(-12)), t + 0.3);
      const g = gain(0);
      hitEnv(g.gain, t, level, 0.85, 0.006);
      o.connect(g).connect(out);
    };
    const snare = (t, level) => {
      const g = gain(0);
      hitEnv(g.gain, t, level, 0.17, 0.002);
      noise(t, 0.22).connect(filter("bandpass", 1800, 0.6)).connect(g);
      g.connect(out);
      g.connect(gain(0.5)).connect(room);
      const body = osc("triangle", 200, t, 0.1);
      body.frequency.setValueAtTime(200, t);
      body.frequency.exponentialRampToValueAtTime(150, t + 0.07);
      const b = gain(0);
      hitEnv(b.gain, t, level * 0.7, 0.08, 0.002);
      body.connect(b).connect(out);
    };
    /** A dark cymbal: a wash, not a splash */
    const wash = (t, level, d) => {
      const g = gain(0);
      hitEnv(g.gain, t, level, d, 0.006);
      noise(t, d + 0.06).connect(filter("highpass", 2600)).connect(filter("lowpass", 6500, 0.7)).connect(g);
      const p = panned(0.2);
      g.connect(p).connect(out);
      p.connect(gain(0.5)).connect(room);
    };
    /**
     * A plucked string, added to `x`: a loop of noise as long as the note's period, averaged every time
     * round, so the highs die first. (The loop is a whole number of samples; a filter that only delays
     * makes up the fraction, or the high notes would be out of tune.) `soft`: how soft the pluck is, 0-1.
     */
    const string = (x, f, at, len, damp, soft = 0.5) => {
      const period = sr / f;
      const N = Math.max(2, Math.floor(period - 0.6));
      const frac = period - 0.5 - N;
      const C = (1 - frac) / (1 + frac);
      const line = new Float32Array(N);
      let prev = 0;
      let mean = 0;
      for (let i = 0; i < N; i++) mean += line[i] = prev = soft * prev + (1 - soft) * rand();
      mean /= N;
      let peak = 1e-6;
      for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs((line[i] -= mean)));
      for (let i = 0; i < N; i++) line[i] /= peak;
      const i0 = Math.round(at * sr);
      const n = Math.min(x.length - i0, Math.round(len * sr));
      const fade = 0.03 * sr;
      let idx = 0;
      let was = 0;
      let gave = 0;
      for (let k = 0; k < n; k++) {
        const a = line[idx];
        const next = idx + 1 === N ? 0 : idx + 1;
        x[i0 + k] += a * Math.min(1, (n - k) / fade);
        const avg = damp * 0.5 * (a + line[next]);
        gave = C * avg + was - C * gave;
        was = avg;
        line[idx] = gave;
        idx = next;
      }
    };
    const T = 0.02;
    const HIT = T + 0.5;
    const VOICE = toVoice(style);

    if (style === "brass") {
      /** A horn section on a chord: saw waves whose filter opens as they are blown, scooping up to the note */
      const horns = (t, len, notes, level) => {
        const lp = filter("lowpass", 450, 2.5);
        lp.frequency.setValueAtTime(450, t);
        lp.frequency.exponentialRampToValueAtTime(2800, t + 0.045);
        lp.frequency.exponentialRampToValueAtTime(1500, t + Math.max(0.1, Math.min(len, 0.3)));
        const env = gain(0);
        env.gain.setValueAtTime(0, 0);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(level, t + 0.018);
        env.gain.linearRampToValueAtTime(level * 0.8, t + len - 0.05);
        env.gain.linearRampToValueAtTime(0, t + len);
        for (const semis of notes) {
          for (const cents of [-7, 7]) {
            const o = osc("sawtooth", hz(semis), t, len + 0.02, cents);
            o.detune.setValueAtTime(cents - 45, t);
            o.detune.linearRampToValueAtTime(cents, t + 0.05);
            o.connect(panned(cents / 11)).connect(gain(0.6 / Math.sqrt(2 * notes.length))).connect(lp);
          }
        }
        lp.connect(env).connect(out);
        env.connect(gain(0.4)).connect(room);
        env.connect(gain(0.25)).connect(echo);
      };
      horns(T, 0.14, [-2, 10, 14, 17, 22], 0.8);
      kick(T, 0.6, 0.2);
      horns(T + 0.22, 0.55, third ? [0, 12, 12 + third, 19, 24] : [0, 12, 19, 24], 1);
      kick(T + 0.22, 0.8);
    } else if (style === "guitar") {
      // (two takes, one to each side)
      for (const side of [-1, 1]) {
        const x = new Float32Array(Math.round(JINGLE_SECONDS * sr));
        const late = side > 0 ? 0.009 : 0;
        for (const at of [T, T + 0.14]) for (const semis of [0, 7]) string(x, hz(semis), at + late, 0.11, 0.955);
        (third ? [0, 7, 12, 19, 24 + third] : [0, 7, 12, 19]).forEach((semis, k) => string(x, hz(semis), T + 0.3 + late + 0.011 * k, 1.4, 0.9985));
        const s = oc.createBufferSource();
        s.buffer = mono(x);
        s.start(0);
        // an amplifier turned up, and its speaker
        const amp = oc.createWaveShaper();
        const curve = new Float32Array(2049);
        for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(3 * (i / 1024 - 1));
        amp.curve = curve;
        amp.oversample = "4x";
        const g = gain(0.5);
        s.connect(gain(1.5)).connect(amp).connect(filter("highpass", 100, 0.7)).connect(filter("peaking", 900, 0.9, 3)).connect(filter("lowpass", 3600, 1)).connect(filter("lowpass", 5000, 0.7)).connect(g);
        const p = panned(side * 0.7);
        g.connect(p).connect(out);
        p.connect(gain(0.3)).connect(room);
      }
      kick(T, 0.6, 0.15);
      kick(T + 0.14, 0.6, 0.15);
      kick(T + 0.3, 0.9);
      snare(T + 0.3, 0.45);
      wash(T + 0.3, 0.14, 0.8);
    } else if (style === "drums") {
      const tom = (t, f, level, side) => {
        const o = osc("sine", f * 1.6, t, 0.4);
        o.frequency.setValueAtTime(f * 1.6, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
        const g = gain(0);
        hitEnv(g.gain, t, level, 0.3, 0.003);
        const stick = gain(0);
        hitEnv(stick.gain, t, level * 0.25, 0.02, 0.001);
        noise(t, 0.04).connect(filter("bandpass", 2500, 0.8)).connect(stick);
        const p = panned(side);
        o.connect(g).connect(p);
        stick.connect(p);
        p.connect(out);
        p.connect(gain(0.5)).connect(room);
      };
      [12, 7, third || 5, 0].forEach((semis, k) => tom(T + 0.13 * k, hz(semis), 0.6 + 0.08 * k, -0.5 + 0.33 * k));
      kick(T + 0.52, 0.9, 0.35);
      boom(T + 0.52, 0.7);
      wash(T + 0.52, 0.12, 0.9);
    } else if (style === "pulse") {
      // one filter over the four notes, opening as they go
      const lp = filter("lowpass", 350, 7);
      lp.frequency.setValueAtTime(350, T);
      lp.frequency.exponentialRampToValueAtTime(2400, HIT - 0.04);
      lp.connect(out);
      lp.connect(gain(0.3)).connect(echo);
      [0, 0, 12, 0].forEach((semis, k) => {
        const t = T + 0.04 + 0.115 * k;
        const g = gain(0);
        hitEnv(g.gain, t, 0.5, 0.11, 0.004, 0.05);
        osc("sawtooth", hz(semis), t, 0.2).connect(g);
        osc("square", hz(semis), t, 0.2, -9).connect(gain(0.5)).connect(g);
        g.connect(lp);
      });
      // the stab: the key note and its fifth (and the third, where the key says which), the filter closing again
      const close = filter("lowpass", 3000, 4);
      close.frequency.setValueAtTime(3000, HIT);
      close.frequency.exponentialRampToValueAtTime(450, HIT + 0.6);
      const env = gain(0);
      hitEnv(env.gain, HIT, 0.9, 0.7, 0.005, 0.05);
      for (const semis of third ? [0, 12, 12 + third, 19, 24] : [0, 12, 19, 24]) for (const cents of [-8, 8]) osc("sawtooth", hz(semis), HIT, 0.8, cents).connect(panned(cents / 12)).connect(gain(0.18)).connect(close);
      close.connect(env).connect(out);
      env.connect(gain(0.4)).connect(echo);
      env.connect(gain(0.3)).connect(room);
      kick(HIT, 0.85);
    } else {
      // swell: a rush of air and a chord fading in, which stutter as they peak and are sucked away
      // for a moment; then the landing. Everything before the landing goes through `chop`.
      const chop = gain(1);
      chop.connect(out);
      chop.connect(gain(0.5)).connect(room);
      {
        // (four chops, each shorter than the last, down to a quarter and back; then nothing for a twentieth of a second)
        const g = chop.gain;
        g.setValueAtTime(1, 0);
        for (const [from, len] of [
          [-0.3, 0.1],
          [-0.2, 0.08],
          [-0.12, 0.05],
          [-0.07, 0.025],
        ]) {
          const t = HIT + from + len * 0.6;
          g.setValueAtTime(1, t);
          g.linearRampToValueAtTime(0.25, t + 0.006);
          g.setValueAtTime(0.25, HIT + from + len - 0.006);
          g.linearRampToValueAtTime(1, HIT + from + len);
        }
        g.setValueAtTime(1, HIT - 0.045);
        g.linearRampToValueAtTime(0, HIT - 0.035);
        g.setValueAtTime(0, HIT - 0.002);
        g.linearRampToValueAtTime(1, HIT + 0.004);
      }
      // a rush of air, getting brighter
      const lp = filter("lowpass", 300, 0.7);
      lp.frequency.setValueAtTime(300, T);
      lp.frequency.exponentialRampToValueAtTime(2600, HIT);
      const air = gain(0);
      air.gain.setValueAtTime(0.03, T);
      air.gain.exponentialRampToValueAtTime(0.22, HIT - 0.04);
      air.gain.linearRampToValueAtTime(0, HIT - 0.03);
      noise(T, 0.6).connect(lp).connect(air).connect(chop);
      // a chord fading in under it (the key note and its fifth, and the third where it is known) on a string ensemble (saw
      // waves, four to a note and a little apart, through a filter that opens as they swell), winding
      // up to its pitch like a record getting up to speed; it rings on after the landing, darker
      const rise = new Float32Array(32);
      for (let i = 0; i < rise.length; i++) rise[i] = Math.pow(i / (rise.length - 1), 1.3);
      const bow = filter("lowpass", 700, 1);
      bow.frequency.setValueAtTime(700, T);
      bow.frequency.exponentialRampToValueAtTime(2400, HIT);
      bow.frequency.exponentialRampToValueAtTime(1100, HIT + 0.8);
      const strings = gain(0);
      strings.gain.setValueAtTime(0, 0);
      strings.gain.setValueCurveAtTime(rise, T, HIT - T);
      strings.gain.exponentialRampToValueAtTime(0.16, HIT + 1);
      strings.gain.linearRampToValueAtTime(0, HIT + 1.3);
      bow.connect(strings).connect(chop);
      // (a slow waver in the pitch, as bowed strings have)
      const waver = gain(5);
      osc("sine", 5.2, T, 1.9).connect(waver);
      for (const [semis, loud] of [
        [12, 0.2],
        [19, 0.16],
        [24, 0.14],
        ...(third ? [[12 + third, 0.12]] : []),
      ]) {
        for (const cents of [-11, -4, 4, 11]) {
          const o = osc("sawtooth", hz(semis), T, 1.9, cents);
          o.detune.setValueAtTime(cents - 300, T);
          o.detune.linearRampToValueAtTime(cents, HIT - 0.06);
          waver.connect(o.detune);
          o.connect(panned(cents / 14)).connect(gain(loud * 1.2)).connect(bow);
        }
      }
      // the landing: the floor dropping away, a low note, and the air rushing back out, getting darker
      kick(HIT, 0.5, 0.25);
      boom(HIT, 0.8);
      const low = gain(0);
      hitEnv(low.gain, HIT, 0.35, 1, 0.006, 0.15);
      osc("triangle", hz(0), HIT, 1.2).connect(filter("lowpass", 1000, 0.7)).connect(low);
      osc("sine", hz(12), HIT, 1.2).connect(gain(0.5)).connect(low);
      low.connect(out);
      const dark = filter("lowpass", 2600, 0.7);
      dark.frequency.setValueAtTime(2600, HIT);
      dark.frequency.exponentialRampToValueAtTime(300, HIT + 0.55);
      const away = gain(0);
      hitEnv(away.gain, HIT, 0.13, 0.6, 0.005, 0.05);
      noise(HIT, 0.7).connect(dark).connect(away);
      away.connect(out);
      away.connect(gain(0.5)).connect(room);
      // and an open chord strummed softly over it on plucked strings (key note, fifth, octave, second,
      // fifth, with the third under them where it is known), two players, one to each side, echoing once
      for (const side of [-1, 1]) {
        const x = new Float32Array(Math.round(JINGLE_SECONDS * sr));
        (third ? [12, 12 + third, 19, 24, 26, 31] : [12, 19, 24, 26, 31]).forEach((semis, k) => string(x, hz(semis), HIT + 0.004 + 0.017 * k + (side > 0 ? 0.007 : 0), 1.5, 0.9975, 0.78));
        const src = oc.createBufferSource();
        src.buffer = mono(x);
        src.start(0);
        const g = gain(0.2);
        src.connect(filter("highpass", 120, 0.7)).connect(filter("peaking", 250, 1, 3)).connect(filter("lowpass", 4200, 0.7)).connect(g);
        const pn = panned(side * 0.6);
        g.connect(pn).connect(out);
        pn.connect(gain(0.7)).connect(room);
        g.connect(gain(0.5)).connect(echo);
      }
    }

    const made = await oc.startRendering();
    const L = made.getChannelData(0);
    const R = made.getChannelData(1);
    const n = L.length;
    const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));
    // To its level: by the loudest third of a second of it
    const block = Math.round(0.3 * sr);
    let most = 0;
    for (let i = 0; i + block <= n; i += block >> 2) {
      let s = 0;
      for (let j = i; j < i + block; j++) s += L[j] * L[j] + R[j] * R[j];
      most = Math.max(most, s / (2 * block));
    }
    const up = most > 0 ? JINGLE_LEVEL / Math.sqrt(most) : 0;
    // (what would go over full scale is rounded off instead)
    const KNEE = 0.72;
    const round = (v) => {
      const a = v < 0 ? -v : v;
      if (a <= KNEE) return v;
      const y = KNEE + (0.97 - KNEE) * Math.tanh((a - KNEE) / (0.97 - KNEE));
      return v < 0 ? -y : y;
    };
    // Out of the DJ's way: by its first word what is left is well under the voice, and it is gone a second later
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const tail = 1 - 0.65 * ease((t - (VOICE - 0.25)) / 0.45);
      const end = 1 - ease((t - (JINGLE_SECONDS - 0.75)) / 0.72);
      const g = up * tail * end;
      L[i] = round(L[i] * g);
      R[i] = round(R[i] * g);
    }
    return made;
  };
  const jingles = new Map(); // style and key → the jingle, being made or made
  // (The gap is by the clock on the wall, not the mixer's, which stands still while the music is paused:
  // a line after a long pause gets its jingle)
  const onTheWall = (t) => performance.now() / 1000 + (t - ctx.currentTime);
  let jingledFor = -1e9; // the start of the last line that had one
  const jingleDue = (on, voiceAt) => !!on && onTheWall(voiceAt) - jingledFor > JINGLE_GAP;
  /**
   * The jingle in a style and a key (a promise of it: it is made the first time it is asked for, which takes
   * a moment). `sure`: the key is known well enough to say major or minor (its third is played); `cents`:
   * how far the song is from concert pitch, which the jingle is then too (to the nearest 5).
   */
  const jingleIn = (style, tonic, minor, sure, cents) => {
    const pc = Number.isFinite(tonic) ? ((Math.round(tonic) % 12) + 12) % 12 : 0;
    const off = Number.isFinite(cents) ? Math.max(-50, Math.min(50, Math.round(cents / 5) * 5)) : 0;
    const third = !sure ? 0 : minor ? 3 : 4;
    const key = style + ":" + pc + ":" + third + ":" + off;
    let made = jingles.get(key);
    if (!made) {
      made = renderJingle(ctx.sampleRate, pc, third, style, off);
      jingles.set(key, made);
      made.catch(() => jingles.delete(key));
      if (jingles.size > 8) jingles.delete(jingles.keys().next().value);
    }
    return made;
  };
  const playJingle = (when, buffer, level) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = level;
    // (not through the voice's own filter, which takes the lows off: on the voice's way out after it)
    s.connect(g).connect(voice);
    s.start(when);
    voices.add(s);
    s.onended = () => {
      voices.delete(s);
      s.disconnect();
      g.disconnect();
    };
  };

  const stopVoice = (fade) => {
    const g = voice.gain;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    g.setValueAtTime(1, now + fade + 0.05);
    for (const s of voices) {
      try {
        s.stop(now + fade + 0.02);
      } catch {}
    }
  };

  const duckOut = (a, t0, tail) => {
    const g = a.fader.gain;
    const low = under(t0);
    tail = Math.max(0.8, Math.min(tail, 6.5));
    // Starting right now (the DJ button): pick up from wherever the fader is
    const from = t0 - ctx.currentTime < 0.25 ? g.value : 1;
    holdAt(g, t0);
    g.setValueAtTime(from, t0);
    glide(g, from, low * from, t0 + 0.002, DOWN);
    g.setValueCurveAtTime(
      FADE_OUT.map((v) => v * low * from),
      t0 + DOWN + 0.004,
      tail,
    );
    const end = t0 + DOWN + 0.004 + tail;
    stopSources(a, end);
    return end;
  };
  const bringIn = (b, pos, intro, voiceStart, voiceEnd) => {
    const earliest = ctx.currentTime + 0.12;
    let start = voiceEnd + 0.12;
    // Talk over the intro: start so the intro ends just after the last word
    if (intro >= 2.5 && voiceEnd - voiceStart > 3) start = Math.max(voiceStart + 1, voiceEnd - 10, voiceEnd + 0.25 - intro);
    start = Math.max(start, earliest);
    const g = b.fader.gain;
    if (start < voiceEnd - 0.6) {
      const BED = under(start, b.trackId);
      g.setValueAtTime(0, start);
      g.linearRampToValueAtTime(BED, start + 0.5);
      glide(g, BED, 1, Math.max(voiceEnd - 0.15, start + 0.52), UP);
    } else {
      g.setValueAtTime(0, start);
      g.linearRampToValueAtTime(1, start + 0.04);
    }
    play(b, start, pos);
    return start;
  };

  // ------------------ OPERATIONS ------------------
  const ops = {
    init,
    load,
    analyse,
    unload,
    stretch,
    dropStretch,
    mashMatch,
    /** Turns the mashup that is playing round: the other song's band, and the other singer (see the transition) */
    mashFlip: () => (liveMash && ctx.currentTime <= liveMash.end && decks.get(liveMash.deck.id) === liveMash.deck ? liveMash.flip() : { ok: false, why: "none" }),
    /** Ends the mashup that is playing on its next bar line, `keep` ("a": the song that was playing, "b": the other one) left whole (see `stop` in the transition) */
    mashStop: ({ keep }) => (liveMash && liveMash.stop && ctx.currentTime <= liveMash.end && decks.get(liveMash.deck.id) === liveMash.deck ? liveMash.stop(keep === "a" ? "a" : "b") : { ok: false, why: "none" }),
    stemOut,
    stemIn,
    stemShift,
    stemDrop,
    feedState,
    clip,
    status: () => {
      // (a mashup's handle is let go of once it is over: a mashup without voices has no feeds to watch that would)
      if (liveMash && ctx.currentTime > liveMash.end + 1) liveMash = null;
      return {};
    },
    setVolume: ({ percent, muted }) => {
      volume = muted ? 0 : Math.max(0, Math.min(1, percent / 100));
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(volume, ctx.currentTime, 0.015);
      return {};
    },
    /**
     * Plays out of the device TIDAL plays out of (by its name: this page has device ids of its own; none
     * or not found: the system's default). `reopen`: the device is opened again even if it is the one in
     * use (after TIDAL had it to itself in exclusive mode, the old connection to it stays silent for good).
     */
    setOutput: async ({ name, reopen }) => {
      if (typeof ctx.setSinkId !== "function") return { sink: "unsupported" };
      let id = "";
      let label = "default";
      if (name) {
        const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications");
        const n = String(name).trim().toLowerCase();
        const hit =
          outs.find((d) => d.label.trim().toLowerCase() === n) ??
          outs.find((d) => d.label.toLowerCase().includes(n) || (d.label && n.includes(d.label.trim().toLowerCase())));
        if (hit) {
          id = hit.deviceId;
          label = hit.label;
        }
      }
      const current = typeof ctx.sinkId === "string" ? ctx.sinkId : "";
      if (id === current && !reopen) return { sink: label, changed: false };
      const wasRunning = ctx.state === "running";
      if (id === current) await ctx.setSinkId({ type: "none" });
      await ctx.setSinkId(id);
      // (a change of device leaves the context suspended: the clock would stand still)
      if (wasRunning && ctx.state !== "running") await ctx.resume();
      return { sink: label, changed: true };
    },
    /** How loud the DJ's voice is, on top of its usual level (percent) */
    setVoiceVolume: ({ percent }) => {
      const v = Math.max(0, Math.min(1.5, (Number(percent) || 0) / 100));
      voiceTrim.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
      return {};
    },
    suspend: async () => (ctx.state === "running" && (await ctx.suspend()), {}),
    resume: async () => (ctx.state !== "running" && (await ctx.resume()), {}),

    /** Starts a deck on its own with a short fade-in */
    startAlone: ({ deck, track, pos, when, fade }) => {
      const b = getDeck(deck, track);
      const t = soon(when ?? 0, 0.08);
      b.fader.gain.setValueAtTime(0, t);
      b.fader.gain.linearRampToValueAtTime(1, t + (fade ?? 0.04));
      play(b, t, pos);
      return { start: t };
    },

    /** A planned transition from deck a to a new deck b. t0: when a reaches plan.aStart */
    transition: ({ a: aId, b: bId, track, plan, t0, stretchKey }) => {
      const a = decks.get(aId);
      if (!a) throw new Error("outgoing deck gone");
      const b = getDeck(bId, track);
      t0 = soon(t0);
      const D = plan.duration;
      const end = t0 + D;
      if (plan.kind === "blend") {
        const st = stretchKey && stretches.get(stretchKey);
        const beat = plan.period ?? 0.5;
        // Whole beats first: the incoming pattern onto the outgoing one's (claps on claps)
        const shift = (plan.beats ?? 0) >= 16 ? (st ? patternShift(a.buffer, plan.aStart, st.buffer, 0, beat, plan.beats) : patternShift(a.buffer, plan.aStart, b.buffer, plan.bStart, beat, plan.beats)) : 0;
        const skip = shift * beat;
        // Then the last milliseconds: measured on the audio that will actually play
        const nudge = st ? beatNudge(a.buffer, plan.aStart, st.buffer, skip, Math.min(D, 26)) : beatNudge(a.buffer, plan.aStart, b.buffer, plan.bStart + skip, Math.min(D, 26));
        const tb = Math.max(ctx.currentTime + 0.05, t0 - nudge);
        if (st) {
          playStretched(b, tb, st, skip);
          settleTrim(b, st, tb, skip);
        } else play(b, tb, plan.bStart + skip);
        const plannedBeat = Math.round((plan.bassSwap ?? D / 2) / beat);
        const swapBeat =
          D >= 12 * beat
            ? st
              ? bassSwapBeat(a.buffer, plan.aStart, st.buffer, skip, beat, D / beat, plannedBeat)
              : bassSwapBeat(a.buffer, plan.aStart, b.buffer, plan.bStart + skip, beat, D / beat, plannedBeat)
            : plannedBeat;
        const swap = t0 + Math.min(D - 0.05, swapBeat * beat);
        const half = Math.min(beat, D / 8);
        // Mids and highs cross over gradually across the whole window at constant loudness, as Spotify's
        // mixes do (measured from recordings: the level never dips or bumps through a transition): the
        // incoming track eases in under the outgoing one and they pass each other in the middle
        b.fader.gain.setValueAtTime(0, t0);
        b.fader.gain.setValueCurveAtTime(FADE_IN, t0, D);
        // ...except that the outgoing track stays up while the incoming one is still thin (see holdCurve)
        const nBeats = Math.max(4, Math.round(D / beat));
        const aCurve = st ? holdCurve(a.buffer, plan.aStart, st.buffer, skip, beat, nBeats) : holdCurve(a.buffer, plan.aStart, b.buffer, plan.bStart + skip, beat, nBeats);
        a.fader.gain.setValueAtTime(1, t0);
        a.fader.gain.setValueCurveAtTime(aCurve, t0, D);
        // The bass changes hands in one move, in the gap just before the bar line where no kick is
        // sounding: never two basslines at once, and never a moment with none (a slow swap measured as
        // a 6 dB hole in the low end)
        const swapFrom = Math.max(t0 + 0.02, swap - Math.min(0.09, beat * 0.2));
        const swapTo = swapFrom + 0.05;
        handBass(a, b, aCurve, t0, D, swapFrom, swapTo, end);
        // ...and what's left of the outgoing track is filtered up and away
        if (plan.style === "filter") {
          // Two dense songs: once its bass has been handed over, the outgoing one is thinned from below,
          // leaving room for the incoming one. Not before: sweeping a filter up through a bassline that
          // is still playing takes the bottom out of the mix, and reshapes the bass so that its peaks
          // come out up to twice as high (the limiter was pulling such blends down by 6 dB).
          if (swapTo < end - 0.5) {
            a.hp.frequency.setValueAtTime(HP_IDLE, swapTo);
            a.hp.frequency.exponentialRampToValueAtTime(150, swapTo + 0.3);
            a.hp.frequency.exponentialRampToValueAtTime(1200, end);
          }
        } else {
          // A gentle lift of the outgoing track's low-mids at the very end, as it leaves
          const sweepFrom = Math.max(swap + half, t0 + D * 0.8);
          if (sweepFrom < end - 0.2) {
            a.hp.frequency.setValueAtTime(HP_IDLE, sweepFrom);
            a.hp.frequency.exponentialRampToValueAtTime(20, sweepFrom + (end - sweepFrom) * 0.05);
            a.hp.frequency.exponentialRampToValueAtTime(500, end);
          }
        }
        makeRoom(a, b, t0, D / 2, end);
        stopSources(a, end);
        return { swap: t0 + plan.swapAt, end, bStart: tb, nudgeMs: Math.round(nudge * 10000) / 10, beatShift: shift, bassBeat: swapBeat };
      }
      if (plan.kind === "mashup") {
        // Two songs as one (see MASHUPS). `a` is the song that is playing, `b` the other one, which is
        // the one that is left at the end. It is a build and a drop: from T1, for `bars1` bars, one of
        // the two is heard over the other; on the line they end on (Tland), `b` lands, whole.
        const way = plan.way || "voice";
        const grid = plan.stems || {};
        const sr = ctx.sampleRate;
        const beat = plan.period;
        const bar = 4 * beat;
        const st = stretchKey && stretches.get(stretchKey);
        const first = Math.round(t0 * sr);
        t0 = first / sr;
        const T1 = t0 + plan.pre;
        const ease = 2 * beat;
        const build = Math.max(4, plan.bars1 || 8);
        const Tland = T1 + build * bar;
        const QUICK = 0.09;
        // How long the build is wound up for before it lands (two bars of an eight-bar one, four of sixteen)
        const windUp = Math.min(4, Math.max(2, build / 4)) * bar;
        /**
         * The playing song's voice alone, in step with the song sample on sample, through gains of its
         * own into each of `tos` (it arrives piece by piece: see the feeds). Turned over and played into
         * the deck itself it takes the voice out of the song, which leaves the band (and whatever the
         * deck does from then on, its fader, its EQ, it does to the band); played past the deck's fader
         * it is the voice again, on its own. `until`: when the song has gone.
         */
        const ownVoice = (tos, until) => {
          const m = a.map[a.map.length - 1];
          if (!m || m.rate !== 1) throw new Error("the playing song is still settling from its own transition");
          const zero = Math.round(m.t * sr) - Math.round(m.pos * sr);
          const gains = tos.map(({ to }) => {
            const g = ctx.createGain();
            g.gain.value = 0;
            g.connect(to);
            return g;
          });
          const feed = addFeed({ name: plan.stemsA, deck: a, frameOf: (s) => zero + s, parts: gains.map((g, i) => ({ which: tos[i].which || "voc", to: g })), grid: { seg: grid.seg, ...grid.a }, audible: T1 - ease, end: until });
          return { feed, levels: gains.map((g) => g.gain) };
        };
        /** The other song as it is (through its tempo-shifted lead-in if it has one), unheard until its fader says so */
        const whole = () => {
          if (st) {
            playStretched(b, t0, st);
            settleTrim(b, st, t0);
          } else play(b, t0, plan.bStart);
          b.fader.gain.setValueAtTime(0, t0);
        };
        /** A deck that is alone from T is back at its own level there and then (it sat a little lower while it shared the mix: see makeRoom) */
        const roomNow = (deck, T) => {
          const g = deck.post.gain;
          try {
            const from = Math.max(ctx.currentTime + 0.01, T - QUICK);
            if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(from);
            else g.cancelScheduledValues(from);
            g.linearRampToValueAtTime(1, Math.max(from + 0.02, T));
          } catch {}
        };
        /** A deck's low cut back to where it rests by T, from wherever a sweep of this mashup's has it (one under way, or to come) */
        const unsweep = (deck, T) => {
          const f = deck.hp.frequency;
          const from = ctx.currentTime + 0.02;
          try {
            if (f.cancelAndHoldAtTime) f.cancelAndHoldAtTime(from);
            else f.cancelScheduledValues(from);
            f.exponentialRampToValueAtTime(HP_IDLE, Math.max(from + 0.04, T));
          } catch {}
        };
        /** A band wound up into the landing at T: thinned from below over the bars before it, as far as `to` Hz, and itself again on the line */
        const wind = (deck, T, to) => {
          const from = Math.max(T - windUp, ctx.currentTime + 0.05);
          if (T - from < 0.5) return;
          deck.hp.frequency.setValueAtTime(HP_IDLE, from);
          deck.hp.frequency.exponentialRampToValueAtTime(20, from + (T - from) * 0.05);
          deck.hp.frequency.exponentialRampToValueAtTime(to, T - 0.01);
          deck.hp.frequency.setValueAtTime(HP_IDLE, T);
        };
        if (way === "layer") {
          liveMash = null;
          // Nobody sings. From T1 the other song's build goes on top of this one: everything of it but its
          // bass and the weight of its kick, over this song as it is. Over the last bars this song is thinned
          // from below, the way a DJ winds a record up, and on the line the other song lands: its bass with
          // it, at full level, and this one gone, all in one move.
          const ON_TOP = 0.84;
          whole();
          b.low.gain.setValueAtTime(BASS_CUT_DB, t0);
          b.fader.gain.setValueAtTime(0, T1);
          b.fader.gain.setValueCurveAtTime(
            FADE_IN.map((v) => v * ON_TOP),
            T1,
            2 * bar,
          );
          const swapFrom = Tland - Math.min(QUICK, beat * 0.2);
          const swapTo = swapFrom + 0.05;
          b.low.gain.setValueAtTime(BASS_CUT_DB, swapFrom);
          b.low.gain.linearRampToValueAtTime(0, swapTo);
          b.fader.gain.setValueAtTime(ON_TOP, swapFrom);
          b.fader.gain.linearRampToValueAtTime(1, swapTo);
          a.fader.gain.setValueAtTime(1, swapFrom);
          a.fader.gain.linearRampToValueAtTime(0, swapTo);
          wind(a, Tland, 900);
          makeRoom(a, b, T1, 2 * bar, Tland, 0.9);
          roomNow(b, Tland);
          stopSources(a, Tland + 0.1);
          // (what it does, for the log and the DJ's full-screen view: on top it is everything but the bass)
          lastArrangement = {
            said: [`${build} bars B's build on top of A`, "B lands"],
            cut: 0,
            halves: "bass",
            from: T1,
            end: Tland,
            land: Tland,
            planned: 1,
            per: build,
            bar,
            blocks: [{ from: T1, to: Tland, a: { top: 1, low: 1 }, b: { top: ON_TOP, low: 0 }, what: "B's build on top of A" }],
          };
          // Stopped while it plays, the listener having asked: on the next bar line two beats away or more, the one
          // song whole and the other gone
          const told = lastArrangement;
          let over = false;
          const stop = (keep) => {
            const t = ctx.currentTime;
            if (over) return { ok: false, why: "over" };
            if (t < T1 - beat) return { ok: false, why: "early" };
            const T = T1 + Math.max(0, Math.ceil((t + 2 * beat - T1) / bar - 1e-6)) * bar;
            // (not in its last bar, where it is landing by itself)
            if (T > Tland - bar + 1e-3) return { ok: false, why: "late" };
            over = true;
            const from = Math.max(t + 0.03, T - Math.max(2 * beat, Math.min(2 * bar, T - t - 0.05)));
            // What was still to come of it goes, and everything moves on from where it stands
            for (const p of [b.fader.gain, a.fader.gain, b.low.gain]) {
              try {
                if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(from);
                else p.cancelScheduledValues(from);
              } catch {}
            }
            unsweep(a, T);
            if (keep === "a") {
              b.fader.gain.linearRampToValueAtTime(0, T);
              stopSources(b, T + 0.1);
              // (it plays on to its own end: it was to stop where the mashup landed)
              for (const s of a.sources) {
                try {
                  s.stop(t + 86400);
                } catch {}
              }
              a.stopAt = Infinity;
              roomBack(a, T, a.post.gain.value);
            } else {
              const at = T - Math.min(QUICK, beat * 0.2);
              a.fader.gain.linearRampToValueAtTime(0, T);
              b.fader.gain.linearRampToValueAtTime(1, T);
              b.low.gain.setValueAtTime(BASS_CUT_DB, at);
              b.low.gain.linearRampToValueAtTime(0, at + 0.05);
              stopSources(a, T + 0.1);
              roomBack(b, T, 0.9);
            }
            told.said.push(`stopped ${Math.round((T - T1) / bar)} bars in: ${keep === "a" ? "A" : "B"} on its own`);
            told.blocks = told.blocks.filter((x) => x.from < T - 1e-3);
            for (const x of told.blocks) if (x.to > T) x.to = T;
            told.end = T;
            told.cut = T;
            told.stopped = keep;
            if (liveMash) liveMash.end = T;
            return { ok: true, keep, at: T, end: T };
          };
          liveMash = { flip: () => ({ ok: false, why: "one" }), stop, deck: b, end: Tland };
          return { swap: T1, end: Tland, bStart: t0, first: T1, mid: Tland, blocks: 1, per: build };
        }
        // A singer in one or both. For the build, one song's singer rides on the other song's band: which
        // way round (`bed`: the song whose band plays) the session chose, and it can be turned round while
        // the build lasts (see `flip`). It is made a block of eight bars at a time, because what is known
        // of the voices arrives as it goes: each block is decided as it comes up, by whether the singer
        // sings there (where it rests, the band plays on alone). Then the build is wound up (the band that
        // is on its way out thinned from below, or the other song's own bass held back until the line), and
        // on the line the other song lands: its band whole and at full level, its bass arriving in one move,
        // and the band that was playing gone. This song's singer either leaves there, the last of the line
        // ringing out over the drop, or, if it is still singing and the other song isn't, rides on over the
        // drop for eight bars more and leaves then.
        //   way "voice": both songs' voices have been taken out; "carry": only the playing song's (the
        //   other has no singer there, and plays as it is: there is only the one version)
        const both = way !== "carry";
        let bed = both && plan.bed !== "b" ? "a" : "b";
        const turns = both;
        // How far the other song's singer is moved in pitch to be in this song's key (cents: see shiftVoice
        // and the ways in mashMatch). This song's singer, over the other song's band, is moved as far the
        // other way. The two bands are then in different keys and are never heard together: see `go`.
        const cents = Math.round(plan.voiceCents || 0);
        if (plan.stemsA) void stemShift({ name: plan.stemsA, cents: -cents });
        if (both && plan.stemsB) void stemShift({ name: plan.stemsB, cents });
        const per = 8;
        const nBuild = Math.max(1, Math.round(build / per));
        const rideBars = plan.bars2 || 0;
        // (the song that was playing is kept running a bar past where its singer has left at the latest)
        const Tlast = Tland + rideBars * bar;
        const D = 2 * beat;
        const ta = tracks.get(a.trackId);
        const tb = tracks.get(b.trackId);
        const SUNG = 0.15;
        const VOICE_OVER_BAND = 0.55;
        const UNDER_A_VOICE = 0.85; // a band with the other song's singer over it sits a little lower
        const UNDER_A_RIDE = 0.92; // ...and a drop with a singer riding on it, less so
        // The other song's own bass is held back through the build where its drop wouldn't be one otherwise
        // (it lands on a line where its bass was there all along): the bass then arrives with the landing
        const holdBass = !!plan.hold;
        // A voice taken out of a record has some of the record's kick and bass left in it. Over its own
        // band that is where it belongs (voice and band add up to the song); over the other song's it
        // would be a second, fainter kick under the first, so there the voice is kept to where a voice is
        const VOICE_FROM = 90;
        const OPEN = 10;
        const voiceFilter = (to) => {
          const f = ctx.createBiquadFilter();
          f.type = "highpass";
          f.frequency.value = OPEN;
          f.Q.value = 0.7;
          f.connect(to);
          return f;
        };

        // The playing song is split where it stands: its voice out of the deck (which is then its band)
        // and back in past the fader, where it has a level of its own
        const backFilter = voiceFilter(a.post);
        const {
          feed: feedA,
          levels: [out, back],
        } = ownVoice([{ to: a.low }, { to: backFilter, which: cents ? "up" : "voc" }], Tlast + bar);
        // (where the key changes on that line, its own voice stays in the song up to it)
        out.setValueAtTime(0, cents && bed === "b" ? T1 - QUICK : T1 - ease);
        out.linearRampToValueAtTime(-1, T1);
        const zeroA = Math.round(a.map[a.map.length - 1].t * sr) - Math.round(a.map[a.map.length - 1].pos * sr);

        // How this song's singer leaves on a line: what it sang in the last beat before it comes round again
        // three quarters of a beat later, and again, each time fainter and thinner, over what follows (a
        // DJ's echo out). It goes out with the other song, which is what it rings out over.
        const echoIn = ctx.createGain();
        echoIn.gain.value = 0;
        {
          const delay = ctx.createDelay(2);
          delay.delayTime.value = 0.75 * beat;
          const hp = ctx.createBiquadFilter();
          hp.type = "highpass";
          hp.frequency.value = 350;
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.value = 4200;
          const again = ctx.createGain();
          again.gain.value = 0.5;
          const level = ctx.createGain();
          level.gain.value = 0.8;
          backFilter.connect(echoIn);
          echoIn.connect(delay).connect(hp).connect(lp).connect(level).connect(b.post);
          lp.connect(again).connect(delay);
        }
        const echoOut = (T) => {
          const from = Math.max(T - beat, ctx.currentTime + 0.03);
          if (T - from < 0.1) return;
          echoIn.gain.setValueAtTime(0, from);
          echoIn.gain.linearRampToValueAtTime(1, from + 0.03);
          echoIn.gain.setValueAtTime(1, T - 0.01);
          echoIn.gain.linearRampToValueAtTime(0, T + 0.02);
        };

        // The other song: its voice straight to the deck's output, its band through the deck's EQ and
        // fader (both silent until their turn, and started together a bar early); or, with no singer,
        // the song as it is
        let vox;
        let voxFilter;
        let voxOwn;
        let feedB;
        let startB = 0;
        if (both) {
          vox = ctx.createGain();
          vox.gain.value = 0;
          voxFilter = voiceFilter(b.post);
          vox.connect(voxFilter);
          // (moved in pitch, that is its singer over the other band only: with its own band it is as it is)
          if (cents) {
            voxOwn = ctx.createGain();
            voxOwn.gain.value = 0;
            voxOwn.connect(b.post);
          }
          // (They arrive piece by piece; a piece that isn't there in time plays as the song itself)
          const L = (grid.b.to - grid.b.from) * grid.seg;
          const tEnd = (first + L) / sr;
          startB = grid.b.base + grid.b.from * grid.seg;
          feedB = addFeed({
            name: plan.stemsB,
            deck: b,
            frameOf: (s) => first + (s - startB),
            parts: [{ which: cents ? "up" : "voc", to: vox }, { which: "inst", to: b.low }, ...(voxOwn ? [{ which: "voc", to: voxOwn }] : [])],
            grid: { seg: grid.seg, ...grid.b },
            whole: { buffer: st ? st.buffer : b.buffer, to: b.low },
            audible: T1 - ease,
            end: tEnd,
          });
          // ...and where the separated stretch ends, the song itself carries on from the very next sample:
          // what is left of its tempo-shifted lead-in if it has one, then the untouched track
          if (st) {
            if (L < st.spliceOut) source(b, st.buffer).start(tEnd, L / sr);
            const joinAt = (first + st.spliceOut) / sr;
            source(b, b.buffer).start(joinAt, st.spliceIn / sr);
            const hold = st.holdOut / sr;
            b.map = [
              { t: t0, pos: st.x0 / sr, rate: st.speed },
              { t: t0 + hold, pos: st.x0 / sr + st.speed * hold, rate: (st.speed + 1) / 2 },
              { t: joinAt, pos: st.spliceIn / sr, rate: 1 },
            ];
            settleTrim(b, st, t0, 0);
          } else {
            source(b, b.buffer).start(tEnd, (startB + L) / sr);
            b.map = [{ t: t0, pos: startB / sr, rate: 1 }];
          }
        } else whole();
        b.fader.gain.setValueAtTime(0, t0);
        // (the band that is out has no bass: it gets it when it comes in, in one move, as in a blend)
        b.low.gain.setValueAtTime(BASS_CUT_DB, t0);

        // What is known of a song's voice in the block that starts at T: of the seconds of it that have
        // been taken out so far, from a second before to three quarters of the way through, how many are
        // sung (the voice is SUNG of the sound or more), and how loud the voice is where it is
        const reach = per * bar * 0.75;
        const heardOf = (name, frameOf, T) => {
          const set = stemSets.get(name);
          let known = 0;
          let sung = 0;
          const levels = [];
          if (set) {
            for (const p of set.pieces.values()) {
              if (!p.share) continue;
              for (let j = 0; j < p.share.length; j++) {
                if (p.share[j] >= SUNG) levels.push(p.level[j]);
                const at = frameOf(p.from + j * sr) / sr;
                if (at < T - 1 || at > T + reach) continue;
                known++;
                if (p.share[j] >= SUNG) sung++;
              }
            }
          }
          levels.sort((x, y) => x - y);
          return { known, sung, level: levels.length ? levels[levels.length >> 1] : 0 };
        };
        const hintA = plan.sings ? plan.sings.a : undefined;
        const hintB = plan.sings ? plan.sings.b : undefined;
        /** Whether a song sings around T: by what has been heard of it there, or, of too little, by what was heard of it before the mashup was set */
        const sings = (h, hint) => (h.known >= 3 ? h.sung / h.known >= 0.35 : hint !== false);
        /**
         * Where a voice is put over the other song's band: a little over half as loud as that song in full
         * swing, which is where a singer sits in a record. Up by 6 dB at the most (what the separator left
         * of a faint voice doesn't bear more), and down as far as it takes: over a record mastered 8 dB
         * quieter than its own, a voice left as it was is all there is to hear. `rel`: how loud the band is
         * in the stretch it rides on, against that song in full swing: over a quiet build the voice comes
         * down with it, part of the way, so the build stays a build and the drop has somewhere to land.
         */
        const liftOf = (level, own, other, rel = 1) => (level > 0 && own && other ? Math.max(0.35, Math.min(2, (VOICE_OVER_BAND * other.loud * other.gain * Math.max(0.6, Math.min(1, rel))) / (level * own.gain))) : 1);
        /** How loud a stretch of a track is against the track in full swing (1: as loud; a build or a break is less) */
        const swingOf = (t, pos, seconds) => {
          const buffer = t && t.buffer;
          if (!buffer || !(t.loud > 0)) return 1;
          const ch = buffer.getChannelData(0);
          const from = Math.max(0, Math.round(pos * buffer.sampleRate));
          const to = Math.min(ch.length, Math.round((pos + seconds) * buffer.sampleRate));
          let sum = 0;
          let n = 0;
          for (let i = from; i < to; i += 7) {
            sum += ch[i] * ch[i];
            n++;
          }
          return n ? Math.sqrt(sum / n) / t.loud : 1;
        };
        /** ...of each of the two songs, in the block that starts at T */
        const swingA = (T) => swingOf(ta, positionAt(a, T), per * bar);
        const swingB = (T) => swingOf(tb, plan.bStart + (T - t0) * (plan.speed || 1), per * bar * (plan.speed || 1));
        /**
         * Up to when (on the clock) a feed's pieces are in place without a gap, from T on. The pieces are
         * made while the mashup plays, a little faster than they are used (see the session): if that ever
         * stops being so, this is where it shows.
         */
        const coverOf = (f, sampleAt, T) => {
          const g = f.grid;
          let i = Math.max(g.from, Math.floor((sampleAt(Math.round(T * sr)) - g.base) / g.seg));
          while (i < g.to && f.played.has(i) && !f.gone.has(i)) i++;
          return i >= g.to ? Infinity : f.frameOf(g.base + i * g.seg) / sr;
        };

        // Where everything stands (the gains as they were last sent, and what each voice is kept to),
        // and the moves from one block to the next
        // (va: this song's voice over the other band; vb: the other song's over this band, or, in one key,
        // with its own; wb: the other song's as it is, with its own band, where vb is moved in pitch;
        // bass: which of the two bands has its low end)
        const now = { fa: 1, fb: 0, va: 0, vb: 0, wb: 0, ha: OPEN, hb: OPEN, band: "a", bass: "a" };
        const said = [];
        // One control, moved: up to T over `span`, or (`after`) from T on. A move that catches another one
        // still under way (it is turned round as a block changes) takes over from where that one has got to.
        const moving = new Map();
        const move = (param, from, to, T, span, after = false) => {
          if (Math.abs(from - to) < 1e-4) return;
          const start = Math.max(after ? T : T - span, ctx.currentTime + 0.03);
          const end = after ? start + span : Math.max(T, start + 0.03);
          if ((moving.get(param) || 0) > start && param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(start);
          else param.setValueAtTime(from, start);
          param.linearRampToValueAtTime(to, end);
          moving.set(param, end);
        };
        /** A band on its way out, thinned from below over the span up to T (and itself again once it is silent) */
        const sweepOut = (deck, T, span) => {
          const from = Math.max(T - span, ctx.currentTime + 0.03);
          if (T - from < 0.4) return;
          deck.hp.frequency.setValueAtTime(HP_IDLE, from);
          deck.hp.frequency.exponentialRampToValueAtTime(20, from + (T - from) * 0.05);
          deck.hp.frequency.exponentialRampToValueAtTime(600, T);
          deck.hp.frequency.setValueAtTime(HP_IDLE, T + 0.25);
        };
        /** The low end goes to band `to` ("a", "b", or neither) in one move, just before the bar line at T */
        const bassTo = (to, T) => {
          if (to === now.bass) return;
          const from = Math.max(T - Math.min(QUICK, beat * 0.2), ctx.currentTime + 0.02);
          for (const [name, deck] of [["a", a], ["b", b]]) {
            if (name === to) {
              deck.low.gain.setValueAtTime(BASS_CUT_DB, from);
              deck.low.gain.linearRampToValueAtTime(0, from + 0.05);
            } else if (name === now.bass) {
              deck.low.gain.setValueAtTime(0, from);
              deck.low.gain.linearRampToValueAtTime(BASS_CUT_DB, from + 0.05);
            }
          }
          now.bass = to;
        };
        /**
         * Everything moves to where `next` has it, by T. How depends on what changes:
         *   - the same band plays on (a singer comes in, or rests): over `span`. A singer who rests fades
         *     after the line, not before it (`tail`): the end of the last line is heard
         *   - the other band takes over, in the same key: as two tracks are blended. It comes in under the
         *     one that is playing over the whole of `span`, that one leaves over the second half of it and
         *     the singers change with it, and the bass changes hands in one move on the line
         *   - the other band takes over and is in another key (a singer moved in pitch: see `cents`): the
         *     two can't be heard together. The band that is playing is thinned from below over `span`,
         *     and on the line everything changes at once
         *   - `land`: it is the landing. Everything changes on the line, at once, whatever the keys
         */
        const go = (T, next, span = D, tail = false, land = false) => {
          const swap = next.band !== now.band;
          const S = Math.max(0.05, Math.min(span, T - ctx.currentTime - 0.03));
          const jump = land || (swap && !!cents);
          if (jump && swap && !land) sweepOut(now.band === "a" ? a : b, T, S);
          const band = (deck, f0, f1) => move(deck.fader.gain, f0, f1, T, jump ? QUICK : swap && f1 < f0 ? S / 2 : S);
          const voice = (gain, filter, v0, v1, h0, h1) => {
            if (!gain) return;
            const late = !swap && !land && tail && v1 < v0;
            const s = jump ? QUICK : late ? bar : swap ? S / 2 : S;
            move(gain, v0, v1, T, s, late);
            if (filter) move(filter.frequency, h0, h1, T, s, late);
          };
          band(a, now.fa, next.fa);
          band(b, now.fb, next.fb);
          voice(back, backFilter, now.va, next.va, now.ha, next.ha);
          voice(vox && vox.gain, voxFilter, now.vb, next.vb, now.hb, next.hb);
          voice(voxOwn && voxOwn.gain, null, now.wb, next.wb);
          // (the bass goes with the band, in one move just before the bar line; the other song's is held back
          // through the build where it is to arrive with the landing)
          bassTo(next.band === "b" && holdBass && !land ? "none" : next.band, T);
          const bass = now.bass;
          Object.assign(now, next);
          now.bass = bass;
        };
        const WHOLE_B = { band: "b", fa: 0, fb: 1, va: 0, vb: cents ? 0 : 1, wb: cents ? 1 : 0, ha: OPEN, hb: OPEN };
        let lifted = 0;
        let over = false;
        /** It is over at T (the other song is on its own from there): what is still kept running of this song goes a bar later, once the last of its voice has rung out */
        const endAt = (T) => {
          arrangement.end = T + bar;
          told.end = T;
          feedA.end = T + bar;
          if (liveMash) liveMash.end = T;
          roomNow(b, T);
          stopSources(a, T + bar);
        };
        /**
         * The pieces have stopped arriving in time (something else took the processor): rather than
         * play on with voices missing, the mashup ends here, the way it would have ended anyway: on the
         * bar line at T the other song is whole.
         */
        const wrapUp = (T, k) => {
          over = true;
          if (now.va > 0) echoOut(T);
          go(T, WHOLE_B, QUICK, false, true);
          unsweep(b, T);
          said.push(`cut short after ${Math.round((T - T1) / bar)} of ${build + rideBars} bars (the voices weren't ready in time)`);
          told.cut = T;
          told.blocks.push({ from: T, to: T + bar, a: { top: 0, low: 0 }, b: { top: 1, low: 1 }, what: "cut short: the voices weren't ready in time", cut: true });
          endAt(T);
          void k;
        };
        /** Who sings in the block that starts at T */
        const heard = (T) => {
          const ha = heardOf(plan.stemsA, (s) => zeroA + s, T);
          const hb = both ? heardOf(plan.stemsB, (s) => first + (s - startB), T) : { known: 0, sung: 0, level: 0 };
          return { ha, hb, sa: sings(ha, hintA), sb: both && sings(hb, hintB) };
        };
        /** What the block of the build that starts at T is, the way round the mashup is now: where everything stands in it, and what to call it */
        const blockOf = (h, T) => {
          const next = { band: bed, fa: 0, fb: 0, va: 0, vb: 0, wb: 0, ha: OPEN, hb: OPEN };
          let what;
          if (bed === "a") {
            if (h.sb) {
              // the other song's singer over this song's band
              const lift = liftOf(h.hb.level || plan.voiceLevel || 0, tb, ta, swingA(T));
              lifted = Math.max(lifted, lift);
              next.vb = lift;
              next.hb = VOICE_FROM;
              next.fa = UNDER_A_VOICE;
              what = "B's voice over A's band";
            } else {
              next.fa = 1;
              what = "A's band (B's singer rests)";
            }
          } else if (h.sa) {
            // this song's singer over the other song's band
            const lift = liftOf(h.ha.level, ta, tb, swingB(T));
            lifted = Math.max(lifted, lift);
            next.va = lift;
            next.ha = VOICE_FROM;
            next.fb = UNDER_A_VOICE;
            what = "A's voice over B's band";
          } else {
            next.fb = 1;
            what = "B's band (A's singer rests)";
          }
          return { next, what };
        };
        const tell = (from, to, next, what, h, more) => told.blocks.push({ from, to, a: { top: next.va, low: next.fa }, b: { top: next.vb + next.wb, low: next.fb }, what, sings: { a: !!h.sa, b: !!h.sb }, ...more });
        // What is decided, in the order it comes up: every block of the build; the winding up; the landing;
        // and, if this song's singer rides on over the drop, where it leaves
        const steps = [];
        for (let k = 0; k < nBuild; k++) steps.push({ T: T1 + k * per * bar, lead: D, what: "build", k });
        steps.push({ T: Tland - windUp, lead: 0.2, what: "wind" });
        steps.push({ T: Tland, lead: beat + 0.2, what: "land" });
        if (rideBars) steps.push({ T: Tlast, lead: beat + 0.2, what: "leave" });
        steps.sort((x, y) => x.T - x.lead - (y.T - y.lead));
        let riding = false;
        let wound = false;
        const decide = (i) => {
          if (over) return;
          const step = steps[i];
          const T = step.T;
          if (step.what === "build") {
            // (a song that had no singer when the mashup was set is not waited for: its pieces are only made when there is time)
            if (step.k > 0 && Math.min(hintA === false ? Infinity : coverOf(feedA, (f) => f - zeroA, T), feedB ? coverOf(feedB, (f) => f - first + startB, T) : Infinity) < T + 1.5) return wrapUp(T, step.k);
            const h = heard(T);
            const { next, what } = blockOf(h, T);
            // (the other band is come to over the bar the other song has been running for at the start; a
            // singer who rests is let finish the line)
            go(T, next, next.band !== now.band ? (step.k === 0 ? Math.min(plan.pre, bar) : D) : D, true);
            said.push(`${per} bars ${what}`);
            tell(T, Math.min(Tland, T + per * bar), next, what, h);
          } else if (step.what === "wind") {
            // The build is wound up: the band that is about to go is thinned from below (this song's, under
            // the other's singer; or the other song's own, where its bass is being held back for the line)
            wound = true;
            if (now.band === "a") wind(a, Tland, 500);
            else if (holdBass) wind(b, Tland, 320);
          } else if (step.what === "land") {
            // The landing. This song's singer rides on over the other song's drop if it is still singing
            // there, the other song isn't, and its pieces are in place for it
            const h = heard(T);
            // (whether or not it sang in the last of the build: a chorus that starts on the line starts over the drop)
            riding = rideBars > 0 && now.band === "b" && h.ha.known >= 3 && h.sa && !(both && h.sb) && coverOf(feedA, (f) => f - zeroA, T) >= T + 0.6 * rideBars * bar;
            if (riding) {
              const lift = liftOf(h.ha.level, ta, tb);
              go(T, { ...WHOLE_B, fb: UNDER_A_RIDE, va: lift, ha: VOICE_FROM }, QUICK, false, true);
              said.push(`B lands; ${rideBars} bars A's voice over B's drop`);
              tell(T, Tlast, { ...WHOLE_B, va: lift }, "A's voice over B's drop", h);
            } else {
              if (now.va > 0) echoOut(T);
              go(T, WHOLE_B, QUICK, false, true);
              said.push("B lands");
              endAt(T);
            }
          } else if (riding) {
            echoOut(T);
            go(T, WHOLE_B, QUICK, false, true);
            said.push("A's voice leaves");
            endAt(T);
          }
        };
        /**
         * The other version, from the next bar line on: the band that was playing makes way for the
         * other song's, its bass with it, and the singer for the other song's. Only while the build is
         * not yet being wound up: after that there is the landing, and one song left to turn to.
         */
        let turning = 0;
        const flip = () => {
          const t = ctx.currentTime;
          if (!turns) return { ok: false, why: "one" };
          if (over || t < T1) return { ok: false, why: t < T1 ? "early" : "late" };
          if (t < turning) return { ok: false, why: "busy" };
          // The bar line it lands on: the next one that is two beats away or more. It starts turning at
          // once and is round on that line.
          let T = T1 + Math.ceil((t + 2 * beat - T1) / bar - 1e-6) * bar;
          let k = Math.floor((T - T1) / (per * bar) + 1e-9);
          const decided = (n) => steps.findIndex((s) => s.what === "build" && s.k === n) < arrangement.k;
          // (a block that starts on that line and has been set up already: its second bar line)
          if (Math.abs(T - (T1 + k * per * bar)) < 1e-3 && decided(k)) T += bar;
          k = Math.floor((T - T1) / (per * bar) + 1e-9);
          if (wound || T > Tland - windUp + 1e-3 || k >= nBuild) return { ok: false, why: "late" };
          bed = bed === "a" ? "b" : "a";
          told.bed = bed;
          const blockFrom = T1 + k * per * bar;
          // (the block that starts on that line hasn't been decided yet: it starts the other way round)
          if (Math.abs(T - blockFrom) < 1e-3 && !decided(k)) return said.push("turned round"), (turning = T), { ok: true, bed, at: T };
          const h = heard(blockFrom);
          const { next, what } = blockOf(h, blockFrom);
          go(T, next, Math.max(2 * beat, Math.min(2 * bar, T - t - 0.05)));
          turning = T;
          said.push(`turned round: ${what}`);
          const before = told.blocks[told.blocks.length - 1];
          if (before && before.to > T) before.to = T;
          tell(T, Math.min(Tland, blockFrom + per * bar), next, what, h, { turned: true });
          return { ok: true, bed, at: T };
        };
        /**
         * Stopped while it plays, the listener having asked: it ends on the next bar line two beats away or more, with
         * one of the two songs left, whole, and the other gone.
         *   "b": the other song, its band and its singer, as the mashup would have ended: on the line, everything at once
         *   "a": the song that was playing, as if there had been no mashup: its band back and the other song's band and
         *        singer away, and its own singer back in the song itself; it plays on to its own end
         */
        const stop = (keep) => {
          const t = ctx.currentTime;
          if (over) return { ok: false, why: "over" };
          if (t < T1 - ease) return { ok: false, why: "early" };
          // (the line it lands on, as for turning it round; not in the last bar before it is over by itself)
          const T = T1 + Math.max(0, Math.ceil((t + 2 * beat - T1) / bar - 1e-6)) * bar;
          if (T > told.end - bar + 1e-3) return { ok: false, why: "late" };
          over = true;
          const S = Math.max(2 * beat, Math.min(2 * bar, T - t - 0.05));
          // Whatever is still to come of it goes (the next block, if it has been decided; a turn round on its way, its
          // bass not yet changed hands; the winding up; the echo), and everything moves on from where it stands: read
          // off the controls themselves, which a change still under way has somewhere between where it was and where it
          // is going
          const held = [
            [a.fader.gain, "fa"],
            [b.fader.gain, "fb"],
            [back, "va"],
            [backFilter.frequency, "ha"],
            ...(vox ? [[vox.gain, "vb"], [voxFilter.frequency, "hb"]] : []),
            ...(voxOwn ? [[voxOwn.gain, "wb"]] : []),
            [a.low.gain],
            [b.low.gain],
            [echoIn.gain],
          ];
          for (const [p, k] of held) {
            try {
              if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t + 0.02);
              else p.cancelScheduledValues(t + 0.02);
            } catch {}
            if (k) now[k] = p.value;
            moving.delete(p);
          }
          try {
            echoIn.gain.setValueAtTime(0, t + 0.03);
          } catch {}
          now.band = now.fa >= now.fb ? "a" : "b";
          now.bass = a.low.gain.value > -6 ? "a" : b.low.gain.value > -6 ? "b" : "none";
          const was = { ...now };
          unsweep(a, T);
          unsweep(b, T);
          if (keep === "b") {
            if (was.band === "b" || !cents) go(T, WHOLE_B, S);
            else go(T, WHOLE_B, QUICK, false, true);
            bassTo("b", T);
          } else {
            go(T, { band: "a", fa: 1, fb: 0, va: was.va, vb: 0, wb: 0, ha: was.ha, hb: OPEN }, S);
            bassTo("a", T);
            // Its own singer, back in the song itself. Where it was over the other band, the voice laid there makes way
            // on the line for the same voice in the song: only its level is heard to change, back to where it is in the
            // song (in two keys that voice was moved, and it goes with everything else, at once on the line). Where the
            // other song's singer was over this band, it comes back as that one leaves.
            if (was.band === "b") {
              const span = cents ? QUICK : beat;
              move(out, -1, 0, T, span, !cents);
              move(back, was.va, 0, T, span, !cents);
            } else move(out, -1, 0, T, Math.max(0.05, Math.min(S, T - T1 - 0.01)));
          }
          said.push(`stopped ${Math.round((T - T1) / bar)} of ${build + (riding ? rideBars : 0)} bars in: ${keep === "a" ? "A" : "B"} on its own`);
          // (the full screen shows what was played of it, and no more)
          told.blocks = told.blocks.filter((x) => x.from < T - 1e-3);
          for (const x of told.blocks) if (x.to > T) x.to = T;
          told.end = T;
          told.cut = T;
          told.stopped = keep;
          arrangement.end = T;
          if (liveMash) liveMash.end = T;
          if (keep === "b") {
            feedA.end = T;
            // (it sat a little lower to make room for the other song: back to where it belongs, now that it is alone)
            roomBack(b, T, 0.9);
            stopSources(a, T + 0.1);
          } else {
            const done = T + (cents ? 0 : beat) + 0.5;
            feedA.end = done;
            if (feedB) feedB.end = done;
            stopSources(b, T + 0.1);
            // ...and it plays on to its own end (it was to stop where the mashup ended; a source's last stop is the one it keeps)
            for (const s of a.sources) {
              try {
                s.stop(t + 86400);
              } catch {}
            }
            a.stopAt = Infinity;
            // (it went down to 0.9 over the two bars from T1 - ease: see makeRoom below)
            roomBack(a, T, Math.max(0.9, 1 - (0.1 * Math.max(0, T - (T1 - ease))) / (2 * bar)));
          }
          return { ok: true, keep, at: T, end: T };
        };
        // (everything after the first block is decided as it comes up: see watchFeeds)
        const told = { said, cut: 0, halves: "voice", from: T1, end: Tlast, land: Tland, flipUntil: Tland - windUp - bar, planned: nBuild + (rideBars ? 1 : 0), per, bar, bed, flippable: turns, blocks: [] };
        const arrangement = { k: 1, blocks: steps.length, at: (i) => steps[i].T - steps[i].lead - 0.5, decide, said, deck: b, other: a, end: Tlast + bar, told };
        liveMash = { flip, stop, deck: b, end: Tlast };
        makeRoom(a, b, T1 - ease, 2 * bar, Tlast, 0.9);
        stopSources(a, Tlast + bar);
        decide(0);
        arrangers.push(arrangement);
        lastArrangement = told;
        if (!feedTimer) feedTimer = setInterval(watchFeeds, 150);

        // (for the log: how far the first voice was brought up, and over what)
        const levels = ta && tb && plan.voiceLevel > 0 && now.vb > 0 && now.fa < 1 ? { voice: plan.voiceLevel * tb.gain * now.vb * 0.9, band: ta.loud * ta.gain * UNDER_A_VOICE * 0.9 } : undefined;
        return { swap: T1, end: Tlast, bStart: t0, first: T1 - ease, mid: Tland, lift: lifted, levels, blocks: told.planned, per, bed };
      }
      if (plan.kind === "fade") {
        play(b, t0, plan.bStart);
        b.fader.gain.setValueAtTime(0, t0);
        b.fader.gain.setValueCurveAtTime(FADE_IN, t0, D);
        a.fader.gain.setValueAtTime(1, t0);
        a.fader.gain.setValueCurveAtTime(FADE_OUT, t0, D);
        makeRoom(a, b, t0, D / 2, end);
        stopSources(a, end);
        return { swap: t0 + plan.swapAt, end, bStart: t0 };
      }
      if (plan.kind === "drop") {
        // Tempos too far apart to blend, so the two never play together: the outgoing track leaves over
        // the beats before a bar line, and the incoming one lands on that line at full level
        const g = a.fader.gain;
        const OUT = 0.03; // the very end is faded, so the cut can't click
        // A deck still inside its own tempo-shifted lead-in changes sources on a schedule: no braking it
        const last = a.map[a.map.length - 1];
        const settled = !!last && last.t <= t0 && last.rate === 1;
        const move = plan.move === "brake" && !settled ? "sweep" : plan.move;
        // (A deck that has only just been mixed in may still be on its way up: that ends here)
        if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t0);
        g.linearRampToValueAtTime(1, t0 + 0.02);
        if (move === "brake") {
          // A record brought to a stop: slower and lower until it stands still, quieter as it goes
          for (const s of a.sources) {
            s.playbackRate.setValueAtTime(1, t0);
            s.playbackRate.linearRampToValueAtTime(0.03, end);
          }
          g.setValueAtTime(1, t0 + D * 0.45);
          g.linearRampToValueAtTime(0, end);
        } else {
          // Filtered up and away: the bass goes first, then the body, until only the top is left. The
          // level comes down a little with it, since a filter moving through a bassline makes its peaks taller.
          a.hp.frequency.setValueAtTime(HP_IDLE, t0);
          a.hp.frequency.exponentialRampToValueAtTime(70, t0 + Math.min(0.15, D * 0.06));
          a.hp.frequency.exponentialRampToValueAtTime(3600, end);
          a.hp.Q.setValueAtTime(0.7, t0);
          a.hp.Q.linearRampToValueAtTime(1.5, end);
          g.linearRampToValueAtTime(0.75, t0 + D * 0.3);
          g.setValueAtTime(0.75, end - OUT);
          g.linearRampToValueAtTime(0, end);
        }
        stopSources(a, end);
        const bStart = t0 + plan.bAt;
        b.fader.gain.setValueAtTime(1, bStart);
        play(b, bStart, plan.bStart);
        return { swap: bStart, end, bStart, move };
      }
      fadeOutAt(a, t0, 0.04);
      const bStart = t0 + plan.bAt;
      b.fader.gain.setValueAtTime(0, bStart);
      b.fader.gain.linearRampToValueAtTime(1, bStart + 0.02);
      play(b, bStart, plan.bStart);
      return { swap: bStart, end: t0 + 0.04, bStart };
    },

    /**
     * The DJ talks. Optionally drops deck `a` under the voice and fades it out; speaks `clip`; optionally
     * brings deck `b` in around the end of the line (see bringIn). With `jingle` (a style of it), its signature
     * comes first (in the key `tonic`, `minor` or not, see jingleIn), unless the line before had it a moment ago.
     */
    talk: async ({ a: aId, t0, clip: clipKey, b: bId, track, pos, intro, jingle, tonic, minor, sure, cents }) => {
      const a = aId ? decks.get(aId) : undefined;
      // (made before anything is timed: the first time in a key that takes a moment)
      const sting = jingle ? await jingleIn(jingle, tonic, minor, sure, cents).catch(() => null) : null;
      t0 = soon(t0 ?? 0, 0.08);
      let voiceStart = t0;
      if (a) {
        const remaining = Math.max(0.8, a.buffer.duration - positionAt(a, t0));
        duckOut(a, t0, remaining);
        voiceStart = t0 + LEAD;
      }
      stopVoice(0.04);
      voiceStart += 0.06;
      let jingleAt;
      if (sting && jingleDue(jingle, voiceStart)) {
        // (After the voice's way out is open again, see stopVoice; where the music was already sent
        // down for it, see dipMusic and duckAll, that is JINGLE_IN into the music going down)
        jingleAt = Math.max(ctx.currentTime + 0.1, voiceStart - toVoice(jingle), a ? t0 + JINGLE_IN : 0);
        playJingle(jingleAt, sting, voiceGain(voiceStart, track));
        voiceStart = Math.max(voiceStart, jingleAt + toVoice(jingle));
        jingledFor = onTheWall(voiceStart);
      }
      const voiceEnd = speak(clipKey, voiceStart, track);
      const out = { voiceStart, voiceEnd, voice: spoken.voice, music: spoken.music, under: under(voiceStart, track), jingle: jingleAt };
      if (bId) out.start = bringIn(getDeck(bId, track), pos, intro, voiceStart, voiceEnd);
      return out;
    },
    /** Starts a deck around a line that's already being spoken */
    bringIn: ({ b, track, pos, intro, voiceStart, voiceEnd }) => ({ start: bringIn(getDeck(b, track), pos, intro, voiceStart, voiceEnd) }),

    kill: ({ deck, fade }) => {
      const d = decks.get(deck);
      if (d) killDeck(d, fade ?? 0.1);
      return {};
    },
    dispose: ({ deck }) => {
      const d = decks.get(deck);
      if (d) disposeDeck(d);
      return {};
    },
    stopVoice: ({ fade }) => (stopVoice(fade ?? 0.12), {}),
    /**
     * All music down under a line of `seconds` from the DJ, from `at` (or now), and back up after it.
     * Returns when the line should start: a moment into the music going down, or, with `jingle`, once
     * the DJ's signature has had its turn (see talk).
     */
    dipMusic: async ({ seconds, at, jingle, tonic, minor, sure, cents }) => {
      if (jingle) await jingleIn(jingle, tonic, minor, sure, cents).catch(() => null);
      const g = music.gain;
      const t = Math.max(ctx.currentTime + 0.03, at ?? 0);
      const lead = jingleDue(jingle, t + LEAD) ? JINGLE_IN + toVoice(jingle) : LEAD;
      const level = under(t);
      const from = musicAt(t);
      holdAt(g, t);
      g.setValueAtTime(from, t);
      glide(g, from, level, t + 0.002, DOWN);
      const back = Math.max(t + DOWN + 0.01, t + lead + seconds);
      glide(g, level, 1, back, UP);
      musicMoves = musicMoves.filter((m) => m.t < t);
      musicMoves.push({ t: t + 0.002, d: DOWN, from, to: level }, { t: back, d: UP, from: level, to: 1 });
      if (musicMoves.length > 8) musicMoves = musicMoves.slice(-8);
      return { voiceAt: t + lead };
    },
    /**
     * Everything down under the voice from now on (a goodbye, or a line with nothing to mix out of). Returns
     * when the line should start. Each deck goes down on its way out, after its fader: that takes a voice
     * taken out for a mashup with it (which joins the deck there). Its fader stays where it has got to (a
     * song that was on its way out stops leaving: it is what is under the line), and a mashup under way
     * is no longer arranged, which would move the faders again.
     */
    duckAll: async ({ jingle, tonic, minor, sure, cents }) => {
      if (jingle) await jingleIn(jingle, tonic, minor, sure, cents).catch(() => null);
      const now = ctx.currentTime + 0.03;
      const level = under(now);
      arrangers.length = 0;
      for (const d of decks.values()) {
        // (not one that is down under a line already, nor one that is being cut off this very moment)
        if (d.ducked || d.stopAt < now + 0.3) continue;
        d.ducked = true;
        holdAt(d.fader.gain, now);
        const g = d.post.gain;
        const v = g.value;
        holdAt(g, now);
        g.setValueAtTime(v, now);
        glide(g, v, v * level, now + 0.002, DOWN);
      }
      return { voiceAt: now + (jingleDue(jingle, now + LEAD) ? JINGLE_IN + toVoice(jingle) : LEAD) };
    },
    /** Has the jingle made in a key before it is needed */
    jinglePrep: ({ jingle, tonic, minor, sure, cents }) => {
      if (jingle) jingleIn(jingle, tonic, minor, sure, cents).catch(() => null);
      return {};
    },
    killAll: ({ fade }) => {
      for (const d of decks.values()) killDeck(d, fade ?? 0.12);
      stopVoice(fade ?? 0.12);
      return {};
    },
    /**
     * A track's waveform for the DJ's full-screen view: how loud it is, `rate` times a second, as the
     * loudest sample (peak) and the average power (rms) of each slice, both 0-255. Worked out once a track.
     */
    waveform: ({ id, rate }) => {
      const t = tracks.get(id);
      if (!t) throw new Error("track not loaded: " + id);
      const r = Math.max(5, Math.min(50, rate || 20));
      if (t.wave && t.wave.rate === r) return t.wave;
      const buffer = t.buffer;
      const step = buffer.sampleRate / r;
      const n = Math.floor(buffer.length / step);
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      const peak = new Array(n);
      const rms = new Array(n);
      let top = 1e-9;
      const raw = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * step);
        const b = Math.min(buffer.length, Math.floor((i + 1) * step));
        let p = 0;
        let sq = 0;
        for (const ch of chans)
          for (let k = a; k < b; k += 2) {
            const v = ch[k];
            const m = v < 0 ? -v : v;
            if (m > p) p = m;
            sq += v * v;
          }
        raw[i * 2] = p;
        raw[i * 2 + 1] = Math.sqrt(sq / Math.max(1, ((b - a) / 2) * chans.length));
        if (p > top) top = p;
      }
      for (let i = 0; i < n; i++) {
        peak[i] = Math.round(Math.min(1, raw[i * 2] / top) * 255);
        rms[i] = Math.round(Math.min(1, (raw[i * 2 + 1] / top) * 1.3) * 255);
      }
      t.wave = { rate: r, peak, rms };
      return t.wave;
    },
    /** What this mixer holds: its decks and the tracks loaded in it. For a session that picks it up after TIDAL's page was away (see CARRIED OVER in mixer.native.ts) */
    inventory: () => ({
      // (how loud it is set, 0-1: the page that comes back doesn't know your volume yet, this still does)
      volume,
      decks: [...decks.values()].map((d) => ({ ref: d.id, track: d.trackId })),
      // (resting: its audio is put aside at half the size, see TRACKS AT REST)
      tracks: [...tracks.entries()].map(([id, t]) => ({ id, duration: t.duration, resting: !t.audio })),
    }),
  };

  window.__mixer = {
    call: async (method, args) => {
      try {
        wake(method, args);
        const result = await ops[method](args || {});
        const deckInfo = {};
        for (const d of decks.values()) deckInfo[d.id] = { map: d.map, stopAt: d.stopAt === Infinity ? null : d.stopAt, gain: d.fader.gain.value };
        return JSON.stringify({
          ok: true,
          result,
          now: ctx ? ctx.currentTime : 0,
          running: ctx ? ctx.state === "running" : false,
          // How long after being scheduled a sample is actually heard
          latency: ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + limiterDelay : 0,
          decks: deckInfo,
          level: outMeter ? rms(outMeter) : 0,
          voice: voiceMeter && voices.size ? Math.min(1, rms(voiceMeter) * 3.2) : 0,
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String((err && err.message) || err), now: ctx ? ctx.currentTime : 0, running: ctx ? ctx.state === "running" : false });
      }
    },
  };
})();
