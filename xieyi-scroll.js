/**
 * 写意 · 四时手卷（周/月/学期志 + 晨/午/晡/暮轻待办）与学休账卷（砚耕 / 闲暇）。
 * 纯状态变换 + 宣纸水墨 HTML 片段渲染，不绑定 DOM，可独立单测。
 */
import { isRoughPersonalBounds } from './time-state.js';

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;
const OFFSET = 8 * HOUR;

export const XIEYI_STORAGE_KEY = 'sixu.xieyi.v1';

export const SLOTS = [
  { key: 'chen', name: '晨', gloss: '上午', startHour: 6, endHour: 12 },
  { key: 'wu', name: '午', gloss: '中午', startHour: 12, endHour: 14 },
  { key: 'bu', name: '晡', gloss: '下午', startHour: 14, endHour: 18.5 },
  { key: 'mu', name: '暮', gloss: '晚间', startHour: 18.5, endHour: 24 },
];

export const GOAL_HORIZONS = [
  { key: 'week', name: '周志', gloss: '本周目标' },
  { key: 'month', name: '月志', gloss: '本月目标' },
  { key: 'term', name: '学期志', gloss: '本学期目标' },
];

export const TIERS = [
  { key: 'all', name: '全部' },
  { key: 'timed', name: '定时' },
  { key: 'deadline', name: '定期限' },
  { key: 'day', name: '定日' },
  { key: 'pending', name: '待定' },
];

export const SLOT_NAMES = Object.fromEntries(SLOTS.map(s => [s.key, `${s.name} · ${s.gloss}`]));

const SLOT_KEYS = new Set(SLOTS.map(s => s.key));
const HORIZON_KEYS = new Set(GOAL_HORIZONS.map(h => h.key));
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const localDateObj = ms => new Date(ms + OFFSET);
const dateStr = ms => localDateObj(ms).toISOString().slice(0, 10);
const shortDate = ymd => {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}月${d}日`;
};
const minutesLabel = value => {
  const total = Math.max(0, Math.round(value));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}分`;
  return m ? `${h}小时${m}分` : `${h}小时`;
};
const newId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`}`;

export function inferSlotFromText(text) {
  const s = String(text || '');
  if (/早上|清晨|今早|明早|上午|早间|早起/.test(s)) return 'chen';
  if (/中午|正午|午间|午饭后/.test(s)) return 'wu';
  if (/下午|午后|傍晚前/.test(s)) return 'bu';
  if (/今晚|明晚|晚上|夜间|晚间|夜里|睡前|傍晚/.test(s)) return 'mu';
  return null;
}

/** Map a Beijing ISO timestamp into the four classical periods: 晨 / 午 / 晡 / 暮. */
export function slotFromTimestamp(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  const d = localDateObj(ms);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h < 12) return 'chen';
  if (h < 14) return 'wu';
  if (h < 18.5) return 'bu';
  return 'mu';
}

const isPersonalTask = task => Array.isArray(task?.notes) && task.notes.includes('个人任务');
const hasTaskClock = task => isPersonalTask(task) && Boolean(task?.deadline_at)
  && !isRoughPersonalBounds(task);
const taskDay = task => {
  const iso = task?.earliest_start_at || task?.deadline_at;
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? dateStr(ms) : iso.slice(0, 10);
};

/**
 * 统一事项池的四档精度判定：定时 / 定期限 / 定日 / 待定。
 * 工笔与写意从此一处各自取数，再无双份清单歧义。
 */
export function itemTier(item, kind = 'task') {
  if (!item) return 'pending';
  if (kind === 'event' || item.deadline_at === undefined) {
    return item.start_at && item.end_at ? 'timed' : 'pending';
  }
  if (!item.deadline_at && !item.earliest_start_at) return 'pending';
  if (hasTaskClock(item)) return 'timed';
  if (isPersonalTask(item) && item.estimate_minutes === null) return 'day';
  return 'deadline';
}

export function createXieyiState() {
  return { version: 2, mode: 'gongbi', goalTab: 'week', goals: [], slots: {}, notes: [], logs: [] };
}

export function normalizeXieyiState(raw) {
  const base = createXieyiState();
  if (!raw || typeof raw !== 'object') return base;
  if (raw.mode === 'gongbi' || raw.mode === 'xieyi') base.mode = raw.mode;
  if (HORIZON_KEYS.has(raw.goalTab)) base.goalTab = raw.goalTab;
  if (raw.slots && typeof raw.slots === 'object' && !Array.isArray(raw.slots)) {
    const cleanSlots = {};
    for (const [tid, slot] of Object.entries(raw.slots).slice(-600)) {
      if (tid && SLOT_KEYS.has(slot)) cleanSlots[String(tid)] = slot;
    }
    base.slots = cleanSlots;
  }
  if (Array.isArray(raw.goals)) {
    base.goals = raw.goals
      .filter(g => g && typeof g.title === 'string' && g.title.trim() && HORIZON_KEYS.has(g.horizon) && typeof g.periodKey === 'string')
      .slice(-120)
      .map(g => ({
        id: String(g.id || newId('xg')),
        horizon: g.horizon,
        periodKey: g.periodKey.slice(0, 24),
        title: g.title.trim().slice(0, 80),
        done: Boolean(g.done),
      }));
  }
  if (Array.isArray(raw.notes)) {
    base.notes = raw.notes
      .filter(n => n && typeof n.title === 'string' && n.title.trim() && DATE_RE.test(n.date || '') && SLOT_KEYS.has(n.slot))
      .slice(-400)
      .map(n => ({
        id: String(n.id || newId('xn')),
        date: n.date,
        slot: n.slot,
        title: n.title.trim().slice(0, 120),
        done: Boolean(n.done),
        goalId: n.goalId ? String(n.goalId) : null,
        promotedTaskId: n.promotedTaskId ? String(n.promotedTaskId) : null,
      }));
  }
  if (Array.isArray(raw.logs)) {
    base.logs = raw.logs
      .filter(l => l && (l.kind === 'study' || l.kind === 'leisure') && Number.isFinite(Number(l.minutes)) && Number(l.minutes) >= 1 && DATE_RE.test(l.date || ''))
      .slice(-500)
      .map(l => ({
        id: String(l.id || newId('xl')),
        kind: l.kind,
        title: (typeof l.title === 'string' && l.title.trim() ? l.title.trim() : (l.kind === 'study' ? '专注砚耕' : '留白休歇')).slice(0, 80),
        minutes: Math.min(720, Math.max(1, Math.round(Number(l.minutes)))),
        date: l.date,
        taskId: l.taskId ? String(l.taskId) : null,
        source: l.source === 'focus' ? 'focus' : 'manual',
        at: Number.isFinite(Number(l.at)) ? Number(l.at) : Date.now(),
      }));
  }
  return base;
}

