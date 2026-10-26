/**
 * One immutable, browser-owned task snapshot. This module performs local draft
 * structure checks, not the backend's full semantic or feasibility validation.
 * Every successful mutation advances revision, so asynchronous output is never
 * evidence about inputs edited after that request began.
 */
export const STORAGE_KEY = 'sixu.task-snapshot.v2';
export const MAX_SNAPSHOT_BYTES = 15000000;
const KINDS = new Set(['flexible', 'fixed', 'visit_window', 'milestone']);
const STATUSES = new Set(['draft', 'confirmed', 'scheduled', 'in_progress', 'completed', 'cancelled']);
const SOURCE_KINDS = new Set(['pasted_notice', 'manual', 'synthetic']);
const EVIDENCE_FIELDS = new Set(['title', 'kind', 'earliest_start_at', 'deadline_at', 'fixed_start_at', 'fixed_end_at', 'visit_windows', 'remaining_minutes', 'location', 'materials', 'must_do', 'priority', 'depends_on']);
const TIMESTAMP_FIELDS = ['earliest_start_at', 'deadline_at', 'fixed_start_at', 'fixed_end_at'];
const TASK_FIELDS = ['id', 'source_id', 'title', 'kind', 'status', ...TIMESTAMP_FIELDS, 'visit_windows', 'remaining_minutes', 'splittable', 'min_block_minutes', 'must_do', 'priority', 'location', 'materials', 'depends_on', 'confirmed_fields', 'evidence', 'uncertainties'];
const EDITABLE_FIELDS = new Set(TASK_FIELDS.filter(key => !['id', 'status', 'confirmed_fields', 'evidence'].includes(key)));
const SOURCE_FIELDS = ['id', 'kind', 'text', 'published_at'];
let fallbackId = 0;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const charLength = value => Array.from(value).length;
const nonempty = (value, max = Infinity) => typeof value === 'string' && value.trim().length > 0 && (max === Infinity || charLength(value) <= max);
const id = value => nonempty(value, 100);
const nullable = (value, predicate) => value === null || predicate(value);
const uniqueStrings = (value, maxLength = Infinity) => Array.isArray(value) && value.every(item => nonempty(item, maxLength)) && new Set(value).size === value.length;
const sameValue = (left, right) => Object.is(left, right) || ((Array.isArray(left) && Array.isArray(right) || object(left) && object(right)) && JSON.stringify(left) === JSON.stringify(right));

function makeId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now().toString(36)}-${++fallbackId}`}`;
}

