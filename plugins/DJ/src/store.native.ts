// Runs in the Electron main process: the DJ's own files on disk. Everything stays on this machine.
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { homedir } from "os";
import path from "path";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// TidaLunar confines a plugin's files to its own folder and names it through this module; Luna has no such module
// (Through a variable: the build would turn a literal "@luna/..." require into a lookup that can't find it)
const runtimeRequire = (id: string) => require(id);
let lunarDir: string | undefined | null = null;
const lunarDataDir = () => {
  if (lunarDir !== null) return lunarDir;
  try {
    lunarDir = runtimeRequire("@luna/native-data").dir as string;
  } catch {
    lunarDir = undefined;
  }
  return lunarDir;
};

export const dataDir = () => path.join(lunarDataDir() ?? path.join(homedir(), ".cache"), "visiuun-dj");
const logFile = () => path.join(dataDir(), "log.txt");
const voiceDir = () => path.join(dataDir(), "voice");
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_VOICE_FILES = 400;

const writeAtomic = async (file: string, data: Uint8Array) => {
  await mkdir(path.dirname(file), { recursive: true });
  if (lunarDataDir()) return writeFile(file, data); // TidaLunar's fs has no rename
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file).catch(() => rm(tmp, { force: true }));
};

// ------------------ LINKS ------------------
/** Opens TrueTaste's page on GitHub in the browser. The address is fixed here: nothing else can be opened through this */
export const openTrueTastePage = async () => {
  await runtimeRequire("electron").shell.openExternal("https://github.com/visiuun/tidaluna-plugins#truetaste-visiuuntrue-taste");
};

// ------------------ JSON DOCUMENTS ------------------
// Document names come from the page: only plain names, so nothing outside the data folder can be reached
const docFile = (name: string) => {
  if (!/^[a-z0-9_-]{1,40}$/i.test(String(name))) throw new Error("Not a document name");
  return path.join(dataDir(), `${name}.json.gz`);
};

export const readDoc = async (name: string): Promise<string | null> => {
  try {
    return (await gunzipAsync(await readFile(docFile(name)))).toString("utf8");
  } catch {
    return null;
  }
};

export const writeDoc = async (name: string, json: string) => {
  await writeAtomic(docFile(name), new Uint8Array(await gzipAsync(Buffer.from(json, "utf8"))));
};

// ------------------ SPOKEN LINES ------------------
// Generated speech, kept so a line is only ever generated once (base64 over IPC: works on Luna and TidaLunar)
const voiceFile = (key: string) => path.join(voiceDir(), `${createHash("sha1").update(key).digest("hex")}.pcm`);

export const readVoice = async (key: string): Promise<string | null> => {
  const file = voiceFile(key);
  try {
    const data = await readFile(file);
    const now = new Date();
    if (!lunarDataDir()) utimes(file, now, now).catch(() => {});
    return data.toString("base64");
  } catch {
    return null;
  }
};

let writes = 0;
export const writeVoice = async (key: string, base64: string) => {
  await writeAtomic(voiceFile(key), new Uint8Array(Buffer.from(base64, "base64")));
  if (++writes % 40 !== 0 || lunarDataDir()) return;
  const names = await readdir(voiceDir()).catch(() => [] as string[]);
  if (names.length <= MAX_VOICE_FILES) return;
  const files = await Promise.all(names.map(async (n) => ({ file: path.join(voiceDir(), n), mtime: (await stat(path.join(voiceDir(), n)).catch(() => null))?.mtimeMs ?? 0 })));
  files.sort((a, b) => a.mtime - b.mtime);
  await Promise.all(files.slice(0, files.length - MAX_VOICE_FILES).map(({ file }) => rm(file, { force: true })));
};

export const clearVoiceFiles = () => rm(voiceDir(), { recursive: true, force: true });

// ------------------ LOG ------------------
export const appendLog = async (lines: string) => {
  await mkdir(dataDir(), { recursive: true });
  const size = (await stat(logFile()).catch(() => null))?.size ?? 0;
  if (size > MAX_LOG_BYTES) await rename(logFile(), `${logFile()}.old`).catch(() => {});
  await appendFile(logFile(), lines);
};

export const getDataDir = async () => dataDir();
