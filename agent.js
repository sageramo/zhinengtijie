import { isTimestamp } from './task-state.js';
import { SnapshotStore } from './snapshot-store.js';
import {
  TIME_STORAGE_KEY, ESTIMATE_PRESETS, createTimeSnapshot, serializeTimeSnapshot, parseTimeSnapshot, readTimeSnapshot,
  addImported, updateTask, updateEvent, addTask, addEvent, removeItem, setDailyWindow, addRoutine,
  addAdjustment, addTimetable, setReferenceTime, setRoutinesConfirmed, skipRoutineDate, isPersonal, personalDay, addPersonalTask, setPersonalDay, setTaskDeadline,
} from './time-state.js';
import { agendaReply, hasPersonalClock, isConversation } from './agenda.js';
import { calendarMarkup, conflictKey, digestChanges, minutesLabel, resultDigest, weekStart, weekRange } from './calendar.js';
import { LEADS, dueReminders, icsCalendar, reminderText, upcomingCount } from './reminders.js';
import { createBellToggle } from './bell-toggle.js';
import { readMemory, writeMemory, recordActual, suggestEstimate, readCalibration, writeCalibration, recordCalibration, calibrationFor } from './estimate-memory.js';
import { createRecognizer, imageProblem } from './screenshot-ocr.js';
import { parseJwTimetable, termStartFrom } from './jw-timetable.js';

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
const TASK_STATE = { time_invalid: ['待书：请核对任务时间', 'undefined'], scheduled: ['已落笔', 'ok'], estimate_undefined: ['只标截止', ''], deadline_undefined: ['待书：截止未填', 'undefined'],
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
let strategyUndo = null; // { before, label, note, digest, changes } of the last 叠墨 strategy applied
let calendarFocus = ''; // one layer of the week shown alone ('' = all)
let lastImport = null; // the latest import reply, so its estimate chips can redraw it
const openCards = new Set(); // item cards whose editor the user opened; kept across re-renders
let solveState = null; // 精确重排 for the shown week: { loading } | { error } | { result }
let pendingDiff = null; // a change notice waiting for the user's word: { text, revision, result }
let skipDiffFor = ''; // the text the user chose to import as new despite a detected change
let groupMask = null; // my anonymous free mask for the shown week: { code, mask, range, slot }
let workGroup = null; // which 落笔 group is spread open ('appointment' | 'personal' | 'deadline'); null = pick one
const weighs = {}; // conflictKey -> { loading, error, pick, reason, note } from 请模型权衡
let scrollRolled = true; // 画卷 opens as a closed scroll each time the page is entered
let coverPainted = false; // the 山水 brushes in once per cover, not on every recalculation
let unrollTimer = null;
let parseSequence = 0;
let lastTaskId = null;
const chatHistory = [];
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
  const personal = tasks.filter(isPersonal).length;
  const pendingTasks = tasks.filter(task => task.deadline_at === null).length;
  set('work', [`<b>${appointments.length}</b> 件约定 · <b>${personal}</b> 件个人任务 · <b>${tasks.length - personal}</b> 件截止之事`, pendingTasks ? `<em>${pendingTasks} 件待书</em>` : '']);
  const pendingEvents = events.filter(item => !item.start_at || !item.end_at).length;
  set('event', [`<b>${events.length}</b> 处点墨`, events.slice(0, 2).map(item => escapeHTML(item.title)).join('、'), pendingEvents ? `<em>${pendingEvents} 处时间待书</em>` : '']);
}
function busy(button, value, idle, working) {
  button.disabled = value;
  button.setAttribute('aria-busy', String(value));
  // An icon button (the round send button) keeps its icon and says what it is doing through its label.
  if (button.hasAttribute('data-icon')) { button.setAttribute('aria-label', value ? working : idle); button.classList.toggle('is-busy', value); return; }
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
  solveState = null;
  save();
  if (render === 'all') renderAll(); else { renderBadges(); renderItemStates(); }
  scheduleCalendar();
  remindTick();
  checkBackup();
}
function showOnPage(element, block = 'start') {
  const roll = element.closest('[data-roll]');
  if (roll) openRoll(roll.dataset.roll);
  const group = element.closest?.('[data-group]');
  if (group) { workGroup = group.dataset.group; spreadWorkGroup(workGroup); }
  const editor = element.querySelector?.(':scope > .item-edit');
  if (editor) { editor.open = true; openCards.add(element.dataset.itemId); }
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
    // fetch rejects with a bare TypeError ("Failed to fetch", "Load failed") when the service cannot be reached.
    if (error instanceof TypeError) throw new Error('连不上计算服务，请检查网络后重试；线上服务闲置后需要约半分钟醒来。当前清单仍保留。');
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
      if (!code) throw new Error('没有输入访问口令，可以切回默认模式。');
      try { storage?.setItem(ACCESS_KEY, code); } catch { /* kept for this call only */ }
    }
  }
  throw new Error('访问口令不对，模型功能未调用。');
}
async function ensureHealth(base, { fresh = false } = {}) {
  if (!fresh && healthBase === base) return health;
  // The free server sleeps when idle; waking it takes about half a minute, so wait and say so.
  const slow = window.setTimeout(() => tell('计算服务正在醒来（免费服务器闲置后第一次要等半分钟左右），请稍候…'), 4000);
  let result;
  try { result = await request('/api/health', undefined, base, 90000); } finally { window.clearTimeout(slow); }
  if (!Array.isArray(result.capabilities) || !result.capabilities.includes('time_layers_v3')) throw new Error('计算服务还不是四层时间版本（需要后端1.12或更新），请重启本地服务后再试。');
  if (base === apiBase) { healthBase = base; health = result; }
  $('connectionStatus').textContent = `已连接计算服务 ${result.version}`;
  return result;
}