/** Require explicit offset and reject calendar rollover such as February 30. */
export function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, minute, second, offset, , oh, om] = match;
  const [year, month, day, hour, min, sec] = [y, m, d, h, minute, second].map(Number);
  const days = new Date(Date.UTC(year < 100 ? year + 400 : year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && min <= 59 && sec <= 59 && (offset === 'Z' || (Number(oh) <= 23 && Number(om) <= 59)) && Number.isFinite(Date.parse(value));
}

function fail(message, errors = [message]) {
  const error = new Error(message);
  error.name = 'TaskStateError';
  error.errors = errors;
  throw error;
}

function fields(value, required, path, errors, optional = []) {
  if (!object(value)) { errors.push(`${path}必须是对象`); return false; }
  for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}缺少${key}`);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) errors.push(`${path}包含未知字段${key}`);
  return true;
}

function checkIntervals(intervals, path, errors, limit) {
  if (!Array.isArray(intervals) || intervals.length > limit) { errors.push(`${path}必须是最多${limit}个区间的数组`); return; }
  intervals.forEach((interval, index) => {
    const name = `${path}[${index}]`;
    if (!fields(interval, ['start', 'end'], name, errors)) return;
    if (!isTimestamp(interval.start) || !isTimestamp(interval.end)) errors.push(`${name}需要带时区的合法起止时间`);
    else if (Date.parse(interval.start) >= Date.parse(interval.end)) errors.push(`${name}结束必须晚于开始`);
  });
}

function checkSource(source, path, errors) {
  if (!fields(source, SOURCE_FIELDS, path, errors)) return;
  if (!id(source.id)) errors.push(`${path}.id无效`);
  if (!SOURCE_KINDS.has(source.kind)) errors.push(`${path}.kind无效`);
  if (!nonempty(source.text, 100000)) errors.push(`${path}.text必须为1至100000字的文本`);
  if (!nullable(source.published_at, isTimestamp)) errors.push(`${path}.published_at需要带时区的时间或null`);
}

function checkTask(task, path, errors) {
  if (!fields(task, TASK_FIELDS, path, errors)) return;
  if (!id(task.id)) errors.push(`${path}.id无效`);
  if (!nullable(task.source_id, id)) errors.push(`${path}.source_id无效`);
  // A half-typed draft may be saved locally. It cannot be confirmed or calculated.
  if (typeof task.title !== 'string' || charLength(task.title) > 200 || (task.status !== 'draft' && !task.title.trim())) errors.push(`${path}.title无效`);
  if (!KINDS.has(task.kind)) errors.push(`${path}.kind无效`);
  if (!STATUSES.has(task.status)) errors.push(`${path}.status无效`);
  for (const key of TIMESTAMP_FIELDS) if (!nullable(task[key], isTimestamp)) errors.push(`${path}.${key}需要带时区的合法时间或null`);
  for (const [key, min, max] of [['remaining_minutes', 0, 10000000], ['min_block_minutes', 1, 10000000], ['priority', 0, 100]]) {
    if (!nullable(task[key], value => Number.isSafeInteger(value) && value >= min && value <= max)) errors.push(`${path}.${key}数值无效`);
  }
  for (const key of ['splittable', 'must_do']) if (!nullable(task[key], value => typeof value === 'boolean')) errors.push(`${path}.${key}必须是布尔值或null`);
  if (!nullable(task.location, value => typeof value === 'string' && charLength(value) <= 500)) errors.push(`${path}.location无效`);
  for (const key of ['materials', 'uncertainties', 'confirmed_fields']) if (!uniqueStrings(task[key])) errors.push(`${path}.${key}必须是不重复的非空文本数组`);
  if (!uniqueStrings(task.depends_on, 100)) errors.push(`${path}.depends_on无效`);
  checkIntervals(task.visit_windows, `${path}.visit_windows`, errors, 100);
  if (!Array.isArray(task.evidence) || task.evidence.length > 1000) errors.push(`${path}.evidence无效`);
  else task.evidence.forEach((evidence, index) => {
    const label = `${path}.evidence[${index}]`;
    if (!fields(evidence, ['field', 'origin', 'source_id', 'quote'], label, errors)) return;
    if (!EVIDENCE_FIELDS.has(evidence.field)) errors.push(`${label}.field无效`);
    if (!['source_text', 'user_input', 'inferred'].includes(evidence.origin)) errors.push(`${label}.origin无效`);
    if (!nullable(evidence.source_id, id)) errors.push(`${label}.source_id无效`);
    if (!nullable(evidence.quote, value => typeof value === 'string' && charLength(value) <= 3000)) errors.push(`${label}.quote无效`);
    if (evidence.origin === 'source_text' && (!id(evidence.source_id) || !nonempty(evidence.quote, 3000))) errors.push(`${label}原文依据需要来源和原文片段`);
  });
  if (task.status === 'completed' && task.remaining_minutes !== 0) errors.push(`${path}已完成任务剩余时间必须为0`);
  if (task.kind === 'milestone' && task.remaining_minutes !== 0) errors.push(`${path}截止节点不计工作量`);
}

/** Local editable-draft checks. Backend remains authoritative for semantics. */
export function validateSnapshot(snapshot) {
  const errors = [];
  if (!fields(snapshot, ['schema_version', 'revision', 'timezone', 'reference_time', 'sources', 'tasks', 'availability'], '快照', errors, ['label', 'availability_confirmed'])) return { valid: false, errors };
  if (snapshot.schema_version !== 2) errors.push('仅支持schema_version=2');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) errors.push('revision必须是非负安全整数');
  if (snapshot.timezone !== 'Asia/Shanghai') errors.push('timezone必须是Asia/Shanghai');
  if (!isTimestamp(snapshot.reference_time)) errors.push('reference_time需要带时区的合法时间');
  if (Object.hasOwn(snapshot, 'label') && (typeof snapshot.label !== 'string' || charLength(snapshot.label) > 200)) errors.push('label最长200字');
  if (Object.hasOwn(snapshot, 'availability_confirmed') && typeof snapshot.availability_confirmed !== 'boolean') errors.push('availability_confirmed必须是布尔值');
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length > 100) errors.push('sources必须是最多100个来源的数组');
  else {
    snapshot.sources.forEach((source, index) => checkSource(source, `sources[${index}]`, errors));
    if (new Set(snapshot.sources.map(source => source?.id)).size !== snapshot.sources.length) errors.push('来源ID不能重复');
  }
  if (!Array.isArray(snapshot.tasks) || snapshot.tasks.length > 200) errors.push('tasks必须是最多200个任务的数组');
  else {
    snapshot.tasks.forEach((task, index) => checkTask(task, `tasks[${index}]`, errors));
    if (new Set(snapshot.tasks.map(task => task?.id)).size !== snapshot.tasks.length) errors.push('任务ID不能重复');
  }
  checkIntervals(snapshot.availability, 'availability', errors, 200);
  return { valid: errors.length === 0, errors };
}

function requireSnapshot(snapshot) {
  const result = validateSnapshot(snapshot);
  if (!result.valid) fail('任务快照格式无效', result.errors);
}

function change(snapshot, apply) {
  requireSnapshot(snapshot);
  if (snapshot.revision === Number.MAX_SAFE_INTEGER) fail('revision已超出范围，请导出后重新建立快照');
  const next = clone(snapshot);
  apply(next);
  next.revision += 1;
  requireSnapshot(next);
  // Reject oversized edits before they become the one in-memory truth: an
  // accepted revision must remain serializable for local backup and requests.
  requireByteBudget(JSON.stringify(next, null, 2), '任务清单');
  return next;
}

function findTask(snapshot, taskId) {
  const task = snapshot.tasks.find(item => item.id === taskId);
  if (!task) fail('未找到对应任务');
  return task;
}

export function createSnapshot({ referenceTime = new Date().toISOString() } = {}) {
  const snapshot = { schema_version: 2, revision: 0, timezone: 'Asia/Shanghai', reference_time: referenceTime, sources: [], tasks: [], availability: [], availability_confirmed: false };
  requireSnapshot(snapshot);
  return snapshot;
}

export function createTask(kind = 'flexible', sourceId = null) {
  if (!KINDS.has(kind) || !nullable(sourceId, id)) fail('任务类型或来源ID无效');
  return {
    id: makeId('task'), source_id: sourceId, title: '', kind, status: 'draft',
    earliest_start_at: null, deadline_at: null, fixed_start_at: null, fixed_end_at: null,
    visit_windows: [], remaining_minutes: ['fixed', 'milestone'].includes(kind) ? 0 : null,
    splittable: null, min_block_minutes: null, must_do: null, priority: null,
    location: null, materials: [], depends_on: [], confirmed_fields: [], evidence: [], uncertainties: [],
  };
}

export function addSource(snapshot, source) {
  return change(snapshot, next => { next.sources.push(clone(source)); });
}

export function addTask(snapshot, task) {
  return change(snapshot, next => { next.tasks.push(clone(task)); });
}

export function editTask(snapshot, taskId, patch) {
  if (!object(patch) || Object.keys(patch).some(key => !EDITABLE_FIELDS.has(key))) fail('任务编辑包含只读或未知字段');
  requireSnapshot(snapshot);
  const original = findTask(snapshot, taskId);
  if (['completed', 'cancelled'].includes(original.status)) fail('已完成或已取消的任务需要先恢复为待核对，再修改内容');
  const changed = Object.keys(patch).filter(key => !sameValue(original[key], patch[key]));
  // A blur event with an unchanged value is not an edit and must not revoke a
  // confirmation or create another revision that an async result cannot match.
  if (!changed.length) return snapshot;
  return change(snapshot, next => {
    const task = findTask(next, taskId);
    Object.assign(task, clone(patch));
    if (changed.includes('kind')) {
      task.confirmed_fields = [];
      if (['fixed', 'milestone'].includes(task.kind)) task.remaining_minutes = 0;
    } else task.confirmed_fields = task.confirmed_fields.filter(key => !changed.includes(key));
    task.status = 'draft';
    for (const field of changed.filter(field => EVIDENCE_FIELDS.has(field))) {
      task.evidence = task.evidence.filter(item => !(item.field === field && item.origin === 'user_input'));
      task.evidence.push({ field, origin: 'user_input', source_id: null, quote: (typeof task[field] === 'string' ? task[field] : JSON.stringify(task[field])).slice(0, 3000) });
    }
  });
}

/** Explicit date review fills empty draft times; never overwrites user values. */
export function applyTimeReview(snapshot, taskId, patch, referenceDate) {
  if (typeof referenceDate !== 'string' || !isTimestamp(`${referenceDate}T00:00:00+08:00`)) fail('请选择有效的通知参照日期');
  if (!object(patch) || !Object.keys(patch).length) fail('没有可补全的时间字段');
  return change(snapshot, next => {
    const task = findTask(next, taskId);
    if (task.status !== 'draft') fail('只可补全待核对事项，不修改已确认或已完成事项');
    const allowed = task.kind === 'fixed' ? ['fixed_start_at', 'fixed_end_at'] : ['flexible', 'milestone'].includes(task.kind) ? ['deadline_at'] : [];
    if (Object.keys(patch).some(field => !allowed.includes(field) || task[field] !== null || !isTimestamp(patch[field]))) fail('补全只可写入空白时间，不覆盖已有输入');
    Object.assign(task, clone(patch));
    if (task.fixed_start_at && task.fixed_end_at && Date.parse(task.fixed_start_at) >= Date.parse(task.fixed_end_at)) fail('固定结束必须晚于开始');
    task.confirmed_fields = task.confirmed_fields.filter(field => !Object.hasOwn(patch, field));
    const note = `按你指定的通知参照日期 ${referenceDate} 解释原文时间，补全部分仍需核对；原文未给出的结束时间不会推测。`;
    task.uncertainties = [...new Set([note, ...task.uncertainties.filter(item => !item.includes('未提供 reference_date') && !item.includes('本次未采用为可计算时间'))])];
    for (const field of Object.keys(patch)) task.evidence.push({ field, origin: 'inferred', source_id: null, quote: `用户主动选择参照日期 ${referenceDate}，根据对应原文补全 ${patch[field]}，尚未确认。` });
  });
}

export function removeTask(snapshot, taskId) {
  return change(snapshot, next => {
    findTask(next, taskId);
    const dependents = next.tasks.filter(task => task.depends_on.includes(taskId));
    if (dependents.length) fail('请先移除其他任务对此任务的依赖，再删除该任务');
    next.tasks = next.tasks.filter(task => task.id !== taskId);
  });
}

export function setAvailability(snapshot, intervals) {
  return change(snapshot, next => {
    next.availability = clone(intervals);
    // [] is a meaningful answer only after this explicit user operation.
    next.availability_confirmed = true;
  });
}

export function setReferenceTime(snapshot, iso) {
  return change(snapshot, next => { next.reference_time = iso; });
}

function confirmationErrors(task) {
  const errors = [];
  if (!nonempty(task.title, 200)) errors.push('请填写任务名称');
  if (typeof task.must_do !== 'boolean') errors.push('请选择是否必须完成');
  if (!Number.isSafeInteger(task.priority) || task.priority < 0 || task.priority > 100) errors.push('请设置0至100的优先级');
  if (task.kind === 'visit_window') errors.push('办理窗口暂不支持自动确认，请拆为具体到场事项或截止节点');
  if (task.kind === 'flexible') {
    if (!Number.isSafeInteger(task.remaining_minutes) || task.remaining_minutes <= 0) errors.push('请填写大于0的剩余工作分钟');
    if (!isTimestamp(task.deadline_at)) errors.push('请确认含具体时刻的截止时间');
    if (typeof task.splittable !== 'boolean') errors.push('请选择工作能否拆分');
    if (task.splittable && (!Number.isSafeInteger(task.min_block_minutes) || task.min_block_minutes < 1)) errors.push('可拆分任务需要至少1分钟的最小连续块');
    if (task.splittable && task.min_block_minutes > task.remaining_minutes) errors.push('最小连续块不能大于剩余工作分钟');
    if (isTimestamp(task.earliest_start_at) && isTimestamp(task.deadline_at) && Date.parse(task.earliest_start_at) >= Date.parse(task.deadline_at)) errors.push('最早开始时间必须早于截止时间');
  }
  if (task.kind === 'fixed') {
    if (!isTimestamp(task.fixed_start_at) || !isTimestamp(task.fixed_end_at)) errors.push('固定事项需要确认开始与结束时间');
    else if (Date.parse(task.fixed_start_at) >= Date.parse(task.fixed_end_at)) errors.push('固定事项结束必须晚于开始');
    if (task.remaining_minutes !== 0) errors.push('固定事项不重复计入准备工作量，请把准备工作单独建任务');
  }
  if (task.kind === 'milestone') {
    if (!isTimestamp(task.deadline_at)) errors.push('截止节点需要确认具体截止时间');
    if (task.remaining_minutes !== 0) errors.push('截止节点不计工作量，请把准备工作单独建任务');
  }
  return errors;
}

export function confirmTask(snapshot, taskId) {
  return change(snapshot, next => {
    const task = findTask(next, taskId);
    if (task.status === 'completed' || task.status === 'cancelled') fail('已完成或已取消任务不能直接确认');
    const errors = confirmationErrors(task);
    if (errors.length) fail('任务信息尚未完整，请补充后确认', errors);
    const fields = ['title', 'kind', 'must_do', 'priority'];
    if (task.kind === 'flexible') fields.push('deadline_at', 'remaining_minutes', 'splittable', ...(task.splittable ? ['min_block_minutes'] : []));
    if (task.kind === 'fixed') fields.push('fixed_start_at', 'fixed_end_at', 'remaining_minutes');
    if (task.kind === 'milestone') fields.push('deadline_at', 'remaining_minutes');
    // The confirmation button explicitly asks the user to check every parser
    // warning. Source evidence remains inspectable; unsupported constraints are
    // still independently identified by the backend rather than bypassed here.
    if (task.earliest_start_at !== null) fields.push('earliest_start_at');
    if (task.location !== null) fields.push('location');
    if (task.materials.length) fields.push('materials');
    if (task.depends_on.length) fields.push('depends_on');
    task.confirmed_fields = [...new Set([...task.confirmed_fields, ...fields])];
    task.uncertainties = [];
    task.status = 'confirmed';
  });
}

export function completeTask(snapshot, taskId) {
  return change(snapshot, next => {
    const task = findTask(next, taskId);
    if (!nonempty(task.title, 200)) fail('请先填写任务名称');
    task.status = 'completed';
    task.remaining_minutes = 0;
    task.confirmed_fields = [...new Set([...task.confirmed_fields, 'remaining_minutes'])];
    task.evidence = task.evidence.filter(item => !(item.field === 'remaining_minutes' && item.origin === 'user_input'));
    task.evidence.push({ field: 'remaining_minutes', origin: 'user_input', source_id: null, quote: '用户标记已完成，剩余工作为0分钟' });
  });
}

export function reopenTask(snapshot, taskId) {
  return change(snapshot, next => {
    const task = findTask(next, taskId);
    if (!['completed', 'cancelled'].includes(task.status)) fail('只能恢复已完成或已取消的任务');
    task.status = 'draft';
    task.remaining_minutes = ['fixed', 'milestone'].includes(task.kind) ? 0 : null;
    task.confirmed_fields = [];
    task.evidence = task.evidence.filter(item => !(item.field === 'remaining_minutes' && item.origin === 'user_input'));
    task.evidence.push({ field: 'remaining_minutes', origin: 'user_input', source_id: null, quote: '用户恢复任务，工作类事项需要重新估算剩余时间。' });
  });
}

export function parseSnapshot(text) {
  if (typeof text !== 'string') fail('导入内容必须是JSON文本');
  requireByteBudget(text, '导入文件');
  let snapshot;
  try { snapshot = JSON.parse(text); } catch { fail('无法读取快照JSON，请检查文件内容'); }
  requireSnapshot(snapshot);
  return clone(snapshot);
}

export function serializeSnapshot(snapshot) {
  requireSnapshot(snapshot);
  const text = JSON.stringify(snapshot, null, 2);
  requireByteBudget(text, '任务清单');
  return text;
}

function requireByteBudget(text, label) {
  if (new TextEncoder().encode(text).byteLength > MAX_SNAPSHOT_BYTES) fail(`${label}超过15,000,000字节（UTF-8）上限，请分成更小的清单后再操作。`);
}

/** Never overwrite a malformed saved snapshot merely because reading it failed. */
export function readSnapshot(storage, key = STORAGE_KEY) {
  let raw = null;
  try {
    raw = storage.getItem(key);
    return raw === null ? { snapshot: null, error: null, raw } : { snapshot: parseSnapshot(raw), error: null, raw };
  } catch (error) { return { snapshot: null, error: error.message || '浏览器存储不可用', raw }; }
}

/** Low-level storage write only: callers need their own locking/conflict check. */
export function writeSnapshot(storage, key = STORAGE_KEY, snapshot) {
  try {
    storage.setItem(key, serializeSnapshot(snapshot));
    return { saved: true, error: null };
  } catch (error) { return { saved: false, error: error.message || '无法保存到浏览器' }; }
}

/** One gate per independently displayed async result channel (parse/calculate). */
export class RevisionGate {
  #sequence = 0;
  #latest = null;

  begin(snapshot) {
    const revision = typeof snapshot === 'number' ? snapshot : snapshot.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) fail('请求revision无效');
    const token = Object.freeze({ sequence: ++this.#sequence, revision });
    this.#latest = token;
    return token;
  }

  accepts(token, currentRevision) {
    return token !== null && token !== undefined && token === this.#latest && token.revision === currentRevision;
  }

  invalidate() {
    this.#sequence += 1;
    this.#latest = null;
  }
}

export function candidateTimestamp(value, timezone) {
  if (timezone && timezone !== 'Asia/Shanghai') return null;
  if (isTimestamp(value)) return value;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(value);
  if (!match) return null;
  const result = `${match[1]}T${match[2]}${match[3] || ':00'}+08:00`;
  return isTimestamp(result) ? result : null;
}

/** Conservative v1 parse adapter. Every generated task remains an unconfirmed draft. */
export function noticeCandidates(result, sourceId = null) {
  if (!object(result) || !nullable(sourceId, id)) fail('通知候选格式无效');
  const points = Array.isArray(result.time_points) ? result.time_points.slice(0, 200) : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter(value => nonempty(value)) : [];
  const rawTitle = typeof result.task_name === 'string' ? result.task_name.trim() : '';
  const title = ['未命名通知', 'user input', 'synthetic-regression'].includes(rawTitle) ? '' : rawTitle;
  if (!points.length) {
    const task = createTask('flexible', sourceId);
    task.title = title.slice(0, 200);
    task.uncertainties = [...new Set([...warnings, '未提取到可确认的时间，请根据原文手动建立任务。'])];
    return [task];
  }
  return points.map(point => {
    const label = typeof point?.time_type === 'string' ? point.time_type : '待核对事项';
    const pointWarnings = Array.isArray(point?.warnings) ? point.warnings.filter(value => nonempty(value)) : [];
    const start = point?.precision === 'datetime' ? candidateTimestamp(point.value, point.timezone) : null;
    const end = point?.precision === 'datetime' ? candidateTimestamp(point.end_value, point.timezone) : null;
    const recurring = [...warnings, ...pointWarnings].some(value => /重复|例外|每天|每日|每周|工作日|循环|周期/.test(value));
    const fixedLabel = /活动|比赛|考试|面试|签到|抽签/.test(label);
    const validInterval = point?.kind === 'interval' && start && end && Date.parse(start) < Date.parse(end) && !recurring;
    const fixed = fixedLabel && validInterval;
    const task = createTask(fixed ? 'fixed' : 'flexible', sourceId);
    const context = title ? `${title} · ` : '';
    task.title = `${context}${label}`.slice(0, 200);
    task.uncertainties = [...new Set([...warnings, ...pointWarnings])];
    const evidence = typeof point?.evidence === 'string' ? point.evidence.slice(0, 3000) : '';
    const record = field => {
      if (sourceId && evidence.trim()) task.evidence.push({ field, origin: 'source_text', source_id: sourceId, quote: evidence });
    };
    task.evidence.push({ field: 'title', origin: 'inferred', source_id: null, quote: '根据通知标题和时间标签生成候选名称，需核对具体事项。' });
    if (fixed) {
      task.fixed_start_at = start;
      task.fixed_end_at = end;
      record('fixed_start_at'); record('fixed_end_at');
    } else if (/报名|材料|提交|截止|撤回|退赛/.test(label) && start && point?.kind !== 'interval' && !recurring) {
      task.deadline_at = start;
      record('deadline_at');
    } else {
      task.uncertainties.push('尚不能把此时间直接认定为工作截止或连续固定占用，请人工选择任务类型和起止时间。');
    }
    if (Array.isArray(result.locations) && result.locations.length || result.location) task.uncertainties.push('通知含地点信息，请核对本事项对应地点后填写。');
    if (Array.isArray(result.materials) && result.materials.length) task.uncertainties.push('通知含材料信息，请核对本事项实际所需材料后填写。');
    task.uncertainties = [...new Set(task.uncertainties)];
    return task;
  });
}
