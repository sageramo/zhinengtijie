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

/** A calendar file of the coming deadlines and starts, each with an alarm `lead` minutes before. */
export function icsCalendar(snapshot, { now, lead }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sixu Marshal//知所先后//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:司序 · 截止与点墨'];
  const targets = reminderTargets(snapshot, now).filter(target => target.at <= now + ICS_HORIZON_DAYS * DAY);
  for (const target of targets) {
    const deadline = target.kind === 'deadline';
    const end = deadline ? target.at : target.end || target.at + 60 * MINUTE;
    const summary = deadline ? `截止｜${target.title}` : `${target.kind === 'appointment' ? '约定' : '点墨'}｜${target.title}`;
    lines.push('BEGIN:VEVENT', `UID:${target.id}-${target.at}@sixu.marshal`, `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(deadline ? target.at - 15 * MINUTE : target.at)}`, `DTEND:${stamp(end)}`, `SUMMARY:${escapeText(summary)}`);
    if (target.location) lines.push(`LOCATION:${escapeText(target.location)}`);
    if (!deadline && !target.end) lines.push(`DESCRIPTION:${escapeText('结束时间未定，先按1小时占位。')}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`${target.title} · ${deadline ? '截止' : '开始'}前${lead}分钟`)}`, deadline ? `TRIGGER;RELATED=END:-PT${lead}M` : `TRIGGER:-PT${lead}M`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { text: `${lines.map(fold).join('\r\n')}\r\n`, count: targets.length };
}
