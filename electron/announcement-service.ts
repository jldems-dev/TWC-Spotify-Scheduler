import fs from "node:fs/promises";
import path from "node:path";

export type AnnouncementOccurrence = { schedule: any; boundary: "start" | "end"; custom?: boolean; audioId: string; key: string };
export type AnnouncementRun = { key: string; scheduleId: string; scheduleName: string; audioId: string; boundary: string; status: "running" | "completed" | "failed" | "skipped"; attempts: number; updatedAt: string; reason?: string };
type AnnouncementStore = { schedules: any[]; announcements: any[] };
type Dependencies = {
  stateFile: string;
  getStore: () => Promise<AnnouncementStore>;
  execute: (event: AnnouncementOccurrence, audio: any, options: { resumeAfter: boolean }) => Promise<void>;
  playback: () => Promise<any>;
  pause: () => Promise<boolean>;
  resume: () => Promise<void>;
  log: (level: "info" | "warn" | "error", message: string) => Promise<unknown> | unknown;
  onStatus?: (status: AnnouncementServiceStatus) => void;
};
export type AnnouncementServiceStatus = { running: boolean; busy: boolean; active: string | null; windowActive: boolean; last: AnnouncementRun | null; error: string | null };
type Ledger = { version: 1; runs: AnnouncementRun[]; windowWasPlaying: boolean; windowActive: boolean };
const emptyLedger = (): Ledger => ({ version: 1, runs: [], windowWasPlaying: false, windowActive: false });
const dateStamp = () => new Date().toISOString();
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const localDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function occursOn(schedule: any, date: Date) {
  if (!schedule.date) return schedule.days?.includes(weekdays[date.getDay()]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.date)) return false;
  const [year, month, day] = schedule.date.split("-").map(Number);
  const anchor = new Date(year, month - 1, day);
  if (anchor.getFullYear() !== year || anchor.getMonth() !== month - 1 || anchor.getDate() !== day) return false;
  return schedule.repeat === "yearly" ? date >= anchor && date.getMonth() === month - 1 && date.getDate() === day : localDateKey(date) === schedule.date;
}
function announcementEventsAt(schedules: any[], now: Date): AnnouncementOccurrence[] {
  const date = localDateKey(now), time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return (schedules || []).filter(schedule => schedule.enabled && occursOn(schedule, now)).flatMap(schedule => {
    if (schedule.date) return schedule.time === time ? [{ schedule, boundary: "start" as const, custom: true, audioId: schedule.announcementId, key: `${schedule.id}:start:${date}:${time}` }] : [];
    return [
      ...(schedule.start === time ? [{ schedule, boundary: "start" as const, audioId: schedule.firstAnnouncementId, key: `${schedule.id}:start:${date}:${time}` }] : []),
      ...(schedule.end === time ? [{ schedule, boundary: "end" as const, audioId: schedule.secondAnnouncementId, key: `${schedule.id}:end:${date}:${time}` }] : []),
    ];
  });
}
function announcementWindowActive(schedules: any[], now: Date) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (schedules || []).some(schedule => !schedule.date && schedule.enabled && occursOn(schedule, now) && schedule.end > schedule.start && minutes >= Number(schedule.start?.slice(0, 2)) * 60 + Number(schedule.start?.slice(3)) && minutes < Number(schedule.end?.slice(0, 2)) * 60 + Number(schedule.end?.slice(3)));
}

