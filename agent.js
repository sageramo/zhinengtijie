import { isTimestamp } from './task-state.js';
import { SnapshotStore } from './snapshot-store.js';
import {
  TIME_STORAGE_KEY, ESTIMATE_PRESETS, createTimeSnapshot, serializeTimeSnapshot, parseTimeSnapshot, readTimeSnapshot,
  addImported, updateTask, updateEvent, addTask, addEvent, removeItem, setDailyWindow, addRoutine,
  addAdjustment, addTimetable, setReferenceTime, skipRoutineDate,
} from './time-state.js';
import { calendarMarkup, weekStart, weekRange } from './calendar.js';
import { createRecognizer, imageProblem } from './screenshot-ocr.js';

/*
 * Workbench for the four time layers (backend docs/time_layers_v3.md):
 * 导入 adds notice items at once, 事项 edits temporary occupancy and work,
 * 时间 sets the daily window, routines (manual or timetable) and free-time
 * adjustments, 日历 shows what /api/v3/calendar computes. Missing values stay
 * "undefined" and never block other items.
 */
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DEFAULT_WINDOW = [...Array(5).fill({ start: '08:00', end: '23:00' }), ...Array(2).fill({ start: '09:00', end: '23:00' })];
const DEFAULT_PERIODS = ['1 08:00-08:50', '2 09:00-09:50', '3 10:10-11:00', '4 11:10-12:00', '5 13:30-14:20', '6 14:20-15:10',
  '7 15:30-16:20', '8 16:20-17:00', '9 18:00-18:50', '10 19:00-19:50', '11 20:00-20:50', '12 21:00-21:50'].join('\n');
// 书画 names: 底色 routine, 留白 free, 落笔 work and appointments, 点墨 temporary, 叠墨 conflict, 待书 undefined.
const TASK_STATE = { scheduled: ['已落笔', 'ok'], estimate_undefined: ['待书：预计用时未填', 'undefined'], deadline_undefined: ['待书：截止未填', 'undefined'],
  free_time_undefined: ['待书：留白未设定', 'undefined'], short: ['留白不够落笔', 'conflict'], overdue: ['已过截止', 'conflict'],
  beyond_horizon: ['截止超出31天，临近再排', 'undefined'], not_attempted: ['暂未安排', 'undefined'], completed: ['已完成', 'done'], cancelled: ['不做了', 'done'] };
const currentMinuteISO = () => new Date(Math.ceil(Date.now() / 60000) * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const toLocalInput = iso => isTimestamp(iso) ? new Date(Date.parse(iso) + OFFSET).toISOString().slice(0, 16) : '';
const localDate = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);
function fromLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const iso = `${value}:00+08:00`;
  return isTimestamp(iso) ? iso : null;
}
function readable(iso) {
  if (!isTimestamp(iso)) return '';
  const local = new Date(Date.parse(iso) + OFFSET);
  return `${local.getUTCMonth() + 1}月${local.getUTCDate()}日 ${local.toISOString().slice(11, 16)}`;
}
const scrollBehavior = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

let storage;
try { storage = window.localStorage; } catch { storage = null; }
const recovered = readTimeSnapshot(storage);
const snapshotStore = new SnapshotStore(storage, { key: TIME_STORAGE_KEY, initialRaw: recovered.raw, serialize: serializeTimeSnapshot });
let snapshot = recovered.snapshot || createTimeSnapshot({ referenceTime: currentMinuteISO() });
let storageLocked = Boolean(recovered.error);
let externalConflict = false;
let apiBase = window.CAMPUS_AGENT_API || 'http://127.0.0.1:8765';
try { apiBase = storage?.getItem('sixu.api-base') || apiBase; } catch { /* Data can still be edited in memory. */ }
let healthBase = null;
let health = null;
let calendarResult = null;
let calendarError = '';
let calendarLoading = false;
let calendarSequence = 0;
let calendarTimer = null;
let calendarWeek = null;
let strategyUndo = null; // { before, label } of the last 叠墨 strategy applied
let parseSequence = 0;
let connectionSequence = 0;
let timetableSequence = 0;
let lastTimetable = null;

// Messages float over the page and fade on their own (errors stay longer); a click dismisses them.
let tellTimer = null;
function tell(message, type = '') {
  $('appMessage').textContent = message;
  $('appMessage').className = `message toast ${type}`.trim();
  $('appMessage').hidden = !message;
  window.clearTimeout(tellTimer);
  if (message) tellTimer = window.setTimeout(() => { $('appMessage').hidden = true; }, type === 'error' ? 10000 : 5000);
}
$('appMessage').addEventListener('click', () => { window.clearTimeout(tellTimer); $('appMessage').hidden = true; });

// ---- Rolls: 铺纸 and 笔墨 show two rolled cards; one unrolls at a time, 返回 rolls it up again.
function openRoll(key) {
  const roll = document.querySelector(`[data-roll="${key}"]`);
  const group = roll?.closest('[data-rolls]');
  if (!group) return;
  group.dataset.open = key;
  for (const item of group.querySelectorAll('[data-roll]')) item.classList.toggle('is-open', item === roll);
  for (const face of group.querySelectorAll('[data-roll-open]')) face.setAttribute('aria-expanded', String(face.dataset.rollOpen === key));
}
function closeRolls(group) {
  delete group.dataset.open;
  for (const item of group.querySelectorAll('[data-roll]')) item.classList.remove('is-open');
  for (const face of group.querySelectorAll('[data-roll-open]')) face.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', event => {
  const face = event.target.closest('[data-roll-open]');
  if (face) { openRoll(face.dataset.rollOpen); window.scrollTo({ top: 0, behavior: scrollBehavior() }); return; }
  const back = event.target.closest('[data-roll-close]');
  if (back) { closeRolls(back.closest('[data-rolls]')); window.scrollTo({ top: 0, behavior: scrollBehavior() }); }
});
function renderRollFaces() {
  const set = (key, lines) => { $(`rollSummary-${key}`).innerHTML = lines.filter(Boolean).map(line => `<span>${line}</span>`).join(''); };
  const routines = snapshot.routines;
  set('routine', [routines.length ? `<b>${routines.length}</b> 处每周照例` : '没有底色也能算，铺了更准',
    routines.slice(0, 3).map(item => escapeHTML(item.title)).join('、') + (routines.length > 3 ? ' 等' : '')]);
  const windows = snapshot.daily_window;
  const ranges = windows ? [...new Set(windows.filter(Boolean).map(window => `${window.start}–${window.end}`))] : [];
  const adds = snapshot.free_adjustments.length;
  set('free', [windows ? `作息 ${ranges.slice(0, 2).join('、')}${ranges.length > 2 ? ' 等' : ''}` : '<em>作息未设定，留白待书</em>', adds ? `<b>${adds}</b> 处临时调整` : '']);
  const active = list => list.filter(item => item.status === 'active');
  const appointments = active(snapshot.events).filter(item => item.kind === 'appointment');
  const events = active(snapshot.events).filter(item => item.kind !== 'appointment');
  const tasks = active(snapshot.tasks);
  const pendingTasks = tasks.filter(task => task.deadline_at === null || task.estimate_minutes === null).length;
  set('work', [`<b>${appointments.length}</b> 件约定 · <b>${tasks.length}</b> 件截止之事`, pendingTasks ? `<em>${pendingTasks} 件待书</em>` : '']);
  const pendingEvents = events.filter(item => !item.start_at || !item.end_at).length;
  set('event', [`<b>${events.length}</b> 处点墨`, events.slice(0, 2).map(item => escapeHTML(item.title)).join('、'), pendingEvents ? `<em>${pendingEvents} 处时间待书</em>` : '']);
}
function busy(button, value, idle, working) {
  button.disabled = value;
  button.setAttribute('aria-busy', String(value));
  button.textContent = value ? working : idle;
}

