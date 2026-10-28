// Pure state/markup tests. No model, network, browser or rendered layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, createTask, addTask, confirmTask, setAvailability, editTask, serializeSnapshot } from '../task-state.js';
import { buildScenario, adoptScenario, canCompare, scenarioForm, comparisonMarkup } from '../scenario.js';

const at = time => `2031-03-14T${time}:00+08:00`;
function fixture() {
  let snapshot = createSnapshot({ referenceTime: at('18:00') });
  const task = createTask('flexible');
  Object.assign(task, { title: '课程报告', deadline_at: at('22:00'), remaining_minutes: 120, priority: 75, must_do: true, splittable: true, min_block_minutes: 30 });
  snapshot = confirmTask(addTask(snapshot, task), task.id);
  snapshot = setAvailability(snapshot, [{ start: at('18:00'), end: at('19:00') }]);
  return { snapshot, task: snapshot.tasks[0] };
}

test('a hypothetical work estimate leaves its baseline untouched and preserves every other constraint', () => {
  const { snapshot, task } = fixture(); const before = serializeSnapshot(snapshot);
  const { candidate, proposal } = buildScenario(snapshot, { kind: 'remaining', task_id: task.id, minutes: 60 });
  assert.equal(serializeSnapshot(snapshot), before);
  assert.equal(candidate.tasks[0].remaining_minutes, 60);
  assert.equal(candidate.tasks[0].status, 'confirmed');
  assert.deepEqual(candidate.availability, snapshot.availability);
  for (const field of ['deadline_at', 'priority', 'must_do', 'min_block_minutes', 'splittable', 'depends_on']) assert.deepEqual(candidate.tasks[0][field], task[field]);
  assert.equal(proposal.baseline, before);
  const adopted = adoptScenario(snapshot, proposal);
  assert.equal(adopted.tasks[0].remaining_minutes, 60);
  assert.equal(adopted.tasks[0].status, 'draft');
  assert.ok(!adopted.tasks[0].confirmed_fields.includes('remaining_minutes'));
  assert.equal(serializeSnapshot(snapshot), before);
});

test('a new availability hypothesis and adoption preserve all existing tasks and intervals', () => {
  const { snapshot } = fixture();
  const { candidate, proposal } = buildScenario(snapshot, { kind: 'availability', start: at('20:00'), end: at('21:00') });
  assert.equal(snapshot.availability.length, 1);
  assert.equal(candidate.availability.length, 2);
  assert.deepEqual(candidate.tasks, snapshot.tasks);
  assert.deepEqual(adoptScenario(snapshot, proposal), candidate);
});

test('adoption rejects a changed snapshot even when its revision is deliberately reused', () => {
  const { snapshot, task } = fixture();
  const { proposal } = buildScenario(snapshot, { kind: 'remaining', task_id: task.id, minutes: 60 });
  const altered = structuredClone(snapshot); altered.tasks[0].priority = 74;
  assert.equal(altered.revision, snapshot.revision);
  assert.throws(() => adoptScenario(altered, proposal), /清单已经变化/);
});

for (const [label, input] of Object.entries({
  'zero workload': { kind: 'remaining', minutes: 0 },
  'negative workload': { kind: 'remaining', minutes: -1 },
  'fractional workload': { kind: 'remaining', minutes: 1.5 },
  'overflow workload': { kind: 'remaining', minutes: 10000001 },
  'unchanged workload': { kind: 'remaining', minutes: 120 },
  'shorter than continuous minimum': { kind: 'remaining', minutes: 20 },
  'deadline rewriting': { kind: 'deadline', deadline: at('23:00') },
  'hidden extra field': { kind: 'remaining', minutes: 60, priority: 0 },
})) test(`rejects ${label}`, () => {
  const { snapshot, task } = fixture();
  assert.throws(() => buildScenario(snapshot, { ...input, task_id: task.id }));
});

test('draft, inactive and unknown work cannot be silently confirmed by a hypothesis', () => {
  const { snapshot, task } = fixture();
  const draft = editTask(snapshot, task.id, { priority: 70 });
  assert.throws(() => buildScenario(draft, { kind: 'remaining', task_id: task.id, minutes: 60 }), /先核对/);
  assert.throws(() => buildScenario(snapshot, { kind: 'remaining', task_id: 'unknown', minutes: 60 }));
  const inactive = structuredClone(snapshot); inactive.tasks[0].status = 'cancelled';
  assert.throws(() => buildScenario(inactive, { kind: 'remaining', task_id: task.id, minutes: 60 }));
});

test('invalid, reversed, past and duplicate availability are rejected', () => {
  const { snapshot } = fixture();
  for (const [start, end] of [[null, at('19:00')], [at('20:00'), at('19:00')], [at('17:00'), at('19:00')], [at('18:00'), at('19:00')]]) {
    assert.throws(() => buildScenario(snapshot, { kind: 'availability', start, end }));
  }
});

test('submillisecond reference precision is respected by new availability and the initial field value', () => {
  const { snapshot } = fixture(); snapshot.reference_time = '2031-03-14T18:00:00.000001+08:00';
  assert.throws(() => buildScenario(snapshot, { kind: 'availability', start: at('18:00'), end: at('20:00') }), /早于/);
  let rounded;
  scenarioForm(snapshot, value => { rounded = value; return value; });
  assert.equal(rounded, '2031-03-14T10:01:00.000Z');
});

test('only full planning outcomes offer comparison, capacity-only and incomplete results do not', () => {
  for (const status of ['feasible_found', 'not_found', 'conflicts_detected']) assert.equal(canCompare({ status }), true);
  for (const status of ['information_needed', 'unsupported', 'validation_failed', 'nothing_to_schedule', 'no_conflict_detected']) assert.equal(canCompare({ status }), false);
});

test('comparison uses the maximum cumulative deficit, never a double-counted sum, and escapes text', () => {
  const { snapshot, task } = fixture();
  const prepared = buildScenario(snapshot, { kind: 'remaining', task_id: task.id, minutes: 60 });
  prepared.proposal.summary = '<img src=x onerror=alert(1)>';
  const base = { status: 'conflicts_detected', capacity_checks: [{ known_required_minutes: 100, available_minutes: 80 }, { known_required_minutes: 200, available_minutes: 170 }], conflicts: [{ reason: 'shortage' }] };
  const hypothetical = { status: 'not_found', capacity_checks: [], schedule: [], issues: [], conflicts: [], warnings: [], limitations: [], horizon: { start: at('18:00'), end: at('22:00') }, algorithm: { attempts: 4 } };
  const markup = comparisonMarkup(base, hypothetical, prepared.proposal, prepared.candidate, value => value);
  assert.match(markup, /30 分钟/); assert.doesNotMatch(markup, /50 分钟|<img/);
  assert.match(markup, /&lt;img/); assert.match(markup, /暂未找到完整安排/); assert.match(markup, /尚未采用/);
});
