import { isTimestamp, parseSnapshot, STORAGE_KEY as V2_STORAGE_KEY } from './task-state.js';

/**
 * Four-layer time list (snapshot v3, see backend docs/time_layers_v3.md).
 * Imported items are used at once; missing values stay null ("undefined") and
 * never block other items. Every change returns a new snapshot with a higher
 * revision. The backend re-validates everything; checks here only stop
 * obviously wrong edits from being saved.
 */
export const TIME_STORAGE_KEY = 'sixu.time-snapshot.v3';
export const MAX_TIME_SNAPSHOT_BYTES = 15000000;
export const ESTIMATE_PRESETS = [
  { minutes: 15, label: '15分钟' }, { minutes: 30, label: '30分钟' }, { minutes: 60, label: '1小时' },
  { minutes: 120, label: '2小时' }, { minutes: 240, label: '半天' },
];
const TASK_FIELDS = ['title', 'deadline_at', 'estimate_minutes', 'splittable', 'min_block_minutes', 'earliest_start_at', 'priority', 'status', 'location', 'materials'];
const EVENT_FIELDS = ['title', 'start_at', 'end_at', 'location', 'status'];
const EVIDENCE_FIELDS = new Set(['title', 'start_at', 'end_at', 'deadline_at', 'earliest_start_at', 'estimate_minutes', 'location', 'materials']);
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const newId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) || `${Date.now()}${Math.random().toString(36).slice(2, 8)}`}`;
const nullableTime = (value, label) => { if (value !== null && !isTimestamp(value)) fail(`${label}需要完整的日期和时刻`); };
const title = value => { if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('名称不能为空，最多200字'); return value.trim(); };

export function createTimeSnapshot({ referenceTime }) {
  if (!isTimestamp(referenceTime)) fail('计算起点需要完整的日期和时刻');
  return { schema_version: 3, revision: 0, timezone: 'Asia/Shanghai', reference_time: referenceTime, sources: [],
    daily_window: null, routines_confirmed: false, routines: [], free_adjustments: [], events: [], tasks: [] };
}

function change(snapshot, mutate) {
  const next = clone(snapshot);
  mutate(next);
  next.revision = snapshot.revision + 1;
  return next;
}

function requireShape(snapshot) {
  const keys = ['schema_version', 'revision', 'timezone', 'reference_time', 'sources', 'daily_window', 'routines_confirmed', 'routines', 'free_adjustments', 'events', 'tasks'];
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schema_version !== 3) fail('清单不是v3格式');
  if (keys.some(key => !Object.hasOwn(snapshot, key))) fail('清单缺少必要字段');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !isTimestamp(snapshot.reference_time)) fail('清单的版本号或计算起点无效');
  for (const key of ['sources', 'routines', 'free_adjustments', 'events', 'tasks']) if (!Array.isArray(snapshot[key])) fail(`清单的${key}必须是列表`);
}

export function serializeTimeSnapshot(snapshot) {
  requireShape(snapshot);
  const text = JSON.stringify(snapshot, null, 2);
  if (new TextEncoder().encode(text).length > MAX_TIME_SNAPSHOT_BYTES) fail('清单超过15MB，请导出后拆分');
  return text;
}

export function parseTimeSnapshot(text) {
  if (typeof text !== 'string') fail('导入内容必须是JSON文本');
  let data;
  try { data = JSON.parse(text); } catch { fail('无法读取清单JSON，请检查文件内容'); }
  if (data?.schema_version === 2) return migrateV2(parseSnapshot(text));
  requireShape(data);
  return data;
}

/** Read the v3 list; if only a v2 list exists, convert it in memory and leave the v2 bytes as they are. */
export function readTimeSnapshot(storage) {
  let raw = null;
  try {
    raw = storage.getItem(TIME_STORAGE_KEY);
    if (raw !== null) return { snapshot: parseTimeSnapshot(raw), raw, error: null, migrated: false };
    const old = storage.getItem(V2_STORAGE_KEY);
    if (old === null) return { snapshot: null, raw: null, error: null, migrated: false };
    return { snapshot: migrateV2(parseSnapshot(old)), raw: null, error: null, migrated: true };
  } catch (error) {
    return { snapshot: null, raw, error: error.message || '浏览器存储不可用', migrated: false };
  }
}

function v3Evidence(evidence, map) {
  return evidence.filter(item => map[item.field] && (item.origin !== 'source_text' || item.quote))
    .map(item => ({ field: map[item.field], origin: item.origin, source_id: item.source_id, quote: item.quote }));
}

export function migrateV2(v2) {
  const v3 = createTimeSnapshot({ referenceTime: v2.reference_time });
  v3.sources = clone(v2.sources);
  v3.free_adjustments = (v2.availability || []).map((interval, index) => ({ id: `a-migrated-${index + 1}`, kind: 'add', start_at: interval.start, end_at: interval.end, note: '从旧版空闲时段转换' }));
  const status = task => ['completed', 'cancelled'].includes(task.status) ? task.status : 'active';
  for (const task of v2.tasks) {
    const notes = [...task.uncertainties];
    if (task.kind === 'fixed') {
      const map = { title: 'title', fixed_start_at: 'start_at', fixed_end_at: 'end_at', location: 'location' };
      v3.events.push({ id: task.id, title: task.title.trim() || '未命名活动', start_at: task.fixed_start_at, end_at: task.fixed_start_at ? task.fixed_end_at : null,
        location: task.location, status: task.status === 'cancelled' ? 'cancelled' : 'active', source_id: task.source_id, evidence: v3Evidence(task.evidence, map), notes });
      continue;
    }
    const window = task.kind === 'visit_window' ? task.visit_windows?.[0] : null;
    if (window) notes.push('这是办理窗口，可在开始与结束之间任选时间完成。');
    const map = { title: 'title', deadline_at: 'deadline_at', earliest_start_at: 'earliest_start_at', location: 'location', materials: 'materials', remaining_minutes: 'estimate_minutes' };
    v3.tasks.push({ id: task.id, title: task.title.trim() || '未命名事项', deadline_at: window ? window.end : task.deadline_at,
      estimate_minutes: task.kind === 'flexible' && task.remaining_minutes > 0 ? task.remaining_minutes : null,
      splittable: task.splittable !== false, min_block_minutes: task.splittable === false ? null : task.min_block_minutes,
      earliest_start_at: window ? window.start : task.earliest_start_at, priority: task.priority, status: status(task),
      location: task.location, materials: clone(task.materials), source_id: task.source_id, evidence: v3Evidence(task.evidence, map), notes });
  }
  return v3;
}

function edited(item, field) {
  if (!EVIDENCE_FIELDS.has(field)) return;
  item.evidence = [...item.evidence.filter(entry => entry.field !== field), { field, origin: 'user_input', source_id: null, quote: null }];
}

function find(snapshot, key, id) {
  const item = snapshot[key].find(entry => entry.id === id);
  if (!item) fail('没有找到这一项，可能已被删除');
  return item;
}

export function addImported(snapshot, { source, events = [], tasks = [] }) {
  return change(snapshot, next => {
    if (source && !next.sources.some(entry => entry.id === source.id || entry.text === source.text)) next.sources.push(clone(source));
    const sourceId = source && next.sources.find(entry => entry.text === source.text)?.id;
    const adopt = item => ({ ...clone(item), source_id: item.source_id === source?.id ? sourceId : item.source_id,
      evidence: item.evidence.map(entry => entry.source_id === source?.id ? { ...entry, source_id: sourceId } : entry) });
    next.events.push(...events.map(adopt));
    next.tasks.push(...tasks.map(adopt));
  });
}

function checkTask(task) {
  title(task.title);
  nullableTime(task.deadline_at, '截止');
  nullableTime(task.earliest_start_at, '最早开始');
  if (task.estimate_minutes !== null && !(Number.isSafeInteger(task.estimate_minutes) && task.estimate_minutes >= 1 && task.estimate_minutes <= 20160)) fail('预计用时需要是1到20160之间的整数分钟');
  if (task.min_block_minutes !== null && !(Number.isSafeInteger(task.min_block_minutes) && task.min_block_minutes >= 1 && task.min_block_minutes <= 1440)) fail('每次至少连续的分钟数无效');
  if (task.priority !== null && !(Number.isSafeInteger(task.priority) && task.priority >= 0 && task.priority <= 100)) fail('优先级需要是0到100的整数');
  if (typeof task.splittable !== 'boolean') fail('请说明能否拆开做');
  if (!['active', 'completed', 'cancelled'].includes(task.status)) fail('状态无效');
  if (task.deadline_at && task.earliest_start_at && Date.parse(task.earliest_start_at) >= Date.parse(task.deadline_at)) fail('最早开始要早于截止');
}

function checkEvent(event) {
  title(event.title);
  nullableTime(event.start_at, '开始');
  nullableTime(event.end_at, '结束');
  if (event.end_at && !event.start_at) fail('有结束时间时也需要开始时间');
  if (event.start_at && event.end_at && Date.parse(event.end_at) <= Date.parse(event.start_at)) fail('结束要晚于开始');
  if (!['active', 'cancelled'].includes(event.status)) fail('状态无效');
}

export function updateTask(snapshot, id, patch) {
  for (const field of Object.keys(patch)) if (!TASK_FIELDS.includes(field)) fail(`不能修改字段${field}`);
  return change(snapshot, next => {
    const task = find(next, 'tasks', id);
    Object.assign(task, clone(patch));
    if (typeof task.title === 'string') task.title = task.title.trim();
    checkTask(task);
    for (const field of Object.keys(patch)) edited(task, field);
  });
}

export function updateEvent(snapshot, id, patch) {
  for (const field of Object.keys(patch)) if (!EVENT_FIELDS.includes(field)) fail(`不能修改字段${field}`);
  return change(snapshot, next => {
    const event = find(next, 'events', id);
    Object.assign(event, clone(patch));
    if (typeof event.title === 'string') event.title = event.title.trim();
    checkEvent(event);
    for (const field of Object.keys(patch)) edited(event, field);
  });
}

export function addTask(snapshot, fields = {}) {
  const task = { id: newId('t'), title: '', deadline_at: null, estimate_minutes: null, splittable: true, min_block_minutes: null, earliest_start_at: null,
    priority: null, status: 'active', location: null, materials: [], source_id: null, evidence: [], notes: [], ...clone(fields) };
  checkTask(task);
  return change(snapshot, next => { next.tasks.push(task); });
}

export function addEvent(snapshot, fields = {}) {
  const event = { id: newId('e'), title: '', start_at: null, end_at: null, location: null, status: 'active', source_id: null, evidence: [], notes: [], ...clone(fields) };
  checkEvent(event);
  return change(snapshot, next => { next.events.push(event); });
}

export function removeItem(snapshot, id) {
  return change(snapshot, next => {
    for (const key of ['events', 'tasks', 'routines', 'free_adjustments']) next[key] = next[key].filter(item => item.id !== id);
  });
}

export function setDailyWindow(snapshot, windows) {
  if (windows !== null) {
    if (!Array.isArray(windows) || windows.length !== 7) fail('作息范围需要周一到周日7天');
    for (const window of windows) {
      if (window === null) continue;
      if (!CLOCK.test(window?.start || '') || !CLOCK.test(window?.end || '')) fail('作息时刻需要HH:MM');
      if (window.end <= window.start) fail('每天的结束要晚于开始');
    }
  }
  return change(snapshot, next => { next.daily_window = windows === null ? null : windows.map(window => window && { start: window.start, end: window.end }); });
}

export function addRoutine(snapshot, fields) {
  const routine = { id: newId('r'), until: null, week_interval: 1, skip_dates: [], location: null, source_id: null, ...clone(fields) };
  title(routine.title);
  if (!Array.isArray(routine.weekdays) || !routine.weekdays.length || routine.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) fail('请至少选择一个星期');
  routine.weekdays = [...new Set(routine.weekdays)].sort();
  if (!CLOCK.test(routine.start || '') || !CLOCK.test(routine.end || '') || routine.end <= routine.start) fail('例行占用的结束要晚于开始');
  if (!DATE.test(routine.from || '') || (routine.until !== null && (!DATE.test(routine.until) || routine.until < routine.from))) fail('例行占用的起止日期无效');
  if (![1, 2].includes(routine.week_interval)) fail('只支持每周或隔周');
  return change(snapshot, next => { next.routines.push(routine); next.routines_confirmed = true; });
}

export function setRoutinesConfirmed(snapshot, value) {
  return change(snapshot, next => { next.routines_confirmed = Boolean(value); });
}

export function addAdjustment(snapshot, fields) {
  const adjustment = { id: newId('a'), note: null, ...clone(fields) };
  if (!['add', 'remove'].includes(adjustment.kind)) fail('调整只能是增加或扣除');
  if (!isTimestamp(adjustment.start_at) || !isTimestamp(adjustment.end_at) || Date.parse(adjustment.end_at) <= Date.parse(adjustment.start_at)) fail('调整的结束要晚于开始');
  return change(snapshot, next => { next.free_adjustments.push(adjustment); });
}

export function addTimetable(snapshot, { source, routines }) {
  return change(snapshot, next => {
    if (!next.sources.some(entry => entry.id === source.id)) next.sources.push(clone(source));
    next.routines.push(...clone(routines));
    next.routines_confirmed = true;
  });
}

export function setReferenceTime(snapshot, iso) {
  if (!isTimestamp(iso)) fail('计算起点需要完整的日期和时刻');
  return change(snapshot, next => { next.reference_time = iso; });
}
