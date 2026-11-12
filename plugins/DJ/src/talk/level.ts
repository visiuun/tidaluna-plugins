// How the DJ's voice is made to carry over music. A voice straight from the speech model has peaks far
// above its body (some 15 dB): brought up until the peaks reach full scale, the words themselves still
// sit well under a mastered record, and the quiet ends of them vanish under even a turned-down song.
// So it's treated the way a radio voice is: a lift where consonants live, the loud syllables pressed
// towards the quiet ones, then the whole line brought up to a fixed level with the last peaks caught.

/** The level of the speaking itself (not the pauses) that every line comes out at. The mixer knows this figure too */
export const VOICE_LEVEL = 0.32;
const CEILING = 0.97;

/** RMS of the parts where someone is speaking: everything within 26 dB of the loudest 20 ms */
export const spokenLevel = (x: Float32Array, rate: number) => {
  const block = Math.max(1, Math.round(rate * 0.02));
  const powers: number[] = [];
  for (let i = 0; i + block <= x.length; i += block) {
    let s = 0;
    for (let j = i; j < i + block; j++) s += x[j] * x[j];
    powers.push(s / block);
  }
  let top = 0;
  for (const p of powers) if (p > top) top = p;
  let sum = 0;
  let count = 0;
  for (const p of powers) {
    if (p > top * 0.0025) {
      sum += p;
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
};

/** A bell-shaped lift of `db` around `hz` (in place) */
const lift = (x: Float32Array, rate: number, hz: number, db: number, q: number) => {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * hz) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha / A;
  const b0 = (1 + alpha * A) / a0;
  const b1 = (-2 * Math.cos(w)) / a0;
  const b2 = (1 - alpha * A) / a0;
  const a2 = (1 - alpha / A) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - b1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
};

/** Presses what is above `threshold` towards it by `ratio` (in place): fast to act, slow to let go, so words keep their shape */
const press = (x: Float32Array, rate: number, threshold: number, ratio: number) => {
  const attack = Math.exp(-1 / (rate * 0.0005));
  const release = Math.exp(-1 / (rate * 0.11));
  const ahead = Math.round(rate * 0.002);
  const power = 1 / ratio - 1;
  let env = 0;
  const gains = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    env = v > env ? attack * env + (1 - attack) * v : release * env + (1 - release) * v;
    gains[i] = env > threshold ? (env / threshold) ** power : 1;
  }
  // (the gain is read a moment ahead, so it's already down when the syllable arrives)
  for (let i = 0; i < x.length; i++) x[i] *= gains[Math.min(x.length - 1, i + ahead)];
};

/** Holds every peak under `ceiling` (in place) without clipping any: the gain dips ahead of the peak and comes back after it */
const limit = (x: Float32Array, rate: number, ceiling: number) => {
  const n = x.length;
  const L = Math.max(1, Math.round(rate * 0.002));
  const need = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(x[i]);
    need[i] = v > ceiling ? ceiling / v : 1;
    if (v > ceiling) any = true;
  }
  if (!any) return { share: 0, deepest: 1 };
  // The lowest gain needed anywhere in the next L samples, then its average over the last L: never above what any sample needs
  const low = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 1;
    const end = Math.min(n, i + L + 1);
    for (let j = i; j < end; j++) if (need[j] < m) m = need[j];
    low[i] = m;
  }
  let sum = 0;
  let touched = 0;
  let deepest = 1;
  for (let i = 0; i < n; i++) {
    sum += low[i];
    if (i >= L) sum -= low[i - L];
    const g = Math.min(low[i], sum / Math.min(i + 1, L));
    if (g < 0.999) touched++;
    if (g < deepest) deepest = g;
    x[i] *= g;
  }
  return { share: touched / n, deepest };
};

/** A line of speech, made to carry over music and brought to the level every line has (in place). Returns what it did, for the log and tests */
export const carry = (x: Float32Array, rate: number) => {
  const before = spokenLevel(x, rate);
  if (!(before > 1e-5)) return { before, after: before, limited: 0, deepest: 1 };
  lift(x, rate, 3100, 3, 0.8);
  // Pressed from 10 dB under the speaking level: the body of each word comes up to where its loudest
  // syllable was. The level it is then brought to is as high as a voice goes before the limiter is
  // heard working: it acts on a few samples in a hundred (measured on 54 lines); 2 dB more and it is a
  // fifth of them. What makes the voice louder still against a song is the song going down, not this.
  press(x, rate, spokenLevel(x, rate) * 0.3, 4);
  const pressed = spokenLevel(x, rate);
  const gain = VOICE_LEVEL / pressed;
  for (let i = 0; i < x.length; i++) x[i] *= gain;
  const limited = limit(x, rate, CEILING);
  return { before, after: spokenLevel(x, rate), limited: limited.share, deepest: limited.deepest };
};
