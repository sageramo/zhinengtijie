import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, createTask, addSource, addTask, editTask, applyTimeReview, serializeSnapshot, confirmTask } from '../task-state.js';
import { reviewTimePatch } from '../time-review.js';
const source = { id: 'basketball', kind: 'pasted_notice', text: '比赛时间：10月26日18:00。比赛地点：大学生活动中心。欢迎有空的同学到场观赛。', published_at: null };
const start = '2026-10-26T18:00:00+08:00';
const end = '2026-10-26T20:00:00+08:00';
function draft() {
  const task = createTask('fixed', source.id); task.title = '到场观赛助威';
  task.evidence = ['fixed_start_at', 'fixed_end_at'].map(field => ({ field, origin: 'source_text', source_id: source.id, quote: '10月26日18:00' }));
  task.uncertainties = ['原文时间缺少明确年份；未提供 reference_date。', '原文未要求所有人必须参加。'];
  return task;
}
const parsed = (changes = {}) => ({ time_points: [{ time_type: '活动/比赛时间', value: '2026-10-26 18:00', end_value: null, precision: 'datetime', kind: 'point', timezone: 'Asia/Shanghai', evidence: '10月26日18:00', ...changes }] });
function state(task = draft()) { return addTask(addSource(createSnapshot(), source), task); }
test('a source start point can fill only the start; no guessed activity end', () => {
  assert.deepEqual(reviewTimePatch(parsed(), draft(), source), { fixed_start_at: start });
});
test('repeat rules, ambiguous points and mismatched source cannot be resolved', () => {
  for (const result of [parsed({ kind: 'recurring_unexpanded' }), parsed({ precision: 'date' }), { time_points: [...parsed().time_points, ...parsed().time_points] }, parsed({ evidence: '无关时间' })]) assert.throws(() => reviewTimePatch(result, draft(), source));
});
test('an application deadline cannot be reinterpreted as fixed attendance', () => {
  assert.throws(() => reviewTimePatch(parsed({ time_type: '报名截止' }), draft(), source), /不能确定为固定/);
});
test('a model fragment omitting a tentative qualifier cannot be laundered by date review', () => {
  for (const suffix of ['左右', '，或次日同一时间']) {
    const qualified = { ...source, text: source.text.replace('10月26日18:00', `10月26日18:00${suffix}`) };
    assert.throws(() => reviewTimePatch(parsed(), draft(), qualified), /暂定、约数或选择关系/);
  }
});
test('time review never replaces an existing start with a source proposal', () => {
  const task = draft(); task.fixed_start_at = '2026-10-26T18:30:00+08:00';
  assert.throws(() => reviewTimePatch(parsed(), task, source), /没有可从原文补全/);
});
test('time review is immutable, advances revision, keeps unknown choices and inferred provenance', () => {
  const original = state(); const before = serializeSnapshot(original);
  const next = applyTimeReview(original, original.tasks[0].id, { fixed_start_at: start }, '2026-10-26');
  assert.equal(serializeSnapshot(original), before);
  assert.equal(next.revision, original.revision + 1);
  assert.equal(next.tasks[0].fixed_start_at, start);
  assert.equal(next.tasks[0].fixed_end_at, null);
  assert.equal(next.tasks[0].priority, null);
  assert.equal(next.tasks[0].must_do, null);
  assert.equal(next.tasks[0].status, 'draft');
  assert.ok(next.tasks[0].evidence.some(item => item.origin === 'inferred' && item.quote.includes('2026-10-26')));
  assert.ok(next.tasks[0].uncertainties.some(note => note.includes('所有人必须参加')));
  assert.ok(!next.tasks[0].uncertainties.some(note => note.includes('未提供 reference_date')));
  assert.throws(() => confirmTask(next, next.tasks[0].id));
});
test('invalid dates, decisions, nonempty fields and reverse intervals cannot be changed by review', () => {
  const original = state(); const id = original.tasks[0].id;
  for (const [patch, date] of [[{ fixed_start_at: start }, '2026-02-30'], [{ priority: 0 }, '2026-10-26'], [{ fixed_start_at: 'not-time' }, '2026-10-26']]) assert.throws(() => applyTimeReview(original, id, patch, date));
  const withStart = applyTimeReview(original, id, { fixed_start_at: start }, '2026-10-26');
  assert.throws(() => applyTimeReview(withStart, id, { fixed_start_at: end }, '2026-10-26'), /不覆盖/);
  assert.throws(() => applyTimeReview(withStart, id, { fixed_end_at: '2026-10-26T17:00:00+08:00' }, '2026-10-26'), /结束必须晚于/);
});
test('confirmed and completed items cannot be silently rewritten by review', () => {
  const original = state(); const id = original.tasks[0].id;
  const ready = editTask(original, id, { fixed_start_at: start, fixed_end_at: end, priority: 0, must_do: false });
  const confirmed = confirmTask(ready, id);
  assert.throws(() => applyTimeReview(confirmed, id, { fixed_start_at: start }, '2026-10-26'), /只可补全待核对/);
});
