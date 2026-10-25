import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STORAGE_KEY, MAX_SNAPSHOT_BYTES, createSnapshot, createTask, addTask, addSource, editTask,
  removeTask, setAvailability, setReferenceTime, confirmTask, completeTask,
  reopenTask, validateSnapshot, parseSnapshot, serializeSnapshot, isTimestamp,
  readSnapshot, writeSnapshot, RevisionGate, noticeCandidates,
} from '../task-state.js';

const TIME = '2026-10-25T09:00:00+08:00';
const DEADLINE = '2026-10-26T23:59:00+08:00';
const snapshot = () => createSnapshot({ referenceTime: TIME });
function manualTask(kind = 'flexible') {
  const task = createTask(kind);
  task.title = '完成课程报告';
  return task;
}
function pending(kind = 'flexible') {
  const task = manualTask(kind);
  return { state: addTask(snapshot(), task), taskId: task.id };
}
function ready(kind = 'flexible') {
  const { state, taskId } = pending(kind);
  const patch = { priority: 80, must_do: true };
  if (kind === 'flexible') Object.assign(patch, { deadline_at: DEADLINE, remaining_minutes: 90, splittable: true, min_block_minutes: 30 });
  if (kind === 'fixed') Object.assign(patch, { fixed_start_at: TIME, fixed_end_at: '2026-10-25T10:00:00+08:00' });
  if (kind === 'milestone') patch.deadline_at = DEADLINE;
  return { state: editTask(state, taskId, patch), taskId };
}
function memoryStorage(initial = new Map()) {
  return { getItem(key) { return initial.has(key) ? initial.get(key) : null; }, setItem(key, value) { initial.set(key, value); }, data: initial };
}
function candidate(overrides = {}) {
  return { time_type: '报名截止', value: '2026-10-26 15:00', evidence: '2026年10月26日15:00前报名', precision: 'datetime', kind: 'point', timezone: 'Asia/Shanghai', warnings: [], ...overrides };
}

test('new snapshot has one explicit time context and no invented data', () => {
  const state = snapshot();
  assert.deepEqual(state, { schema_version: 2, revision: 0, timezone: 'Asia/Shanghai', reference_time: TIME, sources: [], tasks: [], availability: [], availability_confirmed: false });
  assert.equal(validateSnapshot(state).valid, true);
});

test('new task keeps workload, obligation and priority unknown', () => {
  const task = createTask();
  assert.equal(task.status, 'draft');
  for (const key of ['remaining_minutes', 'must_do', 'priority', 'splittable', 'deadline_at']) assert.equal(task[key], null);
  assert.deepEqual(task.confirmed_fields, []);
  assert.notEqual(task.id, createTask().id);
  assert.equal(createTask('fixed').remaining_minutes, 0);
  assert.equal(createTask('milestone').remaining_minutes, 0);
});

test('timestamp validation rejects rollover and implicit timezone', () => {
  for (const value of [TIME, '2028-02-29T23:59:00Z', '0004-02-29T00:00:00+08:00', '2026-10-25t09:00:00+08:00', '2026-10-25t01:00:00Z']) assert.equal(isTimestamp(value), true, value);
  for (const value of ['2026-02-29T23:59:00Z', '2026-02-30T00:00:00+08:00', '2026-13-01T10:00:00Z', '2026-10-25T24:00:00+08:00', '2026-10-25T09:00:00', '2026-10-25T01:00:00z', '2026-10-25', null]) assert.equal(isTimestamp(value), false, String(value));
});

test('lowercase RFC3339 t accepted by backend also survives browser import and export', () => {
  const state = createSnapshot({ referenceTime: '2026-10-25t01:00:00Z' });
  const restored = parseSnapshot(serializeSnapshot(state));
  assert.equal(Date.parse(restored.reference_time), Date.parse(TIME));
});

test('each accepted edit creates a deep independent snapshot and advances revision', () => {
  const { state, taskId } = pending();
  const before = serializeSnapshot(state);
  const patch = { title: '新报告名称', materials: ['成绩单'] };
  const next = editTask(state, taskId, patch);
  patch.materials.push('外部修改');
  assert.equal(serializeSnapshot(state), before);
  assert.equal(next.revision, state.revision + 1);
  assert.deepEqual(next.tasks[0].materials, ['成绩单']);
  next.tasks[0].materials.push('修改下一版');
  assert.deepEqual(state.tasks[0].materials, []);
});

