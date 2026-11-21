/**
 * 专注与休息（认知带宽）— the page side of the backend's replan loop (/api/v3/replan/preview + confirm).
 *
 * The backend plans, compares and verifies; this module only keeps what the user said and draws it:
 * - 常用专注时段, set once in 铺纸; a task's mark (需要专注 / 适合碎片时间), set in 笔墨 when it matters;
 *   temporary 精力 windows said in 研磨. They live beside the v3 snapshot (whose contract allows no extra
 *   fields), in this browser only, and go to the backend with every preview.
 * - One sentence in 研磨 → a draft of the change: an interruption, a rest to keep, or a low/high-energy window.
 *   Nothing is written until the user picks a plan; rests and interruptions are then written by the backend.
 * - The 专注时段带 above the week and the 重排卡. Self-reported intervals are drawn as intervals with their
 *   source, never as a measured curve.
 */
export const FOCUS_KEY = 'sixu.focus.v1';
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OFFSET = 8 * HOUR; // Asia/Shanghai
const pad = value => String(value).padStart(2, '0');
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const dayStartOf = ms => Math.floor((ms + OFFSET) / DAY) * DAY - OFFSET;
export const weekdayOf = ms => ((new Date(ms + OFFSET).getUTCDay() + 6) % 7) + 1; // 1 = Monday
export const hm = ms => { const d = new Date(ms + OFFSET); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
export function isoAt(ms) {
  const d = new Date(ms + OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+08:00`;
}
const monthDay = ms => { const d = new Date(ms + OFFSET); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };
export const dayLabel = ms => `${monthDay(ms)} ${WEEKDAY[weekdayOf(ms) - 1]}`;
const clockMinutes = text => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };
export const spanText = (start, end) => `${hm(start)}–${end - dayStartOf(start) >= DAY ? '24:00' : hm(end)}`;
const minutesText = minutes => (minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}` : `${minutes} 分钟`);

// ---- Settings ---------------------------------------------------------------
export function emptyFocus() { return { windows: [], states: [], marks: {} }; }
export function normalizeFocus(value) {
  const out = emptyFocus();
  if (!value || typeof value !== 'object') return out;
  for (const w of Array.isArray(value.windows) ? value.windows : []) {
    if (!w || !CLOCK.test(w.start) || !CLOCK.test(w.end) || clockMinutes(w.end) <= clockMinutes(w.start) || !Array.isArray(w.weekdays)) continue;
    const weekdays = [...new Set(w.weekdays.filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort();
    if (weekdays.length) out.windows.push({ id: String(w.id || `w${out.windows.length + 1}`), weekdays, start: w.start, end: w.end });
  }
  for (const s of Array.isArray(value.states) ? value.states : []) {
    const start = Date.parse(s?.start_at);
    const end = Date.parse(s?.end_at);
    if (s && ['low', 'high'].includes(s.level) && Number.isFinite(start) && end > start) {
      out.states.push({ id: String(s.id || `s${out.states.length + 1}`), level: s.level, start_at: s.start_at, end_at: s.end_at, text: String(s.text || '').slice(0, 120) });
    }
  }
  if (value.marks && typeof value.marks === 'object') {
    for (const [id, mark] of Object.entries(value.marks)) if (['focus', 'fragment'].includes(mark)) out.marks[id] = mark;
  }
  return out;
}
export function readFocus(storage) {
  try { return normalizeFocus(JSON.parse(storage.getItem(FOCUS_KEY) || 'null')); } catch { return emptyFocus(); }
}
export function writeFocus(storage, focus) {
  try { storage.setItem(FOCUS_KEY, JSON.stringify(focus)); return true; } catch { return false; }
}
/** Temporary windows that ended more than a day ago say nothing about now. */
export function pruneStates(focus, now) {
  return { ...focus, states: focus.states.filter(state => Date.parse(state.end_at) > now - DAY) };
}
export function setMark(focus, taskId, mark) {
  const marks = { ...focus.marks };
  if (mark && marks[taskId] !== mark) marks[taskId] = mark; else delete marks[taskId];
  return { ...focus, marks };
}
/** Common focus windows from the 铺纸 form: weekdays and weekend, each optional. */
export function setCommonWindows(focus, { weekday = null, weekend = null }) {
  const windows = [];
  for (const [id, days, span] of [['w-weekday', [1, 2, 3, 4, 5], weekday], ['w-weekend', [6, 7], weekend]]) {
    if (!span) continue;
    if (!CLOCK.test(span.start) || !CLOCK.test(span.end) || clockMinutes(span.end) <= clockMinutes(span.start)) throw new Error('专注时段的结束要晚于开始');
    windows.push({ id, weekdays: days, start: span.start, end: span.end });
  }
  return { ...focus, windows };
}
export function addStates(focus, states) {
  const kept = focus.states.filter(old => !states.some(next => next.id === old.id));
  return { ...focus, states: [...kept, ...states] };
}
export function removeState(focus, id) {
  return { ...focus, states: focus.states.filter(state => state.id !== id) };
}

// ---- One sentence in 研磨 → a draft change -------------------------------------
const REST = /(歇|休息|躺|放空|喘口气|午睡|睡一会|眯一会|缓一缓|缓一下)/;
const LOW = /(累|困|乏|没精神|没精力|没劲|状态(?:不好|很差|差|一般)|头(?:疼|痛|晕)|不舒服|转不动|脑子很乱)/;
const HIGH = /(状态(?:不错|很好|挺好)|精神(?:不错|很好|挺好)|能专心|很专注|能专注|静得下心|效率(?:高|不错|很高))/;
const DISRUPT = /(开.{0,6}会|被(?:叫|拉|喊)|临时|突然|找我|帮(?:忙|辅导员|老师|同学)|搬东西|值班|加班|排练|集合|面试)/;
const NOT_STATE = /^(?:提醒我|帮我记|记得|别忘了|待办)|【|通知|截止|提交|报名|作业|考试|讲座|\d{4}年|[？?]$/;
const NUM = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 };
function chineseNumber(word) {
  const digit = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (word === '十') return 10;
  if (word.startsWith('十')) return 10 + (digit[word[1]] ?? 0);
  if (word.includes('十')) return (digit[word[0]] ?? 1) * 10 + (digit[word[2]] ?? 0);
  return digit[word] ?? 0;
}
/** A bare hour reads as the afternoon or evening unless 上午/早上 says otherwise: "三点" is 15:00, not 03:00. */
function hourOf(text, period, afternoonHint) {
  let hour = Number(text);
  if (!Number.isInteger(hour) || hour > 24) return null;
  if (/上午|早上|早晨|明早/.test(period)) return hour;
  if (hour >= 1 && hour < 12 && (/下午|晚上|今晚|傍晚|明晚/.test(period) || afternoonHint || hour <= 7)) hour += 12;
  return hour;
}
/**
 * "下午四点半到五点半想歇会儿" → a rest to keep; "三点到四点临时要帮辅导员搬东西" → an interruption;
 * "有点累" → a low-energy window from now. Returns null for anything that is not a plain statement about
 * one's state or an interruption (a reminder, a notice, a question).
 */
export function parseStateSentence(text, now) {
  const line = String(text || '').trim().replace(/：/g, ':').replace(/，|,/g, ' ');
  if (!line || line.length > 60 || NOT_STATE.test(line)) return null;
  const disrupt = DISRUPT.test(line);
  const rest = !disrupt && REST.test(line);
  const level = !disrupt && !rest ? (LOW.test(line) ? 'low' : HIGH.test(line) ? 'high' : null) : null;
  if (!disrupt && !rest && !level) return null;
  const digits = line.replace(/[零〇一二两三四五六七八九十]+(?=点)/g, word => String(chineseNumber(word)));
  const dayShift = /明天|明早|明晚/.test(digits) ? 1 : 0;
  const base = dayStartOf(now) + dayShift * DAY;
  const period = (digits.match(/上午|早上|早晨|中午|下午|傍晚|晚上|今晚|明晚|明早/) || [''])[0];
  const afternoonHint = !dayShift && now - dayStartOf(now) >= 12 * HOUR;
  const startNow = Math.ceil(now / (5 * MINUTE)) * 5 * MINUTE;
  const minuteOf = value => (value === '半' ? 30 : value ? Number(value) : 0);
  const at = (hourText, minuteText) => { const hour = hourOf(hourText, period, afternoonHint || /下午|晚上/.test(period)); return hour === null ? NaN : base + (hour * 60 + minuteOf(minuteText)) * MINUTE; };
  let start = null;
  let end = null;
  const range = digits.match(/(\d{1,2})(?:点|:)(半|\d{2})?\s*(?:分)?\s*(?:到|至|-|—|~)\s*(\d{1,2})(?:点|:)?(半|\d{2})?/);
  const until = digits.match(/到\s*(\d{1,2})(?:点|:)(半|\d{2})?/);
  const after = digits.match(/(\d{1,2})(?:点|:)(半|\d{2})?\s*(?:以后|之后|后)/);
  const length = digits.match(/(半|一|两|二|三|四|\d+(?:\.\d)?)\s*个?\s*(半)?\s*小时|(\d+)\s*分钟/);
  if (range) {
    start = at(range[1], range[2]);
    end = at(range[3], range[4]);
    if (end <= start) end += 12 * HOUR;
  } else if (after) {
    start = at(after[1], after[2]);
    end = level === 'high' ? start + 2 * HOUR : base + 23 * HOUR;
  } else if (until) {
    start = dayShift ? base + 8 * HOUR : startNow;
    end = at(until[1], until[2]);
  } else if (length) {
    const minutes = length[3] ? Number(length[3]) : ((NUM[length[1]] ?? Number(length[1])) + (length[2] ? 0.5 : 0)) * 60;
    start = dayShift ? base + 8 * HOUR : startNow;
    end = start + Math.round(minutes) * MINUTE;
  } else if (disrupt) {
    return { kind: 'disruption', missing: '什么时候到什么时候', text: line };
  } else if (/早点(?:休息|睡)/.test(digits)) {
    start = Math.max(startNow, base + 21 * HOUR + 30 * MINUTE);
    end = base + 23 * HOUR;
  } else if (/今晚|晚上|明晚/.test(period)) {
    start = Math.max(startNow, base + 19 * HOUR);
    end = base + 23 * HOUR;
  } else if (period === '下午') {
    start = Math.max(startNow, base + 13 * HOUR);
    end = base + 18 * HOUR;
  } else {
    start = dayShift ? base + 8 * HOUR : startNow;
    end = start + (rest ? 60 : level === 'low' ? 180 : 120) * MINUTE;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 16 * HOUR) return null;
  if (!dayShift) start = Math.max(start, startNow);
  if (end <= start) return null;
  const id = `${start.toString(36)}`;
  if (disrupt) {
    const title = line.replace(/(?:今天|明天|下午|上午|晚上|今晚|刚刚?|突然|临时|我)/g, '').replace(/\d{1,2}(?:点|:)(?:半|\d{2})?(?:分)?\s*(?:到|至|-|—|~)\s*\d{1,2}(?:点|:)?(?:半|\d{2})?/g, '').replace(/[零〇一二两三四五六七八九十\d]+点半?(?:到|至)[零〇一二两三四五六七八九十\d]+点半?/g, '').replace(/^[\s了要得被]+|[\s了]+$/g, '').slice(0, 30) || '临时打断';
    return { kind: 'disruption', text: line, disruption: { id: `e-cut-${id}`, title, start_at: isoAt(start), end_at: isoAt(end), location: null } };
  }
  if (rest) return { kind: 'rest', text: line, rest: { id: `rest-${id}`, label: line.slice(0, 20), start: isoAt(start), end: isoAt(end), locked: true } };
  return { kind: 'energy', text: line, state: { id: `st-${id}-${level}`, level, start_at: isoAt(start), end_at: isoAt(end), text: line } };
}
export function draftLabel(draft) {
  if (draft.disruption) return `临时打断「${draft.disruption.title}」${dayLabel(Date.parse(draft.disruption.start_at))} ${spanText(Date.parse(draft.disruption.start_at), Date.parse(draft.disruption.end_at))}`;
  if (draft.rest) return `留出休息 ${dayLabel(Date.parse(draft.rest.start))} ${spanText(Date.parse(draft.rest.start), Date.parse(draft.rest.end))}`;
  if (draft.state) return `${draft.state.level === 'low' ? '精力偏低' : '状态不错'} ${dayLabel(Date.parse(draft.state.start_at))} ${spanText(Date.parse(draft.state.start_at), Date.parse(draft.state.end_at))}`;
  return '';
}

// ---- The preview request ---------------------------------------------------------
/** Everything the user said, in the shape /api/v3/replan/preview takes. */
export function previewRequest({ snapshot, focus, draft = null, now, range, history = [] }) {
  const states = draft?.state ? addStates(focus, [draft.state]).states : focus.states;
  const focusWindows = [
    ...focus.windows.map(w => ({ weekdays: w.weekdays, start: w.start, end: w.end, level: 'high', label: '常用专注时段' })),
    ...states.filter(state => Date.parse(state.end_at) > now).map(state => ({ start: state.start_at, end: state.end_at, level: state.level, label: state.level === 'low' ? '精力偏低' : '临时专注' })),
  ];
  const profiles = {};
  for (const task of snapshot.tasks) {
    const mark = focus.marks[task.id];
    if (mark && task.status === 'active') profiles[task.id] = { cognitive_load: mark === 'focus' ? 'high' : 'low' };
  }
  const body = { snapshot, range, now: isoAt(Math.floor(now / MINUTE) * MINUTE), focus_windows: focusWindows, task_profiles: profiles, include_starter: true, starter_mode: 'rules' };
  if (draft?.disruption) body.disruptions = [draft.disruption];
  if (draft?.rest) body.rest_blocks = [draft.rest];
  if (history.length >= 2) body.calibration_history = history.slice(-30);
  return body;
}
/** Confirm with the same range and clock the preview used, so both sides plan the same days. */
export function confirmRequest({ snapshot, range, preview, plan, now = null }) {
  const body = { snapshot, range, base_revision: preview.base_revision, snapshot_fingerprint: preview.snapshot_fingerprint, plan_id: plan.plan_id,
    preview_token: plan.preview_token, preview_snapshot: plan.preview_snapshot, expected_schedule: plan.expected_schedule };
  if (now) body.now = now;
  return body;
}
const dateText = ms => { const d = new Date(ms + OFFSET); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
/**
 * The days a replan has to look at: from this Monday to the latest active deadline (or the planning start
 * a demo pinned in the future), at most 31 days. A single week would miss a task due next Wednesday and
 * report it as impossible.
 */
export function replanRange(snapshot, draft, now) {
  const from = dayStartOf(now) - (weekdayOf(now) - 1) * DAY;
  let last = from + 6 * DAY;
  const reach = ms => { if (Number.isFinite(ms) && ms > now) last = Math.max(last, dayStartOf(ms)); };
  for (const task of snapshot.tasks) if (task.status === 'active' && task.deadline_at) reach(Date.parse(task.deadline_at));
  reach(Date.parse(snapshot.reference_time));
  reach(Date.parse(draft?.disruption?.end_at || draft?.rest?.end || draft?.state?.end_at || ''));
  return { from: dateText(from), to: dateText(Math.min(last, from + 30 * DAY)) };
}

// ---- The band ---------------------------------------------------------------------
/** Rests already written into the list by a confirmed replan (the backend notes them 锁定休息：…). */
export function lockedRests(snapshot) {
  return snapshot.free_adjustments.filter(item => item.kind === 'remove' && /^锁定休息/.test(item.note || ''))
    .map(item => ({ start: Date.parse(item.start_at), end: Date.parse(item.end_at), label: (item.note || '').replace(/^锁定休息[:：]?/, '') }));
}
/** What the 专注时段带 draws for one day, each segment with where it came from. */
export function daySegments(focus, snapshot, dayStart, pending = null) {
  const dayEnd = dayStart + DAY;
  const out = [];
  const clip = (kind, start, end, source) => { const a = Math.max(start, dayStart); const b = Math.min(end, dayEnd); if (b > a) out.push({ kind, start: a, end: b, source }); };
  for (const w of focus.windows) if (w.weekdays.includes(weekdayOf(dayStart + HOUR))) clip('focus', dayStart + clockMinutes(w.start) * MINUTE, dayStart + clockMinutes(w.end) * MINUTE, '铺纸 · 常用专注时段');
  for (const state of focus.states) clip(state.level === 'low' ? 'low' : 'high', Date.parse(state.start_at), Date.parse(state.end_at), `研磨 · “${state.text}”`);
  for (const rest of lockedRests(snapshot)) clip('rest', rest.start, rest.end, `研磨 · 休息“${rest.label}”`);
  if (pending?.rest) clip('rest', Date.parse(pending.rest.start), Date.parse(pending.rest.end), `研磨 · “${pending.text}”（待你选方案）`);
  if (pending?.state) clip(pending.state.level === 'low' ? 'low' : 'high', Date.parse(pending.state.start_at), Date.parse(pending.state.end_at), `研磨 · “${pending.text}”（待你选方案）`);
  const order = { focus: 0, high: 1, low: 2, rest: 3 };
  return out.sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]);
}
const SEG_NAME = { focus: '专注', high: '临时专注', low: '精力偏低', rest: '休息' };
/** The band inside one day head: shaded intervals across the hours the grid shows. */
export function bandMarkup(focus, snapshot, dayStart, firstHour, lastHour, pending = null) {
  const top = dayStart + firstHour * HOUR;
  const width = (lastHour - firstHour) * HOUR;
  const segments = daySegments(focus, snapshot, dayStart, pending).map(segment => {
    const a = Math.max(segment.start, top);
    const b = Math.min(segment.end, top + width);
    if (b <= a) return '';
    const label = `${SEG_NAME[segment.kind]} ${spanText(segment.start, segment.end)} · 来自${segment.source}`;
    return `<i class="fb-seg fb-${segment.kind}" style="left:${((a - top) / width * 100).toFixed(2)}%;width:${((b - a) / width * 100).toFixed(2)}%" title="${escape(label)}"><span class="sr-only">${escape(label)}</span></i>`;
  }).join('');
  return segments ? `<span class="cal-fb">${segments}</span>` : '<span class="cal-fb is-empty"></span>';
}
export function bandUsed(focus, snapshot, pending = null) {
  return Boolean(focus.windows.length || focus.states.length || lockedRests(snapshot).length || pending?.rest || pending?.state);
}
export function bandLegend(focus, snapshot, pending = null) {
  const kinds = new Set(focus.windows.length ? ['focus'] : []);
  for (const state of focus.states) kinds.add(state.level === 'low' ? 'low' : 'high');
  if (lockedRests(snapshot).length || pending?.rest) kinds.add('rest');
  if (pending?.state) kinds.add(pending.state.level === 'low' ? 'low' : 'high');
  if (!kinds.size) return '';
  const item = (kind, text) => (kinds.has(kind) ? `<li class="fb-key fb-${kind}"><i aria-hidden="true"></i>${text}</li>` : '');
  return `<ul class="fb-legend" aria-label="专注时段带：每天格子上方的细条">${item('focus', '专注 · 铺纸设的常用时段')}${item('high', '临时专注 · 研磨里说的')}${item('low', '精力偏低 · 研磨里说的')}${item('rest', '休息 · 研磨里说的')}<li class="fb-note">自评的区间，不是测量</li></ul>`;
}
/** 解析画卷 on a phone: today's state, without the band. */
export function todayStateMarkup(focus, snapshot, now, pending = null) {
  const segments = daySegments(focus, snapshot, dayStartOf(now), pending).filter(segment => segment.end > now);
  if (!segments.length) return '';
  const rows = segments.map(segment => `<li class="fb-key fb-${segment.kind}"><i aria-hidden="true"></i><b>${SEG_NAME[segment.kind]} ${spanText(segment.start, segment.end)}</b><span>${escape(segment.source)}</span></li>`).join('');
  return `<section class="cal-side-block fb-today" aria-label="今天的状态"><h3>今天的状态</h3><ul>${rows}</ul></section>`;
}

// ---- The 重排卡 ---------------------------------------------------------------------
const blocksText = list => (list?.length ? list.map(block => `${monthDay(Date.parse(block.start))} ${spanText(Date.parse(block.start), Date.parse(block.end))}`).join('、') : '未排入');
/**
 * state: { loading, draft } | { error, draft } | { preview, chosen, draft, timer } | { applied, label, starter, timer }
 * The card shows only what the user must decide: why, from when to when, the plans' costs, and a start.
 */
export function replanMarkup(state, place = 'board') {
  if (!state) return '';
  const where = ` rp-${place}`;
  if (state.loading) return `<section class="rp-card is-loading${where}" aria-live="polite"><p class="rp-eyebrow">${escape(state.draft ? draftLabel(state.draft) : '')}</p><p>正在按你说的重算这一周…</p></section>`;
  if (state.error) return `<section class="rp-card is-error${where}" role="status"><p>${escape(state.error)}</p><div class="rp-actions"><button type="button" class="text-button" data-rp-dismiss>知道了</button></div></section>`;
  if (state.applied) {
    return `<section class="rp-card is-applied${where}" aria-label="已采用的重排"><p class="rp-done"><b>已采用：</b>${escape(state.label)}<button type="button" class="text-button" data-strategy-undo>撤销</button></p>${state.starter ? starterMarkup(state.starter, state.timer) : ''}</section>`;
  }
  const preview = state.preview;
  if (!preview) return '';
  if (preview.status === 'infeasible') {
    const gaps = (preview.missing_windows || []).map(gap => `<li><b>「${escape(gap.title)}」还差 ${minutesText(gap.shortfall_minutes)}</b><span>${escape(gap.summary || '')}</span></li>`).join('');
    return `<section class="rp-card is-infeasible${where}" aria-labelledby="rpHead-${place}"><header class="rp-head"><p class="rp-eyebrow">${escape(draftLabel(state.draft || {}))}</p><h3 id="rpHead-${place}">照这样，截止前排不下</h3></header>
      <ul class="rp-gaps">${gaps}</ul><p class="rp-note">${escape(preview.decision_reason || '')}</p>
      <div class="rp-actions"><button type="button" class="text-button" data-rp-dismiss>先不改，回去调整</button></div></section>`;
  }
  const plans = preview.candidate_plans || [];
  const chosen = plans.find(plan => plan.plan_id === state.chosen) || plans.find(plan => plan.recommended) || plans[0];
  if (!chosen) return '';
  const changed = chosen.task_changes.filter(change => change.changed);
  const why = changed.map(change => change.move_reason).filter(Boolean);
  const moves = changed.map(change => `<li><span>「${escape(change.title)}」</span><s>${escape(blocksText(change.before))}</s><i aria-hidden="true">→</i><b>${escape(blocksText(change.after))}</b></li>`).join('');
  const options = plans.map(plan => {
    const m = plan.metrics || {};
    return `<li><button type="button" class="rp-plan${plan === chosen ? ' is-chosen' : ''}" data-rp-pick="${escape(plan.plan_id)}" aria-pressed="${plan === chosen}">
      <strong>${escape(plan.name)}${plan.recommended ? '<span class="rp-tag">推荐</span>' : ''}</strong>
      <span class="rp-m"><small>截止余量</small><em>最紧 ${minutesText(m.min_deadline_buffer_minutes ?? 0)}</em></span>
      <span class="rp-m"><small>改动</small><em>${m.moved_minutes ? `挪 ${minutesText(m.moved_minutes)}` : '不改'}</em></span>
      ${plan.tradeoff_vs_recommended ? `<span class="rp-trade">${escape(plan.tradeoff_vs_recommended)}</span>` : ''}
    </button></li>`;
  }).join('');
  return `<section class="rp-card${where}" aria-labelledby="rpHead-${place}">
    <header class="rp-head"><p class="rp-eyebrow">${escape(state.draft ? draftLabel(state.draft) : '计划有变')}</p><h3 id="rpHead-${place}">${changed.length ? `挪 ${changed.length} 件事，截止都赶得上` : '安排不用动'}</h3></header>
    ${why.length ? `<div class="rp-why"><p class="rp-label">为什么改</p>${why.map(line => `<p>${escape(line)}</p>`).join('')}</div>` : ''}
    ${moves ? `<div class="rp-moves"><p class="rp-label">从几点移到几点</p><ul>${moves}</ul></div>` : ''}
    ${plans.length > 1 ? `<ol class="rp-plans" aria-label="备选方案，按先保截止余量、再少改、最后看专注排序">${options}</ol>` : ''}
    ${preview.five_minute_starter ? starterMarkup(preview.five_minute_starter, state.timer) : ''}
    <div class="rp-actions"><button type="button" class="primary-button" data-rp-apply${state.applying ? ' disabled' : ''}>${state.applying ? '正在写回…' : `采用「${escape(chosen.name)}」`}</button><button type="button" class="text-button" data-rp-dismiss>这次不改</button></div>
  </section>`;
}
function starterMarkup(starter, timer) {
  const left = timer ? `${Math.floor(timer / 60)}:${pad(timer % 60)}` : '';
  return `<div class="rp-now"><p class="rp-label">现在五分钟能做什么${starter.resting ? `<span>（你在休息${starter.resting_until ? `，到 ${hm(Date.parse(starter.resting_until))}` : ''}，想歇就歇）</span>` : ''}</p><p class="rp-step">${escape(starter.action)}</p>
    <button type="button" class="rp-start${timer ? ' is-running' : ''}" data-rp-start>${timer ? `还剩 ${left} · 结束` : '开始 5 分钟'}</button></div>`;
}
