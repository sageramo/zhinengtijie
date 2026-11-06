// Pure markup checks for the week calendar; no layout or visual verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, createTask, addTask, setAvailability } from '../task-state.js';
import { weekStart, calendarItems, calendarMarkup } from '../calendar.js';

const at = value => `2026-11-${value}:00+08:00`;
function sample() {
  let snapshot = createSnapshot({ referenceTime: at('04T18:00') });
  const prep = Object.assign(createTask('flexible'), { title: '准备材料', deadline_at: at('04T19:00'), remaining_minutes: 30 });
  const talk = Object.assign(createTask('fixed'), { title: '小组汇报', fixed_start_at: at('04T19:00'), fixed_end_at: at('04T20:00'), location: '主楼405' });
  const loose = Object.assign(createTask('fixed'), { title: '时间未定的讲座' });
  for (const task of [prep, talk, loose]) snapshot = addTask(snapshot, task);
  snapshot = setAvailability(snapshot, [{ start: at('04T18:00'), end: at('04T22:00') }]);
  const plan = { status: 'feasible_found', schedule: [{ task_id: prep.id, kind: 'work', start: at('04T18:00'), end: at('04T18:30') }, { task_id: talk.id, kind: 'fixed', start: at('04T19:00'), end: at('04T20:00') }] };
  return { snapshot, plan, prep, talk, loose };
}

test('weeks start on Monday 00:00 Beijing time', () => {
  // 2026-11-04 is a Wednesday; the week starts 2026-11-02 00:00 +08:00.
  assert.equal(weekStart(Date.parse(at('04T18:00'))), Date.parse(at('02T00:00')));
  assert.equal(weekStart(Date.parse('2026-11-01T17:00:00Z')), Date.parse(at('02T00:00')));
});

test('items come from free time, fixed activities, deadlines and planned work; the rest is pending', () => {
  const { snapshot, plan, prep, talk, loose } = sample();
  const { items, undated } = calendarItems(snapshot, plan);
  assert.deepEqual(items.map(item => item.type).sort(), ['deadline', 'fixed', 'free', 'work']);
  assert.equal(items.find(item => item.type === 'work').id, prep.id);
  assert.equal(items.find(item => item.type === 'fixed').id, talk.id);
  assert.deepEqual(undated.map(item => item.id), [loose.id]);
  // Without a plan, the flexible task waits under 待定 too.
  assert.deepEqual(calendarItems(snapshot, null).undated.map(item => item.id).sort(), [prep.id, loose.id].sort());
});

test('markup places each item in its day and links blocks to their tasks', () => {
  const { snapshot, plan, prep, talk, loose } = sample();
  const html = calendarMarkup({ snapshot, plan, start: weekStart(Date.parse(snapshot.reference_time)), now: Date.parse(at('04T18:45')) });
  assert.match(html, new RegExp(`class="cal-block cal-work[^"]*" data-cal-task="${prep.id}"`));
  assert.match(html, new RegExp(`class="cal-block cal-fixed[^"]*" data-cal-task="${talk.id}"`));
  assert.match(html, /class="cal-deadline"/);
  assert.match(html, /class="cal-free"/);
  assert.match(html, /class="cal-now"/);
  assert.match(html, new RegExp(`data-cal-task="${loose.id}"[^>]*><strong>时间未定的讲座`));
  assert.match(html, /11月2日 — 8日/);
});
