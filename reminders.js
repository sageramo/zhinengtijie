/**
 * Reminders before 截止 and before 点墨 / 约定 start. Pure functions of the list:
 * the page asks which reminders are due now (shown while it is open), and can write
 * an .ics calendar file whose alarms ring from the phone's own calendar app, so a
 * reminder still arrives when the page is closed. Nothing leaves the browser.
 */
const MINUTE = 60000;
const DAY = 86400000;
export const LEADS = [30, 60];
export const ICS_HORIZON_DAYS = 60;
const WEEKDAY_ICS = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const active = item => item.status === 'active' || item.status === undefined;
const at = iso => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/** Every future moment worth a reminder: task deadlines, and starts of 点墨 and 约定. */
export function reminderTargets(snapshot, now) {
  const targets = [];
  for (const task of snapshot.tasks || []) {
    const time = at(task.deadline_at);
    if (active(task) && Number.isFinite(time) && time > now) {
      targets.push({ id: task.id, kind: 'deadline', title: task.title || '未命名的事', at: time, location: task.location || null });
    }
  }
  for (const event of snapshot.events || []) {
    const time = at(event.start_at);
    if (active(event) && Number.isFinite(time) && time > now) {
      targets.push({ id: event.id, kind: event.kind === 'appointment' ? 'appointment' : 'event', title: event.title || '未命名的事', at: time,
        end: Number.isFinite(at(event.end_at)) ? at(event.end_at) : null, location: event.location || null });
    }
  }
  return targets.sort((a, b) => a.at - b.at);
}

/** One key per item, moment and lead, so an edited time or lead reminds again but a reload does not. */
export const reminderKey = (target, lead) => `${target.id}@${target.at}@${lead}`;

/** Reminders whose lead has started and whose moment has not passed, minus the ones already shown. */
export function dueReminders(snapshot, { now, lead, fired = new Set() }) {
  return reminderTargets(snapshot, now)
    .filter(target => target.at - lead * MINUTE <= now && !fired.has(reminderKey(target, lead)))
    .map(target => ({ ...target, key: reminderKey(target, lead), minutesLeft: Math.max(1, Math.round((target.at - now) / MINUTE)) }));
}

/** How many reminders fall in the next 24 hours: the number on the bell. */
export const upcomingCount = (snapshot, now) => reminderTargets(snapshot, now).filter(target => target.at <= now + DAY).length;

const KIND_TEXT = { deadline: '截止', event: '开始', appointment: '开始' };
const clock = time => new Date(time + 8 * 3600000).toISOString().slice(11, 16);
export function reminderText(reminder) {
  const left = reminder.minutesLeft >= 60 && reminder.minutesLeft % 60 === 0 ? `${reminder.minutesLeft / 60} 小时` : `${reminder.minutesLeft} 分钟`;
  const verb = KIND_TEXT[reminder.kind];
  return {
    title: `${reminder.title} · 还有 ${left}${verb}`,
    body: `${clock(reminder.at)} ${verb}${reminder.location ? ` · ${reminder.location}` : ''}`,
  };
}

