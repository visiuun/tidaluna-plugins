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

  let ctx, music, voice, voiceHp, master, outMeter, voiceMeter;
  let volume = 1;
  const tracks = new Map(); // id → { buffer, gain }
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
    voiceHp.connect(voice).connect(limiter);
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
    tracks.set(id, { buffer, gain, loud: loudness(buffer) });
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
  const source = (deck, buffer) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(deck.low);
    deck.sources.push(s);
    return s;
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
  const makeRoom = (a, b, from, ease, until, room = 0.944) => {
    a.post.gain.setValueAtTime(1, from);
    a.post.gain.linearRampToValueAtTime(room, from + ease);
    b.post.gain.setValueAtTime(room, from);
    b.post.gain.setValueAtTime(room, until);
    b.post.gain.linearRampToValueAtTime(1, until + ROOM_BACK);
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
  const killDeck = (deck, fade) => {
    const g = deck.fader.gain;
    const now = ctx.currentTime;
    try {
      const v = g.value;
      g.cancelScheduledValues(now);
      g.setValueAtTime(v, now);
      g.linearRampToValueAtTime(0, now + fade);
    } catch {}
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
  // A mashup is two songs at once, each giving what the other leaves room for. Which part comes from
  // which depends on who sings in the stretch where they meet:
  //   - the other song sings: its singer comes in over the song that is playing (which loses its own, if
  //     it has one), phrase on phrase, in the same key and on the same beat; after a while the other
  //     song's band comes in underneath (the bass changes hands, as in a blend) and it carries on as itself
  //   - only the playing song sings: the bands change over underneath its singer, who carries on over the
  //     other song's band for a while before giving way to it
  //   - nobody sings: the other song plays on top of this one's bass and drums, then the bass changes
  //     hands and this song is the one on top, until it leaves
  //
  // The voices are taken out of both songs by a neural network in a page of its own (see stems.js): this
  // page hands it a stretch of sound and gets the voice back. The band is then the sound minus the voice,
  // so voice and band always add up to exactly the song. What has to be right is the pairing: that the
  // one song's notes fit the other's, bar by bar, that the drums land together, and that both are in
  // tune. That is measured here, on the audio itself.
  //
  // Taking a voice out takes about half as long as the stretch lasts, and a mashup needs it of two songs,
  // for as long as the mashup lasts. Done before it starts, that is a minute and more of waiting, by
  // which time the song is nearly over. So it is done in pieces of a few seconds, and the mashup starts
  // once the first ones are there: each piece is put in its place, to the sample, as it arrives, the
  // work staying ahead of the playing (see the feeds, below). A piece that doesn't make it in time is
  // done without: of the song coming in, that stretch plays whole; of the one playing, its voice stays.
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
      set = { id: key ? stretches.get(key).id : id, pieces: new Map() };
      stemSets.set(name, set);
      while (stemSets.size > 6) stemSets.delete(stemSets.keys().next().value);
    }
    const piece = { from: from + skip, n, voc, inst };
    set.pieces.set(index, piece);
    for (const f of feeds) if (f.name === name) playPiece(f, index, piece);
    return { seconds: n / sr, voice: Array.from(ev, (e, k) => (es[k] > 1e-7 ? Math.round(Math.sqrt(e / es[k]) * 100) / 100 : 0)) };
  };
  const stemDrop = ({ name }) => (stemSets.delete(name), {});

  // A feed is one song's separated pieces going into a mashup that is already scheduled:
  //   { name, deck, frameOf(sample of the track) → frame of the output it is heard at,
  //     parts: [{ which: "voc" | "inst", to: node }], grid: { base, seg, from, to } (piece i is `seg`
  //     samples from base + i * seg; pieces from..to are wanted), whole?: { buffer, to } (what plays
  //     instead of a piece that isn't there in time), end: when it is over, played, late, missed }
  let feedTimer = 0;
  const playPiece = (f, index, piece) => {
    if (f.played.has(index) || index < f.grid.from || index >= f.grid.to) return;
    const sr = ctx.sampleRate;
    let frame = f.frameOf(piece.from);
    let offset = 0;
    const soonest = Math.round((ctx.currentTime + 0.08) * sr);
    // (how long before it is heard the piece got here: the least of those says how close the race was)
    f.spare = Math.min(f.spare, (frame - soonest) / sr);
    if (frame < soonest) {
      // (Late: it joins in where the song has got to, on the sample)
      offset = soonest - frame;
      frame = soonest;
      f.late++;
    }
    f.played.add(index);
    if (offset >= piece.n) return;
    for (const part of f.parts) {
      const buffer = piece[part.which];
      if (!buffer) continue;
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(part.to);
      f.deck.sources.push(s);
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
    for (let k = feeds.length - 1; k >= 0; k--) {
      const f = feeds[k];
      const set = stemSets.get(f.name);
      if (now > f.end + 1 || decks.get(f.deck.id) !== f.deck) {
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
          f.missed++;
          const soonest = Math.round((now + 0.08) * sr);
          const offset = Math.max(0, soonest - frame);
          if (offset >= f.grid.seg) continue;
          frame += offset;
          const s = ctx.createBufferSource();
          s.buffer = f.whole.buffer;
          s.connect(f.whole.to);
          f.deck.sources.push(s);
          s.start(frame / sr, (from + offset) / sr, (f.grid.seg - offset) / sr);
        }
      }
      // (What has been heard is let go of: a piece is some megabytes)
      if (set) for (const [i, p] of set.pieces) if (f.frameOf(p.from + p.n) / sr < now - 0.5) set.pieces.delete(i);
    }
    if (!feeds.length) {
      clearInterval(feedTimer);
      feedTimer = 0;
    }
  };
  const addFeed = (f) => {
    f.played = new Set();
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
  const feedState = () => ({ feeds: feeds.map((f) => ({ name: f.name, wanted: f.grid.to - f.grid.from, played: f.played.size, late: f.late, missed: f.missed, spare: f.spare === Infinity ? null : Math.round(f.spare * 10) / 10 })) });

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
   * Finds how track `b` best goes on top of track `a`, and how good that is.
   *   A, B: { period, bar0 (a bar line), phrase (which of every four bars starts a phrase), from, last }
   *         (positions in seconds: where the mashup may start in A, and where each track's music ends)
   *   free: the second track may be moved in pitch and tempo to fit (it was asked for by name); without
   *         it, only pairs that fit as they are will do
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

    // Ways to bring B to A's tempo: as it is when the tempos are close (its pitch moves with it, by a
    // hair), or, for a track asked for by name, moved to a pitch that fits with the tempo made up separately
    const ways = [];
    const natural = 1200 * Math.log2(R);
    {
      const k = Math.round((tuneB + natural - tuneA) / 100);
      const off = tuneB + natural - tuneA - 100 * k;
      if (Math.abs(off) <= 14 && Math.abs(k) <= (free ? 2 : 0) && (free || Math.abs(R - 1) <= 0.012)) ways.push({ k, pitch: R, joins: 0, off });
    }
    if (free) {
      for (let k = -2; k <= 2; k++) {
        const pitch = Math.pow(2, (100 * k + tuneA - tuneB) / 1200);
        const joins = R / pitch - 1;
        if (Math.abs(joins) > 0.08 || ways.some((w) => w.k === k && Math.abs(joins) < 0.004)) continue;
        ways.push({ k, pitch, joins, off: 0 });
      }
    }
    const detail = { tempo: [60 / A.period, 60 / B.period], tuning: [Math.round(pa.tuning), Math.round(pb.tuning)], clarity: [pa.clarity, pb.clarity].map((v) => Math.round(v * 100) / 100), ms: [Math.round(profiled - began), 0] };
    if (!ways.length) {
      const why = Math.abs(R - 1) > (free ? 0.21 : 0.012) ? "tempo" : "tuning";
      return { ok: false, why, ...detail };
    }

    // Every bar of both, on their own grids
    const nA = Math.max(0, Math.floor((A.last - A.bar0) / barA));
    const nB = Math.max(0, Math.floor((B.last - B.bar0) / barB));
    const barsA = barsOf(pa, A.bar0, barA, nA);
    let barsB = barsOf(pb, B.bar0, barB, nB);
    const full = { ab: fullLevel(barsA, "eb"), at: fullLevel(barsA, "et"), bb: fullLevel(barsB, "eb"), bt: fullLevel(barsB, "et") };

    // Where A can be joined: the next phrase lines from `from` on
    const firstA = Math.max(0, Math.ceil((A.from - A.bar0) / barA - 1e-6));
    const startsA = [];
    for (let i = firstA; i < nA && startsA.length < (A.starts || 4); i++) if ((((i - A.phrase) % 4) + 4) % 4 === 0) startsA.push(i);
    if (!startsA.length) return { ok: false, why: "ending", ...detail };

    // The two drum patterns have to sit on each other: if B's is clearly a beat or more round from where
    // its bar lines were put, its bar lines move
    let shift = 0;
    {
      const i0 = startsA[0];
      const j0 = Math.max(0, Math.min(nB - 20, Math.round((B.body - B.bar0) / barB)));
      const span = Math.min(12, nA - i0, nB - j0 - 1);
      if (span >= 4) {
        const shifted = [0, 1, 2, 3].map((sft) => barsOf(pb, B.bar0 + j0 * barB + sft * B.period, barB, span));
        const scores = shifted.map((bars) => {
          let sum = 0;
          for (let i = 0; i < span; i++) sum += stepFit(barsA[i0 + i].snap, bars[i].snap) + 0.6 * stepFit(barsA[i0 + i].kick, bars[i].kick);
          return sum / span;
        });
        let best = 0;
        for (let k = 1; k < 4; k++) if (scores[k] > scores[best]) best = k;
        if (best && scores[best] > 0.35 && scores[best] - scores[0] > 0.3) {
          shift = best;
          barsB = barsOf(pb, B.bar0 + shift * B.period, barB, nB - 1);
        }
        detail.pattern = scores.map((v) => Math.round(v * 100) / 100);
      }
    }
    const bar0B = B.bar0 + shift * B.period;

    // One half: the bottom of one track under the top of the other, bar by bar. A bar where either part
    // is missing (a break) adds nothing.
    const half = (i, j, n, k, aBelow) => {
      let sum = 0;
      for (let x = 0; x < n; x++) {
        const ba = barsA[i + x];
        const bb = barsB[j + x];
        if (!ba || !bb) return null;
        const w = aBelow ? Math.min(presence(ba.eb, full.ab), presence(bb.et, full.bt)) : Math.min(presence(bb.eb, full.bb), presence(ba.et, full.at));
        sum += w * (aBelow ? noteFit(ba.bass, bb.top, 0, k) : noteFit(bb.bass, ba.top, k, 0));
      }
      return sum / n;
    };
    // How well a track's own bass and top agree, which is the most any mashup of it could score
    const own = (bars, eb, et) => {
      let sum = 0;
      let n = 0;
      for (const bar of bars) {
        if (presence(bar.eb, eb) < 1 || presence(bar.et, et) < 1) continue;
        sum += noteFit(bar.bass, bar.top, 0, 0);
        n++;
      }
      return n >= 8 ? sum / n : 0;
    };
    const self = [own(barsA, full.ab, full.at), own(barsB, full.bb, full.bt)];

    const bodyBar = Math.round((B.body - bar0B) / barB);
    let best = null;
    const byWay = [];
    for (const way of ways) {
      // B's voice over A's band for n1 bars, then n2 for the bands to change over: the longest that fits
      let top = null;
      for (const [n1, n2] of [[24, 8], [16, 8], [12, 4], [8, 4]]) {
        for (let ai = 0; ai < startsA.length; ai++) {
          const i = startsA[ai];
          // (A has to last through it, with a bar to spare)
          if (A.bar0 + (i + n1 + n2 + 1) * barA > A.last) continue;
          for (let j = 0; j + n1 + n2 < barsB.length; j++) {
            if ((((j - B.phrase) % 4) + 4) % 4 !== 0) continue;
            // (B carries on alone afterwards: it should have a good while left to be itself, a minute at
            // the least, half of which it needs to find its way back to its own tempo)
            if (bar0B + (j + n1 + n2) * barB + 60 > B.last) break;
            // (B starts a bar early, unheard, so it needs that bar)
            if (bar0B + j * barB < barB + 0.1) continue;
            // (What has to fit is what is heard together: B's notes on A's bass, while B sings over A)
            const s1 = half(i, j, n1, way.k, true);
            const s2 = 0;
            if (s1 === null || !barsB[j + n1 + n2 - 1] || !barsA[i + n1 + n2 - 1]) continue;
            // The sooner the better (in this song, and in the other, which then has more left to play
            // afterwards); a longer mashup is worth a little; so is coming in where one of the other
            // song's sections starts (every eight or sixteen bars from where its intro ends)
            const fit = s1;
            const fromBody = j - bodyBar;
            const section = fromBody >= 0 && fromBody % 16 === 0 ? 0.02 : fromBody >= 0 && fromBody % 8 === 0 ? 0.01 : 0;
            const score = fit - 0.012 * ai - 0.0006 * j + section + 0.0015 * (n1 + n2) - 0.03 * Math.abs(way.k) - 1.2 * Math.abs(way.joins) - 0.004 * Math.max(0, Math.abs(way.off) - 5);
            if (!top || score > top.score) top = { score, fit, s1, s2, i, j, n1, n2, way };
          }
        }
        if (top) break;
      }
      if (top) {
        byWay.push({ k: way.k, joins: Math.round(way.joins * 1000) / 10, fit: Math.round(top.fit * 100) / 100 });
        if (!best || top.score > best.score) best = top;
      }
    }
    detail.self = self.map((v) => Math.round(v * 100) / 100);
    detail.ways = byWay;
    if (!best) return { ok: false, why: "room", ...detail };

    // What that fit is worth against the other eleven keys B could have been in: a real match stands out
    const others = [];
    for (let k = 1; k < 12; k++) {
      others.push(half(best.i, best.j, best.n1, best.way.k + k, true));
    }
    others.sort((x, y) => x - y);
    const median = (others[5] + others[4]) / 2;
    const beaten = others.filter((v) => v < best.fit).length;

    // Drums on drums across it
    let rhythm = 0;
    {
      const n = best.n1 + best.n2;
      for (let x = 0; x < n; x++) rhythm += 0.5 * stepFit(barsA[best.i + x].kick, barsB[best.j + x].kick) + 0.5 * stepFit(barsA[best.i + x].snap, barsB[best.j + x].snap);
      rhythm /= n;
    }

    // The last milliseconds, and the tempo to the last hundredth of a percent: where the drums of both
    // actually hit at the start, the middle and the end of it
    const aPos = A.bar0 + best.i * barA;
    let bPos = bar0B + best.j * barB;
    let speed = R;
    const span = (best.n1 + best.n2) * barA;
    const lags = [];
    try {
      const W = Math.min(14, span / 2);
      for (const off of [0, (span - W) / 2, span - W]) {
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
    const way = best.way;
    detail.ms[1] = Math.round(performance.now() - profiled);
    return {
      ok: true,
      fit: best.fit,
      halves: [best.s1, best.s2],
      median,
      beaten,
      self,
      rhythm,
      semitones: way.k,
      // (As it is: the pitch simply follows the speed. Moved: the pitch stays where it was put)
      pitch: way.joins === 0 ? speed : way.pitch,
      joins: way.joins === 0 ? 0 : speed / way.pitch - 1,
      speed,
      off: way.off,
      bars1: best.n1,
      bars2: best.n2,
      aPos,
      bPos,
      shift,
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
    stemOut,
    stemIn,
    stemDrop,
    feedState,
    clip,
    status: () => ({}),
    setVolume: ({ percent, muted }) => {
      volume = muted ? 0 : Math.max(0, Math.min(1, percent / 100));
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(volume, ctx.currentTime, 0.015);
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
        // Two songs at once (see MASHUPS). `a` is the song that is playing, `b` the other one, which is
        // the one that is left at the end.
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
          const gains = tos.map((to) => {
            const g = ctx.createGain();
            g.gain.value = 0;
            g.connect(to);
            return g;
          });
          addFeed({ name: plan.stemsA, deck: a, frameOf: (s) => zero + s, parts: gains.map((g) => ({ which: "voc", to: g })), grid: { seg: grid.seg, ...grid.a }, end: until });
          return gains.map((g) => g.gain);
        };
        /** The other song as it is (through its tempo-shifted lead-in if it has one), unheard until its fader says so */
        const whole = () => {
          if (st) {
            playStretched(b, t0, st);
            settleTrim(b, st, t0);
          } else play(b, t0, plan.bStart);
          b.fader.gain.setValueAtTime(0, t0);
        };
        if (way === "carry") {
          // Only the playing song sings. From T1 the bands change over underneath its singer, as two
          // tracks do in a blend; from T2 the singer is over the other song's band alone; over the last
          // bar the singer leaves, and from T3 the other song is on its own.
          const T2 = T1 + plan.bars2 * bar;
          const T3 = T2 + plan.bars1 * bar;
          // The song is split where it stands: its voice out of the deck and back in past the fader, in
          // the same moment, so that nothing is heard of it
          const [out, back] = ownVoice([a.low, a.post], T3);
          out.setValueAtTime(0, T1 - ease);
          out.linearRampToValueAtTime(-1, T1);
          back.setValueAtTime(0, T1 - ease);
          back.linearRampToValueAtTime(1, T1);
          whole();
          const D = T2 - T1;
          b.fader.gain.setValueAtTime(0, T1);
          b.fader.gain.setValueCurveAtTime(FADE_IN, T1, D);
          a.fader.gain.setValueAtTime(1, T1);
          a.fader.gain.setValueCurveAtTime(FADE_OUT, T1, D);
          const swap = T1 + Math.max(1, Math.round(plan.bars2 / 2)) * bar;
          const swapFrom = swap - Math.min(0.09, beat * 0.2);
          handBass(a, b, FADE_OUT, T1, D, swapFrom, swapFrom + 0.05, T2);
          back.setValueAtTime(1, T3 - bar);
          back.linearRampToValueAtTime(0, T3);
          makeRoom(a, b, T1, 2 * bar, T3, 0.9);
          stopSources(a, T3);
          return { swap: T1, end: T3, bStart: t0, first: T1, mid: T2 };
        }
        if (way === "layer") {
          // Nobody sings. From T1 the other song comes in on top: everything of it but its bass and the
          // weight of its kick, over this song as it is. At T2 the bass changes hands in one move, as in
          // a blend, and it is this song that is on top, leaving over the bars up to T3.
          const T2 = T1 + plan.bars1 * bar;
          const T3 = T2 + plan.bars2 * bar;
          const ON_TOP = 0.84;
          whole();
          b.low.gain.setValueAtTime(BASS_CUT_DB, t0);
          b.fader.gain.setValueAtTime(0, T1);
          b.fader.gain.setValueCurveAtTime(
            FADE_IN.map((v) => v * ON_TOP),
            T1,
            2 * bar,
          );
          const swapFrom = T2 - Math.min(0.09, beat * 0.2);
          const swapTo = swapFrom + 0.05;
          b.low.gain.setValueAtTime(BASS_CUT_DB, swapFrom);
          b.low.gain.linearRampToValueAtTime(0, swapTo);
          a.low.gain.setValueAtTime(0, swapFrom);
          a.low.gain.linearRampToValueAtTime(BASS_CUT_DB, swapTo);
          b.fader.gain.setValueAtTime(ON_TOP, T2);
          b.fader.gain.linearRampToValueAtTime(1, T2 + bar);
          a.fader.gain.setValueAtTime(1, T2);
          a.fader.gain.linearRampToValueAtTime(ON_TOP, T2 + bar);
          a.fader.gain.setValueCurveAtTime(
            FADE_OUT.map((v) => v * ON_TOP),
            T2 + bar + 0.002,
            T3 - T2 - bar - 0.004,
          );
          makeRoom(a, b, T1, 2 * bar, T3, 0.9);
          stopSources(a, T3);
          return { swap: T1, end: T3, bStart: t0, first: T1, mid: T2 };
        }
        // The other song sings. From T1 the playing song loses its singer (if it has one) and the other
        // one's sings over it; from T2 the other song's band comes in underneath while this song's
        // leaves; from T3 the other song is whole and on its own.
        const T2 = T1 + plan.bars1 * bar;
        const T3 = T2 + plan.bars2 * bar;
        {
          const [out] = ownVoice([a.low], T3);
          out.setValueAtTime(0, T1 - ease);
          out.linearRampToValueAtTime(-1, T1);
        }
        // The other song comes as two parts of one deck: its voice straight to the deck's output, its
        // band through the deck's EQ and fader, silent until its turn. Both start together, a bar early.
        const vox = ctx.createGain();
        vox.gain.value = 0;
        vox.connect(b.post);
        vox.gain.setValueAtTime(0, T1 - ease);
        vox.gain.linearRampToValueAtTime(1, T1);
        // (They arrive piece by piece; a piece that isn't there in time plays as the song itself)
        const L = (grid.b.to - grid.b.from) * grid.seg;
        const tEnd = (first + L) / sr;
        const startB = grid.b.base + grid.b.from * grid.seg;
        addFeed({
          name: plan.stemsB,
          deck: b,
          frameOf: (s) => first + (s - startB),
          parts: [
            { which: "voc", to: vox },
            { which: "inst", to: b.low },
          ],
          grid: { seg: grid.seg, ...grid.b },
          whole: { buffer: st ? st.buffer : b.buffer, to: b.low },
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
        // The bands change over the way two tracks do in a blend: the incoming one up, the outgoing one
        // down, the bass from one to the other in the middle
        const D = T3 - T2;
        b.fader.gain.setValueAtTime(0, t0);
        b.fader.gain.setValueAtTime(0, T2);
        b.fader.gain.setValueCurveAtTime(FADE_IN, T2, D);
        a.fader.gain.setValueAtTime(1, T2);
        a.fader.gain.setValueCurveAtTime(FADE_OUT, T2, D);
        const swap = T2 + Math.max(1, Math.round(plan.bars2 / 2)) * bar;
        const swapFrom = swap - Math.min(0.09, beat * 0.2);
        handBass(a, b, FADE_OUT, T2, D, swapFrom, swapFrom + 0.05, T3);
        makeRoom(a, b, T1 - ease, 2 * bar, T3, 0.9);
        stopSources(a, T3);
        return { swap: T1, end: T3, bStart: t0, first: T1 - ease, mid: T2 };
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
     * brings deck `b` in around the end of the line (see bringIn).
     */
    talk: ({ a: aId, t0, clip: clipKey, b: bId, track, pos, intro }) => {
      const a = aId ? decks.get(aId) : undefined;
      t0 = soon(t0 ?? 0, 0.08);
      let voiceStart = t0;
      if (a) {
        const remaining = Math.max(0.8, a.buffer.duration - positionAt(a, t0));
        duckOut(a, t0, remaining);
        voiceStart = t0 + LEAD;
      }
      stopVoice(0.04);
      voiceStart += 0.06;
      const voiceEnd = speak(clipKey, voiceStart, track);
      const out = { voiceStart, voiceEnd, voice: spoken.voice, music: spoken.music, under: under(voiceStart, track) };
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
     * Returns when the line should start: a moment into the music going down.
     */
    dipMusic: ({ seconds, at }) => {
      const g = music.gain;
      const t = Math.max(ctx.currentTime + 0.03, at ?? 0);
      const level = under(t);
      const from = musicAt(t);
      holdAt(g, t);
      g.setValueAtTime(from, t);
      glide(g, from, level, t + 0.002, DOWN);
      const back = Math.max(t + DOWN + 0.01, t + LEAD + seconds);
      glide(g, level, 1, back, UP);
      musicMoves = musicMoves.filter((m) => m.t < t);
      musicMoves.push({ t: t + 0.002, d: DOWN, from, to: level }, { t: back, d: UP, from: level, to: 1 });
      if (musicMoves.length > 8) musicMoves = musicMoves.slice(-8);
      return { voiceAt: t + LEAD };
    },
    /** Everything down under the voice from now on (a goodbye, or a line with nothing to mix out of). Returns when the line should start */
    duckAll: () => {
      const now = ctx.currentTime + 0.03;
      const level = under(now);
      for (const d of decks.values()) {
        const g = d.fader.gain;
        const v = g.value;
        holdAt(g, now);
        g.setValueAtTime(v, now);
        glide(g, v, v * level, now + 0.002, DOWN);
      }
      return { voiceAt: now + LEAD };
    },
    killAll: ({ fade }) => {
      for (const d of decks.values()) killDeck(d, fade ?? 0.12);
      stopVoice(fade ?? 0.12);
      return {};
    },
  };

  window.__mixer = {
    call: async (method, args) => {
      try {
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