test('confirmation requires explicit choices without silently inventing them', () => {
  const { state, taskId } = pending();
  assert.throws(() => confirmTask(state, taskId), error => error.errors.some(message => message.includes('必须完成')) && error.errors.some(message => message.includes('优先级')) && error.errors.some(message => message.includes('剩余')));
  assert.equal(state.tasks[0].status, 'draft');
  assert.equal(state.revision, 1);
});

test('explicit confirmation records critical fields, clears checked uncertainty, and preserves source evidence', () => {
  const { state, taskId } = ready();
  state.tasks[0].uncertainties = ['原文缺少年份，请核对'];
  state.tasks[0].evidence.push({ field: 'deadline_at', origin: 'source_text', source_id: 'notice', quote: '10月26日23:59前' });
  const next = confirmTask(state, taskId);
  assert.equal(next.tasks[0].status, 'confirmed');
  for (const field of ['title', 'kind', 'deadline_at', 'remaining_minutes', 'splittable', 'min_block_minutes', 'must_do', 'priority']) assert.ok(next.tasks[0].confirmed_fields.includes(field));
  assert.deepEqual(next.tasks[0].uncertainties, []);
  assert.deepEqual(next.tasks[0].evidence, state.tasks[0].evidence);
  assert.deepEqual(state.tasks[0].uncertainties, ['原文缺少年份，请核对']);
});

test('an explicit optional choice and zero priority remain valid user choices', () => {
  const { state, taskId } = ready();
  const next = confirmTask(editTask(state, taskId, { must_do: false, priority: 0 }), taskId);
  assert.equal(next.tasks[0].must_do, false);
  assert.equal(next.tasks[0].priority, 0);
  assert.equal(next.tasks[0].status, 'confirmed');
});

test('editing one confirmed field returns task to draft and removes its confirmation', () => {
  const { state, taskId } = ready();
  const confirmed = confirmTask(state, taskId);
  const next = editTask(confirmed, taskId, { remaining_minutes: 120 });
  assert.equal(next.tasks[0].status, 'draft');
  assert.equal(next.tasks[0].confirmed_fields.includes('remaining_minutes'), false);
  assert.equal(next.tasks[0].confirmed_fields.includes('deadline_at'), true);
  assert.equal(confirmed.tasks[0].status, 'confirmed');
  assert.equal(confirmed.tasks[0].remaining_minutes, 90);
});

test('unchanged field patches do not revoke active confirmation or advance revisions', () => {
  const { state, taskId } = ready();
  for (const status of ['confirmed', 'scheduled', 'in_progress']) {
    const checked = confirmTask(state, taskId);
    checked.tasks[0].status = status;
    for (const patch of [{}, { title: checked.tasks[0].title }, { materials: [...checked.tasks[0].materials] }]) {
      const next = editTask(checked, taskId, patch);
      assert.strictEqual(next, checked);
      assert.equal(next.revision, checked.revision);
      assert.equal(next.tasks[0].status, status);
    }
  }
});

test('non-finite numbers cannot impersonate an unchanged unknown numeric value', () => {
  const { state, taskId } = pending();
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => editTask(state, taskId, { remaining_minutes: value }));
  assert.equal(state.tasks[0].remaining_minutes, null);
});

test('source quote survives user corrections and only latest user correction remains', () => {
  const { state, taskId } = ready();
  state.tasks[0].evidence = [{ field: 'deadline_at', origin: 'source_text', source_id: 'notice', quote: '10月26日23:59前' }];
  const next = editTask(editTask(state, taskId, { deadline_at: '2026-10-27T23:59:00+08:00' }), taskId, { deadline_at: '2026-10-28T23:59:00+08:00' });
  assert.equal(next.tasks[0].evidence.filter(item => item.origin === 'source_text').length, 1);
  const latest = next.tasks[0].evidence.filter(item => item.origin === 'user_input' && item.field === 'deadline_at');
  assert.equal(latest.length, 1);
  assert.equal(latest[0].quote, '2026-10-28T23:59:00+08:00');
});

