import { businessDays, normalizeBusinessTime } from './google-hours.mjs';
import { schedulesConflict } from './schedule.mjs';

const weekdayAliases = {
  mon: 'Mon', monday: 'Mon', tue: 'Tue', tues: 'Tue', tuesday: 'Tue', wed: 'Wed', wednesday: 'Wed',
  thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu', fri: 'Fri', friday: 'Fri',
  sat: 'Sat', saturday: 'Sat', sun: 'Sun', sunday: 'Sun',
};
const headerAliases = {
  day: ['day', 'weekday', 'dayofweek'],
  start: ['start', 'starttime', 'open', 'opentime', 'opening', 'openingtime'],
  end: ['end', 'endtime', 'close', 'closetime', 'closing', 'closingtime'],
  date: ['date', 'holidaydate', 'exceptiondate'],
  name: ['name', 'holidayname', 'exceptionname'],
  status: ['status'],
};
const normalizeHeader = value => value.trim().toLowerCase().replace(/[^a-z]/g, '');

export const businessHoursCsvTemplates = {
  weekly: 'day,open_time,close_time,status\nMonday,08:00,18:00,open\nTuesday,08:00,18:00,open\nWednesday,08:00,18:00,open\nThursday,08:00,21:00,open\nFriday,08:00,18:00,open\nSaturday,08:30,16:30,open\nSunday,09:30,16:00,open\n',
  holidays: 'date,name,open_time,close_time,status\n2026-12-24,Christmas Eve,08:00,18:00,open\n2026-12-25,Christmas Day,,,closed\n2026-12-26,Boxing Day,08:30,16:30,open\n',
};

export function downloadBusinessHoursCsvTemplate(kind) {
  const content = businessHoursCsvTemplates[kind];
  if (!content) throw new Error('Unknown business hours CSV template.');
  const filename = kind === 'weekly' ? 'weekly-hours-template.csv' : 'holiday-exceptions-template.csv';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}

function parseRows(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function isClosed(value, rowNumber) {
  const text = value.trim().toLowerCase();
  if (text === 'closed') return true;
  if (text === 'open') return false;
  throw new Error(`CSV row ${rowNumber}: status must be open or closed.`);
}

function validateDate(value, rowNumber) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`CSV row ${rowNumber}: date must use YYYY-MM-DD.`);
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`CSV row ${rowNumber}: invalid calendar date ${value}.`);
  return value;
}

