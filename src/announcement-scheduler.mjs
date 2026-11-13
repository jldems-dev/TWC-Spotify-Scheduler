const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number), date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};
function occursOn(schedule, date) {
  if (!schedule.date) return schedule.days?.includes(weekdays[date.getDay()]);
  if (!validDate(schedule.date)) return false;
  const [year, month, day] = schedule.date.split('-').map(Number), anchor = new Date(year, month - 1, day);
  if ((schedule.repeat || 'never') === 'yearly') return date >= anchor && date.getMonth() === month - 1 && date.getDate() === day;
  return dateKey(date) === schedule.date;
}
export function announcementEventsAt(schedules, now) {
  const day = weekdays[now.getDay()], date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  return (schedules || []).filter(s => s.enabled).flatMap(s => {
    if (s.date) return occursOn(s, now) && s.time === time ? [{ schedule: s, boundary: 'start', custom: true, audioId: s.announcementId, key: `${s.id}:start:${date}:${time}` }] : [];
    if (!s.days?.includes(day)) return [];
    return [
      ...(s.start === time ? [{ schedule: s, boundary: 'start', audioId: s.firstAnnouncementId, key: `${s.id}:start:${date}:${time}` }] : []),
      ...(s.end === time ? [{ schedule: s, boundary: 'end', audioId: s.secondAnnouncementId, key: `${s.id}:end:${date}:${time}` }] : []),
    ];
  });
}
export function announcementWindowActive(schedules, now) {
  const mins = now.getHours()*60+now.getMinutes();
  return (schedules || []).some(s => !s.date && s.enabled && s.days?.includes(weekdays[now.getDay()]) && mins >= Number(s.start?.slice(0,2))*60+Number(s.start?.slice(3)) && mins < Number(s.end?.slice(0,2))*60+Number(s.end?.slice(3)) && s.end > s.start);
}
export function validateAnnouncementSchedule(s) {
  if (!s.name?.trim()) return 'Enter a schedule name.';
  if (s.date) {
    if (!validDate(s.date)) return 'Select a valid announcement date.';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '')) return 'Enter a valid announcement time.';
    if (!s.announcementId) return 'Select an announcement audio track.';
    if (!['never', 'yearly'].includes(s.repeat || 'never')) return 'Select Never or Yearly repeat.';
    return null;
  }
  if (!s.days?.length) return 'Select at least one weekday.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end)) return 'Enter valid start and end times.';
  if (s.end <= s.start) return 'End time must be after start time.';
  if (!s.firstAnnouncementId || !s.secondAnnouncementId) return 'Select both announcement audio files.';
  return null;
}

export function saveAnnouncementSchedule(schedules, schedule) {
  const next = (schedules || []).filter(item => item.id !== schedule.id);
  return [...next, { ...schedule, days: [...(schedule.days || [])] }];
}
export function removeAnnouncementSchedule(schedules, id) { return (schedules || []).filter(item => item.id !== id); }
export function setAnnouncementScheduleEnabled(schedules, id, enabled) { return (schedules || []).map(item => item.id === id ? { ...item, enabled } : item); }
export function upcomingAnnouncementOccurrences(schedules, announcements, now = new Date(), daysAhead = 7) {
  const candidates = [];
  const horizon = Math.min(36500, Math.max(daysAhead, ...(schedules || []).map(schedule => {
    if (!schedule.date) return daysAhead;
    const anchor = new Date(`${schedule.date}T00:00:00`);
    const anchorOffset = Math.max(0, Math.ceil((anchor - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000));
    return anchorOffset + (schedule.repeat === 'yearly' ? 1462 : daysAhead);
  })));
  for (let offset = 0; offset <= horizon; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    for (const schedule of schedules || []) {
      if (!schedule.enabled || (schedule.date ? !occursOn(schedule, date) : !schedule.days?.includes(weekdays[date.getDay()]))) continue;
      const events = schedule.date ? [['start', schedule.time, schedule.announcementId]] : [['start', schedule.start, schedule.firstAnnouncementId], ['end', schedule.end, schedule.secondAnnouncementId]];
      for (const [boundary, time, audioId] of events) {
        const [hour, minute] = (time || '').split(':').map(Number);
        const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
        if (at <= now) continue;
        const audio = (announcements || []).find(item => item.id === audioId);
        candidates.push({ scheduleId: schedule.id, scheduleName: schedule.name, boundary, date: key, time, audioId, audioName: audio?.name || null, custom: !!schedule.date, at });
      }
    }
  }
  const items = [];
  for (const schedule of schedules || []) for (const boundary of ['start', 'end']) {
    const next = candidates.filter(item => item.scheduleId === schedule.id && item.boundary === boundary).sort((a, b) => a.at - b.at)[0];
    if (next) items.push(next);
  }
  return items.sort((a, b) => a.at - b.at);
}