test('cannot forge confirmed status, IDs, or evidence through editable patch', () => {
  const { state, taskId } = ready();
  for (const patch of [{ status: 'confirmed' }, { id: 'other' }, { confirmed_fields: ['deadline_at'] }, { evidence: [] }, { make_it_feasible: true }]) assert.throws(() => editTask(state, taskId, patch));
});

test('kind switch resets confirmations and uses no-work semantics for fixed or milestone', () => {
  const { state, taskId } = ready();
  const next = editTask(confirmTask(state, taskId), taskId, { kind: 'milestone' });
  assert.deepEqual(next.tasks[0].confirmed_fields, []);
  assert.equal(next.tasks[0].remaining_minutes, 0);
  assert.equal(next.tasks[0].status, 'draft');
});

test('fixed event confirmation requires both ordered endpoints', () => {
  const { state, taskId } = pending('fixed');
  assert.throws(() => confirmTask(state, taskId));
  const { state: valid, taskId: validId } = ready('fixed');
  assert.equal(confirmTask(valid, validId).tasks[0].status, 'confirmed');
  const reversed = editTask(valid, validId, { fixed_end_at: '2026-10-25T08:00:00+08:00' });
  assert.throws(() => confirmTask(reversed, validId), error => error.errors.some(item => item.includes('结束')));
});

test('non-splittable work can confirm without an invented minimum block', () => {
  const { state, taskId } = ready();
  const next = editTask(state, taskId, { splittable: false, min_block_minutes: null });
  const task = confirmTask(next, taskId).tasks[0];
  assert.equal(task.min_block_minutes, null);
  assert.equal(task.confirmed_fields.includes('min_block_minutes'), false);
});

test('minimum block cannot exceed workload and earliest start must precede deadline', () => {
  const { state, taskId } = ready();
  assert.throws(() => confirmTask(editTask(state, taskId, { min_block_minutes: 100 }), taskId));
  assert.throws(() => confirmTask(editTask(state, taskId, { earliest_start_at: '2026-10-27T00:00:00+08:00' }), taskId));
});

test('milestone confirms with zero workload and precise deadline only', () => {
  const { state, taskId } = ready('milestone');
  assert.equal(confirmTask(state, taskId).tasks[0].status, 'confirmed');
});

test('visit windows remain unsupported drafts rather than becoming fixed occupancy', () => {
  const { state, taskId } = ready('visit_window');
  assert.throws(() => confirmTask(state, taskId), error => error.errors.some(item => item.includes('办理窗口')));
});

test('completed work is exactly zero and an accidental completion can be reopened', () => {
  const { state, taskId } = ready();
  const completed = completeTask(state, taskId);
  assert.equal(completed.tasks[0].remaining_minutes, 0);
  assert.equal(completed.tasks[0].status, 'completed');
  assert.throws(() => editTask(completed, taskId, { title: '完成报告（修正名称）' }), /先恢复/);
  const reopened = reopenTask(completed, taskId);
  assert.equal(reopened.tasks[0].status, 'draft');
  assert.equal(reopened.tasks[0].remaining_minutes, null);
  assert.deepEqual(reopened.tasks[0].confirmed_fields, []);
  assert.throws(() => confirmTask(reopened, taskId));
  assert.equal(completed.tasks[0].status, 'completed');
});

test('completed and cancelled tasks cannot silently reactivate through edits or empty patches', () => {
  const { state, taskId } = ready();
  for (const status of ['completed', 'cancelled']) {
    const inactive = completeTask(state, taskId);
    inactive.tasks[0].status = status;
    for (const patch of [{}, { title: '另一名称' }, { remaining_minutes: 60 }]) assert.throws(() => editTask(inactive, taskId, patch), /先恢复/);
    assert.equal(inactive.tasks[0].status, status);
    assert.equal(reopenTask(inactive, taskId).tasks[0].status, 'draft');
  }
});