export function parseBusinessHoursCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CSV file is empty.');
  const rows = parseRows(text.replace(/^\uFEFF/, ''));
  const headerRow = rows.shift()?.map(value => value.trim());
  if (!headerRow?.length) throw new Error('CSV header row is missing.');
  const columns = {};
  const unsupported = [];
  headerRow.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    let recognized = false;
    for (const [key, aliases] of Object.entries(headerAliases)) if (aliases.includes(normalized)) {
      recognized = true;
      if (columns[key] !== undefined) throw new Error(`CSV has more than one ${key} column.`);
      columns[key] = index;
    }
    if (!recognized) unsupported.push(header || `(blank column ${index + 1})`);
  });
  const exceptionFormat = columns.date !== undefined;
  const requiredColumns = exceptionFormat ? ['date', 'name', 'start', 'end', 'status'] : ['day', 'start', 'end', 'status'];
  const missing = requiredColumns.filter(key => columns[key] === undefined);
  if (missing.length || unsupported.length) {
    const format = exceptionFormat ? 'holiday exceptions' : 'weekly hours';
    const required = exceptionFormat ? 'date,name,open_time,close_time,status' : 'day,open_time,close_time,status';
    const problems = [];
    if (missing.length) {
      const columnNames = { day: 'day', date: 'date', name: 'name', start: 'open_time', end: 'close_time', status: 'status' };
      problems.push(`missing: ${missing.map(key => columnNames[key]).join(', ')}`);
    }
    if (unsupported.length) problems.push(`unsupported: ${unsupported.join(', ')}`);
    throw new Error(`CSV headers for ${format} are invalid (${problems.join('; ')}). Use these columns: ${required}. Download the matching template and keep its header row.`);
  }

  const regular = []; const special = []; const closedDays = new Set(); const recurringRows = new Set(); const holidayDates = new Set(); let duplicates = 0;
  rows.forEach((cells, index) => {
    const rowNumber = index + 2;
    if (!cells.some(value => value.trim())) return;
    if (cells.length > headerRow.length && cells.slice(headerRow.length).some(value => value.trim())) throw new Error(`CSV row ${rowNumber}: unexpected extra columns.`);
    const value = key => columns[key] === undefined ? '' : (cells[columns[key]] || '').trim();
    const dayRaw = value('day').toLowerCase();
    const dateRaw = value('date');
    let day = '';
    if (dayRaw) {
      day = weekdayAliases[dayRaw];
      if (!day) throw new Error(`CSV row ${rowNumber}: invalid weekday ${value('day')}.`);
    }
    if (!day && !dateRaw) throw new Error(`CSV row ${rowNumber}: provide a weekday or a date.`);
    const closed = isClosed(value('status'), rowNumber);
    if (dateRaw) {
      const date = validateDate(dateRaw, rowNumber);
      if (day) {
        const dateWeekday = businessDays[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
        if (dateWeekday !== day) throw new Error(`CSV row ${rowNumber}: ${date} is a ${dateWeekday}, not ${day}.`);
      }
      if (holidayDates.has(date)) throw new Error(`CSV row ${rowNumber}: duplicate holiday date ${date}.`);
      holidayDates.add(date);
      const name = value('name');
      if (!name) throw new Error(`CSV row ${rowNumber}: exception name is required.`);
      const startRaw = value('start'); const endRaw = value('end');
      if (closed) {
        if (startRaw || endRaw) throw new Error(`CSV row ${rowNumber}: closed exceptions must leave open_time and close_time empty.`);
        special.push({ date, name, closed: true, start: null, end: null, label: `${name} (closed)` }); return;
      }
      if (!startRaw || !endRaw) throw new Error(`CSV row ${rowNumber}: open exceptions need both times; use status=closed for closures.`);
      const start = normalizeBusinessTime(startRaw); const end = normalizeBusinessTime(endRaw);
      if (start === end) throw new Error(`CSV row ${rowNumber}: start and end times cannot be the same.`);
      special.push({ date, name, closed: false, start, end, label: `${name} (special hours)` }); return;
    }
    const startRaw = value('start'); const endRaw = value('end');
    if (closed) {
      if (startRaw || endRaw) throw new Error(`CSV row ${rowNumber}: closed rows must leave open_time and close_time empty.`);
      closedDays.add(day); return;
    }
    if (!startRaw || !endRaw) throw new Error(`CSV row ${rowNumber}: open rows need both times; use status=closed for closures.`);
    const start = normalizeBusinessTime(startRaw); const end = normalizeBusinessTime(endRaw);
    if (start === end) throw new Error(`CSV row ${rowNumber}: start and end times cannot be the same.`);
    const rowKey = `${day}|${start}|${end}`;
    if (recurringRows.has(rowKey)) { duplicates++; return; }
    recurringRows.add(rowKey);
    regular.push({ day, start, end, overnight: end < start });
  });
  if (!regular.length && !special.length && !closedDays.size) throw new Error('CSV contains no business hours or explicit closed days.');
  for (const day of closedDays) if (regular.some(period => period.day === day)) throw new Error(`CSV marks ${day} both open and closed.`);
  for (let index = 0; index < regular.length; index++) for (let other = index + 1; other < regular.length; other++) {
    if (schedulesConflict({ ...regular[index], id: `csv-${index}`, days: [regular[index].day], enabled: true }, { ...regular[other], id: `csv-${other}`, days: [regular[other].day], enabled: true })) throw new Error(`CSV contains overlapping opening hours on ${regular[other].day}.`);
  }
  return { regular, special, closedDays: businessDays.filter(day => closedDays.has(day)), duplicates };
}
