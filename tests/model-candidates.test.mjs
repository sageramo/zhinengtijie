import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCandidates } from '../model-candidates.js';
import { createSnapshot, addSource, addTask, serializeSnapshot } from '../task-state.js';
const source = { id: 'notice-test', kind: 'pasted_notice', text: '2026年10月28日15:00前提交报告，交到主楼405，携带申请表。', published_at: null };
function response() {
  return { schema_version: 1, provider: 'dify', parsing_status: 'needs_confirmation', warnings: [], candidates: [{ title: '提交报告', kind: 'flexible', deadline_at: '2026-10-28T15:00:00+08:00', fixed_start_at: null, fixed_end_at: null, visit_windows: [], location: '主楼405', materials: ['申请表'], evidence: [{ field: 'title', origin: 'source_text', quote: '提交报告' }, { field: 'kind', origin: 'source_text', quote: '提交报告' }, { field: 'deadline_at', origin: 'source_text', quote: '2026年10月28日15:00' }, { field: 'location', origin: 'source_text', quote: '主楼405' }, { field: 'materials', origin: 'source_text', quote: '申请表' }], uncertainties: [] }] };
}
test('model extraction produces valid drafts with locally owned decisions and identity', () => {
  const original = response();
  const before = structuredClone(original);
  const [task] = modelCandidates(original, source);
  assert.equal(task.status, 'draft');
  assert.deepEqual(task.confirmed_fields, []);
  for (const field of ['remaining_minutes', 'priority', 'must_do', 'splittable']) assert.equal(task[field], null);
  assert.equal(task.evidence[0].source_id, source.id);
  assert.match(task.uncertainties[0], /不代表理解一定正确/);
  const snapshot = addTask(addSource(createSnapshot(), source), task);
  assert.equal(JSON.parse(serializeSnapshot(snapshot)).tasks[0].source_id, source.id);
  assert.deepEqual(original, before);
});
test('model cannot inject confirmation, priority, workload, or task identity', () => {
  for (const [key, value] of Object.entries({ status: 'confirmed', priority: 100, remaining_minutes: 60, id: 'existing', confirmed_fields: ['title'] })) {
    const result = response(); result.candidates[0][key] = value;
    assert.throws(() => modelCandidates(result, source), /结构不匹配/);
  }
});
test('fabricated, missing and nonsource evidence are rejected atomically', () => {
  for (const mutate of [c => c.evidence[0].quote = '不存在的报告', c => c.evidence = [], c => c.evidence[0].origin = 'user_input', c => c.evidence[0].source_id = 'other']) {
    const result = response(); mutate(result.candidates[0]);
    assert.throws(() => modelCandidates(result, source));
  }
});
test('wrong extraction envelopes and task states cannot be imported', () => {
  for (const mutate of [r => r.schema_version = 2, r => r.provider = 'rules', r => r.parsing_status = 'confirmed', r => r.candidates = {}, r => r.unexpected = 1]) {
    const result = response(); mutate(result); assert.throws(() => modelCandidates(result, source));
  }
});
test('invalid date rollover, reverse intervals and mixed time types are rejected', () => {
  for (const mutate of [c => c.deadline_at = '2026-02-30T10:00:00+08:00', c => c.fixed_start_at = c.deadline_at, c => c.visit_windows = [{ start: c.deadline_at, end: c.deadline_at }]]) {
    const result = response(); mutate(result.candidates[0]); assert.throws(() => modelCandidates(result, source));
  }
});
test('materials and location must match their exact quoted values', () => {
  for (const mutate of [c => c.materials = ['学生证'], c => c.location = '主楼406']) {
    const result = response(); mutate(result.candidates[0]); assert.throws(() => modelCandidates(result, source));
  }
});
test('a genuine zero-action output remains empty rather than inventing a task', () => {
  const result = response(); result.candidates = []; result.warnings = ['这份通知仅介绍背景。'];
  assert.deepEqual(modelCandidates(result, source), []);
});

test('Unicode code point limits agree with Python schema without truncating evidence', () => {
  const result = response();
  const quote = '😀'.repeat(3000);
  const emojiSource = { ...source, text: quote };
  const candidate = result.candidates[0];
  candidate.title = '😀'.repeat(200);
  candidate.location = '😀'.repeat(500);
  candidate.materials = [];
  candidate.deadline_at = null;
  candidate.evidence = [
    { field: 'title', origin: 'source_text', quote },
    { field: 'kind', origin: 'source_text', quote },
    { field: 'location', origin: 'source_text', quote: candidate.location },
  ];
  const [task] = modelCandidates(result, emojiSource);
  const snapshot = addTask(addSource(createSnapshot(), emojiSource), task);
  assert.equal(JSON.parse(serializeSnapshot(snapshot)).tasks[0].evidence[0].quote, quote);
  candidate.title += '😀';
  assert.throws(() => modelCandidates(result, emojiSource));
});