export function setTaskSlot(state, taskId, slot) {
  if (!taskId || !SLOT_KEYS.has(slot)) return state;
  return { ...state, slots: { ...(state.slots || {}), [String(taskId)]: slot } };
}

export function removeTaskSlot(state, taskId) {
  if (!taskId || !state.slots?.[taskId]) return state;
  const nextSlots = { ...state.slots };
  delete nextSlots[taskId];
  return { ...state, slots: nextSlots };
}

/**
 * 一次性把旧版独立存储的写意四时笔记迁移成「定日」个人任务，保留晨/午/晡/暮时段并清空旧 notes。
 */
export function migrateLegacyNotes(xieyiState, snapshot, addPersonalTaskFn, updateTaskFn) {
  const legacy = xieyiState?.notes || [];
  if (!legacy.length) return { xieyi: xieyiState, snapshot, migrated: false };
  let nextSnap = snapshot;
  let nextXieyi = { ...xieyiState, slots: { ...(xieyiState.slots || {}) } };
  const existingIds = new Set((nextSnap?.tasks || []).map(t => t.id));
  for (const note of legacy) {
    if (note.promotedTaskId && existingIds.has(note.promotedTaskId)) {
      nextXieyi.slots[note.promotedTaskId] = note.slot;
      continue;
    }
    if (typeof addPersonalTaskFn !== 'function') continue;
    nextSnap = addPersonalTaskFn(nextSnap, { title: note.title, day: note.date, estimate_minutes: null });
    const created = nextSnap.tasks[nextSnap.tasks.length - 1];
    if (note.done && typeof updateTaskFn === 'function') {
      nextSnap = updateTaskFn(nextSnap, created.id, { status: 'completed' });
    }
    nextXieyi.slots[created.id] = note.slot;
    existingIds.add(created.id);
  }
  nextXieyi.notes = [];
  return { xieyi: normalizeXieyiState(nextXieyi), snapshot: nextSnap, migrated: true };
}

export function readXieyi(storage) {
  try {
    const raw = storage?.getItem?.(XIEYI_STORAGE_KEY);
    return raw ? normalizeXieyiState(JSON.parse(raw)) : createXieyiState();
  } catch {
    return createXieyiState();
  }
}

export function writeXieyi(storage, state) {
  try {
    storage?.setItem?.(XIEYI_STORAGE_KEY, JSON.stringify(normalizeXieyiState(state)));
  } catch {
    /* keep in memory when storage unavailable */
  }
}