async function save() {
  if (storageLocked || externalConflict) {
    $('saveState').textContent = '当前修改尚未保存，请先导出备份';
    return;
  }
  $('saveState').textContent = '正在保存当前清单…';
  const saved = await snapshotStore.save(snapshot);
  if (saved.superseded) return;
  if (saved.conflict) {
    externalConflict = true;
    $('storageConflict').hidden = false;
    $('saveState').textContent = '保存遇到版本变化，请先导出当前内容';
    return;
  }
  $('saveState').textContent = saved.saved ? '已保存在当前浏览器' : '浏览器保存失败，请导出清单备份';
  if (!saved.saved) $('saveState').title = saved.error;
}
/** render: 'all' re-draws every list; 'none' keeps the inputs the user is typing in. */
function commit(next, { render = 'all', unlock = false } = {}) {
  snapshot = next;
  if (unlock) {
    storageLocked = false; externalConflict = false; $('storageConflict').hidden = true;
    try { snapshotStore.adoptRaw(storage?.getItem(TIME_STORAGE_KEY) ?? null); } catch { snapshotStore.invalidate(); }
  }
  calendarResult = null;
  strategyUndo = null;
  save();
  if (render === 'all') renderAll(); else { renderBadges(); renderItemStates(); }
  scheduleCalendar();
}
function showOnPage(element, block = 'start') {
  const roll = element.closest('[data-roll]');
  if (roll) openRoll(roll.dataset.roll);
  const page = element.closest('[data-page]')?.dataset.page;
  if (page) window.SixuRouter?.go(page);
  element.scrollIntoView({ behavior: scrollBehavior(), block });
  element.classList.remove('is-flash');
  void element.offsetWidth;
  element.classList.add('is-flash');
}

// ---- Service -------------------------------------------------------------
function normalizeApiBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含账号、查询参数或片段的HTTP/HTTPS服务地址。');
  return url.href.replace(/\/$/, '');
}
async function request(path, body, base, timeoutMs = 30000, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = body === undefined ? { ...extraHeaders } : { 'Content-Type': 'application/json', ...extraHeaders };
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`服务没有返回可读取的数据（HTTP ${response.status}），请检查服务地址。`); }
    if (!response.ok) throw Object.assign(new Error(data.error || `服务返回HTTP ${response.status}`), { code: data.code });
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请稍后重试；当前清单仍保留。');
    throw error;
  } finally { window.clearTimeout(timeout); }
}
// Model calls from the public site need the access code the author set on the server. It is asked
// for once, kept in this browser, and sent only with model calls; a wrong one is asked again.
const ACCESS_KEY = 'sixu.model-access';
function savedAccessCode() { try { return storage?.getItem(ACCESS_KEY) || ''; } catch { return ''; } }
function askAccessCode(wrong) {
  return new Promise(resolve => {
    const box = $('accessAsk');
    $('accessHint').textContent = wrong ? '口令不对，请重新输入。' : '线上使用模型功能需要访问口令，可以向作者索取。口令只保存在这个浏览器里。';
    $('accessCode').value = '';
    box.hidden = false;
    $('accessCode').focus();
    const finish = value => {
      box.hidden = true;
      $('accessForm').removeEventListener('submit', submit);
      $('accessCancel').removeEventListener('click', cancel);
      resolve(value);
    };
    const submit = event => { event.preventDefault(); finish($('accessCode').value.trim()); };
    const cancel = () => finish('');
    $('accessForm').addEventListener('submit', submit);
    $('accessCancel').addEventListener('click', cancel);
  });
}
async function modelRequest(path, body, base, timeoutMs) {
  let code = savedAccessCode();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request(path, body, base, timeoutMs, code ? { 'X-Sixu-Access': code } : {});
    } catch (error) {
      if (!['access_code_required', 'access_code_invalid'].includes(error.code)) throw error;
      if (error.code === 'access_code_invalid') { try { storage?.removeItem(ACCESS_KEY); } catch { /* nothing kept */ } }
      code = await askAccessCode(error.code === 'access_code_invalid');
      if (!code) throw new Error('没有输入访问口令，模型功能未调用；可以先用规则提取。');
      try { storage?.setItem(ACCESS_KEY, code); } catch { /* kept for this call only */ }
    }
  }
  throw new Error('访问口令不对，模型功能未调用。');
}
async function ensureHealth(base, { fresh = false } = {}) {
  if (!fresh && healthBase === base) return health;
  const result = await request('/api/health', undefined, base);
  if (!Array.isArray(result.capabilities) || !result.capabilities.includes('time_layers_v3')) throw new Error('计算服务还不是四层时间版本（需要后端1.12或更新），请重启本地服务后再试。');
  if (base === apiBase) { healthBase = base; health = result; }
  $('connectionStatus').textContent = `已连接计算服务 ${result.version}`;
  return result;
}

// ---- Calendar -----------------------------------------------------------
const shownWeek = () => calendarWeek ?? weekStart(Date.parse(snapshot.reference_time));
function scheduleCalendar() {
  window.clearTimeout(calendarTimer);
  calendarTimer = window.setTimeout(computeCalendar, 250);
}
async function computeCalendar() {
  window.clearTimeout(calendarTimer);
  const ticket = ++calendarSequence;
  const revision = snapshot.revision;
  const base = apiBase;
  calendarLoading = true;
  renderCalendar();
  try {
    await ensureHealth(base);
    const result = await request('/api/v3/calendar', { snapshot, range: weekRange(shownWeek()) }, base);
    if (ticket !== calendarSequence || revision !== snapshot.revision || base !== apiBase) return;
    calendarResult = result;
    calendarError = '';
  } catch (error) {
    if (ticket !== calendarSequence) return;
    calendarResult = null;
    calendarError = `日历暂时算不出来：${error.message}`;
  } finally {
    if (ticket === calendarSequence) { calendarLoading = false; renderCalendar(); renderItemStates(); renderBadges(); }
  }
}
function renderCalendar() {
  $('calendarView').innerHTML = calendarMarkup({ result: calendarResult, start: shownWeek(), now: Date.now(), loading: calendarLoading && !calendarResult, error: calendarError, undo: strategyUndo?.label || '' });
  fitCalendar();
}
/** Size the hour rows so the whole week fits the window below the week header (wide screens only). */
function fitCalendar() {
  const week = $('calendarView').querySelector('.cal-week');
  if (!week || document.documentElement.dataset.current !== 'calendar' || window.innerWidth < 760) return;
  const rows = Number(week.style.getPropertyValue('--rows')) || 14;
  const head = week.querySelector('.cal-head-day')?.getBoundingClientRect().height || 0;
  const top = week.getBoundingClientRect().top + window.scrollY;
  const mount = week.closest('.scroll-mount');
  const below = mount ? parseFloat(window.getComputedStyle(mount).borderBottomWidth) || 0 : 0;
  const row = Math.max(20, Math.min(46, Math.floor((window.innerHeight - top - head - below - 44) / rows)));
  week.style.setProperty('--row', `${row}px`);
  $('calendarView').style.setProperty('--cal-fit-height', `${Math.max(240, row * rows + head)}px`);
  const side = $('calendarView').querySelector('.scroll-side');
  if (side) side.style.maxHeight = `${Math.ceil((mount || week).getBoundingClientRect().height) + 2}px`;
}
window.addEventListener('resize', fitCalendar);

