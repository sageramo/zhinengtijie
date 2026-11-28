import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANION_PRESETS,
  companionMarkup,
  companionWhisper,
  createSoundscape,
  formatClock,
  resolveScene,
  suggestGapSession,
} from '../companion.js';

const T = iso => Date.parse(iso);

test('formatClock, resolveScene, and companionWhisper cover study/leisure states', () => {
  assert.equal(formatClock(2705), '45:05');
  assert.equal(formatClock(0), '00:00');
  assert.equal(resolveScene('auto', T('2026-11-28T14:00:00+08:00')), 'day');
  assert.equal(resolveScene('auto', T('2026-11-28T21:00:00+08:00')), 'night');
  assert.equal(resolveScene('day', T('2026-11-28T23:00:00+08:00')), 'day');
  assert.deepEqual(COMPANION_PRESETS.study, [15, 25, 45, 60]);
  assert.match(companionWhisper({ mode: 'study', progress: 0.5, running: true }), /窗外山静/);
  assert.match(companionWhisper({ mode: 'leisure', progress: 0.2, running: true }), /檐雨敲竹/);
  assert.match(companionWhisper({ mode: 'study', finished: true }), /砚耕/);
});

test('suggestGapSession computes gap-aware incense duration before upcoming course and during active work', () => {
  const calendarResult = {
    layers: {
      routine: [{ id: 'r1', title: '高等数学', start: '2026-11-28T15:00:00+08:00', end: '2026-11-28T16:40:00+08:00' }],
      temporary: [],
      appointment: [],
      work: [{ task_id: 't1', title: '课程报告', start: '2026-11-28T10:00:00+08:00', end: '2026-11-28T11:30:00+08:00' }],
    },
  };
  const duringWork = suggestGapSession(calendarResult, T('2026-11-28T10:42:00+08:00'));
  assert.equal(duringWork.kind, 'active_work');
  assert.equal(duringWork.minutes, 45);
  assert.equal(duringWork.taskId, 't1');

  const beforeClass = suggestGapSession(calendarResult, T('2026-11-28T14:12:00+08:00'));
  assert.equal(beforeClass.kind, 'before_fixed');
  assert.equal(beforeClass.minutes, 40);
  assert.equal(beforeClass.cushion, 8);
  assert.match(beforeClass.reason, /高等数学/);

  const openGap = suggestGapSession(null, T('2026-11-28T14:00:00+08:00'));
  assert.equal(openGap.kind, 'open');
  assert.equal(openGap.minutes, 45);
});

test('createSoundscape degrades safely without Web Audio and companionMarkup renders custom study art', () => {
  const sound = createSoundscape({});
  assert.equal(sound.isSupported(), false);
  sound.setChannel('rain', 0.5);
  sound.playChime();
  sound.stopAll();

  const html = companionMarkup({
    mode: 'study',
    resolvedScene: 'night',
    durationMinutes: 45,
    remainingSeconds: 2700,
    suggestion: suggestGapSession(null),
    todayStats: { study: 45, leisure: 20 },
    soundSupported: false,
  });
  assert.match(html, /study-desk-day\.webp/);
  assert.match(html, /study-desk-night\.webp/);
  assert.match(html, /is-night/);
  assert.match(html, /依隙定香/);
  assert.match(html, /45:00/);
  assert.match(html, /今日砚耕 <b>45<\/b> 分/);
});