// ---- Calendar -----------------------------------------------------------
const shownWeek = () => calendarWeek ?? weekStart(Date.now());
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
    const live = Math.max(Date.parse(snapshot.reference_time), Date.parse(currentMinuteISO()));
    const current = { ...snapshot, reference_time: new Date(live).toISOString() };
    const result = await request('/api/v3/calendar', { snapshot: current, range: weekRange(shownWeek()) }, base);
    if (ticket !== calendarSequence || revision !== snapshot.revision || base !== apiBase) return;
    calendarResult = result;
    calendarError = '';
    // After a 叠墨 strategy, say in plain lines what the recalculation changed.
    if (strategyUndo?.digest && !strategyUndo.changes) strategyUndo.changes = digestChanges(strategyUndo.digest, resultDigest(result, shownWeek(), Date.now()));
  } catch (error) {
    if (ticket !== calendarSequence) return;
    calendarResult = null;
    calendarError = `日历暂时算不出来：${error.message}`;
  } finally {
    if (ticket === calendarSequence) { calendarLoading = false; renderCalendar(); renderItemStates(); renderBadges(); }
  }
}
function renderCalendar() {
  $('calendarView').innerHTML = calendarMarkup({ result: calendarResult, start: shownWeek(), now: Date.now(), loading: calendarLoading && !calendarResult, error: calendarError, undo: strategyUndo?.label || '', note: strategyUndo?.note || '', changes: strategyUndo?.changes || [], focus: calendarFocus, plans: solveState, weighs, rolled: scrollRolled, unrolling: Boolean(unrollTimer), fresh: !coverPainted });
  if (scrollRolled && calendarResult) coverPainted = true;
  $('calendarView').querySelector('.cal-remind-slot')?.append(remindBar);
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
  const tasks = snapshot.tasks.filter(task => task.status === 'active' && task.deadline_at === null).length;
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
  if (isPersonal(task) && (computed === 'deadline_undefined' || (!computed && task.deadline_at === null))) return ['待书：哪天做未定', 'undefined'];
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
/** One plain line under the title: when, where, how long. The full fields sit in the folded editor. */
function itemMeta(item) {
  if (item.deadline_at !== undefined) {
    const when = isPersonal(item) && !hasPersonalClock(item) ? (personalDay(item) ? `${personalDay(item).slice(5).replace('-', '月')}日做` : '哪天做待书')
      : item.deadline_at ? `截止 ${readable(item.deadline_at)}` : '截止待书';
    return `${when} · ${item.estimate_minutes === null ? '用时选填' : `预计 ${minutesLabel(item.estimate_minutes)}`}`;
  }
  const when = item.start_at ? `${readable(item.start_at)}${item.end_at ? ` – ${readable(item.end_at).split(' ')[1]}` : ' 开始，结束待书'}` : '时间待书';
  return [when, item.location].filter(Boolean).join(' · ');
}
/** The editor opens when the user opened it, or when something is still missing (待书). */
function editorOpen(item) {
  if (openCards.has(item.id)) return true;
  if (item.status !== 'active') return false;
  return item.deadline_at !== undefined ? item.deadline_at === null && !(isPersonal(item) && personalDay(item))
    : !item.start_at || !item.end_at;
}
const stateBadge = ([text, kind]) => `<span class="item-state${kind ? ` is-${kind}` : ''}" data-item-state>${escapeHTML(text)}</span>`;
function taskMarkup(task) {
  const active = task.status === 'active';
  const learned = task.estimate_minutes === null && active ? suggestEstimate(estimateMemory, task.title) : null;
  const chips = (learned ? `<button type="button" class="chip is-learned" data-estimate="${learned.minutes}" aria-pressed="false" title="按你记录过的实际用时">${escapeHTML(learned.label)}</button>` : '')
    + ESTIMATE_PRESETS.map(preset => `<button type="button" class="chip" data-estimate="${preset.minutes}" aria-pressed="${task.estimate_minutes === preset.minutes}">${preset.label}</button>`).join('');
  const kind = isPersonal(task) ? ['work', '个人任务'] : ['deadline', '截止'];
  return `<article class="item-card is-${kind[0]}${active ? '' : ' is-inactive'}" data-item-id="${escapeHTML(task.id)}" data-kind="task" id="item-${escapeHTML(task.id)}">
    <div class="item-top"><i class="item-glyph" aria-hidden="true"></i><span class="item-kind">${kind[1]}</span><div class="item-heading"><input class="item-title" data-field="title" value="${escapeHTML(task.title)}" aria-label="工作名称" maxlength="200"><p class="item-meta" data-item-meta>${escapeHTML(itemMeta(task))}</p></div>${stateBadge(taskState(task))}</div>
    <details class="item-edit"${editorOpen(task) ? ' open' : ''}><summary>修改${isPersonal(task) && !hasPersonalClock(task) ? '日期' : '截止'}、用时与拆分</summary>
    <div class="field-grid">
      ${isPersonal(task) && !hasPersonalClock(task) ? `<label>哪天做<input type="date" data-field="personal_day" value="${personalDay(task)}"></label>` : `<label>截止<input type="datetime-local" data-field="deadline_at" value="${toLocalInput(task.deadline_at)}"></label>`}
      <label>预计用时（分钟）<input type="number" inputmode="numeric" min="1" max="20160" data-field="estimate_minutes" value="${task.estimate_minutes ?? ''}" placeholder="未填"></label>
      <div class="field-wide chips" role="group" aria-label="预计用时快捷选择">${chips}</div>
      <label>能否拆开做<select data-field="splittable"><option value="true"${task.splittable ? ' selected' : ''}>可以分几次做</option><option value="false"${task.splittable ? '' : ' selected'}>需要一次做完</option></select></label>
      <label>优先级 <span class="optional">可选，0–100</span><input type="number" inputmode="numeric" min="0" max="100" data-field="priority" value="${task.priority ?? ''}" placeholder="未填按50"></label>
    </div></details>
    ${evidenceMarkup(task)}
    <div class="item-actions"><button type="button" data-action="complete">${task.status === 'completed' ? '恢复' : '完成了'}</button><button type="button" data-action="cancel">${task.status === 'cancelled' ? '恢复' : '不做了'}</button><button type="button" class="danger-text" data-action="delete">删除</button></div>
    <p class="field-error" data-item-error role="status"></p>
  </article>`;
}
function eventMarkup(event) {
  const appointment = event.kind === 'appointment';
  return `<article class="item-card is-${appointment ? 'appointment' : 'temporary'}${event.status === 'active' ? '' : ' is-inactive'}" data-item-id="${escapeHTML(event.id)}" data-kind="event" id="item-${escapeHTML(event.id)}">
    <div class="item-top"><i class="item-glyph" aria-hidden="true"></i><span class="item-kind">${appointment ? '约定' : '点墨'}</span><div class="item-heading"><input class="item-title" data-field="title" value="${escapeHTML(event.title)}" aria-label="${appointment ? '约定' : '点墨'}名称" maxlength="200"><p class="item-meta" data-item-meta>${escapeHTML(itemMeta(event))}</p></div>${stateBadge(eventState(event))}</div>
    <details class="item-edit"${editorOpen(event) ? ' open' : ''}><summary>修改时间、地点与类别</summary>
    <div class="field-grid">
      <label class="field-wide">这件事是<select data-field="kind"><option value="temporary"${appointment ? '' : ' selected'}>点墨：外部安排的一次性事项（讲座、考试等）</option><option value="appointment"${appointment ? ' selected' : ''}>约定：自己约好的事，属于落笔（如和朋友出去）</option></select></label>
      <label>开始<input type="datetime-local" data-field="start_at" value="${toLocalInput(event.start_at)}"></label>
      <label>结束<input type="datetime-local" data-field="end_at" value="${toLocalInput(event.end_at)}"></label>
      <label class="field-wide">地点 <span class="optional">可选</span><input data-field="location" value="${escapeHTML(event.location ?? '')}" maxlength="500"></label>
    </div></details>
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
  const personal = snapshot.tasks.filter(isPersonal);
  const deadlines = snapshot.tasks.filter(task => !isPersonal(task));
  $('personalList').innerHTML = personal.length ? personal.map(taskMarkup).join('') : '<p class="empty-note">还没有个人任务。点“添加个人任务”，或在研磨里说“提醒我今天……”。</p>';
  $('taskList').innerHTML = deadlines.length ? deadlines.map(taskMarkup).join('') : '<p class="empty-note">还没有截止之事。导入通知或手动添加。</p>';
  for (const [id, list] of [['eventCount', points], ['appointmentCount', appointments], ['personalCount', personal], ['deadlineCount', deadlines]]) $(id).textContent = String(list.length);
  const sizes = { appointment: appointments.length, personal: personal.length, deadline: deadlines.length };
  for (const [key, size] of Object.entries(sizes)) document.querySelector(`[data-group-count="${key}"]`).textContent = String(size);
  spreadWorkGroup(workGroup || ['deadline', 'personal', 'appointment'].find(key => sizes[key]) || 'deadline');
}
/** Spread one 落笔 group open; the other two fold into narrow strips beside it. */
function spreadWorkGroup(key) {
  $('taskSection').dataset.active = key;
  for (const group of $('taskSection').querySelectorAll('[data-group]')) {
    const open = group.dataset.group === key;
    group.classList.toggle('is-spread', open);
    group.querySelector('.group-expand').setAttribute('aria-expanded', String(open));
  }
}
function renderItemStates() {
  for (const card of document.querySelectorAll('[data-item-id]')) {
    const id = card.dataset.itemId;
    const item = card.dataset.kind === 'task' ? snapshot.tasks.find(entry => entry.id === id) : snapshot.events.find(entry => entry.id === id);
    if (!item) continue;
    card.querySelector('[data-item-state]').outerHTML = stateBadge(card.dataset.kind === 'task' ? taskState(item) : eventState(item));
    const meta = card.querySelector('[data-item-meta]');
    if (meta) meta.textContent = itemMeta(item);
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
const durationText = (start, end) => minutesLabel(Math.round((Date.parse(end) - Date.parse(start)) / 60000));
/** Rows and the one-line tally of an import, read from the current list so estimates set here show at once. */
function importResult(imported) {
  const current = item => (item.deadline_at !== undefined ? snapshot.tasks : snapshot.events).find(entry => entry.id === item.id) || item;
  const events = imported.events.map(current);
  const tasks = imported.tasks.map(current);
  const pending = tasks.filter(task => task.estimate_minutes === null && task.status === 'active').length;
  const noDeadline = tasks.filter(task => task.deadline_at === null && !isPersonal(task)).length;
  const noDay = tasks.filter(task => task.deadline_at === null && isPersonal(task)).length;
  const openEvents = events.filter(event => !event.start_at || !event.end_at).length;
  const points = events.filter(event => event.kind !== 'appointment').length;
  const appointments = events.length - points;
  const personal = tasks.filter(isPersonal).length;
  const deadlines = tasks.length - personal;
  const parts = [];
  if (points) parts.push(`${points} 处点墨`);
  if (appointments) parts.push(`${appointments} 件约定`);
  if (personal) parts.push(`${personal} 件个人任务`);
  if (deadlines) parts.push(`${deadlines} 件截止之事`);
  const missing = [noDeadline && `${noDeadline} 件的截止`, noDay && `${noDay} 件个人任务的日期`, openEvents && `${openEvents} 件事的结束时间`].filter(Boolean);
  const eventRow = event => {
    const kind = event.kind === 'appointment' ? ['appointment', '约定'] : ['temporary', '点墨'];
    const span = event.start_at ? `${readable(event.start_at)}${event.end_at ? ` – ${readable(event.end_at).split(' ')[1]}` : ' 开始'}` : '时间待书';
    const meta = [event.start_at && event.end_at ? `占用 ${durationText(event.start_at, event.end_at)}` : '结束时间待书', event.location].filter(Boolean).map(escapeHTML).join(' · ');
    return `<li class="turn-item is-${kind[0]}"><i class="turn-glyph" aria-hidden="true"></i><span class="turn-kind">${kind[1]}</span><strong>${escapeHTML(event.title)}</strong><span class="turn-when"><b>${span}</b><small>${meta}</small></span></li>`;
  };
  const taskRow = task => {
    const kind = isPersonal(task) ? ['work', '个人任务'] : ['deadline', '截止'];
    const when = isPersonal(task) && !hasPersonalClock(task) && task.earliest_start_at ? `${readable(task.earliest_start_at).split(' ')[0]} 做` : task.deadline_at ? `${readable(task.deadline_at)} 前` : '时间待书';
    const estimate = task.estimate_minutes === null
      ? `<span class="turn-estimate" role="group" aria-label="「${escapeHTML(task.title)}」的预计用时"><span>预计用时（选填）</span>${ESTIMATE_PRESETS.slice(0, 4).map(preset => `<button type="button" class="chip" data-turn-estimate="${escapeHTML(task.id)}:${preset.minutes}">${preset.label}</button>`).join('')}</span>`
      : `<span class="turn-estimate is-set">预计 ${minutesLabel(task.estimate_minutes)}<small>画卷会在截止前的留白里排入</small></span>`;
    return `<li class="turn-item is-${kind[0]}"><i class="turn-glyph" aria-hidden="true"></i><span class="turn-kind">${kind[1]}</span><strong>${escapeHTML(task.title)}</strong><span class="turn-when"><b>${when}</b><small>${task.deadline_at ? '截止前找留白去做' : '先记下，日期可在笔墨补'}</small></span>${estimate}</li>`;
  };
  const group = (key, title, hint, rows) => rows ? `<section class="turn-group is-${key}"><h4>${title}<small>${hint}</small></h4><ul class="turn-items">${rows}</ul></section>` : '';
  return `<div class="turn-result" data-turn-result>${group('fixed', '要到场', '占用一段固定时间', events.map(eventRow).join(''))}${group('due', '要完成', '有截止，需要留出做事的时间', tasks.map(taskRow).join(''))}<p class="turn-tally"><strong>已加入 ${parts.join('、') || '0 项'}。</strong>${missing.length ? `${missing.join('、')}还是待书，可以随时补；没补之前它们不会挡住其他事项。` : '时间信息都已写清楚。'}${pending ? ' 预计用时可以不填，只标截止；填了用时，画卷会在截止前为它找留白。' : ''}</p></div>`;
}
function importSummary(imported) {
  lastImport = imported;
  const warnings = (imported.warnings || []).map(note => `<li>${escapeHTML(note)}</li>`).join('');
  return `${importResult(imported)}
    ${warnings ? `<ul>${warnings}</ul>` : ''}<p class="inline-links"><a href="#/items">去笔墨补充</a><a href="#/calendar">看画卷</a></p>`;
}
function showTurn(text, html) {
  archiveTurn();
  pushUserTurn(text);
  $('importSummary').dataset.turn = '1';
  $('importSummary').innerHTML = html;
  $('importSummary').hidden = false;
  $('noticeText').value = '';
  $('noticeText').style.height = '';
  if ($('noticeSection').getBoundingClientRect().bottom > window.innerHeight) {
    $('noticeForm').scrollIntoView?.({ block: 'end', behavior: scrollBehavior() });
  }
}
function replyMarkup(reply) {
  const links = { calendar: '<a href="#/calendar" data-agenda-calendar>看画卷</a>',
    setup: '<a href="#/time">去铺纸设置</a>', tasks: '<a href="#/items">去落笔查看</a>' };
  return `<p>${escapeHTML(reply.text)}</p>${reply.extraHtml || ''}${links[reply.action] ? `<p class="inline-links">${links[reply.action]}</p>` : ''}`;
}
let agendaWeek = null;
$('importSummary').addEventListener('click', event => {
  if (event.target.closest('[data-diff-apply]')) { applyDiff(); return; }
  if (event.target.closest('[data-diff-import]') && pendingDiff) {
    skipDiffFor = pendingDiff.text;
    $('noticeText').value = pendingDiff.text;
    pendingDiff = null;
    $('noticeForm').requestSubmit ? $('noticeForm').requestSubmit() : $('noticeForm').dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  const chip = event.target.closest('[data-turn-estimate]');
  if (chip && lastImport) {
    const [id, minutes] = chip.dataset.turnEstimate.split(':');
    if (!snapshot.tasks.some(task => task.id === id)) return tell('这件事已经不在清单里了。', 'warning');
    commit(updateTask(snapshot, id, { estimate_minutes: Number(minutes) }));
    const box = $('importSummary').querySelector('[data-turn-result]');
    if (box) box.outerHTML = importResult(lastImport);
    tell(`已记下预计用时 ${minutesLabel(Number(minutes))}，画卷会在截止前的留白里排入。`);
    return;
  }
  if (!event.target.closest('[data-agenda-calendar]')) return;
  if (agendaWeek !== null && agendaWeek !== shownWeek()) {
    calendarWeek = agendaWeek;
    calendarResult = null;
    scheduleCalendar();
  }
});
$('noticeForm').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('parseNotice').disabled) return;
  if (externalConflict) return tell('请先处理另一个标签页的清单变化。', 'warning');
  const text = $('noticeText').value.trim();
  const referenceDate = $('noticeDate').value || null;
  const mode = $('extractionMode').value;
  if (!text) { $('noticeText').focus(); return tell('先写一句话，或粘贴一条通知。', 'warning'); }
  const ticket = ++parseSequence;
  const base = apiBase;
  const stillCurrent = () => ticket === parseSequence && base === apiBase && !externalConflict;
  busy($('parseNotice'), true, '发送', '正在处理…');
  showParseProgress(mode);
  $('parseStep').textContent = '正在理解这条消息';
  tell('');
  try {
    const inputSnapshot = snapshot;
    let reply = mode === 'chat' ? null : await agendaReply(text, { snapshot, lastTaskId, calculate: async body => {
      await ensureHealth(base);
      return request('/api/v3/calendar', body, base);
    } });
    if (!stillCurrent()) return;
    if (reply && inputSnapshot !== snapshot) throw new Error('清单刚刚有变化，请再发送一次。');
    const modelChat = !reply && mode === 'chat';
    if (modelChat) {
      if ([...text].length > 2000) throw new Error('聊天消息每次最多 2000 字。');
      const service = await ensureHealth(base);
      if (!service.capabilities.includes('agenda_chat_v1') || !service.timetable_model?.configured) throw new Error('当前服务尚未开启模型聊天。');
      $('parseStep').textContent = '司序正在回复';
      const messages = [...chatHistory.slice(-8), { role: 'user', text }];
      const result = await modelRequest('/api/v3/chat', { mode: 'model', messages }, base, 90000);
      if (!stillCurrent()) return;
      chatHistory.splice(0, chatHistory.length, ...messages.slice(-7), { role: 'assistant', text: result.reply });
      reply = { text: result.reply };
    }
    if (!reply && isConversation(text)) {
      reply = { text: '这句我还接不住。可以继续问本周空档，或在输入框下选「模型聊天」聊别的。' };
    }
    if (reply?.capacity) reply.extraHtml = await calibrationNote(reply.capacity, base).catch(() => '');
    if (!stillCurrent()) return;
    if (reply) {
      if (reply.next) commit(reply.next);
      agendaWeek = reply.week ?? null;
      showTurn(text, replyMarkup(reply));
      return;
    }
    if (mode === 'model' && [...text].length > 20000) throw new Error('模型提取每次最多两万字，请拆分通知后重试。');
    const matchingSources = new Set(snapshot.sources.filter(source => source.text === text).map(source => source.id));
    if (matchingSources.size && !/^(?:提醒我|帮我记|别忘了|记得|待办)|^(?:今天|明天|后天|今晚|明早|明晚|(?:下)?周[一二三四五六日天])/.test(text)) {
      throw new Error('这份通知已经导入过了，可以在笔墨直接修改。');
    }
    const service = await ensureHealth(base, { fresh: mode === 'model' });
    if (mode === 'model' && !service.model_extraction?.configured) throw new Error('当前服务没有启用模型提取，可以改用默认模式。');
    if (!stillCurrent()) return;
    const known = [...snapshot.events, ...snapshot.tasks].some(item => item.status === 'active');
    if (known && mode !== 'model' && skipDiffFor !== text && service.capabilities.includes('notice_diff_v1')) {
      $('parseStep').textContent = '正在核对是不是已有事项的变更';
      const live = { ...snapshot, reference_time: new Date(Math.max(Date.parse(snapshot.reference_time), Date.parse(currentMinuteISO()))).toISOString() };
      const diff = await request('/api/v3/notice-diff', { snapshot: live, text, reference_date: referenceDate, range: weekRange(shownWeek()), mode: 'rules' }, base, 30000);
      if (!stillCurrent()) return;
      if (diff.summary.updated + diff.summary.cancelled > 0) {
        pendingDiff = { text, revision: snapshot.revision, result: diff };
        showTurn(text, diffMarkup(diff));
        return;
      }
    }
    skipDiffFor = '';
    $('parseStep').textContent = '正在整理事项与时间';
    const imported = await (mode === 'model' ? modelRequest : request)('/api/v3/extract', { text, reference_date: referenceDate, mode }, base, mode === 'model' ? 100000 : 30000);
    if (!stillCurrent()) return;
    if (!imported.tasks.length && !imported.events.length) {
      showTurn(text, replyMarkup({ text: '这句里暂时没有识别出事项。试试「提醒我今天写实验报告，30分钟」，也可以选「模型聊天」。' }));
      return;
    }
    if (matchingSources.size) {
      const same = (item, list, when) => list.some(saved => matchingSources.has(saved.source_id) && saved.title === item.title && saved[when] === item[when]);
      if (imported.tasks.every(task => same(task, snapshot.tasks, 'deadline_at'))
          && imported.events.every(event => same(event, snapshot.events, 'start_at'))) throw new Error('这份通知已经导入过了，可以在笔墨直接修改。');
    }
    if (text.startsWith('【虚构示例】')) imported.source.kind = 'synthetic';
    let next = addImported(snapshot, imported);
    const defaulted = !next.daily_window;
    if (defaulted) next = setDailyWindow(next, DEFAULT_WINDOW);
    commit(next);
    const personal = imported.tasks.filter(isPersonal);
    lastTaskId = personal.length === 1 && imported.tasks.length === 1 && !imported.events.length ? personal[0].id : null;
    agendaWeek = null;
    const follow = lastTaskId && personal[0].estimate_minutes === null
      ? '<p>这件事大约要多久？可以直接回“30分钟”，做完也可以告诉我。</p>' : '';
    showTurn(text, importSummary(imported) + follow + (defaulted ? '<p class="field-help">先用默认作息（工作日 08:00–23:00，周末 09:00–23:00）。课表和作息可以在铺纸里补齐。</p>' : '') + endAskMarkup(imported));
    estimateEnds('rules', imported.source.text);
  } catch (error) {
    if (ticket === parseSequence) tell(`处理未完成：${error.message} 输入内容仍在。`, 'error');
  } finally {
    if (ticket === parseSequence) { busy($('parseNotice'), false, '发送', '正在处理…'); hideParseProgress(); }
  }
});
// ---- The 研磨 conversation: what was sent, and what 司序 added, newest last above the composer.
function archiveTurn() {
  const current = $('importSummary');
  if (!current.dataset.turn) return; // the box is hidden while a new send runs, so a flag says it holds a reply
  delete current.dataset.turn;
  const past = document.createElement('div');
  past.className = 'import-summary turn-agent is-past';
  past.innerHTML = current.innerHTML;
  past.querySelectorAll('.end-ask, .inline-links, .turn-estimate:not(.is-set)').forEach(node => node.remove());
  past.querySelector('[data-turn-result]')?.removeAttribute('data-turn-result');
  current.before(past);
}
function pushUserTurn(text) {
  const turn = document.createElement('div');
  turn.className = 'turn-user';
  turn.textContent = text;
  $('importSummary').before(turn);
}
const growNotice = () => { const box = $('noticeText'); box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight + 2, window.innerHeight * 0.45)}px`; };
$('noticeText').addEventListener('input', growNotice);
$('noticeText').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('noticeForm').requestSubmit(); }
});
for (const chip of document.querySelectorAll('[data-suggest]')) {
  chip.addEventListener('click', () => { $('noticeText').value = chip.dataset.suggest; $('noticeText').dispatchEvent(new Event('input')); $('noticeText').focus(); });
}

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
for (const id of ['noticeText', 'noticeDate', 'extractionMode']) $(id).addEventListener('input', () => { parseSequence += 1; busy($('parseNotice'), false, '发送'); hideParseProgress(); });

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
// Several screenshots at once: read one after another, each appended to the inkwell.
async function recognizeMany(files) {
  const images = Array.from(files || []).filter(Boolean);
  for (const [index, file] of images.entries()) {
    if (images.length > 1) tell(`正在识别第 ${index + 1}/${images.length} 张截图…`);
    await recognizeNotice(file);
  }
  if (images.length > 1) tell(`${images.length} 张截图都已识别，文字依次放进了砚池，请对照核对后再导入。`);
}
$('noticeImage').addEventListener('change', event => {
  recognizeMany(event.target.files);
  event.target.value = '';
});
// One tap instead of long-press → 粘贴: text goes into the inkwell, a copied image goes to OCR.
$('pasteClipboard').addEventListener('click', async () => {
  const clip = navigator.clipboard;
  if (!clip) return tell('这个浏览器不让网页读取剪贴板，请在砚池里长按粘贴。', 'warning');
  try {
    if (typeof clip.read === 'function') {
      const entries = await clip.read();
      const images = [];
      for (const entry of entries) {
        const type = entry.types.find(kind => kind.startsWith('image/'));
        if (type) images.push(new window.File([await entry.getType(type)], `clipboard.${type.split('/')[1]}`, { type }));
      }
      if (images.length) return recognizeMany(images);
    }
    const text = (await clip.readText()).trim();
    if (!text) return tell('剪贴板里没有文字。先在微信里长按通知 → 复制，再回来点一下。', 'warning');
    appendNotice(text);
    tell('已从剪贴板放进砚池，核对后点“导入”。');
  } catch {
    tell('没能读取剪贴板（浏览器需要你允许）。也可以在砚池里长按粘贴。', 'warning');
  }
});
function appendNotice(text) {
  const box = $('noticeText');
  box.value = box.value.trim() ? `${box.value.trimEnd()}\n\n${text}` : text;
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
}
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
  if (card.dataset.kind === 'task' && Object.hasOwn(patch, 'deadline_at')) return setTaskDeadline(snapshot, id, patch.deadline_at);
  return card.dataset.kind === 'task' ? updateTask(snapshot, id, patch) : updateEvent(snapshot, id, patch);
}
function onItemChange(event) {
  const input = event.target.closest('[data-field]');
  const card = event.target.closest('[data-item-id]');
  if (!input || !card) return;
  try {
    const next = input.dataset.field === 'personal_day' ? setPersonalDay(snapshot, card.dataset.itemId, input.value || null)
      : editItem(card, { [input.dataset.field]: fieldValue(input) });
    input.setAttribute('aria-invalid', 'false');
    itemError(card, '');
    // Changing 点墨/约定 moves the card to the other list.
    commit(next, { render: input.dataset.field === 'kind' ? 'all' : 'none' });
    if (card.dataset.kind === 'task' && ['title', 'estimate_minutes'].includes(input.dataset.field)) refreshLearned(card);
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
    const actual = event.target.closest('[data-actual]');
    if (actual) { saveActual(id, actual.dataset.actual); return; }
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
      const finishing = item.status !== 'completed';
      commit(updateTask(snapshot, id, { status: finishing ? 'completed' : 'active' }));
      if (finishing) askActual(id);
    } else if (action === 'cancel') {
      const status = item.status === 'cancelled' ? 'active' : 'cancelled';
      commit(isTask ? updateTask(snapshot, id, { status }) : updateEvent(snapshot, id, { status }));
    }
  } catch (error) { itemError(card, error.message); }
}
// ---- 越用越准的估时 -----------------------------------------------------
let estimateMemory = readMemory(storage);
const ACTUAL_CHOICES = [[30, '半小时'], [60, '1小时'], [120, '2小时'], [180, '3小时'], [300, '5小时']];
function askActual(id) {
  const card = $(`item-${id}`);
  if (!card) return;
  const task = snapshot.tasks.find(item => item.id === id);
  const choices = ACTUAL_CHOICES.map(([minutes, label]) => `<button type="button" class="chip" data-actual="${minutes}"${task?.estimate_minutes === minutes ? ' aria-pressed="true"' : ''}>${label}</button>`).join('');
  card.querySelector('.item-actions').insertAdjacentHTML('afterend', `<div class="actual-ask" role="group" aria-label="实际用了多久"><span>实际用了多久？记下来，下次同类的事会按你的实际用时估。</span><div class="chips">${choices}<button type="button" class="text-button" data-actual="skip">不记了</button></div></div>`);
}
/** A renamed task without an estimate gets (or loses) its learned suggestion without redrawing the card. */
function refreshLearned(card) {
  const task = snapshot.tasks.find(item => item.id === card.dataset.itemId);
  card.querySelector('.chip.is-learned')?.remove();
  const learned = task && task.status === 'active' && task.estimate_minutes === null ? suggestEstimate(estimateMemory, task.title) : null;
  if (!learned) return;
  card.querySelector('.chips[aria-label="预计用时快捷选择"]')?.insertAdjacentHTML('afterbegin', `<button type="button" class="chip is-learned" data-estimate="${learned.minutes}" aria-pressed="false" title="按你记录过的实际用时">${escapeHTML(learned.label)}</button>`);
}
function saveActual(id, value) {
  const card = $(`item-${id}`);
  card?.querySelector('.actual-ask')?.remove();
  if (value === 'skip') return;
  const task = snapshot.tasks.find(item => item.id === id);
  const before = estimateMemory;
  estimateMemory = recordActual(estimateMemory, task?.title, Number(value));
  writeMemory(storage, estimateMemory);
  if (task?.estimate_minutes) writeCalibration(storage, recordCalibration(readCalibration(storage), task.title, task.estimate_minutes, Number(value)));
  tell(estimateMemory === before ? '记下了；这类事还没有归类，暂不用于估时。' : '记下了，下次同类的事会参考这次的实际用时。');
}