// ---- Rendering ----------------------------------------------------------
function renderSources() {
  $('sourceCount').textContent = `${snapshot.sources.length} 份`;
  $('sourceList').innerHTML = snapshot.sources.length ? snapshot.sources.map((source, index) => `<details data-source-id="${escapeHTML(source.id)}"><summary>${index + 1}. ${escapeHTML(source.text.split('\n')[0].slice(0, 40))}${source.kind === 'synthetic' ? '（虚构示例）' : source.kind === 'timetable' ? '（课表）' : ''}</summary><pre>${escapeHTML(source.text)}</pre></details>`).join('') : '<p class="empty-note">导入后可随时回来核对。</p>';
}
function undefinedCount() {
  const tasks = snapshot.tasks.filter(task => task.status === 'active' && (task.deadline_at === null || task.estimate_minutes === null)).length;
  const events = snapshot.events.filter(event => event.status === 'active' && (!event.start_at || !event.end_at)).length;
  return tasks + events;
}
function renderBadges() {
  renderRollFaces();
  const count = undefinedCount();
  $('itemsCount').textContent = count ? String(count) : '';
  $('conflictCount').textContent = calendarResult?.conflicts.length ? String(calendarResult.conflicts.length) : '';
}
function evidenceMarkup(item) {
  const quotes = item.evidence.filter(entry => entry.origin === 'source_text' && entry.quote).map(entry => `<blockquote>${escapeHTML(entry.quote)}</blockquote>`);
  const edits = item.evidence.some(entry => entry.origin === 'user_input') ? '<p class="evidence-label">部分字段已由你修改。</p>' : '';
  const notes = item.notes.length ? `<ul>${item.notes.map(note => `<li>${escapeHTML(note)}</li>`).join('')}</ul>` : '';
  const extra = [item.location ? `地点：${escapeHTML(item.location)}` : '', item.materials?.length ? `材料：${escapeHTML(item.materials.join('、'))}` : ''].filter(Boolean).map(text => `<p class="evidence-label">${text}</p>`).join('');
  if (!quotes.length && !edits && !notes && !extra) return '';
  return `<details class="item-more evidence"><summary>原文依据与提醒</summary>${extra}${quotes.join('')}${edits}${notes}</details>`;
}
function taskState(task) {
  if (task.status !== 'active') return TASK_STATE[task.status];
  const computed = calendarResult?.tasks.find(entry => entry.id === task.id)?.state;
  if (computed) return TASK_STATE[computed] || ['', ''];
  if (task.deadline_at === null) return TASK_STATE.deadline_undefined;
  if (task.estimate_minutes === null) return TASK_STATE.estimate_undefined;
  return ['等待日历计算', ''];
}
function eventState(event) {
  if (event.status === 'cancelled') return ['不参加了', 'done'];
  if (!event.start_at) return ['待书：时间待定', 'undefined'];
  if (!event.end_at) return ['待书：结束未填', 'undefined'];
  if (calendarResult?.conflicts.some(conflict => conflict.items.some(item => item.id === event.id))) return ['叠墨：与他事相撞', 'conflict'];
  return [event.kind === 'appointment' ? '已落笔' : '已点上', 'ok'];
}
const stateBadge = ([text, kind]) => `<span class="item-state${kind ? ` is-${kind}` : ''}" data-item-state>${escapeHTML(text)}</span>`;
function taskMarkup(task) {
  const active = task.status === 'active';
  const chips = ESTIMATE_PRESETS.map(preset => `<button type="button" class="chip" data-estimate="${preset.minutes}" aria-pressed="${task.estimate_minutes === preset.minutes}">${preset.label}</button>`).join('');
  return `<article class="item-card${active ? '' : ' is-inactive'}" data-item-id="${escapeHTML(task.id)}" data-kind="task" id="item-${escapeHTML(task.id)}">
    <div class="item-top"><input class="item-title" data-field="title" value="${escapeHTML(task.title)}" aria-label="工作名称" maxlength="200">${stateBadge(taskState(task))}</div>
    <div class="field-grid">
      <label>截止<input type="datetime-local" data-field="deadline_at" value="${toLocalInput(task.deadline_at)}"></label>
      <label>预计用时（分钟）<input type="number" inputmode="numeric" min="1" max="20160" data-field="estimate_minutes" value="${task.estimate_minutes ?? ''}" placeholder="未填"></label>
      <div class="field-wide chips" role="group" aria-label="预计用时快捷选择">${chips}</div>
      <label>能否拆开做<select data-field="splittable"><option value="true"${task.splittable ? ' selected' : ''}>可以分几次做</option><option value="false"${task.splittable ? '' : ' selected'}>需要一次做完</option></select></label>
      <label>优先级 <span class="optional">可选，0–100</span><input type="number" inputmode="numeric" min="0" max="100" data-field="priority" value="${task.priority ?? ''}" placeholder="未填按50"></label>
    </div>
    ${evidenceMarkup(task)}
    <div class="item-actions"><button type="button" data-action="complete">${task.status === 'completed' ? '恢复' : '完成了'}</button><button type="button" data-action="cancel">${task.status === 'cancelled' ? '恢复' : '不做了'}</button><button type="button" class="danger-text" data-action="delete">删除</button></div>
    <p class="field-error" data-item-error role="status"></p>
  </article>`;
}
function eventMarkup(event) {
  const appointment = event.kind === 'appointment';
  return `<article class="item-card${event.status === 'active' ? '' : ' is-inactive'}" data-item-id="${escapeHTML(event.id)}" data-kind="event" id="item-${escapeHTML(event.id)}">
    <div class="item-top"><input class="item-title" data-field="title" value="${escapeHTML(event.title)}" aria-label="${appointment ? '约定' : '点墨'}名称" maxlength="200">${stateBadge(eventState(event))}</div>
    <div class="field-grid">
      <label class="field-wide">这件事是<select data-field="kind"><option value="temporary"${appointment ? '' : ' selected'}>点墨：外部安排的一次性事项（讲座、考试等）</option><option value="appointment"${appointment ? ' selected' : ''}>约定：自己约好的事，属于落笔（如和朋友出去）</option></select></label>
      <label>开始<input type="datetime-local" data-field="start_at" value="${toLocalInput(event.start_at)}"></label>
      <label>结束<input type="datetime-local" data-field="end_at" value="${toLocalInput(event.end_at)}"></label>
      <label class="field-wide">地点 <span class="optional">可选</span><input data-field="location" value="${escapeHTML(event.location ?? '')}" maxlength="500"></label>
    </div>
    ${evidenceMarkup(event)}
    <div class="item-actions"><button type="button" data-action="cancel">${event.status === 'cancelled' ? '恢复' : '不参加了'}</button><button type="button" class="danger-text" data-action="delete">删除</button></div>
    <p class="field-error" data-item-error role="status"></p>
  </article>`;
}
function renderItems() {
  const points = snapshot.events.filter(event => event.kind !== 'appointment');
  const appointments = snapshot.events.filter(event => event.kind === 'appointment');
  $('eventList').innerHTML = points.length ? points.map(eventMarkup).join('') : '<p class="empty-note">还没有点墨。导入通知或手动添加。</p>';
  $('appointmentList').innerHTML = appointments.length ? appointments.map(eventMarkup).join('') : '<p class="empty-note">还没有约定。和别人约好的事可以加在这里。</p>';
  $('taskList').innerHTML = snapshot.tasks.length ? snapshot.tasks.map(taskMarkup).join('') : '<p class="empty-note">还没有截止之事。导入通知或手动添加。</p>';
}
function renderItemStates() {
  for (const card of document.querySelectorAll('[data-item-id]')) {
    const id = card.dataset.itemId;
    const item = card.dataset.kind === 'task' ? snapshot.tasks.find(entry => entry.id === id) : snapshot.events.find(entry => entry.id === id);
    if (!item) continue;
    card.querySelector('[data-item-state]').outerHTML = stateBadge(card.dataset.kind === 'task' ? taskState(item) : eventState(item));
    for (const chip of card.querySelectorAll('[data-estimate]')) chip.setAttribute('aria-pressed', String(item.estimate_minutes === Number(chip.dataset.estimate)));
  }
}
function renderDayGrid() {
  const windows = snapshot.daily_window || DEFAULT_WINDOW;
  $('dayGrid').innerHTML = WEEKDAY_NAMES.map((name, index) => {
    const window = windows[index];
    const on = snapshot.daily_window ? Boolean(window) : true;
    const value = window || DEFAULT_WINDOW[index];
    return `<div class="day-row"><label class="check-row"><input type="checkbox" data-day-on="${index}"${on ? ' checked' : ''}>${name}</label><label class="sr-only" for="day-start-${index}">${name}开始</label><input type="time" id="day-start-${index}" data-day-start="${index}" value="${value.start}"><span aria-hidden="true">至</span><label class="sr-only" for="day-end-${index}">${name}结束</label><input type="time" id="day-end-${index}" data-day-end="${index}" value="${value.end === '24:00' ? '23:59' : value.end}"></div>`;
  }).join('') + `<p class="field-help" id="windowState">${snapshot.daily_window ? '已保存。改动后再点保存。' : '还没有保存，留白暂为“待书”。下面是常用作息，确认后点保存。'}</p>`;
}
const weekdayText = days => days.map(day => WEEKDAY_NAMES[day - 1].slice(1)).join('、');
const dateText = value => { const [, month, day] = value.split('-').map(Number); return `${month}月${day}日`; };
function renderRoutines() {
  $('routineList').innerHTML = snapshot.routines.length ? `<ul class="plain-list">${snapshot.routines.map(routine => `<li id="routine-${escapeHTML(routine.id)}"><div><strong>${escapeHTML(routine.title)}</strong><span>每周${weekdayText(routine.weekdays)} ${routine.start}–${routine.end}${routine.week_interval === 2 ? '（隔周）' : ''} · ${dateText(routine.from)}起${routine.until ? `至${dateText(routine.until)}` : ''}${routine.location ? ` · ${escapeHTML(routine.location)}` : ''}</span></div><button type="button" class="danger-text" data-remove="${escapeHTML(routine.id)}">删除</button></li>`).join('')}</ul>` : '<p class="empty-note">还没有底色。底色可以不铺，叠墨照样能查；铺上课表后，留白和落笔会更准。</p>';
  $('routineWeekdays').innerHTML = WEEKDAY_NAMES.map((name, index) => `<label class="check-row"><input type="checkbox" value="${index + 1}">${name}</label>`).join('');
}
function renderAdjustments() {
  $('adjustmentList').innerHTML = snapshot.free_adjustments.length ? `<ul class="plain-list">${snapshot.free_adjustments.map(item => `<li><div><strong>${item.kind === 'add' ? '增加' : '扣除'}${item.note ? ` · ${escapeHTML(item.note)}` : ''}</strong><span>${readable(item.start_at)} 至 ${readable(item.end_at)}</span></div><button type="button" class="danger-text" data-remove="${escapeHTML(item.id)}">删除</button></li>`).join('')}</ul>` : '<p class="empty-note">没有调整。</p>';
}
function renderTime() {
  renderDayGrid();
  renderRoutines();
  renderAdjustments();
  $('referenceTime').value = toLocalInput(snapshot.reference_time);
}
function renderAll() { renderSources(); renderItems(); renderTime(); renderCalendar(); renderBadges(); }

