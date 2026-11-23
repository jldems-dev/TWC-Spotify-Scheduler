import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("TWCSBKP1");
const FORMAT_VERSION = 1;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const SINGLETONS = ["scheduler-data.json", "scheduler-runs.json", "announcement-runs.json", "quiet-playback-state.json", "spotify-token.bin", "google-business-token.bin", "google-desktop-client.bin"];
const mediaPath = /^(announcements|advertisements)\/[\w-]{36}\.(mp3|wav)$/;
const brandingPath = /^branding\/[\w-]{36}(?:-(?:256|128|64|32))?\.(?:png|jpe?g|webp)$/i;
const configDefaults = (defaultDirectory: string) => ({ enabled: false, frequency: "daily" as "daily" | "weekly", destination: defaultDirectory, retention: 10, lastSuccessfulAt: null as string | null, lastAttemptAt: null as string | null, history: [] as BackupHistoryItem[] });

export type BackupHistoryItem = { file: string; createdAt: string; appVersion: string; size: number; status: "complete" | "failed"; reason?: string; reasonType?: string };
export type BackupSettings = ReturnType<typeof configDefaults>;
export type BackupStatus = { settings: BackupSettings; busy: boolean; progress: { stage: string; percent: number; message: string } | null; lastError: string | null };
export type BackupPreview = { token: string; createdAt: string; appVersion: string; fileCount: number; totalBytes: number; categories: string[] };
type Manifest = { formatVersion: number; appVersion: string; createdAt: string; files: { path: string; present: boolean; size: number; sha256: string | null }[] };
type FileSource = { relative: string; source?: string; buffer?: Buffer; present: boolean; size: number; sha256: string | null };
type Dependencies = {
  userData: string;
  defaultDirectory: string;
  configFile: string;
  appVersion: string;
  protectKey: (key: Buffer) => Buffer;
  unprotectKey: (wrapped: Buffer) => Buffer;
  getOverrides?: () => Promise<Record<string, Buffer>>;
  validateStore?: (bytes: Buffer) => void;
  validateSnapshot?: (bytes: Buffer, includedPaths: string[]) => void;
  availableSpace?: (directory: string) => Promise<number | null>;
  log: (level: "info" | "warn" | "error", message: string) => Promise<unknown> | unknown;
  onStatus?: (status: BackupStatus) => void;
};

