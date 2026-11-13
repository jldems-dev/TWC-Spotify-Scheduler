import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  safeStorage,
  shell,
  powerMonitor,
  session,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { activeQuietSchedules, ScheduleCoordinator } from "./scheduler";
import { normalizeAdvertisementSchedule } from "./advertisement-schedule";
import { captureQuietPlayback, quietRestorePlan } from "./quiet-state";
import {
  playbackCommand,
  playlistPlaybackCommand,
  transferPlaybackCommand,
  usableDevice,
  shouldLaunchSpotifyDesktop,
} from "./spotify-playback";
import { parseSecureToken } from "./spotify-token";
import { googleApiError } from "./google-api-utils";
import { createGoogleCodeChallenge, exchangeGoogleAuthorizationCode, validateGoogleOAuthCallback } from "./google-oauth";
import { missingPlaybackScopes, sanitizeSpotifyDevices, startScheduledPlayback, startSpotifyPlayback } from "./scheduled-playback";
import {
  readSpotifyResponse,
  requestSpotifyApi,
  spotifyHttpError,
  validateOAuthCallback,
} from "./spotify-utils";

type Store = {
  settings: Record<string, unknown>;
  schedules: unknown[];
  exceptions: unknown[];
  playlists: unknown[];
  logs: { time: string; level: string; message: string }[];
  announcements: any[];
  announcementSchedules: any[];
  advertisements: any[];
  advertisementSchedules: any[];
};
const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const validLocalDateKey = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};
const validAnnouncementSchedule = (item: any, validDays: string[]) => {
  if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || item.name.length > 80 || typeof item.enabled !== "boolean") return false;
  if (item.date !== undefined) return validLocalDateKey(item.date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) && typeof item.announcementId === "string" && ["never", "yearly"].includes(item.repeat || "never");
  return Array.isArray(item.days) && item.days.length > 0 && item.days.length <= 7 && item.days.every((day: string) => validDays.includes(day)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.end) && item.end > item.start && typeof item.firstAnnouncementId === "string" && typeof item.secondAnnouncementId === "string";
};
const empty: Store = {
  settings: {
    spotifyClientId: "",
    googleClientId: "",
    defaultPlaylist: "",
    schedulerEnabled: true,
  },
  schedules: [],
  exceptions: [],
  playlists: [],
  logs: [],
  announcements: [],
  announcementSchedules: [],
  advertisements: [],
  advertisementSchedules: [],
};
const dataFile = () =>
  path.join(app.getPath("userData"), "scheduler-data.json");
const tokenFile = () => path.join(app.getPath("userData"), "spotify-token.bin");
const googleTokenFile = () => path.join(app.getPath("userData"), "google-business-token.bin");
const googleClientCredentialFile = () => path.join(app.getPath("userData"), "google-desktop-client.bin");
const contentSecurityPolicy = () =>
  `default-src 'self'; script-src 'self'${app.isPackaged ? "" : " 'unsafe-inline'"}; style-src 'self'${app.isPackaged ? "" : " 'unsafe-inline'"}; img-src 'self' data: https://i.scdn.co https://mosaic.scdn.co https://image-cdn-ak.spotifycdn.com; media-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.spotify.com https://accounts.spotify.com${app.isPackaged ? "" : " ws://localhost:5173 ws://127.0.0.1:5173"}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'`;
