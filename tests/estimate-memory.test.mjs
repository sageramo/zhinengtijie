// 越用越准的估时: actual durations per kind of work, suggested back as a rounded median.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, recordActual, suggestEstimate, readMemory, writeMemory, MEMORY_KEY } from '../estimate-memory.js';

test('titles fall into kinds of work, narrow kinds first', () => {
  assert.equal(kindOf('课程报告'), '写作');
  assert.equal(kindOf('讲座报名'), '填报');
  assert.equal(kindOf('期末复习'), '复习');
  assert.equal(kindOf('小组汇报PPT'), '展示');
  assert.equal(kindOf('作品集整理'), '作品');
  assert.equal(kindOf('高数作业'), '作业');
  assert.equal(kindOf('取快递'), null);
});

test('actuals are kept per kind, last eight only, and odd values are ignored', () => {
  let memory = {};
  for (const minutes of [100, 120, 200, 3, 2000]) memory = recordActual(memory, '课程报告', minutes);
  assert.deepEqual(memory, { 写作: [100, 120, 200] });
  assert.equal(recordActual(memory, '取快递', 30), memory, 'unknown kinds change nothing');
  for (let index = 0; index < 10; index += 1) memory = recordActual(memory, '读书报告', 60);
  assert.equal(memory.写作.length, 8);
});

test('the suggestion is the median rounded to 15 minutes, with a plain label', () => {
  const memory = { 写作: [100, 130, 200] };
  assert.deepEqual(suggestEstimate(memory, '期中论文'), { kind: '写作', minutes: 135, count: 3, label: '按你以往3次「写作」约2小时15分' });
  assert.equal(suggestEstimate(memory, '讲座报名'), null);
  assert.equal(suggestEstimate({ 填报: [5] }, '报名').minutes, 15);
});

test('memory survives a reload and a broken value reads as empty', () => {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  writeMemory(storage, { 作业: [60] });
  assert.deepEqual(readMemory(storage), { 作业: [60] });
  store.set(MEMORY_KEY, '[1,2]');
  assert.deepEqual(readMemory(storage), {});
  assert.deepEqual(readMemory(null), {});
});
