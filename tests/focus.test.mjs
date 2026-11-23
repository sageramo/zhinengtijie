import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseStateSentence, draftLabel, previewRequest, confirmRequest, replanRange, normalizeFocus, setMark, setCommonWindows, addStates,
  pruneStates, daySegments, bandMarkup, bandUsed, replanMarkup, lockedRests, dayStartOf,
} from '../focus.js';

const fixtures = JSON.parse(readFileSync(new URL('../../campus-action-agent-back/examples/replan-fixtures.v1.json', import.meta.url), 'utf8')).fixtures;
const NOW = Date.parse('2026-11-25T13:30:00+08:00'); // a Wednesday afternoon

test('a sentence about rest, energy or an interruption becomes a draft with real times', () => {
  const rest = parseStateSentence('下午四点半到五点半想歇会儿', NOW);
  assert.equal(rest.kind, 'rest');
  assert.deepEqual([rest.rest.start, rest.rest.end, rest.rest.locked], ['2026-11-25T16:30:00+08:00', '2026-11-25T17:30:00+08:00', true]);
  const cut = parseStateSentence('三点到四点临时要帮辅导员搬东西', NOW);
  assert.equal(cut.kind, 'disruption');
  assert.deepEqual([cut.disruption.start_at, cut.disruption.end_at], ['2026-11-25T15:00:00+08:00', '2026-11-25T16:00:00+08:00']);
  const meeting = parseStateSentence('刚被拉去开会，3点到4点半', NOW);
  assert.equal(meeting.disruption.end_at, '2026-11-25T16:30:00+08:00');
  const low = parseStateSentence('晚上状态不好', NOW);
  assert.deepEqual([low.state.level, low.state.start_at, low.state.end_at], ['low', '2026-11-25T19:00:00+08:00', '2026-11-25T23:00:00+08:00']);
  assert.equal(parseStateSentence('有点累', NOW).state.start_at, '2026-11-25T13:30:00+08:00');
  assert.equal(parseStateSentence('今天好累，想早点休息', NOW).rest.start, '2026-11-25T21:30:00+08:00');
  assert.equal(parseStateSentence('明天上午九点到十点想睡一会', NOW).rest.start, '2026-11-26T09:00:00+08:00');
  assert.match(draftLabel(rest), /留出休息 11月25日 周三 16:30–17:30/);
  // Said in the morning, a bare "三点" is still the afternoon, and "十点" stays the morning.
  const morning = Date.parse('2026-11-25T08:00:00+08:00');
  assert.equal(parseStateSentence('三点到四点临时要帮辅导员搬东西', morning).disruption.start_at, '2026-11-25T15:00:00+08:00');
  assert.equal(parseStateSentence('三点到四点临时要帮辅导员搬东西', morning).disruption.title, '帮辅导员搬东西');
  assert.equal(parseStateSentence('十点到十一点半临时开项目复盘会', morning).disruption.start_at, '2026-11-25T10:00:00+08:00');
});

test('an interruption without times asks for them; reminders, notices and questions are not states', () => {
  assert.equal(parseStateSentence('临时被叫去开会', NOW).missing, '什么时候到什么时候');
  // Real user trial regressions: weekday/date schedules go to /api/v3/extract instead of disruption,
  // and today/tomorrow disruptions with a second period word or 中午 start parse cleanly.
  for (const text of ['提醒我今天交报告', '我这周末要写高数作业', '周末我有没有时间？', '【通知】明天下午三点开会', '周一中午到晚上五点开会', '周一中午十二点到下午五点开会', '11月26日下午三点排练']) {
    assert.equal(parseStateSentence(text, NOW), null, text);
  }
  const morning = Date.parse('2026-11-25T09:00:00+08:00');
  const noonCut = parseStateSentence('临时中午十二点到下午五点开会', morning);
  assert.equal(noonCut.disruption.title, '开会');
  assert.equal(noonCut.disruption.start_at, '2026-11-25T12:00:00+08:00');
  assert.equal(noonCut.disruption.end_at, '2026-11-25T17:00:00+08:00');
  const noonBare = parseStateSentence('临时中午到晚上五点开会', morning);
  assert.equal(noonBare.disruption.title, '开会');
  assert.equal(noonBare.disruption.start_at, '2026-11-25T12:00:00+08:00');
  assert.equal(noonBare.disruption.end_at, '2026-11-25T17:00:00+08:00');
  assert.equal(parseStateSentence('我今天状态不太好', morning)?.state?.level, 'low');
  assert.equal(parseStateSentence('我今天精力不太好', morning)?.state?.level, 'low');
  assert.equal(parseStateSentence('我今天进行了智能体节的路演，精力有点差', morning)?.state?.level, 'low');
  assert.equal(parseStateSentence('下午状态有些不在线', morning)?.state?.level, 'low');
  assert.equal(parseStateSentence('我今天精力很充沛', morning)?.state?.level, 'high');
});

test('settings keep only valid windows, states and marks, and drop stale states', () => {
  let focus = normalizeFocus({ windows: [{ weekdays: [1, 9], start: '19:00', end: '21:00' }, { weekdays: [1], start: '21:00', end: '20:00' }], states: [{ level: 'low', start_at: 'x', end_at: 'y' }], marks: { a: 'focus', b: 'nope' } });
  assert.deepEqual(focus.windows.map(w => w.weekdays), [[1]]);
  assert.deepEqual(focus, { ...focus, states: [], marks: { a: 'focus' } });
  focus = setMark(focus, 'a', 'focus');
  assert.deepEqual(focus.marks, {});
  focus = setCommonWindows(focus, { weekday: { start: '19:00', end: '21:00' }, weekend: null });
  assert.deepEqual(focus.windows, [{ id: 'w-weekday', weekdays: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }]);
  assert.throws(() => setCommonWindows(focus, { weekday: { start: '21:00', end: '19:00' } }), /晚于开始/);
  focus = addStates(focus, [{ id: 's1', level: 'low', start_at: '2026-11-20T10:00:00+08:00', end_at: '2026-11-20T12:00:00+08:00', text: '累' }]);
  assert.equal(pruneStates(focus, NOW).states.length, 0);
});