test('restored fixed event preserves zero preparation workload', () => {
  const { state, taskId } = ready('fixed');
  assert.equal(reopenTask(completeTask(state, taskId), taskId).tasks[0].remaining_minutes, 0);
});

test('deleting a dependency target is rejected rather than silently changing other tasks', () => {
  const { state, taskId } = pending();
  const dependent = manualTask();
  dependent.depends_on = [taskId];
  const next = addTask(state, dependent);
  assert.throws(() => removeTask(next, taskId), /依赖/);
  assert.equal(removeTask(state, taskId).tasks.length, 0);
});

test('availability edits preserve exact intervals and reject impossible endpoint ordering', () => {
  const initial = snapshot();
  const intervals = [{ start: TIME, end: '2026-10-25T12:00:00+08:00' }];
  const next = setAvailability(initial, intervals);
  intervals[0].end = '2026-10-25T11:00:00+08:00';
  assert.equal(next.availability[0].end, '2026-10-25T12:00:00+08:00');
  assert.deepEqual(initial.availability, []);
  assert.throws(() => setAvailability(initial, [{ start: TIME, end: TIME }]));
  assert.throws(() => setAvailability(initial, [{ start: TIME, end: '2026-10-25T08:00:00+08:00' }]));
  assert.deepEqual(setAvailability(next, []).availability, []);
});

test('initial empty availability is unknown but explicitly confirmed empty means zero time', () => {
  const initial = snapshot();
  const known = state => state.availability_confirmed ?? (state.availability.length > 0);
  assert.equal(initial.availability_confirmed, false);
  assert.equal(known(initial), false);
  const none = setAvailability(initial, []);
  assert.deepEqual(none.availability, []);
  assert.equal(none.availability_confirmed, true);
  assert.equal(known(none), true);
  assert.equal(none.revision, initial.revision + 1);
  assert.equal(initial.availability_confirmed, false);
  assert.deepEqual(parseSnapshot(serializeSnapshot(none)), none);
});

test('explicitly entered intervals mark availability known and old snapshots remain readable', () => {
  const intervals = [{ start: TIME, end: '2026-10-25T12:00:00+08:00' }];
  const entered = setAvailability(snapshot(), intervals);
  assert.equal(entered.availability_confirmed, true);
  const old = { ...snapshot(), availability: intervals };
  delete old.availability_confirmed;
  const restored = parseSnapshot(JSON.stringify(old));
  assert.equal(Object.hasOwn(restored, 'availability_confirmed'), false);
  assert.equal(restored.availability_confirmed ?? (restored.availability.length > 0), true);
  old.availability = [];
  const oldEmpty = parseSnapshot(JSON.stringify(old));
  assert.equal(oldEmpty.availability_confirmed ?? (oldEmpty.availability.length > 0), false);
  assert.equal(validateSnapshot({ ...snapshot(), availability_confirmed: 'false' }).valid, false);
  assert.equal(validateSnapshot({ ...snapshot(), availability_confirmed: null }).valid, false);
});

test('reference time edits increase revision and keep original context immutable', () => {
  const initial = snapshot();
  const next = setReferenceTime(initial, DEADLINE);
  assert.equal(next.revision, 1);
  assert.equal(next.reference_time, DEADLINE);
  assert.equal(initial.reference_time, TIME);
  assert.throws(() => setReferenceTime(initial, '2026-10-25 10:00'));
});

test('source additions preserve original text and unknown publication time', () => {
  const original = snapshot();
  const source = { id: 's1', kind: 'pasted_notice', text: '明天下午三点提交', published_at: null };
  const next = addSource(original, source);
  source.text = '外部修改';
  assert.equal(next.sources[0].text, '明天下午三点提交');
  assert.equal(next.sources[0].published_at, null);
  assert.deepEqual(original.sources, []);
  assert.throws(() => addSource(next, next.sources[0]));
});

test('safe import/export supports partially typed drafts without claiming semantic validity', () => {
  const { state } = pending();
  state.tasks[0].title = '';
  assert.deepEqual(parseSnapshot(serializeSnapshot(state)), state);
  // Dependency references and source quotes still require backend semantic checks.
  state.tasks[0].depends_on = ['not-loaded'];
  assert.equal(validateSnapshot(state).valid, true);
});

