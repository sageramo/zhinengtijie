import assert from 'node:assert/strict';
import test from 'node:test';
import { agendaReply } from '../agenda.js';
import { addPersonalTask, createTimeSnapshot, setDailyWindow } from '../time-state.js';

const now = Date.parse('2026-11-13T14:00:00+08:00');
const baseline = createTimeSnapshot({ referenceTime: new Date(now - 86400000).toISOString() });
const at = hour => `2026-11-13T${hour}:00:00+08:00`;
const result = {
  definition: { free_time: 'defined' }, conflicts: [], undefined: [], markers: [],
  layers: {
    free: [{ start: at(12), end: at(22) }], routine: [], appointment: [], temporary: [],
    work: [{ task_id: '1', title: '复习', start: at(16), end: at(18) }],
  },
};

test('a capacity question clips past time, deducts work, tests rest and rejects a fragmented commitment', async () => {
  const snapshot = setDailyWindow(baseline, Array(7).fill({ start: '12:00', end: '22:00' }));
  const calculate = async input => {
    assert.equal(Date.parse(input.snapshot.reference_time), now);
    return result;
  };
  const reply = await agendaReply('今天还能接5小时的社团工作，留1小时休息，够吗？', { snapshot, now, calculate });
  assert.match(reply.text, /还剩 6 小时，最长连续 4 小时/);
  assert.match(reply.text, /总量够，但没有连续 5 小时/);
  const split = await agendaReply('今天还能接5小时的社团工作，可以拆开做，留1小时休息吗？', { snapshot, now, calculate });
  assert.match(split.text, /5 小时排得下/);
  const short = await agendaReply('今天还能接5小时的社团工作，留2小时休息，够吗？', { snapshot, now, calculate });
  assert.match(short.text, /总量还差 1 小时/);
  assert.equal(short.next, undefined);
  assert.equal(snapshot.reference_time, baseline.reference_time);
});

test('task follow-ups use only the current conversational task and do not create another item', async () => {
  let snapshot = addPersonalTask(baseline, { title: '写实验报告', day: '2026-11-13' });
  const lastTaskId = snapshot.tasks[0].id;
  const reply = text => agendaReply(text, { snapshot, lastTaskId, now });
  snapshot = (await reply('30分钟')).next;
  assert.equal(snapshot.tasks[0].estimate_minutes, 30);
  snapshot = (await reply('挪到明天')).next;
  assert.match(snapshot.tasks[0].deadline_at, /^2026-11-14/);
  assert.equal((await reply('还没做完')).next, undefined);
  snapshot = (await reply('做完了')).next;
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].status, 'completed');
  assert.match((await reply('每晚10点问一问我')).text, /重复提醒/);
  assert.equal(await reply('【活动通知】\n请各位同学留出空闲时间'), null);
});

test('equivalent durations produce the same shortage and half an hour of rest is deducted', async () => {
  const snapshot = setDailyWindow(baseline, Array(7).fill({ start: '14:00', end: '17:00' }));
  const calculate = async () => ({ ...result, layers: { ...result.layers, work: [],
    free: [{ start: at(14), end: '2026-11-13T15:10:00+08:00' }] } });
  const reply = text => agendaReply(text, { snapshot, now, calculate });
  const minutes = await reply('今天再接90分钟的社团工作，时间够吗？');
  assert.equal((await reply('今天再接1小时30分钟的社团工作，时间够吗？')).text, minutes.text);
  assert.equal((await reply('今天再接一个半小时的社团工作，时间够吗？')).text, minutes.text);
  assert.match(minutes.text, /总量还差 20 分钟/);
  assert.match((await reply('今天再接1小时社团工作，留半小时休息，时间够吗？')).text, /预留 30 分钟.*总量还差 20 分钟/);
  assert.match((await reply('今天再接1小时社团工作，留点休息时间，时间够吗？')).text, /分别写清/);
});
