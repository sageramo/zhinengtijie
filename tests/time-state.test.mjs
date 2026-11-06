import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTimeSnapshot, migrateV2, serializeTimeSnapshot, readTimeSnapshot, addImported, updateTask, updateEvent,
  addTask, addEvent, removeItem, setDailyWindow, addRoutine, setRoutinesConfirmed, addAdjustment, addTimetable,
  setReferenceTime, TIME_STORAGE_KEY, ESTIMATE_PRESETS,
} from '../time-state.js';

const base = () => createTimeSnapshot({ referenceTime: '2026-11-09T08:00:00+08:00' });
const source = { id: 's1', kind: 'pasted_notice', text: '请于11月10日23:59前提交课程报告。', published_at: null };
const imported = () => ({
  source,
  events: [{ id: 'e1', title: '参加讲座', start_at: '2026-11-09T18:00:00+08:00', end_at: '2026-11-09T20:00:00+08:00', location: null, status: 'active', source_id: 's1', evidence: [], notes: [] }],
  tasks: [{ id: 't1', title: '提交课程报告', deadline_at: '2026-11-10T23:59:00+08:00', estimate_minutes: null, splittable: true, min_block_minutes: null, earliest_start_at: null, priority: null, status: 'active', location: null, materials: [], source_id: 's1', evidence: [{ field: 'deadline_at', origin: 'source_text', source_id: 's1', quote: '11月10日23:59' }], notes: [] }],
});

test('a new snapshot has undefined free time and unconfirmed routines', () => {
  const snapshot = base();
  assert.equal(snapshot.schema_version, 3);
  assert.equal(snapshot.daily_window, null);
  assert.equal(snapshot.routines_confirmed, false);
  for (const key of ['sources', 'routines', 'free_adjustments', 'events', 'tasks']) assert.deepEqual(snapshot[key], []);
});

test('imported items are added at once and every change raises the revision without mutating the input', () => {
  const first = base();
  const next = addImported(first, imported());
  assert.equal(first.events.length, 0);
  assert.equal(next.revision, first.revision + 1);
  assert.deepEqual([next.events.length, next.tasks.length, next.sources.length], [1, 1, 1]);
  assert.equal(addImported(next, imported()).sources.length, 1, 'the same source is not stored twice');
});

test('editing a sourced field records the user edit instead of keeping the old quote', () => {
  const next = updateTask(addImported(base(), imported()), 't1', { deadline_at: '2026-11-10T22:00:00+08:00', estimate_minutes: 60 });
  const task = next.tasks[0];
  assert.equal(task.estimate_minutes, 60);
  assert.deepEqual(task.evidence.filter(item => item.field === 'deadline_at').map(item => item.origin), ['user_input']);
  assert.throws(() => updateTask(next, 't1', { estimate_minutes: 0 }), /预计用时/);
  assert.throws(() => updateTask(next, 't1', { unknown: 1 }), /不能修改/);
  assert.throws(() => updateEvent(next, 'e1', { end_at: '2026-11-09T17:00:00+08:00' }), /结束/);
});

test('manual items, removal, routines, adjustments and the daily window', () => {
  let snapshot = addTask(base(), { title: '读书笔记' });
  snapshot = addEvent(snapshot, { title: '面试', start_at: '2026-11-11T15:00:00+08:00', end_at: '2026-11-11T16:00:00+08:00' });
  assert.equal(snapshot.tasks[0].deadline_at, null);
  snapshot = removeItem(snapshot, snapshot.tasks[0].id);
  assert.equal(snapshot.tasks.length, 0);
  snapshot = setDailyWindow(snapshot, Array(7).fill({ start: '08:00', end: '23:00' }));
  assert.throws(() => setDailyWindow(snapshot, Array(6).fill(null)), /7/);
  assert.throws(() => setDailyWindow(snapshot, [{ start: '23:00', end: '08:00' }, ...Array(6).fill(null)]), /晚于/);
  snapshot = addRoutine(snapshot, { title: '例会', weekdays: [2], start: '19:00', end: '20:00', from: '2026-09-01' });
  assert.equal(snapshot.routines[0].week_interval, 1);
  assert.equal(snapshot.routines_confirmed, true, 'adding a routine counts as having filled routines');
  assert.throws(() => addRoutine(snapshot, { title: '空', weekdays: [], start: '19:00', end: '20:00', from: '2026-09-01' }), /星期/);
  snapshot = setRoutinesConfirmed(snapshot, false);
  assert.equal(snapshot.routines_confirmed, false);
  snapshot = addAdjustment(snapshot, { kind: 'remove', start_at: '2026-11-09T12:00:00+08:00', end_at: '2026-11-09T13:00:00+08:00', note: '午休' });
  assert.equal(snapshot.free_adjustments.length, 1);
  snapshot = setReferenceTime(snapshot, '2026-11-09T09:00:00+08:00');
  assert.equal(snapshot.reference_time, '2026-11-09T09:00:00+08:00');
});

test('a timetable import adds its source and routines and marks routines as filled', () => {
  const routine = { id: 'r-1', title: '高等数学', weekdays: [1], start: '08:00', end: '09:40', from: '2026-09-07', until: '2026-12-27', week_interval: 1, skip_dates: [], location: '主楼301', source_id: 'st' };
  const next = addTimetable(base(), { source: { id: 'st', kind: 'timetable', text: '高等数学', published_at: null }, routines: [routine] });
  assert.equal(next.routines.length, 1);
  assert.equal(next.routines_confirmed, true);
  assert.equal(next.sources[0].kind, 'timetable');
});

