export function announcementEventsAt(schedules: any[], now: Date): Array<{ schedule: any; boundary: "start" | "end"; key: string }>;
export function announcementWindowActive(schedules: any[], now: Date): boolean;
export function validateAnnouncementSchedule(schedule: any): string | null;
export function saveAnnouncementSchedule(schedules: any[], schedule: any): any[];
export function removeAnnouncementSchedule(schedules: any[], id: string): any[];
export function setAnnouncementScheduleEnabled(schedules: any[], id: string, enabled: boolean): any[];
export function upcomingAnnouncementOccurrences(schedules: any[], announcements: any[], now?: Date, daysAhead?: number): any[];