export function periodKeyFor(horizon, weekStartMs) {
  const thursday = localDateObj(weekStartMs + 3 * DAY);
  const year = thursday.getUTCFullYear();
  if (horizon === 'week') {
    const jan1 = Date.UTC(year, 0, 1);
    const weekNo = Math.floor((thursday.getTime() - jan1) / (7 * DAY)) + 1;
    return `${year}-W${String(weekNo).padStart(2, '0')}`;
  }
  if (horizon === 'month') {
    const month = String(thursday.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
  const m = thursday.getUTCMonth() + 1;
  return `${year}-${m >= 2 && m <= 7 ? '春' : '秋'}`;
}

export function setScrollMode(state, mode) {
  return mode === 'gongbi' || mode === 'xieyi' ? { ...state, mode } : state;
}

export function setGoalTab(state, goalTab) {
  return HORIZON_KEYS.has(goalTab) ? { ...state, goalTab } : state;
}

export function addGoal(state, { horizon, periodKey, title }) {
  const clean = typeof title === 'string' ? title.trim().slice(0, 80) : '';
  if (!HORIZON_KEYS.has(horizon) || !periodKey || !clean) throw new Error('目标名称不能为空');
  return {
    ...state,
    goals: [...state.goals, { id: newId('xg'), horizon, periodKey: String(periodKey), title: clean, done: false }],
  };
}

export function toggleGoal(state, id) {
  return { ...state, goals: state.goals.map(g => (g.id === id ? { ...g, done: !g.done } : g)) };
}

export function removeGoal(state, id) {
  return { ...state, goals: state.goals.filter(g => g.id !== id) };
}

export function addNote(state, { date, slot, title, goalId = null }) {
  const clean = typeof title === 'string' ? title.trim().slice(0, 120) : '';
  if (!DATE_RE.test(date || '') || !SLOT_KEYS.has(slot) || !clean) throw new Error('请写下要做的事');
  return {
    ...state,
    notes: [...state.notes, { id: newId('xn'), date, slot, title: clean, done: false, goalId: goalId || null, promotedTaskId: null }],
  };
}

export function toggleNote(state, id) {
  return { ...state, notes: state.notes.map(n => (n.id === id ? { ...n, done: !n.done } : n)) };
}

export function removeNote(state, id) {
  return { ...state, notes: state.notes.filter(n => n.id !== id) };
}

export function markNotePromoted(state, id, taskId) {
  return { ...state, notes: state.notes.map(n => (n.id === id ? { ...n, promotedTaskId: taskId } : n)) };
}

export function addTimeLog(state, { kind, title, minutes, date, taskId = null, source = 'manual', at = Date.now() }) {
  if (kind !== 'study' && kind !== 'leisure') throw new Error('类型只能是砚耕或闲暇');
  const mins = Math.round(Number(minutes));
  if (!Number.isFinite(mins) || mins < 1 || mins > 720) throw new Error('时长需在 1 到 720 分钟之间');
  if (!DATE_RE.test(date || '')) throw new Error('日期无效');
  const cleanTitle = typeof title === 'string' && title.trim()
    ? title.trim().slice(0, 80)
    : (kind === 'study' ? '专注砚耕' : '留白休歇');
  return {
    ...state,
    logs: [...state.logs, { id: newId('xl'), kind, title: cleanTitle, minutes: mins, date, taskId: taskId || null, source: source === 'focus' ? 'focus' : 'manual', at }],
  };
}

export function removeTimeLog(state, id) {
  return { ...state, logs: state.logs.filter(l => l.id !== id) };
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.round((Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / MINUTE));
}

function subtractSpans(baseSpans, busySpans) {
  let out = baseSpans.filter(([s, e]) => e > s);
  for (const [bs, be] of busySpans) {
    if (be <= bs) continue;
    const next = [];
    for (const [s, e] of out) {
      if (be <= s || bs >= e) { next.push([s, e]); continue; }
      if (bs > s) next.push([s, bs]);
      if (be < e) next.push([be, e]);
    }
    out = next;
  }
  return out;
}

/**
 * 从四层工笔结果投影单个四时格的真实余留白与已有底色/点墨提示。
 */
export function slotSummary(result, dayStartMs, slot) {
  const s = dayStartMs + slot.startHour * HOUR;
  const e = dayStartMs + slot.endHour * HOUR;
  const busyItems = [];
  if (!result?.layers) {
    return { freeMinutes: null, busyItems, density: 'is-unknown', label: '' };
  }
  const pushBusy = (layer, list) => {
    for (const item of list || []) {
      const is = Date.parse(item.start);
      const ie = Date.parse(item.end);
      if (Number.isFinite(is) && Number.isFinite(ie) && ie > s && is < e) {
        busyItems.push({ id: item.task_id || item.id || '', layer, title: item.title || '事项', start: is, end: ie });
      }
    }
  };
  pushBusy('routine', result.layers.routine);
  pushBusy('temporary', result.layers.temporary);
  pushBusy('appointment', result.layers.appointment);
  pushBusy('work', result.layers.work);
  busyItems.sort((a, b) => a.start - b.start);

  if (result.definition?.free_time !== 'defined') {
    return { freeMinutes: null, busyItems, density: 'is-unknown', label: '' };
  }
  const rawFree = (result.layers.free || [])
    .map(f => [Math.max(s, Date.parse(f.start)), Math.min(e, Date.parse(f.end))])
    .filter(([fs, fe]) => fe > fs);
  const workSpans = (result.layers.work || [])
    .map(w => [Date.parse(w.start), Date.parse(w.end)])
    .filter(([ws, we]) => we > ws);
  const remainSpans = subtractSpans(rawFree, workSpans);
  const freeMinutes = remainSpans.reduce((sum, [rs, re]) => sum + overlapMinutes(rs, re, s, e), 0);

  let density = 'is-open';
  let label = `余留白 ${minutesLabel(freeMinutes)}`;
  if (freeMinutes <= 15) {
    density = 'is-full';
    label = busyItems.some(b => b.layer === 'routine') ? '底色已满' : '余暇极少';
  } else if (freeMinutes < 90) {
    density = 'is-tight';
    const hasRoutine = busyItems.some(b => b.layer === 'routine');
    label = hasRoutine ? `有底色 · 余 ${minutesLabel(freeMinutes)}` : `余 ${minutesLabel(freeMinutes)}`;
  }
  return { freeMinutes, busyItems, density, label };
}

/** 汇总指定周次 [start, start + 7d) 内的砚耕、闲暇与计划落笔。 */
export function weeklyLedgerStats(state, result, weekStartMs) {
  const days = Array.from({ length: 7 }, (_, idx) => {
    const ymd = dateStr(weekStartMs + idx * DAY);
    return { date: ymd, weekday: WEEKDAYS[idx], study: 0, leisure: 0 };
  });
  const byDate = new Map(days.map(d => [d.date, d]));
  const inWeekLogs = [];
  for (const log of state.logs || []) {
    const bucket = byDate.get(log.date);
    if (!bucket) continue;
    if (log.kind === 'study') bucket.study += log.minutes;
    else bucket.leisure += log.minutes;
    inWeekLogs.push(log);
  }
  const studyMinutes = days.reduce((s, d) => s + d.study, 0);
  const leisureMinutes = days.reduce((s, d) => s + d.leisure, 0);
  const weekEndMs = weekStartMs + 7 * DAY;
  const plannedWorkMinutes = (result?.layers?.work || []).reduce((sum, w) => {
    const ws = Date.parse(w.start);
    const we = Date.parse(w.end);
    if (!Number.isFinite(ws) || !Number.isFinite(we)) return sum;
    return sum + overlapMinutes(ws, we, weekStartMs, weekEndMs);
  }, 0);
  const recentLogs = [...inWeekLogs].sort((a, b) => b.at - a.at).slice(0, 8);
  return { studyMinutes, leisureMinutes, plannedWorkMinutes, daily: days, recentLogs };
}

/**
 * 渲染「本周学休账卷」（嵌于解析画卷侧栏与案头伴读抽屉的宋元账帖卡片）。
 */
export function ledgerMarkup({ state, result, start, now = Date.now(), snapshot = null, compact = false } = {}) {
  const stats = weeklyLedgerStats(state, result, start);
  const totalLogged = stats.studyMinutes + stats.leisureMinutes;
  const studyPct = totalLogged ? Math.round((stats.studyMinutes / totalLogged) * 100) : 0;
  const leisurePct = totalLogged ? 100 - studyPct : 0;
  const maxDay = Math.max(60, ...stats.daily.map(d => Math.max(d.study, d.leisure)));
  const todayYmd = dateStr(now);
  const weekStartYmd = stats.daily[0].date;
  const defaultDate = stats.daily.some(d => d.date === todayYmd) ? todayYmd : weekStartYmd;
  const activeTasks = (snapshot?.tasks || []).filter(t => t.status === 'active');

  const bars = stats.daily.map(d => {
    const sh = d.study ? Math.max(6, Math.round((d.study / maxDay) * 100)) : 0;
    const lh = d.leisure ? Math.max(6, Math.round((d.leisure / maxDay) * 100)) : 0;
    return `<div class="xy-daybar${d.date === todayYmd ? ' is-today' : ''}" title="${d.weekday}：砚耕 ${minutesLabel(d.study)} · 闲暇 ${minutesLabel(d.leisure)}"><div class="xy-cols"><i class="xy-col is-study" style="height:${sh}%"></i><i class="xy-col is-leisure" style="height:${lh}%"></i></div><span>${d.weekday.replace('周', '')}</span></div>`;
  }).join('');

  const taskOptions = activeTasks.length
    ? `<select name="taskId" class="xy-log-task" aria-label="关联落笔事项（可选）"><option value="">不关联特定落笔</option>${activeTasks.map(t => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.title)}${t.estimate_minutes ? `（${t.estimate_minutes}分）` : ''}</option>`).join('')}</select>`
    : '';

  const shownLogs = compact ? stats.recentLogs.slice(0, 5) : stats.recentLogs;
  const recentList = shownLogs.length
    ? `<ul class="xy-log-list">${shownLogs.map(log => `<li class="xy-log-item is-${log.kind}"><i class="xy-log-dot" aria-hidden="true"></i><span class="xy-log-title">${escapeHTML(log.title)}</span><b>${minutesLabel(log.minutes)} · ${shortDate(log.date)}</b><button type="button" class="xy-del" data-xy-log-del="${escapeHTML(log.id)}" aria-label="删去此笔记录">×</button></li>`).join('')}</ul>`
    : '<p class="xy-empty-hint">本周尚未落账，专注或手动记一笔后会显于此处。</p>';

  return `<section class="xy-ledger${compact ? ' is-compact' : ''}" aria-label="本周学休账卷">
    <header class="xy-ledger-head">
      <div><p class="xy-ledger-eyebrow">本周学休账卷</p><h3>砚耕与闲暇</h3></div>
      ${totalLogged ? `<span class="xy-ratio-pill">砚耕 ${studyPct}% · 闲暇 ${leisurePct}%</span>` : '<span class="xy-ratio-pill is-idle">待记</span>'}
    </header>
    <div class="xy-kpis">
      <span class="is-study"><em>砚耕（学）</em><strong>${minutesLabel(stats.studyMinutes)}</strong></span>
      <span class="is-leisure"><em>闲暇（休）</em><strong>${minutesLabel(stats.leisureMinutes)}</strong></span>
      <span class="is-plan"><em>计划落笔</em><strong>${minutesLabel(stats.plannedWorkMinutes)}</strong></span>
    </div>
    <div class="xy-ratio" aria-label="砚耕与闲暇比例">
      <div class="xy-ratio-track"><i class="is-study" style="width:${totalLogged ? studyPct : 50}%"></i><i class="is-leisure" style="width:${totalLogged ? leisurePct : 50}%"></i></div>
    </div>
    <div class="xy-chart" aria-label="本周七日学休柱图">${bars}</div>
    ${recentList}
    <details class="xy-log-fold">
      <summary>+ 手记一笔学休</summary>
      <form class="xy-log-form" data-xy-log-form>
        <div class="xy-log-row">
          <select name="kind" aria-label="记录类型"><option value="study">砚耕（学习）</option><option value="leisure">闲暇（休歇）</option></select>
          <input name="date" type="date" value="${defaultDate}" aria-label="日期" required>
        </div>
        <input name="title" type="text" maxlength="80" placeholder="做了什么（如：高数刷题 / 听歌散步）">
        <div class="xy-log-dur">
          <div class="xy-presets" role="group" aria-label="常用时长">
            <button type="button" data-xy-log-preset="25">25分</button>
            <button type="button" data-xy-log-preset="45">45分</button>
            <button type="button" data-xy-log-preset="60">1小时</button>
            <button type="button" data-xy-log-preset="90">1.5小时</button>
          </div>
          <label class="xy-min-input"><input name="minutes" type="number" min="1" max="720" value="45" required><span>分</span></label>
          <button type="submit" class="primary-button xy-log-submit">记入</button>
        </div>
        ${taskOptions}
      </form>
    </details>
  </section>`;
}

/** 返回本周学休合计的一句简短摘要，放在画卷底部页码旁。 */
export function weeklyLedgerBrief(state, weekStartMs) {
  const stats = weeklyLedgerStats(state, null, weekStartMs);
  if (!stats.studyMinutes && !stats.leisureMinutes) return '';
  return `本周 砚耕 ${minutesLabel(stats.studyMinutes)} · 闲暇 ${minutesLabel(stats.leisureMinutes)}`;
}

function smoothCurvePath(points, baseY) {
  if (!points.length) return '';
  let d = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = Math.min(baseY, Math.max(8, p1.y + (p2.y - p0.y) / 6));
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = Math.min(baseY, Math.max(8, p2.y - (p3.y - p1.y) / 6));
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * 渲染画卷右侧「专注曲线」面板：七日平滑双曲线（砚耕专注实线 + 闲暇休歇虚线）、峰值摘要与快速手记。
 */
export function focusCurveMarkup({ state, result, start, now = Date.now(), snapshot = null } = {}) {
  const stats = weeklyLedgerStats(state, result, start);
  const totalLogged = stats.studyMinutes + stats.leisureMinutes;
  const studyPct = totalLogged ? Math.round((stats.studyMinutes / totalLogged) * 100) : 0;
  const leisurePct = totalLogged ? 100 - studyPct : 0;
  const todayYmd = dateStr(now);
  const defaultDate = stats.daily.some(d => d.date === todayYmd) ? todayYmd : stats.daily[0].date;

  const W = 312;
  const H = 148;
  const PAD_L = 22;
  const PAD_R = 16;
  const PAD_T = 20;
  const BASE_Y = 122;
  const PLOT_H = BASE_Y - PAD_T;
  const stepX = (W - PAD_L - PAD_R) / 6;
  const maxMin = Math.max(60, ...stats.daily.map(d => Math.max(d.study, d.leisure)));
  const yOf = val => BASE_Y - (val / maxMin) * PLOT_H;

  const studyPts = stats.daily.map((d, i) => ({ x: PAD_L + i * stepX, y: yOf(d.study), v: d.study, wd: d.weekday, today: d.date === todayYmd }));
  const leisurePts = stats.daily.map((d, i) => ({ x: PAD_L + i * stepX, y: yOf(d.leisure), v: d.leisure, wd: d.weekday }));
  const studyLine = smoothCurvePath(studyPts, BASE_Y);
  const studyArea = studyLine ? `${studyLine} L${studyPts.at(-1).x.toFixed(1)} ${BASE_Y} L${studyPts[0].x.toFixed(1)} ${BASE_Y} Z` : '';
  const leisureLine = smoothCurvePath(leisurePts, BASE_Y);

  const gridLines = [0, 0.5, 1].map(r => {
    const y = (BASE_Y - r * PLOT_H).toFixed(1);
    const val = Math.round(r * maxMin);
    return `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" class="fc-grid"/>${r > 0 ? `<text x="${PAD_L - 4}" y="${Number(y) + 3}" class="fc-ytick">${val}</text>` : ''}`;
  }).join('');

  const todayIdx = stats.daily.findIndex(d => d.date === todayYmd);
  const todayGuide = todayIdx >= 0
    ? `<line x1="${(PAD_L + todayIdx * stepX).toFixed(1)}" y1="${PAD_T - 6}" x2="${(PAD_L + todayIdx * stepX).toFixed(1)}" y2="${BASE_Y}" class="fc-today-line"/>`
    : '';

  const peakStudy = studyPts.reduce((best, p) => (p.v > best.v ? p : best), { v: 0 });
  const dots = studyPts.filter(p => p.v > 0).map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p === peakStudy ? 4 : 3}" class="fc-dot is-study"><title>${p.wd} 砚耕 ${minutesLabel(p.v)}</title></circle>`
  ).join('') + leisurePts.filter(p => p.v > 0).map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.8" class="fc-dot is-leisure"><title>${p.wd} 闲暇 ${minutesLabel(p.v)}</title></circle>`
  ).join('');
  const peakLabel = peakStudy.v > 0
    ? `<text x="${peakStudy.x.toFixed(1)}" y="${Math.max(11, peakStudy.y - 7).toFixed(1)}" class="fc-peak">${minutesLabel(peakStudy.v)}</text>`
    : '';
  const xLabels = stats.daily.map((d, i) =>
    `<text x="${(PAD_L + i * stepX).toFixed(1)}" y="${H - 6}" class="fc-xtick${d.date === todayYmd ? ' is-today' : ''}">${d.weekday.replace('周', '')}</text>`
  ).join('');

  const svg = `<svg class="fc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="本周七日专注与休歇曲线">
    <defs><linearGradient id="fcStudyGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#24465c" stop-opacity=".22"/><stop offset="1" stop-color="#24465c" stop-opacity=".01"/></linearGradient></defs>
    ${gridLines}${todayGuide}
    ${studyArea ? `<path d="${studyArea}" fill="url(#fcStudyGrad)"/>` : ''}
    ${leisureLine ? `<path d="${leisureLine}" class="fc-line is-leisure"/>` : ''}
    ${studyLine ? `<path d="${studyLine}" class="fc-line is-study"/>` : ''}
    ${dots}${peakLabel}${xLabels}
  </svg>`;

  const peakDay = stats.daily.reduce((best, d) => (d.study > best.study ? d : best), { study: 0, weekday: '—' });
  const activeDays = stats.daily.filter(d => d.study > 0).length || 1;
  const avgStudy = Math.round(stats.studyMinutes / activeDays);
  const recentLogs = stats.recentLogs.slice(0, 6);
  const logList = recentLogs.length
    ? `<ul class="xy-log-list">${recentLogs.map(log => `<li class="xy-log-item is-${log.kind}"><i class="xy-log-dot" aria-hidden="true"></i><span class="xy-log-title">${escapeHTML(log.title)}</span><b>${minutesLabel(log.minutes)} · ${shortDate(log.date)}</b><button type="button" class="xy-del" data-xy-log-del="${escapeHTML(log.id)}" aria-label="删去此笔记录">×</button></li>`).join('')}</ul>`
    : '<p class="xy-empty-hint">开启「案头伴读」满 1 分钟记账或下方手记，七日专注曲线会随之起伏。</p>';
  const activeTasks = (snapshot?.tasks || []).filter(t => t.status === 'active');
  const taskOptions = activeTasks.length
    ? `<select name="taskId" class="xy-log-task" aria-label="关联落笔事项（可选）"><option value="">不关联特定落笔</option>${activeTasks.map(t => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.title)}${t.estimate_minutes ? `（${t.estimate_minutes}分）` : ''}</option>`).join('')}</select>`
    : '';

  return `<section class="focus-curve-panel" aria-label="专注曲线">
    <header class="xy-ledger-head">
      <div><p class="xy-ledger-eyebrow">七日学休</p><h3>专注曲线</h3></div>
      ${totalLogged ? `<span class="xy-ratio-pill">专注 ${studyPct}% · 休歇 ${leisurePct}%</span>` : '<span class="xy-ratio-pill is-idle">待记</span>'}
    </header>
    <div class="fc-legend"><span><i class="is-study"></i>砚耕专注</span><span><i class="is-leisure"></i>闲暇休歇</span></div>
    ${svg}
    <div class="fc-kpis">
      <div><em>本周砚耕</em><strong class="is-study">${minutesLabel(stats.studyMinutes)}</strong></div>
      <div><em>本周闲暇</em><strong class="is-leisure">${minutesLabel(stats.leisureMinutes)}</strong></div>
      <div><em>日均专注</em><strong>${stats.studyMinutes ? minutesLabel(avgStudy) : '0分'}</strong></div>
      <div><em>峰值日</em><strong>${peakDay.study ? `${peakDay.weekday.replace('周', '周')}` : '—'}</strong></div>
    </div>
    ${logList}
    <details class="xy-log-fold">
      <summary>+ 手记一笔学休</summary>
      <form class="xy-log-form" data-xy-log-form>
        <div class="xy-log-row">
          <select name="kind" aria-label="记录类型"><option value="study">砚耕（专注）</option><option value="leisure">闲暇（休歇）</option></select>
          <input name="date" type="date" value="${defaultDate}" aria-label="日期" required>
        </div>
        <input name="title" type="text" maxlength="80" placeholder="做了什么（如：算法推导 / 散步听雨）">
        <div class="xy-log-dur">
          <div class="xy-presets" role="group" aria-label="常用时长">
            <button type="button" data-xy-log-preset="25">25分</button>
            <button type="button" data-xy-log-preset="45">45分</button>
            <button type="button" data-xy-log-preset="60">1小时</button>
          </div>
          <label class="xy-min-input"><input name="minutes" type="number" min="1" max="720" value="45" required><span>分</span></label>
          <button type="submit" class="primary-button xy-log-submit">记入</button>
        </div>
        ${taskOptions}
      </form>
    </details>
  </section>`;
}

/**
 * 将统一事项池投影到待办卷四时格与左侧远山志的待定队列。
 * 互为表里：个人任务无论是否填预计用时都留在待办卷对应时段中，有预计用时则同步排入时序卷。
 */
export function weekDayItems(snapshot, state, weekStartMs) {
  const days = Array.from({ length: 7 }, (_, idx) => dateStr(weekStartMs + idx * DAY));
  const daySet = new Set(days);
  const byDay = new Map(days.map(d => [d, new Map(SLOTS.map(s => [s.key, []]))]));
  const pendingTasks = [];
  for (const task of snapshot?.tasks || []) {
    if (task.status === 'cancelled') continue;
    const tier = itemTier(task, 'task');
    if (tier === 'pending' && task.status === 'active') {
      pendingTasks.push(task);
      continue;
    }
    if (!isPersonalTask(task)) continue;
    const ymd = taskDay(task);
    if (!daySet.has(ymd)) continue;
    const slotKey = SLOT_KEYS.has(state?.slots?.[task.id])
      ? state.slots[task.id]
      : (inferSlotFromText(task.title) || slotFromTimestamp(task.earliest_start_at || task.deadline_at) || 'bu');
    byDay.get(ymd).get(slotKey).push({
      id: task.id,
      title: task.title,
      done: task.status === 'completed',
      fromTask: true,
      estimateMinutes: task.estimate_minutes ?? null,
      scheduled: task.estimate_minutes !== null,
    });
  }
  for (const note of state?.notes || []) {
    if (!daySet.has(note.date)) continue;
    const slotKey = SLOT_KEYS.has(note.slot) ? note.slot : 'bu';
    byDay.get(note.date).get(slotKey).push({
      id: note.id,
      title: note.title,
      done: Boolean(note.done),
      fromTask: false,
      promotedTaskId: note.promotedTaskId,
    });
  }
  return { byDay, pendingTasks };
}

const DUR_PRESETS = [
  [15, '15分'],
  [30, '30分'],
  [45, '45分'],
  [60, '1小时'],
  [90, '1.5小时'],
  [120, '2小时'],
];

/**
 * 渲染「待办 · 四时手卷」：左侧窄竖向「远山志」题跋 + 七日四时格 + 每日底部学休账条。
 */
export function xieyiBoardMarkup({ state, result, start, now = Date.now(), snapshot = null, openLogDate = '', openDurTaskId = '' } = {}) {
  const days = Array.from({ length: 7 }, (_, idx) => start + idx * DAY);
  const todayYmd = dateStr(now);
  const weekStartYmd = dateStr(start);
  const targetDropDate = days.some(ms => dateStr(ms) === todayYmd) ? todayYmd : weekStartYmd;
  const ledgerStats = weeklyLedgerStats(state, result, start);
  const logsByDay = new Map(ledgerStats.daily.map(d => [d.date, d]));
  const { byDay, pendingTasks } = weekDayItems(snapshot, state, start);

  const activeHorizon = GOAL_HORIZONS.find(h => h.key === state.goalTab) || GOAL_HORIZONS[0];
  const pKey = periodKeyFor(activeHorizon.key, start);
  const horizonTabs = GOAL_HORIZONS.map(h => {
    const label = h.key === 'week' ? '周' : h.key === 'month' ? '月' : '学期';
    return `<button type="button" class="xy-goal-tab" data-xy-goal-tab="${h.key}" aria-pressed="${h.key === activeHorizon.key}">${label}</button>`;
  }).join('');

  const matchingGoals = state.goals.filter(g => g.horizon === activeHorizon.key && g.periodKey === pKey);
  const goalList = matchingGoals.length
    ? `<ul class="xy-goal-list">${matchingGoals.map(g => `<li class="xy-goal-chip${g.done ? ' is-done' : ''}">
        <button type="button" class="xy-goal-check" data-xy-goal-toggle="${escapeHTML(g.id)}" aria-pressed="${g.done}"><i class="xy-seal">${g.done ? '成' : ''}</i><span>${escapeHTML(g.title)}</span></button>
        <span class="xy-goal-ops"><button type="button" class="xy-goal-drop" data-xy-goal-drop="${escapeHTML(g.id)}" title="落入 ${shortDate(targetDropDate)} 晡（下午）">落今日</button><button type="button" class="xy-del" data-xy-goal-del="${escapeHTML(g.id)}" aria-label="删除目标">×</button></span>
      </li>`).join('')}</ul>`
    : `<p class="xy-empty-hint">${escapeHTML(activeHorizon.name)}尚未题写</p>`;

  const pendingBlock = pendingTasks.length
    ? `<div class="xy-pending">
        <h4>待定 · 未落哪天</h4>
        <ul>${pendingTasks.slice(0, 6).map(t => `<li><span>${escapeHTML(t.title)}</span><button type="button" class="xy-goal-drop" data-xy-pending-drop="${escapeHTML(t.id)}" title="落入 ${shortDate(targetDropDate)} 晡（下午）">落今日</button></li>`).join('')}</ul>
      </div>`
    : '';

  const colophon = `<aside class="xy-colophon" aria-label="远山志">
    <header class="xy-colo-head">
      <div class="xy-colo-title"><p class="cal-eyebrow">远山志</p><small>${escapeHTML(pKey)}</small></div>
      <div class="xy-goal-tabs" role="tablist" aria-label="目标尺度">${horizonTabs}</div>
    </header>
    ${goalList}
    <form class="xy-goal-form" data-xy-goal-form>
      <input type="hidden" name="horizon" value="${activeHorizon.key}">
      <input type="hidden" name="periodKey" value="${escapeHTML(pKey)}">
      <input name="title" type="text" maxlength="80" aria-label="题写${activeHorizon.name}" placeholder="＋ 题${activeHorizon.name}" required>
      <button type="submit">立志</button>
    </form>
    ${pendingBlock}
  </aside>`;

  const dayColumns = days.map((dayMs, idx) => {
    const ymd = dateStr(dayMs);
    const isToday = ymd === todayYmd;
    const slotCards = SLOTS.map(slot => {
      const info = slotSummary(result, dayMs, slot);
      const entries = byDay.get(ymd)?.get(slot.key) || [];
      const entryIds = new Set(entries.map(e => e.id));
      const busyOnly = info.busyItems.filter(item => !item.id || !entryIds.has(item.id));
      const fixedTags = busyOnly.slice(0, 3).map(item => `<span class="xy-ref-tag is-${item.layer}">${escapeHTML(item.title)}</span>`).join('');
      const moreFixed = busyOnly.length > 3 ? `<span class="xy-ref-more">+${busyOnly.length - 3}</span>` : '';
      const itemRows = entries.map(entry => {
        const toggleAttr = entry.fromTask ? `data-xy-task-toggle="${escapeHTML(entry.id)}"` : `data-xy-note-toggle="${escapeHTML(entry.id)}"`;
        const delAttr = entry.fromTask ? `data-xy-task-del="${escapeHTML(entry.id)}"` : `data-xy-note-del="${escapeHTML(entry.id)}"`;
        const isDurOpen = entry.fromTask && !entry.done && openDurTaskId === entry.id;
        let ops = '';
        if (entry.fromTask && !entry.done) {
          ops = entry.estimateMinutes !== null
            ? `<button type="button" class="xy-time-badge${isDurOpen ? ' is-open' : ''}" data-xy-dur-toggle="${escapeHTML(entry.id)}" aria-expanded="${isDurOpen}" title="已同步排入时序卷，点此调整用时或撤回">${minutesLabel(entry.estimateMinutes)}</button>`
            : `<button type="button" class="xy-time-btn${isDurOpen ? ' is-open' : ''}" data-xy-dur-toggle="${escapeHTML(entry.id)}" aria-expanded="${isDurOpen}" aria-label="选填用时并排入时序卷" title="选填用时排入时序卷（可不填）"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
        } else if (!entry.fromTask) {
          ops = entry.promotedTaskId ? '<em class="xy-promoted">已入时序卷</em>' : `<button type="button" class="xy-promote" data-xy-promote="${escapeHTML(entry.id)}">入时序卷</button>`;
        }
        const durPop = isDurOpen
          ? `<div class="xy-dur-pop">
              <p class="xy-dur-hint">排入时序卷「${slot.name}·${slot.gloss}」时段</p>
              <div class="xy-dur-presets" role="group" aria-label="快捷时长">${DUR_PRESETS.map(([mins, label]) => `<button type="button" data-xy-upgrade="${escapeHTML(entry.id)}:${mins}" aria-pressed="${entry.estimateMinutes === mins}">${label}</button>`).join('')}</div>
              <form class="xy-dur-custom" data-xy-dur-form="${escapeHTML(entry.id)}"><input name="minutes" type="number" min="5" max="720" step="5" value="${entry.estimateMinutes ?? 45}" aria-label="自定义分钟数" required><span>分</span><button type="submit">排入</button></form>
              ${entry.estimateMinutes !== null ? `<button type="button" class="xy-dur-clear" data-xy-upgrade="${escapeHTML(entry.id)}:0">撤回轻待办（仅留待办卷）</button>` : ''}
            </div>`
          : '';
        return `<li class="xy-note${entry.done ? ' is-done' : ''}${entry.estimateMinutes !== null ? ' is-scheduled' : ''}">
          <div class="xy-note-main">
            <button type="button" class="xy-note-check" ${toggleAttr} aria-pressed="${entry.done}"><i class="xy-seal">${entry.done ? '成' : ''}</i><span>${escapeHTML(entry.title)}</span></button>
            <span class="xy-note-ops">${ops}<button type="button" class="xy-del" ${delAttr} aria-label="删去此项">×</button></span>
          </div>
          ${durPop}
        </li>`;
      }).join('');
      return `<div class="xy-slot xy-slot-${slot.key}">
        <div class="xy-slot-head">
          <span class="xy-slot-name"><strong>${slot.name}</strong><small>${slot.gloss}</small></span>
          ${info.label && (info.density === 'is-tight' || info.density === 'is-full') ? `<span class="xy-slot-cap ${info.density}">${escapeHTML(info.label)}</span>` : ''}
        </div>
        ${fixedTags ? `<div class="xy-refs" aria-label="已有底色与点墨">${fixedTags}${moreFixed}</div>` : ''}
        ${itemRows ? `<ul class="xy-notes">${itemRows}</ul>` : ''}
        <form class="xy-add-form" data-xy-add-form>
          <input type="hidden" name="date" value="${ymd}">
          <input type="hidden" name="slot" value="${slot.key}">
          <input name="title" type="text" maxlength="120" aria-label="${WEEKDAYS[idx]} ${slot.name}（${slot.gloss}）新增安排" placeholder="＋ 记一笔">
        </form>
      </div>`;
    }).join('');

    const dl = logsByDay.get(ymd) || { study: 0, leisure: 0 };
    const dlTotal = dl.study + dl.leisure;
    const dlStudyPct = dlTotal ? Math.round((dl.study / dlTotal) * 100) : 0;
    const dlLeisurePct = dlTotal ? 100 - dlStudyPct : 0;
    const isLogOpen = openLogDate === ymd;
    const dayLogs = (state.logs || []).filter(l => l.date === ymd).sort((a, b) => b.at - a.at);
    const dayLogLabel = dlTotal
      ? `${dl.study ? `学 ${minutesLabel(dl.study)}` : ''}${dl.study && dl.leisure ? ' · ' : ''}${dl.leisure ? `休 ${minutesLabel(dl.leisure)}` : ''}`
      : '记学休';
    const dayLogPop = isLogOpen
      ? `<div class="xy-day-log-pop">
          ${dayLogs.length ? `<ul class="xy-day-log-list">${dayLogs.map(log => `<li class="is-${log.kind}"><i aria-hidden="true"></i><span>${escapeHTML(log.title)}</span><b>${minutesLabel(log.minutes)}</b><button type="button" class="xy-del" data-xy-log-del="${escapeHTML(log.id)}" aria-label="删去记录">×</button></li>`).join('')}</ul>` : ''}
          <form class="xy-day-log-form" data-xy-log-form>
            <input type="hidden" name="date" value="${ymd}">
            <div class="xy-day-log-row">
              <select name="kind" aria-label="类型"><option value="study">砚耕</option><option value="leisure">闲暇</option></select>
              <label class="xy-min-input"><input name="minutes" type="number" min="1" max="720" value="45" required><span>分</span></label>
            </div>
            <input name="title" type="text" maxlength="80" placeholder="做了什么（可选）">
            <div class="xy-day-log-foot">
              <div class="xy-presets" role="group" aria-label="常用时长">
                <button type="button" data-xy-log-preset="25">25</button>
                <button type="button" data-xy-log-preset="45">45</button>
                <button type="button" data-xy-log-preset="60">60</button>
              </div>
              <button type="submit" class="xy-day-log-save">记入</button>
            </div>
          </form>
        </div>`
      : '';

    return `<article class="xy-day${isToday ? ' is-today' : ''}" aria-label="${shortDate(ymd)} ${WEEKDAYS[idx]}">
      <header class="xy-day-head"><strong>${WEEKDAYS[idx]}</strong><span>${shortDate(ymd)}${isToday ? ' · 今日' : ''}</span></header>
      <div class="xy-slots">${slotCards}</div>
      <footer class="xy-day-ledger${isLogOpen ? ' is-open' : ''}">
        <div class="xy-day-bar" aria-hidden="true"><i class="is-study" style="width:${dlStudyPct}%"></i><i class="is-leisure" style="width:${dlLeisurePct}%"></i></div>
        <button type="button" class="xy-day-log-btn" data-xy-day-log-toggle="${ymd}" aria-expanded="${isLogOpen}">${escapeHTML(dayLogLabel)}</button>
        ${dayLogPop}
      </footer>
    </article>`;
  }).join('');

  return `<div class="xy-layout">
    ${colophon}
    <div class="xy-grid" aria-label="待办卷 · 四时轻记">${dayColumns}</div>
  </div>`;
}
