const weekdayMap = { MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed', THURSDAY: 'Thu', FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun' };
export const businessDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function normalizeBusinessTime(value) {
  const text = String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  let match = text.match(/^(\d{1,2})(?::([0-5]\d))?(?::00)?\s*(AM|PM)$/);
  let hour; let minute;
  if (match) {
    hour = Number(match[1]); minute = Number(match[2] || 0);
    if (hour < 1 || hour > 12) throw new Error(`Invalid time: ${value}`);
    hour = (hour % 12) + (match[3] === 'PM' ? 12 : 0);
  } else {
    match = text.match(/^(\d{1,2}):([0-5]\d)(?::00)?$/);
    if (!match) throw new Error(`Invalid time: ${value}`);
    hour = Number(match[1]); minute = Number(match[2]);
    if (hour > 23) throw new Error(`Invalid time: ${value}`);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
const apiTime = value => normalizeBusinessTime(`${value.hours || 0}:${String(value.minutes || 0).padStart(2, '0')}`);

function periodsToRows(periods = []) {
  return periods.flatMap(period => {
    const day = weekdayMap[period.openDay];
    if (!day || !period.openTime || !period.closeTime) return [];
    return [{ day, start: apiTime(period.openTime), end: apiTime(period.closeTime), overnight: !!(period.closeDay && period.closeDay !== period.openDay) }];
  });
}

export function parseBusinessHours(location) {
  if (!location?.regularHours || !Array.isArray(location.regularHours.periods)) throw new Error('Google did not provide regular business hours for this location. Check that hours are published and that your account can view them.');
  const regular = periodsToRows(location.regularHours.periods);
  const special = (location.specialHours?.specialHourPeriods || []).map(period => {
    const date = period.startDate && `${String(period.startDate.year).padStart(4, '0')}-${String(period.startDate.month).padStart(2, '0')}-${String(period.startDate.day).padStart(2, '0')}`;
    return { date, closed: !!period.closed, start: period.openTime ? apiTime(period.openTime) : null, end: period.closeTime ? apiTime(period.closeTime) : null, label: period.closed ? 'Closed (special hours)' : 'Special hours' };
  }).filter(period => period.date);
  return { regular, special, closedDays: businessDays.filter(day => !regular.some(period => period.day === day)) };
}

export function businessHoursPreview(hours) { return businessDays.map(day => ({ day, periods: hours.regular.filter(period => period.day === day) })); }

export function importHoursAsSchedules(hours, { playlistId, playlistName, existing = [], existingExceptions = [], locationName = 'Business Profile', locationId = 'default', sourceType = 'google' }) {
  if (!playlistId) throw new Error('Select a Spotify playlist before importing business hours.');
  const ownerPrefix = `${sourceType}:${locationId}:`;
  const legacy = sourceType === 'google' ? existing.filter(item => businessDays.some(day => item.googleSourceId?.startsWith(`google:${day}:`)) && item.name?.startsWith(locationName)) : [];
  const managed = existing.filter(item => item.googleSourceId?.startsWith(ownerPrefix) || legacy.includes(item));
  const preservedIds = new Set();
  const duplicateSchedules = [];
  let duplicates = Number(hours.duplicates) || 0;
  const grouped = new Map();
  for (const period of hours.regular || []) {
    if (!businessDays.includes(period.day)) throw new Error(`Invalid weekday: ${period.day}`);
    const start = normalizeBusinessTime(period.start); const end = normalizeBusinessTime(period.end);
    if (start === end) throw new Error(`Start and end times cannot be the same on ${period.day}.`);
    const key = `${start}|${end}`;
    if (!grouped.has(key)) grouped.set(key, { start, end, days: new Set() });
    const group = grouped.get(key);
    if (group.days.has(period.day)) duplicates++;
    group.days.add(period.day);
  }
  const regular = [...grouped.values()].map(group => {
    const selectedDays = businessDays.filter(day => group.days.has(day));
    const sourceId = `${ownerPrefix}weekly:${selectedDays.join('-')}:${group.start}:${group.end}`;
    const previous = managed.find(item => item.googleSourceId === sourceId)
      || legacy.find(item => selectedDays.some(day => item.days?.includes(day)));
    if (previous && previous.start === group.start && previous.end === group.end && businessDays.filter(day => previous.days?.includes(day)).join(',') === selectedDays.join(',') && previous.playlistId === playlistId) {
      preservedIds.add(previous.id); duplicateSchedules.push({ ...previous, isDuplicate: true }); duplicates++; return null;
    }
    return { id: previous?.id || `${sourceType}-${String(locationId).replace(/[^a-z0-9]/gi, '-')}-${selectedDays.join('-').toLowerCase()}-${group.start.replace(':', '')}-${group.end.replace(':', '')}`, googleSourceId: sourceId, name: `${locationName} · ${selectedDays.join(', ')}`, days: selectedDays, start: group.start, end: group.end, playlistId, playlistName, enabled: true, quiet: false };
  }).filter(Boolean);

  const special = (hours.special || []).map((period, index) => {
    const sourceId = `${ownerPrefix}special:${period.date}`;
    const previous = managed.find(item => item.googleSourceId === sourceId);
    const start = period.start ? normalizeBusinessTime(period.start) : null;
    const end = period.end ? normalizeBusinessTime(period.end) : null;
    const specialName = `${locationName} · ${period.name || `${period.date} special hours`}`;
    const previousExceptions = existingExceptions.filter(item => item.googleSourceId === sourceId && item.date === period.date);
    const date = new Date(`${period.date}T12:00:00`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== period.date) throw new Error(`Invalid holiday date: ${period.date}`);
    const day = businessDays[(date.getDay() + 6) % 7];
    const regularIds = [...new Set([...managed, ...regular].filter(item => item.googleSourceId?.startsWith(ownerPrefix) && item.days?.includes(day)).map(item => item.id))];
    const exceptionTargets = previousExceptions.map(item => item.scheduleId).filter(Boolean).sort();
    const sameExceptionTargets = exceptionTargets.length === regularIds.length && regularIds.slice().sort().every((id, position) => id === exceptionTargets[position]);
    const duplicateClosed = !!period.closed && previousExceptions.some(item => item.label === period.label);
    const duplicateOpen = !!previous && previous.start === start && previous.end === end && previous.playlistId === playlistId && previous.name === specialName;
    if (duplicateClosed || duplicateOpen) duplicates++;
    if (duplicateOpen) { preservedIds.add(previous.id); duplicateSchedules.push({ ...previous, isDuplicate: true }); }
    const targets = (duplicateClosed || duplicateOpen) && sameExceptionTargets ? [] : regularIds;
    return period.closed || !start || !end
      ? { sourceId, date: period.date, closed: true, duplicate: !!duplicateClosed, scheduleIds: targets, label: period.label || 'Closed (special hours)' }
      : { sourceId, schedule: { id: previous?.id || `${sourceType}-${String(locationId).replace(/[^a-z0-9]/gi, '-')}-special-${period.date}-${index}`, googleSourceId: sourceId, name: specialName, days: [day], dates: [period.date], start, end, playlistId, playlistName, enabled: true, quiet: false }, date: period.date, duplicate: !!duplicateOpen, scheduleIds: targets, label: period.label || 'Special hours' };
  }).filter(Boolean);
  const exceptions = special.flatMap(item => item.scheduleIds.map(scheduleId => ({ date: item.date, type: 'skip', scheduleId, googleSourceId: item.sourceId, label: item.label })));
  const schedules = [...regular, ...special.filter(item => item.schedule && !item.duplicate).map(item => item.schedule)];
  const replacements = managed.filter(item => !preservedIds.has(item.id)).map(item => item.id);
  return { schedules, previewSchedules: [...schedules, ...duplicateSchedules], special, exceptions, replacements, duplicates, ownerPrefix };
}

export function resolveGoogleImportPlan(plan, existingSchedules, existingExceptions, conflicts, resolutions) {
  if (conflicts.some(conflict => resolutions[conflict.id] !== 'keep' && resolutions[conflict.id] !== 'replace')) throw new Error('Resolve every schedule conflict before applying this import.');
  const keepExistingIds = new Set(conflicts.filter(item => resolutions[item.id] === 'keep').map(item => item.existingId));
  const keptDays = new Set(conflicts.filter(item => keepExistingIds.has(item.existingId)).map(item => `${item.sourceId}|${item.day}`));
  const removedIds = new Set(plan.replacements || []);
  for (const conflict of conflicts) if (!keepExistingIds.has(conflict.existingId)) removedIds.add(conflict.existingId);
  const accepted = plan.schedules.flatMap(item => {
    const itemConflicts = conflicts.filter(conflict => conflict.sourceId === item.googleSourceId);
    if (item.dates?.length) return itemConflicts.some(conflict => keptDays.has(`${item.googleSourceId}|${conflict.day}`)) ? [] : [item];
    const selectedDays = item.days.filter(day => !keptDays.has(`${item.googleSourceId}|${day}`));
    return selectedDays.length ? [{ ...item, days: selectedDays, ...(item.name ? { name: item.name.replace(/ · .+$/, ` · ${selectedDays.join(', ')}`) } : {}) }] : [];
  });
  const acceptedById = new Map(accepted.map(item => [item.id, item]));
  const schedules = [...existingSchedules.filter(item => !removedIds.has(item.id) && !acceptedById.has(item.id)), ...accepted];
  const acceptedIds = new Set(accepted.map(item => item.id));
  const exceptions = plan.exceptions.filter(item => item.scheduleId && (acceptedIds.has(item.scheduleId) || existingSchedules.some(schedule => schedule.id === item.scheduleId && !removedIds.has(schedule.id))));
  const exceptionKeys = new Set(exceptions.map(item => `${item.date}:${item.scheduleId || item.googleSourceId}`));
  return {
    schedules,
    exceptions: [...existingExceptions.filter(item => !exceptionKeys.has(`${item.date}:${item.scheduleId || item.googleSourceId}`)), ...exceptions],
    acceptedCount: accepted.length,
    exceptionCount: exceptions.length,
    skippedCount: keptDays.size,
  };
}

export const demoBusinessHours = { name: 'Demo Stafford Music Venue', regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 9 }, closeDay: 'MONDAY', closeTime: { hours: 17 } }, { openDay: 'TUESDAY', openTime: { hours: 9 }, closeDay: 'TUESDAY', closeTime: { hours: 17 } }, { openDay: 'WEDNESDAY', openTime: { hours: 9 }, closeDay: 'WEDNESDAY', closeTime: { hours: 17 } }, { openDay: 'THURSDAY', openTime: { hours: 9 }, closeDay: 'THURSDAY', closeTime: { hours: 17 } }, { openDay: 'FRIDAY', openTime: { hours: 9 }, closeDay: 'FRIDAY', closeTime: { hours: 17 } }, { openDay: 'SATURDAY', openTime: { hours: 10 }, closeDay: 'SATURDAY', closeTime: { hours: 14 } }] }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }] } };
