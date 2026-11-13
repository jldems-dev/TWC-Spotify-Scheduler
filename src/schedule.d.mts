export type IntervalSchedule = { id: string; days: string[]; start: string; end: string; enabled: boolean };
export function schedulesConflict(a: IntervalSchedule, b: IntervalSchedule): boolean;
export function validateSchedule(s: IntervalSchedule): string | null;
export function formatLocalDateTime(date: Date): string;
export function nextScheduledAction(schedules: any[], now?: Date, exceptions?: any[]): { schedule: any; at: Date; boundary: 'start' | 'end'; exception?: any } | null;
export function localDateKey(date: Date): string;
export function scheduleBoundariesAt(schedules: any[], now: Date): { schedule: any; boundary: 'start' | 'end'; key: string }[];
export function activeQuietSchedules(schedules: any[], now: Date): any[];
