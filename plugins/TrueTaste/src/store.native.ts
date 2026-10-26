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

// ------------------ BACKUP FILES ------------------
// Native dialogs: browser-style downloads aren't reliable inside TIDAL
const jsonFilter = [{ name: "TrueTaste backup", extensions: ["json"] }];
// TIDAL provides Electron at runtime; this repo has no Electron types, so only what's used is typed here
type DialogResult = { canceled: boolean; filePath?: string; filePaths: string[] };
const electron = () =>
  require("electron") as {
  BrowserWindow: { getFocusedWindow(): object | null };
  dialog: {
    showSaveDialog(...args: unknown[]): Promise<DialogResult>;
    showOpenDialog(...args: unknown[]): Promise<DialogResult>;
  };
};

export const saveBackup = async (json: string, fileName: string): Promise<string | null> => {
  const { BrowserWindow, dialog } = electron();
  const win = BrowserWindow.getFocusedWindow();
  const opts = { title: "Export TrueTaste data", defaultPath: path.join(homedir(), "Downloads", fileName), filters: jsonFilter };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  await writeFile(res.filePath, json, "utf8");
  return res.filePath;
};

export const openBackup = async (): Promise<string | null> => {
  const { BrowserWindow, dialog } = electron();
  const win = BrowserWindow.getFocusedWindow();
  const opts = { title: "Import TrueTaste data", properties: ["openFile" as const], filters: jsonFilter };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  return readFile(res.filePaths[0], "utf8");
};
