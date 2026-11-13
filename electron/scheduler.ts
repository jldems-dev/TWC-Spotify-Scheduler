import fs from 'node:fs/promises';
import path from 'node:path';

export type ScheduledEntry = { id: string; name: string; days: string[]; dates?: string[]; date?: string; repeat?: 'never' | 'daily' | 'weekly' | 'monthly' | 'yearly'; start: string; end: string; playlistId?: string; enabled: boolean; quiet: boolean };
export type ScheduleException = { date: string; type: 'skip' | 'replace'; playlistId?: string; label?: string; scheduleId?: string };
export type Boundary = { schedule: ScheduledEntry; boundary: 'start' | 'end'; key: string };
const week = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');
export const localDateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function occursOn(s: ScheduledEntry, date: Date) {
  const key = localDateKey(date);
  if (s.dates && !s.dates.includes(key)) return false;
  if (!s.date) return s.days.includes(week[date.getDay()]);
  const [year, month, day] = s.date.split('-').map(Number);
  switch (s.repeat || 'never') {
    case 'daily': return date >= new Date(year, month - 1, day);
    case 'weekly': return date >= new Date(year, month - 1, day) && week[date.getDay()] === week[new Date(year, month - 1, day).getDay()];
    case 'monthly': return date >= new Date(year, month - 1, day) && date.getDate() === day;
    case 'yearly': return date >= new Date(year, month - 1, day) && date.getMonth() === month - 1 && date.getDate() === day;
    default: return key === s.date;
  }
}
export function boundariesAt(schedules: ScheduledEntry[], now: Date): Boundary[] {
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const result: Boundary[] = [];
  const matches = (date: Date, time: string, dayOffset = 0) => { const [h, m] = time.split(':').map(Number); const target = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, h, m); return target.getFullYear() === now.getFullYear() && target.getMonth() === now.getMonth() && target.getDate() === now.getDate() && target.getHours() === now.getHours() && target.getMinutes() === now.getMinutes(); };
  for (const s of schedules) {
    if (!s.enabled) continue;
    const overnight = s.end <= s.start;
    const allowedToday = occursOn(s, now);
    const allowedYesterday = occursOn(s, yesterdayDate);
    if (allowedToday && matches(now, s.start)) result.push({ schedule: s, boundary: 'start', key: `${s.id}:start:${localDateKey(now)}:${localTime(now)}` });
    const endDay = overnight ? yesterdayDate : now;
    if (((allowedToday && !overnight) || (allowedYesterday && overnight)) && matches(endDay, s.end, overnight ? 1 : 0)) result.push({ schedule: s, boundary: 'end', key: `${s.id}:end:${localDateKey(now)}:${localTime(now)}` });
  }
  return result;
}
export function activeQuietSchedules(schedules: ScheduledEntry[], now: Date): ScheduledEntry[] {
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const inside = (startDate: Date, overnight: boolean, s: ScheduledEntry) => {
    const [sh, sm] = s.start.split(':').map(Number), [eh, em] = s.end.split(':').map(Number);
    const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), sh, sm);
    const end = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + (overnight ? 1 : 0), eh, em);
    return now >= start && now < end;
  };
  return schedules.filter(s => {
    if (!s.enabled || !s.quiet) return false;
    const overnight = s.end <= s.start;
    return occursOn(s, now) && inside(now, overnight, s) || overnight && occursOn(s, yesterdayDate) && inside(yesterdayDate, true, s);
  });
}
type CoordinatorOptions = {
  stateFile: string;
  getSchedules: () => Promise<{ settings: Record<string, unknown>; schedules: ScheduledEntry[]; exceptions?: ScheduleException[] }>;
  execute: (event: Boundary) => Promise<void>;
  recoverQuiet: (schedule: ScheduledEntry) => Promise<void>;
  enforceQuiet: (schedule: ScheduledEntry) => Promise<boolean>;
  log: (level: 'info' | 'warn' | 'error', message: string) => Promise<void>;
  now?: () => Date;
};
/** Main-process scheduler. It checks wall-clock local fields on every poll and uses an at-most-once persistent event ledger. */
export class ScheduleCoordinator {
  private timer?: NodeJS.Timeout;
  private running = false;
  private busy = false;
  private lastQuietEnforcement = 0;
  constructor(private options: CoordinatorOptions) {}
  start() { if (this.running) return; this.running = true; void this.tick('startup'); this.timer = setInterval(() => void this.tick('poll'), 5000); }
  stop() { this.running = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(reason: 'startup' | 'wake' | 'poll' = 'poll') {
    if (this.busy) return;
    this.busy = true;
    try {
      const { settings, schedules, exceptions = [] } = await this.options.getSchedules();
      if (!settings.schedulerEnabled) return;
      const now = this.options.now?.() || new Date();
      const events = boundariesAt(schedules, now);
      for (const event of events) {
        const overnightEnd = event.boundary === 'end' && event.schedule.end <= event.schedule.start;
        const occurrenceDate = overnightEnd ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) : now;
        const exception = exceptions.find(item => item.date === localDateKey(occurrenceDate) && item.scheduleId === event.schedule.id)
          || exceptions.find(item => item.date === localDateKey(occurrenceDate) && !item.scheduleId);
        if (event.boundary === 'start' && !event.schedule.quiet && exception?.type === 'skip') {
          if (await this.claim(event.key)) await this.options.log('info', `Skipped scheduled playback for ${event.schedule.name} on ${exception.date} due to date exception.`);
          continue;
        }
        const effective = !event.schedule.quiet && exception?.type === 'replace' && exception.playlistId
          ? { ...event, schedule: { ...event.schedule, playlistId: exception.playlistId } } : event;
        await this.claimAndExecute(effective);
      }
      if (reason !== 'poll') {
        const currentStart = new Set(events.filter(e => e.boundary === 'start').map(e => e.schedule.id));
        for (const schedule of activeQuietSchedules(schedules, now)) {
          if (!currentStart.has(schedule.id)) await this.claimRecovery(schedule, now);
        }
      }
      const quietNow = activeQuietSchedules(schedules, now).filter(s => !events.some(e => e.schedule.id === s.id && e.boundary === 'start'));
      if (quietNow.length && Date.now() - this.lastQuietEnforcement >= 30000) {
        this.lastQuietEnforcement = Date.now();
        for (const schedule of quietNow) if (await this.options.enforceQuiet(schedule)) await this.options.log('warn', `Paused playback started manually during quiet hours (“${schedule.name}”).`);
      }
    } catch (e) { await this.options.log('error', `Scheduler tick failed: ${String(e)}`); }
    finally { this.busy = false; }
  }
  private async readLedger(): Promise<Record<string, { status: 'attempting' | 'succeeded' | 'failed'; updatedAt: string; error?: string }>> {
    try {
      const data = JSON.parse(await fs.readFile(this.options.stateFile, 'utf8'));
      if (Array.isArray(data.keys) && data.keys.every((key: unknown) => typeof key === 'string')) return Object.fromEntries(data.keys.map((key: string) => [key, { status: 'succeeded' as const, updatedAt: 'legacy' }]));
      if (!data || typeof data.events !== 'object' || Array.isArray(data.events)) throw new Error('Invalid scheduler event ledger format.');
      return data.events;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return {};
      if (e instanceof SyntaxError || /Invalid scheduler event ledger format/.test(String(e))) {
        const preserved = `${this.options.stateFile}.invalid-${Date.now()}`;
        await fs.rename(this.options.stateFile, preserved);
        await this.options.log('error', `Scheduler ledger was invalid; original data preserved at ${path.basename(preserved)}. A fresh ledger was created.`);
        return {};
      }
      throw new Error(`Scheduler event ledger is unreadable; actions are paused to prevent duplicate execution: ${String(e)}`);
    }
  }
  private async writeLedger(events: Record<string, { status: 'attempting' | 'succeeded' | 'failed'; updatedAt: string; error?: string }>) {
    await fs.mkdir(path.dirname(this.options.stateFile), { recursive: true });
    const temp = `${this.options.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 2, events }), 'utf8');
    await fs.rename(temp, this.options.stateFile);
  }
  private async claim(key: string): Promise<boolean> {
    const events = await this.readLedger();
    if (events[key]) return false;
    events[key] = { status: 'attempting', updatedAt: new Date().toISOString() };
    await this.writeLedger(events);
    return true;
  }
  private async recordResult(key: string, status: 'succeeded' | 'failed', error?: string) {
    const events = await this.readLedger();
    events[key] = { status, updatedAt: new Date().toISOString(), ...(error ? { error: error.slice(0, 300) } : {}) };
    await this.writeLedger(events);
  }
  private async claimAndExecute(event: Boundary) {
    if (!await this.claim(event.key)) return;
    const actual = this.options.now?.() || new Date();
    const keyTime = event.key.match(/:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/);
    const scheduled = keyTime ? `${keyTime[1]} ${keyTime[2]}` : `${localDateKey(actual)} ${localTime(actual)}`;
    const playlist = event.schedule.quiet ? 'none (quiet hours)' : event.schedule.playlistId || 'unassigned';
    await this.options.log('info', `Schedule attempt: ${event.schedule.name} ${event.boundary}; scheduled local ${scheduled}; actual local ${localDateKey(actual)} ${localTime(actual)}; playlist ${playlist}.`);
    try { await this.options.execute(event); await this.recordResult(event.key, 'succeeded'); await this.options.log('info', `Schedule result: ${event.schedule.name} ${event.boundary} succeeded; playlist ${playlist}.`); }
    catch (e) { const message = String(e); await this.recordResult(event.key, 'failed', message); await this.options.log('error', `Schedule result: ${event.schedule.name} ${event.boundary} failed; playlist ${playlist}; error ${message}`); }
  }
  private async claimRecovery(schedule: ScheduledEntry, now: Date) {
    const overnight = schedule.end <= schedule.start;
    const date = overnight && localTime(now) < schedule.end ? localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) : localDateKey(now);
    if (!await this.claim(`${schedule.id}:quiet-recovery:${date}`)) return;
    await this.options.log('warn', `Recovering active quiet schedule “${schedule.name}” after ${date}; missed music starts are skipped.`);
    try { await this.options.recoverQuiet(schedule); }
    catch (e) { await this.options.log('error', `Quiet schedule recovery failed for “${schedule.name}”: ${String(e)}`); }
  }
}
