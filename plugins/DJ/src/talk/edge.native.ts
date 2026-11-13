// The online voice: the lines are read by the voices of Microsoft Edge's "read aloud", the service the browser itself
// uses. Nothing runs on this machine for it (the local voice costs a processor's worth of work for every line, which a
// game takes away from it), and a line is usually back within a few seconds. What is sent is the text of the line.
//
// The service is Edge's own and isn't offered for anything else: it wants a token only the browser is meant to know
// how to make, and that has changed before. So nothing may depend on it: whatever goes wrong here is an error to the
// caller, which has the local voice say the line instead (see voice.ts).
import { createHash, randomBytes, randomUUID } from "crypto";
import { request } from "https";
import type { Socket } from "net";

const CLIENT = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE = "143.0.3650.75";
const EDGE_MAJOR = EDGE.split(".")[0];
const HOST = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`;
/** MP3 is all it gives out (no plain samples): at this rate there is nothing left to hear of that in a voice */
const FORMAT = "audio-24khz-96kbitrate-mono-mp3";
// The audio of a long line comes at about the pace it is spoken (a short one in a second), so what is waited for is
// the next piece, not the whole
const QUIET_MS = 10_000;
const WHOLE_MS = 60_000;

// ------------------ THE TOKEN ------------------
// Made from the time (to five minutes) and the client's name, by a hash of the service's own: SHA-256 with some of its
// constants changed and its first block worked in ahead, and a 64-bit checksum keyed by the result. Worked out by the
// edge-tts project (github.com/rany2/edge-tts, drm.py), which this follows; the numbers are the service's.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const SCHEDULE = [0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564];
const ADJUSTMENT = 0xc9dc06a7;
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS: Array<[number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS_FACTOR = 0x82893933;
const CS_ADJUSTMENT0 = 0xf2f90b1a;
const CS_ADJUSTMENT1 = 0x0b1a0000;

const u = (x: number) => x >>> 0;
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
const sigma0 = (x: number) => u(rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3));
const sigma1 = (x: number) => u(rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10));
const rol16 = (x: number) => u((x << 16) | (x >>> 16));
const mul = (a: number, b: number) => u(Math.imul(a, b));

/** SHA-256's rounds over the words `w`, from round `first` (14: resuming inside the block worked in ahead, which has a constant of its own) */
const rounds = (state: number[], w: number[], first = 0) => {
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const k = first === 14 && i === 14 ? ADJUSTMENT : K[i];
    const t1 = u(h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (g ^ (e & (f ^ g))) + k + w[i]);
    const t2 = u((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b))));
    h = g;
    g = f;
    f = e;
    e = u(d + t1);
    d = c;
    c = b;
    b = a;
    a = u(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
};
const expand = (w: number[], first = 16) => {
  for (let i = first; i < 64; i++) w.push(u(sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]));
};
const bigEndian = (bytes: Uint8Array, at: number, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + bytes[at + i];
  return v;
};
/** Where the hash stands after its first block, of which only the last seven bytes are the caller's */
const begin = (seven: Uint8Array) => {
  const w: number[] = new Array(14).fill(0);
  w.push(bigEndian(seven, 0, 3), bigEndian(seven, 3, 4));
  for (let i = 16; i < 30; i++) {
    let v = SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? u(sigma1(w[i - 2]) ^ SIGMA1_ADJUSTMENT) : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? u(sigma0(w[i - 15]) ^ SIGMA0_ADJUSTMENT) : sigma0(w[i - 15]);
    w.push(u(v));
  }
  w.push(u(sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + ADJUSTMENT - K[14]));
  expand(w, 31);
  const worked = rounds(STATE, w, 14);
  return INITIAL.map((x, i) => u(x + worked[i]));
};
const digest = (data: Uint8Array) => {
  const length = 57 + data.length;
  const pad = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + pad + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, u(length * 8));
  let state = begin(data.subarray(0, 7));
  for (let o = 0; o < padded.length; o += 64) {
    const w: number[] = [];
    for (let i = 0; i < 16; i++) w.push(view.getUint32(o + 4 * i));
    expand(w);
    const worked = rounds(state, w);
    state = state.map((x, i) => u(x + worked[i]));
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  state.forEach((x, i) => outView.setUint32(4 * i, x));
  return out;
};
const checksum = (data: Uint8Array, hash: Uint8Array): [number, number] => {
  const hashView = new DataView(hash.buffer, hash.byteOffset);
  const keyA = u(hashView.getUint32(0, true) | 1);
  const keyB = u(hashView.getUint32(4, true) | 1);
  const factors = [mul(keyA, CS_FACTOR), mul(keyB, CS_FACTOR)];
  const terms = CS.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = CS.map(([, o]) => o);
  // (the data after a zero byte, as little-endian words, an even number of them)
  const raw = new Uint8Array(Math.ceil((data.length + 1) / 8) * 8);
  raw.set(data, 1);
  const rawView = new DataView(raw.buffer);
  for (let i = 0; i < raw.length / 4; i++) {
    const word = rawView.getUint32(4 * i, true);
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = u(term + mul(CS_ADJUSTMENT0, factors[0]));
      offset = u(offset + CS_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16(u(offsets[i] + x));
    let q = mul(t, 0x76f50f34);
    swapAcc = u(swapAcc + u(mul(rol16(q), 0xc3efea97) + q));
    t = rol16(u(offsets[i + 1] + y));
    q = mul(t, 0x1881ce3c);
    swapLast = u(mul(rol16(q), 0x35bd1ec9) + q);
    swapAcc = u(swapAcc + swapLast);
    state = u(mul(state, keyA) + x);
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = u(acc + state);
    t = u(mul(state, keyB) + y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = u(acc + state);
  }
  return [u(swapLast ^ state), u(swapAcc ^ acc)];
};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex").toUpperCase();
/** The token for a moment in time (seconds since 1970) */
export const edgeToken = (unixSeconds: number) => {
  // (the time in Windows' own count, 100 ns since 1601, to the five minutes)
  let seconds = Math.floor(unixSeconds) + 11644473600;
  seconds -= seconds % 300;
  const data = new TextEncoder().encode(`${BigInt(seconds) * 10000000n}${CLIENT}`);
  const hash = digest(data);
  const [a, b] = checksum(data, hash);
  const sum = Buffer.alloc(8);
  sum.writeUInt32LE(a, 0);
  sum.writeUInt32LE(b, 4);
  return `${hex(sum)}-${hex(hash)}`;
};

// ------------------ THE REQUEST ------------------
// Asked over a WebSocket, spoken here over Node's own https rather than with a WebSocket object: the page's can't send
// the headers the service looks at, and there isn't one where this runs. A handful of text messages out and binary
// ones back is all there is to it.
/** Seconds the service's clock is ahead of this machine's: the token is made from the time, so a clock that is off gets refused */
let ahead = 0;
const id = () => randomUUID().replace(/-/g, "");
/** The time the way a browser writes it, which is how the service is told it */
const stamp = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, "$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)");
const forSpeech = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Said no, in so many words (a voice it doesn't have, a format it won't give): asking again changes nothing */
class Declined extends Error {}
/** Not let in at all (answered as a page would be). `theirs`: the time the service has it, in ms, if it said */
class Refused extends Error {
  constructor(
    message: string,
    readonly theirs: number,
  ) {
    super(message);
  }
}

const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;
/** One message as a WebSocket frame (a client's are masked) */
const frame = (op: number, payload: Buffer) => {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : Buffer.from([0x80 | op, 0x80 | 127, 0, 0, 0, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
};

const ask = (text: string, voice: string, rate: number, pitch = 0) =>
  new Promise<Buffer>((resolve, reject) => {
    const percent = Math.round((rate - 1) * 100);
    const hz = Math.round(Math.max(-60, Math.min(60, Number(pitch) || 0)));
    const key = randomBytes(16).toString("base64");
    const token = edgeToken(Date.now() / 1000 + ahead);
    const req = request(`https://${HOST}/edge/v1?TrustedClientToken=${CLIENT}&ConnectionId=${id()}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=2-${EDGE}`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
      },
    });
    const chunks: Buffer[] = [];
    let socket: Socket | undefined;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(whole);
      try {
        socket?.destroy();
        req.destroy();
      } catch {}
      if (err) reject(err);
      else if (!chunks.length) reject(new Error("The online voice sent no audio"));
      else resolve(Buffer.concat(chunks));
    };
    const quiet = () => finish(new Error(`The online voice went quiet for ${QUIET_MS / 1000}s`));
    let timer = setTimeout(quiet, QUIET_MS);
    const whole = setTimeout(() => finish(new Error(`The online voice took more than ${WHOLE_MS / 1000}s`)), WHOLE_MS);
    req.on("error", (err) => finish(new Error(`The online voice couldn't be reached (${err.message})`)));
    req.on("response", (res) => {
      res.resume();
      finish(new Refused(`The online voice refused the connection (HTTP ${res.statusCode})`, Date.parse(String(res.headers.date ?? ""))));
    });
    req.on("upgrade", (res, sock, head) => {
      socket = sock;
      const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (res.headers["sec-websocket-accept"] !== expected) return finish(new Error("The online voice answered with something that isn't a WebSocket"));
      // What has come in and isn't a whole frame yet, and the pieces of a message sent in several frames
      let pending: Buffer = head;
      let pieces: Buffer[] = [];
      let piecesOp = 0;
      const message = (op: number, data: Buffer) => {
        if (op === TEXT) {
          if (data.toString().includes("Path:turn.end")) finish();
        } else if (op === BINARY) {
          // (two bytes of how long the headers are, the headers, then what they describe)
          if (data.length < 2) return;
          const n = data.readUInt16BE(0);
          if (data.length > 2 + n && data.subarray(2, 2 + n).toString().includes("Path:audio")) chunks.push(data.subarray(2 + n));
        }
      };
      const take = () => {
        while (!done) {
          if (pending.length < 2) return;
          const fin = (pending[0] & 0x80) !== 0;
          const op = pending[0] & 0x0f;
          const masked = (pending[1] & 0x80) !== 0;
          let n = pending[1] & 0x7f;
          let at = 2;
          if (n === 126) {
            if (pending.length < 4) return;
            n = pending.readUInt16BE(2);
            at = 4;
          } else if (n === 127) {
            if (pending.length < 10) return;
            n = pending.readUInt32BE(2) * 2 ** 32 + pending.readUInt32BE(6);
            at = 10;
          }
          const maskAt = at;
          if (masked) at += 4;
          if (pending.length < at + n) return;
          const data = Buffer.from(pending.subarray(at, at + n));
          if (masked) for (let i = 0; i < n; i++) data[i] ^= pending[maskAt + (i & 3)];
          pending = pending.subarray(at + n);
          if (op === CLOSE) {
            const why = n >= 2 ? `${data.readUInt16BE(0)} ${data.subarray(2).toString()}`.trim() : "";
            return finish(chunks.length ? undefined : new Declined(`The online voice closed without audio (${why})`));
          }
          if (op === PING) sock.write(frame(PONG, data));
          else if (op === 0) {
            pieces.push(data);
            if (fin) {
              message(piecesOp, Buffer.concat(pieces));
              pieces = [];
            }
          } else if (op === TEXT || op === BINARY) {
            if (fin) message(op, data);
            else {
              pieces = [data];
              piecesOp = op;
            }
          }
        }
      };
      sock.on("data", (d: Buffer) => {
        clearTimeout(timer);
        timer = setTimeout(quiet, QUIET_MS);
        pending = pending.length ? Buffer.concat([pending, d]) : d;
        take();
      });
      sock.on("error", (err: Error) => finish(new Error(`The online voice: ${err.message}`)));
      sock.on("close", () => finish(chunks.length ? undefined : new Error("The online voice closed without audio")));
      sock.write(
        frame(
          TEXT,
          Buffer.from(
            `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
              `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"${FORMAT}"}}}}\r\n`,
          ),
        ),
      );
      sock.write(
        frame(
          TEXT,
          Buffer.from(
            `X-RequestId:${id()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n` +
              `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>` +
              `<prosody pitch='${hz >= 0 ? "+" : ""}${hz}Hz' rate='${percent >= 0 ? "+" : ""}${percent}%' volume='+0%'>${forSpeech(text)}</prosody></voice></speak>`,
          ),
        ),
      );
      take();
    });
    req.end();
  });

// ------------------ API (called from the page) ------------------
/** `text` read by one of Edge's voices at `rate` times its usual pace and `pitch` Hz above (or below) its own pitch, as an MP3 file in base64. Throws whenever that can't be had */
export const edgeSpeak = async (text: string, voice: string, rate: number, pitch = 0): Promise<{ mp3: string }> => {
  try {
    return { mp3: (await ask(text, voice, rate, pitch)).toString("base64") };
  } catch (err) {
    if (err instanceof Declined) throw err;
    if (err instanceof Refused) {
      // Refused at the door, and by the time on the refusal this machine's clock is off: the token was for the wrong
      // time. Once more, by the service's clock
      if (!Number.isFinite(err.theirs)) throw err;
      const theirs = (err.theirs - Date.now()) / 1000;
      if (Math.abs(theirs - ahead) <= 30) throw err;
      ahead = theirs;
    } else {
      // The connection itself gave out (dropped half way, no answer): that happens now and then, and usually not twice
      await new Promise((r) => setTimeout(r, 600));
    }
    return { mp3: (await ask(text, voice, rate, pitch)).toString("base64") };
  }
};