for (const list of ['eventList', 'appointmentList', 'personalList', 'taskList']) {
  $(list).addEventListener('change', onItemChange);
  $(list).addEventListener('click', onItemClick);
  // Only a click on the summary counts as the user's choice: a card rendered open (because something is
  // missing) also fires 'toggle', and recording that would keep it open after the gap is filled.
  $(list).addEventListener('click', event => {
    const summary = event.target.closest('.item-edit > summary');
    const id = summary?.closest('[data-item-id]')?.dataset.itemId;
    if (!id) return;
    if (summary.parentElement.open) openCards.delete(id); else openCards.add(id); // the click flips it right after
  });
}
$('taskSection').addEventListener('click', event => {
  const strip = event.target.closest('[data-group-open]');
  if (!strip) return;
  workGroup = strip.dataset.groupOpen;
  spreadWorkGroup(workGroup);
  strip.closest('[data-group]').querySelector('.group-head button')?.focus({ preventScroll: true });
});
$('addPersonal').addEventListener('click', () => {
  commit(addPersonalTask(snapshot, { day: localDate(Date.now()) }));
  const title = $('personalList').lastElementChild.querySelector('[data-field="title"]');
  title.focus(); title.select();
});
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
// 教务网页: a saved 金智「我的课表」page is read here in the browser (jw-timetable.js). Its period table
// and the week number shown on the page fill the form, and the courses go through the same
// convert step and preview as the other timetable routes; no model, no access code.
$('chooseJwPage').addEventListener('click', () => $('jwPage').click());
$('jwPage').addEventListener('change', async event => {
  const [file] = event.target.files || [];
  event.target.value = '';
  if (!file) return;
  try {
    if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') throw new Error('请上传另存下来的 .html 网页文件。');
    if (file.size > 5_000_000) throw new Error('这个文件太大，不像是课表网页。');
    const source = typeof file.text === 'function' ? await file.text()
      : await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读不出来。')); reader.readAsText(file); });
    const parsed = parseJwTimetable(source);
    if (!parsed.courses.length) throw new Error('网页里的课程都没读懂，请改用复制课表文字或截图识别。');
    $('timetableText').value = parsed.text;
    const lines = Object.entries(parsed.periods).sort((a, b) => Number(a[0]) - Number(b[0])).map(([number, item]) => `${number} ${item.start}-${item.end}`);
    if (lines.length) $('periodText').value = lines.join('\n');
    const savedOn = new Date((file.lastModified || Date.now()) + 8 * 3600000).toISOString().slice(0, 10);
    const firstMonday = termStartFrom(savedOn, parsed.currentWeek);
    if (firstMonday) $('termStart').value = firstMonday;
    lastTimetable = { text: parsed.text, result: { courses: parsed.courses } };
    await runTimetable('convert');
    const notes = [`读出 ${parsed.courses.length} 种上课安排`];
    if (firstMonday) notes.push(`按网页上的「第${parsed.currentWeek}周」（${savedOn}保存）推算第1周周一为 ${firstMonday}，请核对`);
    if (parsed.skipped.length) notes.push(`${parsed.skipped.length} 个格子没读懂，未采用：${parsed.skipped.join('、')}`);
    tell(`${notes.join('；')}。`);
  } catch (error) {
    tell(`教务网页没有读成：${error.message}`, 'error');
  }
});
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
  if (event.target.closest('[data-scroll-open]')) { unrollScroll(); return; }
  if (event.target.closest('[data-scroll-roll]')) { scrollRolled = true; coverPainted = false; renderCalendar(); return; }
  if (event.target.closest('[data-strategy-undo]')) { undoStrategy(); return; }
  if (event.target.closest('[data-solve]')) { runSolve(); return; }
  const plan = event.target.closest('[data-plan]');
  if (plan) { applyPlan(Number(plan.dataset.plan)); return; }
  const focus = event.target.closest('[data-cal-focus]');
  if (focus) { calendarFocus = calendarFocus === focus.dataset.calFocus ? '' : focus.dataset.calFocus; renderCalendar(); return; }
  const weigh = event.target.closest('[data-weigh]');
  if (weigh) { weighConflict(weigh.dataset.weigh); return; }
  if (event.target.closest('[data-copy-note]')) { copyNote(); return; }
  const option = event.target.closest('[data-strategy]');
  if (option) { applyStrategy(option.dataset.strategy); return; }
  const target = event.target.closest('[data-cal-item]');
  if (!target) return;
  const { calItem: id, calLayer: layer } = target.dataset;
  const element = $(layer === 'routine' ? `routine-${id}` : `item-${id}`);
  if (element) showOnPage(element, 'center');
});
/** Apply one rule-based strategy from the calendar result; the previous list is kept for one undo. */
/** One rule-based change (a 叠墨 strategy or a step of a 多方案 plan) applied to a list; null for 'review'. */
function withAction(base, { action, params }) {
  if (action === 'skip_routine_date') return skipRoutineDate(base, params.routine_id, params.date);
  if (action === 'cancel_event') return updateEvent(base, params.event_id, { status: 'cancelled' });
  if (action === 'move_event') return updateEvent(base, params.event_id, { start_at: params.start_at, end_at: params.end_at });
  if (action === 'update_task') return updateTask(base, params.task_id, params.patch);
  if (action === 'add_free') return addAdjustment(base, { kind: 'add', start_at: params.start_at, end_at: params.end_at, note: params.note });
  return null;
}

