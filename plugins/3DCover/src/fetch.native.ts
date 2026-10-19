// Runs in the Electron main process. Node's fetch bypasses Luna's https protocol handler
// (which fails for Web Worker requests) and renderer CORS rules.
import { createHash } from "crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { promisify } from "util";
import { deflate, inflate } from "zlib";

export type FetchResult = { status: number; data?: Uint8Array };

const cacheDir = () => path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), ".cache"), "visiuun-3d-cover");
const depthDir = () => path.join(cacheDir(), "depth");
const hash = (s: string) => createHash("sha1").update(s).digest("hex");

const writeAtomic = async (file: string, data: Uint8Array) => {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file).catch(() => rm(tmp, { force: true }));
};

export const fetchImageBytes = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
};

// ------------------ MODEL FILES ------------------
// Disk-cached fetch for the AI runtime + model files. Luna clears the browser Cache Storage on every
// launch, so without this the model would be re-downloaded each time TIDAL starts.
export const fetchCached = async (url: string): Promise<FetchResult> => {
  const file = path.join(cacheDir(), hash(url));
  try {
    return { status: 200, data: new Uint8Array(await readFile(file)) };
  } catch {}

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return { status: res.status };
  const data = new Uint8Array(await res.arrayBuffer());
  await writeAtomic(file, data);
  return { status: 200, data };
};

// Model files live directly in the cache folder; depth maps are in the "depth" subfolder
export const clearFileCache = async () => {
  const entries = await readdir(cacheDir(), { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((e) => e.isFile()).map((e) => rm(path.join(cacheDir(), e.name), { force: true })));
};

// ------------------ DEPTH MAPS ------------------
// Generated depth maps, deflated on disk (~4x smaller). Oldest-used are pruned past MAX_DEPTH_FILES.
const MAX_DEPTH_FILES = 2000;
const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);
let writesSincePrune = 0;

export const readDepth = async (key: string): Promise<Uint8Array | null> => {
  const file = path.join(depthDir(), `${hash(key)}.bin`);
  try {
    const data = new Uint8Array(await inflateAsync(await readFile(file)));
    // Bump mtime so pruning keeps recently used covers
    const now = new Date();
    utimes(file, now, now).catch(() => {});
    return data;
  } catch {
    return null;
  }
};

const pruneDepth = async () => {
  const names = await readdir(depthDir()).catch(() => [] as string[]);
  if (names.length <= MAX_DEPTH_FILES) return;
  const files = await Promise.all(
    names.map(async (name) => {
      const file = path.join(depthDir(), name);
      return { file, mtime: (await stat(file).catch(() => null))?.mtimeMs ?? 0 };
    }),
  );
  files.sort((a, b) => a.mtime - b.mtime);
  await Promise.all(files.slice(0, files.length - MAX_DEPTH_FILES).map(({ file }) => rm(file, { force: true })));
};

export const writeDepth = async (key: string, data: Uint8Array) => {
  await writeAtomic(path.join(depthDir(), `${hash(key)}.bin`), new Uint8Array(await deflateAsync(data)));
  if (++writesSincePrune >= 50) {
    writesSincePrune = 0;
    await pruneDepth();
  }
};

export const depthCacheStats = async () => {
  const names = await readdir(depthDir()).catch(() => [] as string[]);
  let bytes = 0;
  for (const name of names) bytes += (await stat(path.join(depthDir(), name)).catch(() => null))?.size ?? 0;
  return { count: names.length, bytes };
};

export const clearDepthFiles = () => rm(depthDir(), { recursive: true, force: true });