const execFileAsync = promisify(execFile);
async function spotifyDesktopRunning(): Promise<boolean | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist.exe",
        ["/FI", "IMAGENAME eq Spotify.exe", "/FO", "CSV", "/NH"],
        { timeout: 5000, windowsHide: true },
      );
      if (/^\s*ERROR:/im.test(stdout)) return null;
      return stdout
        .split(/\r?\n/)
        .some((line) => /^"Spotify\.exe"/i.test(line));
    }
    const command = process.platform === "darwin" ? "pgrep" : "pgrep";
    const { stdout } = await execFileAsync(
      command,
      ["-f", process.platform === "darwin" ? "/Spotify\.app/" : "spotify"],
      { timeout: 5000 },
    );
    return stdout.trim().length > 0;
  } catch (error: any) {
    if (error?.code === 1) return false;
    return null;
  }
}
async function playbackDeviceInfo() {
  try {
    return {
      computerName: os.hostname() || null,
      spotifyRunning: await spotifyDesktopRunning(),
    };
  } catch {
    return { computerName: null, spotifyRunning: null };
  }
}
async function openSpotifyDesktop(): Promise<{ alreadyOpen: boolean }> {
  const running = await spotifyDesktopRunning();
  if (!shouldLaunchSpotifyDesktop(running)) {
    if (running === true) return { alreadyOpen: true };
    throw new Error("Could not verify whether Spotify is already running. Check its status, then try Open Spotify again.");
  }
  try {
    // Fixed Spotify protocol URI: never accept a URL or command from the renderer.
    await shell.openExternal("spotify:");
    return { alreadyOpen: false };
  } catch {
    throw new Error(
      "Could not open Spotify. Make sure the Spotify desktop app is installed, then try again.",
    );
  }
}
function redactSecrets(value: unknown): string {
  return String(value)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:access_token|refresh_token|client_secret|code_verifier)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1[REDACTED]",
    );
}
function startupLog(message: string) {
  message = redactSecrets(message);
  console.error(message);
  try {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "startup.log"),
      `${new Date().toISOString()} ${message}\n`,
    );
  } catch {
    /* Diagnostics must not stop startup. */
  }
}
async function preserveInvalidStore() {
  const preserved = `${dataFile()}.invalid-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  await fs.rename(dataFile(), preserved);
  startupLog(
    `[storage] invalid settings data was preserved at ${path.basename(preserved)}; defaults are being used until repaired.`,
  );
}
async function readStore(): Promise<Store> {
  let raw: string;
  try {
    const stat = await fs.stat(dataFile());
    if (stat.size > 10 * 1024 * 1024) {
      await preserveInvalidStore();
      return structuredClone(empty);
    }
    raw = await fs.readFile(dataFile(), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return structuredClone(empty);
    throw new Error(
      "Application settings could not be read. The original file was left untouched.",
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await preserveInvalidStore();
    return structuredClone(empty);
  }
  const validTopLevel =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed.settings === undefined || isRecord(parsed.settings)) &&
    ["schedules", "exceptions", "playlists", "logs", "announcements", "announcementSchedules", "advertisements", "advertisementSchedules"].every(
      (key) => parsed[key] === undefined || Array.isArray(parsed[key]),
    );
  if (!validTopLevel) {
    await preserveInvalidStore();
    return structuredClone(empty);
  }
  const sourceSettings = parsed.settings || {};
  const sourceSchedules = parsed.schedules || [];
  const sourceExceptions = (parsed.exceptions || []).map((item: any) =>
    item && !item.type && typeof item.date === "string"
      ? { ...item, type: "skip" }
      : item,
  );
  const sourcePlaylists = parsed.playlists || [];
  const sourceLogs = parsed.logs || [];
  const validDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const validData =
    (sourceSettings.schedulerEnabled === undefined || typeof sourceSettings.schedulerEnabled === "boolean") &&
    (sourceSettings.spotifyClientId === undefined || (typeof sourceSettings.spotifyClientId === "string" && sourceSettings.spotifyClientId.length <= 200)) &&
    (sourceSettings.googleClientId === undefined || (typeof sourceSettings.googleClientId === "string" && sourceSettings.googleClientId.length <= 300)) &&
    (sourceSettings.defaultPlaylist === undefined || (typeof sourceSettings.defaultPlaylist === "string" && sourceSettings.defaultPlaylist.length <= 256)) &&
    (sourceSettings.timezone === undefined || (typeof sourceSettings.timezone === "string" && sourceSettings.timezone.length <= 128)) &&
    sourceSchedules.length <= 500 && sourceSchedules.every((item: any) =>
      isRecord(item) && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 128 &&
      typeof item.name === "string" && item.name.length <= 80 && Array.isArray(item.days) && item.days.length <= 7 &&
      (item.date === undefined || validLocalDateKey(item.date)) &&
      (item.repeat === undefined || ["never", "daily", "weekly", "monthly", "yearly"].includes(item.repeat)) &&
      (item.dates === undefined || (Array.isArray(item.dates) && item.dates.length <= 100 && item.dates.every((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(d)))) &&
      item.days.every((day: unknown) => validDays.includes(String(day))) &&
      typeof item.start === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.start) &&
      typeof item.end === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.end) &&
      typeof item.enabled === "boolean" && typeof item.quiet === "boolean" &&
      (item.playlistId === undefined || (typeof item.playlistId === "string" && item.playlistId.length <= 256)) &&
      (item.playlistName === undefined || (typeof item.playlistName === "string" && item.playlistName.length <= 300)) && (item.googleSourceId === undefined || (typeof item.googleSourceId === "string" && item.googleSourceId.length <= 256))) &&
    sourceExceptions.length <= 1000 && sourceExceptions.every((item: any) =>
      isRecord(item) && typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
      ["skip", "replace"].includes(item.type) &&
      (item.playlistId === undefined || (typeof item.playlistId === "string" && item.playlistId.length <= 256)) &&
      (item.playlistName === undefined || (typeof item.playlistName === "string" && item.playlistName.length <= 300)) &&
      (item.label === undefined || (typeof item.label === "string" && item.label.length <= 200)) && (item.scheduleId === undefined || (typeof item.scheduleId === "string" && item.scheduleId.length <= 128)) && (item.googleSourceId === undefined || (typeof item.googleSourceId === "string" && item.googleSourceId.length <= 256))) &&
    sourcePlaylists.length <= 5000 && sourcePlaylists.every((item: any) =>
      isRecord(item) && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 &&
      typeof item.uri === "string" && item.uri.length <= 512 && typeof item.name === "string" && item.name.length <= 500 &&
      typeof item.description === "string" && item.description.length <= 10000 && Number.isSafeInteger(item.tracks) && item.tracks >= 0 &&
      (item.image === null || item.image === undefined || (typeof item.image === "string" && item.image.length <= 2048))) &&
    sourceLogs.length <= 1000 && sourceLogs.every((item: any) =>
      isRecord(item) && typeof item.time === "string" && item.time.length <= 64 &&
      ["info", "warn", "error"].includes(item.level) && typeof item.message === "string" && item.message.length <= 500);
  if (!validData) {
    await preserveInvalidStore();
    return structuredClone(empty);
  }
  return {
    settings: {
      schedulerEnabled: sourceSettings.schedulerEnabled ?? empty.settings.schedulerEnabled,
      spotifyClientId: sourceSettings.spotifyClientId ?? empty.settings.spotifyClientId,
      googleClientId: sourceSettings.googleClientId ?? "",
      ...(typeof sourceSettings.googleLocation === "string" ? { googleLocation: sourceSettings.googleLocation } : {}),
      ...(typeof sourceSettings.googleLocationTitle === "string" ? { googleLocationTitle: sourceSettings.googleLocationTitle } : {}),
      ...(typeof sourceSettings.googleLastSync === "string" ? { googleLastSync: sourceSettings.googleLastSync } : {}),
      ...(Number.isInteger(sourceSettings.googleSyncMinutes) ? { googleSyncMinutes: sourceSettings.googleSyncMinutes } : {}),
      defaultPlaylist: sourceSettings.defaultPlaylist ?? empty.settings.defaultPlaylist,
      ...(sourceSettings.timezone !== undefined ? { timezone: sourceSettings.timezone } : {}),
    },
    schedules: sourceSchedules.map(({ id, name, days, dates, date, repeat, googleSourceId, start, end, playlistId, playlistName, enabled, quiet }: any) =>
      ({ id, name, days, ...(dates ? { dates } : {}), ...(date ? { date } : {}), ...(repeat ? { repeat } : {}), ...(googleSourceId ? { googleSourceId } : {}), start, end, ...(playlistId !== undefined ? { playlistId } : {}), ...(playlistName !== undefined ? { playlistName } : {}), enabled, quiet })),
    exceptions: sourceExceptions.map(({ date, type, playlistId, playlistName, label, scheduleId, googleSourceId }: any) =>
      ({ date, type, ...(playlistId !== undefined ? { playlistId } : {}), ...(playlistName !== undefined ? { playlistName } : {}), ...(label !== undefined ? { label } : {}), ...(scheduleId ? { scheduleId } : {}), ...(googleSourceId ? { googleSourceId } : {}) })),
    playlists: sourcePlaylists.map(({ id, uri, name, description, tracks, image }: any) =>
      ({ id, uri, name, description, tracks, image: image ?? null })),
    logs: sourceLogs.map(({ time, level, message }: any) =>
      ({ time, level, message: redactSecrets(message) })),
    announcements: Array.isArray(parsed.announcements) ? parsed.announcements.filter((a: any) => a && typeof a.id === "string" && typeof a.name === "string" && typeof a.enabled === "boolean" && typeof a.file === "string").map((a: any) => ({ id: a.id, name: a.name, file: a.file, enabled: a.enabled, ...(Number.isInteger(a.volume) && a.volume >= 0 && a.volume <= 100 ? { volume: a.volume } : {}) })) : [],
    announcementSchedules: Array.isArray(parsed.announcementSchedules) ? parsed.announcementSchedules.filter((s: any) => validAnnouncementSchedule(s, validDays)) : [],
    advertisements: Array.isArray(parsed.advertisements) ? parsed.advertisements.filter((a: any) => a && typeof a.id === "string" && typeof a.name === "string" && typeof a.enabled === "boolean" && typeof a.file === "string").map((a: any) => ({ id: a.id, name: a.name.slice(0, 500), ...(typeof a.description === "string" ? { description: a.description.slice(0, 2000) } : {}), file: a.file, enabled: a.enabled, ...(Number.isInteger(a.volume) && a.volume >= 0 && a.volume <= 100 ? { volume: a.volume } : {}) })) : [],
    advertisementSchedules: Array.isArray(parsed.advertisementSchedules) ? parsed.advertisementSchedules.map(normalizeAdvertisementSchedule).filter(Boolean) : [],
  };
}
async function writeStore(data: Store) {
  const target = dataFile();
  const dir = app.getPath("userData");
  await fs.mkdir(dir, { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await fs.copyFile(target, `${target}.bak`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(temp, target);
  } catch (error) {
    try {
      await fs.unlink(temp);
    } catch {
      /* Best-effort temp cleanup. */
    }
    throw error;
  }
}
let storeMutation = Promise.resolve();
function withStoreMutation<T>(work: () => Promise<T>): Promise<T> {
  const task = storeMutation.then(work, work);
  storeMutation = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
async function addLog(level: string, message: string) {
  await withStoreMutation(async () => {
    const s = await readStore();
    s.logs.unshift({
      time: new Date().toISOString(),
      level,
      message: redactSecrets(message).slice(0, 500),
    });
    s.logs = s.logs.slice(0, 1000);
    await writeStore(s);
  });
}
function secureStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (
    process.platform === "linux" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  )
    return false;
  return true;
}
async function readToken(): Promise<any | null> {
  try {
    if (!secureStorageAvailable()) return null;
    return parseSecureToken(
      safeStorage.decryptString(await fs.readFile(tokenFile())),
    );
  } catch (error: any) {
    if (error?.code !== "ENOENT")
      startupLog(`[spotify] secure token read failed: credential storage error (${error?.code || "unknown"}).`);
    return null;
  }
}
async function writeToken(token: unknown) {
  if (!secureStorageAvailable())
    throw new Error("Secure system credential storage is unavailable. Set up the operating system keychain or credential store, then reconnect Spotify.");
  const target = tokenFile();
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, safeStorage.encryptString(JSON.stringify(token)), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temp, target);
  } catch (error) {
    try {
      await fs.unlink(temp);
    } catch {
      /* Best-effort temp cleanup. */
    }
    throw error;
  }
}
async function deleteToken() {
  try {
    await fs.unlink(tokenFile());
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}
async function googleToken(): Promise<any | null> {
  try { if (!secureStorageAvailable()) return null; return JSON.parse(safeStorage.decryptString(await fs.readFile(googleTokenFile()))); } catch { return null; }
}
async function googleDesktopClientSecret(clientId: string): Promise<string | undefined> {
  try {
    if (!secureStorageAvailable()) return undefined;
    const stored = JSON.parse(safeStorage.decryptString(await fs.readFile(googleClientCredentialFile())));
    return stored?.client_id === clientId && typeof stored.client_secret === "string" ? stored.client_secret : undefined;
  } catch { return undefined; }
}
async function googleAccess(): Promise<string> {
  const token = await googleToken();
  if (!token?.refresh_token) throw new Error("Connect Google in Settings first. Google OAuth credentials or Business Profile API approval may also be required.");
  if (token.expires_at > Date.now() + 60000) return token.access_token;
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: token.client_id, grant_type: "refresh_token", refresh_token: token.refresh_token }), signal: AbortSignal.timeout(15000) });
  const data: any = await response.json();
  if (!response.ok) { if (data.error === "invalid_grant") await fs.unlink(googleTokenFile()).catch(() => undefined); throw new Error(data.error === "invalid_grant" ? "Google access was revoked or expired. Reconnect the account." : `Google token refresh failed (${response.status}): ${data.error_description || data.error || "request failed"}`); }
  const updated = { ...token, ...data, refresh_token: data.refresh_token || token.refresh_token, expires_at: Date.now() + data.expires_in * 1000 };
  await fs.writeFile(googleTokenFile(), safeStorage.encryptString(JSON.stringify(updated)), { mode: 0o600 });
  return updated.access_token;
}
async function validAccessToken(forceRefresh = false): Promise<string> {
  const token = await readToken();
  if (!token?.access_token)
    throw new Error("Connect Spotify in Settings first.");
  if (!forceRefresh && Date.now() < token.expires_at - 60000)
    return token.access_token;
  if (!token.refresh_token)
    throw new Error("Spotify authorization expired. Reconnect in Settings.");
  const { settings } = await readStore();
  let response: Response;
  try {
    response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: String(token.client_id || settings.spotifyClientId || ""),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error: any) {
    throw new Error(
      error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "Spotify token refresh timed out. Check your network and try again."
        : `Spotify token refresh network error: ${redactSecrets(error?.message || error)}`,
    );
  }
  let fresh: any;
  try {
    fresh = await readSpotifyResponse(response);
  } catch (error) {
    if (response.status === 400 && /invalid_grant/i.test(String(error))) {
      await deleteToken();
      throw new Error(
        "Spotify authorization expired or was revoked. Reconnect Spotify.",
      );
    }
    throw new Error(redactSecrets(error));
  }
  if (
    !fresh ||
    typeof fresh.access_token !== "string" ||
    !Number.isFinite(fresh.expires_in)
  )
    throw new Error(
      "Spotify returned an invalid token refresh response. Reconnect Spotify.",
    );
  const updated = {
    ...token,
    ...fresh,
    client_id: token.client_id || settings.spotifyClientId,
    refresh_token: fresh.refresh_token || token.refresh_token,
    expires_at: Date.now() + fresh.expires_in * 1000,
  };
  await writeToken(updated);
  return updated.access_token;
}
async function spotifyStatus() {
  try {
    const access = await validAccessToken();
    const response = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status === 401) await deleteToken();
      return {
        connected: false,
        message: redactSecrets(spotifyHttpError(
          response.status,
          response.headers.get("Retry-After"),
        )),
      };
    }
    const me = (await response.json()) as any;
    return {
      connected: true,
      name: typeof me.display_name === "string" ? me.display_name.slice(0, 200) : typeof me.id === "string" ? me.id.slice(0, 200) : "Spotify account",
      message: "Connected",
    };
  } catch (e) {
    return { connected: false, message: redactSecrets(e).replace(/^Error: /, "") };
  }
}
let win: BrowserWindow;
let scheduleCoordinator: ScheduleCoordinator | undefined;
let shutdownLogging = false;
const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
function assertTrustedSender(event: Electron.IpcMainInvokeEvent) {
  if (!win || event.sender !== win.webContents)
    throw new Error("Untrusted IPC sender.");
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    throw new Error("IPC is only accepted from the application main frame.");
  if (isTrustedAppUrl(event.senderFrame.url)) return;
  throw new Error("IPC is only accepted from the application window.");
}
function isTrustedAppUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (
      !app.isPackaged &&
      (url.origin === "http://localhost:5173" ||
        url.origin === "http://127.0.0.1:5173")
    )
      return true;
    return (
      url.protocol === "file:" &&
      path.resolve(fileURLToPath(url)) ===
        path.resolve(app.getAppPath(), "dist", "index.html")
    );
  } catch {
    return false;
  }
}
function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "app-icon.ico")
    : path.join(app.getAppPath(), "assets/icons/app-icon.ico");
  const productionIndex = path.join(app.getAppPath(), "dist", "index.html");
  win = new BrowserWindow({
  width: 1536,
  height: 1024,
  minWidth: 800,
  minHeight: 600,
  title: "TWC Stafford Music Scheduler",
  backgroundColor: "#f7f9fc",
  autoHideMenuBar: true,
  frame: false,
  ...(existsSync(iconPath) ? { icon: iconPath } : {}),
  webPreferences: {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // The renderer owns announcement scheduling; keep its clock active while minimized.
    backgroundThrottling: false,
  },
});
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      const allowedHosts = new Set([
        "developer.spotify.com",
        "support.spotify.com",
      ]);
      if (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        allowedHosts.has(parsed.hostname)
      )
        void shell.openExternal(parsed.toString()).catch(() =>
          startupLog("[external] Could not open the approved Spotify help page."),
        );
    } catch {
      /* Reject malformed URLs. */
    }
    return { action: "deny" };
  });
  win.webContents.on("context-menu", (event, params) => {
    if (!params.misspelledWord) return;
    event.preventDefault();
    const suggestions = params.dictionarySuggestions.slice(0, 8);
    const menuItems: MenuItemConstructorOptions[] = suggestions.length
      ? suggestions.map(suggestion => ({ label: suggestion, click: () => win?.webContents.replaceMisspelling(suggestion) }))
      : [{ label: "No spelling suggestions", enabled: false }];
    menuItems.push({ type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    Menu.buildFromTemplate(menuItems).popup({ window: win });
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  let fallbackStarted = false;
  const loadProductionFallback = () => {
    if (fallbackStarted || !existsSync(productionIndex)) return;
    fallbackStarted = true;
    void win
      .loadFile(productionIndex)
      .catch((error) =>
        startupLog(`[renderer] production fallback failed: ${String(error)}`),
      );
  };
  win.webContents.on("did-finish-load", () =>
    startupLog(`[renderer] page loaded: ${win.webContents.getURL()}`),
  );
  win.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      startupLog(`[renderer] load failed (${code}) ${description}: ${url}`);
      if (isMainFrame && !app.isPackaged) loadProductionFallback();
    },
  );
  win.webContents.on("render-process-gone", (_event, details) =>
    startupLog(`[renderer] process exited: ${JSON.stringify(details)}`),
  );
  win.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      if (level >= 2) startupLog(`[renderer] ${message} (${sourceId}:${line})`);
    },
  );

  const devUrl = !app.isPackaged ? "http://localhost:5173" : undefined;
  const start = devUrl ? win.loadURL(devUrl) : win.loadFile(productionIndex);
  void start.catch(async (error) => {
    startupLog(`[renderer] initial load failed: ${String(error)}`);
    if (devUrl) loadProductionFallback();
  });
}
app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstance) return;
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    const spellLanguages = session.defaultSession.availableSpellCheckerLanguages;
    if (spellLanguages.includes("en-AU")) {
      session.defaultSession.setSpellCheckerLanguages(["en-AU"]);
      session.defaultSession.setSpellCheckerEnabled(true);
      startupLog("Native spell-check enabled with en-AU.");
    } else {
      session.defaultSession.setSpellCheckerEnabled(false);
      startupLog(`Native spell-check disabled because en-AU is unavailable (available: ${spellLanguages.join(", ")}).`);
    }
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== "mainFrame") {
        callback({});
        return;
      }
      const responseHeaders = { ...details.responseHeaders };
      delete responseHeaders["Content-Security-Policy"];
      delete responseHeaders["content-security-policy"];
      responseHeaders["Content-Security-Policy"] = [contentSecurityPolicy()];
      callback({ responseHeaders });
    });
    startupLog(
      `Electron ready; packaged=${app.isPackaged}; appPath=${app.getAppPath()}; localTimeZone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    );
    createWindow();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
    scheduleCoordinator = new ScheduleCoordinator({
      stateFile: path.join(app.getPath("userData"), "scheduler-runs.json"),
      getSchedules: async () => {
        const data = await readStore();
        return {
          settings: data.settings,
          schedules: data.schedules as any,
          exceptions: data.exceptions as any,
        };
      },
      execute: executeScheduleBoundary,
      recoverQuiet: async () => {
        await pauseIfPlaying();
      },
      enforceQuiet: pauseIfPlaying,
      log: addLog,
    });
    const quietAtStartup = await readStore();
    if (!activeQuietSchedules(quietAtStartup.schedules as any, new Date()).length) {
      try { await fs.unlink(quietSnapshotFile()); } catch (error: any) { if (error?.code !== "ENOENT") await addLog("warn", `Could not clear an expired quiet-hours playback snapshot: ${String(error)}`); }
    }
    scheduleCoordinator.start();
    powerMonitor.on("resume", () => void scheduleCoordinator?.tick("wake"));
    void addLog(
      "info",
      `Application started; local time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`,
    ).catch((error) => startupLog(`Could not write startup activity log: ${String(error)}`));
  })
  .catch((error) => startupLog(`Electron startup failed: ${String(error)}`));