// ---- 精确重排与多方案对比（后端 /api/v3/solve）--------------------------------
async function runSolve() {
  const revision = snapshot.revision;
  const base = apiBase;
  solveState = { loading: true };
  renderCalendar();
  try {
    const live = Math.max(Date.parse(snapshot.reference_time), Date.parse(currentMinuteISO()));
    const result = await request('/api/v3/solve', { snapshot: { ...snapshot, reference_time: new Date(live).toISOString() }, range: weekRange(shownWeek()), transit_minutes: 10 }, base, 60000);
    if (revision !== snapshot.revision || base !== apiBase) return;
    solveState = { result };
  } catch (error) {
    if (revision !== snapshot.revision) return;
    solveState = { error: `没能求解：${error.message}` };
  }
  renderCalendar();
}
function applyPlan(index) {
  const plan = solveState?.result?.pareto_plans?.[index];
  if (!plan) return;
  let next = snapshot;
  try {
    for (const action of plan.actions) next = withAction(next, action) || next;
  } catch (error) { tell(`这个方案没能采用：${error.message}`, 'error'); return; }
  const before = snapshot;
  const digest = calendarResult ? resultDigest(calendarResult, shownWeek(), Date.now()) : null;
  commit(next);
  strategyUndo = { before, label: `${plan.name}（${plan.actions.map(action => action.label).join('；')}）`, note: '', digest, changes: null };
  tell(`已采用：${plan.name}`);
}