test('existing backend fixture is structurally readable by the browser', () => {
  const fixture = readFileSync(new URL('../../campus-action-agent-back/examples/nine-minutes.snapshot.json', import.meta.url), 'utf8');
  const parsed = parseSnapshot(fixture);
  assert.equal(parsed.tasks[0].remaining_minutes, 180);
});

test('corrupt import fails safely with explicit errors', () => {
  for (const text of ['{', 'null', '[]', '{}', JSON.stringify({ ...snapshot(), schema_version: 1 }), JSON.stringify({ ...snapshot(), timezone: 'UTC' }), JSON.stringify({ ...snapshot(), surprise: true }), '{"__proto__":{}}']) assert.throws(() => parseSnapshot(text));
  const { state, taskId } = ready();
  assert.throws(() => parseSnapshot(JSON.stringify({ ...state, tasks: [{ ...state.tasks[0], must_do: 'false' }] })));
  assert.throws(() => editTask(state, taskId, { remaining_minutes: -1 }));
  assert.throws(() => addTask(state, state.tasks[0]));
});

test('unsafe revisions and revision overflow cannot produce indistinguishable inputs', () => {
  assert.equal(validateSnapshot({ ...snapshot(), revision: Number.MAX_SAFE_INTEGER + 1 }).valid, false);
  assert.throws(() => setReferenceTime({ ...snapshot(), revision: Number.MAX_SAFE_INTEGER }, DEADLINE));
});

test('local storage read failure leaves original data intact and never resets automatically', () => {
  const storage = memoryStorage(new Map([[STORAGE_KEY, '{broken']]));
  const loaded = readSnapshot(storage);
  assert.equal(loaded.snapshot, null);
  assert.ok(loaded.error);
  assert.equal(loaded.raw, '{broken');
  assert.equal(storage.getItem(STORAGE_KEY), '{broken');
});

test('local storage round trip and unavailable storage are explicit', () => {
  const storage = memoryStorage();
  assert.deepEqual(readSnapshot(storage), { snapshot: null, error: null, raw: null });
  assert.deepEqual(writeSnapshot(storage, STORAGE_KEY, snapshot()), { saved: true, error: null });
  assert.deepEqual(readSnapshot(storage).snapshot, snapshot());
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.equal(readSnapshot(blocked).error, 'blocked');
  assert.equal(readSnapshot(blocked).raw, null);
  assert.deepEqual(writeSnapshot(blocked, STORAGE_KEY, snapshot()), { saved: false, error: 'quota' });
});

test('storage read returns the exact string from one getItem, including parse failure', () => {
  let calls = 0;
  const first = serializeSnapshot(snapshot());
  const storage = { getItem() { calls += 1; return calls === 1 ? first : '{changed by another tab'; } };
  const loaded = readSnapshot(storage);
  assert.equal(calls, 1);
  assert.equal(loaded.raw, first);
  assert.deepEqual(loaded.snapshot, snapshot());
});

test('UTF-8 byte budget counts Chinese characters rather than UTF-16 code units', () => {
  const valid = snapshot();
  const text = '中'.repeat(100000);
  valid.sources = Array.from({ length: 51 }, (_, index) => ({ id: `source-${index}`, kind: 'pasted_notice', text, published_at: null }));
  assert.equal(validateSnapshot(valid).valid, true);
  const raw = JSON.stringify(valid);
  assert.ok(raw.length < MAX_SNAPSHOT_BYTES);
  assert.ok(new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES);
  assert.throws(() => parseSnapshot(raw), /15,000,000字节.*分成更小的清单/);
  assert.throws(() => serializeSnapshot(valid), /15,000,000字节.*分成更小的清单/);
});

test('import accepts exactly 15,000,000 bytes and rejects one extra UTF-8 byte', () => {
  const raw = serializeSnapshot(snapshot());
  const atLimit = raw + ' '.repeat(MAX_SNAPSHOT_BYTES - new TextEncoder().encode(raw).byteLength);
  assert.deepEqual(parseSnapshot(atLimit), snapshot());
  assert.throws(() => parseSnapshot(`${atLimit} `), /15,000,000字节/);
});

