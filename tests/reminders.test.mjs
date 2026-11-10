// Reminders, the .ics export, the bell toggle and the 画卷 additions (weekly brief, model weighing, leave note).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { dueReminders, icsCalendar, reminderTargets, reminderText, upcomingCount } from '../reminders.js';
import { ringKeyframes, passOffset, createBellToggle } from '../bell-toggle.js';
import { calendarItems, calendarMarkup, conflictKey, weeklyBrief } from '../calendar.js';

const T = iso => Date.parse(iso);
const snapshot = {
  tasks: [
    { id: 't1', title: '课程报告', deadline_at: '2026-11-12T23:59:00+08:00', status: 'active', location: null },
    { id: 't2', title: '已交的作业', deadline_at: '2026-11-12T12:00:00+08:00', status: 'completed' },
    { id: 't3', title: '没写截止', deadline_at: null, status: 'active' },
  ],
  events: [
    { id: 'e1', kind: 'temporary', title: '学术讲座', start_at: '2026-11-11T09:00:00+08:00', end_at: '2026-11-11T10:30:00+08:00', location: '主楼报告厅', status: 'active' },
    { id: 'e2', kind: 'appointment', title: '和朋友去公园', start_at: '2026-11-14T14:00:00+08:00', end_at: null, location: null, status: 'active' },
    { id: 'e3', kind: 'temporary', title: '取消的面试', start_at: '2026-11-11T15:00:00+08:00', end_at: null, status: 'cancelled' },
    { id: 'e4', kind: 'temporary', title: '过去的事', start_at: '2026-11-01T15:00:00+08:00', end_at: null, status: 'active' },
  ],
};

test('targets are future, active deadlines and starts, in time order', () => {
  const targets = reminderTargets(snapshot, T('2026-11-10T08:00:00+08:00'));
  assert.deepEqual(targets.map(target => [target.id, target.kind]), [['e1', 'event'], ['t1', 'deadline'], ['e2', 'appointment']]);
});

test('a reminder is due once its lead starts, until the moment passes, and only once', () => {
  const fired = new Set();
  assert.deepEqual(dueReminders(snapshot, { now: T('2026-11-11T08:29:00+08:00'), lead: 30, fired }), []);
  const due = dueReminders(snapshot, { now: T('2026-11-11T08:30:00+08:00'), lead: 30, fired });
  assert.deepEqual(due.map(item => [item.id, item.minutesLeft]), [['e1', 30]]);
  fired.add(due[0].key);
  assert.deepEqual(dueReminders(snapshot, { now: T('2026-11-11T08:40:00+08:00'), lead: 30, fired }), []);
  // opened late, still before the start: one reminder with the time left
  assert.equal(dueReminders(snapshot, { now: T('2026-11-11T08:50:00+08:00'), lead: 60 })[0].minutesLeft, 10);
  assert.deepEqual(dueReminders(snapshot, { now: T('2026-11-11T09:01:00+08:00'), lead: 60 }), []);
  assert.equal(upcomingCount(snapshot, T('2026-11-11T00:00:00+08:00')), 1);
});

test('reminder text says what, how long and where', () => {
  const [due] = dueReminders(snapshot, { now: T('2026-11-11T08:00:00+08:00'), lead: 60 });
  assert.deepEqual(reminderText(due), { title: '学术讲座 · 还有 1 小时开始', body: '09:00 开始 · 主楼报告厅' });
  const [deadline] = dueReminders(snapshot, { now: T('2026-11-12T23:29:00+08:00'), lead: 30 });
  assert.equal(reminderText(deadline).title, '课程报告 · 还有 30 分钟截止');
});