// ---- 通知变更识别（后端 /api/v3/notice-diff）---------------------------------
const DIFF_FIELD = { start_at: '开始', end_at: '结束', location: '地点', deadline_at: '截止', earliest_start_at: '哪天做', status: '状态' };
function diffValue(field, value) {
  if (value === null || value === undefined || value === '') return '未填';
  if (field === 'status') return value === 'cancelled' ? '取消' : value === 'completed' ? '完成' : '照常';
  return /_at$/.test(field) ? readable(value) : String(value);
}
function diffMarkup(diff) {
  const ops = diff.operations.filter(op => op.action === 'update' || op.action === 'cancel').map(op => {
    const kind = op.kind === 'event' ? '点墨' : '截止';
    const rows = op.action === 'cancel' ? '<li><span>状态</span><s>照常</s><i aria-hidden="true">→</i><b>取消</b></li>'
      : Object.entries(op.changes).map(([field, change]) => `<li><span>${DIFF_FIELD[field] || field}</span><s>${escapeHTML(diffValue(field, change.from))}</s><i aria-hidden="true">→</i><b>${escapeHTML(diffValue(field, change.to))}</b></li>`).join('');
    return `<li class="diff-op is-${op.action}"><p><em>${kind}</em><strong>${escapeHTML(op.target_title || op.incoming?.title || '')}</strong>${op.action === 'cancel' ? '<span class="diff-tag">取消</span>' : '<span class="diff-tag">改动</span>'}</p><ul>${rows}</ul></li>`;
  }).join('');
  const added = diff.summary.added ? `<p class="field-help">另有 ${diff.summary.added} 项像是新事项，采用后会一并加入。</p>` : '';
  const impact = diff.impact || {};
  const titles = Object.fromEntries(snapshot.tasks.map(task => [task.id, task.title]));
  const shifts = (impact.work_shifts || []).map(shift => `<li><span>落笔「${escapeHTML(titles[shift.id] || '')}」</span><s>${shift.from ? `${readable(shift.from[0])}–${readable(shift.from[1]).split(' ')[1]}` : '未排入'}</s><i aria-hidden="true">→</i><b>${shift.to ? `${readable(shift.to[0])}–${readable(shift.to[1]).split(' ')[1]}` : '未排入'}</b></li>`).join('');
  const conflictLine = `<li><span>叠墨</span><s>${impact.conflicts_before ?? '–'} 处</s><i aria-hidden="true">→</i><b>${impact.conflicts_after ?? '–'} 处</b></li>`;
  const freeLine = impact.free_delta_minutes ? `<li><span>本周留白</span><s>原来</s><i aria-hidden="true">→</i><b>${impact.free_delta_minutes > 0 ? '+' : '−'}${minutesLabel(Math.abs(impact.free_delta_minutes))}</b></li>` : '';
  return `<div class="diff-card"><p class="diff-head"><strong>这像是一条变更通知</strong>：对清单里已有的 ${diff.summary.updated + diff.summary.cancelled} 件事有改动。司序没有新建重复事项，先给你看看变化。</p>
    <ol class="diff-ops">${ops}</ol>${added}
    <div class="cx-changes diff-impact"><p>采用后，画卷会这样变化</p><ul>${conflictLine}${freeLine}${shifts}</ul></div>
    ${impact.conflicts_after > impact.conflicts_before ? '<p class="diff-warn">注意：改动后会多出叠墨，采用后到画卷查看对策。</p>' : impact.conflicts_after ? `<p class="diff-warn">改动后仍有 ${impact.conflicts_after} 处叠墨（可能换成了和别的事相撞），采用后到画卷查看对策。</p>` : ''}
    <div class="inline-actions diff-actions"><button type="button" class="primary-button" data-diff-apply>采用这些变更</button><button type="button" data-diff-import>仍当新通知导入</button></div></div>`;
}
function applyDiff() {
  if (!pendingDiff) return;
  if (pendingDiff.revision !== snapshot.revision) { pendingDiff = null; return tell('清单刚刚有变化，请再发送一次这条通知。', 'warning'); }
  let next;
  try { next = parseTimeSnapshot(JSON.stringify({ ...pendingDiff.result.preview_snapshot, revision: snapshot.revision + 1 })); }
  catch (error) { return tell(`这些变更没能采用：${error.message}`, 'error'); }
  const { summary } = pendingDiff.result;
  pendingDiff = null;
  commit(next);
  $('importSummary').querySelector('.diff-actions')?.replaceWith(Object.assign(document.createElement('p'), { className: 'diff-done', textContent: `已采用：改动 ${summary.updated} 件、取消 ${summary.cancelled} 件${summary.added ? `、新增 ${summary.added} 件` : ''}。` }));
  tell('已按变更通知更新清单，画卷随之重算。');
}

