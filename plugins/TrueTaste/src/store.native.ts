// Runs in the Electron main process: plain files on disk, so the taste profile survives restarts,
// reinstalls and Luna's cache wipes. Everything stays on this machine.
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// Luna's native context doesn't expose LOCALAPPDATA, so this is ~/.cache on every platform
const dataDir = () => path.join(homedir(), ".cache", "visiuun-true-taste");
const logFile = () => path.join(dataDir(), "log.txt");
const MAX_LOG_BYTES = 1024 * 1024;

const writeAtomic = async (file: string, data: Uint8Array) => {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file).catch(async () => {
    await rm(tmp, { force: true });
  });
};

// ------------------ JSON DOCUMENTS ------------------
// Gzipped JSON, one file per document (state, track and artist metadata)
export const readDoc = async (name: string): Promise<string | null> => {
  try {
    return (await gunzipAsync(await readFile(path.join(dataDir(), `${name}.json.gz`)))).toString("utf8");
  } catch {
    return null;
  }
};

export const writeDoc = async (name: string, json: string) => {
  await writeAtomic(path.join(dataDir(), `${name}.json.gz`), new Uint8Array(await gzipAsync(Buffer.from(json, "utf8"))));
};

export const removeDoc = (name: string) => rm(path.join(dataDir(), `${name}.json.gz`), { force: true });

// ------------------ LOG ------------------
// Human readable log of what the recommender did, rotated at 1MB
export const appendLog = async (lines: string) => {
  await mkdir(dataDir(), { recursive: true });
  const size = (await stat(logFile()).catch(() => null))?.size ?? 0;
  if (size > MAX_LOG_BYTES) await rename(logFile(), `${logFile()}.old`).catch(() => {});
  await appendFile(logFile(), lines);
};

export const getDataDir = async () => dataDir();

// Before the TrueTaste rename the plugin lived in "visiuun-daily-discovery"
// Copied rather than moved: on Windows a folder can't be renamed while anything still has a file open
export const migrateLegacyData = async () => {
  const legacy = path.join(homedir(), ".cache", "visiuun-daily-discovery");
  const marker = path.join(dataDir(), ".migrated");
  if (await stat(marker).catch(() => null)) return false;
  if (!(await stat(legacy).catch(() => null))) return false;
  await mkdir(dataDir(), { recursive: true });
  for (const name of ["state", "tracks", "artists"]) {
    await copyFile(path.join(legacy, `${name}.json.gz`), path.join(dataDir(), `${name}.json.gz`)).catch(() => {});
  }
  await writeFile(marker, new Date().toISOString());
  await rename(legacy, `${legacy}-migrated`).catch(() => {});
  return true;
};

export const removeLegacyModels = () => rm(path.join(dataDir(), "models"), { recursive: true, force: true });

// Wipes the learned profile but keeps the downloaded model
export const clearProfile = async () => {
  for (const name of ["state", "tracks", "artists", "embeddings"]) await removeDoc(name);
};