test('an export at the exact UTF-8 budget can be re-imported and an oversized export fails', () => {
  const state = snapshot();
  const text = '中'.repeat(100000);
  state.sources = Array.from({ length: 50 }, (_, index) => ({ id: `source-${index}`, kind: 'pasted_notice', text, published_at: null }));
  const initialBytes = new TextEncoder().encode(JSON.stringify(state, null, 2)).byteLength;
  const removed = Math.ceil((initialBytes - MAX_SNAPSHOT_BYTES) / 3);
  state.sources[0].text = '中'.repeat(100000 - removed);
  const currentBytes = new TextEncoder().encode(JSON.stringify(state, null, 2)).byteLength;
  state.sources[0].text += 'a'.repeat(MAX_SNAPSHOT_BYTES - currentBytes);
  const exported = serializeSnapshot(state);
  assert.equal(new TextEncoder().encode(exported).byteLength, MAX_SNAPSHOT_BYTES);
  assert.deepEqual(parseSnapshot(exported), state);
  state.sources[0].text += 'a';
  assert.throws(() => serializeSnapshot(state), /15,000,000字节/);
});

test('an oversized additive edit is rejected before changing the exportable original snapshot', () => {
  const original = snapshot();
  const text = '中'.repeat(100000);
  original.sources = Array.from({ length: 50 }, (_, index) => ({ id: `source-${index}`, kind: 'pasted_notice', text, published_at: null }));
  const initialBytes = new TextEncoder().encode(JSON.stringify(original, null, 2)).byteLength;
  const removed = Math.ceil((initialBytes - MAX_SNAPSHOT_BYTES) / 3);
  original.sources[0].text = '中'.repeat(100000 - removed);
  const currentBytes = new TextEncoder().encode(JSON.stringify(original, null, 2)).byteLength;
  original.sources[0].text += 'a'.repeat(MAX_SNAPSHOT_BYTES - currentBytes);
  const before = serializeSnapshot(original);
  assert.equal(new TextEncoder().encode(before).byteLength, MAX_SNAPSHOT_BYTES);
  assert.throws(() => addSource(original, { id: 'one-more', kind: 'manual', text: '新增原文', published_at: null }), /15,000,000字节/);
  assert.throws(() => addTask(original, manualTask()), /15,000,000字节/);
  assert.equal(original.revision, 0);
  assert.equal(original.sources.length, 50);
  assert.deepEqual(original.tasks, []);
  assert.equal(serializeSnapshot(original), before);
});

test('editing inputs invalidates a pending result even if it finishes later', () => {
  const gate = new RevisionGate();
  const { state, taskId } = ready();
  const token = gate.begin(state);
  assert.equal(gate.accepts(token, state.revision), true);
  const edited = editTask(state, taskId, { remaining_minutes: 180 });
  assert.equal(gate.accepts(token, edited.revision), false);
});

test('newer request at same revision wins and copied tokens cannot impersonate it', () => {
  const gate = new RevisionGate();
  const state = snapshot();
  const earlier = gate.begin(state);
  const latest = gate.begin(state);
  assert.equal(gate.accepts(earlier, state.revision), false);
  assert.equal(gate.accepts(latest, state.revision), true);
  assert.equal(gate.accepts({ ...latest }, state.revision), false);
});

test('reset/import invalidation prevents collision with an old equal-numbered revision', () => {
  const gate = new RevisionGate();
  const old = gate.begin(snapshot());
  gate.invalidate();
  assert.equal(gate.accepts(old, 0), false);
  assert.equal(gate.accepts(null, 0), false);
  const fresh = gate.begin(snapshot());
  assert.equal(gate.accepts(old, 0), false);
  assert.equal(gate.accepts(fresh, 0), true);
});

