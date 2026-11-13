import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { schedulesConflict, validateSchedule, formatLocalDateTime, nextScheduledAction, scheduleBoundariesAt, activeQuietSchedules } from './schedule.mjs';
import { ScheduleCoordinator, boundariesAt as schedulerBoundariesAt, activeQuietSchedules as schedulerQuietSchedules } from '../dist-electron/scheduler.js';
import { validateOAuthCallback, spotifyHttpError, readSpotifyResponse, requestSpotifyApi } from '../dist-electron/spotify-utils.js';
import { captureQuietPlayback, quietRestorePlan } from '../dist-electron/quiet-state.js';
import { activeDeviceId, playbackCommand, playlistPlaybackCommand, transferPlaybackCommand, shouldLaunchSpotifyDesktop } from '../dist-electron/spotify-playback.js';
import { missingPlaybackScopes, sanitizeSpotifyDevices, startScheduledPlayback } from '../dist-electron/scheduled-playback.js';
import { announcementEventsAt, announcementWindowActive, validateAnnouncementSchedule, saveAnnouncementSchedule, removeAnnouncementSchedule, setAnnouncementScheduleEnabled, upcomingAnnouncementOccurrences } from './announcement-scheduler.mjs';
import { validateAdvertisementSchedule, normalizeAdvertisementSchedule, saveAdvertisementSchedule, removeAdvertisementSchedule, setAdvertisementScheduleEnabled } from '../dist-electron/advertisement-schedule.js';

describe('advertisement schedule configuration', () => {
  const weekly = { id: '12345678-1234-4123-8123-123456789012', name: 'Weekday rotation', type: 'weekly', days: ['Mon', 'Tue'], start: '09:00', end: '17:00', times: ['10:00', '15:00'], advertisementIds: ['87654321-4321-4123-8123-210987654321'], rotate: false, enabled: true };
  it('validates weekly times inside selected operating hours', () => {
    assert.equal(validateAdvertisementSchedule(weekly), null);
    assert.match(validateAdvertisementSchedule({ ...weekly, times: ['08:00'] }), /inside the operating window/);
    assert.match(validateAdvertisementSchedule({ ...weekly, days: [] }), /weekday/);
  });
  it('validates random interval ranges and repeat intervals', () => {
    assert.equal(validateAdvertisementSchedule({ ...weekly, type: 'random', times: [], minIntervalMinutes: 30, maxIntervalMinutes: 60 }), null);
    assert.match(validateAdvertisementSchedule({ ...weekly, type: 'random', times: [], minIntervalMinutes: 70, maxIntervalMinutes: 60 }), /random interval range/);
    assert.equal(validateAdvertisementSchedule({ ...weekly, type: 'repeat', times: [], repeatIntervalMinutes: 15 }), null);
    assert.match(validateAdvertisementSchedule({ ...weekly, type: 'repeat', times: [], repeatIntervalMinutes: 0 }), /repeat interval/);
  });
  it('normalizes schedules, edits without duplicating, toggles, and deletes them', () => {
    const normalized = normalizeAdvertisementSchedule({ ...weekly, advertisementIds: [weekly.advertisementIds[0], weekly.advertisementIds[0]] });
    assert.deepEqual(normalized.advertisementIds, [weekly.advertisementIds[0]]);
    assert.deepEqual(normalizeAdvertisementSchedule(JSON.parse(JSON.stringify(normalized))), normalized);
    const saved = saveAdvertisementSchedule([], normalized);
    const edited = saveAdvertisementSchedule(saved, { ...normalized, name: 'Edited' });
    assert.equal(edited.length, 1);
    assert.equal(setAdvertisementScheduleEnabled(edited, normalized.id, false)[0].enabled, false);
    assert.deepEqual(removeAdvertisementSchedule(edited, normalized.id), []);
  });
});

