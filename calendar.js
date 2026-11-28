/**
 * Week calendar for the four time layers (Beijing time, weeks start on Monday).
 * Pure markup from a /api/v3/calendar result: free time as bands behind
 * everything, routine / temporary / work as blocks, deadlines and start-only
 * events as lines, the present moment as a needle across today. Conflicts and
 * undefined items are listed beside the week. Blocks carry data-cal-item and
 * data-cal-layer so a click can open the matching entry.
 */
import { shanshuiMarkup } from './shanshui.js';

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;
const OFFSET = 8 * HOUR;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const local = value => new Date(value + OFFSET);
const clock = value => { const d = local(value); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const monthDay = value => { const d = local(value); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };
// On screen the layers use the 书画 names: 底色 routine, 留白 free, 落笔 work and appointments, 点墨 temporary.
export const LAYER_LABEL = { routine: '底色', temporary: '点墨', work: '落笔', appointment: '落笔·约定', free: '留白', deadline: '截止', start: '开始' };
const TASK_STATE = { time_invalid: '任务时间待核对', scheduled: '已落笔', estimate_undefined: '只标截止', deadline_undefined: '截止未填', free_time_undefined: '留白未设定',
  short: '留白不够', overdue: '已过截止', beyond_horizon: '超出31天', not_attempted: '暂未安排', completed: '已完成', cancelled: '已取消' };
const CONFLICT_LABEL = { routine_overlap: '底色相叠', temporary_routine_overlap: '点墨压在底色上', temporary_overlap: '两处点墨相叠',
  appointment_routine_overlap: '约定压在底色上', appointment_overlap: '约定与他事相叠', work_shortage: '留白不够落笔', overdue: '已过截止' };

/** Monday 00:00 Beijing time of the week holding `value` (epoch ms). */
export function weekStart(value) {
  const d = local(value);
  const weekday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFFSET - weekday * DAY;
}

/** The YYYY-MM-DD range of a week, as /api/v3/calendar expects it. */
export function weekRange(start) {
  const day = value => local(value).toISOString().slice(0, 10);
  return { from: day(start), to: day(start + 6 * DAY) };
}

export function weekNumber(start) {
  const thursday = local(start + 3 * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / (7 * DAY)) + 1;
}

/** Only the conflicts whose overlap or deadline falls inside the displayed week [start, start + 7d). */
export function conflictsInWeek(conflicts, start) {
  if (!Array.isArray(conflicts) || !Number.isFinite(start)) return Array.isArray(conflicts) ? conflicts : [];
  const end = start + 7 * DAY;
  return conflicts.filter(conflict => {
    if (conflict.start && conflict.end) {
      const from = Date.parse(conflict.start);
      const to = Date.parse(conflict.end);
      return Number.isFinite(from) && Number.isFinite(to) ? to > start && from < end : true;
    }
    if (conflict.end) {
      const at = Date.parse(conflict.end);
      return Number.isFinite(at) ? at >= start && at < end : true;
    }
    if (conflict.start) {
      const at = Date.parse(conflict.start);
      return Number.isFinite(at) ? at >= start && at < end : true;
    }
    return true;
  });
}

export function undefinedInWeek(result, start) {
  const list = result?.undefined || [];
  if (!Number.isFinite(start) || !list.length) return list;
  const end = start + 7 * DAY;
  const knownAt = new Map();
  for (const marker of result.markers || []) knownAt.set(marker.id, Date.parse(marker.at));
  for (const item of [...(result.layers?.temporary || []), ...(result.layers?.appointment || [])]) knownAt.set(item.id, Date.parse(item.start));
  return list.filter(item => {
    if (!item.id) return true; // global definitions (留白 / 底色) apply to every week
    const at = knownAt.get(item.id);
    if (!Number.isFinite(at)) return true; // timeless items stay visible so nothing is silently lost
    return at >= start && at < end;
  });
}

/** Everything the week can place, as plain records with epoch times. */
export function calendarItems(result, start = null) {
  const items = [];
  if (!result) return items;
  const scopedConflicts = Number.isFinite(start) ? conflictsInWeek(result.conflicts, start) : result.conflicts;
  const conflictIds = new Set(scopedConflicts.flatMap(conflict => conflict.items.map(item => item.id)));
  for (const item of result.layers.free) items.push({ type: 'free', start: Date.parse(item.start), end: Date.parse(item.end) });
  for (const item of result.layers.routine) items.push({ type: 'routine', id: item.routine_id, key: item.id, title: item.title, location: item.location, start: Date.parse(item.start), end: Date.parse(item.end), conflict: conflictIds.has(item.id) });
  for (const item of result.layers.temporary) items.push({ type: 'temporary', id: item.id, key: item.id, title: item.title, location: item.location, start: Date.parse(item.start), end: Date.parse(item.end), conflict: conflictIds.has(item.id) });
  for (const item of result.layers.appointment || []) items.push({ type: 'appointment', id: item.id, key: item.id, title: item.title, location: item.location, start: Date.parse(item.start), end: Date.parse(item.end), conflict: conflictIds.has(item.id) });
  for (const item of result.layers.work) items.push({ type: 'work', id: item.task_id, key: item.task_id, title: item.title, start: Date.parse(item.start), end: Date.parse(item.end) });
  for (const marker of result.markers) {
    const at = Date.parse(marker.at);
    items.push({ type: marker.type === 'deadline' ? 'deadline' : 'start', id: marker.id, title: marker.title, start: at, end: at, state: marker.state, conflict: conflictIds.has(marker.id) });
  }
  return items;
}

export function lanes(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [];
  let clusterEnd = -Infinity;
  const finish = () => { const width = Math.max(1, ...cluster.map(block => block.lane + 1)); cluster.forEach(block => { block.lanes = width; }); };
  for (const block of sorted) {
    if (block.start >= clusterEnd && cluster.length) { finish(); cluster = []; }
    const taken = new Set(cluster.filter(other => other.end > block.start).map(other => other.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    block.lane = lane;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.end);
  }
  if (cluster.length) finish();
  return sorted;
}

const layerOf = { routine: 'routine', temporary: 'event', appointment: 'event', work: 'task', deadline: 'task', start: 'event' };
const attrs = item => `data-cal-item="${escape(item.id)}" data-cal-layer="${layerOf[item.type]}"`;
const isLine = item => item.type === 'deadline' || item.type === 'start';

const LAYER_CLASS = { routine: 'routine', temporary: 'temporary', appointment: 'appointment', work: 'work' };
const minutesText = value => value >= 60 ? `${Math.floor(value / 60)}小时${value % 60 ? `${value % 60}分` : ''}` : `${value}分钟`;

/** A small picture of one conflict: two bars on a shared axis with the overlap hatched, or need against free time. */
function conflictPicture(conflict, result) {
  const spans = conflict.items.filter(item => item.start && item.end);
  if (spans.length === 2 && conflict.start) {
    const from = Math.min(...spans.map(item => Date.parse(item.start)));
    const to = Math.max(...spans.map(item => Date.parse(item.end)));
    const at = value => ((Date.parse(value) - from) / (to - from) * 100).toFixed(2);
    const bars = spans.map(item => `<div class="cx-row"><span class="cx-name">${escape(item.title)}</span><div class="cx-track"><i class="cx-bar cx-${LAYER_CLASS[item.layer] || 'temporary'}" style="left:${at(item.start)}%;width:${(at(item.end) - at(item.start)).toFixed(2)}%"></i></div></div>`).join('');
    return `<div class="cx-picture" aria-hidden="true"><div class="cx-overlap" style="--l:${at(conflict.start)};--w:${(at(conflict.end) - at(conflict.start)).toFixed(2)}"></div>${bars}<div class="cx-axis"><span>${clock(from)}</span><span>重叠 ${clock(Date.parse(conflict.start))}–${clock(Date.parse(conflict.end))}</span><span>${clock(to)}</span></div></div>`;
  }
  if (conflict.type === 'work_shortage') {
    const task = result.tasks.find(entry => entry.id === conflict.items[0].id);
    const need = task?.estimate_minutes;
    if (!need) return '';
    const missing = Math.min(conflict.minutes || 0, need);
    const have = need - missing;
    return `<div class="cx-picture" aria-hidden="true"><div class="cx-row"><span class="cx-name">需要 ${minutesText(need)}</span><div class="cx-track"><i class="cx-bar cx-free" style="left:0;width:${(have / need * 100).toFixed(2)}%"></i><i class="cx-bar cx-missing" style="left:${(have / need * 100).toFixed(2)}%;width:${(missing / need * 100).toFixed(2)}%"></i></div></div><div class="cx-axis"><span>${missing ? `留白够 ${minutesText(have)}` : '总量够，但空档太碎'}</span>${missing ? `<span>差 ${minutesText(missing)}</span>` : ''}</div></div>`;
  }
  return '';
}

/** Stable across recalculations (conflict ids are renumbered every time): type plus the items involved. */
export const conflictKey = conflict => `${conflict.type}|${conflict.items.map(item => item.id).join(' ')}`;

function weighMarkup(conflict, weigh) {
  const key = escape(conflictKey(conflict));
  if (!(conflict.strategies || []).length) return '';
  if (weigh?.loading) return `<p class="cx-weigh"><span class="cx-weigh-status" role="status">模型正在权衡这几条对策…</span></p>`;
  const error = weigh?.error ? `<span class="cx-weigh-status" role="status">${escape(weigh.error)}</span>` : '';
  if (weigh?.reason) return `<p class="cx-model"><strong>模型之见</strong>${escape(weigh.reason)}</p>`;
  return `<p class="cx-weigh"><button type="button" class="text-button" data-weigh="${key}">请模型权衡</button>${error}</p>`;
}

/** The two things that overlap, and for how long, in words big enough to read on a projector. */
function conflictHeadline(conflict) {
  const names = conflict.items.slice(0, 2).map(item => `<b class="cx-who cx-who-${LAYER_CLASS[item.layer] || 'work'}">${escape(item.title)}</b>`);
  const span = conflict.start && conflict.end ? `${clock(Date.parse(conflict.start))}–${clock(Date.parse(conflict.end))}` : '';
  const length = conflict.minutes ? `<strong>${minutesText(conflict.minutes)}</strong>` : '';
  const lead = conflict.type === 'work_shortage' ? `${names[0]}<span class="cx-verb">截止前留白不够${length ? `，还差 ${length}` : ''}</span>`
    : conflict.type === 'overdue' ? `${names[0]}<span class="cx-verb">已过截止</span>`
    : `${names.join('<span class="cx-and">与</span>')}<span class="cx-verb">${length ? `重叠 ${length}` : '时间相撞'}${span ? `<em>${span}</em>` : ''}</span>`;
  return `<p class="cx-headline">${lead}</p>`;
}

function conflictCard(conflict, result, weighs = {}) {
  const weigh = weighs[conflictKey(conflict)];
  const pick = weigh?.reason ? weigh.pick : -1;
  const first = conflict.items[0];
  const keys = conflict.items.map(item => item.id).join(' ');
  const when = conflict.start ? `${monthDay(Date.parse(conflict.start))} ${WEEKDAYS[(local(Date.parse(conflict.start)).getUTCDay() + 6) % 7]}` : conflict.end ? `截止 ${monthDay(Date.parse(conflict.end))} ${clock(Date.parse(conflict.end))}` : '';
  const layer = first.layer === 'routine' ? 'routine' : ['temporary', 'appointment'].includes(first.layer) ? 'event' : 'task';
  const id = first.layer === 'routine' ? first.id.split('@')[0] : first.id;
  const strategies = (conflict.strategies || []).map((strategy, index) => `<li><button type="button" class="cx-option${strategy.recommended ? ' is-recommended' : ''}${index === pick ? ' is-model-pick' : ''}" data-strategy="${escape(conflict.id)}:${index}" title="${escape(strategy.detail)}"><span class="cx-option-label">${index === pick ? '<em class="cx-model-tag">模型之选</em>' : ''}${strategy.recommended ? '<em>推荐</em>' : ''}${escape(strategy.label)}</span><span class="cx-option-detail">${escape(strategy.detail)}</span></button></li>`).join('');
  return `<li class="cx-card" data-conflict-keys="${escape(keys)}">
      <button type="button" class="cx-head" data-cal-item="${escape(id)}" data-cal-layer="${layer}"><strong><svg class="cx-blot" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5c2.3.2 3 2.2 4.6 2.6 1.9.5 3.6 1.4 3.2 3.6-.3 1.6-1.7 2-1.5 3.6.2 1.8-.6 3.9-2.7 4.3-1.6.3-2.4-.9-3.8-.6-1.7.4-3.3 1.6-4.9.5-1.5-1-.9-2.9-1.8-4.1C2.2 11.2.9 9.9 1.8 8.2 2.6 6.7 4.6 7 5.4 5.6 6.3 4 7.8 2.3 10 2.5z"/><circle cx="17.3" cy="15.6" r="1.1"/></svg>${escape(CONFLICT_LABEL[conflict.type] || '叠墨')}</strong><span>${when}</span></button>
      ${conflictHeadline(conflict)}
      ${conflictPicture(conflict, result)}
      ${conflict.advice ? `<p class="cx-advice">${escape(conflict.advice)}</p>` : `<p class="cx-advice">${escape(conflict.reason)}</p>`}
      ${weighMarkup(conflict, weigh)}
      ${strategies ? `<ul class="cx-options" aria-label="对策">${strategies}</ul>` : ''}
    </li>`;
}

function noteMarkup(note) {
  if (!note) return '';
  return `<div class="cx-note"><p>给老师的请假说明（草稿，【】里换成你的信息；司序不会替你发送）</p><textarea id="leaveNote" rows="5" aria-label="请假说明草稿">${escape(note)}</textarea><div class="inline-actions"><button type="button" data-copy-note>复制</button></div></div>`;
}

function changesMarkup(changes) {
  if (!changes?.length) return '';
  return `<div class="cx-changes"><p>采用后，画卷重算的变化</p><ul>${changes.map(change => `<li class="is-${change.kind}"><span>${escape(change.label)}</span><s>${escape(change.before)}</s><i aria-hidden="true">→</i><b>${escape(change.after)}</b>${change.delta ? `<em>${escape(change.delta)}</em>` : ''}</li>`).join('')}</ul></div>`;
}

/** 精确重排与多方案对比 (POST /api/v3/solve): Pareto plans with their numbers, each applicable in one click. */
function plansMarkup(plans, weekConflicts) {
  if (!weekConflicts.length && !plans) return '';
  const intro = '<p class="cal-side-note">精确求解这一周：比较“保课表”与“保活动”等方案的叠墨、留白与请假次数，并检查跨楼赶场。</p>';
  if (!plans) return `<section class="cal-side-block plans">${intro}<button type="button" class="plans-run" data-solve>精确重排 · 多方案对比</button></section>`;
  if (plans.loading) return `<section class="cal-side-block plans"><p class="cal-hint" role="status">正在精确求解这一周…</p></section>`;
  if (plans.error) return `<section class="cal-side-block plans"><p class="cal-hint is-error" role="status">${escape(plans.error)}</p><button type="button" class="plans-run" data-solve>再试一次</button></section>`;
  const solved = plans.result;
  const algo = solved.algorithm || {};
  const head = `<h3>多方案对比 <span>${solved.pareto_plans.length}</span></h3><p class="plans-algo">分支定界精确求解 · 搜索 ${algo.nodes_explored ?? 0} 个节点 · ${solved.validation?.passed ? '独立校验通过' : escape(solved.reason || '')}${algo.transit_minutes ? ` · 跨楼预留 ${algo.transit_minutes} 分钟` : ''}</p>`;
  const transit = (solved.transit_warnings || []).map(item => `<li>${escape(item.message || item.reason || `${item.from_title || ''} → ${item.to_title || ''}`)}</li>`).join('');
  const cards = solved.pareto_plans.map((plan, index) => {
    const m = plan.metrics || {};
    const blocks = (plan.work_blocks || []).slice(0, 3).map(block => `<li>${escape(block.title)} <b>${clock(Date.parse(block.start))}–${clock(Date.parse(block.end))}</b></li>`).join('');
    return `<li class="plan-card"><p class="plan-name">${escape(plan.name)}</p><p class="plan-sum">${escape(plan.summary)}</p>
      <ul class="plan-metrics"><li><b>${m.remaining_conflicts ?? '–'}</b><span>叠墨</span></li><li><b>${m.skipped_routine_occurrences ?? 0}</b><span>请假</span></li><li><b>${m.kept_temporary_events ?? 0}</b><span>保留点墨</span></li><li><b>${Math.round((m.net_free_minutes || 0) / 60)} 小时</b><span>本周可用</span></li></ul>
      ${blocks ? `<ul class="plan-blocks">${blocks}</ul>` : ''}
      <button type="button" class="plan-apply" data-plan="${index}">采用：${escape(plan.actions.map(action => action.label).join('；'))}</button></li>`;
  }).join('');
  return `<section class="cal-side-block plans">${head}${transit ? `<ul class="plans-transit">${transit}</ul>` : ''}${cards ? `<ol class="plan-list">${cards}</ol>` : '<p>这一周没有需要比较的方案。</p>'}</section>`;
}

function sideLists(result, weekConflicts, weekUndefined, undo, note, weighs, changes, plans) {
  const conflicts = weekConflicts.map(conflict => conflictCard(conflict, result, weighs)).join('');
  const undefinedRows = weekUndefined.map(item => {
    const target = item.id ? `data-cal-item="${escape(item.id)}" data-cal-layer="${item.type.startsWith('event_') ? 'event' : 'task'}"` : `data-cal-goto="time" data-cal-roll="${item.type === 'routines_unconfirmed' ? 'routine' : 'free'}"`;
    const go = item.id ? '去补上' : item.type === 'routines_unconfirmed' ? '去铺纸确认底色' : '去铺纸设置作息';
    return `<li><button type="button" class="cal-issue is-undefined" ${target}><strong>${escape(item.title || (item.type === 'free_time_undefined' ? '留白' : '底色'))}</strong><span>${escape(item.reason)}</span><em class="cal-issue-go">${go} →</em></button></li>`;
  }).join('');
  const undoBar = undo ? `<p class="cx-undo">已采用：${escape(undo)}<button type="button" class="text-button" data-strategy-undo>撤销</button></p>${changesMarkup(changes)}${noteMarkup(note)}` : '';
  if (!conflicts && !undoBar) return `<section class="cal-side-block cx is-clear" aria-labelledby="calConflictHeading"><p class="cx-clear-line"><b id="calConflictHeading">叠墨 · 对策 <span>0</span></b>这一周没有相叠，这一卷是干净的。</p></section>
    ${plansMarkup(plans, weekConflicts)}
    <section class="cal-side-block" aria-labelledby="calUndefinedHeading"><h3 id="calUndefinedHeading">待书 <span>${weekUndefined.length}</span></h3>${undefinedRows ? `<ul>${undefinedRows}</ul>` : '<p>这一周信息都已写清楚。</p>'}</section>`;
  return `<section class="cal-side-block cx" aria-labelledby="calConflictHeading"><h3 id="calConflictHeading">叠墨 · 对策 <span>${weekConflicts.length}</span></h3>${undoBar}${conflicts ? `<p class="cal-side-note">按规则为这一周每处相叠拟好对策，点一下即采用，画卷随之重算。</p><ol class="cx-list">${conflicts}</ol>` : '<p class="cx-clear">这一周底色、落笔与点墨之间没有相叠，这一卷是干净的。</p>'}</section>
    ${plansMarkup(plans, weekConflicts)}
    <section class="cal-side-block" aria-labelledby="calUndefinedHeading"><h3 id="calUndefinedHeading">待书 <span>${weekUndefined.length}</span></h3>${undefinedRows ? `<ul>${undefinedRows}</ul>` : '<p>这一周信息都已写清楚。</p>'}</section>`;
}

export function minutesLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return (hours ? `${hours} 小时` : '') + (rest || !hours ? `${hours ? ' ' : ''}${rest} 分钟` : '');
}

/** What a judge compares before and after a strategy: conflicts, fixed items, where work sits, time left this week. */
export function resultDigest(result, start, now) {
  if (!result) return null;
  const work = {};
  for (const entry of result.layers.work) (work[entry.task_id] ||= { title: entry.title, spans: [] }).spans.push([Date.parse(entry.start), Date.parse(entry.end)]);
  const fixed = {};
  for (const item of [...result.layers.temporary, ...(result.layers.appointment || [])]) fixed[item.id] = { title: item.title, start: Date.parse(item.start), end: Date.parse(item.end) };
  const remaining = remainingCapacity(result, Math.max(start, Math.ceil(now / MINUTE) * MINUTE), start + 7 * DAY);
  return { conflicts: conflictsInWeek(result.conflicts, start).length, work, fixed, remaining: remaining ? remaining.total : null };
}

const spanText = (spans, withDay) => spans.length ? `${withDay ? `${monthDay(spans[0][0])} ` : ''}${spans.map(([from, to]) => `${clock(from)}–${clock(to)}`).join('、')}` : '未排入';

/** Plain before → after lines for the 叠墨 side panel. Empty when nothing visible changed. */
export function digestChanges(before, after) {
  if (!before || !after) return [];
  const lines = [];
  if (before.conflicts !== after.conflicts) lines.push({ kind: 'conflict', label: '叠墨', before: `${before.conflicts} 处`, after: `${after.conflicts} 处` });
  for (const [id, item] of Object.entries(before.fixed)) {
    const now = after.fixed[id];
    if (!now) lines.push({ kind: 'removed', label: `点墨「${item.title}」`, before: `${clock(item.start)}–${clock(item.end)}`, after: '已划掉' });
    else if (now.start !== item.start || now.end !== item.end) lines.push({ kind: 'moved', label: `「${item.title}」`, before: `${monthDay(item.start)} ${clock(item.start)}`, after: `${monthDay(now.start)} ${clock(now.start)}` });
  }
  for (const id of new Set([...Object.keys(before.work), ...Object.keys(after.work)])) {
    const old = before.work[id]?.spans || [];
    const fresh = after.work[id]?.spans || [];
    if (JSON.stringify(old) === JSON.stringify(fresh)) continue;
    // Same day before and after: the day goes into the label so the times stay short.
    const sameDay = old.length && fresh.length && monthDay(old[0][0]) === monthDay(fresh[0][0]);
    lines.push({ kind: 'work', label: `落笔「${(after.work[id] || before.work[id]).title}」${sameDay ? ` · ${monthDay(old[0][0])}` : ''}`, before: spanText(old, !sameDay), after: spanText(fresh, !sameDay) });
  }
  if (before.remaining !== null && after.remaining !== null && before.remaining !== after.remaining) {
    const delta = after.remaining - before.remaining;
    lines.push({ kind: 'free', label: '本周还可用', before: minutesLabel(before.remaining), after: minutesLabel(after.remaining), delta: `${delta > 0 ? '+' : '−'}${minutesLabel(Math.abs(delta))}` });
  }
  return lines;
}

/** Calendar free bands are before flexible work. Subtract every work interval and clip to the future. */
export function freeAfterWork(items, from, to) {
  const work = items.filter(item => item.type === 'work').sort((a, b) => a.start - b.start);
  const slots = [];
  for (const band of items.filter(item => item.type === 'free')) {
    let cursor = Math.max(from, band.start);
    const end = Math.min(to, band.end);
    if (cursor >= end) continue;
    for (const block of work) {
      if (block.end <= cursor) continue;
      if (block.start >= end) break;
      if (block.start > cursor) slots.push({ start: cursor, end: block.start });
      cursor = Math.max(cursor, block.end);
      if (cursor >= end) break;
    }
    if (cursor < end) slots.push({ start: cursor, end });
  }
  return slots;
}

export function remainingCapacity(result, from, to) {
  if (!result || result.definition?.free_time !== 'defined') return null;
  // Cut at midnight so two calendar days never look like one bookable slot.
  const items = calendarItems(result);
  const slots = [];
  for (let start = from; start < to;) {
    const midnight = Math.floor((start + OFFSET) / DAY) * DAY - OFFSET + DAY;
    const end = Math.min(midnight, to);
    slots.push(...freeAfterWork(items, start, end));
    start = end;
  }
  const length = slot => Math.floor((slot.end - slot.start) / MINUTE);
  const longest = slots.reduce((best, slot) => !best || length(slot) > length(best) ? slot : best, null);
  return { slots, total: slots.reduce((sum, slot) => sum + length(slot), 0), longest: longest ? length(longest) : 0, longestSlot: longest ? { start: longest.start, end: longest.end } : null };
}

/** Two or three plain lines about the week: the fullest day and what is due soon. */
export function weeklyBrief(items, start, now) {
  const busyTypes = ['routine', 'temporary', 'appointment', 'work'];
  const hours = Array.from({ length: 7 }, (_, index) => {
    const dayStart = start + index * DAY;
    return items.filter(item => busyTypes.includes(item.type)).reduce((sum, item) => sum + Math.max(0, Math.min(item.end, dayStart + DAY) - Math.max(item.start, dayStart)), 0) / HOUR;
  });
  const lines = [];
  const top = hours.indexOf(Math.max(...hours));
  if (hours[top] >= 1) lines.push(`最满的一天是<b>${WEEKDAYS[top]}</b>，排了 ${Number(hours[top].toFixed(1))} 小时。`);
  const soon = items.filter(item => item.type === 'deadline' && item.start > now && item.start <= now + 2 * DAY).sort((a, b) => a.start - b.start);
  if (soon.length) lines.push(`48 小时内有 <b>${soon.length}</b> 个截止，最近的是「${escape(soon[0].title)}」，${monthDay(soon[0].start)} ${clock(soon[0].start)}。`);
  const starts = items.filter(item => ['temporary', 'appointment'].includes(item.type) && item.start > now && item.start <= now + DAY).sort((a, b) => a.start - b.start);
  if (starts.length) lines.push(`24 小时内要出门：「${escape(starts[0].title)}」${clock(starts[0].start)} 开始${starts.length > 1 ? `，另有 ${starts.length - 1} 处` : ''}。`);
  return lines;
}

/**
 * Optional page-supplied parts (kept out of this module so the mini program can share it unchanged):
 * band(dayStart, firstHour, lastHour) draws the 专注时段带 in each day head, ribbon(...) the same intervals
 * inside each day column on the week's time axis, bandLegend explains them,
 * banner is the 重排卡 above the week, sideTop opens 本周解析 (full width), sideToday heads its right column, alertLabel badges the 解析画卷 button.
 */
export function calendarMarkup({ result, start, now, loading = false, error = '', undo = '', note = '', changes = [], plans = null, weighs = {}, focus = '', rolled = false, unrolling = false, fresh = false, analyzed = true, futureRef = '', listView = false, scrollMode = 'gongbi', xieyiBoard = '', xieyiPainting = '', xieyiCoverMeta = '', sideLedger = '', band = null, ribbon = null, energy = [], bandLegend = '', banner = '', sideTop = '', sideToday = '', alertLabel = '' }) {
  const weekConflicts = conflictsInWeek(result?.conflicts || [], start);
  const weekUndefined = undefinedInWeek(result, start);
  const items = calendarItems(result, start);
  const days = Array.from({ length: 7 }, (_, index) => start + index * DAY);
  const end = start + 7 * DAY;
  const inWeek = items.filter(item => (isLine(item) ? item.start >= start && item.start < end : item.end > start && item.start < end));
  let first = 8;
  let last = 22;
  for (const item of inWeek) {
    if (item.type === 'free') continue;
    const from = Math.max(item.start, start);
    // A line's label room stays inside its own day, so 23:59 does not pull the next day to 00:00.
    const ownDayEnd = start + (Math.floor((item.start - start) / DAY) + 1) * DAY;
    const to = Math.min(isLine(item) ? Math.min(item.start + HOUR / 2, ownDayEnd) : item.end, end);
    for (let dayStart = start + Math.floor((from - start) / DAY) * DAY; dayStart < to; dayStart += DAY) {
      first = Math.min(first, Math.floor((Math.max(from, dayStart) - dayStart) / HOUR));
      last = Math.max(last, Math.ceil((Math.min(to, dayStart + DAY) - dayStart) / HOUR));
    }
  }
  const span = (last - first) * HOUR;
  const pct = value => `${(Math.min(Math.max(value, 0), span) / span * 100).toFixed(3)}%`;
  const today = weekStart(now) === start ? Math.floor((now - start) / DAY) : -1;
  const count = type => inWeek.filter(item => item.type === type).length;
  const remaining = remainingCapacity(result, Math.max(start, Math.ceil(now / MINUTE) * MINUTE), end);

  // A day where blocks share lanes (an overlap) gets a wider column, so both titles stay readable.
  const crowded = new Set();
  const columns = days.map((dayStart, index) => {
    const dayEnd = dayStart + DAY;
    const top = dayStart + first * HOUR;
    const segment = item => ({ ...item, start: Math.max(item.start, dayStart), end: Math.min(item.end, dayEnd) });
    const free = inWeek.filter(item => item.type === 'free' && item.end > dayStart && item.start < dayEnd).map(segment)
      .map(item => ({ ...item, start: Math.max(item.start, top), end: Math.min(item.end, top + span) })).filter(item => item.end > item.start);
    const blocks = lanes(inWeek.filter(item => ['routine', 'temporary', 'appointment', 'work'].includes(item.type) && item.end > dayStart && item.start < dayEnd).map(segment));
    if (blocks.some(block => block.lanes > 1)) crowded.add(index);
    const marks = inWeek.filter(item => isLine(item) && item.start >= dayStart && item.start < dayEnd);
    const bands = free.map(item => `<button type="button" class="cal-free" data-cal-goto="time" style="top:${pct(item.start - top)};height:${pct(item.end - item.start)}" aria-label="留白 ${clock(item.start)} 至 ${item.end === dayEnd ? '24:00' : clock(item.end)}"><span>留白</span></button>`).join('');
    const body = blocks.map(item => {
      const finish = item.end === dayEnd ? '24:00' : clock(item.end);
      const label = `${LAYER_LABEL[item.type]} ${item.title} ${clock(item.start)} 至 ${finish}${item.conflict ? '，有冲突' : ''}`;
      const short = item.end - item.start < 45 * 60000;
      return `<button type="button" class="cal-block cal-${item.type}${short ? ' is-short' : ''}${item.lanes > 1 ? ' is-narrow' : ''}${item.conflict ? ' is-conflict' : ''}" ${attrs(item)} data-cal-key="${escape(item.key)}" title="${escape(label)}" style="top:${pct(item.start - top)};height:${pct(item.end - item.start)};left:calc(${(item.lane / item.lanes * 100).toFixed(3)}% + var(--lane-gap, 3px));width:calc(${(100 / item.lanes).toFixed(3)}% - 2 * var(--lane-gap, 3px))" aria-label="${escape(label)}"><strong>${escape(item.title)}</strong><span>${clock(item.start)}–${finish}${item.location ? ` · ${escape(item.location)}` : ''}</span></button>`;
    }).join('');
    const lines = marks.map(item => {
      const text = item.type === 'deadline' ? `截止 ${clock(item.start)}` : `开始 ${clock(item.start)}`;
      const state = item.type === 'deadline' ? TASK_STATE[item.state] || '' : '结束未定义';
      const low = item.start - top > span * 0.94;
      return `<button type="button" class="cal-deadline${item.type === 'start' ? ' is-start' : ''}${low ? ' is-low' : ''}${item.state === 'short' || item.state === 'overdue' ? ' is-short' : ''}" ${attrs(item)} style="top:${pct(item.start - top)}" title="${escape(`${item.title} · ${text} · ${state}`)}" aria-label="${escape(`${item.title} ${text}，${state}`)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 1.5Q13.2 10.8 22.5 12Q13.2 13.2 12 22.5Q10.8 13.2 1.5 12Q10.8 10.8 12 1.5Z" fill="currentColor"/></svg><span>${escape(item.title)} · ${text}</span></button>`;
    }).join('');
    // 叠墨 drawn where it happens: a hatched band over the overlapping minutes, labelled with its length.
    const overlaps = weekConflicts.filter(conflict => conflict.start && conflict.end && conflict.items.length === 2)
      .map(conflict => ({ conflict, from: Math.max(Date.parse(conflict.start), top), to: Math.min(Date.parse(conflict.end), dayEnd, top + span) }))
      .filter(({ from, to }) => from >= dayStart && to > from)
      .map(({ conflict, from, to }) => `<div class="cal-overlap" style="top:${pct(from - top)};height:${pct(to - from)}" aria-hidden="true"><span>叠 ${minutesText(conflict.minutes || Math.round((to - from) / MINUTE))}</span></div>`).join('');
    const needle = index === today && now >= top && now <= top + span ? `<div class="cal-now" style="top:${pct(now - top)}" aria-hidden="true"><span>${clock(now)}</span></div>` : '';
    const state = index === today ? ' is-today' : dayEnd <= now ? ' is-past' : '';
    return `<div class="cal-day${state}" role="group" aria-label="${monthDay(dayStart)} ${WEEKDAYS[index]}">${ribbon ? ribbon(dayStart, first, last) : ''}${bands}${body}${overlaps}${lines}${needle}</div>`;
  }).join('');

  const heads = days.map((dayStart, index) => {
    const d = local(dayStart);
    const state = index === today ? ' is-today' : dayStart + DAY <= now ? ' is-past' : '';
    return `<div class="cal-head-day${state}${band ? ' has-band' : ''}"><span>${WEEKDAYS[index]}</span><strong>${d.getUTCDate()}</strong>${d.getUTCDate() === 1 || index === 0 ? `<em>${d.getUTCMonth() + 1}月</em>` : ''}${band ? band(dayStart, first, last) : ''}</div>`;
  }).join('');
  const hours = Array.from({ length: last - first }, (_, index) => `<span style="top:${((index / (last - first)) * 100).toFixed(3)}%">${String(first + index).padStart(2, '0')}:00</span>`).join('');

  const agenda = days.map((dayStart, index) => {
    const dayEnd = dayStart + DAY;
    const rows = inWeek.filter(item => (isLine(item) ? item.start >= dayStart && item.start < dayEnd : item.end > dayStart && item.start < dayEnd)).sort((a, b) => a.start - b.start);
    if (!rows.length && index !== today) return '';
    const clash = weekConflicts.filter(conflict => conflict.start && conflict.end && conflict.items.length === 2 && Date.parse(conflict.start) >= dayStart && Date.parse(conflict.start) < dayEnd)
      .map(conflict => `<li><p class="cal-row cal-row-overlap"><time>${clock(Date.parse(conflict.start))}–${clock(Date.parse(conflict.end))}</time><span>「${escape(conflict.items[0].title)}」与「${escape(conflict.items[1].title)}」重叠 ${minutesText(conflict.minutes || 0)}</span><em>叠墨</em></p></li>`).join('');
    const list = clash + rows.map(item => {
      const from = Math.max(item.start, dayStart);
      const to = Math.min(item.end, dayEnd);
      const time = isLine(item) ? clock(item.start) : `${clock(from)}–${to === dayEnd ? '24:00' : clock(to)}`;
      const target = item.type === 'free' ? 'data-cal-goto="time"' : attrs(item);
      return `<li><button type="button" class="cal-row cal-row-${item.type}${item.conflict ? ' is-conflict' : ''}" ${target}><time>${time}</time><span>${item.type === 'free' ? '留白' : escape(item.title)}</span><em>${LAYER_LABEL[item.type]}</em></button></li>`;
    }).join('');
    return `<li class="cal-agenda-day${index === today ? ' is-today' : ''}"><h3>${monthDay(dayStart)} <span>${WEEKDAYS[index]}${index === today ? ' · 今天' : ''}</span></h3>${list ? `<ul>${list}</ul>` : '<p>今天还没有安排。</p>'}</li>`;
  }).join('');

  const weekEnd = start + 6 * DAY;
  const range = local(start).getUTCMonth() === local(weekEnd).getUTCMonth() ? `${monthDay(start)} — ${local(weekEnd).getUTCDate()}日` : `${monthDay(start)} — ${monthDay(weekEnd)}`;
  const status = error ? `<p class="cal-hint is-error" role="status">${escape(error)}</p>`
    : loading ? '<p class="cal-hint" role="status">正在计算这一周…</p>'
    : weekConflicts.length ? (weekUndefined.length ? `<p class="cal-hint" role="status">另有 ${weekUndefined.length} 项待书，见下方。</p>` : '')
    : weekUndefined.length ? `<p class="cal-hint" role="status">有 ${weekUndefined.length} 项待书，已按写清楚的部分落笔。</p>`
    : result ? '<p class="cal-hint" role="status">这一周没有叠墨，所有信息都已写清楚。</p>' : '';
  const empty = result && !inWeek.length ? '<div class="cal-empty"><p>这一周还是一片空白。</p><span>在「铺纸」里铺好底色、定下留白，再到「研墨」导入通知，事情会落在这里。</span></div>' : '';
  const brief = result ? weeklyBrief(inWeek, start, now) : [];
  const side = result ? sideLists(result, weekConflicts, weekUndefined, undo, note, weighs, changes, plans) : '<section class="cal-side-block"><p>计算完成后，这里列出这一周的叠墨对策、剩余留白和待书。</p></section>';
  const freeMinutes = inWeek.filter(item => item.type === 'free').reduce((sum, item) => sum + (item.end - item.start) / MINUTE, 0);
  const layerButton = (key, name, meaning, value) => `<li><button type="button" class="cal-layer lg-${key}" data-cal-focus="${key}" aria-pressed="${focus === key}"><i aria-hidden="true"></i><strong>${name}</strong><span>${meaning}</span><b>${value}</b></button></li>`;
  const layerStrip = result ? `<div class="cal-layers"><ul aria-label="四层时间，点一层只看这一层">${layerButton('routine', '底色', '每周照例的课与例会', count('routine'))}${layerButton('free', '留白', '自己支配的时间', `${Math.round(freeMinutes / 60)} 小时`)}${layerButton('work', '落笔', '约定与截止之事', count('work') + count('appointment'))}${layerButton('temporary', '点墨', '临时、突发事项', count('temporary'))}${layerButton('conflict', '叠墨', '两件事相撞', weekConflicts.filter(conflict => conflict.start).length)}</ul><p>${focus ? '再点一次，恢复全部图层' : '点一层，只看这一层'}</p></div>` : '';
  // 本周山水: 工笔 reflects scheduled calendar hours, while 写意 has its own non-conflicting 写意山水 painting.
  const isXieyi = scrollMode === 'xieyi';
  const painting = result ? shanshuiMarkup({ items: inWeek, start, now, conflicts: weekConflicts, energy, id: rolled ? 'ss-cover' : 'ss-board' }) : '';
  const activePainting = isXieyi ? (xieyiPainting || painting) : painting;
  const analyzeBadge = !analyzed && (weekConflicts.length || alertLabel) ? `<em class="cal-analyze-badge">${[weekConflicts.length ? `${weekConflicts.length} 处叠墨` : '', alertLabel].filter(Boolean).join(' · ')}</em>` : '';
  const analyzeBtn = `<button type="button" class="cal-analyze-btn${analyzed ? ' is-open' : ''}${weekConflicts.length ? ' has-alert' : ''}" data-cal-analyze aria-expanded="${analyzed}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7M17 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${analyzed ? '回到画卷' : '解析画卷'}</span>${analyzeBadge}</button>`;
  // 本周还可用: the one number the week is for, up in the bar on every view of 画卷: what is left of
  // this week's 留白 (from now on), the longest stretch, and how much of the week's 留白 that is.
  const remainLabel = start > now ? '这一周可用' : '本周还可用';
  const split = minutes => { const h = Math.floor(minutes / 60); const m = Math.round(minutes % 60); return `${h ? `${h}<small>小时</small>` : ''}${m || !h ? `${m}<small>分</small>` : ''}`; };
  const share = freeMinutes > 0 && remaining ? Math.max(0, Math.min(100, remaining.total / freeMinutes * 100)) : 0;
  const remain = result && remaining && end > now ? `<div class="cal-remain" role="group" aria-label="${remainLabel} ${minutesLabel(remaining.total)}，最长连续 ${minutesLabel(remaining.longest)}">
      <span class="cr-label">${remainLabel}</span><strong class="cr-value">${split(remaining.total)}</strong>
      <span class="cr-meta">最长连续 ${minutesLabel(remaining.longest)} · 本周留白共 ${minutesLabel(freeMinutes)}</span>
      <i class="cr-bar" aria-hidden="true"><b style="width:${share.toFixed(1)}%"></b></i>
    </div>` : '';
  const clockPill = futureRef ? `<button type="button" class="cal-clock-pill" data-use-now title="安排的起点设在了未来（铺纸里的“从什么时刻开始安排”）。点这里改成从现在开始">从 ${escape(futureRef)} 开始安排 · 改用现在</button>` : '';
  const coverEyebrow = isXieyi ? (xieyiCoverMeta ? `四时烟水 · ${escape(xieyiCoverMeta)}` : '四时烟水') : '本周山水';
  const coverTitle = isXieyi ? '竹影随心，烟波留白' : '峰高是忙，云白是留白';
  const coverLegend = isXieyi
    ? '<ul class="cover-legend is-xieyi" aria-label="四时烟水图例"><li class="lg-bamboo">墨竹 · 本日四时手卷</li><li class="lg-blossom">点朱 · 已印「成」</li><li class="lg-skiff">扁舟 · 今日所在</li><li class="lg-mist">烟波 · 无事留白</li></ul>'
    : `<ul class="cover-legend" aria-label="山水图例"><li class="lg-peak">近处深色的峰 · 这天排了多少</li><li class="lg-cloud">云 · 留白</li><li class="lg-dot">墨点 · 点墨</li><li class="lg-star">金星 · 截止</li><li class="lg-bleed">朱晕 · 叠墨</li><li class="lg-moon">朱日 · 今天</li><li class="lg-far">淡远山 · 远景，不计时</li>${energy.length ? '<li class="lg-glow">暖光 · 专注时段</li><li class="lg-haze">灰雾 · 精力偏低</li>' : ''}</ul>`;
  const cover = `<section class="scroll-cover" aria-labelledby="coverHeading">
      <header class="cover-head"><p class="cal-eyebrow">${coverEyebrow}</p><h3 id="coverHeading">${coverTitle}</h3></header>
      <div class="cover-painting">${activePainting || (error ? `<p class="cover-wait is-error" role="status">${escape(error)}</p>` : '<p class="cover-wait">正在铺开这一周…</p>')}</div>
      ${coverLegend}
      <div class="cover-actions">
        <button type="button" class="primary-button cover-open" data-scroll-open${!isXieyi && !result ? ' disabled' : ''}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 5v14M20 5v14M8 12h8M11 9l-3 3 3 3M13 9l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>${isXieyi ? '展开四时手卷' : '展开画卷'}</button>
        <button type="button" class="cover-analyze" data-cal-analyze aria-expanded="${analyzed}">${analyzed ? '收起本周解析' : `解析画卷${weekConflicts.length ? `（${weekConflicts.length} 处叠墨）` : ''}`}</button>
      </div>
    </section>`;
  const backdrop = activePainting ? `<div class="ss-backdrop" aria-hidden="true">${activePainting.replace('role="img"', 'focusable="false"')}</div><i class="unroll-ink" aria-hidden="true"></i>` : '';
  // The bar docks as the first row of what is shown: the week's board, or the 本周山水 cover when rolled.
  const docked = !analyzed;
  const bar = `<header class="cal-bar${docked ? ' is-docked' : ''}" aria-label="画卷周次与解析">
      <div class="cal-bar-left">
        <div class="cal-bar-title"><p class="cal-eyebrow">${local(start).getUTCFullYear()} · 第 ${weekNumber(start)} 周</p><h2 class="cal-range" id="calendarHeading">${range}</h2></div>
        <div class="cal-nav"><button type="button" data-cal-week="-1" aria-label="上一周"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" data-cal-week="0">本周</button><button type="button" data-cal-week="1" aria-label="下一周"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      </div>
      ${isXieyi ? '' : remain}
      <div class="cal-bar-actions">
        ${clockPill}
        <div class="cal-mode-switch" role="group" aria-label="画卷视图切换"><button type="button" data-cal-mode="gongbi" aria-pressed="${scrollMode === 'gongbi'}">工笔 · 时轴</button><button type="button" data-cal-mode="xieyi" aria-pressed="${scrollMode === 'xieyi'}">写意 · 四时</button></div>
        <button type="button" class="text-button cal-companion-btn" data-open-companion>案头伴读</button>
        ${result && !rolled && !isXieyi ? `<button type="button" class="text-button cal-view-toggle" data-cal-view aria-pressed="${listView}">${listView ? '周网格' : '列表'}</button>` : ''}
        ${!rolled && (result || isXieyi) ? '<button type="button" class="text-button cal-roll-up" data-scroll-roll>卷起画卷</button>' : ''}
        ${analyzeBtn}
      </div>
    </header>`;
  return `<div class="scroll${rolled ? ' is-rolled' : ''}${rolled && fresh ? ' is-fresh' : ''}${unrolling ? ' is-unrolling' : ''}${analyzed ? ' is-analyzed' : ' is-solo'}${listView ? ' is-list' : ''}${scrollMode === 'xieyi' ? ' is-xieyi' : ''}">
    ${docked ? '' : bar}
    <div class="scroll-body">
      <aside class="scroll-side" aria-label="本周解析"${analyzed ? '' : ' hidden'}>
        <div class="side-head"><span>本周解析</span></div>
        ${sideTop}
        ${status}
        <div class="cal-pending">${side}</div>
        <div class="side-aside">
          ${sideToday}
          <div class="cal-remind-slot"></div>
          ${sideLedger}
          ${end > now && result ? (remaining ? `<section class="cal-capacity" aria-label="这周还能接多少"><h3>${start > now ? '这一周还能接' : '这周还能接'}</h3><p><strong>${minutesLabel(remaining.total)}</strong><span>最长连续 ${minutesLabel(remaining.longest)}${remaining.longestSlot ? `：${monthDay(remaining.longestSlot.start)} ${WEEKDAYS[Math.floor((remaining.longestSlot.start - start) / DAY)] || ''} ${clock(remaining.longestSlot.start)}–${clock(remaining.longestSlot.end)}` : ''}</span>${weekUndefined.length ? '<span>待补时间的事项可能占用空档。</span>' : ''}</p><a href="#/import?capacity=1">再接一件事？先试算</a></section>`
            : `<section class="cal-capacity is-unknown" aria-label="这周还能接多少"><h3>这周还能接多少</h3><p><span>还算不出来：每天的作息还没定，系统不知道哪些时间归你支配。</span></p><button type="button" class="text-button" data-cal-goto="time" data-cal-roll="free">去铺纸设置作息 →</button></section>`) : ''}
          ${brief.length ? `<ul class="cal-brief" aria-label="本周提要">${brief.map(line => `<li>${line}</li>`).join('')}</ul>` : ''}
        </div>
      </aside>
      ${rolled ? cover.replace('<section class="scroll-cover" aria-labelledby="coverHeading">', head => head + bar) : (scrollMode === 'xieyi' && xieyiBoard
        ? `    <div class="scroll-mount"><div class="cal-board">${backdrop}${docked ? bar : ''}${banner}${xieyiBoard}</div></div>`
        : `    <div class="scroll-mount"><div class="cal-board">${backdrop}${docked ? bar : ''}${banner}${layerStrip}${bandLegend}
        <div class="cal-week${crowded.size ? ' has-crowded' : ''}${band ? ' has-band' : ''}"${focus ? ` data-focus="${escape(focus)}"` : ''} style="--rows:${last - first}${crowded.size ? `;--cols:var(--time-col, 54px) ${days.map((_, index) => crowded.has(index) ? 'minmax(0, 1.5fr)' : 'minmax(0, 1fr)').join(' ')}` : ''}">
          <div class="cal-corner" aria-hidden="true"></div>${heads}
          <div class="cal-hours" aria-hidden="true">${hours}</div>${columns}
        </div>${empty}
        <ol class="cal-agenda">${agenda || '<li class="cal-agenda-day"><p>这一周还没有安排。</p></li>'}</ol>
      </div></div>`)}
    </div>
  </div>`;
}