// ---- Import -------------------------------------------------------------
let parseTimer = null;
function showParseProgress(mode) {
  const started = Date.now();
  $('parseProgress').hidden = false;
  $('inkwell').classList.add('is-grinding');
  $('parseStep').textContent = mode === 'model' ? '正在连接服务，随后由模型阅读原文' : '正在按规则读取原文';
  $('parseHint').textContent = mode === 'model' ? '模型提取通常需要几秒到一分钟。' : '';
  $('parseElapsed').textContent = '';
  window.clearInterval(parseTimer);
  parseTimer = window.setInterval(() => { $('parseElapsed').textContent = `已用 ${Math.round((Date.now() - started) / 1000)} 秒。`; }, 1000);
}
function hideParseProgress() { window.clearInterval(parseTimer); parseTimer = null; $('parseProgress').hidden = true; $('inkwell').classList.remove('is-grinding'); }
function importSummary(imported) {
  const pending = imported.tasks.filter(task => task.estimate_minutes === null && task.deadline_at !== null).length;
  const noDeadline = imported.tasks.filter(task => task.deadline_at === null).length;
  const openEvents = imported.events.filter(event => !event.start_at || !event.end_at).length;
  const parts = [];
  if (imported.events.length) parts.push(`${imported.events.length} 处点墨`);
  if (imported.tasks.length) parts.push(`${imported.tasks.length} 件截止之事`);
  const missing = [pending && `${pending} 件的预计用时`, noDeadline && `${noDeadline} 件的截止`, openEvents && `${openEvents} 处点墨的时间`].filter(Boolean);
  const warnings = (imported.warnings || []).map(note => `<li>${escapeHTML(note)}</li>`).join('');
  return `<p><strong>已加入 ${parts.join('、') || '0 项'}。</strong>${missing.length ? `${missing.join('、')}还是待书，可以随时补；没补之前它们不会挡住其他事项。` : '时间信息都已写清楚。'}</p>
    ${warnings ? `<ul>${warnings}</ul>` : ''}<p class="inline-links"><a href="#/items">去笔墨补充</a><a href="#/calendar">看画卷</a></p>`;
}
$('noticeForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (externalConflict) return tell('请先处理另一个标签页的清单变化。', 'warning');
  const text = $('noticeText').value.trim();
  const referenceDate = $('noticeDate').value || null;
  const mode = $('extractionMode').value;
  if (!text) return tell('请先粘贴通知原文。', 'warning');
  if (mode === 'model' && [...text].length > 20000) return tell('模型提取每次最多两万字，请拆分通知后重试；原文尚未发送。', 'warning');
  if (snapshot.sources.some(source => source.text === text)) return tell('这份通知已经导入过了，可以在“笔墨”页直接修改。', 'warning');
  const ticket = ++parseSequence;
  const base = apiBase;
  busy($('parseNotice'), true, '导入', '正在导入…');
  showParseProgress(mode);
  $('importSummary').hidden = true;
  tell('');
  try {
    const result = await ensureHealth(base, { fresh: mode === 'model' });
    if (mode === 'model' && !result.model_extraction?.configured) throw new Error('当前服务没有启用模型提取。请用本地模型服务启动后端，或改用规则提取。');
    $('parseStep').textContent = mode === 'model' ? '模型正在阅读原文，找出事项、时间和地点' : '正在整理事项与时间';
    const imported = await (mode === 'model' ? modelRequest : request)('/api/v3/extract', { text, reference_date: referenceDate, mode }, base, mode === 'model' ? 100000 : 30000);
    if (ticket !== parseSequence || base !== apiBase) return;
    if (text.startsWith('【虚构示例】')) imported.source.kind = 'synthetic';
    commit(addImported(snapshot, imported));
    $('importSummary').innerHTML = importSummary(imported) + endAskMarkup(imported);
    $('importSummary').hidden = false;
    $('noticeText').value = '';
    estimateEnds('rules', imported.source.text);
  } catch (error) {
    if (ticket === parseSequence) tell(`导入未完成：${error.message} 原文仍在输入框里。`, 'error');
  } finally {
    if (ticket === parseSequence) { busy($('parseNotice'), false, '导入'); hideParseProgress(); }
  }
});
// ---- 大约几点结束？ Many notices give only a start. Right after import each such 点墨 gets a
// suggested end (rules by kind of event, or DeepSeek reading the notice on request); the user
// adjusts it and saves, or leaves it 待书.
const beijingDay = iso => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);
const beijingClock = iso => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(11, 16);
let endSource = '';
function endAskMarkup(imported) {
  const open = imported.events.filter(event => event.start_at && !event.end_at);
  if (!open.length) return '';
  const rows = open.map(event => `<li class="end-row" data-end-for="${escapeHTML(event.id)}" data-start="${escapeHTML(event.start_at)}"><div><strong>${escapeHTML(event.title)}</strong><span>${beijingDay(event.start_at).slice(5).replace('-', '月')}日 ${beijingClock(event.start_at)} 开始</span></div><label>大约<input type="time" data-end-input aria-label="${escapeHTML(event.title)}大约几点结束">结束</label><button type="button" data-end-save>就这样</button><em class="end-reason" data-end-reason>正在估计…</em></li>`).join('');
  return `<section class="end-ask" aria-labelledby="endAskHeading"><h3 id="endAskHeading">这些点墨只写了开始，大约几点结束？</h3><p>先按活动类型估了一个时间，改一改再保存；不填也行，它会先作为待书。</p><ul>${rows}</ul><div class="inline-actions"><button type="button" class="primary-button" data-end-save-all>全部按此保存</button><button type="button" data-end-model hidden>结合原文问问模型</button></div></section>`;
}
async function estimateEnds(mode, sourceText) {
  const rows = [...$('importSummary').querySelectorAll('.end-row:not(.is-saved)')];
  if (!rows.length) return;
  endSource = sourceText ?? endSource;
  const base = apiBase;
  const button = $('importSummary').querySelector('[data-end-model]');
  try {
    const result = await ensureHealth(base);
    if (button) button.hidden = !result.timetable_model?.configured;
    if (!result.capabilities.includes('end_estimate_v1')) throw new Error('计算服务还不支持估计结束时间，请重启到1.19或更新。');
    if (mode === 'model' && button) busy(button, true, '结合原文问问模型', '模型正在读原文…');
    const items = rows.map(row => ({ id: row.dataset.endFor, title: snapshot.events.find(event => event.id === row.dataset.endFor)?.title || '活动', start_at: row.dataset.start, context: endSource.slice(0, 4000) }));
    const { estimates } = await (mode === 'model' ? modelRequest : request)('/api/v3/estimate-end', { mode, items }, base, mode === 'model' ? 60000 : 15000);
    for (const estimate of estimates) {
      const row = rows.find(item => item.dataset.endFor === estimate.id);
      if (!row) continue;
      row.querySelector('[data-end-input]').value = beijingClock(estimate.end_at);
      row.querySelector('[data-end-reason]').textContent = `${estimate.basis === 'model' ? '模型：' : ''}${estimate.reason}`;
    }
  } catch (error) {
    for (const row of rows) if (row.querySelector('[data-end-reason]').textContent === '正在估计…') row.querySelector('[data-end-reason]').textContent = '填一下大约几点结束。';
    if (mode === 'model') tell(`模型没能估计：${error.message}`, 'error');
  } finally {
    if (mode === 'model' && button) busy(button, false, '结合原文问问模型');
  }
}
function saveEnd(row) {
  const value = row.querySelector('[data-end-input]').value;
  if (!/^\d{2}:\d{2}$/.test(value)) { row.querySelector('[data-end-reason]').textContent = '请先填一个结束时刻。'; return false; }
  const start = row.dataset.start;
  let end = Date.parse(`${beijingDay(start)}T${value}:00+08:00`);
  if (end <= Date.parse(start)) end += 86400000;
  const endAt = new Date(end + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';
  try { commit(updateEvent(snapshot, row.dataset.endFor, { end_at: endAt })); } catch (error) { row.querySelector('[data-end-reason]').textContent = error.message; return false; }
  row.classList.add('is-saved');
  row.querySelector('[data-end-reason]').textContent = `已补上：${beijingClock(endAt)} 结束${end - Date.parse(start) >= 86400000 ? '（次日）' : ''}`;
  return true;
}
$('importSummary').addEventListener('click', event => {
  const one = event.target.closest('[data-end-save]');
  if (one) { saveEnd(one.closest('.end-row')); return; }
  if (event.target.closest('[data-end-save-all]')) {
    const rows = [...$('importSummary').querySelectorAll('.end-row:not(.is-saved)')];
    const saved = rows.filter(saveEnd).length;
    if (saved) tell(`已补上 ${saved} 处点墨的结束时间。`);
    return;
  }
  if (event.target.closest('[data-end-model]')) estimateEnds('model');
});
for (const id of ['noticeText', 'noticeDate', 'extractionMode']) $(id).addEventListener('input', () => { parseSequence += 1; busy($('parseNotice'), false, '导入'); hideParseProgress(); });

const recognizeScreenshot = createRecognizer(...(window.SIXU_OCR_ENGINE ? [async () => window.SIXU_OCR_ENGINE] : []));
let ocrSequence = 0;
let ocrPreviewUrl = null;
// Local OCR reads lines, not grids. A timetable screenshot belongs to timetable reading,
// so the last recognised image can be handed over there.
let ocrHandoff = null;
const TIMETABLE_LIKE = /[一二三四五六日]{4,}|第\s*0*\d+\s*周|星期[一二三四五六日天]|第\s*\d+\s*[-—~至]\s*\d+\s*节/;
const ocrAsTimetable = Object.assign(document.createElement('button'), { type: 'button', id: 'ocrAsTimetable', hidden: true, textContent: '这是课表？改用课表截图识别' });
$('ocrStatus').after(ocrAsTimetable);
function ocrStatus(message) { $('ocrStatus').textContent = message; }
async function recognizeNotice(file) {
  const problem = imageProblem(file);
  if (problem) return ocrStatus(problem);
  const ticket = ++ocrSequence;
  ocrHandoff = null;
  ocrAsTimetable.hidden = true;
  if (ocrPreviewUrl) window.URL.revokeObjectURL(ocrPreviewUrl);
  ocrPreviewUrl = window.URL.createObjectURL(file);
  $('ocrPreviewImage').src = ocrPreviewUrl;
  $('ocrPreview').hidden = false;
  $('chooseNoticeImage').disabled = true;
  ocrStatus('正在本机识别截图…');
  try {
    const text = await recognizeScreenshot(file, progress => { if (ticket === ocrSequence) ocrStatus(`正在本机识别截图… ${Math.round(progress * 100)}%`); });
    if (ticket !== ocrSequence) return;
    if (!text) return ocrStatus('没有识别出文字。请换一张更清晰、只含通知部分的截图，或手动输入；输入框内容没有改动。');
    const box = $('noticeText');
    ocrHandoff = { file, textBefore: box.value };
    box.value = box.value.trim() ? `${box.value.trimEnd()}\n\n${text}` : text;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
    ocrAsTimetable.hidden = false;
    ocrStatus(TIMETABLE_LIKE.test(text)
      ? '这张图像是一张课表。本机识别只能读一行行的通知文字，课表格子会被读乱；请点下面的按钮改用课表截图识别。'
      : '已把识别出的文字放进输入框。请对照截图逐字核对时间、地点和数字，修改后再导入。');
  } catch (error) {
    if (ticket === ocrSequence) ocrStatus(`未能识别这张截图（${error.message}）。输入框内容没有改动，可以重试或手动输入。`);
  } finally {
    if (ticket === ocrSequence) $('chooseNoticeImage').disabled = false;
  }
}
$('chooseNoticeImage').addEventListener('click', () => $('noticeImage').click());
ocrAsTimetable.addEventListener('click', () => {
  if (!ocrHandoff) return;
  const { file, textBefore } = ocrHandoff;
  ocrHandoff = null;
  ocrAsTimetable.hidden = true;
  $('noticeText').value = textBefore;
  $('noticeText').dispatchEvent(new window.Event('input', { bubbles: true }));
  ocrStatus('已把这张图交给课表截图识别，结果在“铺纸”页的“从课表铺底色”里。');
  window.SixuRouter?.go('time');
  openRoll('routine');
  $('timetableSection').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  runTimetable('image', file);
});
$('noticeImage').addEventListener('change', event => {
  const [file] = event.target.files || [];
  if (file) recognizeNotice(file);
  event.target.value = '';
});
$('noticeText').addEventListener('paste', event => {
  const item = Array.from(event.clipboardData?.items || []).find(entry => entry.kind === 'file' && entry.type.startsWith('image/'));
  if (!item) return;
  event.preventDefault();
  recognizeNotice(item.getAsFile());
});

// ---- Items --------------------------------------------------------------
function itemError(card, message) { card.querySelector('[data-item-error]').textContent = message; }
function fieldValue(input) {
  const field = input.dataset.field;
  const raw = input.value.trim();
  if (['deadline_at', 'start_at', 'end_at'].includes(field)) {
    if (!raw) return null;
    const value = fromLocalInput(raw);
    if (!value) throw new Error('请填写完整的日期和时刻');
    return value;
  }
  if (['estimate_minutes', 'priority'].includes(field)) {
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) throw new Error('请填写整数');
    return Number(raw);
  }
  if (field === 'splittable') return raw === 'true';
  if (field === 'location') return raw || null;
  if (field === 'kind') return raw;
  return raw;
}
function editItem(card, patch) {
  const id = card.dataset.itemId;
  return card.dataset.kind === 'task' ? updateTask(snapshot, id, patch) : updateEvent(snapshot, id, patch);
}
function onItemChange(event) {
  const input = event.target.closest('[data-field]');
  const card = event.target.closest('[data-item-id]');
  if (!input || !card) return;
  try {
    const next = editItem(card, { [input.dataset.field]: fieldValue(input) });
    input.setAttribute('aria-invalid', 'false');
    itemError(card, '');
    // Changing 点墨/约定 moves the card to the other list.
    commit(next, { render: input.dataset.field === 'kind' ? 'all' : 'none' });
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    itemError(card, `没有保存：${error.message}。`);
  }
}
function onItemClick(event) {
  const card = event.target.closest('[data-item-id]');
  if (!card) return;
  const id = card.dataset.itemId;
  const isTask = card.dataset.kind === 'task';
  const item = isTask ? snapshot.tasks.find(entry => entry.id === id) : snapshot.events.find(entry => entry.id === id);
  try {
    const chip = event.target.closest('[data-estimate]');
    if (chip) {
      const minutes = Number(chip.dataset.estimate);
      card.querySelector('[data-field="estimate_minutes"]').value = String(minutes);
      commit(updateTask(snapshot, id, { estimate_minutes: minutes }), { render: 'none' });
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'delete') {
      if (!window.confirm(`删除「${item.title}」？`)) return;
      commit(removeItem(snapshot, id));
    } else if (action === 'complete') {
      commit(updateTask(snapshot, id, { status: item.status === 'completed' ? 'active' : 'completed' }));
    } else if (action === 'cancel') {
      const status = item.status === 'cancelled' ? 'active' : 'cancelled';
      commit(isTask ? updateTask(snapshot, id, { status }) : updateEvent(snapshot, id, { status }));
    }
  } catch (error) { itemError(card, error.message); }
}
for (const list of ['eventList', 'appointmentList', 'taskList']) {
  $(list).addEventListener('change', onItemChange);
  $(list).addEventListener('click', onItemClick);
}
$('addTask').addEventListener('click', () => {
  commit(addTask(snapshot, { title: '新的截止之事' }));
  const title = $('taskList').lastElementChild.querySelector('[data-field="title"]');
  title.focus(); title.select();
});
$('addEvent').addEventListener('click', () => {
  commit(addEvent(snapshot, { title: '新的点墨' }));
  const title = $('eventList').lastElementChild.querySelector('[data-field="title"]');
  title.focus(); title.select();
});
$('addAppointment').addEventListener('click', () => {
  commit(addEvent(snapshot, { title: '新的约定', kind: 'appointment' }));
  const title = $('appointmentList').lastElementChild.querySelector('[data-field="title"]');
  title.focus(); title.select();
});

