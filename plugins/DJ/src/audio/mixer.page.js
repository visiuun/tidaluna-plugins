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
  // Where a deck's filter rests when it isn't sweeping: far enough below the music to leave bass alone
  const HP_IDLE = 1;
  const curve = (fn, n = 96) => Float32Array.from({ length: n }, (_, i) => fn(i / (n - 1)));
  const FADE_IN = curve((x) => Math.sin((x * Math.PI) / 2));
  const FADE_OUT = curve((x) => Math.cos((x * Math.PI) / 2));

  let ctx, music, voice, voiceHp, master, outMeter, voiceMeter;
  let volume = 1;
  const tracks = new Map(); // id → { buffer, gain }
  const stretches = new Map(); // key → { buffer, x0, speed, holdOut, spliceOut, spliceIn }
  const clips = new Map(); // key → AudioBuffer
  const decks = new Map(); // id → deck
  const voices = new Set();

  // ------------------ DSP WORKER ------------------
  let worker;
  let dsp;
  let dspSource = "";
  let nextJob = 0;
  const jobs = new Map();
  const runDsp = (msg, direct) => {
    if (worker === undefined) {
      try {
        worker = new Worker(URL.createObjectURL(new Blob([dspSource], { type: "text/javascript" })));
        worker.onmessage = (e) => {
          const j = jobs.get(e.data.id);
          if (!j) return;
          jobs.delete(e.data.id);
          if (e.data.error) j.reject(new Error(e.data.error));
          else j.resolve(e.data.result);
        };
        worker.onerror = () => {
          worker = null;
          for (const j of jobs.values()) j.reject(new Error("DSP worker failed"));
          jobs.clear();
        };
      } catch {
        worker = null;
      }
    }
    if (worker) {
      return new Promise((resolve, reject) => {
        const id = nextJob++;
        jobs.set(id, { resolve, reject });
        worker.postMessage({ ...msg, id });
      }).catch((err) => {
        if (worker) throw err;
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
    // Two tracks overlapping can exceed full scale, so the way out goes through a limiter. It must do
    // nothing at all to a track playing on its own: the first one here (Web Audio's compressor, set just
    // under full scale) was pulling every loud hit of an ordinary track down by 2-4 dB, which is heard as
    // the sound pumping. This one looks 5 ms ahead and only moves when a peak would actually go over.
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
        processorOptions: { lookahead: LOOKAHEAD, ceiling: 0.985, release: 0.12 },
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
    // The level is set so the track's highest sample stays clear of full scale: measured here, on the
    // audio as decoded (the peak TIDAL reports for a track can be a little under what actually comes out),
    // so that a track playing on its own never reaches the limiter
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > peak) peak = v;
      }
    }
    gain = Math.min(gain, 0.95 / Math.max(peak, 0.05));
    const t2 = performance.now();
    let analysis;
    if (analyse) analysis = await analyseBuffer(buffer, hintBpm);
    tracks.set(id, { buffer, gain });
    return { duration: buffer.duration, analysis, ms: { fetch: Math.round(t1 - t0), decode: Math.round(t2 - t1), analyse: Math.round(performance.now() - t2) } };
  };

  const unload = ({ id }) => {
    tracks.delete(id);
    for (const [key, st] of stretches) if (st.id === id) stretches.delete(key);
    return {};
  };

  /** Tempo-shifted lead-in for a blend (see dsp.js) */
  const stretch = async ({ key, id, x0, speed, holdOut, glideOut }) => {
    if (stretches.has(key)) return { cached: true };
    const t = tracks.get(id);
    if (!t) throw new Error("track not loaded");
    const buffer = t.buffer;
    const lead = 2048;
    const from = Math.max(0, Math.floor(x0) - lead);
    const need = Math.ceil(Math.max(speed, 1) * (holdOut + glideOut) + 8192 + 4096) + lead;
    const to = Math.min(buffer.length, from + need);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice(from, to));
    const local = x0 - from;
    const sr = buffer.sampleRate;
    const r = await runDsp({ type: "stretch", channels, sr, x0: local, speed, holdOut, glideOut }, (d) => d.stretch(channels, sr, local, speed, holdOut, glideOut));
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

  const clip = ({ key, pcm, rate, gainedPcm }) => {
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
    hp.frequency.value = HP_IDLE;
    hp.Q.value = 0.7;
    const fader = ctx.createGain();
    const trim = ctx.createGain();
    trim.gain.value = t.gain;
    low.connect(hp).connect(fader).connect(trim).connect(music);
    const deck = { id, trackId, buffer: t.buffer, low, hp, fader, trim, sources: [], map: [], stopAt: Infinity };
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
  const play = (deck, when, pos) => {
    source(deck, deck.buffer).start(when, Math.max(0, pos));
    deck.map = [{ t: when, pos, rate: 1 }];
  };
  const playVarispeed = (deck, when, pos, speed, hold) => {
    const s = source(deck, deck.buffer);
    s.playbackRate.setValueAtTime(speed, when);
    s.playbackRate.setValueAtTime(1, when + hold);
    s.start(when, Math.max(0, pos));
    deck.map = [
      { t: when, pos, rate: speed },
      { t: when + hold, pos: pos + speed * hold, rate: 1 },
    ];
  };
  /** `skip`: seconds of the tempo-shifted lead-in to leave out at the start (joining it a beat or more in) */
  const playStretched = (deck, when, st, skip = 0) => {
    const sr = deck.buffer.sampleRate;
    source(deck, st.buffer).start(when, skip);
    const joinAt = when + st.spliceOut / sr - skip;
    source(deck, deck.buffer).start(joinAt, st.spliceIn / sr);
    const hold = Math.max(0, st.holdOut / sr - skip);
    deck.map = [
      { t: when, pos: st.x0 / sr + st.speed * skip, rate: st.speed },
      { t: when + hold, pos: st.x0 / sr + st.speed * (hold + skip), rate: (st.speed + 1) / 2 },
      { t: joinAt, pos: st.spliceIn / sr, rate: 1 },
    ];
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

  // ------------------ VOICE ------------------
  const speak = (key, when) => {
    const buffer = clips.get(key);
    if (!buffer) throw new Error("clip not loaded");
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(voiceHp);
    s.start(when);
    voices.add(s);
    s.onended = () => {
      voices.delete(s);
      s.disconnect();
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
    tail = Math.max(0.8, Math.min(tail, 6.5));
    // Starting right now (the DJ button): pick up from wherever the fader is
    const from = t0 - ctx.currentTime < 0.25 ? g.value : 1;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(from, t0);
    g.linearRampToValueAtTime(0.3 * from, t0 + 0.45);
    g.setValueCurveAtTime(
      FADE_OUT.map((v) => v * 0.3 * from),
      t0 + 0.45,
      tail,
    );
    const end = t0 + 0.45 + tail;
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
      const BED = 0.3;
      g.setValueAtTime(0, start);
      g.linearRampToValueAtTime(BED, start + 0.5);
      g.setValueAtTime(BED, voiceEnd - 0.15);
      g.linearRampToValueAtTime(1, voiceEnd + 0.45);
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
        const speed = plan.speed ?? 1;
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
          // A tempo-shifted lead-in peaks a little higher than the track itself (its waves are redrawn
          // between the original samples). Rather than have the limiter shave those peaks all the way
          // through it, the deck sits that much lower, and comes back up over twelve seconds once the
          // untouched track has taken over.
          const full = b.trim.gain.value;
          const k = Math.max(0.7, Math.min(1, 0.98 / ((st.peak || 1) * full)));
          if (k < 0.995) {
            const joinAt = tb + st.spliceOut / st.buffer.sampleRate - skip;
            b.trim.gain.setValueAtTime(full * k, tb);
            b.trim.gain.setValueAtTime(full * k, joinAt);
            b.trim.gain.linearRampToValueAtTime(full, joinAt + 12);
          }
        } else if (Math.abs(speed - 1) > 1e-5 && Math.abs(speed - 1) <= 0.003) playVarispeed(b, tb, plan.bStart + skip * speed, speed, D);
        else play(b, tb, plan.bStart + skip);
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
        b.low.gain.setValueAtTime(BASS_CUT_DB, t0);
        b.low.gain.setValueAtTime(BASS_CUT_DB, swapFrom);
        b.low.gain.linearRampToValueAtTime(0, swapTo);
        a.low.gain.setValueAtTime(0, swapFrom);
        a.low.gain.linearRampToValueAtTime(BASS_CUT_DB, swapTo);
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
        stopSources(a, end);
        return { swap: t0 + plan.swapAt, end, bStart: tb, nudgeMs: Math.round(nudge * 10000) / 10, beatShift: shift, bassBeat: swapBeat };
      }
      if (plan.kind === "fade") {
        play(b, t0, plan.bStart);
        b.fader.gain.setValueAtTime(0, t0);
        b.fader.gain.setValueCurveAtTime(FADE_IN, t0, D);
        a.fader.gain.setValueAtTime(1, t0);
        a.fader.gain.setValueCurveAtTime(FADE_OUT, t0, D);
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
        } else if (move === "dive") {
          // Closed down from the top until only a rumble is left, as if heard through a wall. The filter
          // is put in for this move only, and passes everything untouched until the move starts.
          const top = ctx.sampleRate / 2;
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.value = top;
          lp.Q.value = 0.7;
          a.fader.disconnect(a.trim);
          a.fader.connect(lp).connect(a.trim);
          lp.frequency.setValueAtTime(top, t0);
          lp.frequency.exponentialRampToValueAtTime(9000, t0 + D * 0.08);
          lp.frequency.exponentialRampToValueAtTime(180, end);
          lp.Q.setValueAtTime(0.7, t0);
          lp.Q.linearRampToValueAtTime(1.3, end);
          g.setValueAtTime(1, end - OUT);
          g.linearRampToValueAtTime(0, end);
          setTimeout(() => lp.disconnect(), Math.max(0, end - ctx.currentTime + 1) * 1000);
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
        voiceStart = t0 + 0.35;
      }
      stopVoice(0.04);
      voiceStart += 0.06;
      const voiceEnd = speak(clipKey, voiceStart);
      const out = { voiceStart, voiceEnd };
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
    /** All music down to `level` for `seconds`, then back up (a quick word from the DJ over the music) */
    dipMusic: ({ level, seconds, at }) => {
      const g = music.gain;
      const t = Math.max(ctx.currentTime, at ?? 0);
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
      else {
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
      }
      g.linearRampToValueAtTime(level, t + 0.25);
      g.setValueAtTime(level, t + 0.25 + seconds);
      g.linearRampToValueAtTime(1, t + 0.25 + seconds + 0.6);
      return {};
    },
    /** Everything down to `level` right now (under a goodbye) */
    duckAll: ({ level }) => {
      const now = ctx.currentTime;
      for (const d of decks.values()) {
        const g = d.fader.gain;
        const v = g.value;
        g.cancelScheduledValues(now);
        g.setValueAtTime(v, now);
        g.linearRampToValueAtTime(v * level, now + 0.4);
      }
      return {};
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
          voice: voiceMeter && voices.size ? Math.min(1, rms(voiceMeter) * 5) : 0,
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String((err && err.message) || err), now: ctx ? ctx.currentTime : 0, running: ctx ? ctx.state === "running" : false });
      }
    },
  };
})();