test('a v2 list becomes v3 layers without losing times, workload or evidence', () => {
  const v2 = {
    schema_version: 2, revision: 7, timezone: 'Asia/Shanghai', reference_time: '2026-11-09T08:00:00+08:00', sources: [source],
    availability: [{ start: '2026-11-09T19:00:00+08:00', end: '2026-11-09T21:00:00+08:00' }], availability_confirmed: true,
    tasks: [
      { id: 'a', source_id: 's1', title: '报告', kind: 'flexible', status: 'confirmed', earliest_start_at: null, deadline_at: '2026-11-10T23:59:00+08:00', fixed_start_at: null, fixed_end_at: null, visit_windows: [], remaining_minutes: 90, splittable: false, min_block_minutes: null, must_do: true, priority: 80, location: null, materials: [], depends_on: [], confirmed_fields: [], evidence: [{ field: 'deadline_at', origin: 'source_text', source_id: 's1', quote: '11月10日23:59' }, { field: 'must_do', origin: 'user_input', source_id: null, quote: null }], uncertainties: ['提醒'] },
      { id: 'b', source_id: null, title: '讲座', kind: 'fixed', status: 'draft', earliest_start_at: null, deadline_at: null, fixed_start_at: '2026-11-09T18:00:00+08:00', fixed_end_at: null, visit_windows: [], remaining_minutes: null, splittable: null, min_block_minutes: null, must_do: null, priority: null, location: '主楼', materials: [], depends_on: [], confirmed_fields: [], evidence: [], uncertainties: [] },
      { id: 'c', source_id: null, title: '领证', kind: 'visit_window', status: 'draft', earliest_start_at: null, deadline_at: null, fixed_start_at: null, fixed_end_at: null, visit_windows: [{ start: '2026-11-10T09:00:00+08:00', end: '2026-11-12T17:00:00+08:00' }], remaining_minutes: null, splittable: null, min_block_minutes: null, must_do: null, priority: null, location: null, materials: [], depends_on: [], confirmed_fields: [], evidence: [], uncertainties: [] },
      { id: 'd', source_id: null, title: '已完成', kind: 'flexible', status: 'completed', earliest_start_at: null, deadline_at: null, fixed_start_at: null, fixed_end_at: null, visit_windows: [], remaining_minutes: 0, splittable: null, min_block_minutes: null, must_do: null, priority: null, location: null, materials: [], depends_on: [], confirmed_fields: [], evidence: [], uncertainties: [] },
    ],
  };
  const v3 = migrateV2(v2);
  assert.equal(v3.schema_version, 3);
  assert.deepEqual(v3.events.map(item => [item.id, item.start_at, item.end_at, item.location]), [['b', '2026-11-09T18:00:00+08:00', null, '主楼']]);
  const tasks = Object.fromEntries(v3.tasks.map(item => [item.id, item]));
  assert.deepEqual([tasks.a.estimate_minutes, tasks.a.splittable, tasks.a.priority, tasks.a.notes], [90, false, 80, ['提醒']]);
  assert.deepEqual(tasks.a.evidence.map(item => item.field), ['deadline_at']);
  assert.deepEqual([tasks.c.earliest_start_at, tasks.c.deadline_at], ['2026-11-10T09:00:00+08:00', '2026-11-12T17:00:00+08:00']);
  assert.equal(tasks.d.status, 'completed');
  assert.deepEqual(v3.free_adjustments.map(item => [item.kind, item.start_at]), [['add', '2026-11-09T19:00:00+08:00']]);
});

test('serialization round-trips, rejects other versions and reads from storage', () => {
  const snapshot = addImported(base(), imported());
  const raw = serializeTimeSnapshot(snapshot);
  const data = new Map([[TIME_STORAGE_KEY, raw]]);
  const storage = { getItem: key => data.get(key) ?? null };
  const read = readTimeSnapshot(storage);
  assert.deepEqual(read.snapshot, snapshot);
  assert.equal(read.raw, raw);
  assert.throws(() => serializeTimeSnapshot({ ...snapshot, schema_version: 2 }), /v3/);
  assert.equal(readTimeSnapshot({ getItem: () => null }).snapshot, null);
});

test('reading migrates a stored v2 list but leaves the v2 bytes untouched', () => {
  const v2 = { schema_version: 2, revision: 1, timezone: 'Asia/Shanghai', reference_time: '2026-11-09T08:00:00+08:00', sources: [], tasks: [], availability: [] };
  const data = new Map([['sixu.task-snapshot.v2', JSON.stringify(v2)]]);
  const read = readTimeSnapshot({ getItem: key => data.get(key) ?? null });
  assert.equal(read.snapshot.schema_version, 3);
  assert.equal(read.migrated, true);
  assert.equal(read.raw, null);
  assert.equal(data.get('sixu.task-snapshot.v2'), JSON.stringify(v2));
});

test('estimate presets cover quick choices', () => {
  assert.deepEqual(ESTIMATE_PRESETS.map(item => item.minutes), [15, 30, 60, 120, 240]);
});
