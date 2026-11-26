import { announcementOccursOn } from "./announcement-service";
import type { AdvertisementSchedule } from "./advertisement-schedule";
import { activeQuietSchedules, boundariesBetween, scheduleExceptionFor, scheduledAt, type ScheduledEntry, type ScheduleException } from "./scheduler";

type DashboardStore = {
  settings: Record<string, unknown>;
  schedules: (ScheduledEntry & { playlistName?: string })[];
  exceptions: (ScheduleException & { playlistName?: string })[];
  playlists: { id: string; name: string }[];
  announcements: { id: string; enabled: boolean }[];
  announcementSchedules: any[];
  advertisements: { id: string; enabled: boolean }[];
  advertisementSchedules: AdvertisementSchedule[];
};
type Activity = { announcement: boolean; advertisement: boolean; blocked: boolean };
type Action = { description: string; name: string; at: Date };
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const name = (value: unknown) => typeof value === "string" ? value.slice(0, 200) : "";
const dayAt = (date: Date, offset = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
const dateFromKey = (key: string) => new Date(`${key}T00:00:00`);
const minutes = (clock: string) => {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
};
const timeAt = (day: Date, minute: number) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60);

export function remotePlaybackBlock(activity: Activity, quiet: boolean) {
  if (activity.announcement && activity.advertisement) return "Announcement and advertisement playing. Spotify controls are temporarily disabled.";
  if (activity.announcement) return "Announcement playing. Spotify controls are temporarily disabled.";
  if (activity.advertisement) return "Advertisement playing. Spotify controls are temporarily disabled.";
  if (activity.blocked) return "Spotify controls are unavailable during the scheduled announcement window.";
  return quiet ? "Spotify controls are unavailable during Quiet Hours." : null;
}

function upcomingMusic(store: DashboardStore, now: Date): Action[] {
  const today = dayAt(now);
  return store.schedules.filter(schedule => schedule.enabled).flatMap(schedule => {
    const anchor = schedule.date ? dateFromKey(schedule.date) : today;
    const first = anchor > today ? anchor : today;
    const horizon = schedule.repeat === "yearly" ? 1462 : schedule.repeat === "monthly" ? 63 : 8;
    const ranges = schedule.dates
      ? schedule.dates.map(dateFromKey).filter(date => date >= dayAt(now, -1))
        .map(day => [new Date(day.getTime() - 1), dayAt(day, 2)] as const)
      : [[first > today ? new Date(first.getTime() - 1) : now, dayAt(first, horizon)] as const];
    const next = ranges.flatMap(([after, through]) => boundariesBetween([schedule], after, through))
      .map(event => ({ event, at: scheduledAt(event.key, now) }))
      .filter(({ at, event }) => at > now && (schedule.quiet || event.boundary === "end"
        || scheduleExceptionFor(event, store.exceptions)?.type !== "skip"))
      .sort((a, b) => Number(a.at) - Number(b.at))[0];
    if (!next) return [];
    const start = next.event.boundary === "start";
    return [{
      description: schedule.quiet ? (start ? "Start Quiet Hours" : "End Quiet Hours") : (start ? "Start Spotify" : "Pause Spotify"),
      name: name(schedule.name),
      at: next.at,
    }];
  });
}