test('the .ics file carries every target with an alarm before it, folded and escaped', () => {
  const { text, count } = icsCalendar(snapshot, { now: T('2026-11-10T08:00:00+08:00'), lead: 60 });
  assert.equal(count, 3);
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.endsWith('END:VCALENDAR\r\n'));
  assert.equal(text.match(/BEGIN:VEVENT/g).length, 3);
  assert.match(text, /DTSTART:20261111T010000Z\r\nDTEND:20261111T023000Z\r\nSUMMARY:点墨｜学术讲座/);
  assert.match(text, /SUMMARY:截止｜课程报告[\s\S]*?TRIGGER;RELATED=END:-PT60M/);
  assert.match(text, /SUMMARY:约定｜和朋友去公园\r\nDESCRIPTION:结束时间未定，先按1小时占位。/);
  const odd = icsCalendar({ tasks: [], events: [{ id: 'x', kind: 'temporary', title: 'A,B;C\n第二行', start_at: '2026-11-11T09:00:00+08:00', end_at: null, status: 'active' }] }, { now: T('2026-11-10T08:00:00+08:00'), lead: 30 });
  assert.match(odd.text, /SUMMARY:点墨｜A\\,B\\;C\\n第二行/);
  assert.match(text, /TRIGGER:-PT60M/);
  for (const line of text.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test('the bell keeps the React Bits ring curve and toggles, badges and labels in plain DOM', () => {
  const frames = ringKeyframes(0, 17, 5, 1);
  assert.equal(frames.length, 7);
  assert.equal(frames[1].transform, 'rotate(-17.00deg)');
  assert.equal(frames[2].transform, 'rotate(13.60deg)');
  assert.ok(passOffset(0, 5) > 0 && passOffset(4, 5) < 1);
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    const changes = [];
    const bell = createBellToggle({ offLabel: '提醒我', onLabel: '已开启提醒', onChange: value => changes.push(value) });
    dom.window.document.body.append(bell.element);
    const button = bell.element.querySelector('button');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    button.click();
    assert.deepEqual(changes, [true]);
    assert.equal(bell.element.dataset.on, 'true');
    bell.setCount(12);
    assert.equal(bell.element.querySelector('.bell-toggle__digit').textContent, '9+');
    assert.ok(bell.element.querySelector('.bell-toggle__badge').hasAttribute('data-show'));
    bell.setPressed(false);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.ok(!bell.element.querySelector('.bell-toggle__badge').hasAttribute('data-show'), 'the badge only shows while on');
  } finally { Object.assign(globalThis, saved); dom.window.close(); }
});

const { result } = JSON.parse(readFileSync(new URL('./fixtures/calendar-v3.json', import.meta.url), 'utf8'));
const monday = T('2026-11-09T00:00:00+08:00');

test('the weekly brief names the fullest day and what is due soon', () => {
  const lines = weeklyBrief(calendarItems(result), monday, T('2026-11-09T07:00:00+08:00'));
  assert.ok(lines.length >= 1);
  assert.match(lines[0], /最满的一天是<b>周.<\/b>/);
  const html = calendarMarkup({ result, start: monday, now: T('2026-11-09T07:00:00+08:00') });
  assert.match(html, /class="cal-brief"/);
  assert.match(html, /class="cal-remind-slot"/);
});

test('each 叠墨 offers 请模型权衡, then shows the model view and marks its pick; a skipped class gets a note', () => {
  const conflict = result.conflicts[0];
  const key = conflictKey(conflict);
  let html = calendarMarkup({ result, start: monday, now: monday });
  assert.ok(html.includes(`data-weigh="${key}"`));
  html = calendarMarkup({ result, start: monday, now: monday, weighs: { [key]: { pick: 1, reason: '讲座只此一次。' } } });
  assert.match(html, /模型之见<\/strong>讲座只此一次。/);
  assert.match(html, /is-model-pick" data-strategy="c1:1"/);
  assert.ok(!html.includes('data-weigh='));
  html = calendarMarkup({ result, start: monday, now: monday, undo: '这次不上「高等数学」', note: '老师您好，<我>' });
  assert.match(html, /<textarea id="leaveNote"[^>]*>老师您好，&lt;我&gt;<\/textarea>/);
  assert.match(html, /data-copy-note/);
});