// ---- 个人估时校准（后端 /api/v3/calibrate-capacity）---------------------------
async function calibrationNote(capacity, base) {
  const history = readCalibration(storage);
  if (calibrationFor(history, null).count < 2) return '';
  const service = await ensureHealth(base);
  if (!service.capabilities.includes('capacity_calibration_v1')) return '';
  const today = localDate(Date.now());
  const range = capacity.scope === 'today' ? { from: today, to: today } : weekRange(capacity.scope === 'next' ? weekStart(Date.now()) + 7 * DAY : weekStart(Date.now()));
  const live = { ...snapshot, reference_time: new Date(Math.max(Date.parse(snapshot.reference_time), Date.parse(currentMinuteISO()))).toISOString() };
  const result = await request('/api/v3/calibrate-capacity', { history, nominal_minutes: capacity.needed, reserve_minutes: capacity.reserve, splittable: Boolean(capacity.split), snapshot: live, range }, base, 30000);
  if (!result.calibrated_verdict) return '';
  const factor = result.calibration.factor;
  return `<div class="calib${result.optimism_risk ? ' is-risk' : ''}"><p class="calib-head">${result.optimism_risk ? '乐观偏差预警' : '按你的历史节奏复核'}<span>以往 ${result.calibration.sample_count} 次实际用时约为预估的 ${factor} 倍</span></p>
    <ul><li><span>按你说的</span><b>${minutesLabel(result.nominal_minutes)}</b><em>${result.nominal_verdict.fits ? '排得下' : '排不下'}</em></li><li><span>按以往节奏</span><b>${minutesLabel(result.calibrated_minutes)}</b><em>${result.calibrated_verdict.fits ? '排得下' : '排不下'}</em></li></ul>
    <p>${escapeHTML(result.optimism_risk ? `按以往节奏要 ${minutesLabel(result.calibrated_minutes)}，算上预留的 ${minutesLabel(result.reserve_minutes)} 休息就不够了；答应之前再想想，或者把事拆小。` : result.calibrated_verdict.summary)}</p></div>`;
}

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
    next = withAction(snapshot, strategy);
    if (!next) return;
  } catch (error) { tell(`这条对策没能采用：${error.message}`, 'error'); return; }
  const before = snapshot;
  const conflict = calendarResult.conflicts.find(item => item.id === conflictId);
  const weighed = weighs[conflictKey(conflict)];
  const digest = resultDigest(calendarResult, shownWeek(), Date.now());
  commit(next);
  strategyUndo = { before, label: strategy.label, note: weighed?.pick === Number(index) ? weighed.note || '' : '', digest, changes: null };
  tell(`已采用：${strategy.label}`);
  // Skipping a class leaves one more step: a leave note to the teacher, drafted by the same rules.
  if (strategy.action === 'skip_routine_date' && !strategyUndo.note) {
    const undo = strategyUndo;
    request('/api/v3/advise', { ...advicePayload(conflict), strategies: [strategy].map(adviceOption) }, apiBase)
      .then(result => { if (strategyUndo === undo && result.note) { undo.note = result.note; renderCalendar(); } })
      .catch(() => { /* the plan itself is applied; the note is optional */ });
  }
}

