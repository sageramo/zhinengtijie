import assert from 'node:assert/strict';
import test from 'node:test';
import { agendaReply, isConversation } from '../agenda.js';
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

test('capacity trial gently notes unestimated deadline tasks even when they are not in undefined', async () => {
  let snapshot = setDailyWindow(baseline, Array(7).fill({ start: '12:00', end: '22:00' }));
  snapshot = addPersonalTask(snapshot, { title: '交选课确认表', day: '2026-11-13' });
  const calculate = async () => ({ ...result, undefined: [] });
  const reply = await agendaReply('今天再接1小时社团工作，留半小时休息，时间够吗？', { snapshot, now, calculate });
  assert.match(reply.text, /另有 1 件未估时的截止事项未占空档/);
  assert.doesNotMatch(reply.text, /待补时间/);
});

test('asking about today while reference_time is pinned on a future demo day uses real now', async () => {
  const futureDemo = createTimeSnapshot({ referenceTime: '2026-11-25T13:30:00+08:00' });
  const snapshot = setDailyWindow(futureDemo, Array(7).fill({ start: '12:00', end: '22:00' }));
  let seenInput = null;
  const calculate = async input => { seenInput = input; return result; };
  await agendaReply('今天还能接2小时的社团工作吗？', { snapshot, now, calculate });
  assert.equal(Date.parse(seenInput.snapshot.reference_time), now);
  assert.equal(Date.parse(seenInput.now), now);
});

test('weekend and weekday availability questions calculate real slots instead of turning into fake tasks', async () => {
  // now = 2026-11-13 (Friday) 14:00 -> weekend is Sat Nov 14 & Sun Nov 15
  const snapshot = setDailyWindow(baseline, Array(7).fill({ start: '09:00', end: '22:00' }));
  const weekendResult = {
    definition: { free_time: 'defined' }, conflicts: [], undefined: [], markers: [],
    layers: {
      free: [
        { start: '2026-11-14T09:00:00+08:00', end: '2026-11-14T12:00:00+08:00' },
        { start: '2026-11-15T14:00:00+08:00', end: '2026-11-15T18:00:00+08:00' },
      ],
      routine: [], appointment: [], temporary: [], work: [],
    },
  };
  const reply = await agendaReply('周末我有没有时间参加社团活动', { snapshot, now, calculate: async () => weekendResult });
  assert.ok(reply, 'weekend question must be answered directly by agendaReply');
  assert.match(reply.text, /本周末还剩 7 小时，最长连续 4 小时/);
  assert.match(reply.text, /11月14日 09:00–12:00/);
  assert.match(reply.text, /11月15日 14:00–18:00/);
  assert.equal(isConversation('周末我有没有时间参加社团活动'), true);
});

test('plain-spoken availability questions are capacity questions too', async () => {
  const snapshot = setDailyWindow(baseline, Array(7).fill({ start: '09:00', end: '22:00' }));
  const weekendResult = {
    definition: { free_time: 'defined' }, conflicts: [], undefined: [], markers: [],
    layers: { free: [{ start: '2026-11-14T09:00:00+08:00', end: '2026-11-14T12:00:00+08:00' }], routine: [], appointment: [], temporary: [], work: [] },
  };
  for (const line of ['我这周末还有时间出去玩吗', '这周末能出去玩吗', '周末社团和作业排得开吗']) {
    const reply = await agendaReply(line, { snapshot, now, calculate: async () => weekendResult });
    assert.ok(reply, line);
    assert.match(reply.text, /本周末还剩 3 小时/, line);
  }
  const week = await agendaReply('这周我还有时间出去玩吗', { snapshot, now, calculate: async () => weekendResult });
  assert.ok(week && /还剩/.test(week.text));
  const bareEmpty = await agendaReply('这周还有多少空', { snapshot, now, calculate: async () => weekendResult });
  assert.ok(bareEmpty && /本周还剩/.test(bareEmpty.text));
});

test('several activities with lengths in one question become a plan request; one activity does not', async () => {
  const { parseActivities } = await import('../agenda.js');
  const plan = parseActivities('这周末出去玩4小时、写作业3小时、社团2小时，留2小时休息，排得开吗');
  assert.equal(plan.scope, 'weekend');
  assert.deepEqual(plan.activities.map(item => [item.title, item.minutes, item.category, item.splittable]), [['出去玩', 240, 'leisure', false], ['写作业', 180, 'study', true], ['社团', 120, 'club', false]]);
  assert.equal(plan.reserve_rest_minutes, 120);
  assert.equal(parseActivities('周六想去看电影2小时，还要复习高数3个小时，够吗').weekdayIndex, 5);
  assert.equal(parseActivities('这周还有时间出去玩吗'), null);
  assert.equal(parseActivities('【通知】周六上午9点开会2小时、下午打扫1小时'), null);
});