// ---- Time ---------------------------------------------------------------
function readDayGrid() {
  return WEEKDAY_NAMES.map((_, index) => {
    if (!document.querySelector(`[data-day-on="${index}"]`).checked) return null;
    return { start: document.querySelector(`[data-day-start="${index}"]`).value, end: document.querySelector(`[data-day-end="${index}"]`).value };
  });
}
$('windowForm').addEventListener('submit', event => {
  event.preventDefault();
  try { commit(setDailyWindow(snapshot, readDayGrid())); $('windowError').textContent = ''; tell('作息范围已保存，留白会按它推算。'); }
  catch (error) { $('windowError').textContent = error.message; }
});
$('presetWindow').addEventListener('click', () => {
  commit(setDailyWindow(snapshot, DEFAULT_WINDOW));
  tell('已填入常用作息：工作日 8:00–23:00，周末 9:00–23:00，可以按自己的情况修改后再保存。');
});
$('clearWindow').addEventListener('click', () => { commit(setDailyWindow(snapshot, null)); });
$('referenceTime').addEventListener('change', event => {
  const value = fromLocalInput(event.target.value);
  if (!value) return tell('请填写完整的开始安排时刻。', 'warning');
  calendarWeek = null;
  commit(setReferenceTime(snapshot, value), { render: 'none' });
  renderCalendar();
});
$('useCurrentTime').addEventListener('click', () => { calendarWeek = null; commit(setReferenceTime(snapshot, currentMinuteISO())); });
$('addRoutine').addEventListener('click', () => {
  $('routineForm').hidden = false;
  $('routineFrom').value = localDate(Date.parse(snapshot.reference_time));
  $('routineError').textContent = '';
  $('routineTitle').focus();
});
$('cancelRoutine').addEventListener('click', () => { $('routineForm').hidden = true; });
$('routineForm').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const weekdays = Array.from($('routineWeekdays').querySelectorAll('input:checked'), input => Number(input.value));
    commit(addRoutine(snapshot, { title: $('routineTitle').value, weekdays, start: $('routineStart').value, end: $('routineEnd').value,
      from: $('routineFrom').value, until: $('routineUntil').value || null, week_interval: Number($('routineInterval').value), location: $('routineLocation').value.trim() || null }));
    $('routineForm').reset();
    $('routineForm').hidden = true;
  } catch (error) { $('routineError').textContent = error.message; }
});
$('routineList').addEventListener('click', event => {
  const id = event.target.closest('[data-remove]')?.dataset.remove;
  if (id && window.confirm('删除这条例行占用？')) commit(removeItem(snapshot, id));
});
$('addAdjustment').addEventListener('click', () => { $('adjustmentForm').hidden = false; $('adjustmentError').textContent = ''; $('adjustmentStart').focus(); });
$('cancelAdjustment').addEventListener('click', () => { $('adjustmentForm').hidden = true; });
$('adjustmentForm').addEventListener('submit', event => {
  event.preventDefault();
  try {
    commit(addAdjustment(snapshot, { kind: $('adjustmentKind').value, start_at: fromLocalInput($('adjustmentStart').value), end_at: fromLocalInput($('adjustmentEnd').value), note: $('adjustmentNote').value.trim() || null }));
    $('adjustmentForm').reset();
    $('adjustmentForm').hidden = true;
  } catch (error) { $('adjustmentError').textContent = error.message; }
});
$('adjustmentList').addEventListener('click', event => {
  const id = event.target.closest('[data-remove]')?.dataset.remove;
  if (id) commit(removeItem(snapshot, id));
});