function upcomingAudio(store: DashboardStore, now: Date, randomTimes: ReadonlyMap<string, number>): Action[] {
  const today = dayAt(now);
  const announcements = new Set(store.announcements.filter(item => item.enabled).map(item => item.id));
  const advertisements = new Set(store.advertisements.filter(item => item.enabled).map(item => item.id));
  const next: Action[] = [];
  for (const schedule of store.announcementSchedules) {
    if (!schedule.enabled) continue;
    const anchor = schedule.date ? dateFromKey(schedule.date) : today;
    const first = anchor > today ? anchor : today;
    const days = schedule.date ? (schedule.repeat === "yearly" ? 1462 : 1) : 8;
    const times = (schedule.date ? [[schedule.time, schedule.announcementId]] : [
      [schedule.start, schedule.firstAnnouncementId], [schedule.end, schedule.secondAnnouncementId],
    ]).filter(([time, id]) => typeof time === "string" && announcements.has(id));
    if (!times.length) continue;
    for (let offset = 0; offset < days; offset++) {
      const day = dayAt(first, offset);
      if (!announcementOccursOn(schedule, day)) continue;
      const future = times.map(([time]) => timeAt(day, minutes(time))).filter(at => at > now);
      if (!future.length) continue;
      for (const at of future) next.push({ description: "Announcement", name: name(schedule.name), at });
      break;
    }
  }
  for (const schedule of store.advertisementSchedules) {
    if (!schedule.enabled || !schedule.advertisementIds.some(id => advertisements.has(id))) continue;
    if (schedule.type === "random") {
      const at = new Date(randomTimes.get(schedule.id) ?? NaN);
      const minute = at.getHours() * 60 + at.getMinutes();
      if (at > now && schedule.days.includes(weekdays[at.getDay()]) &&
          minute >= minutes(schedule.start) && minute < minutes(schedule.end))
        next.push({ description: "Advertisement", name: name(schedule.name), at });
      continue;
    }
    for (let offset = 0; offset < 8; offset++) {
      const day = dayAt(today, offset);
      if (!schedule.days.includes(weekdays[day.getDay()])) continue;
      const start = minutes(schedule.start);
      const end = minutes(schedule.end);
      const elapsed = offset === 0 ? now.getHours() * 60 + now.getMinutes() - start + 1 : 0;
      const interval = schedule.repeatIntervalMinutes || 1;
      const times = schedule.type === "weekly" ? schedule.times.map(minutes) : [start + Math.max(0, Math.ceil(elapsed / interval)) * interval];
      const future = times.filter(minute => minute >= start && minute < end).map(minute => timeAt(day, minute)).filter(at => at > now);
      if (!future.length) continue;
      for (const at of future) next.push({ description: "Advertisement", name: name(schedule.name), at });
      break;
    }
  }
  return next;
}

export function remoteScheduleSummary(store: DashboardStore, now = new Date(), randomTimes: ReadonlyMap<string, number> = new Map()) {
  const schedulerEnabled = store.settings.schedulerEnabled === true;
  const actions = [...(schedulerEnabled ? upcomingMusic(store, now) : []), ...upcomingAudio(store, now, randomTimes)];
  const next = actions.sort((a, b) => Number(a.at) - Number(b.at))[0];
  const playlistName = (id: unknown) => name(store.playlists.find(item => item.id === id)?.name);
  const today = dayAt(now);
  const tomorrow = dayAt(now, 1);
  const todayPlaylists = new Set<string>();
  if (schedulerEnabled) {
    const music = store.schedules.filter(schedule => !schedule.quiet);
    const events = boundariesBetween(music, new Date(dayAt(today, -1).getTime() - 1), new Date(tomorrow.getTime() - 1));
    const carried = new Set(events.filter(({ schedule, boundary, key }) =>
      boundary === "end" && schedule.end <= schedule.start && scheduledAt(key, now) > today &&
      scheduledAt(key, now) < tomorrow).map(({ schedule }) => schedule.id));
    for (const event of events.sort((a, b) => Number(scheduledAt(a.key, now)) - Number(scheduledAt(b.key, now)))) {
      if (event.boundary !== "start" || (scheduledAt(event.key, now) < today && !carried.has(event.schedule.id))) continue;
      const exception = scheduleExceptionFor(event, store.exceptions);
      if (exception?.type === "skip") continue;
      const replacement = exception?.type === "replace" && exception.playlistId;
      const title = store.settings.defaultPlaylist
        ? playlistName(store.settings.defaultPlaylist) || "Configured playlist unavailable"
        : replacement ? playlistName(replacement) || name(exception.playlistName)
        : playlistName(event.schedule.playlistId) || name((event.schedule as DashboardStore["schedules"][number]).playlistName);
      if (title) todayPlaylists.add(title);
    }
  }
  return {
    schedulerEnabled,
    quiet: schedulerEnabled && activeQuietSchedules(store.schedules, now).length > 0,
    nextAction: next ? { description: next.description, name: next.name, at: next.at.toISOString() } : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultPlaylist: store.settings.defaultPlaylist
      ? playlistName(store.settings.defaultPlaylist) || "Configured playlist unavailable" : null,
    todayPlaylists: [...todayPlaylists].slice(0, 30),
  };
}