// ---- 叠墨：请模型权衡 ------------------------------------------------------
// The rules computed every option; the model only weighs them and says why, by option number.
const adviceOption = strategy => ({ action: strategy.action, label: strategy.label, detail: strategy.detail, recommended: Boolean(strategy.recommended) });
function advicePayload(conflict) {
  const located = item => {
    if (item.layer === 'routine') return snapshot.routines.find(routine => routine.id === item.id.split('@')[0])?.location || null;
    return snapshot.events.find(event => event.id === item.id)?.location || null;
  };
  const items = conflict.items.slice(0, 2).map(item => ({ title: item.title, layer: item.layer, start: item.start || null, end: item.end || null, location: located(item) }));
  const sources = new Set(conflict.items.map(item => snapshot.events.find(event => event.id === item.id)?.source_id).filter(Boolean));
  const context = snapshot.sources.filter(source => sources.has(source.id)).map(source => source.text).join('\n\n').slice(0, 4000);
  return { type: conflict.type, items, advice: (conflict.advice || '').slice(0, 300), context };
}
async function weighConflict(key) {
  const conflict = calendarResult?.conflicts.find(item => conflictKey(item) === key);
  if (!conflict || weighs[key]?.loading) return;
  weighs[key] = { loading: true };
  renderCalendar();
  try {
    const result = await modelRequest('/api/v3/advise', { mode: 'model', ...advicePayload(conflict), strategies: conflict.strategies.map(adviceOption) }, apiBase, 60000);
    weighs[key] = { pick: result.pick, reason: result.reason, note: result.note || '' };
  } catch (error) {
    weighs[key] = { error: `没能权衡：${error.message}` };
  }
  renderCalendar();
}
async function copyNote() {
  const box = $('leaveNote');
  if (!box) return;
  try { await navigator.clipboard.writeText(box.value); tell('请假说明已复制，记得把【】换成你的信息。'); }
  catch { box.select(); tell('请长按或用快捷键复制选中的文字。', 'warning'); }
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
// 展开画卷: the paper widens from the centre while both rods roll outward, an ink wash spreads over it,
// the 山水 shows through and settles into a faint wash as the week appears (agent.css .is-unrolling).
function unrollScroll() {
  scrollRolled = false;
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  window.clearTimeout(unrollTimer);
  unrollTimer = calm ? null : window.setTimeout(() => {
    unrollTimer = null;
    $('calendarView').querySelector('.scroll')?.classList.remove('is-unrolling');
  }, 2000);
  renderCalendar();
  window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
  const mount = $('calendarView').querySelector('.scroll-mount');
  if (mount) mount.style.setProperty('--unroll', `${Math.max(0, mount.getBoundingClientRect().width / 2 - 2)}px`);
  (window.requestAnimationFrame || window.setTimeout)(fitCalendar);
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[href="#/import?capacity=1"]');
  if (!link) return;
  const input = $('noticeText');
  if (!input.value.trim()) {
    input.value = '这周再接4小时的社团工作，留6小时休息，时间够吗？';
    input.dispatchEvent(new Event('input'));
  }
});
document.addEventListener('sixu:route', event => {
  if (event.detail !== 'calendar') { scrollRolled = true; coverPainted = false; return; }
  coverPainted = false; // paint the 山水 when the page is actually entered, even if it was redrawn off screen
  if (calendarResult) renderCalendar();
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
    markBackedUp();
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

// ---- 多人约时：匿名空闲码（后端 /api/v3/group/*）-------------------------------
// A code carries only the week, the slot size and a 0/1 free mask (hex), never a title, place or task.
const GROUP_SLOT = 30;
function maskCode(range, mask) {
  const padded = mask.padEnd(Math.ceil(mask.length / 4) * 4, '0');
  let hex = '';
  for (let i = 0; i < padded.length; i += 4) hex += parseInt(padded.slice(i, i + 4), 2).toString(16);
  return `SX1.${range.from}.${range.to}.${GROUP_SLOT}.${mask.length}.${hex}`;
}
function readMaskCode(code) {
  const parts = code.trim().split('.');
  if (parts.length !== 6 || parts[0] !== 'SX1' || !/^[0-9a-f]+$/i.test(parts[5])) throw new Error('这不是司序空闲码');
  const length = Number(parts[4]);
  const bits = [...parts[5]].map(digit => parseInt(digit, 16).toString(2).padStart(4, '0')).join('').slice(0, length);
  if (bits.length !== length) throw new Error('空闲码不完整');
  return { range: { from: parts[1], to: parts[2] }, slot: Number(parts[3]), mask: bits };
}
async function exportMask() {
  const range = weekRange(weekStart(Date.now()));
  const live = { ...snapshot, reference_time: new Date(Math.max(Date.parse(snapshot.reference_time), Date.parse(currentMinuteISO()))).toISOString() };
  const result = await request('/api/v3/group/export-mask', { snapshot: live, range, slot_minutes: GROUP_SLOT }, apiBase, 30000);
  groupMask = { code: maskCode(range, result.free_mask), mask: result.free_mask, range };
  $('groupMine').value = groupMask.code;
  return groupMask;
}
$('groupExport').addEventListener('click', async () => {
  try { await exportMask(); tell('已生成本周空闲码，复制发给要约的同学。'); }
  catch (error) { tell(`没能生成空闲码：${error.message}`, 'error'); }
});
$('groupCopy').addEventListener('click', async () => {
  if (!$('groupMine').value) return tell('先生成空闲码。', 'warning');
  try { await navigator.clipboard.writeText($('groupMine').value); tell('空闲码已复制。'); }
  catch { $('groupMine').select(); tell('请用快捷键复制选中的空闲码。', 'warning'); }
});
$('groupFind').addEventListener('click', async () => {
  const box = $('groupResult');
  try {
    const mine = groupMask || await exportMask();
    const others = $('groupOthers').value.split(/\n+/).map(line => line.trim()).filter(Boolean).map(readMaskCode);
    if (!others.length) throw new Error('先贴上至少一位同学的空闲码');
    if (others.some(other => other.range.from !== mine.range.from || other.slot !== GROUP_SLOT || other.mask.length !== mine.mask.length)) throw new Error('有的空闲码不是同一周生成的，请大家都生成本周的码');
    // Slots already past are nobody's free time: blank them in every code before ranking.
    const past = Math.max(0, Math.ceil((Date.now() - Date.parse(`${mine.range.from}T00:00:00+08:00`)) / (GROUP_SLOT * 60000)));
    const ahead = mask => '0'.repeat(Math.min(past, mask.length)) + mask.slice(past);
    const participants = [{ label: '我', free_mask: ahead(mine.mask) }, ...others.map((other, index) => ({ label: `同学${index + 1}`, free_mask: ahead(other.mask) }))];
    const result = await request('/api/v3/group/coordinate', { range: mine.range, slot_minutes: GROUP_SLOT, duration_minutes: Number($('groupDuration').value), top_k: 20, participants }, apiBase, 30000);
    // The code covers the whole week; only slots still ahead are worth proposing.
    const upcoming = result.recommended_slots.filter(slot => Date.parse(slot.start) > Date.now()).slice(0, 3);
    const rows = upcoming.map(slot => `<li><b>${readable(slot.start)}–${readable(slot.end).split(' ')[1]}</b><span>${slot.available_count}/${result.participant_count} 人有空${slot.conflict_count ? `，${slot.conflict_count} 人撞了` : ''}</span></li>`).join('');
    box.innerHTML = rows ? `<p class="group-head">${result.participant_count} 人的共同空档（只比对空闲码）</p><ol class="group-slots">${rows}</ol>` : '<p>这一周找不到够长的共同空档，可以缩短时长再试。</p>';
  } catch (error) { box.innerHTML = `<p class="field-error">${escapeHTML(error.message)}</p>`; }
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
  tell('已载入示例一周（下周，从下周一7:00开始安排）：讲座撞上高数是一处叠墨，讲座报名没填用时，只标截止，周六和朋友去公园是一笔约定。想按真实时间安排，可在“铺纸”页点“使用当前时间”。');
  window.SixuRouter?.go('calendar');
});
// 路演案例 (the case in the design report and the deck): a fictional 摄影社 notice for next week's Wednesday.
// Only 铺纸 is prepared and the notice is put in the box; the presenter still sends it, adds the estimate and
// applies the strategy. Planning starts that Wednesday 13:30 (the 铺纸 "开始安排时刻"), so the same numbers come
// out on any day: 说明会 14:30–15:30 overlaps 专业课 14:00–15:00 by 30 minutes; 报名表 (30 minutes) sits at
// 15:30–16:00, and 15:00–15:30 once the 说明会 is dropped.
function photoClubCase(now) {
  const monday = weekStart(now) + 7 * DAY;
  const wednesday = localDate(monday + 2 * DAY);
  const [year, month, date] = wednesday.split('-').map(Number);
  const day = `${year}年${month}月${date}日`;
  const notice = `【摄影社招新通知】\n${day}14:30-15:30举行摄影社招新说明会（学活204）。\n${day}18:00前提交社团报名表。`;
  const window = DEFAULT_WINDOW.map((span, index) => index === 2 ? { start: '14:00', end: '18:00' } : span);
  let next = createTimeSnapshot({ referenceTime: `${wednesday}T13:30:00+08:00` });
  next = setDailyWindow(next, window);
  const from = localDate(monday - 77 * DAY);
  next = addRoutine(next, { title: '专业课', weekdays: [3], start: '14:00', end: '15:00', from, location: '新闻楼402' });
  next = addRoutine(next, { title: '高等数学', weekdays: [1, 4], start: '08:00', end: '09:50', from, location: '主楼301' });
  next = addRoutine(next, { title: '大学英语', weekdays: [2, 5], start: '10:10', end: '12:00', from, location: '外语楼204' });
  next = addRoutine(next, { title: '社团例会', weekdays: [4], start: '19:00', end: '20:00', from, location: '学活204' });
  next = setRoutinesConfirmed(next, true);
  return { snapshot: next, notice, monday, wednesday };
}
$('loadPhotoCase').addEventListener('click', () => {
  const hasData = snapshot.events.length || snapshot.tasks.length || snapshot.routines.length;
  if (hasData && !window.confirm('载入路演案例会替换当前清单，请先导出要保留的内容。是否继续？')) return;
  const prepared = photoClubCase(Date.now());
  calendarWeek = prepared.monday;
  commit({ ...prepared.snapshot, revision: snapshot.revision + 1 }, { unlock: !externalConflict && !storageLocked });
  $('noticeText').value = prepared.notice;
  $('noticeDate').value = prepared.wednesday;
  tell('已铺好虚构课表与作息（下周三 14:00–18:00 留白，从 13:30 开始安排），招新通知已放进砚池，点发送即可导入。');
  $('noticeText').focus();
});

// ---- 司序链接：一个人做，全班点开即导入 ----------------------------------
const SHARE_LIMIT = 1500;
$('makeShareLink').addEventListener('click', async () => {
  const text = $('noticeText').value.trim();
  if (!text) return tell('先把通知粘进砚池，再做成链接。', 'warning');
  if ([...text].length > SHARE_LIMIT) return tell(`链接最多放${SHARE_LIMIT}字的通知，请删去无关内容后再做。`, 'warning');
  const link = `${location.origin}${location.pathname}#/import?from=link&text=${encodeURIComponent(text)}`;
  const firstLine = text.split('\n').find(line => line.trim())?.trim().slice(0, 30) || '通知';
  const message = `【司序】${firstLine}\n点开即可把这条通知排进你的一周：\n${link}`;
  try { await navigator.clipboard.writeText(message); tell('司序链接已复制，粘贴到群里即可；同学点开后核对再导入。'); }
  catch { window.prompt('复制下面这段发到群里：', message); }
});

// ---- 备份提醒：清单只在这个浏览器里 ----------------------------------------
const BACKUP_KEY = 'sixu.backup';
function backupState() { return { at: 0, revision: -1, snoozed: '', ...readJSON(BACKUP_KEY, {}) }; }
function markBackedUp() { writeJSON(BACKUP_KEY, { ...backupState(), at: Date.now(), revision: snapshot.revision }); $('backupNudge').hidden = true; }
function checkBackup() {
  const state = backupState();
  const items = snapshot.tasks.length + snapshot.events.length + snapshot.routines.length;
  const today = localDate(Date.now());
  const stale = !state.at || (Date.now() - state.at > 7 * DAY && snapshot.revision !== state.revision);
  $('backupNudge').hidden = !(items >= 3 && stale && state.snoozed !== today && !storageLocked);
}
$('backupNow').addEventListener('click', () => $('exportSnapshot').click());
$('backupLater').addEventListener('click', () => { writeJSON(BACKUP_KEY, { ...backupState(), snoozed: localDate(Date.now()) }); $('backupNudge').hidden = true; });

// ---- 提醒 ---------------------------------------------------------------
// While the page is open, a reminder pops up `lead` minutes before each 截止 and each 点墨 / 约定
// start (a system notification when allowed, the page's toast always). A web page cannot wake up
// once closed, so 加到手机日历 writes the same reminders as calendar alarms the phone keeps.
const REMIND_KEY = 'sixu.remind';
const FIRED_KEY = 'sixu.remind.fired';
const readJSON = (key, fallback) => { try { return JSON.parse(storage?.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
const writeJSON = (key, value) => { try { storage?.setItem(key, JSON.stringify(value)); } catch { /* kept for this visit */ } };
const remind = { on: false, lead: 30, ...readJSON(REMIND_KEY, {}) };
if (!LEADS.includes(remind.lead)) remind.lead = 30;
const fired = new Set(readJSON(FIRED_KEY, []));
let swRegistration = null;
const remindBar = document.createElement('div');
remindBar.className = 'cal-remind';
const bell = createBellToggle({ offLabel: '提醒我', onLabel: '已开启提醒', label: '截止和点墨开始前提醒我', defaultPressed: remind.on, onChange: toggleRemind });
const leadPick = document.createElement('select');
leadPick.setAttribute('aria-label', '提前多久提醒');
leadPick.innerHTML = LEADS.map(minutes => `<option value="${minutes}">提前${minutes === 60 ? '1小时' : `${minutes}分钟`}</option>`).join('');
leadPick.value = String(remind.lead);
leadPick.addEventListener('change', () => { remind.lead = Number(leadPick.value); writeJSON(REMIND_KEY, remind); remindTick(); });
const icsButton = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: '加到手机日历' });
icsButton.addEventListener('click', downloadCalendar);
const remindNote = Object.assign(document.createElement('p'), { className: 'cal-remind-note', textContent: '页面开着时到点弹出提醒；关掉页面也要提醒，就“加到手机日历”，由手机日历按同样的提前量响铃。' });
remindBar.append(bell.element, leadPick, icsButton, remindNote);

async function toggleRemind(on) {
  remind.on = on;
  writeJSON(REMIND_KEY, remind);
  if (!on) { tell('已关闭提醒。'); return; }
  if ('Notification' in window && window.Notification.permission === 'default') {
    try { await window.Notification.requestPermission(); } catch { /* falls back to the toast */ }
  }
  const allowed = 'Notification' in window && window.Notification.permission === 'granted';
  tell(allowed ? `已开启：截止和点墨开始前${remind.lead === 60 ? '1小时' : `${remind.lead}分钟`}提醒。` : '浏览器没有允许通知，页面开着时会用提示条提醒；也可以“加到手机日历”。', allowed ? '' : 'warning');
  remindTick();
}
function showReminder(reminder) {
  const { title, body } = reminderText(reminder);
  tell(`${title}（${body}）`, 'warning');
  if (!('Notification' in window) || window.Notification.permission !== 'granted') return;
  const options = { body, tag: reminder.key, icon: './assets/icon-192.png', badge: './assets/icon-192.png', data: { url: './#/calendar' } };
  try {
    if (swRegistration) swRegistration.showNotification(title, options);
    else new window.Notification(title, options);
  } catch { /* the toast already showed it */ }
}
function remindTick() {
  const now = Date.now();
  bell.setCount(upcomingCount(snapshot, now));
  if (!remind.on) return;
  const due = dueReminders(snapshot, { now, lead: remind.lead, fired });
  if (!due.length) return;
  for (const reminder of due) { fired.add(reminder.key); showReminder(reminder); }
  writeJSON(FIRED_KEY, [...fired].slice(-300));
}
function downloadCalendar() {
  const { text, count } = icsCalendar(snapshot, { now: Date.now(), lead: remind.lead });
  if (!count) return tell('接下来60天里没有截止或点墨，暂时不用加。', 'warning');
  const url = window.URL.createObjectURL(new window.Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: '司序-截止与点墨.ics' });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 10000);
  tell(`已生成 ${count} 项（各带提前${remind.lead === 60 ? '1小时' : `${remind.lead}分钟`}的闹钟）。打开这个文件，选“全部添加”到手机日历。`);
}
window.setInterval(remindTick, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') remindTick(); });

// ---- 外面送进来的通知：快捷指令（#/import?text=…）与系统分享（sw.js 暂存） ----
$('shortcutUrl').textContent = `${location.origin}${location.pathname}#/import?text=`;
function takeHashText() {
  const [route, query] = location.hash.slice(2).split('?');
  if (route !== 'import' || !query) return;
  const params = new URLSearchParams(query);
  const text = params.get('text');
  history.replaceState(null, '', `${location.pathname}${location.search}#/import`);
  if (text && text.trim()) {
    appendNotice(text.trim().slice(0, 100000));
    tell(params.get('from') === 'link' ? '已从司序链接收到一条通知，核对后点“导入”。' : '已收到快捷指令送来的通知，核对后点“导入”。');
  }
  if (params.get('shared')) takeShared();
}
async function takeShared() {
  if (!('caches' in window)) return;
  try {
    const cache = await window.caches.open('sixu-share');
    const meta = await cache.match('share/meta');
    if (!meta) return;
    const { text, count } = await meta.json();
    const files = [];
    for (let index = 0; index < count; index += 1) {
      const response = await cache.match(`share/file-${index}`);
      if (response) { const blob = await response.blob(); files.push(new window.File([blob], `shared-${index}`, { type: blob.type })); }
    }
    await window.caches.delete('sixu-share');
    if (text && text.trim()) appendNotice(text.trim());
    if (files.length) await recognizeMany(files);
    else if (text) tell('已收到分享来的文字，核对后点“导入”。');
  } catch { tell('没能读取分享来的内容，请再分享一次或直接粘贴。', 'warning'); }
}
window.addEventListener('hashchange', takeHashText);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('./sw.js').then(registration => { swRegistration = registration; }).catch(() => { /* reminders still use the toast */ });
}

renderAll();
takeHashText();
remindTick();
checkBackup();
if (recovered.error) tell(`本地清单未能读取：${recovered.error}。为保护原数据，当前修改暂不覆盖保存；请导入备份或明确清空后重建。`, 'warning');
else if (recovered.migrated) { tell('已把旧版清单转换成四层时间格式；旧数据仍保留在浏览器中，没有删除。'); save(); }
if (location.protocol === 'file:') tell('请通过本地HTTP服务打开此页面，直接打开文件无法完整加载编辑模块。', 'warning');
$('timetableText').value ||= '';
$('periodText').value = DEFAULT_PERIODS;
scheduleCalendar();