app.on("before-quit", (event) => {
  if (shutdownLogging) return;
  event.preventDefault();
  shutdownLogging = true;
  scheduleCoordinator?.stop();
  startupLog("Application shutting down; scheduler stopped.");
  void addLog("info", "Application stopped; scheduler stopped.")
    .catch((error) =>
      startupLog(`Could not save shutdown log: ${String(error)}`),
    )
    .finally(() => app.quit());
});
process.on("uncaughtException", (error) => {
  startupLog(
    `Uncaught main-process exception: ${error.stack || error.message}`,
  );
  void addLog("error", `Uncaught main-process exception: ${error.message}`);
});
process.on("unhandledRejection", (reason) => {
  startupLog(`Unhandled main-process rejection: ${String(reason)}`);
  void addLog("error", `Unhandled main-process rejection: ${String(reason)}`);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
ipcMain.handle("data:load", (event) => {
  assertTrustedSender(event);
  return readStore();
});
ipcMain.handle("data:save", async (_e, input) => {
  assertTrustedSender(_e);
  const validDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let serializedSize: number;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    throw new Error("Invalid application data.");
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    serializedSize > 10 * 1024 * 1024 ||
    !input.settings ||
    typeof input.settings !== "object" ||
    Array.isArray(input.settings) ||
    !Array.isArray(input.schedules) ||
    input.schedules.length > 500 ||
    !Array.isArray(input.exceptions) ||
    input.exceptions.length > 1000 ||
    !Array.isArray(input.playlists) ||
    input.playlists.length > 5000
  )
    throw new Error("Invalid application data.");
  const ids = new Set<string>();
  for (const s of input.schedules) {
    if (
      !s ||
      typeof s.id !== "string" ||
      !s.id || s.id.length > 128 ||
      ids.has(s.id) ||
      typeof s.name !== "string" ||
      s.name.length > 80 ||
      (s.playlistName !== undefined && (typeof s.playlistName !== "string" || s.playlistName.length > 300)) ||
      (s.googleSourceId !== undefined && (typeof s.googleSourceId !== "string" || s.googleSourceId.length > 256)) ||
      (s.dates !== undefined && (!Array.isArray(s.dates) || s.dates.length > 100 || s.dates.some((d: any) => !/^\d{4}-\d{2}-\d{2}$/.test(d)))) ||
      (s.date !== undefined && !validLocalDateKey(s.date)) ||
      (s.repeat !== undefined && !["never", "daily", "weekly", "monthly", "yearly"].includes(s.repeat)) ||
      !Array.isArray(s.days) ||
      s.days.length > 7 ||
      new Set(s.days).size !== s.days.length ||
      s.days.some((d: unknown) => !validDays.includes(String(d))) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end) ||
      s.start === s.end ||
      typeof s.enabled !== "boolean" ||
      typeof s.quiet !== "boolean" ||
      (s.playlistId !== undefined && (typeof s.playlistId !== "string" || s.playlistId.length > 256)) ||
      (s.enabled && !s.quiet && (typeof s.playlistId !== "string" || !s.playlistId))
    )
      throw new Error("Invalid schedule data.");
    ids.add(s.id);
  }
  const dayIndex: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const minutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const weekMinutes = 7 * 1440;
  for (let i = 0; i < input.schedules.length; i++)
    for (let j = i + 1; j < input.schedules.length; j++) {
      const a = input.schedules[i],
        b = input.schedules[j];
      if (!a.enabled || !b.enabled || a.date || b.date || a.quiet || b.quiet) continue;
      for (const aDay of a.days)
        for (const bDay of b.days) {
          const aStart = dayIndex[aDay] * 1440 + minutes(a.start);
          let aEnd = dayIndex[aDay] * 1440 + minutes(a.end);
          if (aEnd <= aStart) aEnd += 1440;
          const bStart = dayIndex[bDay] * 1440 + minutes(b.start);
          let bEnd = dayIndex[bDay] * 1440 + minutes(b.end);
          if (bEnd <= bStart) bEnd += 1440;
          for (const shift of [-weekMinutes, 0, weekMinutes])
            if (aStart < bEnd + shift && bStart + shift < aEnd)
              throw new Error(
                `Schedule “${a.name}” conflicts with “${b.name}”.`,
              );
        }
    }
  const exceptionDates = new Set<string>();
  for (const e of input.exceptions) {
    const date =
      typeof e?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date)
        ? new Date(`${e.date}T00:00:00`)
        : null;
    const validDate =
      !!date &&
      !Number.isNaN(date.getTime()) &&
      `${date!.getFullYear()}-${String(date!.getMonth() + 1).padStart(2, "0")}-${String(date!.getDate()).padStart(2, "0")}` ===
        e.date;
    if (
      !e ||
      !validDate ||
      !["skip", "replace"].includes(e.type) ||
      (e.playlistName !== undefined && (typeof e.playlistName !== "string" || e.playlistName.length > 300)) ||
      (e.label !== undefined &&
        (typeof e.label !== "string" || e.label.length > 200)) ||
      (e.scheduleId !== undefined && (typeof e.scheduleId !== "string" || e.scheduleId.length > 128)) ||
      (e.googleSourceId !== undefined && (typeof e.googleSourceId !== "string" || e.googleSourceId.length > 256)) ||
      (e.type === "replace" &&
        (typeof e.playlistId !== "string" || !e.playlistId || e.playlistId.length > 256))
    )
      throw new Error(
        "Invalid date exception. Choose a valid date and either skip playback or select a replacement playlist.",
      );
    const exceptionKey = `${e.date}:${e.scheduleId || "*"}`;
    if (exceptionDates.has(exceptionKey))
      throw new Error(
        `Only one date exception may be configured for ${e.date}.`,
      );
    exceptionDates.add(exceptionKey);
  }
  for (const playlist of input.playlists) {
    let validImage = playlist?.image === null || playlist?.image === undefined;
    if (typeof playlist?.image === "string" && playlist.image.length <= 2048) {
      try {
        const imageUrl = new URL(playlist.image);
        validImage = imageUrl.protocol === "https:" && ["i.scdn.co", "mosaic.scdn.co", "image-cdn-ak.spotifycdn.com"].includes(imageUrl.hostname) && !imageUrl.username && !imageUrl.password;
      } catch {
        validImage = false;
      }
    }
    if (
      !playlist ||
      typeof playlist.id !== "string" || !playlist.id || playlist.id.length > 256 ||
      typeof playlist.uri !== "string" || playlist.uri.length > 512 ||
      typeof playlist.name !== "string" || playlist.name.length > 500 ||
      typeof playlist.description !== "string" || playlist.description.length > 10000 ||
      !Number.isSafeInteger(playlist.tracks) || playlist.tracks < 0 ||
      !validImage
    ) throw new Error("Invalid Spotify playlist data.");
  }
  const settingKeys = new Set(["schedulerEnabled", "spotifyClientId", "googleClientId", "googleLocation", "googleLocationTitle", "googleLastSync", "googleSyncMinutes", "defaultPlaylist", "timezone"]);
  if (
    Object.keys(input.settings).some((key) => !settingKeys.has(key)) ||
    typeof input.settings.schedulerEnabled !== "boolean" ||
    typeof input.settings.spotifyClientId !== "string" ||
    input.settings.spotifyClientId.length > 200 ||
    (input.settings.googleClientId !== undefined && (typeof input.settings.googleClientId !== "string" || input.settings.googleClientId.length > 300)) ||
    typeof input.settings.defaultPlaylist !== "string" ||
    input.settings.defaultPlaylist.length > 256 ||
    (input.settings.timezone !== undefined &&
      (typeof input.settings.timezone !== "string" || input.settings.timezone.length > 128))
  )
    throw new Error("Invalid settings data.");
  await withStoreMutation(async () => {
    const current = await readStore();
    await writeStore({
      settings: {
        schedulerEnabled: input.settings.schedulerEnabled,
        spotifyClientId: input.settings.spotifyClientId,
        googleClientId: input.settings.googleClientId || "",
        ...(typeof input.settings.googleLocation === "string" ? { googleLocation: input.settings.googleLocation } : {}),
        ...(typeof input.settings.googleLocationTitle === "string" ? { googleLocationTitle: input.settings.googleLocationTitle } : {}),
        ...(typeof input.settings.googleLastSync === "string" ? { googleLastSync: input.settings.googleLastSync } : {}),
        ...(Number.isInteger(input.settings.googleSyncMinutes) ? { googleSyncMinutes: input.settings.googleSyncMinutes } : {}),
        defaultPlaylist: input.settings.defaultPlaylist,
        ...(input.settings.timezone !== undefined ? { timezone: input.settings.timezone } : {}),
      },
      schedules: input.schedules.map(({ id, name, days, dates, date, repeat, googleSourceId, start, end, playlistId, playlistName, enabled, quiet }: any) =>
        ({ id, name, days, ...(dates ? { dates } : {}), ...(date ? { date } : {}), ...(repeat ? { repeat } : {}), ...(googleSourceId ? { googleSourceId } : {}), start, end, ...(playlistId !== undefined ? { playlistId } : {}), ...(playlistName !== undefined ? { playlistName } : {}), enabled, quiet })),
      exceptions: input.exceptions.map(({ date, type, playlistId, playlistName, label, scheduleId, googleSourceId }: any) =>
        ({ date, type, ...(playlistId !== undefined ? { playlistId } : {}), ...(playlistName !== undefined ? { playlistName } : {}), ...(label !== undefined ? { label } : {}), ...(scheduleId ? { scheduleId } : {}), ...(googleSourceId ? { googleSourceId } : {}) })),
      playlists: input.playlists.map(({ id, uri, name, description, tracks, image }: any) =>
        ({ id, uri, name, description, tracks, image: image ?? null })),
      logs: current.logs,
      announcements: Array.isArray(input.announcements) ? input.announcements.filter((a: any) => a && typeof a.id === "string" && typeof a.name === "string" && a.name.length <= 500 && typeof a.file === "string" && typeof a.enabled === "boolean").map((a: any) => ({ id: a.id, name: a.name, file: a.file, enabled: a.enabled, ...(Number.isInteger(a.volume) && a.volume >= 0 && a.volume <= 100 ? { volume: a.volume } : {}) })) : current.announcements,
      announcementSchedules: Array.isArray(input.announcementSchedules) ? input.announcementSchedules.filter((s: any) => validAnnouncementSchedule(s, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])) : current.announcementSchedules,
      advertisements: Array.isArray(input.advertisements) ? input.advertisements.filter((a: any) => a && typeof a.id === "string" && /^[\w-]{36}$/.test(a.id) && typeof a.name === "string" && a.name.trim().length > 0 && a.name.length <= 500 && (a.description === undefined || (typeof a.description === "string" && a.description.length <= 2000)) && /^[\w-]{36}\.(mp3|wav)$/.test(a.file) && typeof a.enabled === "boolean").map((a: any) => ({ id: a.id, name: a.name.trim(), ...(typeof a.description === "string" ? { description: a.description } : {}), file: a.file, enabled: a.enabled, ...(Number.isInteger(a.volume) && a.volume >= 0 && a.volume <= 100 ? { volume: a.volume } : {}) })) : current.advertisements,
      advertisementSchedules: Array.isArray(input.advertisementSchedules) ? input.advertisementSchedules.map(normalizeAdvertisementSchedule).filter(Boolean) : current.advertisementSchedules,
    });
  });
  void scheduleCoordinator?.tick("poll");
  return true;
});
const audioDirectory = (kind: "announcements" | "advertisements") => path.join(app.getPath("userData"), kind);
async function importAudioFiles(kind: "announcements" | "advertisements") {
  const pick = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters: [{ name: "Audio", extensions: ["mp3", "wav"] }] });
  if (pick.canceled) return [];
  await fs.mkdir(audioDirectory(kind), { recursive: true });
  const added = [];
  for (const source of pick.filePaths) {
    const ext = path.extname(source).toLowerCase();
    if (![".mp3", ".wav"].includes(ext)) continue;
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) continue;
    const id = crypto.randomUUID();
    const filename = `${id}${ext}`;
    await fs.copyFile(source, path.join(audioDirectory(kind), filename), fs.constants.COPYFILE_EXCL);
    added.push({ id, name: path.basename(source), ...(kind === "advertisements" ? { description: "" } : {}), file: filename, enabled: true });
  }
  return added;
}
async function readAudioFile(kind: "announcements" | "advertisements", id: string) {
  const diagnostic = async (level: "info" | "warn" | "error", message: string) => {
    if (kind === "advertisements") await addLog(level, `Advertisement audio: ${message}`).catch(() => undefined);
  };
  try {
    if (typeof id !== "string" || !/^[\w-]{36}$/.test(id)) throw new Error("Invalid advertisement ID.");
    const store = await readStore();
    const item = store[kind].find((a: any) => a.id === id);
    if (!item) throw new Error(kind === "advertisements" ? "Advertisement record was not found." : "Announcement record was not found.");
    if (!/^[\w-]{36}\.(mp3|wav)$/.test(item.file)) throw new Error("Audio filename is missing or invalid.");
    const filePath = path.join(audioDirectory(kind), item.file);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 100 * 1024 * 1024) throw new Error("Audio file is empty, oversized, or not a regular file.");
    const data = await fs.readFile(filePath);
    await diagnostic("info", `file resolved; category=${kind}; filename=${item.file}; exists=true; bytes=${data.length}`);
    return `data:${item.file.endsWith(".wav") ? "audio/wav" : "audio/mpeg"};base64,${data.toString("base64")}`;
  } catch (error) {
    await diagnostic("error", `load failed; category=${kind}; ${String(error)}`);
    throw error;
  }
}
async function deleteAudioFile(kind: "announcements" | "advertisements", id: string) {
  if (typeof id !== "string" || !/^[\w-]{36}$/.test(id)) throw new Error("Invalid announcement.");
  const store = await readStore(); const item = store[kind].find((a: any) => a.id === id);
  if (item && /^[\w-]{36}\.(mp3|wav)$/.test(item.file)) await fs.unlink(path.join(audioDirectory(kind), item.file)).catch((e: any) => { if (e.code !== "ENOENT") throw e; });
  return true;
}
ipcMain.handle("announcements:import", async (event) => { assertTrustedSender(event); return importAudioFiles("announcements"); });
ipcMain.handle("announcements:audio", async (event, id: string) => { assertTrustedSender(event); return readAudioFile("announcements", id); });
ipcMain.handle("announcements:delete-file", async (event, id: string) => { assertTrustedSender(event); return deleteAudioFile("announcements", id); });
ipcMain.handle("advertisements:import", async (event) => { assertTrustedSender(event); return importAudioFiles("advertisements"); });
ipcMain.handle("advertisements:audio", async (event, id: string) => { assertTrustedSender(event); return readAudioFile("advertisements", id); });
ipcMain.handle("advertisements:delete-file", async (event, id: string) => { assertTrustedSender(event); return deleteAudioFile("advertisements", id); });
ipcMain.handle("log:add", async (event, input) => {
  assertTrustedSender(event);
  if (
    !input ||
    typeof input.message !== "string" ||
    input.message.length > 500 ||
    !["info", "warn", "error"].includes(input.level)
  )
    throw new Error("Invalid log entry.");
  await addLog(input.level, input.message);
  return true;
});
ipcMain.handle("logs:load", (event) => {
  assertTrustedSender(event);
  return readStore().then((s) => s.logs);
});
ipcMain.handle("logs:clear", async (event) => {
  assertTrustedSender(event);
  await withStoreMutation(async () => {
    const s = await readStore();
    s.logs = [];
    await writeStore(s);
  });
  return true;
});
ipcMain.handle("scheduler:status", async (event) => {
  assertTrustedSender(event);
  const data = await readStore();
  return {
    quiet:
      data.settings.schedulerEnabled === true &&
      activeQuietSchedules(data.schedules as any, new Date()).length > 0,
    localTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
});
ipcMain.handle("device:info", (event) => {
  assertTrustedSender(event);
  return playbackDeviceInfo();
});
ipcMain.handle("spotify:open-desktop", async (event) => {
  assertTrustedSender(event);
  return openSpotifyDesktop();
});
ipcMain.handle("window:action", (event, action) => {
  assertTrustedSender(event);
  if (!["minimize", "maximize", "close"].includes(action))
    throw new Error("Invalid window action.");
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) return;
  if (action === "minimize") target.minimize();
  else if (action === "maximize")
    target.isMaximized() ? target.unmaximize() : target.maximize();
  else target.close();
});
ipcMain.handle("spotify:status", (event) => {
  assertTrustedSender(event);
  return spotifyStatus();
});
ipcMain.handle("spotify:disconnect", async (event) => {
  assertTrustedSender(event);
  await deleteToken();
  await addLog("info", "Spotify disconnected.");
  return { connected: false, message: "Spotify disconnected." };
});
ipcMain.handle("spotify:connect", async (event) => {
  assertTrustedSender(event);
  const data = await readStore(),
    clientId = String(data.settings.spotifyClientId || "").trim();
  if (!clientId)
    throw new Error("Add your Spotify Client ID in Settings first.");
  const verifier = crypto.randomBytes(48).toString("base64url"),
    challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url"),
    state = crypto.randomBytes(16).toString("hex");
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start local Spotify callback.");
  const redirect = `http://127.0.0.1:${address.port}/callback`;
  const callback = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Spotify authorization timed out."));
    }, 180000);
    server.on("request", (req, res) => {
      if (
        req.method !== "GET" ||
        req.headers.host !== `127.0.0.1:${address.port}`
      ) {
        res.writeHead(400).end("Invalid local callback request.");
        return;
      }
      try {
        const result = validateOAuthCallback(
          new URL(req.url || "/", redirect).toString(),
          redirect,
          state,
        );
        res
          .writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'",
          })
          .end(
            result.code
              ? "Spotify connected. You can close this window."
              : "Spotify authorization received. You can close this window.",
          );
        clearTimeout(timeout);
        server.close();
        resolve(result.code);
      } catch (error) {
        const message = String(error).replace(/^Error: /, "");
        res
          .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
          .end(message);
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });
  });
  const scopes =
    "user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative";
  const auth = new URL("https://accounts.spotify.com/authorize");
  Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: scopes,
  }).forEach(([k, v]) => auth.searchParams.set(k, v));
  try {
    await shell.openExternal(auth.toString());
    const code = await callback;
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: clientId,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const token = (await response.json()) as any;
    if (!response.ok)
      throw new Error(
        token.error_description ||
          token.error ||
          `Spotify returned ${response.status}`,
      );
    if (
      !token ||
      typeof token.access_token !== "string" ||
      !token.access_token ||
      token.access_token.length > 8192 ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0 ||
      (token.refresh_token !== undefined &&
        (typeof token.refresh_token !== "string" || token.refresh_token.length > 8192))
    )
      throw new Error("Spotify returned invalid credentials. Reconnect Spotify.");
    await writeToken({
      ...token,
      scope: typeof token.scope === "string" ? token.scope : "",
      client_id: clientId,
      authorized_at: Date.now(),
      expires_at: Date.now() + token.expires_in * 1000,
    });
    const status = await spotifyStatus();
    if (!status.connected) throw new Error(status.message);
    await addLog("info", "Spotify authorization verified.");
    return status;
  } catch (e) {
    server.close();
    await addLog("error", `Spotify connection failed: ${String(e)}`);
    throw new Error(redactSecrets(e));
  }
});
ipcMain.handle("google:status", (event) => { assertTrustedSender(event); return googleToken().then(t => ({ connected: !!t?.refresh_token, message: t ? "Google account connected." : "Not connected. Configure an OAuth client ID and Google Business Profile API access." })); });
ipcMain.handle("google:disconnect", async (event) => { assertTrustedSender(event); await fs.unlink(googleTokenFile()).catch(() => undefined); return { connected: false, message: "Google account disconnected." }; });
ipcMain.handle("google:import-desktop-client", async (event) => {
  assertTrustedSender(event);
  if (!secureStorageAvailable()) throw new Error("Secure system credential storage is unavailable. The OAuth client file cannot be stored safely.");
  const picked = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Google OAuth client JSON", extensions: ["json"] }] });
  if (picked.canceled || !picked.filePaths[0]) return { imported: false };
  const raw = await fs.readFile(picked.filePaths[0], "utf8");
  if (raw.length > 65536) throw new Error("Google OAuth client JSON file is too large.");
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new Error("The selected Google OAuth client file is not valid JSON."); }
  const desktop = parsed?.installed;
  if (!desktop || typeof desktop.client_id !== "string" || typeof desktop.client_secret !== "string" || !desktop.client_secret)
    throw new Error("Select the downloaded OAuth client JSON for a Desktop app (the file should contain an installed client). Web client files are not accepted.");
  const { settings } = await readStore();
  if (desktop.client_id !== String(settings.googleClientId || "").trim()) throw new Error("The selected Desktop OAuth file does not match the Client ID currently configured in Settings.");
  const encrypted = safeStorage.encryptString(JSON.stringify({ client_id: desktop.client_id, client_secret: desktop.client_secret }));
  const target = googleClientCredentialFile(), temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, encrypted, { mode: 0o600, flag: "w" }); await fs.rename(temp, target);
  return { imported: true };
});
ipcMain.handle("google:connect", async (event) => {
  assertTrustedSender(event);
  const { settings } = await readStore(); const clientId = String(settings.googleClientId || "").trim();
  if (!clientId) throw new Error("Add a Google OAuth Client ID in Settings first. Use an OAuth client for a Desktop app; no client secret is used.");
  if (!secureStorageAvailable()) throw new Error("Secure system credential storage is unavailable. Google tokens cannot be stored safely on this system.");
  const state = crypto.randomBytes(24).toString("hex"), verifier = crypto.randomBytes(48).toString("base64url"), challenge = createGoogleCodeChallenge(verifier), server = http.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not start Google OAuth callback.");
  // Google Desktop OAuth uses the loopback IP and ephemeral port as the entire
  // redirect URI. Keep this exact value for both authorization and token exchange.
  const redirect = `http://127.0.0.1:${address.port}`;
  let authorizationTimeout: NodeJS.Timeout | undefined;
  const callback = new Promise<string>((resolve, reject) => {
    authorizationTimeout = setTimeout(() => { server.close(); reject(new Error("Google authorization timed out.")); }, 180000);
    let handled = false;
    server.on("request", (req, res) => {
      if (handled) { res.writeHead(409).end("This Google authorization response was already handled."); return; }
      if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${address.port}`) { res.writeHead(400).end("Invalid local OAuth callback."); return; }
      try {
        const result = validateGoogleOAuthCallback(new URL(req.url || "/", redirect).toString(), redirect, state);
        handled = true;
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'" }).end("Google authorization received. You may close this tab and return to the app.");
        if (authorizationTimeout) clearTimeout(authorizationTimeout); server.close(); resolve(result.code);
      } catch (error) {
        // A valid OAuth denial is terminal too; invalid local requests do not
        // consume the authorization attempt.
        if (/authorization was canceled|authorization failed/.test(String(error))) {
          handled = true; res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'" }).end("Google authorization was not granted. Return to the app.");
          if (authorizationTimeout) clearTimeout(authorizationTimeout); server.close(); reject(error); return;
        }
        res.writeHead(400).end("Google authorization failed. Return to the app for details.");
      }
    });
  });
  try {
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth"); Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "https://www.googleapis.com/auth/business.manage", access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => auth.searchParams.set(k, v));
    await shell.openExternal(auth.toString()); const code = await callback;
    const data = await exchangeGoogleAuthorizationCode({ clientId, code, redirectUri: redirect, codeVerifier: verifier, clientSecret: await googleDesktopClientSecret(clientId) });
    const token = { ...data, client_id: clientId, expires_at: Date.now() + data.expires_in * 1000 }; await fs.writeFile(googleTokenFile(), safeStorage.encryptString(JSON.stringify(token)), { mode: 0o600 }); return { connected: true, message: "Google account connected." };
  } catch (error) { if (authorizationTimeout) clearTimeout(authorizationTimeout); server.close(); throw new Error(redactSecrets(error)); }
});
async function googleApi(url: string): Promise<any> { const access = await googleAccess(); const response = await fetch(url, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000) }); const data: any = await response.json().catch(() => ({})); if (!response.ok) throw googleApiError(response.status, data.error?.message || ""); return data; }
let googleLocationsInFlight: Promise<any[]> | null = null;
ipcMain.handle("google:locations", async (event) => {
  assertTrustedSender(event);
  if (googleLocationsInFlight) return googleLocationsInFlight;
  googleLocationsInFlight = (async () => {
    const result: any[] = []; let accountPage = "";
    do {
      const accountUrl = new URL("https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
      if (accountPage) accountUrl.searchParams.set("pageToken", accountPage);
      const accounts = await googleApi(accountUrl.toString());
      for (const account of accounts.accounts || []) {
        let pageToken = "";
        do {
          const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`);
          url.searchParams.set("readMask", "name,title,storefrontAddress,regularHours,specialHours");
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const body = await googleApi(url.toString());
          result.push(...(body.locations || []).map((location: any) => ({ ...location, accountName: account.name })));
          pageToken = body.nextPageToken || "";
        } while (pageToken);
      }
      accountPage = accounts.nextPageToken || "";
    } while (accountPage);
    return result;
  })();
  try { return await googleLocationsInFlight; }
  finally { googleLocationsInFlight = null; }
});
ipcMain.handle("google:hours", async (event, name: string) => { assertTrustedSender(event); if (typeof name !== "string" || !/^locations\/[^/]+$/.test(name)) throw new Error("Invalid Google Business Profile location."); return googleApi(`https://mybusinessbusinessinformation.googleapis.com/v1/${name}?readMask=name,title,regularHours,specialHours`); });
ipcMain.handle("spotify:playlists", async (event) => {
  assertTrustedSender(event);
  const all: any[] = [];
  let offset = 0;
  while (offset <= 100000) {
    const access = await validAccessToken();
    const r = await fetch(
      `https://api.spotify.com/v1/me/playlists?limit=50&offset=${offset}`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) {
      if (r.status === 401) await deleteToken();
      throw new Error(
        redactSecrets(spotifyHttpError(
          r.status,
          r.headers.get("Retry-After"),
          await r.text(),
        )),
      );
    }
    const body = (await r.json()) as any;
    all.push(
      ...(body.items || []).map((p: any) => ({
        id: p.id,
        uri: p.uri,
        name: p.name,
        description: p.description || "",
        tracks: p.items?.total ?? p.tracks?.total ?? 0,
        image: p.images?.[0]?.url || null,
      })),
    );
    offset += body.limit || 50;
    if (!body.next || !body.items?.length) break;
  }
  return all;
});
async function spotifyRequest(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<any | null> {
  try {
    return await requestSpotifyApi({
      method,
      endpoint,
      body,
      getAccessToken: () => validAccessToken(),
      refreshAccessToken: () => validAccessToken(true),
      onUnauthorized: deleteToken,
    });
  } catch (error) {
    throw new Error(redactSecrets(error));
  }
}
async function freshSpotifyDevices() {
  const response = await spotifyRequest("GET", "/me/player/devices");
  if (!Array.isArray(response?.devices)) throw new Error("Spotify did not return a fresh device list.");
  return response.devices;
}
async function logSpotifyDeviceSnapshot(devices: any[], stage: string, source: string) {
  await addLog("info", `Spotify ${source} device response (${stage}): ${JSON.stringify(sanitizeSpotifyDevices(devices))}`);
}
ipcMain.handle("spotify:playback", async (event) => {
  assertTrustedSender(event);
  return currentPlayback();
});
ipcMain.handle(
  "spotify:control",
  async (event, action: string, value?: number) => {
    assertTrustedSender(event);
    try {
    if (
      !["play", "pause", "previous", "next", "volume"].includes(action)
    )
      throw new Error("Invalid Spotify playback operation.");
    if (
      action === "volume" &&
      (!Number.isInteger(value) || value! < 0 || value! > 100)
    )
      throw new Error("Invalid Spotify volume. Choose a value from 0 to 100.");
      if (action === "play") {
        await verifyScheduledPlaybackScopes();
        const started = await startSpotifyPlayback({
          getPlayback: async () => await spotifyRequest("GET", "/me/player"),
          getDevices: freshSpotifyDevices,
          transfer: async deviceId => { const command = transferPlaybackCommand(deviceId); await spotifyRequest(command.method, command.endpoint, command.body); },
          play: async deviceId => { const command = playbackCommand("play", deviceId); await spotifyRequest(command.method, command.endpoint); },
          onDevices: (devices, stage) => logSpotifyDeviceSnapshot(devices, stage, "manual playback start"),
          onStage: stage => event.sender.send("spotify:playback-stage", { stage }),
        });
        await addLog("info", `Manual playback start accepted on an active Spotify device (device ID present: yes; transferred: ${started.transferred}).`);
        return await currentPlayback();
      }
      const playback = await currentPlayback();
      const deviceId =
        playback?.device?.is_usable && typeof playback.device.id === "string"
          ? playback.device.id
          : null;
      if (!deviceId)
        throw new Error(
          "Spotify is connected, but no usable playback device is available. Open Spotify, wait for it to appear in Available Devices, then try again.",
        );
      if (
        action === "volume" &&
        Number.isInteger(value) &&
        value! >= 0 &&
        value! <= 100
      ) {
        if (playback.device.supports_volume === false)
          throw new Error(
            "Spotify volume control is not supported on this device.",
          );
        await spotifyRequest(
          "PUT",
          `/me/player/volume?volume_percent=${value}&device_id=${encodeURIComponent(deviceId)}`,
        );
      } else if (
        action === "play" ||
        action === "pause" ||
        action === "previous" ||
        action === "next"
      ) {
        const command = playbackCommand(action, deviceId);
        await spotifyRequest(command.method, command.endpoint);
      } else throw new Error("Invalid Spotify playback operation.");
      await addLog(
        "info",
        `Spotify playback command completed: ${action}${action === "volume" ? ` ${value}%` : ""}.`,
      );
      return await currentPlayback();
    } catch (e) {
      if (action === "play") event.sender.send("spotify:playback-stage", { stage: "playback-failed" });
      await addLog(
        "error",
        `Spotify playback command failed (${action}): ${String(e)}`,
      );
      throw new Error(redactSecrets(e));
    }
  },
);
async function currentPlayback() {
  const state = await spotifyRequest("GET", "/me/player");
  let devices: any[] = [];
  try {
    const available = (await spotifyRequest(
      "GET",
      "/me/player/devices",
    )) as any;
    devices = Array.isArray(available?.devices) ? available.devices : [];
  } catch (error) {
    // A current active state is still useful if refreshing the device list fails.
    if (!state) throw error;
  }
  const selected = usableDevice(state, devices);
  if (!state && !selected) return null;
  const stateDeviceId = state?.device?.id;
  const sameActiveDevice =
    !!selected && selected.id === stateDeviceId && !!state?.device?.is_active;
  const device = selected
    ? { ...selected, is_usable: true }
    : state?.device
      ? { ...state.device, is_usable: false }
      : null;
  if (!state)
    return {
      is_playing: false,
      device,
      item: null,
      actions: { disallows: {} },
    };
  // Preserve Spotify's reported playing state even if the device endpoint is briefly stale.
  if (!sameActiveDevice) return { ...state, device };
  return { ...state, device, actions: state.actions };
}
async function verifyScheduledPlaybackScopes() {
  const token = await readToken();
  const missing = missingPlaybackScopes(token?.scope);
  if (missing.length)
    throw new Error(`Spotify authorization is missing or does not report required permission(s): ${missing.join(", ")}. Reconnect Spotify and approve playback state and control access.`);
}
async function pauseIfPlaying() {
  const state = await currentPlayback();
  if (!state?.is_playing) return false;
  await spotifyRequest("PUT", "/me/player/pause");
  return true;
}
const quietSnapshotFile = () =>
  path.join(app.getPath("userData"), "quiet-playback-state.json");
async function readQuietSnapshot(): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(quietSnapshotFile(), "utf8"));
  } catch {
    return null;
  }
}
async function saveQuietSnapshot(state: any) {
  const snapshot = {
    ...captureQuietPlayback(state),
    savedAt: Date.now(),
    deviceId: state?.device?.id || null,
  };
  const target = quietSnapshotFile(),
    temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(snapshot), "utf8");
  await fs.rename(temp, target);
}
async function restoreQuietSnapshot() {
  const snapshot = await readQuietSnapshot();
  if (!snapshot) {
    await addLog(
      "warn",
      "Quiet hours ended without a saved playback snapshot; nothing was resumed.",
    );
    return;
  }
  try {
    const plan = quietRestorePlan(snapshot);
    if (!plan) {
      await addLog(
        "info",
        "Quiet hours ended; playback was not resumed because it had been paused or lacked a saved context.",
      );
      try {
        await fs.unlink(quietSnapshotFile());
      } catch {
        /* Cleanup is best effort. */
      }
      return;
    }
    const { positionMs, ...body } = plan;
    await spotifyRequest("PUT", "/me/player/play", body);
    if (positionMs > 0)
      await spotifyRequest("PUT", `/me/player/seek?position_ms=${positionMs}`);
    await addLog(
      "info",
      "Restored the pre-quiet-hours Spotify context and playback state.",
    );
  } catch (error) {
    await addLog(
      "error",
      `Could not restore playback after quiet hours: ${String(error)}`,
    );
    throw error;
  } finally {
    try {
      await fs.unlink(quietSnapshotFile());
    } catch {
      /* Snapshot cleanup is best effort. */
    }
  }
}
async function executeScheduleBoundary(event: {
  schedule: any;
  boundary: "start" | "end";
}) {
  const { schedule, boundary } = event;
  if (schedule.quiet) {
    if (boundary === "start") {
      if (await readQuietSnapshot()) return;
      const state = await currentPlayback();
      await saveQuietSnapshot(state);
      if (state?.is_playing) await spotifyRequest("PUT", "/me/player/pause");
      return;
    }
    const current = await readStore();
    if (activeQuietSchedules(current.schedules as any, new Date()).length) return;
    await restoreQuietSnapshot();
    return;
  }
  if (boundary === "start") {
    if (activeQuietSchedules((await readStore()).schedules as any, new Date()).length) {
      await addLog("info", `Skipped scheduled playback for ${schedule.name} because a No Playback schedule is active.`);
      return;
    }
    if (!schedule.playlistId)
      throw new Error("This schedule has no Spotify playlist assigned.");
    await verifyScheduledPlaybackScopes();
    const result = await startScheduledPlayback({
      playlistId: schedule.playlistId,
      getPlayback: async () => await spotifyRequest("GET", "/me/player"),
      getDevices: freshSpotifyDevices,
      transfer: async deviceId => {
        const command = transferPlaybackCommand(deviceId);
        await spotifyRequest(command.method, command.endpoint, command.body);
      },
      onDevices: (devices, stage) => logSpotifyDeviceSnapshot(devices, stage, "scheduled start"),
      play: async (deviceId, playlistUri) => {
        const command = playlistPlaybackCommand(playlistUri, deviceId);
        await spotifyRequest(command.method, command.endpoint, command.body);
      },
    });
    await addLog("info", `Scheduled playback started and was confirmed on an active Spotify device (device ID present: yes; transferred: ${result.transferred}).`);
    return;
  }
  const state = await currentPlayback();
  const expected = `spotify:playlist:${schedule.playlistId}`;
  if (state?.is_playing && state.context?.uri === expected)
    await spotifyRequest("PUT", "/me/player/pause");
}