test('deadline candidates keep original quote but never guess workload or choices', () => {
  const [task] = noticeCandidates({ task_name: '报名通知', time_points: [candidate()] }, 's1');
  assert.equal(task.deadline_at, '2026-10-26T15:00:00+08:00');
  assert.equal(task.status, 'draft');
  for (const key of ['remaining_minutes', 'priority', 'must_do', 'splittable']) assert.equal(task[key], null);
  assert.deepEqual(task.evidence.find(item => item.field === 'deadline_at'), { field: 'deadline_at', origin: 'source_text', source_id: 's1', quote: '2026年10月26日15:00前报名' });
  assert.deepEqual(task.confirmed_fields, []);
});

test('precise activity interval becomes a draft fixed event without duplicate preparation time', () => {
  for (const label of ['活动/比赛时间', '考试时间', '面试时间', '抽签/签到时间']) {
    const [task] = noticeCandidates({ time_points: [candidate({ time_type: label, kind: 'interval', end_value: '2026-10-26 17:00' })] }, 's1');
    assert.equal(task.kind, 'fixed', label);
    assert.equal(task.fixed_start_at, '2026-10-26T15:00:00+08:00');
    assert.equal(task.fixed_end_at, '2026-10-26T17:00:00+08:00');
    assert.equal(task.remaining_minutes, 0);
    assert.equal(task.deadline_at, null);
  }
});

test('registration and office opening windows never become fixed continuous occupation', () => {
  for (const label of ['报名截止', '材料提交', '办理时间']) {
    const [task] = noticeCandidates({ time_points: [candidate({ time_type: label, kind: 'interval', end_value: '2026-10-26 17:00' })] }, 's1');
    assert.equal(task.kind, 'flexible', label);
    assert.equal(task.fixed_start_at, null);
    assert.equal(task.fixed_end_at, null);
    assert.equal(task.deadline_at, null);
    assert.ok(task.uncertainties.length);
  }
});

test('recurring intervals and date-only precision remain unresolved for user confirmation', () => {
  const [recurring] = noticeCandidates({ warnings: ['发现每天重复规则，尚未展开日历'], time_points: [candidate({ time_type: '活动时间', kind: 'interval', end_value: '2026-10-26 17:00' })] }, 's1');
  assert.equal(recurring.kind, 'flexible');
  assert.equal(recurring.fixed_start_at, null);
  const [dateOnly] = noticeCandidates({ time_points: [candidate({ precision: 'date', value: '2026-10-26' })] }, 's1');
  assert.equal(dateOnly.deadline_at, null);
  assert.ok(dateOnly.uncertainties.length);
});

test('multiple candidates do not inherit a shared notice location or materials', () => {
  const tasks = noticeCandidates({ task_name: '课程安排', location: '主楼405', locations: ['主楼405'], materials: ['申请表'], time_points: [candidate(), candidate({ value: '2026-10-27 15:00', evidence: '次日三点' })] }, 's1');
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].id, tasks[1].id);
  for (const task of tasks) {
    assert.equal(task.location, null);
    assert.deepEqual(task.materials, []);
    assert.ok(task.uncertainties.some(item => item.includes('对应地点')));
  }
});

test('candidate adapter truncates display title and evidence to contract limits', () => {
  const [task] = noticeCandidates({ task_name: '名'.repeat(250), time_points: [candidate({ evidence: '证'.repeat(4000) })] }, 's1');
  assert.equal(task.title.length, 200);
  assert.equal(task.evidence.find(item => item.field === 'deadline_at').quote.length, 3000);
});

test('no time extracted still produces an editable draft instead of empty success', () => {
  const [task] = noticeCandidates({ task_name: '仅有报名要求', time_points: [], warnings: ['关键时间缺失'] }, 's1');
  assert.equal(task.title, '仅有报名要求');
  assert.equal(task.deadline_at, null);
  assert.equal(task.status, 'draft');
  assert.ok(task.uncertainties.includes('关键时间缺失'));
});

test('parser fallback source names never appear as task titles', () => {
  for (const task_name of ['user input', 'synthetic-regression', '未命名通知']) {
    const [task] = noticeCandidates({ task_name, time_points: [candidate()] }, 's1');
    assert.equal(task.title, '报名截止');
    const [withoutTime] = noticeCandidates({ task_name, time_points: [] }, 's1');
    assert.equal(withoutTime.title, '');
  }
});