/** Main-process announcement scheduler. Event keys are the stable local schedule occurrence IDs. */
export class AnnouncementService {
  private ledger = emptyLedger();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopping = false;
  private active: string | null = null;
  private last: AnnouncementRun | null = null;
  private error: string | null = null;
  private initialized = false;
  private idleWaiter: (() => void) | null = null;
  private lastDiagnostic: { message: string; at: number } | null = null;
  constructor(private deps: Dependencies) {}
  status(): AnnouncementServiceStatus { return { running: !!this.timer && !this.stopping, busy: this.busy, active: this.active, windowActive: this.ledger.windowActive, last: this.last, error: this.error }; }
  private publish() { this.deps.onStatus?.(this.status()); }
  private async report(level: "info" | "warn" | "error", message: string) {
    const now = Date.now();
    if (this.lastDiagnostic?.message === message && now - this.lastDiagnostic.at < 60_000) return;
    this.lastDiagnostic = { message, at: now };
    await this.deps.log(level, message);
  }
  private async persist() {
    await fs.mkdir(path.dirname(this.deps.stateFile), { recursive: true });
    this.ledger.runs = this.ledger.runs.slice(-2000);
    const temp = `${this.deps.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.ledger), "utf8");
    await fs.rename(temp, this.deps.stateFile);
  }
  private async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const saved = JSON.parse(await fs.readFile(this.deps.stateFile, "utf8"));
      if (saved?.version === 1 && Array.isArray(saved.runs)) this.ledger = { ...emptyLedger(), ...saved, runs: saved.runs.slice(-2000) };
    } catch { /* New or unreadable ledger: preserve operation and start with an empty ledger. */ }
    for (const run of this.ledger.runs) if (run.status === "running") {
      run.status = "failed"; run.reason = "Interrupted by application shutdown or crash; not replayed."; run.updatedAt = dateStamp();
      await this.deps.log("error", `Announcement ${run.key} was interrupted while running and will not be replayed.`);
      this.last = run;
    }
    await this.persist();
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick("timer"); }, 1000);
    void this.tick("startup");
    this.publish();
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Let an in-flight announcement finish (including Spotify restoration) before intentional shutdown.
    if (this.busy) await new Promise<void>(resolve => { this.idleWaiter = resolve; });
    this.publish();
  }
  async tick(_reason: "timer" | "startup" | "resume" = "timer", now = new Date()) {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.initialize();
      const data = await this.deps.getStore();
      const schedules = Array.isArray(data.schedules) ? data.schedules : [];
      const inWindow = announcementWindowActive(schedules, now);
      if (inWindow && !this.ledger.windowActive) {
        try {
          const state = await this.deps.playback();
          this.ledger.windowWasPlaying = !!state?.is_playing;
          if (this.ledger.windowWasPlaying) await this.deps.pause();
        } catch (e) {
          this.error = `Could not pause Spotify for the announcement window: ${String(e)}`;
          await this.deps.log("error", this.error);
        }
        this.ledger.windowActive = true;
        await this.persist();
      }
      const events = announcementEventsAt(schedules, now) as AnnouncementOccurrence[];
      for (let index = 0; index < events.length; index++) {
        const event = events[index];
        if (this.ledger.runs.some(run => run.key === event.key)) continue;
        if (index > 0 || this.active) { await this.record(event, "skipped", "Overlapping announcement occurrence; only one is run at a time."); continue; }
        const audio = (data.announcements || []).find((item: any) => item.id === event.audioId && item.enabled);
        if (!audio) { await this.record(event, "failed", "Announcement audio record is missing or disabled."); continue; }
        const otherWindowActive = schedules.some(schedule => schedule.id !== event.schedule.id && !schedule.date && schedule.enabled && schedule.days?.includes(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getDay()]) && now.getHours() * 60 + now.getMinutes() >= Number(schedule.start?.slice(0, 2)) * 60 + Number(schedule.start?.slice(3)) && now.getHours() * 60 + now.getMinutes() < Number(schedule.end?.slice(0, 2)) * 60 + Number(schedule.end?.slice(3)));
        const resumeAfter = event.custom ? !inWindow : (event.boundary === "end" && !otherWindowActive);
        const run: AnnouncementRun = { key: event.key, scheduleId: event.schedule.id, scheduleName: event.schedule.name, audioId: event.audioId, boundary: event.boundary, status: "running", attempts: 1, updatedAt: dateStamp() };
        this.ledger.runs.push(run); this.active = event.key; this.last = run; this.error = null; await this.persist(); this.publish();
        try {
          await this.deps.execute(event, audio, { resumeAfter });
          run.status = "completed"; run.reason = undefined; run.updatedAt = dateStamp(); this.last = run;
          this.error = null;
          await this.deps.log("info", `Announcement ${event.boundary} completed for "${event.schedule.name}" (${event.key}).`);
        } catch (e) {
          run.status = "failed"; run.reason = String(e); run.updatedAt = dateStamp(); this.last = run; this.error = `Announcement for "${event.schedule.name}" failed: ${String(e)}`;
          await this.deps.log("error", this.error);
        } finally {
          this.active = null;
          await this.persist(); this.publish();
        }
      }
      if (!inWindow) {
        if (this.ledger.windowWasPlaying) {
          try { await this.deps.resume(); this.ledger.windowWasPlaying = false; }
          catch (e) { this.error = `Could not resume Spotify after the announcement window: ${String(e)}`; await this.report("error", this.error); }
        }
        if (this.ledger.windowActive) { this.ledger.windowActive = false; await this.persist(); }
      }
    } catch (e) {
      this.error = String(e); await this.report("error", `Announcement service tick failed: ${String(e)}`);
    } finally { this.busy = false; this.idleWaiter?.(); this.idleWaiter = null; this.publish(); }
  }
  private async record(event: AnnouncementOccurrence, status: "failed" | "skipped", reason: string) {
    const run: AnnouncementRun = { key: event.key, scheduleId: event.schedule.id, scheduleName: event.schedule.name, audioId: event.audioId, boundary: event.boundary, status, attempts: 0, updatedAt: dateStamp(), reason };
    this.ledger.runs.push(run); this.last = run; if (status === "failed") this.error = reason;
    await this.deps.log(status === "failed" ? "error" : "warn", `Announcement ${event.key} ${status}: ${reason}`); await this.persist(); this.publish();
  }
}