// ---- Timetable ----------------------------------------------------------
function readPeriods() {
  const periods = {};
  for (const line of $('periodText').value.split('\n').map(text => text.trim()).filter(Boolean)) {
    const match = /^(\d{1,2})\s+(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})$/.exec(line);
    if (!match) throw new Error(`节次时间“${line}”看不懂，请写成“1 08:00-08:45”`);
    const pad = value => value.padStart(2, '0');
    periods[String(Number(match[1]))] = { start: `${pad(match[2])}:${match[3]}`, end: `${pad(match[4])}:${match[5]}` };
  }
  return periods;
}
const periodLines = periods => Object.entries(periods).sort((a, b) => Number(a[0]) - Number(b[0])).map(([number, item]) => `${number} ${item.start}-${item.end}`);
function periodDifference(seen) {
  if (!seen) return '';
  let mine = {};
  try { mine = readPeriods(); } catch { /* An unreadable table differs from anything seen. */ }
  const differs = Object.entries(seen).some(([number, item]) => mine[number]?.start !== item.start || mine[number]?.end !== item.end);
  if (!differs) return '<p class="field-help">截图上的节次时间与下面填的一致。</p>';
  return `<div class="period-diff"><h4>截图上的节次时间与下面填的不同</h4><p class="field-help">${escapeHTML(periodLines(seen).join('；'))}</p><button type="button" id="usePeriodsSeen">改用截图上的节次时间并重新换算</button></div>`;
}
function timetablePreview(result) {
  const routines = result.routines.map(routine => `<li><strong>${escapeHTML(routine.title)}</strong><span>每周${weekdayText(routine.weekdays)} ${routine.start}–${routine.end}${routine.week_interval === 2 ? '（隔周）' : ''} · ${dateText(routine.from)}起${routine.until ? `至${dateText(routine.until)}` : ''}${routine.location ? ` · ${escapeHTML(routine.location)}` : ''}</span></li>`).join('');
  const drafts = result.drafts.map(draft => `<li><strong>${escapeHTML(draft.course.title)}</strong><span>${escapeHTML(draft.problem)}</span></li>`).join('');
  // The backend marks dropped courses with 未采用; other notes are the model's remarks about courses it did keep.
  const list = notes => notes.map(note => `<li>${escapeHTML(note)}</li>`).join('');
  const rejected = list(result.warnings.filter(note => note.includes('未采用')));
  const remarks = list(result.warnings.filter(note => !note.includes('未采用')));
  return `<div class="timetable-result">
    <h3>整理出 ${result.routines.length} 处底色${result.drafts.length ? `，${result.drafts.length} 门课还缺信息` : ''}</h3>
    <p class="field-help">课表是整学期的数据，请逐条对照原课表核对后再导入。</p>
    ${periodDifference(result.periods_seen)}
    ${routines ? `<ul class="plain-list">${routines}</ul>` : ''}
    ${drafts ? `<h4>还缺信息</h4><ul class="plain-list is-draft">${drafts}</ul>` : ''}
    ${rejected ? `<h4>没有采用的部分</h4><ul>${rejected}</ul>` : ''}
    ${remarks ? `<h4>整理时的提醒</h4><ul>${remarks}</ul>` : ''}
    ${result.routines.length ? `<button type="button" class="primary-button" id="adoptTimetable">核对无误，铺上这 ${result.routines.length} 处底色</button>` : ''}
  </div>`;
}
/** Shrink a screenshot to at most 2000px on its long side as JPEG; without canvas support, send it as it is. */
async function imageToDataUrl(file) {
  const read = blob => new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(blob); });
  try {
    const bitmap = await window.createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch { return read(file); }
}
const TIMETABLE_BUTTONS = { model: ['recognizeTimetable', '整理课表', '正在整理…'], image: ['chooseTimetableImage', '从课表截图识别', '正在读截图…'], convert: ['reconvertTimetable', '按新的日期和节次重新换算', '正在换算…'] };
async function runTimetable(mode, file = null) {
  const text = $('timetableText').value.trim();
  if (mode !== 'image' && !text) return tell('请先粘贴课表文字，或上传课表截图。', 'warning');
  let periods;
  try { periods = readPeriods(); } catch (error) { return tell(error.message, 'warning'); }
  const body = { mode, term_start: $('termStart').value || null, periods };
  if (mode === 'convert') {
    if (!lastTimetable || lastTimetable.text !== text) return tell('课表文字改过了，请重新整理。', 'warning');
    body.courses = lastTimetable.result.courses;
  }
  const ticket = ++timetableSequence;
  const base = apiBase;
  const [buttonId, idle, working] = TIMETABLE_BUTTONS[mode];
  const button = $(buttonId);
  busy(button, true, idle, working);
  try {
    if (mode === 'image') {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('请选择PNG、JPG、WebP或GIF格式的截图。');
      body.image = await imageToDataUrl(file);
    } else body.text = text;
    const result = await ensureHealth(base, { fresh: mode !== 'convert' });
    if (!result.capabilities.includes(mode === 'image' ? 'timetable_image_v3' : 'timetable_v3')) throw new Error(`计算服务还不支持${mode === 'image' ? '课表截图识别（需要后端1.15或更新）' : '课表识别（需要后端1.13或更新）'}。`);
    if (mode !== 'convert' && !result.timetable_model?.configured) throw new Error('本地服务没有配置 DeepSeek Key。重启服务时输入 Key 后再试。');
    const data = await (mode === 'convert' ? request : modelRequest)('/api/v3/timetable', body, base, mode === 'convert' ? 30000 : 100000);
    if (ticket !== timetableSequence) return;
    if (mode === 'image') $('timetableText').value = data.source.text;
    lastTimetable = { text: mode === 'image' ? data.source.text : text, result: data };
    $('timetablePreview').innerHTML = timetablePreview(data);
    $('reconvertTimetable').hidden = !data.courses.length;
  } catch (error) {
    if (ticket === timetableSequence) tell(`课表没有整理完成：${error.message}`, 'error');
  } finally {
    busy(button, false, idle);
  }
}
$('chooseTimetableImage').addEventListener('click', () => $('timetableImage').click());
$('timetableImage').addEventListener('change', event => {
  const [file] = event.target.files || [];
  if (file) runTimetable('image', file);
  event.target.value = '';
});
$('timetableForm').addEventListener('submit', event => { event.preventDefault(); runTimetable('model'); });
$('reconvertTimetable').addEventListener('click', () => runTimetable('convert'));
$('timetablePreview').addEventListener('click', event => {
  if (event.target.closest('#usePeriodsSeen') && lastTimetable?.result.periods_seen) {
    $('periodText').value = periodLines(lastTimetable.result.periods_seen).join('\n');
    runTimetable('convert');
    return;
  }
  if (!event.target.closest('#adoptTimetable') || !lastTimetable) return;
  const { source, routines } = lastTimetable.result;
  commit(addTimetable(snapshot, { source, routines }));
  $('timetablePreview').innerHTML = `<p class="field-help">已铺上 ${routines.length} 处底色。</p>`;
  lastTimetable = null;
  $('reconvertTimetable').hidden = true;
  tell(`已铺上 ${routines.length} 处底色（例行占用），留白会扣除这些时间。`);
});

