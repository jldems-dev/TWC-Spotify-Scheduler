export const advertisementDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type AdvertisementScheduleType = "weekly" | "random" | "repeat";
export type AdvertisementSchedule = {
  id: string;
  name: string;
  type: AdvertisementScheduleType;
  days: string[];
  start: string;
  end: string;
  times: string[];
  advertisementIds: string[];
  minIntervalMinutes?: number;
  maxIntervalMinutes?: number;
  repeatIntervalMinutes?: number;
  rotate: boolean;
  enabled: boolean;
};

const validTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{36}$/.test(value);

export function validateAdvertisementSchedule(value: any): string | null {
  if (!value || typeof value !== "object") return "Enter a valid schedule.";
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80) return "Enter a schedule name up to 80 characters.";
  if (!validId(value.id)) return "Invalid schedule ID.";
  if (!["weekly", "random", "repeat"].includes(value.type)) return "Choose a schedule type.";
  if (!Array.isArray(value.days) || !value.days.length || value.days.length > 7 || value.days.some((day: unknown) => !advertisementDays.includes(day as any))) return "Select at least one weekday.";
  if (!validTime(value.start) || !validTime(value.end) || value.end <= value.start) return "Enter a valid operating window with an end time after the start time.";
  if (!Array.isArray(value.advertisementIds) || !value.advertisementIds.length || value.advertisementIds.length > 100 || value.advertisementIds.some((id: unknown) => !validId(id))) return "Select at least one valid advertisement.";
  if (typeof value.rotate !== "boolean" || typeof value.enabled !== "boolean") return "Invalid schedule state.";
  if (value.type === "weekly") {
    if (!Array.isArray(value.times) || !value.times.length || value.times.length > 48 || value.times.some((time: unknown) => !validTime(time) || (time as string) < value.start || (time as string) >= value.end)) return "Add one or more playback times inside the operating window.";
  }
  if (value.type === "random" && (!Number.isInteger(value.minIntervalMinutes) || !Number.isInteger(value.maxIntervalMinutes) || value.minIntervalMinutes < 1 || value.maxIntervalMinutes > 1440 || value.minIntervalMinutes > value.maxIntervalMinutes)) return "Enter a valid random interval range from 1 to 1,440 minutes.";
  if (value.type === "repeat" && (!Number.isInteger(value.repeatIntervalMinutes) || value.repeatIntervalMinutes < 1 || value.repeatIntervalMinutes > 1440)) return "Enter a repeat interval from 1 to 1,440 minutes.";
  return null;
}

export function normalizeAdvertisementSchedule(value: any): AdvertisementSchedule | null {
  if (validateAdvertisementSchedule(value)) return null;
  return {
    id: value.id,
    name: value.name.trim(),
    type: value.type,
    days: [...value.days],
    start: value.start,
    end: value.end,
    times: value.type === "weekly" ? [...value.times].sort() : [],
    advertisementIds: [...new Set<string>(value.advertisementIds as string[])],
    ...(value.type === "random" ? { minIntervalMinutes: value.minIntervalMinutes, maxIntervalMinutes: value.maxIntervalMinutes } : {}),
    ...(value.type === "repeat" ? { repeatIntervalMinutes: value.repeatIntervalMinutes } : {}),
    rotate: value.rotate,
    enabled: value.enabled,
  };
}

export function saveAdvertisementSchedule(schedules: AdvertisementSchedule[], schedule: AdvertisementSchedule): AdvertisementSchedule[] {
  return [...(schedules || []).filter(item => item.id !== schedule.id), { ...schedule, days: [...schedule.days], times: [...schedule.times], advertisementIds: [...schedule.advertisementIds] }];
}
export function removeAdvertisementSchedule(schedules: AdvertisementSchedule[], id: string): AdvertisementSchedule[] { return (schedules || []).filter(item => item.id !== id); }
export function setAdvertisementScheduleEnabled(schedules: AdvertisementSchedule[], id: string, enabled: boolean): AdvertisementSchedule[] { return (schedules || []).map(item => item.id === id ? { ...item, enabled } : item); }
