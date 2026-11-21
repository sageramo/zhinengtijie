// Pure markup checks for the four-layer week calendar; no layout or visual verification.
// The fixture is real /api/v3/calendar output from the backend, so both sides share one contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { weekStart, weekRange, calendarItems, calendarMarkup, conflictsInWeek, digestChanges, resultDigest } from '../calendar.js';

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
  assert.match(html, /点墨压在底色上<\/strong><span>11月9日 周一<\/span>/);
  // The card names both items and how long they overlap; the week hatches the same minutes.
  assert.match(html, /class="cx-headline"><b class="cx-who cx-who-temporary">讲座<\/b><span class="cx-and">与<\/span><b class="cx-who cx-who-routine">高等数学<\/b><span class="cx-verb">重叠 <strong>40分钟<\/strong><em>09:00–09:40<\/em>/);
  assert.match(html, /class="cal-overlap"[^>]*><span>叠 40分钟<\/span>/);
  assert.match(html, /待书 <span>2<\/span>/);
  assert.match(html, /预计用时未定义/);
  assert.match(html, /data-cal-focus="work" aria-pressed="false"><i aria-hidden="true"><\/i><strong>落笔<\/strong><span>约定与截止之事<\/span>/);
  assert.match(html, /data-cal-focus="free"[^>]*>.*<strong>留白<\/strong><span>自己支配的时间<\/span>/);
  assert.match(html, /点一层，只看这一层/);
  // 叠墨 comes before reminders in the side, so it is on screen when the scroll opens.
  assert.ok(html.indexOf('calConflictHeading') < html.indexOf('cal-remind-slot'));
  assert.match(html, /11月9日 — 15日/);
});

test('a chosen layer is shown alone and its button reads as pressed', () => {
  const html = calendarMarkup({ result, start: monday, now: monday, focus: 'routine' });
  assert.match(html, /class="cal-week[^"]*" data-focus="routine"/);
  assert.match(html, /data-cal-focus="routine" aria-pressed="true"/);
  assert.match(html, /再点一次，恢复全部图层/);
  assert.doesNotMatch(calendarMarkup({ result, start: monday, now: monday }), /data-focus=/);
});

test('after a strategy the side lists what the recalculation changed', () => {
  const now = Date.parse('2026-11-09T07:00:00+08:00');
  const before = resultDigest(result, monday, now);
  const after = structuredClone(result);
  after.conflicts = [];
  after.layers.temporary = after.layers.temporary.filter(item => item.id !== 'e1');
  const moved = after.layers.work[0];
  moved.start = new Date(Date.parse(moved.start) - 30 * 60000).toISOString();
  moved.end = new Date(Date.parse(moved.end) - 30 * 60000).toISOString();
  const changes = digestChanges(before, resultDigest(after, monday, now));
  assert.deepEqual(changes.find(change => change.kind === 'conflict'), { kind: 'conflict', label: '叠墨', before: '1 处', after: '0 处' });
  assert.equal(changes.find(change => change.kind === 'removed').after, '已划掉');
  assert.match(changes.find(change => change.kind === 'work').label, /^落笔「/);
  assert.deepEqual(digestChanges(before, before), []);
  const html = calendarMarkup({ result: after, start: monday, now, undo: '不去「讲座」', changes });
  assert.match(html, /采用后，画卷重算的变化/);
  assert.match(html, /<s>1 处<\/s><i aria-hidden="true">→<\/i><b>0 处<\/b>/);
});

test('loading, error and no-result states are explained', () => {
  assert.match(calendarMarkup({ result: null, start: monday, now: monday, loading: true }), /正在计算这一周/);
  assert.match(calendarMarkup({ result: null, start: monday, now: monday, error: '连接失败' }), /连接失败/);
  assert.match(calendarMarkup({ result: null, start: monday, now: monday }), /计算完成后/);
  // A rolled scroll that cannot be computed says why on the cover instead of "正在铺开".
  const rolled = calendarMarkup({ result: null, start: monday, now: monday, rolled: true, error: '连不上计算服务' });
  assert.match(rolled, /class="cover-wait is-error" role="status">连不上计算服务/);
  assert.doesNotMatch(rolled, /正在铺开这一周/);
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

test('weekly scoping excludes conflicts from other weeks and solo view hides the analysis panel until opened', () => {
  const nextWeek = monday + 7 * 86400000;
  // Conflict in fixture is on 2026-11-09 (first week); viewing next week (2026-11-16..22) must show 0 conflicts.
  assert.equal(conflictsInWeek(result.conflicts, monday).length, 1);
  assert.equal(conflictsInWeek(result.conflicts, nextWeek).length, 0);
  const nextWeekHtml = calendarMarkup({ result, start: nextWeek, now: nextWeek, analyzed: true });
  assert.match(nextWeekHtml, /叠墨 · 对策 <span>0<\/span>/);
  assert.match(nextWeekHtml, /这一卷是干净的/);
  assert.doesNotMatch(nextWeekHtml, /点墨压在底色上/);
  // Solo mode (default on page open) hides .scroll-side and exposes the 解析画卷 toggle button.
  const soloHtml = calendarMarkup({ result, start: monday, now: monday, analyzed: false });
  assert.match(soloHtml, /class="scroll[^"]*is-solo"/);
  assert.match(soloHtml, /class="scroll-side" aria-label="本周解析" hidden>/);
  assert.match(soloHtml, /data-cal-analyze aria-expanded="false"[^>]*>.*解析画卷.*1 处叠墨/);
});