// ---- .ics ------------------------------------------------------------------
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escapeText = value => String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, match => `\\${match}`);
const encoder = new TextEncoder();
/** RFC 5545 folds lines longer than 75 octets; Chinese takes three octets a character, so fold by bytes. */
function fold(line) {
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > (parts.length ? 74 : 75)) { parts.push(current); current = ''; bytes = 0; }
    current += character;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const bjStamp = (dateStr, hhmm) => {
  if (hhmm === '24:00') {
    const nextMs = Date.parse(`${dateStr}T00:00:00+08:00`) + DAY;
    return `${new Date(nextMs + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '')}T000000`;
  }
  return `${dateStr.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
};

function firstRoutineDate(routine) {
  if (!routine?.from || !Array.isArray(routine.weekdays) || !routine.weekdays.length) return null;
  const startMs = Date.parse(`${routine.from}T00:00:00+08:00`);
  if (!Number.isFinite(startMs)) return null;
  const want = new Set(routine.weekdays);
  for (let offset = 0; offset < 7; offset += 1) {
    const dayMs = startMs + offset * DAY;
    const bj = new Date(dayMs + 8 * 3600000);
    const isoDay = ((bj.getUTCDay() + 6) % 7) + 1;
    if (want.has(isoDay)) {
      const firstDate = bj.toISOString().slice(0, 10);
      if (routine.until && firstDate > routine.until) return null;
      return firstDate;
    }
  }
  return null;
}

/** A calendar file of deadlines, events, and optionally weekly routines + solved work blocks, each with an alarm. */
export function icsCalendar(snapshot, { now, lead, calendarResult = null, includeRoutines = false, includeWork = false }) {
  const full = Boolean(includeRoutines || includeWork);
  const routines = includeRoutines ? (snapshot.routines || []).map(routine => ({ routine, firstDate: firstRoutineDate(routine) })).filter(entry => entry.firstDate) : [];
  const workBlocks = includeWork ? (calendarResult?.layers?.work || []).filter(block => {
    const s = Date.parse(block.start);
    const e = Date.parse(block.end);
    return Number.isFinite(s) && Number.isFinite(e) && e > s && e > now;
  }) : [];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sixu Marshal//知所先后//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${full ? '司序 · 完整日程' : '司序 · 截止与点墨'}`,
  ];
  if (routines.length) {
    lines.push(
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Shanghai',
      'X-LIC-LOCATION:Asia/Shanghai',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0800',
      'TZOFFSETTO:+0800',
      'TZNAME:CST',
      'DTSTART:19700101T000000',
      'END:STANDARD',
      'END:VTIMEZONE',
    );
  }
  const targets = reminderTargets(snapshot, now).filter(target => target.at <= now + ICS_HORIZON_DAYS * DAY);
  let deadlines = 0;
  let events = 0;
  for (const target of targets) {
    const deadline = target.kind === 'deadline';
    if (deadline) deadlines += 1;
    else events += 1;
    const end = deadline ? target.at : target.end || target.at + 60 * MINUTE;
    const summary = deadline ? `截止｜${target.title}` : `${target.kind === 'appointment' ? '约定' : '点墨'}｜${target.title}`;
    lines.push('BEGIN:VEVENT', `UID:${target.id}-${target.at}@sixu.marshal`, `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(deadline ? target.at - 15 * MINUTE : target.at)}`, `DTEND:${stamp(end)}`, `SUMMARY:${escapeText(summary)}`);
    if (target.location) lines.push(`LOCATION:${escapeText(target.location)}`);
    if (!deadline && !target.end) lines.push(`DESCRIPTION:${escapeText('结束时间未定，先按1小时占位。')}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`${target.title} · ${deadline ? '截止' : '开始'}前${lead}分钟`)}`, deadline ? `TRIGGER;RELATED=END:-PT${lead}M` : `TRIGGER:-PT${lead}M`, 'END:VALARM', 'END:VEVENT');
  }
  for (const { routine, firstDate } of routines) {
    const byDay = [...new Set(routine.weekdays)].sort((a, b) => a - b).map(day => WEEKDAY_ICS[day]).filter(Boolean).join(',');
    const interval = routine.week_interval === 2 ? 2 : 1;
    let rrule = `RRULE:FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${byDay};WKST=MO`;
    if (routine.until) rrule += `;UNTIL=${stamp(Date.parse(`${routine.until}T23:59:59+08:00`))}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:routine-${routine.id}@sixu.marshal`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;TZID=Asia/Shanghai:${bjStamp(firstDate, routine.start)}`,
      `DTEND;TZID=Asia/Shanghai:${bjStamp(firstDate, routine.end)}`,
      rrule,
    );
    const skips = (routine.skip_dates || []).filter(dateStr => /^\d{4}-\d{2}-\d{2}$/.test(dateStr));
    if (skips.length) lines.push(`EXDATE;TZID=Asia/Shanghai:${skips.map(dateStr => bjStamp(dateStr, routine.start)).join(',')}`);
    lines.push(`SUMMARY:${escapeText(`底色｜${routine.title}`)}`);
    if (routine.location) lines.push(`LOCATION:${escapeText(routine.location)}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`${routine.title} · 上课/例行前${lead}分钟`)}`, `TRIGGER:-PT${lead}M`, 'END:VALARM', 'END:VEVENT');
  }
  for (const block of workBlocks) {
    const startMs = Date.parse(block.start);
    const endMs = Date.parse(block.end);
    const title = block.title || '待办事项';
    const desc = block.deadline_at ? `司序已校验排期 · 截止 ${block.deadline_at.slice(0, 16).replace('T', ' ')}` : '司序已校验排期';
    lines.push(
      'BEGIN:VEVENT',
      `UID:work-${block.task_id || 'task'}-${startMs}@sixu.marshal`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(startMs)}`,
      `DTEND:${stamp(endMs)}`,
      `SUMMARY:${escapeText(`落笔｜${title}`)}`,
      `DESCRIPTION:${escapeText(desc)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(`${title} · 排期开始前${lead}分钟`)}`,
      `TRIGGER:-PT${lead}M`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  const count = deadlines + events + routines.length + workBlocks.length;
  return {
    text: `${lines.map(fold).join('\r\n')}\r\n`,
    count,
    breakdown: { deadlines, events, routines: routines.length, work: workBlocks.length },
  };
}
