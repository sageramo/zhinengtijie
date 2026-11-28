import { isTimestamp } from './task-state.js';
import { SnapshotStore } from './snapshot-store.js';
import {
  TIME_STORAGE_KEY, ESTIMATE_PRESETS, createTimeSnapshot, serializeTimeSnapshot, parseTimeSnapshot, readTimeSnapshot,
  addImported, updateTask, updateEvent, addTask, addEvent, removeItem, setDailyWindow, addRoutine,
  addAdjustment, addTimetable, setReferenceTime, setRoutinesConfirmed, skipRoutineDate, isPersonal, personalDay, addPersonalTask, setPersonalDay, setTaskDeadline,
} from './time-state.js';
import { agendaReply, hasPersonalClock, isConversation, parseActivities } from './agenda.js';
import { calendarMarkup, conflictKey, conflictsInWeek, digestChanges, minutesLabel, resultDigest, weekStart, weekRange } from './calendar.js';
import { xieyiShanshuiMarkup } from './shanshui.js';
import { LEADS, dueReminders, icsCalendar, reminderText, upcomingCount } from './reminders.js';
import { createBellToggle } from './bell-toggle.js';
import { readMemory, writeMemory, recordActual, suggestEstimate, readCalibration, writeCalibration, recordCalibration, calibrationFor } from './estimate-memory.js';
import { createRecognizer, imageProblem } from './screenshot-ocr.js';
import { parseChatAction, findTask, starterReply, nextChips, planCardMarkup, proposalCardMarkup, PROPOSAL_KIND_LABEL } from './chat-actions.js';
import { readFocus, writeFocus, pruneStates, setMark, setCommonWindows, addStates, removeState, parseStateSentence, draftLabel, previewRequest, confirmRequest, replanRange, lockedRests, daySegments, bandMarkup, ribbonMarkup, bandUsed, bandLegend, todayStateMarkup, replanMarkup, spanText, dayLabel, isoAt } from './focus.js';
import { parseJwTimetable, termStartFrom } from './jw-timetable.js';
import { checkPersistentStorage, isVaultCode, openVault, requestPersistentStorage, sealVault, supportsLocalFileSync, writeLocalBackupFile } from './vault.js';
import { addGoal, addNote, addTimeLog, inferSlotFromText, itemTier, ledgerMarkup, markNotePromoted, migrateLegacyNotes, normalizeXieyiState, periodKeyFor, readXieyi, removeGoal, removeNote, removeTaskSlot, removeTimeLog, setGoalTab, setScrollMode, setTaskSlot, SLOT_NAMES, toggleGoal, toggleNote, weekDayItems, weeklyLedgerBrief, writeXieyi, xieyiBoardMarkup } from './xieyi-scroll.js';
import { COMPANION_PRESETS, companionMarkup, companionWhisper, createSoundscape, formatClock, resolveScene, sceneMix, suggestGapSession } from './companion.js';

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
const COVER_DAY_KEY = 'sixu.cover.seenDay';
const TIER_LABEL = { timed: '定时', deadline: '定期限', day: '定日', pending: '待定' };
const isPhoneViewport = () => typeof window !== 'undefined' && window.innerWidth <= 760;
const hasSeenCoverToday = () => {
  try { return storage?.getItem(COVER_DAY_KEY) === localDate(Date.now()); } catch { return false; }
};
const initialCoverRolled = () => !isPhoneViewport() && !hasSeenCoverToday();
let rolledByMode = { gongbi: initialCoverRolled(), xieyi: initialCoverRolled() };
const isScrollRolled = () => rolledByMode[xieyiState.mode];
let openLogDate = '';
let scrollFlipDir = '';
let calendarAnalyzed = false; // 画卷 defaults to full-width solo view; click 解析 to open the left analysis panel
let calendarListView = false; // Phones default to the WakeUp-style 7-column week grid; toggle for agenda list
let focusSettings = pruneStates(readFocus(storage), Date.now()); // 专注时段、精力状态与任务标记 (focus.js), this browser only
let replanState = null; // the 重排卡: { loading, draft } | { error } | { preview, draft, body, range, revision, chosen } | { applied, label, starter }
let replanClock = null; // the 5-minute start: { left, timer }
let flipFrom = null; // work-block rectangles before a replan, so the blocks glide to their new places
let coverPaintedByMode = { gongbi: false, xieyi: false }; // the 山水 brushes in once per cover, not on every recalculation
let unrollTimer = null;
let parseSequence = 0;
let lastTaskId = null;
// The days a 专注时段 question was just asked about ({weekday, weekend}); the next sentence is read as its answer.
let focusAsk = null;
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