// ---- Calendar interactions ------------------------------------------------
$('calendarView').addEventListener('click', event => {
  const week = event.target.closest('[data-cal-week]');
  if (week) {
    const step = Number(week.dataset.calWeek);
    calendarWeek = step ? shownWeek() + step * 7 * DAY : null;
    calendarResult = null;
    computeCalendar();
    return;
  }
  const goto = event.target.closest('[data-cal-goto="time"]');
  if (goto) { window.SixuRouter?.go('time'); openRoll(goto.dataset.calRoll || 'free'); return; }
  if (event.target.closest('[data-strategy-undo]')) { undoStrategy(); return; }
  const option = event.target.closest('[data-strategy]');
  if (option) { applyStrategy(option.dataset.strategy); return; }
  const target = event.target.closest('[data-cal-item]');
  if (!target) return;
  const { calItem: id, calLayer: layer } = target.dataset;
  const element = $(layer === 'routine' ? `routine-${id}` : `item-${id}`);
  if (element) showOnPage(element, 'center');
});
/** Apply one rule-based strategy from the calendar result; the previous list is kept for one undo. */
function applyStrategy(key) {
  const [conflictId, index] = key.split(':');
  const strategy = calendarResult?.conflicts.find(conflict => conflict.id === conflictId)?.strategies?.[Number(index)];
  if (!strategy) return;
  const params = strategy.params;
  if (strategy.action === 'review') {
    const element = params.item ? $(`item-${params.item}`) : null;
    if (element) showOnPage(element, 'center'); else { window.SixuRouter?.go(params.page); if (params.page === 'time') openRoll('routine'); }
    return;
  }
  let next;
  try {
    if (strategy.action === 'skip_routine_date') next = skipRoutineDate(snapshot, params.routine_id, params.date);
    else if (strategy.action === 'cancel_event') next = updateEvent(snapshot, params.event_id, { status: 'cancelled' });
    else if (strategy.action === 'move_event') next = updateEvent(snapshot, params.event_id, { start_at: params.start_at, end_at: params.end_at });
    else if (strategy.action === 'update_task') next = updateTask(snapshot, params.task_id, params.patch);
    else if (strategy.action === 'add_free') next = addAdjustment(snapshot, { kind: 'add', start_at: params.start_at, end_at: params.end_at, note: params.note });
    else return;
  } catch (error) { tell(`这条对策没能采用：${error.message}`, 'error'); return; }
  const before = snapshot;
  commit(next);
  strategyUndo = { before, label: strategy.label };
  tell(`已采用：${strategy.label}`);
}
function undoStrategy() {
  if (!strategyUndo) return;
  const { before, label } = strategyUndo;
  strategyUndo = null;
  commit({ ...before, revision: snapshot.revision + 1 });
  tell(`已撤销：${label}`);
}
// Hovering a 叠墨 card lights up the blocks it is about.
for (const [type, lit] of [['mouseover', true], ['mouseout', false], ['focusin', true], ['focusout', false]]) {
  $('calendarView').addEventListener(type, event => {
    const card = event.target.closest('[data-conflict-keys]');
    if (!card || (!lit && card.contains(event.relatedTarget))) return;
    for (const key of card.dataset.conflictKeys.split(' ')) {
      for (const block of $('calendarView').querySelectorAll('[data-cal-key], [data-cal-item]')) {
        if (block.dataset.calKey === key || (!block.dataset.calKey && block.dataset.calItem === key && !block.closest('[data-conflict-keys]'))) block.classList.toggle('is-lit', lit);
      }
    }
  });
}
document.addEventListener('sixu:route', event => {
  if (event.detail !== 'calendar') return;
  (window.requestAnimationFrame || window.setTimeout)(fitCalendar);
  if (!calendarResult && !calendarLoading) computeCalendar();
});
window.setInterval(() => { if (document.documentElement.dataset.current === 'calendar' && !document.hidden) renderCalendar(); }, 60000);

