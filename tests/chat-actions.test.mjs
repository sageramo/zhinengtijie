import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatAction, findTask, starterReply, nextChips } from '../chat-actions.js';

const task = (id, title, deadline) => ({ id, title, status: 'active', deadline_at: deadline, estimate_minutes: null });
const snapshot = { tasks: [task('t1', '交实验报告', '2026-11-27T23:59:00+08:00'), task('t2', '提交社团报名表', '2026-11-25T18:00:00+08:00'), { ...task('t3', '旧作业', null), status: 'completed' }] };

test('sentences that do what the detail pages do are recognised', () => {
  assert.deepEqual(parseChatAction('帮我开个头：交实验报告'), { kind: 'starter', phrase: '交实验报告', material: '' });
  assert.deepEqual(parseChatAction('交实验报告怎么开始'), { kind: 'starter', phrase: '交实验报告', material: '' });
  assert.deepEqual(parseChatAction('给报名表起个头\n要求：填写姓名学号，附一张证件照'), { kind: 'starter', phrase: '报名表', material: '填写姓名学号，附一张证件照' });
  assert.equal(parseChatAction('五分钟起步').phrase, '');
  assert.deepEqual(parseChatAction('我工作日晚上7点到9点最专注'), { kind: 'focus-window', weekday: { start: '19:00', end: '21:00' }, weekend: null });
  assert.deepEqual(parseChatAction('周末上午九点到十一点效率最高'), { kind: 'focus-window', weekday: null, weekend: { start: '09:00', end: '11:00' } });
  assert.equal(parseChatAction('我平时专注').missing, true);
  assert.deepEqual(parseChatAction('实验报告需要专注'), { kind: 'mark', phrase: '实验报告', mark: 'focus' });
  assert.deepEqual(parseChatAction('报名表碎片时间做就行'), { kind: 'mark', phrase: '报名表', mark: 'fragment' });
  assert.deepEqual(parseChatAction('实验报告做完了'), { kind: 'complete', phrase: '实验报告' });
  assert.deepEqual(parseChatAction('报告大概两个小时'), { kind: 'estimate', phrase: '报告', minutes: 120 });
});

test('reminders, notices, questions, states and small talk are left to the usual flow', () => {
  for (const text of ['提醒我今天写实验报告，预计 30 分钟', '这周再接4小时的社团工作，留6小时休息，时间够吗？', '周末我有空', '我已经交了',
    '下午四点半到五点半想歇会儿', '三点到四点临时要帮辅导员搬东西', '【通知】明天开头会', '有点累']) assert.equal(parseChatAction(text), null, text);
});

test('a phrase finds the active task it names, else falls back to the task just talked about', () => {
  assert.deepEqual(findTask(snapshot, '交实验报告'), { task: snapshot.tasks[0], byName: true });
  assert.equal(findTask(snapshot, '报名表').task.id, 't2');
  assert.equal(findTask(snapshot, '旧作业').task, null, 'completed tasks are not matched');
  assert.deepEqual(findTask(snapshot, '', 't2'), { task: snapshot.tasks[1], byName: false });
});

test('the 起步卡 reply quotes the material, says when the user is resting, and offers next sentences', () => {
  const html = starterReply(snapshot.tasks[0], { action: '新建文档，写下三个小标题', material_brief: { excerpts: ['报告需包含实验目的'] } });
  assert.match(html, /先做这一步/);
  assert.match(html, /报告需包含实验目的/);
  assert.match(html, /data-turn-timer/);
  assert.match(starterReply(snapshot.tasks[0], { action: '想歇就歇', resting: true }), /现在正休息/);
  assert.match(starterReply(snapshot.tasks[0], { action: 'x' }, { degraded: true }), /还不能读材料/);
  assert.match(nextChips(['帮我开个头：交实验报告']), /data-say="帮我开个头：交实验报告"/);
  assert.equal(nextChips([]), '');
});
