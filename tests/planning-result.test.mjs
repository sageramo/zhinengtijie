// Pure response-contract and markup tests, no rendered browser or live network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, createTask, addTask, confirmTask, setAvailability } from '../task-state.js';
import { readPlanResponse, planMarkup } from '../planning-result.js';

const at = time => `2031-03-14T${time}:00+08:00`;
function fixture() {
  let snapshot = createSnapshot({ referenceTime: at('09:00') });
  const task = createTask('flexible');
  Object.assign(task, { title: '<img src=x onerror=alert(1)>', deadline_at: at('12:00'), remaining_minutes: 60, priority: 50, must_do: true, splittable: false, location: '<script>place</script>' });
  snapshot = confirmTask(addTask(snapshot, task), task.id);
  snapshot = setAvailability(snapshot, [{ start: at('09:00'), end: at('12:00') }]);
  const response = { schema_version: 1, revision: snapshot.revision, status: 'feasible_found', horizon: { start: at('09:00'), end: at('12:00') }, schedule: [{ task_id: task.id, kind: 'work', start: at('09:00'), end: at('10:00') }], validation: { passed: true, errors: [], checked_constraints: ['confirmed_inputs', 'availability', 'fixed_occupancy', 'no_overlap', 'release_and_deadline', 'exact_remaining_work', 'continuous_blocks', 'dependencies'] }, issues: [], conflicts: [], capacity_checks: [], warnings: [], limitations: ['<script>limit</script>'], algorithm: { name: 'bounded_greedy_v1', attempts: 1, max_attempts: 4 } };
  return { snapshot, response };
}

test('a complete matching response is accepted as a detached copy', () => {
  const { snapshot, response } = fixture();
  const accepted = readPlanResponse(response, snapshot);
  assert.deepEqual(accepted, response); assert.notEqual(accepted, response);
});

const mutations = {
  'wrong revision': response => { response.revision += 1; },
  'unknown status': response => { response.status = 'optimal'; },
  'missing whole task': response => { response.schedule = []; },
  'wrong workload': response => { response.schedule[0].end = at('09:59'); },
  'unknown task': response => { response.schedule[0].task_id = 'unknown'; },
  'wrong kind': response => { response.schedule[0].kind = 'fixed'; },
  'failed checker': response => { response.validation.passed = false; },
  'unchecked constraint': response => { response.validation.checked_constraints.pop(); },
  'extra result field': response => { response.schedule[0].instruction = 'bad'; },
  'contradictory conflict': response => { response.conflicts = [{ reason: 'conflict' }]; },
  'partial schedule after failure': response => { response.status = 'not_found'; response.validation.passed = null; },
  'wrong horizon': response => { response.horizon.start = at('08:59'); },
};
for (const [label, mutate] of Object.entries(mutations)) test(`rejects ${label}`, () => {
  const { snapshot, response } = fixture(); mutate(response);
  assert.throws(() => readPlanResponse(response, snapshot));
});

test('all source and service text is escaped in schedule and explanatory markup', () => {
  const { snapshot, response } = fixture();
  response.warnings = ['<svg onload=alert(1)>'];
  const markup = planMarkup(readPlanResponse(response, snapshot), snapshot, value => value.slice(0, 16).replace('T', ' '));
  assert.doesNotMatch(markup, /<img|<script|<svg/);
  assert.match(markup, /&lt;img/); assert.match(markup, /&lt;script/); assert.match(markup, /&lt;svg/);
});

test('microseconds do not change exact workload validation', () => {
  const { snapshot, response } = fixture();
  response.schedule[0].start = '2031-03-14T09:00:00.123456+08:00';
  response.schedule[0].end = '2031-03-14T10:00:00.123456+08:00';
  assert.ok(readPlanResponse(response, snapshot));
  response.schedule[0].end = '2031-03-14T10:00:00.123455+08:00';
  assert.throws(() => readPlanResponse(response, snapshot));
});

test('short fixed occupancy and zero-duration milestones are distinct visible entries', () => {
  let { snapshot, response } = fixture();
  const event = createTask('fixed');
  Object.assign(event, { title: '短占用', fixed_start_at: '2031-03-14T10:15:00+08:00', fixed_end_at: '2031-03-14T10:15:00.500000+08:00', priority: 50, must_do: true });
  const node = createTask('milestone');
  Object.assign(node, { title: '截止节点', deadline_at: at('12:00'), priority: 50, must_do: true });
  snapshot = confirmTask(addTask(snapshot, event), event.id);
  snapshot = confirmTask(addTask(snapshot, node), node.id);
  response.revision = snapshot.revision;
  response.schedule.push({ task_id: event.id, kind: 'fixed', start: event.fixed_start_at, end: event.fixed_end_at }, { task_id: node.id, kind: 'milestone', start: node.deadline_at, end: node.deadline_at });
  const markup = planMarkup(readPlanResponse(response, snapshot), snapshot, value => value.replace('T', ' '));
  assert.match(markup, /0.5 秒/); assert.match(markup, /截止节点，不占用工时/);
  response.schedule.at(-1).end = at('12:01');
  assert.throws(() => readPlanResponse(response, snapshot));
});
