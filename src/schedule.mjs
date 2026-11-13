const dayIndex = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const minute = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
/** Detects recurring weekly overlaps, including overnight and Sunday→Monday intervals. */
export function schedulesConflict(a, b) {
  if (!a.enabled || !b.enabled) return false;
  const week = 7 * 1440;
  for (const day of a.days) {
    const startA = dayIndex[day] * 1440 + minute(a.start);
    let endA = dayIndex[day] * 1440 + minute(a.end); if (endA <= startA) endA += 1440;
    for (const otherDay of b.days) {
      const startB = dayIndex[otherDay] * 1440 + minute(b.start);
      let endB = dayIndex[otherDay] * 1440 + minute(b.end); if (endB <= startB) endB += 1440;
      for (const shift of [-week, 0, week]) if (startA < endB + shift && startB + shift < endA) return true;
    }
  }
  return false;
}
export function validateSchedule(s) {
  if (s.date) {
    const parsed = new Date(`${s.date}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(parsed.getTime()) || localDateKey(parsed) !== s.date) return 'Select a valid specific date.';
    if (!['never', 'daily', 'weekly', 'monthly', 'yearly'].includes(s.repeat || 'never')) return 'Select a valid repeat option.';
  } else if (!s.days.length) return 'Select at least one day.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end)) return 'Enter valid 24-hour start and end times.';
  if (s.start === s.end) return 'Start and end times cannot be the same.';
  if (s.days.some(d => dayIndex[d] === undefined)) return 'Schedule contains an invalid day.';
  return null;
}

const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export function formatLocalDateTime(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${dayNames[date.getDay()]} ${pad(date.getDate())} ${monthNames[date.getMonth()]} ${date.getFullYear()} @ ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Resolve the next recurring schedule start using the computer's local zone rules. */
export function nextScheduledAction(schedules, now = new Date(), exceptions = []) {
  const candidates = [];
  for (const schedule of schedules || []) {
    if (!schedule.enabled) continue;
    const recurrenceHorizon = schedule.date ? ((schedule.repeat || 'never') === 'yearly' ? 1462 : (schedule.repeat || 'never') === 'monthly' ? 63 : (schedule.repeat || 'never') === 'never' ? 1 : 8) : 8;
    const anchorOffset = schedule.date ? Math.max(0, Math.ceil((new Date(`${schedule.date}T00:00:00`) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000)) : 0;
    const horizon = Math.min(36500, anchorOffset + recurrenceHorizon);
    for (let offset = 0; offset < horizon; offset++) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      if (schedule.dates && !schedule.dates.includes(localDateKey(date))) continue;
      const day = weekdayNames[date.getDay()];
      if (schedule.date) {
        const [y, m, d] = schedule.date.split('-').map(Number);
        const anchor = new Date(y, m - 1, d);
        const afterAnchor = date >= anchor;
        const repeat = schedule.repeat || 'never';
        const matches = repeat === 'never' ? localDateKey(date) === schedule.date
          : repeat === 'daily' ? afterAnchor
          : repeat === 'weekly' ? afterAnchor && date.getDay() === anchor.getDay()
          : repeat === 'monthly' ? afterAnchor && date.getDate() === d
          : afterAnchor && date.getMonth() === m - 1 && date.getDate() === d;
        if (!matches) continue;
      } else if (!schedule.days?.includes(day)) continue;
      const [hour, minute] = schedule.start.split(':').map(Number);
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
      const exception = exceptions.find(item => item.date === localDateKey(at) && item.scheduleId === schedule.id)
        || exceptions.find(item => item.date === localDateKey(at) && !item.scheduleId);
      if (at > now && !(exception?.type === 'skip' && !schedule.quiet)) {
        const effective = exception?.type === 'replace' && !schedule.quiet
          ? { ...schedule, playlistId: exception.playlistId, playlistName: exception.playlistName || 'Replacement playlist' }
          : schedule;
        candidates.push({ schedule: effective, at, boundary: 'start', exception: exception || null });
      }
      const [endHour, endMinute] = schedule.end.split(':').map(Number);
      const endAt = new Date(date.getFullYear(), date.getMonth(), date.getDate() + (schedule.end <= schedule.start ? 1 : 0), endHour, endMinute);
      if (endAt > now) candidates.push({ schedule: exception?.type === 'replace' && !schedule.quiet
        ? { ...schedule, playlistId: exception.playlistId, playlistName: exception.playlistName || 'Replacement playlist' }
        : schedule, at: endAt, boundary: 'end', exception: exception || null });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0] || null;
}

export function localDateKey(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** Returns recurring boundaries matching this PC-local minute. */
export function scheduleBoundariesAt(schedules, now) {
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = weekdayNames[now.getDay()];
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterday = weekdayNames[yesterdayDate.getDay()];
  const dateKey = localDateKey(now);
  const result = [];
  const matches = (date, time, dayOffset = 0) => { const [h, m] = time.split(':').map(Number); const target = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, h, m); return target.getFullYear() === now.getFullYear() && target.getMonth() === now.getMonth() && target.getDate() === now.getDate() && target.getHours() === now.getHours() && target.getMinutes() === now.getMinutes(); };
  for (const schedule of schedules || []) {
    if (!schedule.enabled) continue;
    if (schedule.days?.includes(today) && matches(now, schedule.start)) result.push({ schedule, boundary: 'start', key: `${schedule.id}:start:${dateKey}:${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
    const overnight = schedule.end <= schedule.start;
    if ((schedule.days?.includes(today) && !overnight || schedule.days?.includes(yesterday) && overnight) && matches(overnight ? yesterdayDate : now, schedule.end, overnight ? 1 : 0)) result.push({ schedule, boundary: 'end', key: `${schedule.id}:end:${dateKey}:${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
  }
  return result;
}
/** Quiet intervals use the schedule's start weekday and local wall-clock boundaries. */
export function activeQuietSchedules(schedules, now) {
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = weekdayNames[now.getDay()];
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterday = weekdayNames[yesterdayDate.getDay()];
  return (schedules || []).filter(s => {
    if (!s.enabled || !s.quiet) return false;
    const overnight = s.end <= s.start;
    const inside = (date, crosses) => { const [sh, sm] = s.start.split(':').map(Number), [eh, em] = s.end.split(':').map(Number); const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), sh, sm); const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + (crosses ? 1 : 0), eh, em); return now >= start && now < end; };
    return s.days?.includes(today) && inside(now, overnight) || overnight && s.days?.includes(yesterday) && inside(yesterdayDate, true);
  });
}
