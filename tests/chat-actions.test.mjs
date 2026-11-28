import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatAction, parseRoughSchedule, findTask, starterReply, nextChips } from '../chat-actions.js';

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

test('the 试算卡 shows the verdict, each placement or its shortfall, what is left, and the trade-offs when it does not fit', async () => {
  const { planCardMarkup } = await import('../chat-actions.js');
  const short = planCardMarkup({ tool: 'plan_activities', scope: { label: '本周末' }, feasible: false, leftover_minutes: 0, longest_free_minutes: 0,
    placements: [{ title: '社团活动', status: 'unplaced', shortfall_minutes: 120, blocks: [] }],
    tradeoffs: [{ title: '把「出去玩」从 4 小时缩到 2 小时', consequence: '其余活动全部排得开' }] }, 'plan-1');
  assert.match(short, /本周末排不开/);
  assert.match(short, /放不下，还差 2 小时/);
  assert.match(short, /缩到 2 小时/);
  assert.doesNotMatch(short, /data-plan-adopt/);
  const free = planCardMarkup({ tool: 'check_capacity', scope: { label: '本周末' }, available_minutes: 600, longest_free_minutes: 300, free_slots: [{ label: '11月28日 周六 09:00–14:00' }] });
  assert.match(free, /本周末还剩 10 小时/);
  assert.match(free, /11月28日 周六 09:00–14:00/);
});

test('专注时段：a part of the day stands for a default span, and a follow-up is read against the question asked', async () => {
  const { parseFocusWindow } = await import('../chat-actions.js');
  // "全天" maps straight to 09:00–22:00 on the days named; nothing is asked.
  assert.deepEqual(parseChatAction('我需要在周末的全天专注'), { kind: 'focus-window', weekday: null, weekend: { start: '09:00', end: '22:00' }, guessed: '全天 09:00–22:00' });
  // The follow-up names no days and has no 平时/经常 word of the old list: 常 now counts, and after a weekend question it is the weekend.
  const asked = parseChatAction('我需要在周末专注');
  assert.deepEqual(asked, { kind: 'focus-window', missing: true, days: { weekday: false, weekend: true } });
  assert.deepEqual(parseChatAction('常在下午专注', { afterAsk: asked.days }), { kind: 'focus-window', weekday: null, weekend: { start: '14:00', end: '18:00' }, guessed: '下午 14:00–18:00' });
  // Without the question, 常 alone is enough (weekday by default); 常常/经常/习惯/总是 likewise.
  assert.deepEqual(parseChatAction('常在下午专注'), { kind: 'focus-window', weekday: { start: '14:00', end: '18:00' }, weekend: null, guessed: '下午 14:00–18:00' });
  for (const [text, span] of [['我经常晚上最专注', ['19:00', '22:00']], ['习惯上午效率最高', ['08:00', '12:00']], ['总是傍晚状态最好', ['19:00', '22:00']], ['常常早上最清醒', ['08:00', '12:00']]]) {
    const hit = parseChatAction(text);
    assert.deepEqual([hit.weekday.start, hit.weekday.end], span, text);
  }
  // An explicit range still wins over the part of the day.
  assert.deepEqual(parseFocusWindow('我经常下午3点到5点专注'), { kind: 'focus-window', weekday: { start: '15:00', end: '17:00' }, weekend: null });
  // A bare answer to the question with no time at all asks again instead of becoming an item.
  assert.equal(parseChatAction('嗯，专注', { afterAsk: { weekday: false, weekend: true } }).missing, true);
  // An answer that only the question makes a focus answer is flagged, so agent.js can let a named task win.
  assert.equal(parseChatAction('下午专注写实验报告', { afterAsk: { weekday: true, weekend: false } }).byContext, true);
  // 非常/正常/日常 are not 常; without the question nothing is taken.
  assert.equal(parseChatAction('实验报告非常需要专注').kind, 'mark');
  assert.equal(parseChatAction('下午专注'), null);
  assert.equal(parseChatAction('正常下午专注'), null);
});

test('proposalCardMarkup renders confirmable cards for add_items, update_item, focus_window and replan_draft', async () => {
  const { proposalCardMarkup } = await import('../chat-actions.js');
  const addHtml = proposalCardMarkup({
    kind: 'add_items',
    items: [
      { kind: 'task', layer: 'deadline', title: '大创PPT', deadline_at: '2026-11-26T15:00:00+08:00', estimate_minutes: 180 },
      { kind: 'task', layer: 'personal', title: '复习高数', deadline_at: '2026-11-28T23:59:00+08:00' },
      { kind: 'event', layer: 'temporary', title: '主题大课', start_at: '2026-11-24T15:00:00+08:00', location: '中传礼堂' },
      { kind: 'event', layer: 'appointment', title: '吃火锅', start_at: '2026-11-27T19:00:00+08:00', end_at: '2026-11-27T21:00:00+08:00', location: '北门' },
    ],
    impact: { conflicts_before: 0, conflicts_after: 0, free_delta_minutes: -300 },
  }, 'prop-1');
  assert.match(addHtml, /待确认记入清单（4 项）/);
  assert.match(addHtml, /截止 · 大创PPT/);
  assert.match(addHtml, /个人任务 · 复习高数/);
  assert.match(addHtml, /点墨 · 主题大课/);
  assert.match(addHtml, /约定 · 吃火锅/);
  assert.match(addHtml, /data-proposal-adopt="prop-1"/);
  assert.match(addHtml, /本周留白 −5 小时/);

  const updHtml = proposalCardMarkup({
    kind: 'update_item',
    target_title: '大创PPT',
    action: 'update',
    changes: { deadline_at: { from: '2026-11-25T18:00:00+08:00', to: '2026-11-26T18:00:00+08:00' } },
  }, 'prop-2');
  assert.match(updHtml, /待确认改动「大创PPT」/);
  assert.match(updHtml, /采用这项改动/);

  const fwHtml = proposalCardMarkup({ kind: 'focus_window', weekend: { start: '14:00', end: '18:00' } }, 'prop-3');
  assert.match(fwHtml, /保存为常用专注时段/);
  assert.match(fwHtml, /14:00–18:00/);
});

test('parseRoughSchedule turns 研墨 natural-language slot requests into slotted 待办 items without touching clock/notice inputs', () => {
  const nowMs = Date.parse('2026-11-28T10:00:00+08:00');
  assert.deepEqual(
    parseRoughSchedule('请帮我在待办中安排明天上午学英语，下午写实验报告45分钟，晚上跑步', nowMs),
    {
      kind: 'rough-schedule',
      items: [
        { date: '2026-11-29', slot: 'chen', title: '学英语', minutes: null },
        { date: '2026-11-29', slot: 'bu', title: '写实验报告', minutes: 45 },
        { date: '2026-11-29', slot: 'mu', title: '跑步', minutes: null },
      ],
    },
  );
  assert.deepEqual(
    parseRoughSchedule('今天上午预习高数，下午写论文半小时', nowMs),
    {
      kind: 'rough-schedule',
      items: [
        { date: '2026-11-28', slot: 'chen', title: '预习高数', minutes: null },
        { date: '2026-11-28', slot: 'bu', title: '写论文', minutes: 30 },
      ],
    },
  );
  for (const skip of [
    '提醒我今天晚上9点前交实验报告',
    '明天下午三点半开会',
    '周末我有空',
    '我工作日晚上7点到9点最专注',
    '周三上午还有空吗？',
  ]) {
    assert.equal(parseRoughSchedule(skip, nowMs), null, skip);
  }
});
