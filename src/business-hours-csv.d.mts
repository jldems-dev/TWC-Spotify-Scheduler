export function parseBusinessHoursCsv(text: string): { regular: any[]; special: any[]; closedDays: string[]; duplicates: number };
export const businessHoursCsvTemplates: { weekly: string; holidays: string };
export function downloadBusinessHoursCsvTemplate(kind: 'weekly' | 'holidays'): void;