// ---- The header floats over the page: pages leave room for it (--hdr-h), and it tucks away while the
// user scrolls down, coming back on scrolling up, on pointing at the top edge, on focus, or from its handle.
const siteHeader = document.querySelector('[data-app] .site-header');
if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--hdr-h', `${siteHeader.offsetHeight}px`);
  });
  observer.observe(siteHeader);
}
{
  let lastY = window.scrollY;
  const tuck = on => { siteHeader.classList.toggle('is-tucked', on); $('hdrHandle').hidden = !on; };
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y < 48 || y < lastY - 6) tuck(false);
    else if (y > lastY + 6 && !siteHeader.contains(document.activeElement)) tuck(true);
    lastY = y;
  }, { passive: true });
  document.addEventListener('pointermove', event => { if (event.pointerType === 'mouse' && event.clientY < 40) tuck(false); }, { passive: true });
  siteHeader.addEventListener('focusin', () => tuck(false));
  $('hdrHandle').addEventListener('click', () => { tuck(false); siteHeader.querySelector('[aria-current="page"], a')?.focus({ preventScroll: true }); });
}
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
  if (face) {
    openRoll(face.dataset.rollOpen);
    $(face.getAttribute('aria-controls')).querySelector('[data-roll-close]').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    return;
  }
  const back = event.target.closest('[data-roll-close]');
  if (back) {
    const roll = back.closest('[data-roll]');
    closeRolls(roll.closest('[data-rolls]'));
    roll.querySelector('[data-roll-open]').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }
});
function renderRollFaces() {
  const set = (key, lines) => {
    const el = $(`rollSummary-${key}`);
    if (el) el.innerHTML = lines.filter(Boolean).map(line => `<span>${line}</span>`).join('');
  };
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

let autoBackupHandle = null;
let persistRequestedOnce = false;
let xieyiState = readXieyi(storage);
function syncLegacyXieyiNotes() {
  const res = migrateLegacyNotes(xieyiState, snapshot, addPersonalTask, updateTask);
  if (!res.migrated) return;
  xieyiState = res.xieyi;
  writeXieyi(storage, xieyiState);
  snapshot = res.snapshot;
  try { snapshotStore.save(snapshot); } catch { /* wait for commit */ }
}
syncLegacyXieyiNotes();
function commitXieyi(next) {
  xieyiState = normalizeXieyiState(next);
  writeXieyi(storage, xieyiState);
  renderCalendar();
}

async function refreshPersistLabel() {
  const box = $('persistStatus');
  if (!box) return;
  const status = await checkPersistentStorage();
  if (!status.supported) box.textContent = '浏览器防清理保护：当前浏览器未开放持久存储接口，建议定期复制加密恢复码。';
  else box.textContent = status.persisted ? '浏览器防清理保护：已开启（浏览器不会轻易自动清空本地清单）。' : '浏览器防清理保护：未授权，可点击上方按钮申请；若手动清理缓存仍需加密恢复码还原。';
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
  if (!saved.saved) {
    $('saveState').title = saved.error;
    return;
  }
  if (!persistRequestedOnce && (snapshot.tasks.length + snapshot.events.length + snapshot.routines.length > 0)) {
    persistRequestedOnce = true;
    requestPersistentStorage().then(refreshPersistLabel).catch(() => {});
  }
  if (autoBackupHandle && saved.raw) {
    writeLocalBackupFile(autoBackupHandle, saved.raw).then(written => {
      const box = $('autoBackupStatus');
      if (!box) return;
      if (written.ok) {
        const clock = new Date(Date.now() + OFFSET).toISOString().slice(11, 16);
        box.textContent = `本地自动双写：已同步到 ${autoBackupHandle.name || '本地备份文件'}（${clock}）。`;
        markBackedUp();
      } else {
        box.textContent = `本地自动双写未成功（${written.error}），清单仍安全保存在浏览器中。`;
      }
    });
  }
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
    const nowISO = currentMinuteISO();
    const live = Math.max(Date.parse(snapshot.reference_time), Date.parse(nowISO));
    const current = { ...snapshot, reference_time: new Date(live).toISOString() };
    const result = await request('/api/v3/calendar', { snapshot: current, range: weekRange(shownWeek()), now: nowISO }, base);
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
  const nowMs = Date.now();
  const refMs = Date.parse(snapshot.reference_time);
  const futureRef = Number.isFinite(refMs) && refMs - nowMs > 5 * 60000 ? readable(snapshot.reference_time) : '';
  // The 重排卡 shows while a choice waits; after one is taken it stays only as long as it can be undone.
  if (replanState?.applied && !strategyUndo?.replan) replanState = null;
  const pending = replanState && !replanState.applied ? replanState.draft : null;
  const showBand = bandUsed(focusSettings, snapshot, pending);
  const card = { ...replanState, timer: replanClock?.left || 0 };
  const waiting = Boolean(replanState?.preview && (replanState.preview.needs_decision || replanState.preview.status === 'infeasible'));
  const rolled = isScrollRolled();
  const isXieyi = xieyiState.mode === 'xieyi';
  const startMs = shownWeek();
  const xieyiWeek = isXieyi ? weekDayItems(snapshot, xieyiState, startMs) : null;
  const xieyiCount = xieyiWeek ? Array.from(xieyiWeek.byDay.values()).reduce((sum, map) => {
    let daySum = 0;
    for (const list of map.values()) daySum += list.length;
    return sum + daySum;
  }, 0) : 0;
  const xieyiGoalsInWeek = (xieyiState.goals || []).filter(g => g.horizon === 'week' && g.periodKey === periodKeyFor('week', startMs));
  const xieyiPainting = isXieyi ? xieyiShanshuiMarkup({ state: xieyiState, snapshot, start: startMs, now: nowMs, id: rolled ? 'ss-xy-cover' : 'ss-xy-board', weekGoals: xieyiGoalsInWeek.map(g => g.title) }) : '';
  const xieyiCoverMeta = [xieyiGoalsInWeek.length ? `${xieyiGoalsInWeek.length} 条周志` : '', xieyiCount ? `${xieyiCount} 笔定日` : ''].filter(Boolean).join(' · ');
  $('calendarView').innerHTML = calendarMarkup({ result: calendarResult, start: startMs, now: nowMs, loading: calendarLoading && !calendarResult, error: calendarError, undo: strategyUndo?.replan ? '' : strategyUndo?.label || '', note: strategyUndo?.note || '', changes: strategyUndo?.changes || [], focus: calendarFocus, plans: solveState, weighs, rolled, unrolling: Boolean(unrollTimer), fresh: !coverPaintedByMode[xieyiState.mode], analyzed: calendarAnalyzed, futureRef, listView: calendarListView,
    scrollMode: xieyiState.mode,
    xieyiBoard: isXieyi ? xieyiBoardMarkup({ state: xieyiState, result: calendarResult, start: startMs, now: nowMs, snapshot, openLogDate }) : '',
    xieyiPainting,
    xieyiCoverMeta,
    weekLedgerBrief: weeklyLedgerBrief(xieyiState, startMs),
    band: showBand ? (dayStart, first, last) => bandMarkup(focusSettings, snapshot, dayStart, first, last, pending) : null,
    ribbon: showBand ? (dayStart, first, last) => ribbonMarkup(focusSettings, snapshot, dayStart, first, last, pending) : null,
    energy: showBand ? Array.from({ length: 7 }, (_, index) => daySegments(focusSettings, snapshot, startMs + index * DAY, pending)).flat() : [],
    bandLegend: showBand ? bandLegend(focusSettings, snapshot, pending) : '',
    banner: replanState ? replanMarkup(card, 'board') : '',
    sideTop: replanState ? replanMarkup(card, 'side') : '',
    sideToday: todayStateMarkup(focusSettings, snapshot, nowMs, pending),
    alertLabel: waiting ? '1 个取舍' : '' });
  if (scrollFlipDir) {
    const mount = $('calendarView').querySelector('.scroll-mount, .scroll-cover');
    if (mount) {
      mount.classList.remove('is-flip-next', 'is-flip-prev');
      void mount.offsetWidth;
      mount.classList.add(scrollFlipDir);
    }
    scrollFlipDir = '';
  }
  window.SixuRouter?.refreshArrows?.();
  if (rolled && (calendarResult || isXieyi)) coverPaintedByMode[xieyiState.mode] = true;
  $('calendarView').querySelector('.cal-remind-slot')?.append(remindBar);
  fitCalendar();
  if (flipFrom && calendarResult && !calendarLoading) glideBlocks();
}
/** Moved work blocks glide from where they were to where the chosen plan put them. */
function workRects() {
  const seen = {};
  const rects = {};
  for (const block of $('calendarView').querySelectorAll('.cal-block.cal-work')) {
    const id = block.dataset.calItem;
    seen[id] = (seen[id] || 0) + 1;
    rects[`${id}#${seen[id]}`] = block.getBoundingClientRect();
  }
  return rects;
}
function glideBlocks() {
  const before = flipFrom;
  flipFrom = null;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const seen = {};
  for (const block of $('calendarView').querySelectorAll('.cal-block.cal-work')) {
    const id = block.dataset.calItem;
    seen[id] = (seen[id] || 0) + 1;
    const old = before[`${id}#${seen[id]}`];
    if (!old) continue;
    const now = block.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
    block.classList.add('is-gliding');
    block.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.7,.2,1)' })
      .finished.then(() => block.classList.remove('is-gliding'), () => {});
  }
}
/** Size the hour rows so the whole week fits the window below the week header (desktop and phone grid). */
function fitCalendar() {
  const week = $('calendarView').querySelector('.cal-week');
  if (!week || document.documentElement.dataset.current !== 'calendar') return;
  const phone = isPhoneViewport();
  if (phone && calendarListView) return;
  const rows = Number(week.style.getPropertyValue('--rows')) || 14;
  const head = week.querySelector('.cal-head-day')?.getBoundingClientRect().height || 0;
  const top = week.getBoundingClientRect().top + window.scrollY;
  const mount = week.closest('.scroll-mount');
  const below = mount ? parseFloat(window.getComputedStyle(mount).borderBottomWidth) || 0 : 0;
  const pad = phone ? 18 : 44;
  // Readable rows first: an hour is tall enough for a block's name, time and place; the page scrolls.
  const minRow = phone ? 42 : 56;
  const maxRow = phone ? 50 : 68;
  const row = Math.max(minRow, Math.min(maxRow, Math.floor((window.innerHeight - top - head - below - pad) / rows)));
  week.style.setProperty('--row', `${row}px`);
  $('calendarView').style.setProperty('--cal-fit-height', `${Math.max(240, row * rows + head)}px`);
  const side = $('calendarView').querySelector('.scroll-side');
  if (side && !phone) side.style.maxHeight = `${Math.ceil((mount || week).getBoundingClientRect().height) + 2}px`;
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
  const itemsCountEl = $('itemsCount');
  if (itemsCountEl) itemsCountEl.textContent = count ? String(count) : '';
  const pillCountEl = $('itemsPillCount');
  if (pillCountEl) pillCountEl.textContent = count ? ` · ${count}待书` : '';
  const summaryNote = $('itemsSummaryNote');
  if (summaryNote) {
    const activeTasks = snapshot.tasks.filter(t => t.status === 'active').length;
    const activeEvents = snapshot.events.filter(e => e.status === 'active').length;
    summaryNote.textContent = (activeTasks + activeEvents) > 0
      ? `落笔 ${activeTasks} 件 · 点墨 ${activeEvents} 处`
      : '查看与管理导入事项';
  }
  const weekClashCount = calendarResult ? conflictsInWeek(calendarResult.conflicts, shownWeek()).length : 0;
  $('conflictCount').textContent = weekClashCount ? String(weekClashCount) : '';
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
  const tier = itemTier(task, 'task');
  const slot = xieyiState.slots?.[task.id] || inferSlotFromText(task.title);
  const slotLabel = tier === 'day' ? `定日 · ${SLOT_NAMES[slot] || '晡'}` : TIER_LABEL[tier];
  const slotField = tier === 'day' ? `<label>时段<select data-field="xieyi_slot"><option value="chen"${slot === 'chen' ? ' selected' : ''}>晨 · 上午</option><option value="wu"${slot === 'wu' ? ' selected' : ''}>午 · 中午</option><option value="bu"${slot === 'bu' ? ' selected' : ''}>晡 · 下午</option><option value="mu"${slot === 'mu' ? ' selected' : ''}>暮 · 晚间</option></select></label>` : '';
  return `<article class="item-card is-${kind[0]}${active ? '' : ' is-inactive'}" data-item-id="${escapeHTML(task.id)}" data-kind="task" data-tier="${tier}" id="item-${escapeHTML(task.id)}">
    <div class="item-top"><i class="item-glyph" aria-hidden="true"></i><span class="item-kind">${kind[1]}</span><div class="item-heading"><input class="item-title" data-field="title" value="${escapeHTML(task.title)}" aria-label="工作名称" maxlength="200"><div class="item-meta-row"><span class="pool-tier-badge is-${tier}">${escapeHTML(slotLabel)}</span><p class="item-meta" data-item-meta>${escapeHTML(itemMeta(task))}</p></div></div>${stateBadge(taskState(task))}</div>
    <details class="item-edit"${editorOpen(task) ? ' open' : ''}><summary>修改${isPersonal(task) && !hasPersonalClock(task) ? '日期' : '截止'}、用时与拆分</summary>
    <div class="field-grid">
      ${isPersonal(task) && !hasPersonalClock(task) ? `<label>哪天做<input type="date" data-field="personal_day" value="${personalDay(task)}"></label>` : `<label>截止<input type="datetime-local" data-field="deadline_at" value="${toLocalInput(task.deadline_at)}"></label>`}
      ${slotField}
      <label>预计用时（分钟）<input type="number" inputmode="numeric" min="1" max="20160" data-field="estimate_minutes" value="${task.estimate_minutes ?? ''}" placeholder="未填"></label>
      <div class="field-wide chips" role="group" aria-label="预计用时快捷选择">${chips}</div>
      <label>能否拆开做<select data-field="splittable"><option value="true"${task.splittable ? ' selected' : ''}>可以分几次做</option><option value="false"${task.splittable ? '' : ' selected'}>需要一次做完</option></select></label>
      <label>优先级 <span class="optional">可选，0–100</span><input type="number" inputmode="numeric" min="0" max="100" data-field="priority" value="${task.priority ?? ''}" placeholder="未填按50"></label>
      <div class="field-wide chips mark-chips" role="group" aria-label="这件事适合什么时候做（选填，计划被打断时用来重排）"><span class="chips-label">这件事<span class="optional">选填</span></span><button type="button" class="chip" data-mark="focus" aria-pressed="${focusSettings.marks[task.id] === 'focus'}">需要专注</button><button type="button" class="chip" data-mark="fragment" aria-pressed="${focusSettings.marks[task.id] === 'fragment'}">适合碎片时间</button></div>
    </div></details>
    ${evidenceMarkup(task)}
    ${active ? `<details class="item-edit task-starter"><summary>五分钟起步</summary>
      <form data-task-starter>
        <label>材料摘录 <span class="optional">选填</span><textarea name="material" rows="3" maxlength="6000" placeholder="粘贴作业要求、论文摘要或讨论记录"></textarea></label>
        <p class="field-help">材料仅随这次请求发给计算服务。</p>
        <button type="submit">生成起步卡</button>
        <p class="field-help" data-starter-feedback role="status"></p>
        <div data-starter-result hidden></div>
      </form>
    </details>` : ''}
    <div class="item-actions"><button type="button" data-action="complete">${task.status === 'completed' ? '恢复' : '完成了'}</button><button type="button" data-action="cancel">${task.status === 'cancelled' ? '恢复' : '不做了'}</button><button type="button" class="danger-text" data-action="delete">删除</button></div>
    <p class="field-error" data-item-error role="status"></p>
  </article>`;
}
function eventMarkup(event) {
  const appointment = event.kind === 'appointment';
  const tier = itemTier(event, 'event');
  return `<article class="item-card is-${appointment ? 'appointment' : 'temporary'}${event.status === 'active' ? '' : ' is-inactive'}" data-item-id="${escapeHTML(event.id)}" data-kind="event" data-tier="${tier}" id="item-${escapeHTML(event.id)}">
    <div class="item-top"><i class="item-glyph" aria-hidden="true"></i><span class="item-kind">${appointment ? '约定' : '点墨'}</span><div class="item-heading"><input class="item-title" data-field="title" value="${escapeHTML(event.title)}" aria-label="${appointment ? '约定' : '点墨'}名称" maxlength="200"><div class="item-meta-row"><span class="pool-tier-badge is-${tier}">${TIER_LABEL[tier]}</span><p class="item-meta" data-item-meta>${escapeHTML(itemMeta(event))}</p></div></div>${stateBadge(eventState(event))}</div>
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
  $('personalList').innerHTML = personal.length ? personal.map(taskMarkup).join('') : '<p class="empty-note">还没有个人任务。点“添加个人任务”，或在日课卷里随笔记下。</p>';
  $('taskList').innerHTML = deadlines.length ? deadlines.map(taskMarkup).join('') : '<p class="empty-note">还没有截止之事。导入通知或手动添加。</p>';
  for (const [id, list] of [['eventCount', points], ['appointmentCount', appointments], ['personalCount', personal], ['deadlineCount', deadlines]]) $(id).textContent = String(list.length);
  const sizes = { appointment: appointments.length, personal: personal.length, deadline: deadlines.length };
  for (const [key, size] of Object.entries(sizes)) document.querySelector(`[data-group-count="${key}"]`)?.replaceChildren(document.createTextNode(String(size)));
  spreadWorkGroup(workGroup || ['deadline', 'personal', 'appointment'].find(key => sizes[key]) || 'deadline');
}
/** Spread one 落笔 group open when strips exist; inside flat 笔墨 pool all groups stay legible. */
function spreadWorkGroup(key) {
  $('taskSection').dataset.active = key;
  for (const group of $('taskSection').querySelectorAll('[data-group]')) {
    const open = group.dataset.group === key;
    group.classList.toggle('is-spread', open);
    group.querySelector('.group-expand')?.setAttribute('aria-expanded', String(open));
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
function renderAll() { renderSources(); renderItems(); renderTime(); renderFocusSetup(); renderInkRail(); renderCalendar(); renderBadges(); }

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
  $('noticeDate').value = '';
  clearOcrPreview();
  // Like a chat: the composer stays put at the bottom, and the thread scrolls so this turn starts at the top.
  const turn = $('importSummary').previousElementSibling;
  (window.requestAnimationFrame || window.setTimeout)(() => turn?.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() }));
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
    $('noticeDate').value = pendingDiff.referenceDate || '';
    pendingDiff = null;
    $('noticeForm').requestSubmit ? $('noticeForm').requestSubmit() : $('noticeForm').dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  const chip = event.target.closest('[data-turn-estimate]');
  if (chip) {
    const [id, minutes] = chip.dataset.turnEstimate.split(':');
    if (!snapshot.tasks.some(task => task.id === id)) return tell('这件事已经不在清单里了。', 'warning');
    commit(updateTask(snapshot, id, { estimate_minutes: Number(minutes) }));
    const box = $('importSummary').querySelector('[data-turn-result]');
    if (box && lastImport) box.outerHTML = importResult(lastImport);
    else {
      const wrap = chip.closest('.turn-estimate');
      if (wrap) { wrap.classList.add('is-set'); wrap.innerHTML = `预计 ${minutesLabel(Number(minutes))}<small>画卷会在截止前的留白里排入</small>`; }
    }
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
    // One sentence does what the detail pages do: 起步卡, 专注时段, 任务标记, 点名完成与估时.
    const afterAsk = focusAsk;
    focusAsk = null;
    let action = mode === 'chat' ? null : parseChatAction(text, { afterAsk });
    // An answer that only counts as one because of the question (no 平时/经常…) still yields to a task it names.
    if (action?.kind === 'focus-window' && action.byContext && findTask(snapshot, text).byName) action = null;
    if (action && await runChatAction(text, action)) return;
    // "下午四点半到五点半想歇会儿" / "三点到四点临时要帮辅导员搬东西" / "有点累": a change to the plan, not an item.
    const draft = mode === 'chat' ? null : parseStateSentence(text, Date.now());
    if (draft) {
      if (draft.missing) { showTurn(text, replyMarkup({ text: `这次打断大概${draft.missing}？比如说「3点到4点半临时开会」，我好算要挪哪些事。` })); return; }
      $('parseStep').textContent = '正在按你说的重算这一周';
      const state = await startReplan(draft);
      if (!stillCurrent()) return;
      agendaWeek = weekStart(Date.parse(draft.disruption?.start_at || draft.rest?.start || draft.state?.start_at || '') || Date.now());
      showTurn(text, stateReply(draft, state));
      return;
    }
    // 排不排得开: two or more activities with lengths go to the backend's planner (capacity_plan_v1).
    const asked = mode === 'chat' ? null : parseActivities(text);
    if (asked) {
      const service = await ensureHealth(base);
      if (service.capabilities.includes('capacity_plan_v1')) {
        $('parseStep').textContent = '正在试算这几件事排不排得开';
        const body = { snapshot, now: planNow(), scope: asked.scope, activities: asked.activities, reserve_rest_minutes: asked.reserve_rest_minutes };
        if (asked.scope === 'weekday') Object.assign(body, { weekday_index: asked.weekdayIndex, weekday_next: asked.weekdayNext });
        const plan = await request('/api/v3/capacity/plan', body, base);
        if (!stillCurrent()) return;
        agendaWeek = plan.scope?.from ? weekStart(Date.parse(plan.scope.from)) : null;
        showTurn(text, `<p>${escapeHTML(plan.summary || '')}</p>${planCardMarkup(plan, keepPlan(plan))}`);
        return;
      }
    }
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
      // With agenda_chat_tools_v1 the model may check the list itself (the list never reaches the model).
      const tools = service.capabilities.includes('agenda_chat_tools_v1');
      const result = await modelRequest('/api/v3/chat', { mode: 'model', messages, ...(tools ? { snapshot, now: planNow() } : {}) }, base, 90000);
      if (!stillCurrent()) return;
      chatHistory.splice(0, chatHistory.length, ...messages.slice(-7), { role: 'assistant', text: result.reply });
      const extras = [
        result.capacity ? planCardMarkup(result.capacity, keepPlan(result.capacity)) : '',
        result.proposal ? proposalCardMarkup(result.proposal, keepProposal(result.proposal)) : '',
      ].filter(Boolean).join('');
      reply = { text: result.reply, ...(extras ? { extraHtml: extras } : {}) };
      if (result.capacity?.scope?.from) reply.week = weekStart(Date.parse(result.capacity.scope.from));
      else if (result.proposal?.week_anchor) reply.week = weekStart(Date.parse(`${result.proposal.week_anchor}T00:00:00+08:00`));
    }
    if (!reply && isConversation(text)) {
      reply = { text: '这句我还接不住。可以继续问本周空档，或一键交给模型深度理解。', extraHtml: escalateMarkup(text) };
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
        pendingDiff = { text, referenceDate, revision: snapshot.revision, result: diff };
        showTurn(text, diffMarkup(diff));
        return;
      }
    }
    skipDiffFor = '';
    $('parseStep').textContent = '正在整理事项与时间';
    const imported = await (mode === 'model' ? modelRequest : request)('/api/v3/extract', { text, reference_date: referenceDate, mode }, base, mode === 'model' ? 100000 : 30000);
    if (!stillCurrent()) return;
    if (!imported.tasks.length && !imported.events.length) {
      showTurn(text, replyMarkup({ text: '这句里暂时没有识别出事项。试试「提醒我今天写实验报告，30分钟」，也可以一键交给模型深度理解。', extraHtml: escalateMarkup(text) }));
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
    // If a demo button left reference_time pinned in the future, snap back to real now when the user adds
    // a real task whose deadline falls between now and that future reference_time.
    const nowMs = Date.now();
    const refMs = Date.parse(next.reference_time);
    const needsLiveClock = Number.isFinite(refMs) && refMs - nowMs > 5 * 60000
      && (imported.tasks.some(task => task.deadline_at && Date.parse(task.deadline_at) > nowMs && Date.parse(task.deadline_at) <= refMs)
        || imported.events.some(ev => ev.start_at && Date.parse(ev.start_at) > nowMs && Date.parse(ev.start_at) <= refMs));
    if (needsLiveClock) { next = setReferenceTime(next, currentMinuteISO()); calendarWeek = null; }
    for (const t of imported.tasks || []) {
      if (isPersonal(t) && !hasPersonalClock(t)) {
        const added = next.tasks.find(item => item.title === t.title && item.source_id === imported.source.id);
        if (added && !xieyiState.slots?.[added.id]) {
          xieyiState = normalizeXieyiState(setTaskSlot(xieyiState, added.id, inferSlotFromText(`${t.title} ${text}`)));
        }
      }
    }
    writeXieyi(storage, xieyiState);
    commit(next);
    const personal = imported.tasks.filter(isPersonal);
    lastTaskId = personal.length === 1 && imported.tasks.length === 1 && !imported.events.length ? personal[0].id : null;
    agendaWeek = null;
    const follow = lastTaskId && personal[0].estimate_minutes === null
      ? '<p>这件事大约要多久？可以直接回“30分钟”，做完也可以告诉我。</p>' : '';
    const first = imported.tasks.find(task => task.status === 'active');
    const nextSay = nextChips(first ? [`帮我开个头：${first.title}`, `${first.title}需要专注`, '这周还剩多少时间？'] : ['这周还剩多少时间？']);
    showTurn(text, importSummary(imported) + follow + (defaulted ? '<p class="field-help">先用默认作息（工作日 08:00–23:00，周末 09:00–23:00）。课表和作息可以在铺纸里补齐。</p>' : '') + endAskMarkup(imported) + nextSay);
    estimateEnds('rules', imported.source.text);
  } catch (error) {
    if (ticket === parseSequence) tell(`处理未完成：${error.message} 输入内容仍在。`, 'error');
  } finally {
    if (ticket === parseSequence) { busy($('parseNotice'), false, '发送', '正在处理…'); hideParseProgress(); }
  }
});
// ---- The 研墨 conversation: what was sent, and what 司序 added, newest last above the composer.
function archiveTurn() {
  const current = $('importSummary');
  if (!current.dataset.turn) return; // the box is hidden while a new send runs, so a flag says it holds a reply
  delete current.dataset.turn;
  const past = document.createElement('div');
  past.className = 'import-summary turn-agent is-past';
  past.innerHTML = current.innerHTML;
  past.querySelectorAll('.end-ask, .inline-links, .turn-estimate:not(.is-set), .turn-next, .turn-card-actions').forEach(node => node.remove());
  past.querySelector('[data-turn-result]')?.removeAttribute('data-turn-result');
  current.before(past);
}
function pushUserTurn(text) {
  const turn = document.createElement('div');
  turn.className = 'turn-user';
  turn.textContent = text;
  $('importSummary').before(turn);
}
// ---- 研墨的左栏：导入过的通知与说过的状态（清单里的东西，不是另一套会话） ----------------
function renderInkRail() {
  if (!$('railSources')) return;
  const sources = snapshot.sources.filter(source => source.kind !== 'timetable').slice().reverse().slice(0, 40);
  $('railSources').innerHTML = sources.length ? sources.map(source => {
    const count = [...snapshot.events, ...snapshot.tasks].filter(item => item.source_id === source.id).length;
    const first = source.text.split('\n').map(line => line.trim()).find(Boolean) || '（空白通知）';
    return `<li><details><summary><span>${escapeHTML(first.slice(0, 36))}</span><em>${count} 项${source.kind === 'synthetic' ? ' · 示例' : ''}</em></summary><pre>${escapeHTML(source.text)}</pre></details></li>`;
  }).join('') : '<li class="rail-empty">导入的通知会列在这里，随时回来核对原文。</li>';
  const now = Date.now();
  const states = focusSettings.states.filter(state => Date.parse(state.end_at) > now).map(state => ({ at: Date.parse(state.start_at), html: `<li><b>${state.level === 'low' ? '精力偏低' : '临时专注'} ${escapeHTML(dayLabel(Date.parse(state.start_at)))} ${spanText(Date.parse(state.start_at), Date.parse(state.end_at))}</b><span>“${escapeHTML(state.text)}”</span><button type="button" class="text-button" data-focus-state="${escapeHTML(state.id)}">删去</button></li>` }));
  const rests = lockedRests(snapshot).filter(rest => rest.end > now).map(rest => ({ at: rest.start, html: `<li><b>休息 ${escapeHTML(dayLabel(rest.start))} ${spanText(rest.start, rest.end)}</b><span>“${escapeHTML(rest.label)}” · 已写进留白</span></li>` }));
  const rows = [...states, ...rests].sort((a, b) => a.at - b.at).map(row => row.html).join('');
  $('railStates').innerHTML = rows || '<li class="rail-empty">说一句“下午四点半到五点半想歇会儿”或“有点累”，会记在这里。</li>';
}
$('railStates')?.addEventListener('click', event => {
  const button = event.target.closest('[data-focus-state]');
  if (button) saveFocus(removeState(focusSettings, button.dataset.focusState));
});
$('newThread')?.addEventListener('click', () => {
  for (const node of [...$('inkThread').children]) if (node.id !== 'importSummary') node.remove();
  const box = $('importSummary');
  box.hidden = true; box.innerHTML = ''; delete box.dataset.turn;
  chatHistory.splice(0); lastTaskId = null; pendingDiff = null;
  clearOcrPreview();
  setRail(false);
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
  $('noticeText').focus({ preventScroll: true });
  tell('已开始新对话。清单不变，之前导入的通知仍在左边。');
});
function setRail(open) {
  $('noticeSection').closest('.page-import')?.classList.toggle('is-rail-open', open);
  $('railOpen')?.setAttribute('aria-expanded', String(open));
}
$('railOpen')?.addEventListener('click', () => setRail(true));
$('railClose')?.addEventListener('click', () => setRail(false));

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
let ocrCurrentFile = null;
let ocrTextBefore = '';
const TIMETABLE_LIKE = /[一二三四五六日]{4,}|第\s*0*\d+\s*周|星期[一二三四五六日天]|第\s*\d+\s*[-—~至]\s*\d+\s*节/;
const ocrActions = Object.assign(document.createElement('div'), { className: 'ocr-actions', hidden: true });
const ocrAsVision = Object.assign(document.createElement('button'), { type: 'button', id: 'ocrAsVision', className: 'primary-button', hidden: true, textContent: '海报 / 复杂版面？用大模型识图' });
const ocrAsTimetable = Object.assign(document.createElement('button'), { type: 'button', id: 'ocrAsTimetable', hidden: true, textContent: '这是课表？改用课表截图识别' });
ocrActions.append(ocrAsVision, ocrAsTimetable);
$('ocrStatus').after(ocrActions);
function syncOcrActions() { ocrActions.hidden = ocrAsVision.hidden && ocrAsTimetable.hidden; }
function ocrStatus(message) { $('ocrStatus').textContent = message; }
function clearOcrPreview({ keepStatus = false } = {}) {
  ocrSequence += 1;
  ocrHandoff = null;
  ocrCurrentFile = null;
  ocrAsVision.hidden = true;
  ocrAsTimetable.hidden = true;
  syncOcrActions();
  if (ocrPreviewUrl) { window.URL.revokeObjectURL(ocrPreviewUrl); ocrPreviewUrl = null; }
  $('ocrPreviewImage')?.removeAttribute('src');
  if ($('ocrPreview')) $('ocrPreview').hidden = true;
  if ($('chooseNoticeImage')) $('chooseNoticeImage').disabled = false;
  if (!keepStatus) ocrStatus('');
}
$('clearOcrPreview')?.addEventListener('click', () => {
  clearOcrPreview();
  $('noticeText')?.focus({ preventScroll: true });
});
async function recognizeNotice(file) {
  const problem = imageProblem(file);
  if (problem) return ocrStatus(problem);
  const ticket = ++ocrSequence;
  ocrHandoff = null;
  ocrCurrentFile = file;
  ocrTextBefore = $('noticeText').value;
  ocrAsVision.hidden = false;
  ocrAsTimetable.hidden = true;
  syncOcrActions();
  if (ocrPreviewUrl) window.URL.revokeObjectURL(ocrPreviewUrl);
  ocrPreviewUrl = window.URL.createObjectURL(file);
  $('ocrPreviewImage').src = ocrPreviewUrl;
  $('ocrPreview').hidden = false;
  $('chooseNoticeImage').disabled = true;
  ocrStatus('正在本机识别截图… 若是海报或周历表，可直接点下方「用大模型识图」。');
  try {
    const text = await recognizeScreenshot(file, progress => { if (ticket === ocrSequence) ocrStatus(`正在本机识别截图… ${Math.round(progress * 100)}%`); });
    if (ticket !== ocrSequence) return;
    if (!text) return ocrStatus('没有识别出文字。可以点下方「用大模型识图」，或换一张更清晰的截图。');
    const box = $('noticeText');
    ocrHandoff = { file, textBefore: box.value };
    box.value = box.value.trim() ? `${box.value.trimEnd()}\n\n${text}` : text;
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
    ocrAsTimetable.hidden = false;
    syncOcrActions();
    ocrStatus(TIMETABLE_LIKE.test(text)
      ? '这张图像是一张课表。本机识别只能读一行行的通知文字，课表格子会被读乱；请点下面的按钮改用课表截图识别。'
      : '已把识别出的文字放进输入框。请对照截图核对；若海报排版复杂，可直接点下方「用大模型识图」。');
  } catch (error) {
    if (ticket === ocrSequence) ocrStatus(`未能识别这张截图（${error.message}）。可以改点下方「用大模型识图」或手动输入。`);
  } finally {
    if (ticket === ocrSequence) $('chooseNoticeImage').disabled = false;
  }
}
$('chooseNoticeImage').addEventListener('click', () => $('noticeImage').click());
ocrAsVision.addEventListener('click', async () => {
  const file = ocrCurrentFile || ocrHandoff?.file;
  if (!file || ocrAsVision.disabled) return;
  if (externalConflict) return tell('请先处理另一个标签页的清单变化。', 'warning');
  const restoreText = ocrHandoff ? ocrHandoff.textBefore : ocrTextBefore;
  ocrSequence += 1; // cancel any still-running local OCR
  $('chooseNoticeImage').disabled = false;
  busy(ocrAsVision, true, '海报 / 复杂版面？用大模型识图', '大模型正在识图…');
  showParseProgress('model');
  $('parseStep').textContent = '大模型正在识别海报版面与日期';
  const base = apiBase;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      throw new Error('请选择 PNG、JPG、WebP 或 GIF 格式的图片。');
    }
    const image = await imageToDataUrl(file);
    const service = await ensureHealth(base, { fresh: true });
    if (!service.capabilities.includes('notice_image_v1')) throw new Error('当前计算服务尚未启用海报大模型识图，请稍后再试。');
    if (!service.timetable_model?.configured) throw new Error('当前服务尚未配置视觉模型 Key。');
    const referenceDate = $('noticeDate').value || null;
    const imported = await modelRequest('/api/v3/extract', { mode: 'image', image, reference_date: referenceDate }, base, 100000);
    if (!imported.events.length && !imported.tasks.length) {
      showTurn('（上传了一张海报/通知截图）', replyMarkup({ text: imported.warnings?.join(' ') || '没有从图片里读出明确的日程或任务。' }));
      clearOcrPreview();
      return;
    }
    let next = addImported(snapshot, imported);
    const defaulted = !next.daily_window;
    if (defaulted) next = setDailyWindow(next, DEFAULT_WINDOW);
    commit(next);
    const firstDateIso = imported.events.find(e => e.start_at)?.start_at || imported.tasks.find(t => t.deadline_at)?.deadline_at;
    agendaWeek = firstDateIso ? weekStart(Date.parse(firstDateIso)) : null;
    lastTaskId = null;
    $('noticeText').value = restoreText;
    const first = imported.tasks.find(task => task.status === 'active');
    const nextSay = nextChips(first ? [`帮我开个头：${first.title}`, '这周还剩多少时间？'] : ['这周还剩多少时间？']);
    showTurn(`（大模型识图）${imported.source.text.split('\n')[0].slice(0, 48)}`, importSummary(imported) + (defaulted ? '<p class="field-help">先用默认作息（工作日 08:00–23:00，周末 09:00–23:00）。课表和作息可以在铺纸里补齐。</p>' : '') + endAskMarkup(imported) + nextSay);
    estimateEnds('rules', imported.source.text);
    tell(`大模型识图完成：已导入 ${imported.events.length} 项到场安排、${imported.tasks.length} 项截止任务，点「看画卷」即可查看。`);
  } catch (error) {
    tell(`大模型识图未完成：${error.message}`, 'error');
  } finally {
    busy(ocrAsVision, false, '海报 / 复杂版面？用大模型识图');
    hideParseProgress();
  }
});
ocrAsTimetable.addEventListener('click', () => {
  if (!ocrHandoff) return;
  const { file, textBefore } = ocrHandoff;
  clearOcrPreview({ keepStatus: true });
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
    if (input.dataset.field === 'xieyi_slot') {
      xieyiState = normalizeXieyiState(setTaskSlot(xieyiState, card.dataset.itemId, input.value || 'bu'));
      writeXieyi(storage, xieyiState);
      itemError(card, '');
      renderItems();
      renderCalendar();
      return;
    }
    const beforeTier = card.dataset.tier;
    const next = input.dataset.field === 'personal_day' ? setPersonalDay(snapshot, card.dataset.itemId, input.value || null)
      : editItem(card, { [input.dataset.field]: fieldValue(input) });
    input.setAttribute('aria-invalid', 'false');
    itemError(card, '');
    const updated = card.dataset.kind === 'task'
      ? next.tasks.find(t => t.id === card.dataset.itemId)
      : next.events.find(e => e.id === card.dataset.itemId);
    const afterTier = updated ? itemTier(updated, card.dataset.kind) : beforeTier;
    const tierChanged = beforeTier !== afterTier;
    // Changing 点墨/约定 or upgrading between 定日/定期限/定时 moves or updates the badge immediately.
    commit(next, { render: (input.dataset.field === 'kind' || input.dataset.field === 'personal_day' || tierChanged) ? 'all' : 'none' });
    if (card.dataset.kind === 'task' && ['title', 'estimate_minutes'].includes(input.dataset.field) && !tierChanged) refreshLearned(card);
    if (input.dataset.field === 'title') clearStarterResult(card.querySelector('[data-task-starter]'));
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    itemError(card, `没有保存：${error.message}。`);
  }
}
function clearStarterResult(form) {
  if (!form) return;
  const result = form.querySelector('[data-starter-result]');
  result.hidden = true;
  result.replaceChildren();
  form.querySelector('[data-starter-feedback]').textContent = '';
}
async function prepareTaskStarter(event) {
  const form = event.target.closest('[data-task-starter]');
  if (!form) return;
  event.preventDefault();
  const task = snapshot.tasks.find(item => item.id === form.closest('[data-item-id]').dataset.itemId);
  const textarea = form.elements.namedItem('material');
  const submit = form.querySelector('button[type="submit"]');
  if (!task || task.status !== 'active' || submit.disabled) return;
  const result = form.querySelector('[data-starter-result]');
  const feedback = form.querySelector('[data-starter-feedback]');
  const base = apiBase;
  const material = textarea.value.trim();
  const now = Date.now();
  const rest = lockedRests(snapshot).find(item => item.start <= now && now < item.end);
  const current = () => form.isConnected && base === apiBase &&
    snapshot.tasks.some(item => item.id === task.id && item.title === task.title && item.status === 'active');
  clearStarterResult(form);
  feedback.textContent = '正在整理…';
  textarea.readOnly = true;
  busy(submit, true, '生成起步卡', '正在整理…');
  try {
    const service = await ensureHealth(base);
    // 1.30 reads the material; 1.29.1 still gives a first step from the title alone.
    const rich = service.capabilities?.includes('starter_material_v1');
    if (!rich && !service.capabilities?.includes('replan_loop_v1')) throw new Error('起步卡需要 1.29 或更新的计算服务。');
    if (!current()) throw new Error('任务或服务地址已变化。');
    const body = { task_id: task.id, title: task.title, mode: 'rules' };
    if (rich) Object.assign(body, { material_text: material, resting: Boolean(rest), resting_label: rest?.label || '', ...(rest ? { resting_until: new Date(rest.end).toISOString() } : {}) });
    const card = await request('/api/v3/starter', body, base);
    if (!current()) throw new Error('任务或服务地址已变化。');
    const excerpts = card.material_brief?.excerpts || [];
    const draft = [task.title, ...(excerpts.length ? ['', '材料原文', ...excerpts.map(text => `- ${text}`)] : []), '', '第一步', card.action].join('\n');
    result.innerHTML = `<p class="starter-action"><strong>${card.resting ? '现在正休息' : '先做这一步'}</strong><span>${escapeHTML(card.action)}</span></p>
      ${material && !rich ? '<p class="field-help">当前计算服务还不能读材料，先按任务名给出第一步。</p>' : ''}
      ${excerpts.length ? `<h4>材料原文</h4><ul>${excerpts.map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ul>` : ''}
      <button type="button" data-starter-copy>复制草稿</button>
      <label data-starter-copy-fallback hidden>草稿<textarea readonly rows="5">${escapeHTML(draft)}</textarea></label>`;
    result.hidden = false;
    feedback.textContent = '起步卡已生成。';
  } catch (error) {
    feedback.textContent = `没能生成起步卡：${error.message}`;
  } finally {
    textarea.readOnly = false;
    busy(submit, false, '生成起步卡', '正在整理…');
  }
}
async function copyStarterDraft(button) {
  const fallback = button.parentElement.querySelector('[data-starter-copy-fallback]');
  const draft = fallback.querySelector('textarea');
  try {
    await navigator.clipboard.writeText(draft.value);
    tell('起步草稿已复制。');
  } catch {
    fallback.hidden = false;
    draft.focus();
    draft.select();
    tell('草稿已选中，可以用复制快捷键。');
  }
}
function onItemClick(event) {
  const card = event.target.closest('[data-item-id]');
  if (!card) return;
  const id = card.dataset.itemId;
  const isTask = card.dataset.kind === 'task';
  const item = isTask ? snapshot.tasks.find(entry => entry.id === id) : snapshot.events.find(entry => entry.id === id);
  const copyStarter = event.target.closest('[data-starter-copy]');
  if (copyStarter) { copyStarterDraft(copyStarter); return; }
  try {
    const actual = event.target.closest('[data-actual]');
    if (actual) { saveActual(id, actual.dataset.actual); return; }
    const mark = event.target.closest('[data-mark]');
    if (mark) {
      saveFocus(setMark(focusSettings, id, mark.dataset.mark));
      for (const button of card.querySelectorAll('[data-mark]')) button.setAttribute('aria-pressed', String(focusSettings.marks[id] === button.dataset.mark));
      return;
    }
    const chip = event.target.closest('[data-estimate]');
    if (chip) {
      const minutes = Number(chip.dataset.estimate);
      const beforeTier = card.dataset.tier;
      card.querySelector('[data-field="estimate_minutes"]').value = String(minutes);
      const next = updateTask(snapshot, id, { estimate_minutes: minutes });
      const updated = next.tasks.find(t => t.id === id);
      const afterTier = updated ? itemTier(updated, 'task') : beforeTier;
      commit(next, { render: beforeTier !== afterTier ? 'all' : 'none' });
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'delete') {
      if (!window.confirm(`删除「${item.title}」？`)) return;
      if (isTask && xieyiState.slots?.[id]) {
        xieyiState = normalizeXieyiState(removeTaskSlot(xieyiState, id));
        writeXieyi(storage, xieyiState);
      }
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
    const summary = event.target.closest('.item-edit:not(.task-starter) > summary');
    const id = summary?.closest('[data-item-id]')?.dataset.itemId;
    if (!id) return;
    if (summary.parentElement.open) openCards.delete(id); else openCards.add(id); // the click flips it right after
  });
}
$('taskSection').addEventListener('submit', prepareTaskStarter);
$('taskSection').addEventListener('input', event => {
  if (event.target.name === 'material') clearStarterResult(event.target.closest('[data-task-starter]'));
});
$('taskSection').addEventListener('click', event => {
  const strip = event.target.closest('[data-group-open]');
  if (!strip) return;
  workGroup = strip.dataset.groupOpen;
  spreadWorkGroup(workGroup);
  strip.closest('[data-group]').querySelector('.group-head button')?.focus({ preventScroll: true });
});
$('addPersonal').addEventListener('click', () => {
  let next = addPersonalTask(snapshot, { day: localDate(Date.now()) });
  const created = next.tasks[next.tasks.length - 1];
  if (created) {
    xieyiState = normalizeXieyiState(setTaskSlot(xieyiState, created.id, 'bu'));
    writeXieyi(storage, xieyiState);
  }
  const refMs = Date.parse(next.reference_time);
  if (Number.isFinite(refMs) && refMs - Date.now() > 5 * 60000) { next = setReferenceTime(next, currentMinuteISO()); calendarWeek = null; }
  commit(next);
  const title = $('personalList').lastElementChild?.querySelector('[data-field="title"]');
  title?.focus(); title?.select();
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
function flipScrollMode(nextMode, dir = '') {
  if (xieyiState.mode === nextMode) return false;
  scrollFlipDir = dir || (nextMode === 'xieyi' ? 'is-flip-next' : 'is-flip-prev');
  commitXieyi(setScrollMode(xieyiState, nextMode));
  if (xieyiState.mode === 'gongbi') (window.requestAnimationFrame || window.setTimeout)(fitCalendar);
  return true;
}

window.SixuCalendarFlip = {
  arrows() {
    if (xieyiState.mode === 'xieyi') {
      return {
        prev: { label: '时序卷 · 精确排期', flip: 'gongbi', route: 'calendar' },
        next: null,
      };
    }
    return {
      prev: { label: '铺纸 · 底色与留白', route: 'time' },
      next: { label: '日课卷 · 每日待办', flip: 'xieyi', route: 'calendar' },
    };
  },
  step(step) {
    if (step > 0 && xieyiState.mode === 'gongbi') return flipScrollMode('xieyi', 'is-flip-next');
    if (step < 0 && xieyiState.mode === 'xieyi') return flipScrollMode('gongbi', 'is-flip-prev');
    return false;
  },
};

$('calendarView').addEventListener('click', event => {
  if (event.target.closest('[data-open-companion]')) { openCompanionModal(); return; }
  const flipBtn = event.target.closest('[data-scroll-flip]');
  if (flipBtn) { flipScrollMode(flipBtn.dataset.scrollFlip); return; }
  const modeBtn = event.target.closest('[data-cal-mode]');
  if (modeBtn) { flipScrollMode(modeBtn.dataset.calMode); return; }
  const dayLogBtn = event.target.closest('[data-xy-day-log-toggle]');
  if (dayLogBtn) {
    const targetDay = dayLogBtn.dataset.xyDayLogToggle;
    openLogDate = openLogDate === targetDay ? '' : targetDay;
    renderCalendar();
    return;
  }
  const goalTabBtn = event.target.closest('[data-xy-goal-tab]');
  if (goalTabBtn) { commitXieyi(setGoalTab(xieyiState, goalTabBtn.dataset.xyGoalTab)); return; }
  const goalToggleBtn = event.target.closest('[data-xy-goal-toggle]');
  if (goalToggleBtn) { commitXieyi(toggleGoal(xieyiState, goalToggleBtn.dataset.xyGoalToggle)); return; }
  const goalDelBtn = event.target.closest('[data-xy-goal-del]');
  if (goalDelBtn) { commitXieyi(removeGoal(xieyiState, goalDelBtn.dataset.xyGoalDel)); return; }
  const goalDropBtn = event.target.closest('[data-xy-goal-drop]');
  if (goalDropBtn) {
    const goal = xieyiState.goals.find(g => g.id === goalDropBtn.dataset.xyGoalDrop);
    if (!goal) return;
    const startMs = shownWeek();
    const todayYmd = localDate(Date.now());
    const inWeek = Date.now() >= startMs && Date.now() < startMs + 7 * DAY;
    const dropDate = inWeek ? todayYmd : localDate(startMs);
    const next = addPersonalTask(snapshot, { title: goal.title, day: dropDate, estimate_minutes: null });
    const created = next.tasks[next.tasks.length - 1];
    if (created) {
      xieyiState = normalizeXieyiState(setTaskSlot(xieyiState, created.id, 'bu'));
      writeXieyi(storage, xieyiState);
    }
    commit(next);
    tell(`已把「${goal.title}」落入 ${dropDate} 晡（下午），并同步记入笔墨。`);
    return;
  }
  const pendingDropBtn = event.target.closest('[data-xy-pending-drop]');
  if (pendingDropBtn) {
    const taskId = pendingDropBtn.dataset.xyPendingDrop;
    const task = snapshot.tasks.find(t => t.id === taskId);
    if (!task) return;
    const startMs = shownWeek();
    const todayYmd = localDate(Date.now());
    const inWeek = Date.now() >= startMs && Date.now() < startMs + 7 * DAY;
    const dropDate = inWeek ? todayYmd : localDate(startMs);
    xieyiState = normalizeXieyiState(setTaskSlot(xieyiState, taskId, 'bu'));
    writeXieyi(storage, xieyiState);
    commit(setPersonalDay(snapshot, taskId, dropDate));
    tell(`已把「${task.title}」落到 ${dropDate} 晡（下午）。`);
    return;
  }
  const taskToggleBtn = event.target.closest('[data-xy-task-toggle]');
  if (taskToggleBtn) {
    const task = snapshot.tasks.find(t => t.id === taskToggleBtn.dataset.xyTaskToggle);
    if (!task) return;
    const finishing = task.status !== 'completed';
    commit(updateTask(snapshot, task.id, { status: finishing ? 'completed' : 'active' }));
    return;
  }
  const taskDelBtn = event.target.closest('[data-xy-task-del]');
  if (taskDelBtn) {
    const taskId = taskDelBtn.dataset.xyTaskDel;
    if (xieyiState.slots?.[taskId]) {
      xieyiState = normalizeXieyiState(removeTaskSlot(xieyiState, taskId));
      writeXieyi(storage, xieyiState);
    }
    commit(removeItem(snapshot, taskId));
    return;
  }
  const upgradeBtn = event.target.closest('[data-xy-upgrade]');
  if (upgradeBtn) {
    const [taskId, minRaw] = upgradeBtn.dataset.xyUpgrade.split(':');
    const minutes = Number(minRaw);
    const task = snapshot.tasks.find(t => t.id === taskId);
    if (!task || !Number.isFinite(minutes)) return;
    commit(updateTask(snapshot, taskId, { estimate_minutes: minutes }));
    tell(`已为「${task.title}」补填预计 ${minutes} 分钟，已同步排入时序卷。`);
    return;
  }
  const noteToggleBtn = event.target.closest('[data-xy-note-toggle]');
  if (noteToggleBtn) { commitXieyi(toggleNote(xieyiState, noteToggleBtn.dataset.xyNoteToggle)); return; }
  const noteDelBtn = event.target.closest('[data-xy-note-del]');
  if (noteDelBtn) { commitXieyi(removeNote(xieyiState, noteDelBtn.dataset.xyNoteDel)); return; }
  const promoteBtn = event.target.closest('[data-xy-promote]');
  if (promoteBtn) {
    const note = xieyiState.notes.find(n => n.id === promoteBtn.dataset.xyPromote);
    if (!note || note.promotedTaskId) return;
    const nextSnap = addPersonalTask(snapshot, { title: note.title, day: note.date, estimate_minutes: null });
    const createdTask = nextSnap.tasks[nextSnap.tasks.length - 1];
    xieyiState = normalizeXieyiState(markNotePromoted(xieyiState, note.id, createdTask.id));
    writeXieyi(storage, xieyiState);
    commit(nextSnap);
    tell(`已将「${note.title}」转入「笔墨」，补填预计用时后即可在工笔时轴精确排期。`);
    return;
  }
  const presetBtn = event.target.closest('[data-xy-log-preset]');
  if (presetBtn) {
    const form = presetBtn.closest('[data-xy-log-form]');
    const input = form?.querySelector('input[name="minutes"]');
    if (input) input.value = presetBtn.dataset.xyLogPreset;
    return;
  }
  const logDelBtn = event.target.closest('[data-xy-log-del]');
  if (logDelBtn) { commitXieyi(removeTimeLog(xieyiState, logDelBtn.dataset.xyLogDel)); return; }
  const week = event.target.closest('[data-cal-week]');
  if (week) {
    const step = Number(week.dataset.calWeek);
    calendarWeek = step ? shownWeek() + step * 7 * DAY : null;
    solveState = null;
    calendarResult = null;
    computeCalendar();
    return;
  }
  if (event.target.closest('[data-cal-analyze]')) {
    // 画卷 and 本周解析 are two full pages side by side: the analysis turns in from the right, the
    // painting comes back from the left. The class lives only on this render, so a later refresh
    // of the same page does not play the turn again.
    calendarAnalyzed = !calendarAnalyzed;
    renderCalendar();
    $('calendarView').querySelector('.scroll')?.classList.add(calendarAnalyzed ? 'turn-in-right' : 'turn-in-left');
    const top = $('calendarView').getBoundingClientRect().top;
    if (top < 0) window.scrollBy({ top: top - 90, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  if (event.target.closest('[data-use-now]')) {
    calendarWeek = null;
    commit(setReferenceTime(snapshot, currentMinuteISO()));
    tell('已恢复按当前时间安排。');
    return;
  }
  const goto = event.target.closest('[data-cal-goto="time"]');
  if (goto) { window.SixuRouter?.go('time'); openRoll(goto.dataset.calRoll || 'free'); return; }
  if (event.target.closest('[data-cal-view]')) {
    calendarListView = !calendarListView;
    renderCalendar();
    (window.requestAnimationFrame || window.setTimeout)(fitCalendar);
    return;
  }
  if (event.target.closest('[data-scroll-open]')) { unrollScroll(); return; }
  if (event.target.closest('[data-scroll-roll]')) { rolledByMode[xieyiState.mode] = true; coverPaintedByMode[xieyiState.mode] = false; renderCalendar(); return; }
  if (event.target.closest('[data-strategy-undo]')) { undoStrategy(); return; }
  const pick = event.target.closest('[data-rp-pick]');
  if (pick && replanState?.preview) { replanState.chosen = pick.dataset.rpPick; renderCalendar(); return; }
  if (event.target.closest('[data-rp-apply]')) { applyReplan(); return; }
  if (event.target.closest('[data-rp-dismiss]')) { dismissReplan(); return; }
  if (event.target.closest('[data-rp-start]')) { toggleStart(); return; }
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

function handleXieyiLogSubmit(logForm) {
  try {
    const el = logForm.elements;
    const kind = String(el.kind?.value || 'study');
    const minutes = Number(el.minutes?.value);
    const date = String(el.date?.value || localDate(Date.now()));
    const taskId = String(el.taskId?.value || '').trim() || null;
    const linked = taskId ? snapshot.tasks.find(t => t.id === taskId) : null;
    const rawTitle = String(el.title?.value || '').trim();
    const title = rawTitle || linked?.title || (kind === 'study' ? '专注砚耕' : '留白休歇');
    commitXieyi(addTimeLog(xieyiState, { kind, title, minutes, date, taskId, source: 'manual' }));
    if (kind === 'study' && linked) {
      estimateMemory = recordActual(estimateMemory, linked.title, minutes);
      writeMemory(storage, estimateMemory);
      if (linked.estimate_minutes) writeCalibration(storage, recordCalibration(readCalibration(storage), linked.title, linked.estimate_minutes, minutes));
      tell(`已记入砚耕 ${minutes} 分钟，并同步校准「${linked.title}」的耗时记忆。`);
    } else {
      tell(`已记入${kind === 'study' ? '砚耕' : '闲暇'} ${minutes} 分钟。`);
    }
    if ($('companionStage') && !$('companionStage').hidden) renderCompanion();
  } catch (error) { tell(error.message, 'warning'); }
}

$('calendarView').addEventListener('submit', event => {
  const goalForm = event.target.closest('[data-xy-goal-form]');
  if (goalForm) {
    event.preventDefault();
    try {
      const { horizon, periodKey, title } = goalForm.elements;
      commitXieyi(addGoal(xieyiState, { horizon: String(horizon?.value || 'week'), periodKey: String(periodKey?.value || periodKeyFor('week', shownWeek())), title: String(title?.value || '') }));
      tell('已立下远山志。');
    } catch (error) { tell(error.message, 'warning'); }
    return;
  }
  const addForm = event.target.closest('[data-xy-add-form]');
  if (addForm) {
    event.preventDefault();
    try {
      const { date, slot, title } = addForm.elements;
      const cleanTitle = String(title?.value || '').trim();
      const targetDate = String(date?.value || '');
      const targetSlot = String(slot?.value || 'chen');
      if (!cleanTitle || !targetDate) return;
      const next = addPersonalTask(snapshot, { title: cleanTitle, day: targetDate, estimate_minutes: null });
      const created = next.tasks[next.tasks.length - 1];
      if (created) {
        xieyiState = normalizeXieyiState(setTaskSlot(xieyiState, created.id, targetSlot));
        writeXieyi(storage, xieyiState);
      }
      commit(next);
    } catch (error) { tell(error.message, 'warning'); }
    return;
  }
  const logForm = event.target.closest('[data-xy-log-form]');
  if (logForm) {
    event.preventDefault();
    handleXieyiLogSubmit(logForm);
  }
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

// ---- 计划被打断：重排预览与确认（后端 /api/v3/replan/*）-----------------------------
// One sentence in 研墨 becomes a draft (an interruption, a rest to keep, a low/high-energy window). The backend
// plans every option inside the hard constraints and says whether the user has to choose; only then a card shows.
// Nothing is written until a plan is taken, and what is written is exactly what the 画卷 then draws.
function saveFocus(next, { render = true } = {}) {
  focusSettings = next;
  writeFocus(storage, next);
  renderFocusSetup();
  renderInkRail();
  if (render) renderCalendar();
}
function liveSnapshot() {
  return { ...snapshot, reference_time: new Date(Math.max(Date.parse(snapshot.reference_time), Date.parse(currentMinuteISO()))).toISOString() };
}
async function startReplan(draft) {
  const base = apiBase;
  const revision = snapshot.revision;
  const range = replanRange(snapshot, draft, Date.now());
  const loading = { loading: true, draft };
  replanState = loading;
  stopStart();
  renderCalendar();
  try {
    const service = await ensureHealth(base);
    if (!service.capabilities?.includes('replan_loop_v1')) throw new Error('当前计算服务还不能重排（需要后端 1.29 及以上）。');
    const body = previewRequest({ snapshot: liveSnapshot(), focus: focusSettings, draft, now: Date.now(), range, history: readCalibration(storage) });
    const preview = await request('/api/v3/replan/preview', body, base, 60000);
    // The list changed (cleared, edited, another plan taken) while the preview was computed: it no longer applies.
    if (replanState !== loading) return replanState;
    if (base !== apiBase || snapshot.revision !== revision) { replanState = { error: '清单在重算途中有变化，这次没有记下；需要的话请再说一遍。', draft }; return replanState; }
    replanState = { preview, draft, body, range, revision, chosen: null };
    if (preview.status === 'ready' && !preview.needs_decision) await applyReplan({ quiet: true });
  } catch (error) {
    replanState = { error: `没能按这句话重算：${error.message}`, draft };
  } finally { renderCalendar(); }
  return replanState;
}
async function applyReplan({ quiet = false } = {}) {
  const state = replanState;
  if (!state?.preview || state.applying || state.preview.status !== 'ready') return;
  const plans = state.preview.candidate_plans || [];
  const plan = plans.find(item => item.plan_id === state.chosen) || plans.find(item => item.recommended) || plans[0];
  if (!plan) return;
  if (state.revision !== snapshot.revision) { tell('清单刚刚变过，已按最新清单重算。', 'warning'); await startReplan(state.draft); return; }
  state.applying = true;
  renderCalendar();
  const moved = plan.task_changes.filter(change => change.changed);
  const before = snapshot;
  const focusBefore = focusSettings;
  const base = apiBase;
  try {
    const result = await request('/api/v3/replan/confirm', confirmRequest({ snapshot: state.body.snapshot, range: state.range, preview: state.preview, plan, now: state.body.now }), base, 60000);
    // Checked again on the way back: if the list changed while the server confirmed (清空清单, an edit,
    // another tab), writing the old plan back would undo the user's newer change. Drop it instead.
    if (replanState !== state || snapshot !== before || base !== apiBase) {
      if (replanState === state) replanState = null;
      tell('清单在写回途中有变化，这次重排没有写入；需要的话请再说一遍。', 'warning');
      renderCalendar();
      return;
    }
    const next = parseTimeSnapshot(JSON.stringify({ ...result.snapshot, revision: snapshot.revision + 1 }));
    if (state.draft?.state) saveFocus(addStates(focusSettings, [state.draft.state]), { render: false });
    flipFrom = moved.length ? workRects() : null;
    commit(next);
    const said = draftLabel(state.draft || {});
    const label = moved.length ? `${plan.name}：${moved.map(change => `「${change.title}」挪到 ${change.after.map(block => spanText(Date.parse(block.start), Date.parse(block.end))).join('、')}`).join('；')}` : `${said}，安排不用动`;
    strategyUndo = { before, label, note: '', digest: null, changes: [], replan: true, focusBefore };
    replanState = { applied: true, label, starter: state.preview.five_minute_starter || null };
    if (!quiet) tell(`已采用：${plan.name}`);
  } catch (error) {
    if (replanState !== state) return; // the card was dismissed or the list cleared meanwhile
    if (error.code === 'stale_preview') { tell('清单刚刚变过，已按最新清单重算。', 'warning'); await startReplan(state.draft); return; }
    // Nothing was for the user to choose, so there is no card to fall back to: say it was not recorded.
    replanState = quiet ? { error: `没能记下这次变化：${error.message}`, draft: state.draft } : { ...state, applying: false };
    if (!quiet) tell(`没能写回：${error.message}`, 'error');
  }
  renderCalendar();
}
function dismissReplan() {
  const waiting = replanState && !replanState.applied;
  replanState = null;
  stopStart();
  renderCalendar();
  if (waiting) tell('没改安排；你刚才说的没有写进画卷。');
}
function stopStart() {
  if (replanClock) window.clearInterval(replanClock.timer);
  replanClock = null;
}
function toggleStart() {
  if (replanClock) { stopStart(); renderCalendar(); return; }
  replanClock = { left: 300, timer: window.setInterval(() => {
    replanClock.left -= 1;
    for (const button of $('calendarView').querySelectorAll('[data-rp-start]')) button.textContent = `还剩 ${Math.floor(replanClock.left / 60)}:${String(replanClock.left % 60).padStart(2, '0')} · 结束`;
    if (replanClock.left <= 0) { stopStart(); renderCalendar(); tell('五分钟到了。想接着做就继续，停在这里也算开了头。'); }
  }, 1000) };
  renderCalendar();
}
/** 铺纸 · 常用专注时段 and the temporary states said in 研墨 (each can be removed). */
function renderFocusSetup() {
  const form = $('focusForm');
  if (!form) return;
  const fill = (key, id) => {
    const w = focusSettings.windows.find(item => item.id === id);
    $(`focus${key}On`).checked = Boolean(w);
    if (w) { $(`focus${key}Start`).value = w.start; $(`focus${key}End`).value = w.end; }
  };
  fill('Weekday', 'w-weekday');
  fill('Weekend', 'w-weekend');
  const states = focusSettings.states.filter(state => Date.parse(state.end_at) > Date.now());
  $('focusStates').innerHTML = states.length ? `<p class="field-help">研墨里说过的状态</p><ul class="focus-state-list">${states.map(state => `<li><span>${state.level === 'low' ? '精力偏低' : '临时专注'} ${escapeHTML(dayLabel(Date.parse(state.start_at)))} ${spanText(Date.parse(state.start_at), Date.parse(state.end_at))}</span><em>“${escapeHTML(state.text)}”</em><button type="button" class="text-button" data-focus-state="${escapeHTML(state.id)}">删去</button></li>`).join('')}</ul>` : '';
}
$('focusForm')?.addEventListener('submit', event => {
  event.preventDefault();
  const span = key => ($(`focus${key}On`).checked ? { start: $(`focus${key}Start`).value, end: $(`focus${key}End`).value } : null);
  try {
    saveFocus(setCommonWindows(focusSettings, { weekday: span('Weekday'), weekend: span('Weekend') }));
    $('focusError').textContent = '';
    tell(focusSettings.windows.length ? '专注时段已保存。只有计划被打断、需要取舍时，画卷才会用到它。' : '已清除常用专注时段。');
  } catch (error) { $('focusError').textContent = error.message; }
});
$('focusStates')?.addEventListener('click', event => {
  const button = event.target.closest('[data-focus-state]');
  if (button) saveFocus(removeState(focusSettings, button.dataset.focusState));
});

// ---- 研墨里一句话完成的操作（chat-actions.js 解析，这里执行并回复） -----------------------
const activeTitles = () => snapshot.tasks.filter(task => task.status === 'active').slice(0, 3).map(task => task.title);
/** Runs one sentence action and answers in the thread; false hands the sentence on to the usual flow. */
async function runChatAction(text, action) {
  const reply = (body, says = []) => { showTurn(text, body + nextChips(says)); return true; };
  if (action.kind === 'focus-window') {
    if (action.missing) {
      focusAsk = action.days;
      const which = action.days.weekend && !action.days.weekday ? '周末' : action.days.weekday && !action.days.weekend ? '工作日' : '';
      return reply(replyMarkup({ text: `你${which}常在几点到几点最能专注？说「下午」「晚上」「全天」也行，比如「${which || '工作日'}晚上7点到9点最专注」。` }), ['常在下午专注', '全天都能专注']);
    }
    const span = id => { const w = focusSettings.windows.find(item => item.id === id); return w ? { start: w.start, end: w.end } : null; };
    const next = setCommonWindows(focusSettings, { weekday: action.weekday || span('w-weekday'), weekend: action.weekend || span('w-weekend') });
    saveFocus(next);
    const said = [action.weekday && `工作日 ${action.weekday.start}–${action.weekday.end}`, action.weekend && `周末 ${action.weekend.start}–${action.weekend.end}`].filter(Boolean).join('、');
    const titles = activeTitles();
    const guess = action.guessed ? `没说具体几点，先按${action.guessed} 记下，可以在铺纸 · 留白里微调。` : '';
    return reply(replyMarkup({ text: `记下了：${said} 是你的常用专注时段。${guess}计划被打断时，标了“需要专注”的事会优先排进这里；平时不打扰你。` }), titles.length ? [`${titles[0]}需要专注`] : []);
  }
  const { task, byName } = findTask(snapshot, action.phrase, lastTaskId);
  if (action.kind === 'complete' || action.kind === 'estimate') {
    if (!byName) return false; // "做完了" without a name: agenda.js answers for the task just talked about
    if (action.kind === 'complete') {
      commit(updateTask(snapshot, task.id, { status: 'completed' }));
      lastTaskId = task.id;
      return reply(replyMarkup({ text: `已把「${task.title}」标记完成。` }), ['这周还剩多少时间？']);
    }
    commit(updateTask(snapshot, task.id, { estimate_minutes: action.minutes }));
    lastTaskId = task.id;
    return reply(replyMarkup({ text: `「${task.title}」的预计用时改成 ${minutesLabel(action.minutes)}，画卷会在截止前为它找留白。` }), [`帮我开个头：${task.title}`]);
  }
  if (!task) {
    const titles = activeTitles();
    return reply(replyMarkup({ text: titles.length ? '你说的是哪件事？点一下下面的说法就行。' : '清单里还没有要做的事。先说一件，比如「提醒我周五前交实验报告」。' }),
      titles.map(title => (action.kind === 'starter' ? `帮我开个头：${title}` : `${title}${action.mark === 'fragment' ? '碎片时间做就行' : '需要专注'}`)));
  }
  lastTaskId = task.id;
  if (action.kind === 'mark') {
    if (focusSettings.marks[task.id] !== action.mark) saveFocus(setMark(focusSettings, task.id, action.mark));
    const hasWindow = focusSettings.windows.length > 0;
    return reply(replyMarkup({ text: action.mark === 'focus'
      ? `记下了：「${task.title}」需要专注。${hasWindow ? '计划被打断时，它会优先排进你的专注时段。' : '再说一句你平时几点最专注，重排时它就会优先排进那段时间。'}`
      : `记下了：「${task.title}」适合碎片时间，重排时会用零碎空档来做它。` }),
      action.mark === 'focus' && !hasWindow ? ['我工作日晚上7点到9点最专注'] : [`帮我开个头：${task.title}`]);
  }
  // 起步卡: the backend picks one concrete first step, and quotes the material if the user gave any.
  $('parseStep').textContent = '正在想第一步';
  const service = await ensureHealth(apiBase);
  const rich = service.capabilities?.includes('starter_material_v1');
  if (!rich && !service.capabilities?.includes('replan_loop_v1')) return reply(replyMarkup({ text: '当前计算服务还不能生成起步卡，请更新到后端 1.29 以上。' }));
  const now = Date.now();
  const rest = lockedRests(snapshot).find(item => item.start <= now && now < item.end);
  const body = { task_id: task.id, title: task.title, mode: 'rules' };
  if (task.estimate_minutes) body.estimate_minutes = task.estimate_minutes;
  if (task.deadline_at) body.deadline_at = task.deadline_at;
  // Fields are left out rather than sent as null: the backend reads them with .get(key, "").
  if (rich && action.material) body.material_text = action.material;
  if (rich && rest) Object.assign(body, { resting: true, resting_label: rest.label, resting_until: new Date(rest.end).toISOString() });
  const card = await request('/api/v3/starter', body, apiBase);
  return reply(starterReply(task, card, { degraded: Boolean(action.material) && !rich }), ['这周还剩多少时间？', `${task.title}需要专注`]);
}
// 试算 starts from now, or from the list's planning start when that is later (the roadshow case).
function planNow() {
  const ref = Date.parse(snapshot.reference_time || '');
  return new Date(Math.max(Date.now(), Number.isFinite(ref) ? ref : 0)).toISOString();
}
// Plans shown in the thread, so a card's 记进日历 adds exactly what it showed.
const shownPlans = new Map();
function keepPlan(plan) {
  if (plan?.tool !== 'plan_activities' || !plan.feasible) return '';
  const id = `plan-${shownPlans.size + 1}`;
  shownPlans.set(id, plan);
  return id;
}
function adoptPlan(id, button) {
  const plan = shownPlans.get(id);
  if (!plan) return;
  let next = snapshot;
  let count = 0;
  for (const item of plan.placements || []) for (const block of item.blocks || []) {
    next = addEvent(next, { title: item.title, kind: 'appointment', start_at: block.start, end_at: block.end, notes: ['研墨试算后记下的约定'] });
    count += 1;
  }
  if (!count) return;
  commit(next);
  shownPlans.delete(id);
  button.disabled = true;
  button.textContent = `已记进日历 · ${count} 段约定`;
  tell(`已把 ${count} 段时间记成约定，画卷里能看到；在笔墨 · 约定里可以改或删。`);
}
// Action proposals from /api/v3/chat (agenda_chat_proposals_v1): nothing writes until the user clicks confirm.
const shownProposals = new Map();
function escalateMarkup(text) {
  return `<div class="pc-actions"><button type="button" class="text-button" data-escalate-chat="${escapeHTML(text)}">交给司序深度理解（模型）</button></div>`;
}
function keepProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return '';
  const id = `prop-${shownProposals.size + 1}`;
  const choices = (proposal.items || []).map(item => item.layer || (item.kind === 'event' ? 'appointment' : 'deadline'));
  shownProposals.set(id, { proposal, revision: snapshot.revision, choices, initialChoices: [...choices] });
  return id;
}
function switchProposalKind(spec, button) {
  const [id, idxText, nextKind] = String(spec || '').split(':');
  const idx = Number(idxText);
  const entry = shownProposals.get(id);
  if (!entry || !Number.isInteger(idx) || idx < 0 || idx >= entry.choices.length || !PROPOSAL_KIND_LABEL[nextKind]) return;
  entry.choices[idx] = nextKind;
  const row = button.closest('[data-prop-item]');
  if (row) {
    for (const pill of row.querySelectorAll('.pc-pill')) {
      const on = pill === button;
      pill.classList.toggle('is-on', on);
      pill.setAttribute('aria-pressed', String(on));
    }
    const titleEl = row.querySelector('[data-prop-title]');
    const item = entry.proposal.items[idx];
    if (titleEl && item) titleEl.textContent = `${PROPOSAL_KIND_LABEL[nextKind]} · ${item.title}`;
  }
  const card = button.closest('.plan-card');
  const confirmBtn = card?.querySelector('[data-proposal-adopt]');
  if (confirmBtn && !confirmBtn.disabled) {
    const allDisrupt = entry.choices.every(choice => choice === 'disruption');
    const anyDisrupt = entry.choices.some(choice => choice === 'disruption');
    confirmBtn.textContent = allDisrupt ? '按临时打断重算本周' : anyDisrupt ? '确认记入并重算' : '确认记入清单';
  }
}
function offerOptionalDurations(card, addedEvents, addedTasks, sourceText = '') {
  if (!card || !card.closest('#importSummary')) return;
  const unestimated = (addedTasks || []).filter(task => task.status === 'active' && task.estimate_minutes === null);
  const estMarkup = unestimated.map(task => `<div class="turn-estimate" role="group" aria-label="「${escapeHTML(task.title)}」的预计用时"><span>「${escapeHTML(task.title)}」预计用时（选填）</span>${ESTIMATE_PRESETS.slice(0, 4).map(preset => `<button type="button" class="chip" data-turn-estimate="${escapeHTML(task.id)}:${preset.minutes}">${preset.label}</button>`).join('')}</div>`).join('');
  const endMarkup = endAskMarkup({ events: addedEvents || [], tasks: addedTasks || [] });
  if (estMarkup || endMarkup) card.insertAdjacentHTML('afterend', estMarkup + endMarkup);
  if (endMarkup) estimateEnds('rules', sourceText);
}
async function adoptProposal(id, button) {
  const entry = shownProposals.get(id);
  if (!entry) return;
  const { proposal, revision, choices, initialChoices } = entry;
  const card = button.closest('.plan-card');
  const lockPills = () => card?.querySelectorAll('.pc-pill').forEach(pill => { pill.disabled = true; });
  if (proposal.kind === 'add_items') {
    if (revision !== snapshot.revision) { shownProposals.delete(id); return tell('清单刚刚有变化，请再发一次以重新核对冲突。', 'warning'); }
    const prevEventIds = new Set(snapshot.events.map(ev => ev.id));
    const prevTaskIds = new Set(snapshot.tasks.map(tk => tk.id));
    const unchanged = choices.every((choice, i) => choice === initialChoices[i]);
    if (unchanged) {
      let next;
      try { next = parseTimeSnapshot(JSON.stringify({ ...proposal.preview_snapshot, revision: snapshot.revision + 1 })); }
      catch (error) { return tell(`草案没能写入：${error.message}`, 'error'); }
      if (!next.daily_window) next = setDailyWindow(next, DEFAULT_WINDOW);
      const addedEvents = next.events.filter(ev => !prevEventIds.has(ev.id));
      const addedTasks = next.tasks.filter(tk => !prevTaskIds.has(tk.id));
      commit(next);
      shownProposals.delete(id);
      lockPills();
      button.disabled = true;
      button.textContent = `已记入清单 · ${(proposal.items || []).length} 项`;
      offerOptionalDurations(card, addedEvents, addedTasks, next.sources.at(-1)?.text || '');
      tell('已按确认的草案记入清单，画卷已更新。');
      return;
    }
    let next = snapshot;
    let addedCount = 0;
    const disruptions = [];
    for (const [index, item] of (proposal.items || []).entries()) {
      const chosen = choices[index] || 'appointment';
      if (chosen === 'disruption') {
        const startAt = item.start_at || item.deadline_at;
        if (!startAt) continue;
        const startMs = Date.parse(startAt);
        const endAt = item.end_at && Date.parse(item.end_at) > startMs ? item.end_at : isoAt(startMs + 60 * 60000);
        disruptions.push({ title: item.title, start_at: startAt, end_at: endAt });
      } else if (chosen === 'temporary' || chosen === 'appointment') {
        const startAt = item.start_at || item.deadline_at || null;
        const endAt = item.end_at && startAt && Date.parse(item.end_at) > Date.parse(startAt) ? item.end_at : null;
        next = addEvent(next, { title: item.title, kind: chosen, start_at: startAt, end_at: endAt, location: item.location || null, notes: ['由司序语义理解生成草案，经用户切换归类后记入'] });
        addedCount += 1;
      } else {
        const deadlineAt = item.deadline_at || item.end_at || item.start_at || null;
        let earliest = item.earliest_start_at || (chosen === 'personal' && deadlineAt ? `${deadlineAt.slice(0, 10)}T00:00:00+08:00` : null);
        if (earliest && deadlineAt && Date.parse(earliest) >= Date.parse(deadlineAt)) earliest = null;
        const notes = chosen === 'personal'
          ? ['个人任务', '由司序语义理解生成草案，经用户切换归类后记入']
          : ['由司序语义理解生成草案，经用户切换归类后记入'];
        next = addTask(next, { title: item.title, deadline_at: deadlineAt, earliest_start_at: earliest, estimate_minutes: item.estimate_minutes ?? null, location: item.location || null, notes });
        addedCount += 1;
      }
    }
    let addedEvents = [], addedTasks = [];
    if (addedCount) {
      if (!next.daily_window) next = setDailyWindow(next, DEFAULT_WINDOW);
      addedEvents = next.events.filter(ev => !prevEventIds.has(ev.id));
      addedTasks = next.tasks.filter(tk => !prevTaskIds.has(tk.id));
      commit(next);
    }
    shownProposals.delete(id);
    lockPills();
    button.disabled = true;
    if (addedCount) offerOptionalDurations(card, addedEvents, addedTasks, next.sources.at(-1)?.text || '');
    if (disruptions.length) {
      button.textContent = '正在按临时打断重算…';
      const state = await startReplan({ kind: 'disruption', disruption: disruptions[0] });
      if (state?.error) { button.textContent = addedCount ? `已记入 ${addedCount} 项（重算未完成）` : '重算未完成'; return tell(state.error, 'error'); }
      button.textContent = addedCount ? `已记入 ${addedCount} 项并重算` : (state?.applied ? '已记下临时打断（原安排不用动）' : '已生成重排方案 · 去画卷选');
      tell(state?.applied ? '已按临时打断记下，原来的安排都赶得上。' : '已按临时打断重算这一周，请到画卷查看并选择方案。');
      return;
    }
    button.textContent = `已记入清单 · ${addedCount} 项`;
    tell('已按你切换后的归类记入清单，画卷已更新。');
    return;
  }
  if (proposal.kind === 'update_item') {
    if (revision !== snapshot.revision) { shownProposals.delete(id); return tell('清单刚刚有变化，请再发一次以重新核对冲突。', 'warning'); }
    let next;
    try { next = parseTimeSnapshot(JSON.stringify({ ...proposal.preview_snapshot, revision: snapshot.revision + 1 })); }
    catch (error) { return tell(`草案没能写入：${error.message}`, 'error'); }
    if (!next.daily_window) next = setDailyWindow(next, DEFAULT_WINDOW);
    commit(next);
    shownProposals.delete(id);
    button.disabled = true;
    button.textContent = '已采用这项改动';
    tell('已按确认的改动更新清单，画卷已重算。');
    return;
  }
  if (proposal.kind === 'focus_window') {
    const existing = {
      weekday: focusSettings.windows.find(w => w.id === 'w-weekday') || null,
      weekend: focusSettings.windows.find(w => w.id === 'w-weekend') || null,
    };
    try {
      saveFocus(setCommonWindows(focusSettings, {
        weekday: proposal.weekday || (existing.weekday ? { start: existing.weekday.start, end: existing.weekday.end } : null),
        weekend: proposal.weekend || (existing.weekend ? { start: existing.weekend.start, end: existing.weekend.end } : null),
      }));
    } catch (error) { return tell(`专注时段没能保存：${error.message}`, 'error'); }
    shownProposals.delete(id);
    button.disabled = true;
    button.textContent = '已保存常用专注时段';
    tell('已保存常用专注时段，可在铺纸调整，画卷顶部已标出。');
    return;
  }
  if (proposal.kind === 'replan_draft' && proposal.draft) {
    shownProposals.delete(id);
    button.disabled = true;
    button.textContent = '正在重算…';
    const state = await startReplan(proposal.draft);
    if (state?.error) { button.disabled = false; button.textContent = '按此重算这一周'; return tell(state.error, 'error'); }
    button.textContent = state?.applied ? '已记下状态（原安排不用动）' : '已生成重排方案 · 去画卷选';
    tell(state?.applied ? '已记下当前状态，原来的安排都赶得上。' : '已按你说的重算这一周，请到画卷查看并选择方案。');
  }
}
// The chips send their sentence; a 起步卡 has its own 5-minute timer and copy button.
$('inkThread').addEventListener('click', event => {
  const adopt = event.target.closest('[data-plan-adopt]');
  if (adopt && !adopt.disabled) { adoptPlan(adopt.dataset.planAdopt, adopt); return; }
  const propKind = event.target.closest('[data-prop-kind]');
  if (propKind && !propKind.disabled) { switchProposalKind(propKind.dataset.propKind, propKind); return; }
  const propBtn = event.target.closest('[data-proposal-adopt]');
  if (propBtn && !propBtn.disabled) { adoptProposal(propBtn.dataset.proposalAdopt, propBtn); return; }
  const escalate = event.target.closest('[data-escalate-chat]');
  if (escalate && !$('parseNotice').disabled) {
    $('extractionMode').value = 'chat';
    $('noticeText').value = escalate.dataset.escalateChat;
    $('noticeForm').requestSubmit ? $('noticeForm').requestSubmit() : $('noticeForm').dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  const chip = event.target.closest('[data-say]');
  if (chip && !$('parseNotice').disabled) { $('noticeText').value = chip.dataset.say; $('noticeForm').requestSubmit(); return; }
  const timer = event.target.closest('[data-turn-timer]');
  if (timer) {
    if (timer.dataset.running) { window.clearInterval(Number(timer.dataset.running)); delete timer.dataset.running; timer.textContent = '开始 5 分钟'; return; }
    let left = 300;
    const tick = () => { timer.textContent = `还剩 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · 停下`; };
    tick();
    timer.dataset.running = String(window.setInterval(() => {
      left -= 1; tick();
      if (left <= 0) { window.clearInterval(Number(timer.dataset.running)); delete timer.dataset.running; timer.textContent = '再来 5 分钟'; tell('五分钟到了。想接着做就继续，停在这里也算开了头。'); }
    }, 1000));
    return;
  }
  const copy = event.target.closest('[data-turn-copy]');
  if (copy) {
    const draft = copy.parentElement.querySelector('[data-turn-draft]');
    navigator.clipboard?.writeText(draft.value).then(() => tell('起步草稿已复制。'), () => { draft.classList.remove('sr-only'); draft.select(); tell('草稿已选中，可以用复制快捷键。'); });
  }
});

/** What 研墨 answers after a sentence about one's state or an interruption. */
function stateReply(draft, state) {
  const said = escapeHTML(draftLabel(draft));
  const go = '<p class="inline-links"><a href="#/calendar" data-agenda-calendar>去画卷看</a></p>';
  if (!state || state.error) return `<p>${escapeHTML(state?.error || '没能重算。')}</p>`;
  if (state.applied) return `<p>记下了：${said}。原来的安排不用动，截止都赶得上。</p>${state.starter ? `<p class="field-help">现在五分钟能做：${escapeHTML(state.starter.action)}</p>` : ''}`;
  if (state.preview?.status === 'infeasible') return `<p>记下了：${said}。照这样，截止前排不下：${escapeHTML((state.preview.missing_windows || []).map(gap => `「${gap.title}」还差 ${gap.shortfall_minutes} 分钟`).join('；'))}。</p>${go}`;
  return `<p>记下了：${said}。${escapeHTML(state.preview?.decision_reason || '')}</p><p class="inline-links"><a href="#/calendar" data-agenda-calendar class="primary-link">去画卷选方案</a></p>`;
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
  const { before, label, focusBefore, replan } = strategyUndo;
  strategyUndo = null;
  if (focusBefore) saveFocus(focusBefore, { render: false });
  if (replan) { replanState = null; stopStart(); flipFrom = workRects(); }
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
  rolledByMode[xieyiState.mode] = false;
  try { storage?.setItem(COVER_DAY_KEY, localDate(Date.now())); } catch { /* ignore storage restrictions */ }
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
// Touch & trackpad horizontal swipe flips between 工笔 ↔ 写意 without hijacking grid horizontal scroll.
(() => {
  const cal = $('calendarView');
  if (!cal) return;
  let touchStartX = 0;
  let touchStartY = 0;
  let lastWheelFlip = 0;
  cal.addEventListener('touchstart', e => {
    const t = e.touches?.[0];
    if (!t) return;
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }, { passive: true });
  cal.addEventListener('touchend', e => {
    if (document.documentElement.dataset.current !== 'calendar') return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.abs(dx) < 76 || Math.abs(dy) > 48) return;
    if (dx < 0 && xieyiState.mode === 'gongbi') flipScrollMode('xieyi', 'is-flip-next');
    else if (dx > 0 && xieyiState.mode === 'xieyi') flipScrollMode('gongbi', 'is-flip-prev');
  }, { passive: true });
  cal.addEventListener('wheel', e => {
    if (document.documentElement.dataset.current !== 'calendar') return;
    if (Math.abs(e.deltaX) < 52 || Math.abs(e.deltaY) > 22) return;
    const now = Date.now();
    if (now - lastWheelFlip < 650) return;
    const scroller = e.target instanceof Element ? e.target.closest('.cal-week, .xy-grid') : null;
    if (scroller && scroller.scrollWidth > scroller.clientWidth + 4) {
      if (e.deltaX > 0 && scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4) return;
      if (e.deltaX < 0 && scroller.scrollLeft > 4) return;
    }
    if (e.deltaX > 0 && xieyiState.mode === 'gongbi') { lastWheelFlip = now; flipScrollMode('xieyi', 'is-flip-next'); }
    else if (e.deltaX < 0 && xieyiState.mode === 'xieyi') { lastWheelFlip = now; flipScrollMode('gongbi', 'is-flip-prev'); }
  }, { passive: true });
})();
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
  if (event.detail !== 'calendar') {
    const showCover = !isPhoneViewport() && !hasSeenCoverToday();
    rolledByMode = { gongbi: showCover, xieyi: showCover };
    coverPaintedByMode = { gongbi: false, xieyi: false };
    return;
  }
  if (isPhoneViewport() || hasSeenCoverToday()) { rolledByMode.gongbi = false; rolledByMode.xieyi = false; }
  coverPaintedByMode = { gongbi: false, xieyi: false }; // paint the 山水 when the page is actually entered, even if it was redrawn off screen
  window.SixuRouter?.refreshArrows?.();
  if (calendarResult || xieyiState.mode === 'xieyi') renderCalendar();
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
function unpackVaultPayload(raw) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* fall through to parseTimeSnapshot for clear error */ }
  if (parsed && parsed._sixu_bundle === 1 && parsed.snapshot) {
    return {
      nextSnapshot: parseTimeSnapshot(JSON.stringify(parsed.snapshot)),
      nextXieyi: normalizeXieyiState(parsed.xieyi),
    };
  }
  return { nextSnapshot: parseTimeSnapshot(raw), nextXieyi: null };
}

$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 15000000) throw new Error('导入文件超过15MB，请缩小清单。');
    let raw = await file.text();
    if (isVaultCode(raw)) {
      const pass = window.prompt('这是司序加密恢复文件，请输入恢复口令：');
      if (pass === null) return;
      raw = await openVault(raw, pass);
    }
    const { nextSnapshot, nextXieyi } = unpackVaultPayload(raw);
    const hasData = snapshot.events.length || snapshot.tasks.length || snapshot.routines.length;
    if (hasData && !window.confirm('导入会替换当前清单。请先导出需要保留的内容，是否继续？')) return;
    if (nextXieyi) { xieyiState = nextXieyi; writeXieyi(storage, xieyiState); }
    calendarWeek = null;
    commit({ ...nextSnapshot, revision: snapshot.revision + 1 }, { unlock: true });
    syncLegacyXieyiNotes();
    save();
    renderAll();
    tell('已载入清单。旧版清单会自动转换成四层时间格式。');
  } catch (error) { tell(`导入未完成：${error.message}`, 'error'); }
  finally { event.target.value = ''; }
});
$('clearSnapshot').addEventListener('click', () => {
  if (!window.confirm('清空此浏览器中的当前清单？请先导出需要保留的内容。')) return;
  calendarWeek = null;
  replanState = null; // a waiting or in-flight replan belongs to the list being cleared
  stopStart();
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
// 路演案例 (the case in the design report and the deck), pinned to the roadshow itself: planning starts
// Tuesday 2026-11-24 14:15, the moment it is presented, so on stage "now" and the plan's start agree and
// no future-start pill shows. The fictional 摄影社 notice is for the next day: 说明会 Wed 25th 14:30–15:30
// overlaps 专业课 14:00–15:00 by 30 minutes; 报名表 (30 minutes) is due that day 18:00. Only 铺纸 is
// prepared and the notice is put in the box; the presenter still sends it, adds the estimate and decides.
const ROADSHOW = { day: '2026-11-24', at: '14:15', event: '2026-11-25' };
function photoClubCase() {
  const monday = weekStart(Date.parse(`${ROADSHOW.day}T12:00:00+08:00`));
  const wednesday = ROADSHOW.event;
  const [year, month, date] = wednesday.split('-').map(Number);
  const day = `${year}年${month}月${date}日`;
  const notice = `【摄影社招新通知】\n${day}14:30-15:30举行摄影社招新说明会（学活204）。\n${day}18:00前提交社团报名表。`;
  const window = DEFAULT_WINDOW.map((span, index) => index === 2 ? { start: '14:00', end: '18:00' } : span);
  let next = createTimeSnapshot({ referenceTime: `${ROADSHOW.day}T${ROADSHOW.at}:00+08:00` });
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
  const prepared = photoClubCase();
  calendarWeek = prepared.monday;
  commit({ ...prepared.snapshot, revision: snapshot.revision + 1 }, { unlock: !externalConflict && !storageLocked });
  $('noticeText').value = prepared.notice;
  $('noticeDate').value = prepared.wednesday;
  tell('已铺好虚构课表与作息，从路演时刻 11月24日 14:15 开始安排；招新通知（11月25日说明会）已放进砚池，点发送即可导入。');
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
$('backupVaultOpen')?.addEventListener('click', () => {
  $('settingsPanel').open = true;
  $('vaultSection')?.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
  $('vaultPassphrase')?.focus();
});
$('backupLater').addEventListener('click', () => { writeJSON(BACKUP_KEY, { ...backupState(), snoozed: localDate(Date.now()) }); $('backupNudge').hidden = true; });

$('makeVaultCode')?.addEventListener('click', async () => {
  try {
    const bundle = JSON.stringify({ _sixu_bundle: 1, snapshot: JSON.parse(serializeTimeSnapshot(snapshot)), xieyi: xieyiState });
    const code = await sealVault(bundle, $('vaultPassphrase').value);
    $('vaultCodeBox').value = code;
    const clock = new Date(Date.now() + OFFSET).toISOString().slice(11, 16);
    $('vaultStatus').textContent = `已生成加密恢复码（${code.length} 字符，${clock}，含四层清单、远山志与学休账卷），可复制发给微信“文件传输助手”。`;
    markBackedUp();
    tell('已生成本机加密恢复码，可直接复制保存。');
  } catch (error) {
    $('vaultStatus').textContent = error.message;
    tell(error.message, 'error');
  }
});
$('copyVaultCode')?.addEventListener('click', async () => {
  const code = $('vaultCodeBox').value.trim();
  if (!code) return tell('请先生成或粘贴加密恢复码。', 'warning');
  try { await navigator.clipboard.writeText(code); tell('加密恢复码已复制，可直接发给微信“文件传输助手”。'); }
  catch { $('vaultCodeBox').select(); tell('请用快捷键复制已选中的恢复码。', 'warning'); }
});
$('restoreVaultCode')?.addEventListener('click', async () => {
  try {
    const json = await openVault($('vaultCodeBox').value, $('vaultPassphrase').value);
    const { nextSnapshot, nextXieyi } = unpackVaultPayload(json);
    const hasData = snapshot.events.length || snapshot.tasks.length || snapshot.routines.length || xieyiState.goals.length || xieyiState.notes.length || xieyiState.logs.length;
    if (hasData && !window.confirm('还原加密恢复码会替换当前清单与手卷记录，是否继续？')) return;
    if (nextXieyi) { xieyiState = nextXieyi; writeXieyi(storage, xieyiState); }
    calendarWeek = null;
    commit({ ...nextSnapshot, revision: snapshot.revision + 1 }, { unlock: true });
    syncLegacyXieyiNotes();
    save();
    renderAll();
    $('vaultPassphrase').value = '';
    $('vaultStatus').textContent = '已从加密恢复码还原整份清单与手卷记录，并同步保存在当前浏览器。';
    tell('已从加密恢复码完整还原清单。');
  } catch (error) {
    $('vaultStatus').textContent = error.message;
    tell(`未能还原：${error.message}`, 'error');
  }
});
$('bindAutoBackup')?.addEventListener('click', async () => {
  if (!supportsLocalFileSync()) {
    const hint = '当前浏览器暂不支持目录文件直写，请使用上方的加密恢复码或“导出清单”。';
    $('autoBackupStatus').textContent = hint;
    return tell(hint, 'warning');
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: '司序-自动备份.json',
      types: [{ description: '司序清单 JSON', accept: { 'application/json': ['.json'] } }],
    });
    const raw = serializeTimeSnapshot(snapshot);
    const written = await writeLocalBackupFile(handle, raw);
    if (!written.ok) throw new Error(written.error);
    autoBackupHandle = handle;
    $('autoBackupStatus').textContent = `本地自动双写：已绑定 ${handle.name || '本地备份文件'}，之后每次改动都会自动同步写入。`;
    markBackedUp();
    tell('已绑定本地自动备份文件，此后每次修改都会双写保留。');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    $('autoBackupStatus').textContent = `绑定未完成：${error.message}`;
    tell(`绑定本地自动备份未完成：${error.message}`, 'error');
  }
});
$('requestPersist')?.addEventListener('click', async () => {
  const status = await requestPersistentStorage();
  await refreshPersistLabel();
  if (!status.supported) return tell('当前浏览器不支持主动申请持久存储，请使用加密恢复码备份。', 'warning');
  tell(status.persisted ? '已开启浏览器防清理保护。' : '浏览器暂未授予持久存储权限，建议结合加密恢复码保存。', status.persisted ? '' : 'warning');
});

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
const icsScope = document.createElement('select');
icsScope.id = 'icsScope';
icsScope.setAttribute('aria-label', '导出日历范围');
icsScope.innerHTML = '<option value="full">完整日程（课表+落笔+点墨与截止）</option><option value="alerts">仅点墨与截止提醒</option>';
const icsButton = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', id: 'exportIcsBtn', textContent: '加到手机日历' });
icsButton.addEventListener('click', downloadCalendar);
const remindNote = Object.assign(document.createElement('p'), { className: 'cal-remind-note', textContent: '页面开着时到点弹出提醒；关掉页面也要提醒，选“完整日程”或“仅点墨与截止”后点“加到手机日历”，即可把课表重复规律与排期一起导入手机日历。' });
remindBar.append(bell.element, leadPick, icsScope, icsButton, remindNote);

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
  const full = icsScope.value === 'full';
  const { text, count, breakdown } = icsCalendar(snapshot, {
    now: Date.now(),
    lead: remind.lead,
    calendarResult,
    includeRoutines: full,
    includeWork: full,
  });
  if (!count) return tell(full ? '当前没有可导出的课表、排期、截止或点墨，暂时不用加。' : '接下来60天里没有截止或点墨，暂时不用加。', 'warning');
  const url = window.URL.createObjectURL(new window.Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: full ? '司序-完整日程.ics' : '司序-截止与点墨.ics' });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 10000);
  const parts = [];
  if (breakdown?.routines) parts.push(`${breakdown.routines} 门底色课表`);
  if (breakdown?.work) parts.push(`${breakdown.work} 块落笔排期`);
  if (breakdown?.events) parts.push(`${breakdown.events} 处点墨/约定`);
  if (breakdown?.deadlines) parts.push(`${breakdown.deadlines} 项截止`);
  tell(`已生成 ${count} 项日历事件（${parts.join('、')}，各带提前${remind.lead === 60 ? '1小时' : `${remind.lead}分钟`}提醒）。打开该 .ics 文件选“全部添加”即可写入手机系统日历。`);
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
refreshPersistLabel();
if (recovered.error) tell(`本地清单未能读取：${recovered.error}。为保护原数据，当前修改暂不覆盖保存；请导入备份或明确清空后重建。`, 'warning');
else if (recovered.migrated) { tell('已把旧版清单转换成四层时间格式；旧数据仍保留在浏览器中，没有删除。'); save(); }
if (location.protocol === 'file:') tell('请通过本地HTTP服务打开此页面，直接打开文件无法完整加载编辑模块。', 'warning');
$('timetableText').value ||= '';
$('periodText').value = DEFAULT_PERIODS;
scheduleCalendar();

// ---- 案头伴读 · 焚香专注台（.86）----------------------------------------
const soundscape = createSoundscape(window);
const companion = {
  mode: 'study',
  scenePref: 'auto',
  durationMinutes: 45,
  remainingSeconds: 45 * 60,
  elapsedSeconds: 0,
  running: false,
  finished: false,
  selectedTaskId: '',
  customTitle: '',
  suggestion: null,
  audioLevels: { rain: 0, wind: 0, hearth: 0 },
  chimeOn: true,
  settlement: null,
  ledgerOpen: false,
  settingsOpen: false,
  round: 1,
};
let companionTimer = null;

function todayStudyLeisureStats() {
  const todayYmd = localDate(Date.now());
  let study = 0;
  let leisure = 0;
  for (const log of xieyiState.logs || []) {
    if (log.date !== todayYmd) continue;
    if (log.kind === 'study') study += log.minutes;
    else leisure += log.minutes;
  }
  return { study, leisure };
}

function stopCompanionTick() {
  if (companionTimer) { window.clearInterval(companionTimer); companionTimer = null; }
  companion.running = false;
}

function renderCompanion() {
  const stage = $('companionStage');
  if (!stage || stage.hidden) return;
  const todayYmd = localDate(Date.now());
  const activeTasks = (snapshot.tasks || []).filter(t => t.status === 'active');
  const todayNotes = activeTasks.filter(t => isPersonal(t) && !hasPersonalClock(t) && personalDay(t) === todayYmd);
  stage.innerHTML = companionMarkup({
    mode: companion.mode,
    scenePref: companion.scenePref,
    resolvedScene: resolveScene(companion.scenePref, Date.now()),
    mix: sceneMix(companion.scenePref, Date.now()),
    round: companion.round,
    settingsOpen: companion.settingsOpen,
    durationMinutes: companion.durationMinutes,
    remainingSeconds: companion.remainingSeconds,
    running: companion.running,
    finished: companion.finished,
    elapsedSeconds: companion.elapsedSeconds,
    selectedTaskId: companion.selectedTaskId,
    customTitle: companion.customTitle,
    suggestion: companion.suggestion,
    activeTasks,
    todayNotes,
    todayStats: todayStudyLeisureStats(),
    audioLevels: companion.audioLevels,
    chimeOn: companion.chimeOn,
    soundSupported: soundscape.isSupported(),
    settlement: companion.settlement,
    ledgerOpen: companion.ledgerOpen,
    ledgerHtml: companion.ledgerOpen ? ledgerMarkup({ state: xieyiState, result: calendarResult, start: shownWeek(), now: Date.now(), snapshot, compact: true }) : '',
  });
  syncCompanionFsLabel();
}
function syncCompanionFsLabel() {
  const btn = $('companionStage')?.querySelector('[data-cmp-fullscreen]');
  if (btn) btn.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
}

function resolveCompanionTitleAndTask() {
  let linkedTask = null;
  let linkedNote = null;
  if (companion.selectedTaskId.startsWith('task:')) {
    linkedTask = snapshot.tasks.find(t => t.id === companion.selectedTaskId.slice(5)) || null;
  } else if (companion.selectedTaskId.startsWith('note:')) {
    linkedNote = xieyiState.notes.find(n => n.id === companion.selectedTaskId.slice(5)) || null;
  }
  const title = companion.customTitle.trim() || linkedTask?.title || linkedNote?.title || (companion.mode === 'study' ? '案头砚耕' : '听雨休歇');
  return { title, linkedTask };
}

function completeCompanionSession({ early = false } = {}) {
  stopCompanionTick();
  const loggedMinutes = early ? Math.max(1, Math.round(companion.elapsedSeconds / 60)) : companion.durationMinutes;
  const { title, linkedTask } = resolveCompanionTitleAndTask();
  const date = localDate(Date.now());
  let nextXieyi = addTimeLog(xieyiState, {
    kind: companion.mode,
    title,
    minutes: loggedMinutes,
    date,
    taskId: linkedTask?.id || null,
    source: 'focus',
  });
  let calibrationNote = '';
  if (companion.mode === 'study' && linkedTask) {
    estimateMemory = recordActual(estimateMemory, linkedTask.title, loggedMinutes);
    writeMemory(storage, estimateMemory);
    if (linkedTask.estimate_minutes) {
      writeCalibration(storage, recordCalibration(readCalibration(storage), linkedTask.title, linkedTask.estimate_minutes, loggedMinutes));
      calibrationNote = '，并同步校准耗时记忆';
    }
  }
  xieyiState = normalizeXieyiState(nextXieyi);
  writeXieyi(storage, xieyiState);
  renderCalendar();

  companion.finished = true;
  if (companion.mode === 'study') companion.round += 1;
  companion.settlement = {
    mode: companion.mode,
    minutes: loggedMinutes,
    summary: `已将「${title}」${loggedMinutes} 分钟记入${companion.mode === 'study' ? '砚耕' : '闲暇'}账卷${calibrationNote}。`,
  };
  if (companion.chimeOn) soundscape.playChime();
  renderCompanion();
}

function startCompanionTick() {
  stopCompanionTick();
  companion.running = true;
  companion.settingsOpen = false;
  companion.finished = false;
  companion.settlement = null;
  companionTimer = window.setInterval(() => {
    companion.elapsedSeconds += 1;
    companion.remainingSeconds = Math.max(0, companion.remainingSeconds - 1);
    const totalSec = Math.max(60, companion.durationMinutes * 60);
    const progress = Math.max(0, Math.min(1, 1 - companion.remainingSeconds / totalSec));
    const clockEl = $('cmpClock');
    const fillEl = $('cmpIncenseFill');
    const whisperEl = $('cmpWhisper');
    const finishBtn = $('companionStage')?.querySelector('[data-cmp-finish]');
    if (clockEl) clockEl.textContent = formatClock(companion.remainingSeconds);
    if (fillEl) fillEl.style.width = `${Math.max(0, Math.min(100, (1 - progress) * 100)).toFixed(2)}%`;
    if (whisperEl) whisperEl.textContent = companionWhisper({ mode: companion.mode, progress, running: true, finished: false });
    if (finishBtn) finishBtn.disabled = false;
    if (companion.elapsedSeconds % 30 === 0) {
      const card = $('companionStage')?.querySelector('.cmp-card');
      const mixNow = sceneMix(companion.scenePref, Date.now());
      card?.style.setProperty('--night', mixNow.night);
      card?.style.setProperty('--dusk', mixNow.dusk);
    }
    if (companion.remainingSeconds <= 0) completeCompanionSession({ early: false });
  }, 1000);
  renderCompanion();
}

function openCompanionModal() {
  const stage = $('companionStage');
  if (!stage) return;
  companion.suggestion = suggestGapSession(calendarResult, Date.now());
  if (!companion.running && companion.elapsedSeconds === 0 && !companion.finished) {
    companion.durationMinutes = companion.suggestion.minutes || 45;
    companion.remainingSeconds = companion.durationMinutes * 60;
    if (companion.suggestion.taskId && !companion.selectedTaskId) {
      companion.selectedTaskId = `task:${companion.suggestion.taskId}`;
    }
  }
  stage.hidden = false;
  renderCompanion();
  stage.querySelector('[data-cmp-toggle]')?.focus();
}

function closeCompanionModal() {
  stopCompanionTick();
  soundscape.stopAll();
  companion.audioLevels = { rain: 0, wind: 0, hearth: 0 };
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  const stage = $('companionStage');
  if (stage) { stage.hidden = true; stage.innerHTML = ''; }
}

$('openCompanion')?.addEventListener('click', openCompanionModal);
// 伴读画面随真实天色缓缓流转：打开期间每分钟刷新一次昼夜混合比例。
window.setInterval(() => {
  const card = $('companionStage') && !$('companionStage').hidden ? $('companionStage').querySelector('.cmp-card') : null;
  if (!card) return;
  const mixNow = sceneMix(companion.scenePref, Date.now());
  card.style.setProperty('--night', mixNow.night);
  card.style.setProperty('--dusk', mixNow.dusk);
}, 60000);
document.addEventListener('fullscreenchange', syncCompanionFsLabel);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.fullscreenElement && $('companionStage') && !$('companionStage').hidden) closeCompanionModal();
});
$('companionStage')?.addEventListener('click', event => {
  if (event.target === $('companionStage') || event.target.closest('[data-cmp-close]')) { closeCompanionModal(); return; }
  if (event.target.closest('[data-cmp-fullscreen]')) {
    const stage = $('companionStage');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else stage?.requestFullscreen?.().catch(() => {});
    return;
  }
  const modeBtn = event.target.closest('button[data-cmp-mode]');
  if (modeBtn) {
    stopCompanionTick();
    companion.mode = modeBtn.dataset.cmpMode === 'leisure' ? 'leisure' : 'study';
    companion.durationMinutes = companion.mode === 'leisure' ? 20 : (companion.suggestion?.minutes || 45);
    companion.remainingSeconds = companion.durationMinutes * 60;
    companion.elapsedSeconds = 0;
    companion.finished = false;
    companion.settlement = null;
    renderCompanion();
    return;
  }
  const sceneBtn = event.target.closest('[data-cmp-scene]');
  if (sceneBtn) {
    companion.scenePref = sceneBtn.dataset.cmpScene;
    renderCompanion();
    return;
  }
  const gapBtn = event.target.closest('[data-cmp-adopt-gap]');
  if (gapBtn) {
    stopCompanionTick();
    companion.durationMinutes = Number(gapBtn.dataset.cmpAdoptGap) || 45;
    companion.remainingSeconds = companion.durationMinutes * 60;
    companion.elapsedSeconds = 0;
    companion.finished = false;
    companion.settlement = null;
    renderCompanion();
    return;
  }
  const minBtn = event.target.closest('[data-cmp-minutes]');
  if (minBtn) {
    stopCompanionTick();
    companion.durationMinutes = Number(minBtn.dataset.cmpMinutes) || 45;
    companion.remainingSeconds = companion.durationMinutes * 60;
    companion.elapsedSeconds = 0;
    companion.finished = false;
    companion.settlement = null;
    renderCompanion();
    return;
  }
  if (event.target.closest('[data-cmp-toggle]')) {
    if (companion.running) { stopCompanionTick(); renderCompanion(); }
    else {
      if (companion.finished) {
        companion.remainingSeconds = companion.durationMinutes * 60;
        companion.elapsedSeconds = 0;
      }
      startCompanionTick();
    }
    return;
  }
  if (event.target.closest('[data-cmp-finish]')) {
    if (companion.elapsedSeconds > 0 || companion.finished) completeCompanionSession({ early: !companion.finished });
    return;
  }
  if (event.target.closest('[data-cmp-reset]')) {
    stopCompanionTick();
    companion.remainingSeconds = companion.durationMinutes * 60;
    companion.elapsedSeconds = 0;
    companion.finished = false;
    companion.settlement = null;
    renderCompanion();
    return;
  }
  const switchRest = event.target.closest('[data-cmp-switch-rest]');
  if (switchRest) {
    stopCompanionTick();
    companion.mode = 'leisure';
    companion.durationMinutes = Number(switchRest.dataset.cmpSwitchRest) || 10;
    companion.remainingSeconds = companion.durationMinutes * 60;
    companion.elapsedSeconds = 0;
    companion.finished = false;
    companion.settlement = null;
    startCompanionTick();
    return;
  }
  const switchStudy = event.target.closest('[data-cmp-switch-study]');
  if (switchStudy) {
    stopCompanionTick();
    companion.mode = 'study';
    companion.durationMinutes = companion.suggestion?.minutes || Number(switchStudy.dataset.cmpSwitchStudy) || 45;
    companion.remainingSeconds = companion.durationMinutes * 60;
    companion.elapsedSeconds = 0;
    companion.finished = false;
    companion.settlement = null;
    renderCompanion();
    return;
  }
  if (event.target.closest('[data-cmp-again]')) {
    stopCompanionTick();
    companion.remainingSeconds = companion.durationMinutes * 60;
    companion.elapsedSeconds = 0;
    companion.finished = false;
    companion.settlement = null;
    renderCompanion();
    return;
  }
  if (event.target.closest('[data-cmp-settings]')) {
    companion.settingsOpen = !companion.settingsOpen;
    renderCompanion();
    return;
  }
  if (event.target.closest('[data-cmp-ledger-toggle]')) {
    companion.ledgerOpen = !companion.ledgerOpen;
    renderCompanion();
    return;
  }
  const presetBtn = event.target.closest('[data-xy-log-preset]');
  if (presetBtn) {
    const form = presetBtn.closest('[data-xy-log-form]');
    const input = form?.querySelector('input[name="minutes"]');
    if (input) input.value = presetBtn.dataset.xyLogPreset;
    return;
  }
  const logDelBtn = event.target.closest('[data-xy-log-del]');
  if (logDelBtn) {
    commitXieyi(removeTimeLog(xieyiState, logDelBtn.dataset.xyLogDel));
    renderCompanion();
  }
});
$('companionStage')?.addEventListener('submit', event => {
  const logForm = event.target.closest('[data-xy-log-form]');
  if (!logForm) return;
  event.preventDefault();
  handleXieyiLogSubmit(logForm);
});
$('companionStage')?.addEventListener('input', event => {
  if (event.target.id === 'cmpTitleInput') companion.customTitle = event.target.value;
  const slider = event.target.closest('[data-cmp-sound]');
  if (slider) {
    const val = Number(slider.value) / 100;
    companion.audioLevels[slider.dataset.cmpSound] = val;
    soundscape.setChannel(slider.dataset.cmpSound, val);
  }
});
$('companionStage')?.addEventListener('change', event => {
  if (event.target.id === 'cmpTaskSelect') companion.selectedTaskId = event.target.value;
  if (event.target.matches('[data-cmp-chime]')) companion.chimeOn = event.target.checked;
});
