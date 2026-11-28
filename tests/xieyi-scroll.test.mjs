import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GOAL_HORIZONS,
  SLOTS,
  addGoal,
  addNote,
  addTimeLog,
  createXieyiState,
  ledgerMarkup,
  markNotePromoted,
  normalizeXieyiState,
  periodKeyFor,
  removeGoal,
  removeNote,
  removeTimeLog,
  setGoalTab,
  setScrollMode,
  slotSummary,
  toggleGoal,
  toggleNote,
  weeklyLedgerStats,
  xieyiBoardMarkup,
} from '../xieyi-scroll.js';
import { xieyiShanshuiMarkup } from '../shanshui.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/calendar-v3.json', import.meta.url), 'utf8'));
const MONDAY = Date.parse('2026-11-09T00:00:00+08:00');
const DAY = 86400000;

test('xieyi state lifecycle manages goals, four-slot rough notes, and study/leisure logs', () => {
  let state = createXieyiState();
  assert.equal(SLOTS.map(s => s.name).join(''), '晨午晡暮');
  assert.equal(GOAL_HORIZONS.map(h => h.name).join('/'), '周志/月志/学期志');
  assert.equal(periodKeyFor('week', MONDAY), '2026-W46');
  assert.equal(periodKeyFor('month', MONDAY), '2026-11');
  assert.equal(periodKeyFor('term', MONDAY), '2026-秋');

  state = setScrollMode(state, 'xieyi');
  state = setGoalTab(state, 'month');
  assert.equal(state.mode, 'xieyi');
  assert.equal(state.goalTab, 'month');

  state = addGoal(state, { horizon: 'week', periodKey: '2026-W46', title: '完成三维视觉基线复现' });
  const gid = state.goals[0].id;
  state = toggleGoal(state, gid);
  assert.equal(state.goals[0].done, true);

  state = addNote(state, { date: '2026-11-10', slot: 'chen', title: '过一遍相机标定推导', goalId: gid });
  const nid = state.notes[0].id;
  state = toggleNote(state, nid);
  state = markNotePromoted(state, nid, 't-p1');
  assert.deepEqual([state.notes[0].done, state.notes[0].promotedTaskId], [true, 't-p1']);

  state = addTimeLog(state, { kind: 'study', title: '相机标定阅读', minutes: 50, date: '2026-11-10' });
  state = addTimeLog(state, { kind: 'leisure', title: '散步听歌', minutes: 25, date: '2026-11-10' });
  const stats = weeklyLedgerStats(state, fixture.result, MONDAY);
  assert.equal(stats.studyMinutes, 50);
  assert.equal(stats.leisureMinutes, 25);
  assert.equal(stats.plannedWorkMinutes, 120);
  assert.equal(stats.daily[1].study, 50);
  assert.equal(stats.daily[1].leisure, 25);

  const normalized = normalizeXieyiState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(normalized.goals, state.goals);
  assert.deepEqual(normalized.notes, state.notes);
  assert.deepEqual(normalized.logs, state.logs);

  state = removeTimeLog(state, state.logs[0].id);
  state = removeNote(state, nid);
  state = removeGoal(state, gid);
  assert.deepEqual([state.goals.length, state.notes.length, state.logs.length], [0, 0, 1]);
});

test('slotSummary projects real free capacity and busy items per classical period', () => {
  const chen = slotSummary(fixture.result, MONDAY, SLOTS[0]);
  assert.equal(chen.freeMinutes, 0);
  assert.equal(chen.density, 'is-full');
  assert.ok(chen.busyItems.some(item => item.title === '高等数学'));
  assert.ok(chen.busyItems.some(item => item.title === '讲座'));

  const bu = slotSummary(fixture.result, MONDAY + DAY, SLOTS[2]);
  assert.equal(bu.freeMinutes, 270);
  assert.equal(bu.density, 'is-open');

  const undefinedSlot = slotSummary({ ...fixture.result, definition: { free_time: 'undefined' } }, MONDAY, SLOTS[0]);
  assert.equal(undefinedSlot.label, '');
  assert.equal(slotSummary(null, MONDAY, SLOTS[0]).label, '');
});

test('xieyiBoardMarkup stays cleanly free of 未定作息 and ledger, while ledgerMarkup & xieyiShanshuiMarkup render Song-Yuan surfaces', () => {
  let state = setScrollMode(createXieyiState(), 'xieyi');
  state = addGoal(state, { horizon: 'week', periodKey: periodKeyFor('week', MONDAY), title: '梳理智能体闭环' });
  state = addNote(state, { date: '2026-11-11', slot: 'bu', title: '整理摄影社报名资料' });
  state = addTimeLog(state, { kind: 'study', title: '读控制论论文', minutes: 45, date: '2026-11-11' });

  const html = xieyiBoardMarkup({ state, result: fixture.result, start: MONDAY, now: MONDAY + DAY });
  assert.match(html, /远山志/);
  assert.match(html, /周志/);
  assert.match(html, /整理摄影社报名资料/);
  assert.match(html, /入工笔/);
  assert.match(html, /<strong>晨<\/strong><small>上午<\/small>/);
  assert.match(html, /<strong>暮<\/strong><small>晚间<\/small>/);
  assert.doesNotMatch(html, /未定作息/);
  assert.doesNotMatch(html, /本周学休账卷/);

  const side = ledgerMarkup({ state, result: fixture.result, start: MONDAY, now: MONDAY + DAY, snapshot: fixture.snapshot, compact: true });
  assert.match(side, /xy-ledger is-compact/);
  assert.match(side, /xy-log-fold/);
  assert.match(side, /读控制论论文/);

  const svg = xieyiShanshuiMarkup({ state, start: MONDAY, now: MONDAY + DAY, weekGoals: ['梳理智能体闭环'] });
  assert.match(svg, /shanshui-xieyi/);
  assert.match(svg, /xy-bamboo-culm/);
  assert.match(svg, /xy-skiff/);
  assert.match(svg, /远山志 · 梳理智能体闭环/);
  assert.match(svg, /class="ss-seal is-xieyi"/);
  assert.match(svg, />写<\/text>/);
  assert.match(svg, />意<\/text>/);
  assert.match(svg, /四时烟水/);
});