test('the preview request carries common windows, said states, marks and the draft in the backend contract', () => {
  const snapshot = fixtures.success_replan.preview_request.snapshot;
  const focus = setMark(setCommonWindows(normalizeFocus(null), { weekday: { start: '14:00', end: '16:00' } }), 't-math-hw', 'focus');
  const draft = parseStateSentence('十点到十一点半临时开项目复盘会', Date.parse('2026-11-25T08:00:00+08:00'));
  const body = previewRequest({ snapshot, focus, draft, now: Date.parse('2026-11-25T08:00:30+08:00'), range: { from: '2026-11-23', to: '2026-11-29' }, history: [{ estimated_minutes: 30, actual_minutes: 45 }] });
  assert.deepEqual(body.focus_windows, [{ weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '16:00', level: 'high', label: '常用专注时段' }]);
  assert.deepEqual(body.task_profiles, { 't-math-hw': { cognitive_load: 'high' } });
  assert.equal(body.disruptions[0].start_at, '2026-11-25T10:00:00+08:00');
  assert.equal(body.now, '2026-11-25T08:00:00+08:00');
  assert.equal(body.calibration_history, undefined, 'one sample is not a calibration');
  const preview = fixtures.success_replan.preview_response;
  const plan = preview.candidate_plans.find(item => item.recommended);
  assert.deepEqual(Object.keys(confirmRequest({ snapshot, range: body.range, preview, plan })).sort(), Object.keys(fixtures.success_replan.confirm_request).sort());
});

test('a replan looks from this Monday to the latest deadline, not only at this week', () => {
  const snapshot = fixtures.success_replan.preview_request.snapshot;
  const sunday = Date.parse('2026-11-22T01:17:00+08:00');
  const nextWeek = { ...snapshot, reference_time: '2026-11-25T13:30:00+08:00', tasks: snapshot.tasks.map(task => ({ ...task, deadline_at: '2026-11-25T18:00:00+08:00' })) };
  assert.deepEqual(replanRange(nextWeek, null, sunday), { from: '2026-11-16', to: '2026-11-25' });
  assert.deepEqual(replanRange({ ...nextWeek, tasks: [], reference_time: '2026-11-22T01:00:00+08:00' }, null, sunday), { from: '2026-11-16', to: '2026-11-22' });
  const far = { ...nextWeek, tasks: [{ ...nextWeek.tasks[0], deadline_at: '2027-02-01T12:00:00+08:00' }] };
  assert.equal(replanRange(far, null, sunday).to, '2026-12-16', 'capped at 31 days, the backend limit');
  const preview = fixtures.success_replan.preview_response;
  const plan = preview.candidate_plans[0];
  assert.equal(confirmRequest({ snapshot, range: {}, preview, plan, now: '2026-11-22T01:17:00+08:00' }).now, '2026-11-22T01:17:00+08:00');
});

test('the 重排卡 says why, from when to when, each plan\'s cost, and a five-minute start', () => {
  const preview = fixtures.success_replan.preview_response;
  const draft = parseStateSentence('十点到十一点半临时开项目复盘会', Date.parse('2026-11-25T08:00:00+08:00'));
  const html = replanMarkup({ preview, draft, chosen: null });
  const recommended = preview.candidate_plans.find(plan => plan.recommended);
  assert.match(html, new RegExp(`采用「${recommended.name}」`));
  assert.match(html, /为什么改/);
  assert.match(html, /从几点移到几点/);
  for (const change of recommended.task_changes.filter(item => item.changed)) assert.ok(html.includes(`「${change.title}」`));
  assert.match(html, /推荐/);
  const other = preview.candidate_plans.find(plan => !plan.recommended);
  if (other?.tradeoff_vs_recommended) assert.ok(html.includes(other.tradeoff_vs_recommended));
  assert.match(html, /开始 5 分钟/);
  assert.match(replanMarkup({ preview, draft, chosen: other.plan_id }), new RegExp(`采用「${other.name}」`));
  const infeasible = replanMarkup({ preview: fixtures.infeasible_before_deadline.preview_response, draft });
  assert.match(infeasible, /截止前排不下/);
  assert.match(infeasible, /还差 1 小时/);
  assert.doesNotMatch(infeasible, /data-rp-apply/);
});

test('the band draws each interval with its source, and rests written by a confirmed replan', () => {
  const snapshot = fixtures.success_replan.confirm_response.snapshot;
  assert.deepEqual(lockedRests(snapshot).map(rest => rest.label), ['午休恢复']);
  const focus = setCommonWindows(normalizeFocus(null), { weekday: { start: '14:00', end: '16:00' } });
  const day = dayStartOf(Date.parse('2026-11-25T12:00:00+08:00'));
  assert.deepEqual(daySegments(focus, snapshot, day).map(s => [s.kind, s.source]), [['rest', '研墨 · 休息“午休恢复”'], ['focus', '铺纸 · 常用专注时段']]);
  const band = bandMarkup(focus, snapshot, day, 8, 22);
  assert.match(band, /fb-focus/);
  assert.match(band, /left:42\.86%;width:14\.29%/); // 14:00–16:00 across 08:00–22:00
  assert.equal(bandUsed(normalizeFocus(null), fixtures.success_replan.preview_request.snapshot), false);
});