// ---- Service settings, backup -------------------------------------------
$('apiBase').value = apiBase;
$('apiForm').addEventListener('submit', async event => {
  event.preventDefault();
  const ticket = ++connectionSequence;
  try {
    apiBase = normalizeApiBase($('apiBase').value.trim());
    healthBase = null;
    try { storage?.setItem('sixu.api-base', apiBase); } catch { /* Current session can still connect. */ }
    $('connectionStatus').textContent = '正在检查连接…';
    const checked = apiBase;
    await ensureHealth(checked, { fresh: true });
    if (checked !== apiBase || ticket !== connectionSequence) return;
    tell('服务已连接。');
    computeCalendar();
  } catch (error) {
    if (ticket !== connectionSequence) return;
    healthBase = null;
    $('connectionStatus').textContent = error.message; tell(error.message, 'error');
  }
});
$('exportSnapshot').addEventListener('click', () => {
  try {
    const blob = new Blob([serializeTimeSnapshot(snapshot)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `司序-清单-${localDate(Date.now())}.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    tell('已导出清单，文件包含通知原文与个人安排，请妥善保存。');
  } catch (error) { tell(error.message, 'error'); }
});
$('importSnapshot').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 15000000) throw new Error('导入文件超过15MB，请缩小清单。');
    const next = parseTimeSnapshot(await file.text());
    const hasData = snapshot.events.length || snapshot.tasks.length || snapshot.routines.length;
    if (hasData && !window.confirm('导入会替换当前清单。请先导出需要保留的内容，是否继续？')) return;
    calendarWeek = null;
    commit({ ...next, revision: snapshot.revision + 1 }, { unlock: true });
    tell('已载入清单。旧版清单会自动转换成四层时间格式。');
  } catch (error) { tell(`导入未完成：${error.message}`, 'error'); }
  finally { event.target.value = ''; }
});
$('clearSnapshot').addEventListener('click', () => {
  if (!window.confirm('清空此浏览器中的当前清单？请先导出需要保留的内容。')) return;
  calendarWeek = null;
  commit({ ...createTimeSnapshot({ referenceTime: currentMinuteISO() }), revision: snapshot.revision + 1 }, { unlock: true });
  $('noticeText').value = ''; $('noticeDate').value = ''; $('importSummary').hidden = true;
  tell('清单已清空。');
});
$('reloadLatest').addEventListener('click', () => {
  const latest = readTimeSnapshot(storage);
  if (latest.error || !latest.snapshot) return tell('最新清单无法读取，请先导出当前内容，保留备份后重试。', 'error');
  if (!window.confirm('载入另一个标签页保存的清单？当前未保存修改将被替换，请先导出需要保留的内容。')) return;
  snapshot = latest.snapshot;
  snapshotStore.adoptRaw(latest.raw);
  externalConflict = false; storageLocked = false;
  $('storageConflict').hidden = true;
  calendarResult = null;
  renderAll(); scheduleCalendar();
  $('saveState').textContent = '已载入浏览器保存的最新清单';
});
window.addEventListener('storage', event => {
  if (event.key !== TIME_STORAGE_KEY) return;
  try { if (event.newValue === serializeTimeSnapshot(snapshot)) return; } catch { /* Oversized memory state must not overwrite stored data. */ }
  externalConflict = true;
  snapshotStore.invalidate();
  $('storageConflict').hidden = false;
  $('saveState').textContent = '其他标签页已修改，请先处理版本变化';
});

// ---- Examples -------------------------------------------------------------
$('fillExample').addEventListener('click', () => {
  // Written the way notices are ("2026年11月7日15:00"); "2026-11-0715:00" would not be readable.
  const [year, month, date] = localDate(Date.now() + DAY).split('-').map(Number);
  const day = `${year}年${month}月${date}日`;
  $('noticeText').value =`【虚构示例】讲座与课程报告安排\n请于${day}15:00前完成讲座报名。讲座于${day}18:00-20:00举行，地点为主楼405。请于${day}23:59前提交课程报告。`;
  $('noticeDate').value = '';
  tell('已填入虚构通知，点“导入”即可。');
  $('noticeText').focus();
});
$('loadDemoWeek').addEventListener('click', () => {
  const hasData = snapshot.events.length || snapshot.tasks.length || snapshot.routines.length;
  if (hasData && !window.confirm('载入示例会替换当前清单，请先导出要保留的内容。是否继续？')) return;
  // Next week, so every time in the example lies in the future.
  const monday = weekStart(Date.now()) + 7 * DAY;
  const at = (dayIndex, time) => `${localDate(monday + dayIndex * DAY)}T${time}:00+08:00`;
  const source = { id: 's-demo', kind: 'synthetic', text: '【虚构示例】一周安排：周三9:00-10:30讲座（与高数冲突）；周二12:00前讲座报名；周五23:59前交课程报告，约3小时。', published_at: null };
  // The example plans from next Monday 07:00, so its work blocks land in the week shown.
  let next = createTimeSnapshot({ referenceTime: at(0, '07:00') });
  next = setDailyWindow(next, DEFAULT_WINDOW);
  const from = localDate(monday - 56 * DAY);
  next = addRoutine(next, { title: '高等数学（示例）', weekdays: [1, 3], start: '08:00', end: '09:40', from, location: '主楼301' });
  next = addRoutine(next, { title: '大学英语（示例）', weekdays: [2, 4], start: '10:00', end: '11:40', from, location: '外语楼204' });
  next = addRoutine(next, { title: '社团例会（示例）', weekdays: [2], start: '19:00', end: '20:00', from });
  next = addImported(next, { source,
    events: [{ id: 'e-demo-park', kind: 'appointment', title: '和朋友去公园（示例）', start_at: at(5, '14:00'), end_at: at(5, '18:00'), location: null, status: 'active', source_id: 's-demo', evidence: [], notes: ['示例：自己约好的事属于落笔，同样占用留白。'] },
      { id: 'e-demo-talk', title: '参加讲座（示例）', start_at: at(2, '09:00'), end_at: at(2, '10:30'), location: '主楼405', status: 'active', source_id: 's-demo', evidence: [], notes: ['示例：故意与高数时间重叠，演示冲突。'] }],
    tasks: [
      { id: 't-demo-signup', title: '讲座报名（示例）', deadline_at: at(1, '12:00'), estimate_minutes: null, splittable: true, min_block_minutes: null, earliest_start_at: null, priority: null, status: 'active', location: null, materials: [], source_id: 's-demo', evidence: [], notes: ['示例：预计用时未定义，只显示截止。'] },
      { id: 't-demo-report', title: '课程报告（示例）', deadline_at: at(4, '23:59'), estimate_minutes: 180, splittable: true, min_block_minutes: 60, earliest_start_at: null, priority: 80, status: 'active', location: null, materials: [], source_id: 's-demo', evidence: [], notes: [] },
    ] });
  calendarWeek = monday;
  commit({ ...next, revision: snapshot.revision + 1 }, { unlock: !externalConflict && !storageLocked });
  tell('已载入示例一周（下周，从下周一7:00开始安排）：讲座撞上高数是一处叠墨，讲座报名的预计用时还是待书，周六和朋友去公园是一笔约定。想按真实时间安排，可在“铺纸”页点“使用当前时间”。');
  window.SixuRouter?.go('calendar');
});

renderAll();
if (recovered.error) tell(`本地清单未能读取：${recovered.error}。为保护原数据，当前修改暂不覆盖保存；请导入备份或明确清空后重建。`, 'warning');
else if (recovered.migrated) { tell('已把旧版清单转换成四层时间格式；旧数据仍保留在浏览器中，没有删除。'); save(); }
if (location.protocol === 'file:') tell('请通过本地HTTP服务打开此页面，直接打开文件无法完整加载编辑模块。', 'warning');
$('timetableText').value ||= '';
$('periodText').value = DEFAULT_PERIODS;
scheduleCalendar();