function isAllowedRelative(relative: string): boolean {
  if (typeof relative !== "string" || relative.includes("\\") || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) return false;
  if (SINGLETONS.includes(relative)) return true;
  return mediaPath.test(relative) || brandingPath.test(relative);
}
function formatStamp(date: Date) { return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`; }
function safeNumber(value: unknown, max: number) { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }
async function hashFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(filePath)) { const bytes = chunk as Buffer; size += bytes.length; hash.update(bytes); }
  return { size, sha256: hash.digest("hex") };
}
async function hashBuffer(bytes: Buffer) { return { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }; }
async function writeJsonAtomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 }); await fs.rename(temp, file); }
  catch (error) { await fs.unlink(temp).catch(() => undefined); throw error; }
}
async function readExactly(handle: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset); if (!bytesRead) throw new Error("The backup is truncated."); offset += bytesRead; }
  return buffer;
}

/** Encrypted, checksummed backup/restore manager for the app's known userData files. */
export class BackupService {
  private settings: BackupSettings;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private progress: BackupStatus["progress"] = null;
  private lastError: string | null = null;
  private selections = new Map<string, { file: string; preview: BackupPreview; expires: number }>();
  private restoringFile: string | null = null;
  private operationPromise: Promise<unknown> | null = null;
  private automaticCheckBusy = false;
  private stopping = false;
  constructor(private deps: Dependencies) { this.settings = configDefaults(deps.defaultDirectory); }
  status(): BackupStatus { return { settings: structuredClone(this.settings), busy: this.busy, progress: this.progress, lastError: this.lastError }; }
  private publish() { this.deps.onStatus?.(this.status()); }
  private setProgress(stage: string, percent: number, message: string) { this.progress = { stage, percent: Math.max(0, Math.min(100, Math.round(percent))), message }; this.publish(); }
  private async persistSettings() { await writeJsonAtomic(this.deps.configFile, this.settings); }
  async initialize() {
    this.stopping = false;
    try {
      const parsed = JSON.parse(await fs.readFile(this.deps.configFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.settings = { ...configDefaults(this.deps.defaultDirectory), ...parsed };
        if (typeof this.settings.enabled !== "boolean") this.settings.enabled = false;
        if (this.settings.frequency !== "daily" && this.settings.frequency !== "weekly") this.settings.frequency = "daily";
        if (typeof this.settings.destination !== "string" || !path.isAbsolute(this.settings.destination)) this.settings.destination = this.deps.defaultDirectory;
        if (!Number.isInteger(this.settings.retention) || this.settings.retention < 1 || this.settings.retention > 100) this.settings.retention = 10;
        if (!Array.isArray(this.settings.history)) this.settings.history = [];
        this.settings.history = this.settings.history.filter(item => item && typeof item.file === "string" && typeof item.createdAt === "string" && typeof item.size === "number" && ["complete", "failed"].includes(item.status)).slice(-100);
        if (typeof this.settings.lastSuccessfulAt !== "string") this.settings.lastSuccessfulAt = null;
        if (typeof this.settings.lastAttemptAt !== "string") this.settings.lastAttemptAt = null;
      }
    } catch (error: any) { if (error?.code !== "ENOENT") await this.deps.log("warn", `Backup preferences could not be read; default backup settings are active: ${String(error)}`); }
    await this.recoverInterruptedRestores();
    await fs.mkdir(this.deps.defaultDirectory, { recursive: true });
    this.timer = setInterval(() => { void this.checkAutomaticSchedule(); }, 60_000);
    this.timer.unref?.();
    void this.checkAutomaticSchedule();
    this.publish();
  }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; if (this.operationPromise) await this.operationPromise.catch(() => undefined); }
  async updateSettings(patch: Partial<Pick<BackupSettings, "enabled" | "frequency" | "retention">>) {
    if (!patch || typeof patch !== "object") throw new Error("Invalid backup settings.");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("Automatic backups must be enabled or disabled.");
    if (patch.frequency !== undefined && patch.frequency !== "daily" && patch.frequency !== "weekly") throw new Error("Choose daily or weekly backups.");
    if (patch.retention !== undefined && (!Number.isInteger(patch.retention) || patch.retention < 1 || patch.retention > 100)) throw new Error("Backup retention must be between 1 and 100.");
    this.settings = { ...this.settings, ...patch };
    await this.persistSettings(); this.publish();
    if (this.settings.enabled) void this.checkAutomaticSchedule();
    return this.status();
  }
  async setDestination(destination: string) {
    if (typeof destination !== "string" || !path.isAbsolute(destination) || destination.length > 2048) throw new Error("Choose a valid backup folder.");
    await fs.mkdir(destination, { recursive: true });
    const stat = await fs.stat(destination);
    if (!stat.isDirectory()) throw new Error("The backup destination is not a folder.");
    await fs.access(destination, fs.constants.W_OK);
    this.settings.destination = path.resolve(destination);
    await this.persistSettings(); this.publish(); return this.status();
  }
  async checkAutomaticSchedule(now = Date.now()) {
    if (this.stopping || !this.settings.enabled || this.busy || this.automaticCheckBusy) return;
    const interval = this.settings.frequency === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (this.settings.lastSuccessfulAt && now - Date.parse(this.settings.lastSuccessfulAt) < interval) return;
    if (this.settings.lastAttemptAt && now - Date.parse(this.settings.lastAttemptAt) < 60 * 60 * 1000) return;
    this.automaticCheckBusy = true;
    try { this.settings.lastAttemptAt = new Date(now).toISOString(); await this.persistSettings(); if (!this.stopping) await this.createBackup("automatic"); }
    catch (error) { /* Failure is surfaced through status and app logs. */ this.lastError = String(error); this.publish(); }
    finally { this.automaticCheckBusy = false; }
  }
  async createBackup(reason = "manual", options: { force?: boolean; destination?: string } = {}) {
    if (this.stopping) throw new Error("The application is shutting down; backup could not start.");
    if (this.busy) throw new Error("A backup or restore operation is already in progress.");
    this.busy = true; this.lastError = null; this.publish();
    const work = this.createBackupInternal(reason, options).catch(async error => {
      this.lastError = String(error);
      const recorded = this.settings.history.at(-1);
      if (!(recorded?.status === "failed" && recorded.reasonType === reason && recorded.reason === String(error))) {
        this.settings.history.push({ file: "", createdAt: new Date().toISOString(), appVersion: this.deps.appVersion, size: 0, status: "failed", reason: String(error).slice(0, 300), reasonType: reason });
        this.settings.history = this.settings.history.slice(-100);
        await this.persistSettings().catch(() => undefined);
        await this.deps.log("error", `Backup failed (${reason}): ${String(error)}`);
      }
      this.publish(); throw error;
    }).finally(() => { this.busy = false; this.progress = null; this.operationPromise = null; this.publish(); });
    this.operationPromise = work;
    return work;
  }
  private async collectSources(): Promise<FileSource[]> {
    const overrides = await this.deps.getOverrides?.() || {};
    const out: FileSource[] = [];
    for (const relative of SINGLETONS) {
      const override = overrides[relative];
      if (override) { const info = await hashBuffer(override); out.push({ relative, buffer: override, present: true, ...info }); continue; }
      const absolute = path.join(this.deps.userData, relative);
      try { const stat = await fs.lstat(absolute); if (!stat.isFile()) throw new Error(`Refusing non-file backup source: ${relative}`); const info = await hashFile(absolute); out.push({ relative, source: absolute, present: true, ...info }); }
      catch (error: any) { if (error?.code === "ENOENT") out.push({ relative, present: false, size: 0, sha256: null }); else throw error; }
    }
    for (const directory of ["announcements", "advertisements", "branding"]) {
      const absoluteDirectory = path.join(this.deps.userData, directory);
      let children: string[];
      try { children = await fs.readdir(absoluteDirectory); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
      for (const name of children) {
        const relative = `${directory}/${name}`;
        if (!isAllowedRelative(relative)) throw new Error(`Unexpected file name in application data folder: ${relative}`);
        const absolute = path.join(absoluteDirectory, name); const stat = await fs.lstat(absolute);
        if (!stat.isFile()) throw new Error(`Refusing non-regular backup source: ${relative}`);
        const info = await hashFile(absolute); out.push({ relative, source: absolute, present: true, ...info });
      }
    }
    if (!out.some(item => item.relative === "scheduler-data.json" && item.present)) throw new Error("Application settings are not available to back up.");
    if (out.length > MAX_FILES || out.reduce((sum, entry) => sum + entry.size, 0) > MAX_TOTAL_BYTES) throw new Error("Application data exceeds the supported backup size of 5 GB.");
    const storeBytes = overrides["scheduler-data.json"] || await fs.readFile(path.join(this.deps.userData, "scheduler-data.json"));
    this.deps.validateSnapshot?.(storeBytes, out.filter(item => item.present).map(item => item.relative));
    return out.sort((a, b) => a.relative.localeCompare(b.relative));
  }
  private async createBackupInternal(reason: string, options: { force?: boolean; destination?: string }) {
    if (!options.force && !this.settings.enabled && reason === "automatic") return null;
    const destination = path.resolve(options.destination || this.settings.destination);
    await fs.mkdir(destination, { recursive: true });
    await fs.access(destination, fs.constants.W_OK);
    this.setProgress("collecting", 2, "Preparing application data…");
    await this.deps.log("info", `Backup started (${reason}).`);
    const sources = await this.collectSources();
    const totalBytes = sources.reduce((sum, file) => sum + file.size, 0);
    let free: number | null = null;
    if (this.deps.availableSpace) free = await this.deps.availableSpace(destination);
    else { try { const statfs = await fs.statfs(destination); free = Number(statfs.bavail) * Number(statfs.bsize); } catch { /* statfs is not supported on every target volume. */ } }
    if (free !== null && Number.isFinite(free) && free < totalBytes + 2 * 1024 * 1024) throw new Error("The backup destination does not have enough free disk space.");
    const created = new Date();
    const manifest: Manifest = { formatVersion: FORMAT_VERSION, appVersion: this.deps.appVersion, createdAt: created.toISOString(), files: sources.map(({ relative, present, size, sha256 }) => ({ path: relative, present, size, sha256 })) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestPrefix = Buffer.alloc(4); manifestPrefix.writeUInt32BE(manifestBytes.length);
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), wrappedKey = this.deps.protectKey(key);
    const header = Buffer.concat([MAGIC, Buffer.alloc(4), wrappedKey, iv, Buffer.alloc(16)]);
    header.writeUInt32BE(wrappedKey.length, MAGIC.length);
    const filename = `TWC-Scheduler-backup-${formatStamp(created)}-${crypto.randomUUID()}.twcbak`;
    const target = path.join(destination, filename), temporary = `${target}.tmp`;
    let output: ReturnType<typeof createWriteStream> | null = null;
    let targetCreated = false;
    let finalized = false;
    try {
      output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      await new Promise<void>((resolve, reject) => output!.write(header, error => error ? reject(error) : resolve()));
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const setProgress = (stage: string, percent: number, message: string) => this.setProgress(stage, percent, message);
      async function* payload() {
        yield manifestPrefix; yield manifestBytes;
        for (let index = 0; index < sources.length; index++) {
          const item = sources[index]; if (!item.present) continue;
          const hash = crypto.createHash("sha256"); let size = 0;
          const stream = item.buffer ? Readable.from([item.buffer]) : createReadStream(item.source!);
          for await (const part of stream) { const bytes = part as Buffer; size += bytes.length; hash.update(bytes); yield bytes; }
          if (size !== item.size || hash.digest("hex") !== item.sha256) throw new Error(`Application data changed while backing up: ${item.relative}`);
          setProgress("encrypting", 5 + (index / Math.max(1, sources.length)) * 90, `Encrypting ${item.relative}…`);
        }
      }
      await pipeline(Readable.from(payload.call(this)), cipher, output);
      output = null;
      const tag = cipher.getAuthTag(); const handle = await fs.open(temporary, "r+");
      try { const tagOffset = MAGIC.length + 4 + wrappedKey.length + iv.length; await handle.write(tag, 0, tag.length, tagOffset); await handle.sync(); }
      finally { await handle.close(); }
      try {
        await fs.link(temporary, target);
        targetCreated = true;
        await fs.unlink(temporary);
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new Error("A backup with the generated filename already exists; no existing backup was overwritten.");
        if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error?.code)) throw error;
        await fs.copyFile(temporary, target, fs.constants.COPYFILE_EXCL);
        targetCreated = true;
        await this.verifyArchive(target);
        await fs.unlink(temporary);
      }
      finalized = true;
      const stat = await fs.stat(target);
      const item: BackupHistoryItem = { file: target, createdAt: created.toISOString(), appVersion: this.deps.appVersion, size: stat.size, status: "complete", reasonType: reason };
      this.settings.history.push(item); this.settings.history = this.settings.history.slice(-100); this.settings.lastSuccessfulAt = item.createdAt;
      this.settings.lastAttemptAt = item.createdAt;
      await this.persistSettings(); this.lastError = null;
      await this.deps.log("info", `Backup completed (${reason}); ${sources.length} entries, ${totalBytes} bytes, encrypted archive ${filename}.`);
      this.setProgress("complete", 100, "Backup completed.");
      await this.cleanRetention(); this.publish();
      return { ...item, totalBytes, fileCount: sources.length };
    } catch (error) {
      output?.destroy(); await fs.unlink(temporary).catch(() => undefined);
      if (targetCreated && !finalized) await fs.unlink(target).catch(() => undefined);
      this.lastError = String(error); await this.deps.log("error", `Backup failed (${reason}): ${String(error)}`); this.publish(); throw error;
    } finally { key.fill(0); }
  }
  private async cleanRetention() {
    const complete = this.settings.history.filter(item => item.status === "complete" && path.dirname(item.file) === path.resolve(this.settings.destination)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (complete.length <= this.settings.retention) return;
    const keep = complete.slice(0, this.settings.retention);
    try { for (const item of keep) await this.verifyArchive(item.file); }
    catch (error) { await this.deps.log("warn", `Backup retention cleanup skipped because a newer backup failed integrity verification: ${String(error)}`); return; }
    for (const item of complete.slice(this.settings.retention)) {
      if (item.file === this.restoringFile || item.file === keep[0]?.file) continue;
      try { await fs.unlink(item.file); this.settings.history = this.settings.history.filter(record => record.file !== item.file); await this.deps.log("info", `Removed old verified backup ${path.basename(item.file)} during retention cleanup.`); }
      catch (error: any) { if (error?.code !== "ENOENT") await this.deps.log("warn", `Could not remove expired backup ${path.basename(item.file)}: ${String(error)}`); }
    }
    await this.persistSettings();
  }
  private async decryptToTemp(archive: string, temp: string): Promise<{ manifest: Manifest; plainSize: number }> {
    const stat = await fs.stat(archive); if (!stat.isFile() || stat.size < 48) throw new Error("The selected file is not a TWC backup archive.");
    if (stat.size > MAX_TOTAL_BYTES + 3 * 1024 * 1024 + 8192) throw new Error("The selected backup exceeds the supported size limit.");
    const handle = await fs.open(archive, "r");
    let headerLength: number, key: Buffer | null = null;
    try {
      if (!(await readExactly(handle, MAGIC.length, 0)).equals(MAGIC)) throw new Error("Unsupported backup file format.");
      const wrappedSize = (await readExactly(handle, 4, MAGIC.length)).readUInt32BE();
      if (wrappedSize < 1 || wrappedSize > 4096) throw new Error("Invalid encrypted backup key header.");
      const wrapped = await readExactly(handle, wrappedSize, MAGIC.length + 4);
      const ivAt = MAGIC.length + 4 + wrappedSize; const iv = await readExactly(handle, 12, ivAt); const tag = await readExactly(handle, 16, ivAt + 12);
      headerLength = ivAt + 28;
      try { key = this.deps.unprotectKey(wrapped); } catch { throw new Error("This backup cannot be decrypted for the current Windows user account."); }
      if (key.length !== 32) throw new Error("Invalid backup encryption key.");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv); decipher.setAuthTag(tag);
      await pipeline(createReadStream(archive, { start: headerLength }), decipher, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    } finally { key?.fill(0); await handle.close(); }
    const plainStat = await fs.stat(temp); if (plainStat.size < 4 || plainStat.size > MAX_TOTAL_BYTES + 2 * 1024 * 1024) throw new Error("Backup contents exceed supported size limits.");
    const plain = await fs.open(temp, "r");
    try {
      const manifestLength = (await readExactly(plain, 4, 0)).readUInt32BE();
      if (!manifestLength || manifestLength > 2 * 1024 * 1024 || 4 + manifestLength > plainStat.size) throw new Error("Invalid backup manifest length.");
      let manifest: Manifest; try { manifest = JSON.parse((await readExactly(plain, manifestLength, 4)).toString("utf8")); } catch { throw new Error("The backup manifest is invalid."); }
      this.validateManifest(manifest, plainStat.size, manifestLength);
      return { manifest, plainSize: plainStat.size };
    } finally { await plain.close(); }
  }
  private validateManifest(manifest: Manifest, plainSize: number, manifestLength: number) {
    if (!manifest || manifest.formatVersion !== FORMAT_VERSION || typeof manifest.appVersion !== "string" || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES) throw new Error("Unsupported or invalid backup manifest.");
    const seen = new Set<string>(); let total = 0;
    for (const file of manifest.files) {
      if (!file || !isAllowedRelative(file.path) || seen.has(file.path) || typeof file.present !== "boolean" || !safeNumber(file.size, MAX_TOTAL_BYTES) || (file.present ? !/^[a-f0-9]{64}$/.test(file.sha256 || "") : file.size !== 0 || file.sha256 !== null)) throw new Error("Backup manifest contains an invalid file entry.");
      if (file.present) total += file.size; seen.add(file.path);
    }
    if (!seen.has("scheduler-data.json") || !manifest.files.some(file => file.path === "scheduler-data.json" && file.present) || total > MAX_TOTAL_BYTES || 4 + manifestLength + total !== plainSize) throw new Error("Backup manifest is incomplete or does not match its contents.");
  }
  private async verifyContents(archive: string, stageDirectory?: string): Promise<{ manifest: Manifest; preview: Omit<BackupPreview, "token"> }> {
    const temp = path.join(this.deps.userData, `.twc-backup-verify-${crypto.randomUUID()}.tmp`);
    const stage = stageDirectory ? path.join(stageDirectory, "files") : null;
    if (stage) await fs.mkdir(stage, { recursive: true });
    try {
      const { manifest } = await this.decryptToTemp(archive, temp);
      const plain = await fs.open(temp, "r"); let offset = 4 + Buffer.byteLength(JSON.stringify(manifest), "utf8");
      // JSON string length can differ from serialized length if whitespace or escaping differs. Re-read the actual prefix length.
      const manifestLength = (await readExactly(plain, 4, 0)).readUInt32BE(); offset = 4 + manifestLength;
      const hash = crypto.createHash;
      try {
        for (let index = 0; index < manifest.files.length; index++) {
          const file = manifest.files[index]; if (!file.present) continue;
          const fileHash = hash("sha256"); const target = stage ? path.join(stage, file.path) : null;
          if (target) await fs.mkdir(path.dirname(target), { recursive: true });
          const out = target ? await fs.open(target, "wx", 0o600) : null;
          let remaining = file.size;
          try {
            if (remaining) {
              const source = createReadStream(temp, { start: offset, end: offset + remaining - 1 });
              for await (const chunk of source) { const bytes = chunk as Buffer; remaining -= bytes.length; fileHash.update(bytes); if (out) await out.write(bytes); }
            }
          } finally { await out?.close(); }
          const actual = fileHash.digest("hex"); if (remaining !== 0 || actual !== file.sha256) throw new Error(`Backup integrity check failed for ${file.path}.`);
          if (file.path === "scheduler-data.json" && stage) {
            const bytes = await fs.readFile(target!);
            this.deps.validateStore?.(bytes);
            this.deps.validateSnapshot?.(bytes, manifest.files.filter(item => item.present).map(item => item.path));
          }
          offset += file.size; this.setProgress("validating", 10 + 80 * ((index + 1) / manifest.files.length), `Verifying ${file.path}…`);
        }
      } finally { await plain.close(); }
      const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
      return { manifest, preview: { createdAt: manifest.createdAt, appVersion: manifest.appVersion, fileCount: manifest.files.filter(file => file.present).length, totalBytes, categories: [...new Set(manifest.files.filter(file => file.present).map(file => file.path.split("/")[0] === "scheduler-data.json" ? "Settings and schedules" : file.path.split("/")[0] === "scheduler-runs.json" || file.path.split("/")[0] === "announcement-runs.json" ? "Scheduler and announcement history" : file.path.split("/")[0] === "quiet-playback-state.json" ? "Quiet Hours state" : file.path.split("/")[0] === "spotify-token.bin" || file.path.split("/")[0].startsWith("google-") ? "Encrypted account connections" : file.path.split("/")[0] === "branding" ? "Branding" : file.path.split("/")[0] === "announcements" ? "Announcement audio" : "Advertisement audio"))] } };
    } finally { await fs.unlink(temp).catch(() => undefined); }
  }
  private async verifyArchive(file: string) { await this.verifyContents(file); }
  async selectRestoreFile(dialogSelect: () => Promise<string | null>): Promise<BackupPreview | null> {
    if (this.stopping || this.busy) throw new Error("Wait for the current backup operation to finish first.");
    const selected = await dialogSelect(); if (!selected) return null;
    this.busy = true; this.setProgress("validating", 1, "Validating selected backup…");
    try {
      const result = await this.verifyContents(selected);
      const token = crypto.randomUUID(); const preview: BackupPreview = { token, ...result.preview };
      this.selections.set(token, { file: path.resolve(selected), preview, expires: Date.now() + 10 * 60_000 });
      await this.deps.log("info", `Backup validation passed for ${path.basename(selected)} (${preview.fileCount} entries).`);
      return preview;
    } catch (error) { await this.deps.log("error", `Backup validation failed: ${String(error)}`); throw error; }
    finally { this.busy = false; this.progress = null; this.publish(); }
  }
  async restore(token: string) {
    if (this.stopping) throw new Error("The application is shutting down; restore could not start.");
    if (this.busy) throw new Error("A backup or restore operation is already in progress.");
    if (typeof token !== "string" || !/^[\w-]{36}$/.test(token)) throw new Error("Select a valid backup first.");
    const selection = this.selections.get(token); this.selections.delete(token);
    if (!selection || selection.expires < Date.now()) throw new Error("The backup selection expired. Select it again.");
    this.busy = true; this.lastError = null; this.restoringFile = selection.file; this.publish();
    const work = this.restoreInternal(selection.file).finally(() => { this.restoringFile = null; this.busy = false; this.progress = null; this.operationPromise = null; this.publish(); });
    this.operationPromise = work; return work;
  }
  private async restoreInternal(archive: string) {
    const transactionId = crypto.randomUUID(); const txDir = path.join(this.deps.userData, `.twc-restore-${transactionId}`); const stageDir = path.join(txDir, "stage");
    this.setProgress("validating", 2, "Rechecking backup integrity…");
    await this.deps.log("info", `Restore started from ${path.basename(archive)}.`);
    try {
      const { manifest } = await this.verifyContents(archive, stageDir);
      this.setProgress("safety-backup", 92, "Creating a safety backup of current data…");
      await this.createBackupInternal("pre-restore", { force: true });
      const journalEntries: { relative: string; existed: boolean }[] = [];
      const rollbackDir = path.join(txDir, "rollback"); await fs.mkdir(rollbackDir, { recursive: true });
      for (const file of manifest.files) {
        if (!isAllowedRelative(file.path)) throw new Error("Restore contains an unsafe path.");
        const destination = path.join(this.deps.userData, file.path); await this.assertSafeParents(destination);
        try {
          const stat = await fs.lstat(destination); if (!stat.isFile()) throw new Error(`Restore target is not a regular file: ${file.path}`);
          const rollback = path.join(rollbackDir, file.path); await fs.mkdir(path.dirname(rollback), { recursive: true }); await fs.copyFile(destination, rollback); journalEntries.push({ relative: file.path, existed: true });
        } catch (error: any) { if (error?.code === "ENOENT") journalEntries.push({ relative: file.path, existed: false }); else throw error; }
      }
      const journal = { version: 1, state: "applying", entries: journalEntries };
      await writeJsonAtomic(path.join(txDir, "journal.json"), journal);
      this.setProgress("restoring", 95, "Restoring settings, schedules, ledgers, audio, and branding…");
      const stage = path.join(stageDir, "files");
      for (const file of manifest.files) {
        const destination = path.join(this.deps.userData, file.path);
        if (!file.present) { await fs.unlink(destination).catch((error: any) => { if (error?.code !== "ENOENT") throw error; }); continue; }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const temp = `${destination}.${transactionId}.restore.tmp`;
        await fs.copyFile(path.join(stage, file.path), temp, fs.constants.COPYFILE_EXCL);
        await fs.rename(temp, destination);
      }
      journal.state = "committed"; await writeJsonAtomic(path.join(txDir, "journal.json"), journal);
      await fs.rm(txDir, { recursive: true, force: true });
      await this.deps.log("info", `Restore completed from ${path.basename(archive)}; ${manifest.files.length} managed entries processed.`);
      this.setProgress("complete", 100, "Restore completed. The application will restart.");
      return { createdAt: manifest.createdAt, appVersion: manifest.appVersion, fileCount: manifest.files.filter(file => file.present).length };
    } catch (error) {
      await this.rollbackTransaction(txDir).catch(rollbackError => this.deps.log("error", `Restore rollback failed; recovery will be retried on next startup: ${String(rollbackError)}`));
      this.lastError = String(error); await this.deps.log("error", `Restore failed and recovery was attempted: ${String(error)}`); throw error;
    }
  }
  private async assertSafeParents(target: string) {
    const relative = path.relative(this.deps.userData, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Restore target escapes application data storage.");
    let cursor = this.deps.userData;
    for (const part of path.dirname(relative).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); try { const stat = await fs.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to restore through a symbolic link."); } catch (error: any) { if (error?.code === "ENOENT") break; throw error; } }
  }
  private async rollbackTransaction(txDir: string) {
    let journal: any; try { journal = JSON.parse(await fs.readFile(path.join(txDir, "journal.json"), "utf8")); } catch { await fs.rm(txDir, { recursive: true, force: true }); return; }
    if (journal?.version !== 1 || !Array.isArray(journal.entries)) throw new Error("Restore recovery journal is invalid.");
    if (journal.state === "committed") { await fs.rm(txDir, { recursive: true, force: true }); return; }
    for (const entry of [...journal.entries].reverse()) {
      if (!entry || !isAllowedRelative(entry.relative)) throw new Error("Restore recovery journal contains an unsafe path.");
      const destination = path.join(this.deps.userData, entry.relative); await this.assertSafeParents(destination);
      if (entry.existed) {
        const backup = path.join(txDir, "rollback", entry.relative); try { await fs.access(backup); } catch { continue; }
        const temp = `${destination}.${crypto.randomUUID()}.rollback.tmp`; await fs.copyFile(backup, temp); await fs.rename(temp, destination);
      } else await fs.unlink(destination).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
    }
    await fs.rm(txDir, { recursive: true, force: true });
  }
  private async recoverInterruptedRestores() {
    let entries: string[]; try { entries = await fs.readdir(this.deps.userData); } catch { return; }
    for (const name of entries.filter(item => item.startsWith(".twc-backup-verify-"))) {
      await fs.unlink(path.join(this.deps.userData, name)).catch(() => undefined);
      await this.deps.log("warn", "Removed an incomplete encrypted-backup verification temporary file.");
    }
    for (const name of entries.filter(item => item.startsWith(".twc-restore-"))) {
      const txDir = path.join(this.deps.userData, name);
      try { await this.rollbackTransaction(txDir); await this.deps.log("warn", `Recovered an interrupted restore transaction (${name}).`); }
      catch (error) { this.lastError = `Restore recovery needs attention: ${String(error)}`; await this.deps.log("error", this.lastError); }
    }
    for (const directory of new Set([this.deps.defaultDirectory, this.settings.destination])) {
      let files: string[]; try { files = await fs.readdir(directory); } catch { continue; }
      for (const filename of files.filter(name => name.endsWith(".twcbak.tmp"))) {
        await fs.unlink(path.join(directory, filename)).catch(() => undefined);
        await this.deps.log("warn", `Removed incomplete backup temporary file ${filename}.`);
      }
    }
  }
}
