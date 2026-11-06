// Pure markup checks for the four-layer week calendar; no layout or visual verification.
// The fixture is real /api/v3/calendar output from the backend, so both sides share one contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weekStart, weekRange, calendarItems, calendarMarkup } from '../calendar.js';

const { result } = JSON.parse(readFileSync(new URL('./fixtures/calendar-v3.json', import.meta.url), 'utf8'));
const monday = Date.parse('2026-11-09T00:00:00+08:00');

test('weeks start on Monday 00:00 Beijing time and map to the API range', () => {
  assert.equal(weekStart(Date.parse('2026-11-11T18:00:00+08:00')), monday);
  assert.equal(weekStart(Date.parse('2026-11-08T17:00:00Z')), monday);
  assert.deepEqual(weekRange(monday), { from: '2026-11-09', to: '2026-11-15' });
});

test('items come from the four layers and markers; conflicting items are flagged', () => {
  const items = calendarItems(result);
  const types = new Set(items.map(item => item.type));
  for (const type of ['free', 'routine', 'temporary', 'appointment', 'work', 'deadline', 'start']) assert.ok(types.has(type), type);
  assert.ok(items.find(item => item.type === 'temporary' && item.id === 'e1').conflict);
  assert.ok(items.find(item => item.type === 'routine' && item.key === 'r1@2026-11-09').conflict);
  assert.equal(items.find(item => item.type === 'routine' && item.key === 'r1@2026-11-11').conflict, false);
  assert.deepEqual(calendarItems(null), []);
});

test('markup draws each layer, links blocks to their entries and lists conflicts and undefined items', () => {
  const html = calendarMarkup({ result, start: monday, now: Date.parse('2026-11-09T10:00:00+08:00') });
  assert.match(html, /class="cal-block cal-routine[^"]*is-conflict" data-cal-item="r1" data-cal-layer="routine"/);
  assert.match(html, /class="cal-block cal-temporary[^"]*is-conflict" data-cal-item="e1" data-cal-layer="event"/);
  assert.match(html, /class="cal-block cal-work[^"]*" data-cal-item="t1" data-cal-layer="task"/);
  assert.match(html, /class="cal-deadline[^"]*" data-cal-item="t2"/);
  assert.match(html, /class="cal-deadline is-start" data-cal-item="e2"/);
  assert.match(html, /class="cal-free" data-cal-goto="time"/);
  assert.match(html, /class="cal-now"/);
  assert.match(html, /class="cal-block cal-appointment[^"]*" data-cal-item="a1" data-cal-layer="event"/);
  assert.match(html, /叠墨 · 对策 <span>1<\/span>/);
  assert.match(html, /点墨压在底色上<\/strong><span>11月9日 周一 · 40分钟/);
  assert.match(html, /待书 <span>2<\/span>/);
  assert.match(html, /预计用时未定义/);
  assert.match(html, /落笔 · 约定与截止之事/);
  assert.match(html, /留白 · 自己支配/);
  assert.match(html, /11月9日 — 15日/);
});

test('loading, error and no-result states are explained', () => {
  assert.match(calendarMarkup({ result: null, start: monday, now: monday, loading: true }), /正在计算这一周/);
  assert.match(calendarMarkup({ result: null, start: monday, now: monday, error: '连接失败' }), /连接失败/);
  assert.match(calendarMarkup({ result: null, start: monday, now: monday }), /计算完成后/);
});

test('titles are escaped', () => {
  const unsafe = structuredClone(result);
  unsafe.layers.temporary[0].title = '<img src=x>';
  assert.doesNotMatch(calendarMarkup({ result: unsafe, start: monday, now: monday }), /<img src=x>/);
});

test('a deadline just before midnight does not stretch the next day to 00:00', () => {
  const late = structuredClone(result);
  late.markers = [{ type: 'deadline', id: 't1', title: '课程报告', at: '2026-11-13T23:59:00+08:00', state: 'scheduled' }];
  const html = calendarMarkup({ result: late, start: monday, now: monday });
  assert.doesNotMatch(html, />00:00</);
  assert.match(html, />08:00</);
});

test('each conflict shows its overlap picture, rule advice and one-click strategies, recommended first', () => {
  const html = calendarMarkup({ result, start: monday, now: monday, undo: '这次不上「高等数学」' });
  assert.match(html, /class="cx-card" data-conflict-keys="e1 r1@2026-11-09"/);
  assert.match(html, /class="cx-overlap"/);
  assert.match(html, /重叠 09:00–09:40/);
  assert.match(html, /缺一次的代价通常更小/);
  assert.match(html, /class="cx-option is-recommended" data-strategy="c1:0"[^>]*><span class="cx-option-label"><em>推荐<\/em>这次不上「高等数学」/);
  assert.match(html, /data-strategy="c1:1"/);
  assert.match(html, /已采用：这次不上「高等数学」<button[^>]*data-strategy-undo/);
  assert.match(html, /data-cal-key="r1@2026-11-09"/);
});

test('work shortage pictures need against free time; a clean week says so', () => {
  const short = structuredClone(result);
  short.conflicts = [{ id: 'c1', type: 'work_shortage', layers: ['work'], items: [{ layer: 'work', id: 't1', title: '课程报告' }], start: null, end: '2026-11-10T23:59:00+08:00', minutes: 30, reason: '差', advice: '补留白', strategies: [] }];
  short.tasks = [{ id: 't1', state: 'short', estimate_minutes: 120, scheduled_minutes: 0, assumptions: [] }];
  const html = calendarMarkup({ result: short, start: monday, now: monday });
  assert.match(html, /需要 2小时/);
  assert.match(html, /差 30分钟/);
  const clean = structuredClone(result);
  clean.conflicts = [];
  assert.match(calendarMarkup({ result: clean, start: monday, now: monday }), /这一卷是干净的/);
});

test('a week with 叠墨 never claims to be clear', () => {
  assert.doesNotMatch(calendarMarkup({ result, start: monday, now: monday }), /没有叠墨/);
});
