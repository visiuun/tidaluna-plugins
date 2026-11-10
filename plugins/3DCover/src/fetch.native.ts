// Runs in the Electron main process. Node's fetch bypasses Luna's https protocol handler
// (which fails for Web Worker requests) and renderer CORS rules.
import { createHash } from "crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "fs/promises";
import { get as httpsGet } from "https";
import path from "path";
import { promisify } from "util";
import { deflate, inflate } from "zlib";

// Binary on Luna, base64 on TidaLunar (see toWire)
export type Wire = Uint8Array | string;
export type FetchResult = { status: number; data?: Wire };

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

// TidaLunar's IPC is JSON, where a Uint8Array wouldn't survive
export const toWire = (data: Uint8Array): Wire => (lunarDataDir() ? Buffer.from(data).toString("base64") : data);

const cacheDir = () => path.join(lunarDataDir() ?? process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cache"), "visiuun-3d-cover");
const depthDir = () => path.join(cacheDir(), "depth");
// TidaLunar's fs can't list folders, so clearing the model files there means removing a folder of their own
const modelDir = () => (lunarDataDir() ? path.join(cacheDir(), "models") : cacheDir());
const hash = (s: string) => createHash("sha1").update(s).digest("hex");

const writeAtomic = async (file: string, data: Uint8Array) => {
  await mkdir(path.dirname(file), { recursive: true });
  // TidaLunar's fs has no rename
  if (lunarDataDir()) {
    await writeFile(file, data).catch(async (err) => {
      await rm(file, { force: true });
      throw err;
    });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file).catch(() => rm(tmp, { force: true }));
};

// Node's https rather than fetch: requiring it is how a plugin asks TidaLunar for network access, and
// TidaLunar's fetch stops at 25 MB, less than the AI model.
const download = (url: string, redirects = 5): Promise<{ status: number; data?: Uint8Array }> =>
  new Promise((resolve, reject) => {
    httpsGet(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`Too many redirects for ${url}`));
        return resolve(download(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return resolve({ status });
      }
      const chunks: Uint8Array[] = [];
      res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      res.on("end", () => resolve({ status, data: new Uint8Array(Buffer.concat(chunks)) }));
      res.on("error", reject);
      // Comes after "end" on a complete response, when this does nothing
      res.on("close", () => reject(new Error(`Connection closed while downloading ${url}`)));
    }).on("error", reject);
  });

export const fetchImageBytes = async (url: string): Promise<Wire> => {
  const { status, data } = await download(url);
  if (!data) throw new Error(`HTTP ${status} for ${url}`);
  return toWire(data);
};

// ------------------ MODEL FILES ------------------
// Disk-cached fetch for the AI runtime + model files. Luna clears the browser Cache Storage on every
// launch, so without this the model would be re-downloaded each time TIDAL starts.
export const cachedBytes = async (url: string): Promise<{ status: number; data?: Uint8Array }> => {
  const file = path.join(modelDir(), hash(url));
  try {
    return { status: 200, data: new Uint8Array(await readFile(file)) };
  } catch {}

  const { status, data } = await download(url);
  if (!data) return { status };
  await writeAtomic(file, data);
  return { status: 200, data };
};

export const fetchCached = async (url: string): Promise<FetchResult> => {
  const { status, data } = await cachedBytes(url);
  return data ? { status, data: toWire(data) } : { status };
};

// Model files live directly in the cache folder; depth maps are in the "depth" subfolder
export const clearFileCache = async () => {
  if (lunarDataDir()) return rm(modelDir(), { recursive: true, force: true });
  const entries = await readdir(cacheDir(), { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((e) => e.isFile()).map((e) => rm(path.join(cacheDir(), e.name), { force: true })));
};

// ------------------ DEPTH MAPS ------------------
// Generated depth maps, deflated on disk (~4x smaller). Oldest-used are pruned past MAX_DEPTH_FILES.
const MAX_DEPTH_FILES = 2000;
const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);
let writesSincePrune = 0;

export const readDepth = async (key: string): Promise<Wire | null> => {
  const file = path.join(depthDir(), `${hash(key)}.bin`);
  try {
    const data = new Uint8Array(await inflateAsync(await readFile(file)));
    // Bump mtime so pruning keeps recently used covers
    const now = new Date();
    if (!lunarDataDir()) utimes(file, now, now).catch(() => {});
    return toWire(data);
  } catch {
    return null;
  }
};

const pruneDepth = async () => {
  if (lunarDataDir()) return; // can't list the folder there
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

export const writeDepth = async (key: string, base64: string) => {
  await writeAtomic(path.join(depthDir(), `${hash(key)}.bin`), new Uint8Array(await deflateAsync(Buffer.from(base64, "base64"))));
  if (++writesSincePrune >= 50) {
    writesSincePrune = 0;
    await pruneDepth();
  }
};

export const depthCacheStats = async () => {
  if (lunarDataDir()) return { count: 0, bytes: 0 }; // can't list the folder there
  const names = await readdir(depthDir()).catch(() => [] as string[]);
  let bytes = 0;
  for (const name of names) bytes += (await stat(path.join(depthDir(), name)).catch(() => null))?.size ?? 0;
  return { count: names.length, bytes };
};

export const clearDepthFiles = () => rm(depthDir(), { recursive: true, force: true });
