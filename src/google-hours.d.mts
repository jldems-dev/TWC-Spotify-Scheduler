export type BusinessPeriod = { day: string; start: string; end: string; overnight: boolean };
export type SpecialPeriod = { date: string; closed: boolean; start: string | null; end: string | null; label: string };
export function normalizeBusinessTime(value: string | number): string;
export const businessDays: string[];
export function parseBusinessHours(location: any): { regular: BusinessPeriod[]; special: SpecialPeriod[]; closedDays: string[] };
export function businessHoursPreview(hours: any): any[];
export function importHoursAsSchedules(hours: any, options: { playlistId: string; playlistName: string; existing?: any[]; existingExceptions?: any[]; locationName?: string; locationId?: string; sourceType?: 'google' | 'csv' }): { schedules: any[]; previewSchedules: any[]; special: any[]; exceptions: any[]; replacements: string[]; duplicates: number; ownerPrefix: string; conflicts?: any[] };
export function resolveGoogleImportPlan(plan: any, existingSchedules: any[], existingExceptions: any[], conflicts: any[], resolutions: Record<string, string>): { schedules: any[]; exceptions: any[]; acceptedCount: number; exceptionCount: number; skippedCount: number };
export const demoBusinessHours: any;