describe('recurring announcement schedules', () => {
  const item = { id: 'a', name: 'Workday', days: ['Mon', 'Tue'], start: '08:00', end: '17:00', firstAnnouncementId: 'opening', secondAnnouncementId: 'closing', enabled: true };
  it('generates first and second events on selected weekdays only', () => {
    assert.equal(announcementEventsAt([item], new Date(2026, 9, 26, 8, 0))[0].boundary, 'start');
    assert.equal(announcementEventsAt([item], new Date(2026, 9, 27, 17, 0))[0].boundary, 'end');
    assert.equal(announcementEventsAt([item], new Date(2026, 9, 28, 8, 0)).length, 0);
  });
  it('skips disabled schedules and detects active windows for pause recovery', () => {
    assert.equal(announcementEventsAt([{ ...item, enabled: false }], new Date(2026, 9, 26, 8, 0)).length, 0);
    assert.equal(announcementWindowActive([item], new Date(2026, 9, 26, 12, 0)), true);
    assert.equal(announcementWindowActive([item], new Date(2026, 9, 26, 17, 0)), false);
  });
  it('validates end-after-start and preserves both audio choices as required fields', () => {
    assert.equal(validateAnnouncementSchedule(item), null);
    assert.match(validateAnnouncementSchedule({ ...item, end: '07:00' }), /after start/);
    assert.match(validateAnnouncementSchedule({ ...item, secondAnnouncementId: '' }), /both announcement/);
  });
  it('uses a stable unique key for one occurrence across repeated polling and restart storage', () => {
    const now = new Date(2026, 9, 26, 8, 0), first = announcementEventsAt([item], now)[0], again = announcementEventsAt([item], now)[0];
    assert.equal(first.key, 'a:start:2026-10-26:08:00');
    assert.equal(again.key, first.key);
  });
  it('creates exactly one parent schedule and generates two upcoming child occurrences', () => {
    const saved = saveAnnouncementSchedule([], item);
    const upcoming = upcomingAnnouncementOccurrences(saved, [{ id: 'opening', name: 'Opening' }, { id: 'closing', name: 'Closing' }], new Date(2026, 9, 26, 7, 0), 0);
    assert.equal(saved.length, 1);
    assert.deepEqual(upcoming.map(event => [event.scheduleId, event.boundary, event.audioName]), [['a', 'start', 'Opening'], ['a', 'end', 'Closing']]);
  });
  it('edits one parent while retaining its audio pairing and weekdays', () => {
    const edited = saveAnnouncementSchedule([item], { ...item, start: '08:30', days: ['Tue'] });
    assert.equal(edited.length, 1);
    assert.equal(edited[0].firstAnnouncementId, 'opening');
    assert.equal(edited[0].secondAnnouncementId, 'closing');
    assert.deepEqual(edited[0].days, ['Tue']);
  });
  it('does not generate events for deleted or disabled parent schedules', () => {
    const disabled = setAnnouncementScheduleEnabled([item], 'a', false);
    assert.equal(upcomingAnnouncementOccurrences(disabled, [], new Date(2026, 9, 26, 7, 0), 0).length, 0);
    assert.deepEqual(removeAnnouncementSchedule([item], 'a'), []);
    assert.equal(upcomingAnnouncementOccurrences(removeAnnouncementSchedule([item], 'a'), [], new Date(2026, 9, 26, 7, 0), 0).length, 0);
  });
  it('marks unavailable audio references without inventing a separate schedule', () => {
    const upcoming = upcomingAnnouncementOccurrences([item], [{ id: 'opening', name: 'Opening' }], new Date(2026, 9, 26, 7, 0), 0);
    assert.equal(upcoming.length, 2);
    assert.equal(upcoming[0].audioName, 'Opening');
    assert.equal(upcoming[1].audioName, null);
    assert.equal(upcoming[1].scheduleId, 'a');
  });
  it('runs a custom announcement once at its selected local date and minute', () => {
    const custom = { id: 'remembrance', name: 'Remembrance Day', date: '2026-11-11', time: '10:58', repeat: 'never', announcementId: 'audio', enabled: true };
    const now = new Date(2026, 10, 11, 10, 58);
    const first = announcementEventsAt([custom], now)[0];
    assert.equal(first.audioId, 'audio');
    assert.equal(first.custom, true);
    assert.equal(first.key, 'remembrance:start:2026-11-11:10:58');
    assert.equal(announcementEventsAt([custom], new Date(2027, 10, 11, 10, 58)).length, 0);
    assert.equal(validateAnnouncementSchedule(custom), null);
  });
  it('repeats custom announcements yearly, skips invalid leap days, and lists the next occurrence', () => {
    const annual = { id: 'annual', name: 'Remembrance Day', date: '2026-11-11', time: '10:58', repeat: 'yearly', announcementId: 'audio', enabled: true };
    assert.equal(announcementEventsAt([annual], new Date(2027, 10, 11, 10, 58))[0].audioId, 'audio');
    const next = upcomingAnnouncementOccurrences([annual], [{ id: 'audio', name: 'Remembrance' }], new Date(2026, 10, 12, 0, 0));
    assert.equal(next[0].date, '2027-11-11');
    const leap = { ...annual, date: '2024-02-29' };
    assert.equal(announcementEventsAt([leap], new Date(2025, 1, 28, 10, 58)).length, 0);
    assert.equal(announcementEventsAt([leap], new Date(2028, 1, 29, 10, 58)).length, 1);
  });
});
import { parseSecureToken } from '../dist-electron/spotify-token.js';
import { googleApiError } from '../dist-electron/google-api-utils.js';
import { createGoogleCodeChallenge, exchangeGoogleAuthorizationCode, googleTokenRequestBody, validateGoogleOAuthCallback } from '../dist-electron/google-oauth.js';
import { parseBusinessHours, importHoursAsSchedules, resolveGoogleImportPlan, demoBusinessHours } from './google-hours.mjs';
import { normalizeBusinessTime } from './google-hours.mjs';
import { parseBusinessHoursCsv, businessHoursCsvTemplates } from './business-hours-csv.mjs';
const s = (id, days, start, end) => ({ id, days, start, end, enabled: true });
describe('Google Business Profile hours import', () => {
  it('provides weekly and holiday CSV templates that parse into valid hours', () => {
    assert.match(businessHoursCsvTemplates.weekly, /^day,open_time,close_time,status\r?\nMonday,08:00,18:00,open/m);
    assert.match(businessHoursCsvTemplates.holidays, /^date,name,open_time,close_time,status\r?\n2026-12-24,Christmas Eve,08:00,18:00,open/m);
    const weekly = parseBusinessHoursCsv(businessHoursCsvTemplates.weekly);
    assert.equal(weekly.regular.length, 7);
    assert.deepEqual(weekly.regular.find(row => row.day === 'Thu'), { day: 'Thu', start: '08:00', end: '21:00', overnight: false });
    const holidays = parseBusinessHoursCsv(businessHoursCsvTemplates.holidays);
    assert.equal(holidays.special.length, 3);
    assert.equal(holidays.special[1].closed, true);
  });
  it('explains missing and unsupported CSV columns with a fix', () => {
    assert.throws(() => parseBusinessHoursCsv('day,open_time,status\nMonday,08:00,open'), /missing: close_time/);
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time,status,notes\nMonday,08:00,18:00,open,x'), /unsupported: notes.*keep its header row/);
  });
  it('maps normal hours, closed days, overnight periods and holiday closure', () => {
    const hours = parseBusinessHours({ regularHours: { periods: [{ openDay: 'FRIDAY', openTime: { hours: 20, minutes: 30 }, closeDay: 'SATURDAY', closeTime: { hours: 1 } }] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }] } });
    assert.deepEqual(hours.regular[0], { day: 'Fri', start: '20:30', end: '01:00', overnight: true });
    assert.deepEqual(hours.closedDays, ['Mon', 'Tue', 'Wed', 'Thu', 'Sat', 'Sun']);
    assert.equal(hours.special[0].closed, true);
    assert.equal(parseBusinessHours(demoBusinessHours).regular.length, 6);
    const imported = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music' });
    assert.equal(imported.exceptions[0].scheduleId, imported.schedules[0].id);
    assert.equal(imported.exceptions[0].date, '2026-12-25');
  });
  it('does not duplicate a previously imported schedule and requires a playlist', () => {
    const hours = parseBusinessHours(demoBusinessHours);
    const first = importHoursAsSchedules(hours, { playlistId: 'playlist', playlistName: 'Music', existing: [] });
    const again = importHoursAsSchedules(hours, { playlistId: 'playlist', playlistName: 'Music', existing: first.schedules, existingExceptions: first.exceptions });
    assert.equal(first.schedules.length, 2);
    assert.equal(again.schedules.length, 0);
    assert.equal(again.duplicates, 3);
    assert.throws(() => importHoursAsSchedules(hours, { playlistId: '', existing: [] }), /playlist/);
  });
  it('updates a legacy Google-managed period when business hours change instead of adding an overlap', () => {
    const hours = parseBusinessHours(demoBusinessHours);
    const previous = { id: 'old-google-mon', googleSourceId: 'google:Mon:09:00:17:00:0', name: 'Demo Stafford Music Venue · Mon', days: ['Mon'], start: '09:00', end: '17:00', playlistId: 'p', enabled: true, quiet: false };
    const updatedHours = { ...hours, regular: hours.regular.map(period => period.day === 'Mon' ? { ...period, start: '10:00', end: '18:00' } : period) };
    const result = importHoursAsSchedules(updatedHours, { playlistId: 'p', playlistName: 'Music', existing: [previous], locationName: 'Demo Stafford Music Venue', locationId: 'demo' });
    const monday = result.schedules.find(item => item.days[0] === 'Mon');
    assert.equal(monday.id, previous.id);
    assert.equal(monday.start, '10:00');
    assert.deepEqual(result.replacements, [previous.id]);
  });
  it('groups matching business hours into one schedule with the selected weekdays', () => {
    const hours = { regular: [
      { day: 'Mon', start: '08:00', end: '18:00' }, { day: 'Tue', start: '08:00', end: '18:00' },
      { day: 'Wed', start: '08:00', end: '18:00' }, { day: 'Fri', start: '08:00', end: '18:00' },
      { day: 'Thu', start: '08:00', end: '21:00' }, { day: 'Sat', start: '08:30', end: '16:30' },
      { day: 'Sun', start: '09:30', end: '16:00' },
    ], special: [], closedDays: [] };
    const result = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music' });
    assert.equal(result.schedules.length, 4);
    assert.deepEqual(result.schedules.find(item => item.start === '08:00' && item.end === '18:00').days, ['Mon', 'Tue', 'Wed', 'Fri']);
    assert.deepEqual(result.schedules.find(item => item.start === '08:00' && item.end === '21:00').days, ['Thu']);
    assert.equal(result.schedules.some(item => item.days.includes('Sun') && item.start === '08:00'), false);
  });
  it('resolves a conflict for one weekday without dropping the other weekdays in a grouped period', () => {
    const imported = { id: 'grouped', googleSourceId: 'csv:hours:weekly:Mon-Tue-Wed:08:00:18:00', name: 'CSV · Mon, Tue, Wed', days: ['Mon', 'Tue', 'Wed'], start: '08:00', end: '18:00', playlistId: 'p', enabled: true };
    const manual = { id: 'manual-tuesday', name: 'Manual Tuesday', days: ['Tue'], start: '10:00', end: '12:00', playlistId: 'p', enabled: true };
    const conflict = { id: 'conflict-tue', sourceId: imported.googleSourceId, existingId: manual.id, day: 'Tue' };
    const plan = { schedules: [imported], exceptions: [], replacements: [] };
    const result = resolveGoogleImportPlan(plan, [manual], [], [conflict], { [conflict.id]: 'keep' });
    assert.deepEqual(result.schedules.find(item => item.id === imported.id).days, ['Mon', 'Wed']);
    assert.equal(result.schedules.some(item => item.id === manual.id), true);
  });
  it('requires explicit conflict decisions and applies keep or replace without losing unrelated schedules', () => {
    const imported = { id: 'google-mon', googleSourceId: 'google:demo:Mon:0', days: ['Mon'], start: '09:00', end: '17:00', enabled: true };
    const existing = [
      { id: 'manual', name: 'Manual schedule', days: ['Mon'], start: '08:00', end: '10:00', enabled: true },
      { id: 'unrelated', name: 'Announcement music', days: ['Tue'], start: '08:00', end: '10:00', enabled: true },
    ];
    const conflict = { id: 'google-mon|manual|Mon', sourceId: imported.googleSourceId, existingId: 'manual', day: 'Mon' };
    const plan = { schedules: [imported], exceptions: [], replacements: [] };
    assert.throws(() => resolveGoogleImportPlan(plan, existing, [], [conflict], {}), /Resolve every schedule conflict/);
    const resolvedKeep = resolveGoogleImportPlan(plan, existing, [], [conflict], { [conflict.id]: 'keep' });
    assert.equal(resolvedKeep.schedules.some(item => item.id === imported.id), false);
    assert.equal(resolvedKeep.schedules.some(item => item.id === 'manual'), true);
    const resolvedReplace = resolveGoogleImportPlan(plan, existing, [], [conflict], { [conflict.id]: 'replace' });
    assert.equal(resolvedReplace.schedules.some(item => item.id === 'manual'), false);
    assert.equal(resolvedReplace.schedules.some(item => item.id === imported.id), true);
    assert.equal(resolvedReplace.schedules.some(item => item.id === 'unrelated'), true);
  });
  it('keeps holiday overrides date-specific and skips a holiday already imported', () => {
    const hours = parseBusinessHours({ regularHours: { periods: [{ openDay: 'FRIDAY', openTime: { hours: 9 }, closeDay: 'FRIDAY', closeTime: { hours: 17 } }] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }] } });
    const first = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music', locationId: 'store' });
    assert.equal(first.exceptions.length, 1);
    assert.equal(first.exceptions[0].date, '2026-12-25');
    const again = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music', locationId: 'store', existing: first.schedules, existingExceptions: first.exceptions });
    assert.equal(again.exceptions.length, 0);
    assert.equal(again.schedules.length, 0);
    assert.equal(again.duplicates, 2);
  });
  it('updates a holiday exception when Google changes a closure into open special hours', () => {
    const closedHours = parseBusinessHours({ regularHours: { periods: [{ openDay: 'FRIDAY', openTime: { hours: 9 }, closeDay: 'FRIDAY', closeTime: { hours: 17 } }] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }] } });
    const first = importHoursAsSchedules(closedHours, { playlistId: 'p', playlistName: 'Music', locationId: 'store' });
    const openHours = { ...closedHours, special: [{ date: '2026-12-25', closed: false, start: '11:00', end: '15:00', label: 'Special hours' }] };
    const changed = importHoursAsSchedules(openHours, { playlistId: 'p', playlistName: 'Music', locationId: 'store', existing: first.schedules, existingExceptions: first.exceptions });
    assert.equal(changed.schedules.some(item => item.dates?.[0] === '2026-12-25'), true);
    assert.equal(changed.special.length, 1);
  });
  it('reports failed Google API requests with approval, permission, unavailable-hours and revoked-access guidance', () => {
    assert.match(googleApiError(403, 'API has not been used in project').message, /not approved or.*not enabled/i);
    assert.match(googleApiError(403, 'insufficient permission').message, /permission denied/i);
    assert.match(googleApiError(404, '').message, /hours are unavailable/i);
    assert.match(googleApiError(401, '').message, /revoked or expired/i);
    assert.throws(() => parseBusinessHours({ title: 'No hours' }), /did not provide regular business hours/i);
  });
  it('creates a dated one-off music period for open holiday hours', () => {
    const hours = parseBusinessHours({ regularHours: { periods: [{ openDay: 'FRIDAY', openTime: { hours: 9 }, closeDay: 'FRIDAY', closeTime: { hours: 17 } }] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, openTime: { hours: 11 }, closeTime: { hours: 15 } }] } });
    const imported = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music' });
    const special = imported.schedules.find(x => x.dates);
    assert.equal(special.start, '11:00');
    assert.deepEqual(special.dates, ['2026-12-25']);
    assert.equal(imported.exceptions[0].scheduleId, imported.schedules.find(x => !x.dates).id);
  });
});
describe('Business hours CSV import', () => {
  const weeklyCsv = `day,open_time,close_time,status
Monday,08:00,18:00,open
Tuesday,08:00:00,18:00,open
Wednesday,8:00 AM,18:00,open
Friday,08:00,18:00,open
Thursday,08:00,21:00,open
Saturday,08:30,16:30,open
Sunday,,,closed`;
  const exceptionCsv = `date,name,open_time,close_time,status
2026-12-25,Christmas,11:00,15:00,open
2026-12-26,Boxing Day,,,closed`;
  it('normalizes equivalent 12-hour, 24-hour, and seconds time values', () => {
    assert.equal(normalizeBusinessTime('8:00 AM'), '08:00');
    assert.equal(normalizeBusinessTime('08:00'), '08:00');
    assert.equal(normalizeBusinessTime('08:00:00'), '08:00');
    assert.equal(normalizeBusinessTime('6:00 PM'), '18:00');
  });
  it('parses weekly hours, groups matching days, and keeps explicit closed days without inferring closures', () => {
    const hours = parseBusinessHoursCsv(weeklyCsv);
    assert.equal(hours.regular.length, 6);
    assert.deepEqual(hours.closedDays, ['Sun']);
    assert.equal(hours.closedDays.includes('Mon'), false);
    const grouped = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music', locationId: 'hours', sourceType: 'csv' });
    assert.deepEqual(grouped.schedules.find(item => item.start === '08:00' && item.end === '18:00').days, ['Mon', 'Tue', 'Wed', 'Fri']);
    assert.equal(grouped.schedules.some(item => item.days.includes('Sun')), false);
    assert.equal(grouped.schedules.some(item => item.days.includes('Thu') && item.end === '21:00'), true);
    assert.equal(grouped.schedules.some(item => item.days.includes('Mon') && item.days.includes('Thu')), false);
  });
  it('parses named date-specific open and closed exceptions separately from weekly hours', () => {
    const hours = parseBusinessHoursCsv(exceptionCsv);
    assert.deepEqual(hours.special.map(item => [item.date, item.name, item.closed, item.start, item.end]), [
      ['2026-12-25', 'Christmas', false, '11:00', '15:00'], ['2026-12-26', 'Boxing Day', true, null, null],
    ]);
    const weekly = parseBusinessHoursCsv(weeklyCsv);
    const grouped = importHoursAsSchedules({ ...weekly, special: hours.special }, { playlistId: 'p', playlistName: 'Music', locationId: 'hours', sourceType: 'csv' });
    assert.equal(grouped.schedules.some(item => item.dates?.[0] === '2026-12-25'), true);
    assert.equal(grouped.exceptions.some(item => item.date === '2026-12-26'), true);
    assert.equal(grouped.schedules.some(item => item.dates?.[0] === '2026-12-26'), false);
  });
  it('deduplicates repeated rows and repeated file imports', () => {
    const duplicateCsv = 'day,open_time,close_time,status\nMonday,8:00 AM,6:00 PM,open\nMonday,08:00:00,18:00,open';
    const hours = parseBusinessHoursCsv(duplicateCsv);
    assert.equal(hours.duplicates, 1);
    const first = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music', sourceType: 'csv', locationId: 'shop' });
    const again = importHoursAsSchedules(hours, { playlistId: 'p', playlistName: 'Music', sourceType: 'csv', locationId: 'shop', existing: first.schedules });
    assert.equal(first.schedules.length, 1);
    assert.equal(again.schedules.length, 0);
    assert.equal(again.duplicates, 2);
  });
  it('validates exact required headers, dates, times, and status-specific empty fields', () => {
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time\nMonday,08:00,17:00'), /missing: status.*Use these columns/);
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time,status\nMonday,25:00,17:00,open'), /Invalid time/);
    assert.throws(() => parseBusinessHoursCsv('date,name,open_time,close_time,status\n2026-02-30,Holiday,08:00,17:00,open'), /invalid calendar date/);
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time,status\nMonday,08:00,,open'), /both times/);
    assert.throws(() => parseBusinessHoursCsv('date,name,open_time,close_time,status\n2026-12-25,,08:00,17:00,open'), /exception name is required/);
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time,status\nSunday,09:00,,closed'), /closed rows must leave/);
    assert.throws(() => parseBusinessHoursCsv('date,name,open_time,close_time,status\n2026-12-25,Holiday,,,open'), /open exceptions need both times/);
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time,status\nMonday,08:00,17:00,maybe'), /status must be open or closed/);
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time,status\nMonday,08:00,12:00,open\nMonday,11:00,17:00,open'), /overlapping opening hours/);
    assert.throws(() => parseBusinessHoursCsv('day,open_time,close_time,status\nMonday,08:00,17:00,open\nMonday,,,closed'), /both open and closed/);
  });
});
describe('Google Desktop OAuth code exchange', () => {
  const verifier = 'a'.repeat(64);
  const redirectUri = 'http://127.0.0.1:43127';
  it('exchanges one valid authorization code using PKCE and the matching loopback URI without requiring a secret', async () => {
    let calls = 0;
    const result = await exchangeGoogleAuthorizationCode({
      clientId: 'desktop-client-id.apps.googleusercontent.com', code: 'single-use-code', redirectUri, codeVerifier: verifier,
      fetcher: async (url, init) => {
        calls++;
        assert.equal(url, 'https://oauth2.googleapis.com/token');
        assert.equal(init.method, 'POST');
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('client_id'), 'desktop-client-id.apps.googleusercontent.com');
        assert.equal(body.get('redirect_uri'), redirectUri);
        assert.equal(body.get('code_verifier'), verifier);
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.has('client_secret'), false);
        return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.access_token, 'access');
    assert.equal(result.refresh_token, 'refresh');
    assert.equal(createGoogleCodeChallenge(verifier).length, 43);
  });
  it('accepts an optional secret when supplied without making it required', () => {
    const body = googleTokenRequestBody({ clientId: 'client', code: 'code', redirectUri, codeVerifier: verifier, clientSecret: 'optional-test-secret' });
    assert.equal(body.get('client_secret'), 'optional-test-secret');
  });
  it('rejects missing or invalid code-exchange parameters before making a request', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return new Response('{}', { status: 200 }); };
    await assert.rejects(exchangeGoogleAuthorizationCode({ clientId: '', code: 'c', redirectUri, codeVerifier: verifier, fetcher }), /client ID/);
    await assert.rejects(exchangeGoogleAuthorizationCode({ clientId: 'client', code: '', redirectUri, codeVerifier: verifier, fetcher }), /authorization code/);
    await assert.rejects(exchangeGoogleAuthorizationCode({ clientId: 'client', code: 'c', redirectUri: 'https://example.com/callback', codeVerifier: verifier, fetcher }), /loopback redirect URI/);
    await assert.rejects(exchangeGoogleAuthorizationCode({ clientId: 'client', code: 'c', redirectUri, codeVerifier: 'short', fetcher }), /code verifier/);
    assert.equal(calls, 0);
  });
  it('validates the exact loopback origin, redirect path, state, and a single code result', () => {
    assert.deepEqual(validateGoogleOAuthCallback(`${redirectUri}/?code=abc&state=nonce`, redirectUri, 'nonce'), { code: 'abc' });
    assert.throws(() => validateGoogleOAuthCallback(`${redirectUri}/?code=abc&state=wrong`, redirectUri, 'nonce'), /state did not match/);
    assert.throws(() => validateGoogleOAuthCallback(`http://127.0.0.1:43128/?code=abc&state=nonce`, redirectUri, 'nonce'), /loopback redirect URI/);
    assert.throws(() => validateGoogleOAuthCallback(`${redirectUri}/callback?code=abc&state=nonce`, redirectUri, 'nonce'), /callback did not match/);
    assert.throws(() => validateGoogleOAuthCallback(`${redirectUri}/?code=abc&code=def&state=nonce`, redirectUri, 'nonce'), /exactly one authorization code/);
  });
  it('rejects unsuccessful or incomplete token responses without treating authorization as connected', async () => {
    await assert.rejects(exchangeGoogleAuthorizationCode({ clientId: 'client', code: 'c', redirectUri, codeVerifier: verifier, fetcher: async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad verifier' }), { status: 400 }) }), /Google token exchange failed \(400\): Bad verifier/);
    await assert.rejects(exchangeGoogleAuthorizationCode({ clientId: 'client', code: 'c', redirectUri, codeVerifier: verifier, fetcher: async () => new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 }) }), /incomplete token response/);
  });
});
describe('weekly schedule validation', () => {
  it('rejects missing days and equal endpoints', () => { assert.match(validateSchedule(s('a', [], '09:00', '10:00')), /day/); assert.match(validateSchedule(s('a', ['Mon'], '09:00', '09:00')), /same/); });
  it('detects a shared weekday overlap', () => assert.equal(schedulesConflict(s('a', ['Mon'], '09:00', '12:00'), s('b', ['Mon'], '11:30', '13:00')), true));
  it('detects midnight crossing overlap with the next day', () => assert.equal(schedulesConflict(s('a', ['Mon'], '23:00', '01:00'), s('b', ['Tue'], '00:30', '02:00')), true));
  it('handles Sunday wrapping into Monday', () => assert.equal(schedulesConflict(s('a', ['Sun'], '23:30', '01:00'), s('b', ['Mon'], '00:30', '02:00')), true));
  it('allows back-to-back schedules', () => assert.equal(schedulesConflict(s('a', ['Tue'], '09:00', '10:00'), s('b', ['Tue'], '10:00', '11:00')), false));
});
describe('specific date and recurring schedules', () => {
  const dated = (id, date, repeat, start = '10:59', end = '11:02') => ({ id, name: id, date, repeat, days: [], start, end, enabled: true, quiet: true });
  it('runs one-time schedules only on their selected local date', () => {
    const item = dated('once', '2026-11-11', 'never');
    assert.equal(schedulerBoundariesAt([item], new Date(2026, 10, 11, 10, 59))[0].boundary, 'start');
    assert.equal(schedulerBoundariesAt([item], new Date(2027, 10, 11, 10, 59)).length, 0);
  });
  it('repeats yearly, daily, weekly, and monthly from the selected calendar date', () => {
    assert.equal(schedulerBoundariesAt([dated('year', '2026-11-11', 'yearly')], new Date(2027, 10, 11, 10, 59)).length, 1);
    assert.equal(schedulerBoundariesAt([dated('day', '2026-11-11', 'daily')], new Date(2026, 10, 12, 10, 59)).length, 1);
    assert.equal(schedulerBoundariesAt([dated('week', '2026-11-11', 'weekly')], new Date(2026, 10, 18, 10, 59)).length, 1);
    const monthly = dated('month', '2026-01-31', 'monthly');
    assert.equal(schedulerBoundariesAt([monthly], new Date(2026, 1, 28, 10, 59)).length, 0);
    assert.equal(schedulerBoundariesAt([monthly], new Date(2026, 2, 31, 10, 59)).length, 1);
  });
  it('keeps yearly leap-day schedules safe and recognizes quiet windows', () => {
    const leap = dated('leap', '2024-02-29', 'yearly');
    assert.equal(schedulerBoundariesAt([leap], new Date(2025, 1, 28, 10, 59)).length, 0);
    assert.equal(schedulerBoundariesAt([leap], new Date(2028, 1, 29, 10, 59)).length, 1);
    const quiet = dated('quiet', '2026-11-11', 'yearly');
    assert.equal(schedulerQuietSchedules([quiet], new Date(2027, 10, 11, 11, 0)).length, 1);
    assert.equal(schedulerQuietSchedules([quiet], new Date(2027, 10, 11, 11, 2)).length, 0);
  });
});
describe('local scheduled action display', () => {
  it('formats dates from local date fields in the required format', () => {
    assert.equal(formatLocalDateTime(new Date(2026, 9, 23, 12, 0)), 'FRI 23 OCT 2026 @ 12:00');
  });
  it('selects the nearest enabled recurring start in local time', () => {
    const now = new Date(2026, 9, 23, 11, 30);
    const result = nextScheduledAction([
      { ...s('later', ['Fri'], '13:00', '14:00'), name: 'Later' },
      { ...s('next', ['Fri'], '12:00', '13:00'), name: 'Next' },
      { ...s('off', ['Fri'], '11:45', '12:30'), enabled: false },
    ], now);
    assert.equal(result.schedule.name, 'Next');
    assert.equal(result.at.getHours(), 12);
    assert.equal(result.at.getDate(), 23);
  });
  it('returns no action when there are no enabled schedules', () => {
    assert.equal(nextScheduledAction([], new Date(2026, 9, 23)), null);
  });
  it('skips an exception date and substitutes the selected playlist on replacement dates', () => {
    const schedules = [{ ...s('weekday', ['Fri'], '12:00', '13:00'), name: 'Lunch', playlistId: 'original' }];
    const now = new Date(2026, 9, 23, 11, 0);
    assert.equal(nextScheduledAction(schedules, now, [{ date: '2026-10-23', type: 'skip' }]).boundary, 'end');
    const replaced = nextScheduledAction(schedules, now, [{ date: '2026-10-23', type: 'replace', playlistId: 'special', playlistName: 'Special' }]);
    assert.equal(replaced.schedule.playlistId, 'special');
    assert.equal(replaced.schedule.playlistName, 'Special');
  });
  it('reports the end boundary of an overnight schedule on the following local day', () => {
    const quietSchedule = { ...s('quiet', ['Fri'], '23:00', '01:00'), quiet: true };
    const result = scheduleBoundariesAt([quietSchedule], new Date(2026, 9, 24, 1, 0));
    assert.equal(result[0].boundary, 'end');
    assert.match(result[0].key, /2026-10-24:01:00$/);
    assert.equal(schedulerBoundariesAt([quietSchedule], new Date(2026, 9, 24, 1, 0))[0].boundary, 'end');
  });
  it('reports quiet-hour start and end boundaries once at their local clock minutes', () => {
    const quiet = { ...s('quiet-transition', ['Fri'], '22:00', '23:00'), quiet: true };
    assert.equal(schedulerBoundariesAt([quiet], new Date(2026, 9, 23, 22, 0))[0].boundary, 'start');
    assert.equal(schedulerBoundariesAt([quiet], new Date(2026, 9, 23, 23, 0))[0].boundary, 'end');
  });
  it('recognizes a quiet interval crossing midnight using its start weekday', () => {
    const quietSchedule = { ...s('quiet', ['Fri'], '23:00', '01:00'), quiet: true };
    assert.equal(activeQuietSchedules([quietSchedule], new Date(2026, 9, 24, 0, 30)).length, 1);
    assert.equal(activeQuietSchedules([quietSchedule], new Date(2026, 9, 24, 1, 0)).length, 0);
  });
  it('resolves DST gaps and repeated local minutes using the host time-zone rules', () => {
    const previousZone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const gapSchedule = { ...s('gap', ['Sun'], '02:30', '04:00'), quiet: true };
      const gapMinute = new Date(2026, 2, 8, 3, 30);
      assert.equal(scheduleBoundariesAt([gapSchedule], gapMinute)[0].boundary, 'start');
      assert.equal(schedulerBoundariesAt([gapSchedule], gapMinute)[0].boundary, 'start');
      const quiet = { ...s('quiet', ['Sun'], '01:30', '02:30'), quiet: true };
      assert.equal(activeQuietSchedules([quiet], new Date(2026, 2, 8, 3, 15)).length, 1);
      assert.equal(schedulerQuietSchedules([quiet], new Date(2026, 2, 8, 3, 15)).length, 1);
      const foldSchedule = { ...s('fold', ['Sun'], '01:30', '02:00'), quiet: false };
      const first = new Date(2026, 10, 1, 1, 30);
      const second = new Date(first.getTime() + 60 * 60 * 1000);
      assert.equal(scheduleBoundariesAt([foldSchedule], first)[0].key, scheduleBoundariesAt([foldSchedule], second)[0].key);
    } finally {
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });
  it('persists at-most-once event claims across scheduler restarts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'twc-scheduler-'));
    const opts = { stateFile: path.join(dir, 'runs.json'), getSchedules: async () => ({ settings: { schedulerEnabled: true }, schedules: [] }), execute: async () => {}, recoverQuiet: async () => {}, log: async () => {} };
    try {
      const first = new ScheduleCoordinator(opts);
      assert.equal(await first.claim('schedule:start:2026-10-23:12:00'), true);
      const restarted = new ScheduleCoordinator(opts);
      assert.equal(await restarted.claim('schedule:start:2026-10-23:12:00'), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('initializes, executes a due schedule with its date replacement, and records success once', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'twc-due-'));
    const now = new Date(2026, 9, 23, 12, 0);
    const schedule = { ...s('due-id', ['Fri'], '12:00', '13:00'), name: 'Lunch', playlistId: 'default' };
    const executed = [], logs = [];
    const opts = { stateFile: path.join(dir, 'runs.json'), now: () => now, getSchedules: async () => ({ settings: { schedulerEnabled: true }, schedules: [schedule], exceptions: [{ date: '2026-10-23', type: 'replace', playlistId: 'special' }] }), execute: async event => executed.push(event.schedule.playlistId), recoverQuiet: async () => {}, enforceQuiet: async () => false, log: async (_level, message) => logs.push(message) };
    try {
      const coordinator = new ScheduleCoordinator(opts);
      coordinator.start();
      for (let i = 0; i < 50 && !executed.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
      await new Promise(resolve => setTimeout(resolve, 10));
      coordinator.stop();
      await coordinator.tick('wake');
      assert.deepEqual(executed, ['special']);
      assert.ok(logs.some(message => message.includes('succeeded') && message.includes('special')));
      const ledger = JSON.parse(await (await import('node:fs/promises')).readFile(opts.stateFile, 'utf8'));
      assert.equal(Object.values(ledger.events)[0].status, 'succeeded');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('records a failed execution without reporting success or replaying it on restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'twc-failed-'));
    const now = new Date(2026, 9, 23, 12, 0), schedule = { ...s('failed-id', ['Fri'], '12:00', '13:00'), name: 'Lunch', playlistId: 'playlist' };
    const logs = []; let attempts = 0;
    const opts = { stateFile: path.join(dir, 'runs.json'), now: () => now, getSchedules: async () => ({ settings: { schedulerEnabled: true }, schedules: [schedule] }), execute: async () => { attempts++; throw new Error('No active Spotify device'); }, recoverQuiet: async () => {}, enforceQuiet: async () => false, log: async (_level, message) => logs.push(message) };
    try {
      await new ScheduleCoordinator(opts).tick();
      await new ScheduleCoordinator(opts).tick('wake');
      const ledger = JSON.parse(await (await import('node:fs/promises')).readFile(opts.stateFile, 'utf8'));
      assert.equal(attempts, 1);
      assert.equal(Object.values(ledger.events)[0].status, 'failed');
      assert.ok(logs.some(message => message.includes('failed') && message.includes('No active Spotify device')));
      assert.ok(!logs.some(message => message.includes('succeeded')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('fails a scheduled playback after Spotify 403 and does not retry or record success', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'twc-scheduled-403-'));
    const now = new Date(2026, 9, 23, 12, 0), playlistId = 'ABCDEFGHIJKLMNOPQRSTUV', schedule = { ...s('spotify-403', ['Fri'], '12:00', '13:00'), name: 'Lunch', playlistId };
    const logs = []; let playRequests = 0;
    const options = { stateFile: path.join(dir, 'runs.json'), now: () => now, getSchedules: async () => ({ settings: { schedulerEnabled: true }, schedules: [schedule] }), recoverQuiet: async () => {}, enforceQuiet: async () => false, log: async (_level, message) => logs.push(message), execute: async (event) => startScheduledPlayback({ playlistId: event.schedule.playlistId, getPlayback: async () => ({ actions: { disallows: {} } }), getDevices: async () => [{ id: 'fresh-device', is_active: true, is_restricted: false }], transfer: async () => {}, play: async (deviceId, playlistUri) => { playRequests++; assert.equal(playlistUri, `spotify:playlist:${playlistId}`); await requestSpotifyApi({ method: 'PUT', endpoint: `/me/player/play?device_id=${deviceId}`, body: { context_uri: playlistUri }, getAccessToken: async () => 'token', refreshAccessToken: async () => 'unused', fetcher: async () => new Response(JSON.stringify({ error: { status: 403, message: 'Restriction violated', reason: 'PREMIUM_REQUIRED' } }), { status: 403 }) }); } }) };
    try {
      const coordinator = new ScheduleCoordinator(options);
      await coordinator.tick();
      await coordinator.tick('wake');
      const ledger = JSON.parse(await (await import('node:fs/promises')).readFile(options.stateFile, 'utf8'));
      assert.equal(playRequests, 1);
      assert.equal(Object.values(ledger.events)[0].status, 'failed');
      assert.ok(Object.values(ledger.events)[0].error.includes('PREMIUM_REQUIRED'));
      assert.ok(logs.some(message => message.includes('PREMIUM_REQUIRED')));
      assert.ok(!logs.some(message => message.includes('succeeded')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('preserves and quarantines malformed scheduler ledger data instead of aborting on token-like text', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'twc-ledger-'));
    const file = path.join(dir, 'runs.json');
    try {
      await (await import('node:fs/promises')).writeFile(file, 'mPnZCqyW4');
      const logs = [];
      const coordinator = new ScheduleCoordinator({ stateFile: file, getSchedules: async () => ({ settings: { schedulerEnabled: true }, schedules: [] }), execute: async () => {}, recoverQuiet: async () => {}, enforceQuiet: async () => false, log: async (_level, message) => logs.push(message) });
      assert.equal(await coordinator.claim('once'), true);
      const files = await (await import('node:fs/promises')).readdir(dir);
      assert.ok(files.some(name => name.startsWith('runs.json.invalid-')));
      assert.ok(logs.some(message => message.includes('original data preserved')));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
describe('quiet-hour playback restoration', () => {
  it('captures active playback context and seeks back to the prior track position', () => {
    const saved = captureQuietPlayback({ is_playing: true, context: { uri: 'spotify:playlist:p' }, item: { uri: 'spotify:track:t' }, progress_ms: 12345 });
    assert.deepEqual(quietRestorePlan(saved), { context_uri: 'spotify:playlist:p', offset: { uri: 'spotify:track:t' }, positionMs: 12345 });
  });
  it('does not resume playback that was already paused before quiet hours', () => {
    assert.equal(quietRestorePlan(captureQuietPlayback({ is_playing: false, context: { uri: 'spotify:playlist:p' } })), null);
  });
  it('does not resume when no playback device or context was available', () => {
    assert.equal(quietRestorePlan(captureQuietPlayback(null)), null);
  });
  it('retains a persisted snapshot across restart and allows the end boundary to restore it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'twc-quiet-'));
    const file = path.join(dir, 'quiet.json');
    try {
      const beforeRestart = captureQuietPlayback({ is_playing: true, context: { uri: 'spotify:playlist:restart' }, progress_ms: 8000 });
      await (await import('node:fs/promises')).writeFile(file, JSON.stringify(beforeRestart));
      const afterRestart = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
      assert.equal(quietRestorePlan(afterRestart).context_uri, 'spotify:playlist:restart');
      assert.equal(quietRestorePlan(afterRestart).positionMs, 8000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
describe('Spotify authorization and API errors', () => {
  it('polls device activation after transfer instead of failing on the first inactive response', async () => {
    const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV'; let deviceReads = 0; let stateReads = 0; let plays = 0;
    const result = await startScheduledPlayback({
      playlistId, transitionTimeoutMs: 500, pollIntervalMs: 1, wait: async () => {},
      getPlayback: async () => { stateReads++; return plays > 0 ? { is_playing: true, context: { uri: `spotify:playlist:${playlistId}` } } : { is_playing: false }; },
      getDevices: async () => [{ id: 'desktop', is_active: ++deviceReads > 2, is_restricted: false }],
      transfer: async () => {}, play: async () => { plays++; },
    });
    assert.equal(result.transferred, true);
    assert.ok(deviceReads > 2);
    assert.equal(plays, 1);
  });
  it('does not send another Play when the requested playlist starts during transfer', async () => {
    const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV'; let reads = 0; let plays = 0;
    const result = await startScheduledPlayback({
      playlistId,
      getPlayback: async () => ++reads === 1 ? { is_playing: false } : { is_playing: true, context: { uri: `spotify:playlist:${playlistId}` } },
      getDevices: async () => [{ id: 'desktop', is_active: false, is_restricted: false }],
      transfer: async () => {}, play: async () => { plays++; },
    });
    assert.equal(result.transferred, true);
    assert.equal(plays, 0);
  });
  it('does not duplicate Play when the playlist is already playing', async () => {
    const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV'; let transfers = 0; let plays = 0;
    const result = await startScheduledPlayback({
      playlistId,
      getPlayback: async () => ({ is_playing: true, context: { uri: `spotify:playlist:${playlistId}` } }),
      getDevices: async () => [{ id: 'desktop', is_active: true, is_restricted: false }],
      transfer: async () => { transfers++; }, play: async () => { plays++; },
    });
    assert.equal(result.transferred, false);
    assert.equal(transfers + plays, 0);
  });
  it('times out when Spotify never activates the transferred device', async () => {
    await assert.rejects(startScheduledPlayback({
      playlistId: 'ABCDEFGHIJKLMNOPQRSTUV', transitionTimeoutMs: 0,
      getPlayback: async () => ({ is_playing: false }), getDevices: async () => [{ id: 'desktop', is_active: false, is_restricted: false }],
      transfer: async () => {}, play: async () => assert.fail('Play must wait for activation'),
    }), /confirmation timeout/);
  });
  it('only launches Spotify when the explicit launch check confirms it is closed', () => {
    assert.equal(shouldLaunchSpotifyDesktop(true), false);
    assert.equal(shouldLaunchSpotifyDesktop(null), false);
    assert.equal(shouldLaunchSpotifyDesktop(false), true);
  });
  it('ignores a stale playback-state device ID and uses the fresh active device list', async () => {
    const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV'; const calls = []; let stateReads = 0;
    const result = await startScheduledPlayback({
      playlistId,
      getPlayback: async () => ++stateReads === 1
        ? ({ device: { id: 'stale-id', is_active: true }, actions: { disallows: {} } })
        : stateReads === 2 ? ({ is_playing: false, actions: { disallows: {} } })
          : ({ is_playing: true, context: { uri: `spotify:playlist:${playlistId}` }, actions: { disallows: {} } }),
      getDevices: async () => [{ id: 'new-current-id', name: 'Desktop', type: 'computer', is_active: true, is_restricted: false }],
      transfer: async () => assert.fail('An already active device must not be transferred.'),
      play: async (deviceId, playlistUri) => calls.push({ deviceId, playlistUri }),
    });
    assert.deepEqual(result, { deviceId: 'new-current-id', transferred: false });
    assert.deepEqual(calls, [{ deviceId: 'new-current-id', playlistUri: `spotify:playlist:${playlistId}` }]);
    assert.equal(stateReads, 3);
  });
  it('transfers to an available inactive desktop, refreshes state, and starts a paused playlist once', async () => {
    const playlistId = '0123456789012345678901'; const stages = []; const calls = []; let deviceReads = 0; let playbackReads = 0;
    const result = await startScheduledPlayback({
      playlistId,
      getPlayback: async () => {
        playbackReads++;
        if (playbackReads === 1) return { is_playing: false, device: { id: 'desktop', is_active: false }, actions: { disallows: {} } };
        if (playbackReads === 2) return { is_playing: false, device: { id: 'desktop', is_active: true }, actions: { disallows: {} } };
        if (playbackReads === 3) return { is_playing: false, context: { uri: `spotify:playlist:${playlistId}` } };
        return { is_playing: true, context: { uri: `spotify:playlist:${playlistId}` } };
      },
      getDevices: async () => {
        deviceReads++;
        return [{ id: 'desktop', name: 'Spotify Desktop', type: 'computer', is_active: deviceReads > 1, is_restricted: false, is_private_session: false }];
      },
      transfer: async id => calls.push({ type: 'transfer', id }),
      onDevices: (_devices, stage) => stages.push(stage),
      play: async (id, uri) => calls.push({ type: 'play', id, uri }),
    });
    assert.deepEqual(result, { deviceId: 'desktop', transferred: true });
    assert.deepEqual(stages, ['initial', 'after-transfer']);
    assert.deepEqual(calls, [
      { type: 'transfer', id: 'desktop' },
      { type: 'play', id: 'desktop', uri: `spotify:playlist:${playlistId}` },
    ]);
    assert.equal(deviceReads, 2);
    assert.equal(playbackReads, 4);
  });
  it('does not start the playlist when transfer fails or the device remains inactive', async () => {
    const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV'; let starts = 0; let refreshes = 0;
    const common = { playlistId, transitionTimeoutMs: 0, getPlayback: async () => ({ actions: { disallows: {} } }), getDevices: async () => [{ id: 'desktop', is_active: refreshes++ > 0, is_restricted: false }], play: async () => { starts++; } };
    await assert.rejects(startScheduledPlayback({ ...common, transfer: async () => { throw new Error('Spotify denied transfer (403).'); } }), /denied transfer/);
    refreshes = 0;
    await assert.rejects(startScheduledPlayback({ ...common, getDevices: async () => [{ id: 'desktop', is_active: false, is_restricted: false }], transfer: async () => {} }), /confirmation timeout/);
    assert.equal(starts, 0);
  });
  it('does not report scheduled success when Spotify accepted play but playback is not confirmed', async () => {
    const playlistId = 'ABCDEFGHIJKLMNOPQRSTUV'; let reads = 0; let starts = 0;
    await assert.rejects(startScheduledPlayback({
      playlistId,
      getPlayback: async () => ++reads === 1 ? ({ actions: { disallows: {} } }) : ({ is_playing: false, context: { uri: `spotify:playlist:${playlistId}` } }),
      getDevices: async () => [{ id: 'active-device', is_active: true, is_restricted: false }],
      transfer: async () => {},
      play: async () => { starts++; },
      transitionTimeoutMs: 0,
    }), /playback could not be confirmed as started/);
    assert.equal(starts, 1);
    assert.equal(reads, 2);
  });
  it('logs all requested device diagnostics without exposing raw device IDs', () => {
    const sanitized = sanitizeSpotifyDevices([{ id: 'private-device-id', name: 'Desktop\nPlayer', type: 'computer', is_active: false, is_restricted: false, is_private_session: true }]);
    assert.deepEqual(sanitized, [{ device_id_present: true, name: 'Desktop Player', type: 'computer', is_active: false, is_restricted: false, is_private_session: true }]);
    assert.equal(JSON.stringify(sanitized).includes('private-device-id'), false);
  });
  it('rejects invalid playlist IDs before device transfer or start', async () => {
    let requests = 0;
    await assert.rejects(startScheduledPlayback({ playlistId: 'not-a-spotify-id', getPlayback: async () => { requests++; return null; }, getDevices: async () => [], transfer: async () => { requests++; }, play: async () => { requests++; } }), /invalid Spotify playlist ID/);
    assert.equal(requests, 0);
  });
  it('does not attempt playback on a restricted active device or when playback disallows it', async () => {
    let attempts = 0;
    const common = { playlistId: 'ABCDEFGHIJKLMNOPQRSTUV', getPlayback: async () => ({ actions: { disallows: {} } }), transfer: async () => {}, play: async () => { attempts++; } };
    await assert.rejects(startScheduledPlayback({ ...common, getDevices: async () => [{ id: 'restricted', is_active: true, is_restricted: true, name: 'TV' }] }), /restricted/);
    await assert.rejects(startScheduledPlayback({ ...common, getPlayback: async () => ({ actions: { disallows: { interrupting_playback: true } } }), getDevices: async () => [{ id: 'active', is_active: true, is_restricted: false }] }), /does not allow/);
    assert.equal(attempts, 0);
  });
  it('reports missing playback authorization scopes', () => {
    assert.deepEqual(missingPlaybackScopes('user-read-playback-state'), ['user-modify-playback-state']);
    assert.deepEqual(missingPlaybackScopes('user-read-playback-state user-modify-playback-state'), []);
  });
  it('handles Spotify 204 and empty success responses without JSON parsing', async () => {
    assert.equal(await readSpotifyResponse(new Response(null, { status: 204 })), null);
    assert.equal(await readSpotifyResponse(new Response('', { status: 200 })), null);
  });
  it('parses valid Spotify JSON responses', async () => {
    assert.deepEqual(await readSpotifyResponse(new Response('{"is_playing":true}', { status: 200, headers: { 'content-type': 'application/json' } })), { is_playing: true });
  });
  it('preserves plain-text details and HTTP status for common Spotify errors', async () => {
    for (const [status, detail] of [[401, 'expired'], [403, 'restricted'], [404, 'missing device'], [429, 'slow down']]) {
      const response = new Response(detail, { status, headers: { 'retry-after': '19' } });
      await assert.rejects(readSpotifyResponse(response), error => error.message.includes(String(status)) && error.message.includes(detail));
    }
    await assert.rejects(readSpotifyResponse(new Response('slow down', { status: 429, headers: { 'retry-after': '19' } })), /19 seconds/);
  });
  it('refreshes once after 401, accepts a 204 playback command, and does not retry repeatedly', async () => {
    let attempts = 0, refreshes = 0;
    const ok = await requestSpotifyApi({ method: 'POST', endpoint: '/me/player/next?device_id=d', getAccessToken: async () => 'old', refreshAccessToken: async () => { refreshes++; return 'fresh'; }, fetcher: async () => { attempts++; return attempts === 1 ? new Response('expired', { status: 401 }) : new Response(null, { status: 204 }); } });
    assert.equal(ok, null);
    assert.equal(attempts, 2);
    assert.equal(refreshes, 1);
    attempts = 0;
    await assert.rejects(requestSpotifyApi({ method: 'PUT', endpoint: '/me/player/play', getAccessToken: async () => 'old', refreshAccessToken: async () => { refreshes++; return 'fresh'; }, fetcher: async () => { attempts++; return new Response('still unauthorized', { status: 401 }); } }), /401/);
    assert.equal(attempts, 2);
  });
  it('reports network failures and timeout errors clearly', async () => {
    await assert.rejects(requestSpotifyApi({ method: 'PUT', endpoint: '/me/player/pause', getAccessToken: async () => 'x', refreshAccessToken: async () => 'y', fetcher: async () => { throw new TypeError('offline'); } }), /network request failed.*offline/);
    await assert.rejects(requestSpotifyApi({ method: 'PUT', endpoint: '/me/player/pause', getAccessToken: async () => 'x', refreshAccessToken: async () => 'y', fetcher: async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; } }), /request timed out/);
  });
  it('sends real playback controls and reports a rejected command', async () => {
    const command = playbackCommand('previous', 'd');
    assert.equal(await requestSpotifyApi({ ...command, getAccessToken: async () => 'x', refreshAccessToken: async () => 'y', fetcher: async (_url, init) => { assert.equal(init.method, 'POST'); return new Response(null, { status: 204 }); } }), null);
    await assert.rejects(requestSpotifyApi({ ...playbackCommand('play', 'd'), getAccessToken: async () => 'x', refreshAccessToken: async () => 'y', fetcher: async () => new Response('{"error":{"message":"device is restricted"}}', { status: 403 }) }), /403.*device is restricted/);
  });
  it('parses a valid secure token and reports malformed JSON without exposing credential text', () => {
    assert.deepEqual(parseSecureToken('{"access_token":"test-access"}'), { access_token: 'test-access' });
    assert.throws(() => parseSecureToken('mPnZCqyW4'), /not valid token JSON/);
    assert.throws(() => parseSecureToken('mPnZCqyW4'), error => !error.message.includes('mPnZCqyW4'));
  });
  it('uses Spotify playback endpoints and methods with the active device id', () => {
    assert.deepEqual(playbackCommand('play', 'device 1'), { method: 'PUT', endpoint: '/me/player/play?device_id=device%201' });
    assert.deepEqual(playbackCommand('pause', 'd'), { method: 'PUT', endpoint: '/me/player/pause?device_id=d' });
    assert.deepEqual(playbackCommand('previous', 'd'), { method: 'POST', endpoint: '/me/player/previous?device_id=d' });
    assert.deepEqual(playbackCommand('next', 'd'), { method: 'POST', endpoint: '/me/player/next?device_id=d' });
    assert.deepEqual(transferPlaybackCommand('device 1'), { method: 'PUT', endpoint: '/me/player', body: { device_ids: ['device 1'], play: false } });
    assert.deepEqual(playlistPlaybackCommand('spotify:playlist:ABCDEFGHIJKLMNOPQRSTUV', 'device 1'), { method: 'PUT', endpoint: '/me/player/play?device_id=device%201', body: { context_uri: 'spotify:playlist:ABCDEFGHIJKLMNOPQRSTUV' } });
    assert.throws(() => playlistPlaybackCommand('spotify:playlist:bad', 'device'), /Invalid Spotify playlist URI/);
    assert.equal(activeDeviceId(null, [{ id: 'inactive', is_active: false }]), null);
    assert.equal(activeDeviceId(null, [{ id: 'active', is_active: true }]), 'active');
    assert.equal(activeDeviceId(null, [{ id: 'restricted', is_active: true, is_restricted: true }]), null);
  });
  it('accepts a one-time local callback with the matching state', () => {
    assert.deepEqual(validateOAuthCallback('http://127.0.0.1:43821/callback?code=abc&state=xyz', 'http://127.0.0.1:43821/callback', 'xyz'), { code: 'abc' });
  });
  it('rejects a mismatched state and a callback from another origin', () => {
    assert.throws(() => validateOAuthCallback('http://127.0.0.1:43821/callback?code=abc&state=bad', 'http://127.0.0.1:43821/callback', 'xyz'), /state did not match/);
    assert.throws(() => validateOAuthCallback('http://127.0.0.2:43821/callback?code=abc&state=xyz', 'http://127.0.0.1:43821/callback', 'xyz'), /expected local redirect/);
  });
  it('explains Spotify rate limits using Retry-After', () => assert.match(spotifyHttpError(429, '17'), /17 seconds/));
});
