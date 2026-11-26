import fs from 'node:fs/promises';
import path from 'node:path';

export type ScheduledEntry = { id: string; name: string; days: string[]; dates?: string[]; date?: string; repeat?: 'never' | 'daily' | 'weekly' | 'monthly' | 'yearly'; start: string; end: string; playlistId?: string; enabled: boolean; quiet: boolean };
export type ScheduleException = { date: string; type: 'skip' | 'replace'; playlistId?: string; label?: string; scheduleId?: string };
export type Boundary = { schedule: ScheduledEntry; boundary: 'start' | 'end'; key: string; overridePlaylistId?: string; startedPlaylistUri?: string };
export type MissedSchedulePolicy = 'skip' | 'latest-within-5-minutes';
type EventStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
type LedgerEvent = { status: EventStatus; updatedAt: string; attempts: number; error?: string; retryable?: boolean; playlistUri?: string };
type Ledger = Record<string, LedgerEvent>;
const RECOVERY_GRACE_MS = 5 * 60_000;
const MAX_MISSED_SCAN_MS = 7 * 24 * 60 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 5_000];
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
/** Enumerate wall-clock schedule boundaries in a short interval, including Windows wake gaps. */
export function boundariesBetween(schedules: ScheduledEntry[], after: Date, through: Date): Boundary[] {
  const found = new Map<string, Boundary>();
  const firstDate = new Date(after.getFullYear(), after.getMonth(), after.getDate() - 1);
  const lastDate = new Date(through.getFullYear(), through.getMonth(), through.getDate());
  for (let day = firstDate; day <= lastDate; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    for (const schedule of schedules) {
      if (!schedule.enabled || !occursOn(schedule, day)) continue;
      const [startHour, startMinute] = schedule.start.split(':').map(Number);
      const [endHour, endMinute] = schedule.end.split(':').map(Number);
      const overnight = schedule.end <= schedule.start;
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, startMinute);
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + (overnight ? 1 : 0), endHour, endMinute);
      if (start > after && start <= through) {
        const event = { schedule, boundary: 'start' as const, key: `${schedule.id}:start:${localDateKey(start)}:${localTime(start)}` };
        found.set(event.key, event);
      }
      if (end > after && end <= through) {
        const event = { schedule, boundary: 'end' as const, key: `${schedule.id}:end:${localDateKey(end)}:${localTime(end)}` };
        found.set(event.key, event);
      }
    }
  }
  return [...found.values()];
}
export function scheduleExceptionFor<T extends ScheduleException>(event: Boundary, exceptions: T[]) {
  const at = scheduledAt(event.key, new Date());
  if (event.boundary === 'end' && event.schedule.end <= event.schedule.start)
    at.setDate(at.getDate() - 1);
  const date = localDateKey(at);
  return exceptions.find(item => item.date === date && item.scheduleId === event.schedule.id)
    || exceptions.find(item => item.date === date && !item.scheduleId);
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
  execute: (event: Boundary) => Promise<void | { skipped: string } | { playlistUri: string }>;
  recoverQuiet: (schedule: ScheduledEntry) => Promise<void>;
  enforceQuiet: (schedule: ScheduledEntry) => Promise<boolean>;
  log: (level: 'info' | 'warn' | 'error', message: string) => Promise<void>;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
};
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
export function scheduledAt(key: string, fallback: Date) {
  const match = key.match(/:(\d{4})-(\d{2})-(\d{2}):(\d{2}):(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) : fallback;
}
function normalizeEvent(value: any): LedgerEvent {
  const status = value?.status === 'succeeded' ? 'completed'
    : value?.status === 'attempting' ? 'running'
      : ['pending', 'running', 'completed', 'failed', 'skipped'].includes(value?.status) ? value.status : 'failed';
  return {
    status,
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : 'unknown',
    attempts: Number.isInteger(value?.attempts) && value.attempts >= 0 ? value.attempts : status === 'running' || status === 'failed' ? 1 : 0,
    ...(typeof value?.error === 'string' ? { error: value.error.slice(0, 500) } : {}),
    ...(/^spotify:playlist:[A-Za-z0-9]{22}$/.test(value?.playlistUri) ? { playlistUri: value.playlistUri } : {}),
    ...(typeof value?.retryable === 'boolean' ? { retryable: value.retryable } : {}),
  };
}
function retryableFailure(error: unknown) {
  return /network request failed|request timed out|\(429\)|\(5\d\d\)|no available controllable playback device|did not become active before the confirmation timeout|could not be confirmed as started before the confirmation timeout|still active after three verification attempts|pause command did not confirm/i.test(String(error));
}

/** Main-process scheduler with a persistent event ledger and bounded missed-start recovery. */
export class ScheduleCoordinator {
  private timer?: NodeJS.Timeout;
  private running = false;
  private shuttingDown = false;
  private busy = false;
  private queuedReason: 'startup' | 'wake' | 'poll' | null = null;
  private lastObservedAt: Date | null = null;
  private persistedObservedAt: string | null = null;
  private lastQuietEnforcement = 0;
  private lastTickFailure = '';
  private lastTickFailureAt = 0;
  private inFlight = new Set<string>();
  private recoveredPlaylist?: { startKey: string; uri: string };
  private stopWaiters: Array<() => void> = [];
  constructor(private options: CoordinatorOptions) {}
  start() { if (this.running) return; this.shuttingDown = false; this.running = true; void this.tick('startup'); this.timer = setInterval(() => void this.tick('poll'), 5000); }
  stop(): Promise<void> {
    this.shuttingDown = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.busy) return Promise.resolve();
    return new Promise(resolve => this.stopWaiters.push(resolve));
  }
  async tick(reason: 'startup' | 'wake' | 'poll' = 'poll') {
    if (this.shuttingDown) return;
    if (this.busy) {
      if (reason !== 'poll') this.queuedReason = reason;
      return;
    }
    this.busy = true;
    try {
      let current: 'startup' | 'wake' | 'poll' | null = reason;
      while (current && !this.shuttingDown) {
        this.queuedReason = null;
        await this.tickOnce(current);
        current = this.queuedReason;
      }
    } finally {
      this.busy = false;
      for (const resolve of this.stopWaiters.splice(0)) resolve();
    }
  }
  recordRecoveredPlaylist(startKey: string, uri: string) {
    this.recoveredPlaylist = { startKey, uri };
  }
  private async tickOnce(reason: 'startup' | 'wake' | 'poll') {
    try {
      const { settings, schedules, exceptions = [] } = await this.options.getSchedules();
      const now = this.options.now?.() || new Date();
      await this.readLedger();
      const priorObserved = this.lastObservedAt || (this.persistedObservedAt ? new Date(this.persistedObservedAt) : null);
      if (priorObserved && now.getTime() - priorObserved.getTime() > MAX_MISSED_SCAN_MS)
        await this.options.log('warn', 'Schedule recovery history older than seven days was expired and will not be replayed.');
      const recoveryStart = priorObserved
        ? new Date(Math.max(now.getTime() - MAX_MISSED_SCAN_MS, priorObserved.getTime()))
        : new Date(now.getTime() - RECOVERY_GRACE_MS);
      if (!settings.schedulerEnabled) { await this.persistObservation(now); this.lastTickFailure = ''; return; }
      const all = new Map<string, Boundary>();
      for (const event of boundariesBetween(schedules, recoveryStart, now)) all.set(event.key, event);
      for (const event of boundariesAt(schedules, now)) all.set(event.key, event);
      const events = [...all.values()];
      const currentMinute = Math.floor(now.getTime() / 60_000) * 60_000;
      const overdue = events.filter(event => scheduledAt(event.key, now).getTime() < currentMinute)
        .sort((a, b) => scheduledAt(a.key, now).getTime() - scheduledAt(b.key, now).getTime());
      const current = events.filter(event => scheduledAt(event.key, now).getTime() === currentMinute);
      const candidateKeys = new Set(events.map(event => event.key));
      await this.failOrphanedRuns(candidateKeys);

      for (const event of current) {
        const exception = this.exceptionFor(event, exceptions);
        if (event.boundary === 'start' && !event.schedule.quiet && exception?.type === 'skip') {
          await this.markSkipped(event.key, `Date exception ${exception.date} skips this start.`, `Skipped scheduled playback for ${event.schedule.name} on ${exception.date} due to date exception.`);
          continue;
        }
        const effective = !event.schedule.quiet && exception?.type === 'replace' && exception.playlistId
          ? { ...event, overridePlaylistId: exception.playlistId, schedule: { ...event.schedule, playlistId: exception.playlistId } } : event;
        await this.claimAndExecute(effective);
      }

      const policy: MissedSchedulePolicy = settings.missedSchedulePolicy === 'latest-within-5-minutes' ? 'latest-within-5-minutes' : 'skip';
      const latestRecoverable = policy === 'latest-within-5-minutes'
        ? [...overdue].reverse().find(event => event.boundary === 'start' && !event.schedule.quiet && now.getTime() - scheduledAt(event.key, now).getTime() <= RECOVERY_GRACE_MS)
        : undefined;
      const skippedEvents: Boundary[] = [];
      const ledgerSnapshot = await this.readLedger();
      for (const event of overdue) {
        const existing = ledgerSnapshot[event.key];
        const interruptedOrRetryable = existing?.status === 'running' || existing?.status === 'pending'
          || existing?.status === 'failed' && existing.retryable && existing.attempts < MAX_ATTEMPTS;
        // Recover interrupted/retryable operations only inside the bounded window; execution paths reconcile Spotify state first.
        if (interruptedOrRetryable && now.getTime() - scheduledAt(event.key, now).getTime() <= RECOVERY_GRACE_MS) {
          const exception = this.exceptionFor(event, exceptions);
          const effective = !event.schedule.quiet && exception?.type === 'replace' && exception.playlistId
            ? { ...event, overridePlaylistId: exception.playlistId, schedule: { ...event.schedule, playlistId: exception.playlistId } } : event;
          await this.executeBoundary(effective);
          continue;
        }
        if (existing?.status === 'running' || existing?.status === 'pending') {
          await this.setEvent(event.key, { ...existing, status: 'failed', retryable: false, error: 'Interrupted operation exceeded the five-minute recovery window.', updatedAt: new Date().toISOString() });
          await this.options.log('error', `Interrupted schedule event ${event.key} was marked failed because its recovery window expired.`);
          continue;
        }
        if (existing?.status === 'failed' && existing.retryable && now.getTime() - scheduledAt(event.key, now).getTime() > RECOVERY_GRACE_MS) {
          await this.setEvent(event.key, { ...existing, retryable: false, error: 'Transient failure retry window expired.', updatedAt: new Date().toISOString() });
          continue;
        }
        if (event === latestRecoverable) {
          const exception = this.exceptionFor(event, exceptions);
          if (exception?.type === 'skip') {
            await this.markSkipped(event.key, `Date exception ${exception.date} skips this recovered start.`, `Skipped recovered playback for ${event.schedule.name} due to date exception.`);
          } else {
            const effective = exception?.type === 'replace' && exception.playlistId
              ? { ...event, overridePlaylistId: exception.playlistId, schedule: { ...event.schedule, playlistId: exception.playlistId } } : event;
            await this.options.log('warn', `Recovering the latest missed start for ${event.schedule.name}; it is ${Math.floor((now.getTime() - scheduledAt(event.key, now).getTime()) / 1000)} seconds late.`);
            await this.claimAndExecute(effective);
          }
        } else {
          skippedEvents.push(event);
        }
      }
      await this.markSkippedEvents(skippedEvents);

      if (reason !== 'poll') {
        const currentStart = new Set(current.filter(e => e.boundary === 'start').map(e => e.schedule.id));
        for (const schedule of activeQuietSchedules(schedules, now)) {
          if (!currentStart.has(schedule.id)) await this.claimRecovery(schedule, now);
        }
      }
      const quietNow = activeQuietSchedules(schedules, now).filter(s => !current.some(e => e.schedule.id === s.id && e.boundary === 'start'));
      if (quietNow.length && Date.now() - this.lastQuietEnforcement >= 30000) {
        this.lastQuietEnforcement = Date.now();
        for (const schedule of quietNow) if (await this.options.enforceQuiet(schedule)) await this.options.log('warn', `Paused playback started manually during quiet hours (“${schedule.name}”).`);
      }
      await this.persistObservation(now);
      this.lastTickFailure = '';
    } catch (e) {
      const message = String(e);
      if (message !== this.lastTickFailure || Date.now() - this.lastTickFailureAt >= 60_000) {
        this.lastTickFailure = message;
        this.lastTickFailureAt = Date.now();
        await this.options.log('error', `Scheduler tick failed: ${message}`);
      }
    }
  }
  private exceptionFor(event: Boundary, exceptions: ScheduleException[]) {
    return scheduleExceptionFor(event, exceptions);
  }
  private async readLedger(): Promise<Ledger> {
    try {
      const data = JSON.parse(await fs.readFile(this.options.stateFile, 'utf8'));
      if (Array.isArray(data.keys) && data.keys.every((key: unknown) => typeof key === 'string')) {
        this.persistedObservedAt = null;
        return Object.fromEntries(data.keys.map((key: string) => [key, { status: 'completed' as const, updatedAt: 'legacy', attempts: 1 }]));
      }
      if (!data || typeof data.events !== 'object' || Array.isArray(data.events)) throw new Error('Invalid scheduler event ledger format.');
      this.persistedObservedAt = typeof data.meta?.lastObservedAt === 'string' && Number.isFinite(Date.parse(data.meta.lastObservedAt)) ? data.meta.lastObservedAt : null;
      return Object.fromEntries(Object.entries(data.events).map(([key, value]) => [key, normalizeEvent(value)]));
    } catch (e: any) {
      if (e?.code === 'ENOENT') { this.persistedObservedAt = null; return {}; }
      if (e instanceof SyntaxError || /Invalid scheduler event ledger format/.test(String(e))) {
        this.persistedObservedAt = null;
        const preserved = `${this.options.stateFile}.invalid-${Date.now()}`;
        await fs.rename(this.options.stateFile, preserved);
        await this.options.log('error', `Scheduler ledger was invalid; original data preserved at ${path.basename(preserved)}. A fresh ledger was created.`);
        return {};
      }
      throw new Error(`Scheduler event ledger is unreadable; actions are paused to prevent duplicate execution: ${String(e)}`);
    }
  }
  private async writeLedger(events: Ledger) {
    await fs.mkdir(path.dirname(this.options.stateFile), { recursive: true });
    const temp = `${this.options.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 3, meta: { lastObservedAt: this.persistedObservedAt }, events }), 'utf8');
    await fs.rename(temp, this.options.stateFile);
  }
  private async claim(key: string): Promise<boolean> {
    const events = await this.readLedger();
    if (events[key]) return false;
    events[key] = { status: 'pending', updatedAt: new Date().toISOString(), attempts: 0 };
    await this.writeLedger(events);
    return true;
  }
  private async setEvent(key: string, event: LedgerEvent) {
    const events = await this.readLedger();
    events[key] = event;
    await this.writeLedger(events);
  }
  private async failOrphanedRuns(candidateKeys: Set<string>) {
    const events = await this.readLedger();
    let changed = false;
    for (const [key, event] of Object.entries(events)) {
      if ((!['running', 'pending'].includes(event.status) && !(event.status === 'failed' && event.retryable)) || candidateKeys.has(key)) continue;
      events[key] = { ...event, status: 'failed', retryable: false, error: 'Interrupted by application shutdown or crash; recovery window expired.', updatedAt: new Date().toISOString() };
      changed = true;
      await this.options.log('error', `Interrupted schedule event ${key} was marked failed because its recovery window expired.`);
    }
    if (changed) await this.writeLedger(events);
  }
  private async markSkipped(key: string, reason: string, message: string) {
    const events = await this.readLedger();
    if (events[key]) return;
    events[key] = { status: 'skipped', updatedAt: new Date().toISOString(), attempts: 0, error: reason };
    await this.writeLedger(events);
    await this.options.log('warn', message);
  }
  private async markSkippedEvents(eventsToSkip: Boundary[]) {
    if (!eventsToSkip.length) return;
    const events = await this.readLedger();
    const skipped: Boundary[] = [];
    for (const event of eventsToSkip) {
      if (events[event.key]) continue;
      events[event.key] = { status: 'skipped', updatedAt: new Date().toISOString(), attempts: 0, error: 'Missed occurrence expired or was superseded by a newer occurrence.' };
      skipped.push(event);
    }
    if (!skipped.length) return;
    await this.writeLedger(events);
    const names = [...new Set(skipped.map(event => event.schedule.name))].slice(0, 4).join(', ');
    await this.options.log('warn', `Skipped ${skipped.length} expired or superseded missed schedule event${skipped.length === 1 ? '' : 's'}${names ? ` (${names})` : ''}.`);
  }
  private async persistObservation(now: Date) {
    const minute = Math.floor(now.getTime() / 60_000) * 60_000;
    const value = new Date(minute).toISOString();
    this.lastObservedAt = now;
    if (this.persistedObservedAt && Math.floor(new Date(this.persistedObservedAt).getTime() / 60_000) === Math.floor(minute / 60_000)) return;
    const events = await this.readLedger();
    this.persistedObservedAt = value;
    await this.writeLedger(events);
  }
  private async claimAndExecute(event: Boundary) { await this.executeBoundary(event); }
  private async executeBoundary(event: Boundary) {
    const key = event.key;
    if (this.inFlight.has(key)) return;
    const ledger = await this.readLedger();
    const previous = ledger[key];
    if (previous?.status === 'completed' || previous?.status === 'skipped') return;
    if (previous?.status === 'failed' && (!previous.retryable || previous.attempts >= MAX_ATTEMPTS)) return;
    this.inFlight.add(key);
    try {
      let attempts = previous?.attempts || 0;
      const actual = this.options.now?.() || new Date();
      const scheduled = scheduledAt(key, actual);
      if (event.boundary === 'end' && !event.schedule.quiet) {
        const start = new Date(scheduled);
        if (event.schedule.end <= event.schedule.start) start.setDate(start.getDate() - 1);
        const startKey = `${event.schedule.id}:start:${localDateKey(start)}:${event.schedule.start}`;
        const startedPlaylistUri = this.recoveredPlaylist?.startKey === startKey
          ? this.recoveredPlaylist.uri : ledger[startKey]?.playlistUri;
        if (startedPlaylistUri) event = { ...event, startedPlaylistUri };
      }
      if (!previous) {
        await this.setEvent(key, { status: 'pending', updatedAt: new Date().toISOString(), attempts: 0 });
      } else if (previous.status === 'running') {
        await this.options.log('warn', `Recovering interrupted schedule event ${key}; Spotify state will be checked before commands are repeated.`);
      }
      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        await this.setEvent(key, { status: 'running', updatedAt: new Date().toISOString(), attempts });
        await this.options.log('info', `Schedule attempt ${attempts}/${MAX_ATTEMPTS}: ${event.schedule.name} ${event.boundary}; scheduled local ${localDateKey(scheduled)} ${localTime(scheduled)}; actual local ${localDateKey(actual)} ${localTime(actual)}.`);
        try {
          const result = await this.options.execute(event);
          if (result && typeof result === 'object' && 'skipped' in result) {
            await this.setEvent(key, { status: 'skipped', updatedAt: new Date().toISOString(), attempts, error: result.skipped.slice(0, 500) });
            await this.options.log('warn', `Schedule event skipped: ${event.schedule.name} ${event.boundary}; ${result.skipped}.`);
            return;
          }
          const playlistUri = result && typeof result === 'object' && 'playlistUri' in result ? result.playlistUri : undefined;
          await this.setEvent(key, { status: 'completed', updatedAt: new Date().toISOString(), attempts, playlistUri });
          const playlist = event.schedule.quiet ? 'none (quiet hours)' : playlistUri || event.startedPlaylistUri || event.schedule.playlistId || 'unassigned';
          await this.options.log('info', `Schedule result: ${event.schedule.name} ${event.boundary} completed; playlist ${playlist}.`);
          return;
        } catch (error) {
          const message = String(error).slice(0, 500);
          const canRetry = retryableFailure(error) && attempts < MAX_ATTEMPTS && !this.shuttingDown;
          await this.setEvent(key, { status: canRetry ? 'failed' : 'failed', updatedAt: new Date().toISOString(), attempts, error: message, retryable: canRetry });
          await this.options.log(canRetry ? 'warn' : 'error', `Schedule attempt ${attempts} failed: ${event.schedule.name} ${event.boundary}; ${message}${canRetry ? '; a bounded retry will follow.' : ''}`);
          if (!canRetry) return;
          await (this.options.wait || wait)(RETRY_DELAYS_MS[attempts - 1]);
        }
      }
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async claimRecovery(schedule: ScheduledEntry, now: Date) {
    const overnight = schedule.end <= schedule.start;
    const date = overnight && localTime(now) < schedule.end ? localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) : localDateKey(now);
    const key = `${schedule.id}:quiet-recovery:${date}`;
    const previous = (await this.readLedger())[key];
    if (previous?.status === 'completed' || previous?.status === 'skipped') return;
    if (previous?.status === 'failed' && (!previous.retryable || previous.attempts >= MAX_ATTEMPTS)) return;
    if (!previous) await this.claim(key);
    const attempts = (previous?.attempts || 0) + 1;
    await this.setEvent(key, { status: 'running', updatedAt: new Date().toISOString(), attempts });
    await this.options.log('warn', `Recovering active quiet schedule “${schedule.name}” after ${date}; missed music starts are skipped.`);
    try {
      await this.options.recoverQuiet(schedule);
      await this.setEvent(key, { status: 'completed', updatedAt: new Date().toISOString(), attempts });
    } catch (e) {
      await this.setEvent(key, { status: 'failed', updatedAt: new Date().toISOString(), attempts, error: String(e).slice(0, 500), retryable: retryableFailure(e) && attempts < MAX_ATTEMPTS });
      await this.options.log('error', `Quiet schedule recovery failed for “${schedule.name}”: ${String(e)}`);
    }
  }
}
