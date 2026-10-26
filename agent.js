import {
  STORAGE_KEY, createSnapshot, createTask, addSource, addTask, editTask,
  removeTask, setAvailability, setReferenceTime, confirmTask, completeTask,
  reopenTask, noticeCandidates, parseSnapshot, serializeSnapshot,
  readSnapshot, RevisionGate, isTimestamp, MAX_SNAPSHOT_BYTES, applyTimeReview,
} from './task-state.js';
import { SnapshotStore } from './snapshot-store.js';
import { modelCandidates } from './model-candidates.js';
import { reviewTimePatch } from './time-review.js';

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const clone = value => structuredClone(value);
const nowISO = () => new Date().toISOString();
const currentMinuteISO = () => new Date(Math.ceil(Date.now() / 60000) * 60000).toISOString();
const toLocalInput = iso => isTimestamp(iso) ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16) : '';
function fromLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const iso = `${value}:00+08:00`;
  return isTimestamp(iso) ? iso : null;
}
function readableTime(value) {
  if (!isTimestamp(value)) return '';
  const local = new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19);
  const fraction = (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] || '').replace(/0+$/, '');
  const displayed = !fraction && local.endsWith(':00') ? local.slice(0, 16) : `${local}${fraction ? `.${fraction}` : ''}`;
  return displayed.replace('T', ' ');
}
const minutes = value => `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 分钟`;
const taskTitle = task => task.title.trim() || '未命名事项';
const isInactive = task => ['completed', 'cancelled'].includes(task.status);
const sourceId = () => `notice-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const scrollBehavior = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
const stateLabels = { draft: '待核对', confirmed: '已确认', scheduled: '已确认', in_progress: '进行中', completed: '已完成，不计剩余量', cancelled: '已取消，不计剩余量' };
const TIME_REVIEW_LABEL = '按参照日期补全原文时间';
const CONFIRM_LABEL = '已逐项核对，确认事项';
const CONFIRMED_HELP = '事项已确认。继续核对其他事项，或填写空闲时段后检查冲突与容量。';
let confirmationErrorSequence = 0;

let storage;
try { storage = window.localStorage; } catch { storage = null; }
const recovered = readSnapshot(storage);
const snapshotStore = new SnapshotStore(storage, { initialRaw: recovered.raw });
let snapshot = recovered.snapshot || createSnapshot({ referenceTime: currentMinuteISO() });
let storageLocked = Boolean(recovered.error);
let externalConflict = false;
let apiBase = window.CAMPUS_AGENT_API || 'http://127.0.0.1:8765';
try { apiBase = storage?.getItem('sixu.api-base') || apiBase; } catch { /* Data can still be edited in memory. */ }
let capabilityBase = null;
let capabilityHealth = null;
let result = null;
let hasCalculated = false;
let activeParse = null;
let activeCalculation = null;
let importSequence = 0;
let connectionSequence = 0;
let invalidReference = false;
const invalidEdits = new Map();
const parseGate = new RevisionGate();
const calculateGate = new RevisionGate();
const timeReviewGate = new RevisionGate();

function tell(message, type = '') {
  $('appMessage').textContent = message;
  $('appMessage').className = `message ${type}`.trim();
  $('appMessage').hidden = !message;
}
function taskError(id, message) {
  const card = Array.from($('taskList').querySelectorAll('[data-task-id]')).find(element => element.dataset.taskId === id);
  if (card) card.querySelector('[data-task-error]').textContent = message;
}
function clearConfirmationErrors(card) {
  const ids = new Set(Array.from(card.querySelectorAll('[data-confirmation-error]'), node => node.id));
  for (const input of card.querySelectorAll('[data-task-field]')) {
    const descriptions = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && !ids.has(id));
    if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' '));
    else input.removeAttribute('aria-describedby');
    input.setAttribute('aria-invalid', String(invalidEdits.get(card.dataset.taskId)?.has(input.dataset.taskField) || false));
  }
  for (const node of card.querySelectorAll('[data-confirmation-error]')) node.remove();
}
function showConfirmationErrors(id, messages, fields = []) {
  const card = Array.from($('taskList').querySelectorAll('[data-task-id]')).find(element => element.dataset.taskId === id);
  if (!card) return;
  clearConfirmationErrors(card);
  taskError(id, `尚未确认：${messages.join('；')}。补充后再次确认，已填内容会保留。`);
  let first;
  const controls = Array.from(card.querySelectorAll('[data-task-field]'));
  for (let index = 0; index < messages.length; index += 1) {
    const input = controls.find(control => control.dataset.taskField === fields[index]);
    if (!input) continue;
    const hint = document.createElement('span');
    hint.id = `confirmation-error-${++confirmationErrorSequence}`;
    hint.className = 'field-error confirmation-error';
    hint.dataset.confirmationError = '';
    hint.textContent = messages[index];
    input.after(hint);
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), hint.id].filter(Boolean).join(' '));
    first ||= input;
  }
  const target = first || card.querySelector('[data-task-error]');
  for (let detail = target.closest('details'); detail && card.contains(detail); detail = detail.parentElement.closest('details')) detail.open = true;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
}
function needsReview(task) {
  if (isInactive(task)) return false;
  if (invalidEdits.has(task.id)) return true;
  if (task.status === 'draft') return true;
  const fields = ['title', 'kind', 'must_do', 'priority'];
  if (task.kind === 'fixed') fields.push('fixed_start_at', 'fixed_end_at');
  else if (task.kind === 'milestone') fields.push('deadline_at');
  else fields.push('deadline_at', 'remaining_minutes', 'splittable', ...(task.splittable ? ['min_block_minutes'] : []));
  return fields.some(field => task[field] === null || !task.confirmed_fields.includes(field));
}
function busy(button, value, idle, working) {
  button.disabled = value;
  button.setAttribute('aria-busy', String(value));
  button.textContent = value ? working : idle;
}
function invalidateResults() {
  calculateGate.invalidate();
  parseGate.invalidate();
  timeReviewGate.invalidate();
  activeParse = null;
  activeCalculation = null;
  result = null;
  busy($('calculate'), false, '检查冲突与容量');
  busy($('parseNotice'), false, '提取待确认事项');
  for (const button of $('taskList').querySelectorAll('[data-action="resolve-time"]')) busy(button, false, TIME_REVIEW_LABEL);
  renderResult();
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
    invalidateResults();
    $('storageConflict').hidden = false;
    $('saveState').textContent = '保存遇到版本变化，请先导出当前内容';
    return;
  }
  $('saveState').textContent = saved.saved ? (invalidEdits.size ? '存在未保存的无效输入，请先修正' : '已保存在当前浏览器') : '浏览器保存失败，请导出清单备份';
  if (!saved.saved) $('saveState').title = saved.error;
}
function commit(next, { full = true, unlock = false } = {}) {
  snapshot = next;
  if (unlock) {
    storageLocked = false; externalConflict = false; $('storageConflict').hidden = true;
    try { snapshotStore.adoptRaw(storage?.getItem(STORAGE_KEY) ?? null); } catch { snapshotStore.invalidate(); }
  }
  importSequence += 1;
  invalidateResults();
  save();
  if (full) renderAll();
  else renderSummary();
}
function renderSummary() {
  const pending = snapshot.tasks.filter(needsReview).length;
  const active = snapshot.tasks.filter(task => !isInactive(task)).length;
  const inactive = snapshot.tasks.length - active;
  $('taskSummary').textContent = snapshot.tasks.length ? `${active} 件待处理，${pending} 件需要核对${inactive ? `，${inactive} 件已完成或取消` : ''}。` : '先确认要做什么，再计算需要多少时间。';
}
function option(value, label, selected) {
  return `<option value="${escapeHTML(value)}"${selected ? ' selected' : ''}>${escapeHTML(label)}</option>`;
}
function inputField(label, field, value, type = 'text', attributes = '') {
  return `<label>${label}<input data-task-field="${field}" type="${type}" value="${escapeHTML(value ?? '')}" ${attributes}></label>`;
}
function taskMarkup(task) {
  const inactive = isInactive(task);
  const reviewed = !inactive && !needsReview(task);
  const title = escapeHTML(taskTitle(task));
  const disabled = inactive ? 'disabled' : '';
  const kindNames = { flexible: '待安排工作', fixed: '固定活动', milestone: '截止节点', visit_window: '办理窗口（本轮待支持）' };
  let temporalFields = '';
  if (task.kind === 'fixed') {
    temporalFields = inputField('固定开始', 'fixed_start_at', toLocalInput(task.fixed_start_at), 'datetime-local', 'required') + inputField('固定结束', 'fixed_end_at', toLocalInput(task.fixed_end_at), 'datetime-local', 'required');
  } else {
    temporalFields = inputField('截止日期与时刻', 'deadline_at', toLocalInput(task.deadline_at), 'datetime-local', 'required');
    if (task.kind !== 'milestone') temporalFields += inputField('还需要多少分钟', 'remaining_minutes', task.remaining_minutes, 'number', 'min="1" max="10000000" step="1" placeholder="按剩余工作量填写" required');
  }
  if (task.kind === 'flexible') {
    temporalFields += `<label>这项工作能否拆开做<select data-task-field="splittable" required>${option('', '请选择', task.splittable === null)}${option('true', '可以分几次完成', task.splittable === true)}${option('false', '需要连续完成', task.splittable === false)}</select></label>`;
    if (task.splittable === true) temporalFields += inputField('每次至少连续几分钟', 'min_block_minutes', task.min_block_minutes, 'number', 'min="1" max="10000000" step="1" required');
  }
  const evidence = task.evidence.filter(item => item.origin === 'source_text');
  const inferred = task.evidence.filter(item => item.origin === 'inferred');
  const quotes = [...new Set(evidence.map(item => item.quote).filter(Boolean))];
  const timeFields = task.kind === 'fixed' ? ['fixed_start_at', 'fixed_end_at'] : ['deadline_at'];
  const timeQuotes = [...new Set(evidence.filter(item => timeFields.includes(item.field)).map(item => item.quote).filter(Boolean))];
  const missingTime = task.status === 'draft' && timeFields.some(field => task[field] === null);
  const timeHelp = missingTime ? `<div class="field-wide time-review"><p class="field-help">${timeQuotes.length ? `已识别时间原文：${timeQuotes.map(escapeHTML).join('；')}。` : ''}${task.kind === 'fixed' ? '开始需要完整日期；结束按你计划的离场时间填写，原文未给出时不会自动估计。' : '截止需要完整日期与时刻，原文未给出的部分请核实后填写。'}</p>${task.source_id && timeQuotes.length && task.kind !== 'visit_window' ? `<button type="button" class="text-button" data-action="resolve-time">${TIME_REVIEW_LABEL}</button><p class="field-help">先在左侧选择通知参照日期；仅补全空白时间，不调用模型、不增加事项。</p>` : ''}</div>` : '';
  const dependence = snapshot.tasks.filter(item => item.id !== task.id);
  return `<article class="task-item" data-task-id="${escapeHTML(task.id)}">
    <div class="task-top"><div><h3 class="task-name" data-task-name>${title}</h3><p class="task-status ${needsReview(task) ? '' : 'confirmed'}" data-task-status>${escapeHTML(stateLabels[task.status])}${!isInactive(task) && needsReview(task) && task.status !== 'draft' ? ' · 需重新核对关键字段' : ''}</p></div><span class="field-help">${escapeHTML(kindNames[task.kind])}</span></div>
    <details class="task-details" ${needsReview(task) ? 'open' : ''}><summary>查看与修改事项</summary>
      <fieldset ${disabled}><div class="field-grid">
        <label class="field-wide">事项名称<input data-task-field="title" maxlength="200" value="${escapeHTML(task.title)}" placeholder="写清楚具体要完成什么" required></label>
        <label>事项类型<select data-task-field="kind">${Object.entries(kindNames).map(([key, name]) => key !== 'visit_window' || task.kind === 'visit_window' ? option(key, name, key === task.kind) : '').join('')}</select></label>
        <label>这件事是否必须完成<select data-task-field="must_do" required>${option('', '由你选择', task.must_do === null)}${option('true', '必须完成', task.must_do === true)}${option('false', '可以调整，由我取舍', task.must_do === false)}</select></label>
        ${temporalFields}
        ${timeHelp}
        <label>优先级（0–100，数字越大越优先）<input data-task-field="priority" type="text" inputmode="numeric" pattern="[0-9]{1,3}" maxlength="3" autocomplete="off" name="priority-${escapeHTML(task.id)}" value="${escapeHTML(task.priority ?? '')}" placeholder="尚未设置，请手动填写" required><span class="field-help" data-priority-help>${task.priority === null ? '尚未选择；0也需要由你明确填写。' : '请核对这个数值是否代表你的选择。'}</span></label>
      </div>
      <p class="field-help">${task.kind === 'fixed' ? '这里仅记录固定占用；准备材料等工作请单独添加。' : task.kind === 'milestone' ? '这里只记录截止节点；如果还需要准备，请另建待安排工作。' : task.kind === 'visit_window' ? '办理窗口不能直接当成连续占用，请根据原文改成具体活动或截止节点后再确认。' : '填写剩余时间；连续块、前置关系等会保留，但本轮暂不生成具体安排。'}</p>
      <details><summary>地点、材料与其他条件</summary><div class="field-grid">${inputField('对应地点（可选）', 'location', task.location, 'text', 'maxlength="500"')}<label>本事项所需材料（可选）<input data-task-field="materials" value="${escapeHTML(task.materials.join('、'))}" placeholder="用顿号或逗号分隔"></label>${task.kind === 'flexible' ? inputField('最早可开始的时刻（可选）', 'earliest_start_at', toLocalInput(task.earliest_start_at), 'datetime-local') : ''}</div>
        ${dependence.length ? `<fieldset class="dependencies"><legend class="field-help">前置事项（可选，本轮尚未验证依赖排程）</legend>${dependence.map(other => `<label class="check-label"><input type="checkbox" data-dependency="${escapeHTML(other.id)}" ${task.depends_on.includes(other.id) ? 'checked' : ''}>${escapeHTML(taskTitle(other))}</label>`).join('')}</fieldset>` : ''}
        ${task.visit_windows.length ? `<p class="field-help">导入的办理窗口：${task.visit_windows.map(item => `${escapeHTML(readableTime(item.start))} 至 ${escapeHTML(readableTime(item.end))}`).join('；')}。选择其他类型会清除窗口，请先核对原文。</p>` : ''}
      </details></fieldset>
      <details class="evidence" ${task.uncertainties.length ? 'open' : ''}><summary>原文依据与提取提醒</summary>${task.source_id ? `<button class="text-button" type="button" data-action="source" data-source-id="${escapeHTML(task.source_id)}">查看整份原文</button>` : '<p class="field-help">手动建立的事项，以你的输入为依据。</p>'}${quotes.map(quote => `<blockquote>${escapeHTML(quote)}</blockquote>`).join('')}${inferred.map(item => `<p class="field-help">${escapeHTML(item.quote)}</p>`).join('')}${task.uncertainties.length ? `<ul>${task.uncertainties.map(item => `<li>${escapeHTML(item)}</li>`).join('')}</ul>` : '<p class="field-help">如需修改，字段会重新转为待核对。</p>'}</details>
      <p class="field-error" data-task-error role="alert" tabindex="-1"></p>
      <p class="confirmation-status" data-task-confirmation role="status">${reviewed ? CONFIRMED_HELP : ''}</p>
      <div class="task-actions">${inactive ? '<button type="button" data-action="reopen">恢复为待核对</button>' : `<button class="primary-button" type="button" data-action="confirm" aria-disabled="${reviewed}">${reviewed ? '已确认' : CONFIRM_LABEL}</button><button type="button" data-action="complete">标记完成</button>`}<button class="text-button danger-text" type="button" data-action="remove">删除事项</button></div>
    </details>
  </article>`;
}
function captureTaskFocus() {
  const active = document.activeElement;
  const card = active?.closest?.('[data-task-id]');
  if (!card) return null;
  let selection = null;
  try { if (typeof active.selectionStart === 'number') selection = [active.selectionStart, active.selectionEnd]; } catch { /* Number/date controls have no selection API. */ }
  return { id: card.dataset.taskId, field: active.dataset.taskField, action: active.dataset.action, dependency: active.dataset.dependency, selection };
}
function restoreTaskFocus(focus) {
  if (!focus) return;
  const card = Array.from($('taskList').querySelectorAll('[data-task-id]')).find(item => item.dataset.taskId === focus.id);
  if (!card) { $('addTask').focus({ preventScroll: true }); return; }
  const controls = Array.from(card.querySelectorAll('input,select,textarea,button'));
  const target = controls.find(item => focus.field ? item.dataset.taskField === focus.field : focus.action ? item.dataset.action === focus.action : focus.dependency ? item.dataset.dependency === focus.dependency : false) || card.querySelector('summary');
  const disclosure = target.closest('details');
  if (disclosure) disclosure.open = true;
  target.focus({ preventScroll: true });
  if (focus.selection && target.setSelectionRange) try { target.setSelectionRange(...focus.selection); } catch { /* Not a text field. */ }
}
function recordInvalidEdit(id, field, raw, message) {
  if (!invalidEdits.has(id)) invalidEdits.set(id, new Map());
  invalidEdits.get(id).set(field, { raw, message });
}
function clearInvalidEdit(id, field) {
  invalidEdits.get(id)?.delete(field);
  if (invalidEdits.get(id)?.size === 0) invalidEdits.delete(id);
}
function renderTaskErrors(id) {
  const errors = invalidEdits.get(id);
  taskError(id, errors ? [...errors.values()].map(item => item.message).join('；') : '');
}
function renderTasks() {
  const focus = captureTaskFocus();
  const disclosures = new Map(Array.from($('taskList').querySelectorAll('.task-item')).map(card => [card.dataset.taskId, card.querySelector('.task-details').open]));
  $('taskList').innerHTML = snapshot.tasks.length ? snapshot.tasks.map(taskMarkup).join('') : '<div class="empty-state"><h3>把模糊的安排，变成具体的一件事。</h3><p>导入左侧通知，或手动添加。核对截止、剩余时间和固定活动后，再确认事项。</p></div>';
  for (const card of $('taskList').querySelectorAll('[data-task-id]')) {
    const id = card.dataset.taskId;
    if (disclosures.has(id)) card.querySelector('.task-details').open = disclosures.get(id);
    for (const [field, entry] of invalidEdits.get(id) || []) {
      const input = Array.from(card.querySelectorAll('[data-task-field]')).find(item => item.dataset.taskField === field);
      if (input) { input.value = entry.raw; input.setAttribute('aria-invalid', 'true'); }
      else clearInvalidEdit(id, field);
    }
    renderTaskErrors(id);
  }
  restoreTaskFocus(focus);
}
function updateTaskMeta(id) {
  const task = snapshot.tasks.find(item => item.id === id);
  const card = Array.from($('taskList').querySelectorAll('[data-task-id]')).find(element => element.dataset.taskId === id);
  if (!task || !card) return;
  card.querySelector('[data-task-name]').textContent = taskTitle(task);
  card.querySelector('[data-task-status]').textContent = invalidEdits.has(id) ? '输入尚未保存，请先修正' : stateLabels[task.status];
  card.querySelector('[data-task-status]').className = `task-status ${needsReview(task) ? '' : 'confirmed'}`;
  card.querySelector('[data-priority-help]').textContent = task.priority === null ? '尚未选择；0也需要由你明确填写。' : '请核对这个数值是否代表你的选择。';
  const confirmButton = card.querySelector('[data-action="confirm"]');
  if (confirmButton) {
    const reviewed = !needsReview(task);
    confirmButton.textContent = reviewed ? '已确认' : CONFIRM_LABEL;
    confirmButton.setAttribute('aria-disabled', String(reviewed));
    card.querySelector('[data-task-confirmation]').textContent = reviewed ? CONFIRMED_HELP : '';
  }
}
function renderSources() {
  $('sourceCount').textContent = `${snapshot.sources.length} 份`;
  $('sourceList').innerHTML = snapshot.sources.length ? snapshot.sources.map((source, index) => `<details data-source-id="${escapeHTML(source.id)}"><summary>${index + 1}. ${escapeHTML(source.text.split('\n')[0].slice(0, 40))}${source.kind === 'synthetic' ? '（虚构示例）' : ''}</summary><pre>${escapeHTML(source.text)}</pre></details>`).join('') : '<p class="empty-note">导入后可随时回来核对。</p>';
}
function renderAvailability() {
  $('referenceTime').value = toLocalInput(snapshot.reference_time);
  $('referenceTime').setAttribute('aria-invalid', 'false');
  invalidReference = false;
  renderReferencePrecision();
  $('availabilityList').innerHTML = snapshot.availability.length ? snapshot.availability.map((interval, index) => `<div class="availability-item"><span>${escapeHTML(readableTime(interval.start))}<br>至 ${escapeHTML(readableTime(interval.end))}</span><button class="text-button danger-text" type="button" data-remove-availability="${index}" aria-label="删除第${index + 1}个空闲时段">删除</button></div>`).join('') : `<p class="empty-note">${snapshot.availability_confirmed ? '你已确认当前没有可用时段，计算时按0分钟处理。' : '还没有填写个人空闲时段。'}</p><button class="text-button" id="confirmNoAvailability" type="button">确认目前没有可用时间</button>`;
}
function renderReferencePrecision() {
  const precise = readableTime(snapshot.reference_time);
  const hasSeconds = precise !== toLocalInput(snapshot.reference_time).replace('T', ' ');
  $('referencePrecision').textContent = hasSeconds ? `当前清单保存的实际计算起点：${precise}。如需从整分钟起算，可点击“使用当前时间”。` : '';
  $('referencePrecision').hidden = !hasSeconds;
}
function renderResult() {
  const output = $('resultOutput');
  if (!result) {
    output.removeAttribute('aria-busy');
    output.innerHTML = `<p class="empty-note">${hasCalculated ? '清单或时间已修改，原结果已失效，请重新检查。' : '确认事项并填写空闲时段后，结果会显示在这里。'}</p>`;
    return;
  }
  const labels = { conflicts_detected: '发现需要处理的冲突', information_needed: '还有条件需要核对', no_conflict_detected: '本次检查未发现冲突' };
  const statusClass = result.status === 'conflicts_detected' ? 'result-danger' : result.status === 'information_needed' ? 'result-warning' : '';
  const missing = Array.isArray(result.missing_information) ? result.missing_information : [];
  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  const checks = Array.isArray(result.capacity_checks) ? result.capacity_checks : [];
  const excluded = Array.isArray(result.excluded_task_ids) ? result.excluded_task_ids : [];
  const capacityNote = checks.some(check => check.result === 'shortage')
    ? '累计需求已超过对应截止前的可用时长，需要减少工作量、增加空闲或调整安排后重新检查。'
    : checks.length ? '容量没有超出，只说明累计时长这一必要条件通过，尚不能保证每件事都能排进具体空档。'
      : '本次没有可列出的工作量容量节点；请结合上方冲突或待核对条件判断，不能据此确认整个计划可行。';
  output.innerHTML = `<h3 class="result-heading ${statusClass}">${escapeHTML(labels[result.status] || '结果需要核对')}</h3><p class="result-caption">按当前清单，从 ${escapeHTML(readableTime(snapshot.reference_time))} 开始检查。修改任意事项或时间后，需要重新计算。</p>
    ${excluded.length ? `<p class="field-error">以下事项未纳入计算，下面不是完整清单的总需求：${excluded.map(id => escapeHTML(taskTitle(snapshot.tasks.find(item => item.id === id) || { title: id }))).join('、')}。</p>` : ''}
    ${conflicts.map(item => `<div class="result-entry"><strong class="result-danger">${escapeHTML((item.tasks || []).join('、'))}</strong><p>${escapeHTML(item.reason)}</p></div>`).join('')}
    ${checks.length ? `<div class="result-table-wrap"><table><caption class="sr-only">各截止节点的累计工作量与可用时间</caption><thead><tr><th scope="col">截至</th><th scope="col">累计需要</th><th scope="col">实际可用</th><th scope="col">时长差额</th></tr></thead><tbody>${checks.map(check => `<tr><td>${escapeHTML(readableTime(check.deadline))}</td><td>${escapeHTML(minutes(check.known_required_minutes))}${check.unknown_workload_count ? '<br>另有未知工作量' : ''}</td><td>${escapeHTML(minutes(check.available_minutes))}</td><td class="${check.result === 'shortage' ? 'result-danger' : ''}">${check.result === 'shortage' ? '缺少 ' : '剩余 '}${escapeHTML(minutes(Math.abs(check.available_minutes - check.known_required_minutes)))}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${missing.length ? `<div class="result-entry"><strong>本次还没有验证的部分</strong><ul class="result-list">${missing.map(item => `<li>${escapeHTML(item.name || '事项')}：${escapeHTML(item.reason || (item.fields || []).join('、'))}</li>`).join('')}</ul></div>` : ''}
    <p class="result-caption">${capacityNote}</p>
    <details><summary>计算口径与具体空档</summary>${(result.warnings || []).map(warning => `<p class="field-help">${escapeHTML(warning)}</p>`).join('')}${(result.limitations || []).map(limit => `<p class="field-help">${escapeHTML(limit)}</p>`).join('')}${checks.map(check => `<div class="result-entry"><strong>${escapeHTML(readableTime(check.deadline))}前的空档</strong>${(check.free_intervals || []).map(interval => `<p>${escapeHTML(readableTime(interval.start))} 至 ${escapeHTML(readableTime(interval.end))}</p>`).join('') || '<p>没有可用空档。</p>'}</div>`).join('')}</details>`;
  output.removeAttribute('aria-busy');
}
function renderAll() { renderSummary(); renderTasks(); renderSources(); renderAvailability(); renderResult(); }

function normalizeApiBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含账号、查询参数或片段的HTTP/HTTPS服务地址。');
  return url.href.replace(/\/$/, '');
}
async function request(path, body, base, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`服务没有返回可读取的数据（HTTP ${response.status}），请检查服务地址。`); }
    if (!response.ok) throw new Error(data.error || `服务返回HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请稍后重试；当前清单仍保留。');
    throw error;
  } finally { window.clearTimeout(timeout); }
}
async function ensureCapabilities(base, { fresh = false } = {}) {
  if (!fresh && capabilityBase === base) return capabilityHealth;
  const health = await request('/api/health', undefined, base);
  if (!Array.isArray(health.capabilities) || !health.capabilities.includes('snapshot_v2')) throw new Error('该服务尚未升级，暂不能处理这份新清单。请在“服务与备份”中连接本地新版服务；清单没有提交给旧算法。');
  if (base === apiBase) { capabilityBase = base; capabilityHealth = health; }
  return health;
}

$('noticeForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (externalConflict) return tell('请先处理另一个标签页的清单变化。', 'warning');
  const text = $('noticeText').value.trim();
  const referenceDate = $('noticeDate').value || null;
  const mode = $('extractionMode').value;
  if (!text) return tell('请先粘贴通知原文。', 'warning');
  if (!['rules', 'dify'].includes(mode)) return tell('请选择有效的提取方式。', 'warning');
  if (mode === 'dify' && [...text].length > 20000) return tell('模型提取每次最多两万字，请拆分通知后重试；原文尚未发送。', 'warning');
  const existingSource = snapshot.sources.find(source => source.text === text);
  if (existingSource && snapshot.tasks.some(task => task.source_id === existingSource.id)) return tell('这份通知已导入，不会重复增加事项。补日期时请先选择通知参照日期，再点击对应事项旁的“按参照日期补全原文时间”；也可以直接修改已有事项。', 'warning');
  const ticket = parseGate.begin(snapshot);
  activeParse = ticket;
  const base = apiBase;
  busy($('parseNotice'), true, '提取待确认事项', '正在提取，请稍候…');
  tell('');
  try {
    const health = await ensureCapabilities(base, { fresh: mode === 'dify' });
    if (!parseGate.accepts(ticket, snapshot.revision) || base !== apiBase) return;
    if (mode === 'dify' && (!health.capabilities.includes('model_notice_candidates_v1') || !health.model_extraction?.configured)) throw new Error('当前服务尚未启用模型提取。请先按接入说明配置本地 Dify 服务，或主动选择规则提取。');
    $('connectionStatus').textContent = '已连接支持任务确认与重算的服务';
    const parsed = await request(mode === 'dify' ? '/api/v2/extract' : '/api/parse', { text, reference_date: referenceDate, timezone: snapshot.timezone }, base, mode === 'dify' ? 100000 : 30000);
    if (!parseGate.accepts(ticket, snapshot.revision) || text !== $('noticeText').value.trim() || referenceDate !== ($('noticeDate').value || null) || mode !== $('extractionMode').value || base !== apiBase) return;
    const source = existingSource || { id: sourceId(), kind: text.startsWith('【虚构示例】') ? 'synthetic' : 'pasted_notice', text, published_at: null };
    const candidates = mode === 'dify' ? modelCandidates(parsed, source) : noticeCandidates(parsed, source.id);
    if (!candidates.length) {
      tell(`本次${mode === 'dify' ? '模型' : '规则'}提取没有识别到行动事项；原文与清单均保留。请核对通知，必要时手动添加。${(parsed.warnings || []).join(' ')}`, 'warning');
      return;
    }
    if (referenceDate && /今天|明天|后天|昨日|昨天|本周|这周|下周|今年|明年|去年/.test(text)) {
      for (const task of candidates) for (const field of ['deadline_at', 'fixed_start_at', 'fixed_end_at'].filter(field => task[field])) task.evidence.push({ field, origin: 'inferred', source_id: null, quote: `日期解释使用本次选择的参照日 ${referenceDate}；通知实际发布时间仍未知，请核对原语境。` });
    }
    let next = existingSource ? snapshot : addSource(snapshot, source);
    for (const task of candidates) next = addTask(next, task);
    commit(next);
    tell(`通过${mode === 'dify' ? 'Dify 模型' : '规则'}提取整理出 ${candidates.length} 件待核对事项。请检查名称、时间与原文，再逐项确认。`);
    $('taskSection').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  } catch (error) {
    if (activeParse === ticket) tell(`提取未完成：${error.message} 也可以先手动添加事项。`, 'error');
  } finally { if (activeParse === ticket) { activeParse = null; busy($('parseNotice'), false, '提取待确认事项'); } }
});
for (const id of ['noticeText', 'noticeDate', 'extractionMode']) $(id).addEventListener('input', () => { parseGate.invalidate(); timeReviewGate.invalidate(); activeParse = null; busy($('parseNotice'), false, '提取待确认事项'); });

$('addTask').addEventListener('click', () => {
  try { const task = createTask(); commit(addTask(snapshot, task)); $('taskList').lastElementChild.querySelector('[data-task-field="title"]').focus(); }
  catch (error) { tell(error.message, 'error'); }
});
$('taskList').addEventListener('input', event => {
  const input = event.target;
  const card = input.closest('[data-task-id]');
  if (!card || (!input.dataset.taskField && !input.dataset.dependency)) return;
  const id = card.dataset.taskId;
  const task = snapshot.tasks.find(item => item.id === id);
  if (!task || isInactive(task)) return;
  clearConfirmationErrors(card);
  invalidateResults();
  const field = input.dataset.taskField;
  let inputError = '';
  let patch;
  if (input.dataset.dependency) {
    patch = { depends_on: Array.from(card.querySelectorAll('[data-dependency]:checked')).map(item => item.dataset.dependency) };
  } else {
    let value = input.value;
    if (['must_do', 'splittable'].includes(field)) value = value === '' ? null : value === 'true';
    if (['remaining_minutes', 'min_block_minutes', 'priority'].includes(field)) {
      const lower = field === 'priority' ? 0 : 1;
      const upper = field === 'priority' ? 100 : 10000000;
      const valid = value !== '' && (field !== 'priority' || /^[0-9]{1,3}$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= lower && Number(value) <= upper;
      if (!valid && (value !== '' || input.validity?.badInput)) inputError = `请将${field === 'priority' ? '优先级' : field === 'remaining_minutes' ? '剩余分钟' : '最小连续分钟'}填写为${lower}至${upper}的整数；此输入尚未保存。`;
      value = valid ? Number(value) : null;
    }
    if (['deadline_at', 'fixed_start_at', 'fixed_end_at', 'earliest_start_at'].includes(field)) value = fromLocalInput(value);
    if (field === 'location') value = value.trim() || null;
    if (field === 'materials') value = [...new Set(value.split(/[、，,\n]/).map(item => item.trim()).filter(Boolean))];
    patch = { [field]: value };
    if (field === 'kind') {
      Object.assign(patch, { fixed_start_at: null, fixed_end_at: null, visit_windows: [], earliest_start_at: null, splittable: null, min_block_minutes: null, remaining_minutes: ['fixed', 'milestone'].includes(value) ? 0 : null });
      if (value === 'fixed') patch.deadline_at = null;
    }
    if (field === 'splittable' && value === false) patch.min_block_minutes = null;
  }
  try {
    commit(editTask(snapshot, id, patch), { full: false });
    if (inputError) recordInvalidEdit(id, field, input.value, inputError);
    else clearInvalidEdit(id, field || 'depends_on');
    input.setAttribute('aria-invalid', String(Boolean(inputError)));
    renderTaskErrors(id);
    renderSummary();
    if (['kind', 'splittable'].includes(field)) renderTasks(); else updateTaskMeta(id);
  } catch (error) {
    recordInvalidEdit(id, field || 'depends_on', input.value, `输入尚未保存：${(error.errors || [error.message]).join('；')}`);
    input.setAttribute('aria-invalid', 'true');
    $('saveState').textContent = '存在未保存的无效输入，请先修正';
    renderTaskErrors(id); updateTaskMeta(id); renderSummary();
  }
});
$('taskList').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  const card = button?.closest('[data-task-id]');
  if (!button || !card) return;
  const id = card.dataset.taskId;
  const task = snapshot.tasks.find(item => item.id === id);
  try {
    if (button.dataset.action === 'resolve-time') {
      if (externalConflict) throw new Error('请先处理另一个标签页的清单变化。');
      if (invalidEdits.has(id)) throw new Error('请先修正此事项尚未保存的无效输入。');
      const referenceDate = $('noticeDate').value;
      if (!referenceDate) throw new Error('请先在左侧“通知的参照日期”选择原通知语境日期，再点击补全。');
      const source = snapshot.sources.find(item => item.id === task.source_id);
      if (!source) throw new Error('找不到本事项的原通知，请手动核对时间。');
      const ticket = timeReviewGate.begin(snapshot);
      const base = apiBase;
      busy(button, true, TIME_REVIEW_LABEL, '正在读取原文时间…');
      try {
        await ensureCapabilities(base);
        if (!timeReviewGate.accepts(ticket, snapshot.revision) || base !== apiBase) return;
        const parsed = await request('/api/parse', { text: source.text, reference_date: referenceDate, timezone: snapshot.timezone }, base);
        if (!timeReviewGate.accepts(ticket, snapshot.revision) || base !== apiBase || referenceDate !== $('noticeDate').value) return;
        const patch = reviewTimePatch(parsed, task, source);
        commit(applyTimeReview(snapshot, id, patch, referenceDate));
        tell(`已按参照日期 ${referenceDate} 补全原文支持的空白时间，事项仍待核对。${task.kind === 'fixed' && !(patch.fixed_end_at || task.fixed_end_at) ? '原文缺少结束时间，请按你的计划填写离场时间。' : ''}`);
      } catch (error) {
        if (timeReviewGate.accepts(ticket, snapshot.revision) && base === apiBase && referenceDate === $('noticeDate').value) throw error;
      } finally { if (button.isConnected) busy(button, false, TIME_REVIEW_LABEL); }
      return;
    }
    if (button.dataset.action === 'source') {
      const source = Array.from($('sourceList').querySelectorAll('[data-source-id]')).find(item => item.dataset.sourceId === button.dataset.sourceId);
      if (source) { source.open = true; source.scrollIntoView({ behavior: scrollBehavior(), block: 'center' }); source.querySelector('summary').focus(); }
      return;
    }
    if (button.dataset.action === 'confirm') {
      if (invalidEdits.has(id)) {
        const entries = [...invalidEdits.get(id)];
        showConfirmationErrors(id, entries.map(([, entry]) => entry.message), entries.map(([field]) => field));
        return;
      }
      if (!needsReview(task)) return;
      const priorityInput = card.querySelector('[data-task-field="priority"]');
      if (task.priority === null && priorityInput.value !== '') { priorityInput.value = ''; showConfirmationErrors(id, ['页面显示的优先级尚未保存为你的选择，请手动填写后再确认'], ['priority']); return; }
      commit(confirmTask(snapshot, id));
    }
    if (button.dataset.action === 'complete') { invalidEdits.delete(id); commit(completeTask(snapshot, id)); }
    if (button.dataset.action === 'reopen') commit(reopenTask(snapshot, id));
    if (button.dataset.action === 'remove' && window.confirm(`删除“${taskTitle(task)}”？该事项会从当前清单移除。`)) { const next = removeTask(snapshot, id); invalidEdits.delete(id); commit(next); }
  } catch (error) {
    if (button.dataset.action === 'confirm') showConfirmationErrors(id, error.errors || [error.message], error.fields);
    else taskError(id, (error.errors || [error.message]).join('；'));
  }
});

$('referenceTime').addEventListener('input', event => {
  invalidateResults();
  const value = fromLocalInput(event.target.value);
  invalidReference = !value;
  try { if (value) commit(setReferenceTime(snapshot, value), { full: false }); }
  catch (error) { invalidReference = true; tell(`新的计算时刻未保存：${error.message}`, 'error'); }
  event.target.setAttribute('aria-invalid', String(invalidReference));
  renderReferencePrecision();
});
$('useCurrentTime').addEventListener('click', () => {
  invalidateResults();
  try { commit(setReferenceTime(snapshot, currentMinuteISO())); }
  catch (error) { tell(`当前时刻未能保存：${error.message}`, 'error'); }
});
$('addAvailability').addEventListener('click', () => {
  invalidateResults();
  $('availabilityForm').hidden = false;
  $('availabilityStart').value = toLocalInput(snapshot.reference_time);
  $('availabilityEnd').value = '';
  $('availabilityError').textContent = '';
  $('availabilityStart').focus();
});
$('cancelAvailability').addEventListener('click', () => { $('availabilityForm').hidden = true; $('availabilityError').textContent = ''; });
$('availabilityForm').addEventListener('input', invalidateResults);
$('availabilityForm').addEventListener('submit', event => {
  event.preventDefault();
  const start = fromLocalInput($('availabilityStart').value);
  const end = fromLocalInput($('availabilityEnd').value);
  if (!start || !end || Date.parse(end) <= Date.parse(start)) { $('availabilityError').textContent = '请填写完整时刻，并让结束晚于开始；跨午夜请选择次日日期。'; return; }
  try { commit(setAvailability(snapshot, [...snapshot.availability, { start, end }])); $('availabilityForm').hidden = true; $('availabilityError').textContent = ''; }
  catch (error) { $('availabilityError').textContent = (error.errors || [error.message]).join('；'); }
});
$('availabilityList').addEventListener('click', event => {
  if (event.target.closest('#confirmNoAvailability')) {
    try { commit(setAvailability(snapshot, [])); } catch (error) { tell(error.message, 'error'); }
    return;
  }
  const button = event.target.closest('[data-remove-availability]');
  if (!button) return;
  const index = Number(button.dataset.removeAvailability);
  try { commit(setAvailability(snapshot, snapshot.availability.filter((_, item) => item !== index))); }
  catch (error) { tell(error.message, 'error'); }
});
$('calculate').addEventListener('click', async () => {
  if (externalConflict) return tell('请先处理另一个标签页的清单变化。', 'warning');
  if (!$('availabilityForm').hidden) return tell('请先保存或取消正在填写的空闲时段。', 'warning');
  if (invalidReference || !fromLocalInput($('referenceTime').value)) return tell('请填写并保存有效的计算起始时刻。', 'warning');
  if (!snapshot.tasks.length) return tell('请先添加并确认至少一件事项。', 'warning');
  const pending = snapshot.tasks.filter(needsReview);
  if (pending.length) { tell(`还有 ${pending.length} 件事项需要核对，不会将它们悄悄从计算中排除。`, 'warning'); $('taskSection').scrollIntoView({ behavior: scrollBehavior() }); return; }
  const active = snapshot.tasks.filter(task => !isInactive(task));
  const availabilityKnown = snapshot.availability_confirmed ?? (snapshot.availability.length > 0);
  if (active.length && !availabilityKnown) return tell('请先填写真实空闲时段，或明确确认目前没有可用时间；没有填写不代表全天可用或零空闲。', 'warning');
  try {
    if (new TextEncoder().encode(serializeSnapshot(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) throw new Error('清单超过15MB，请导出并拆分清单后再检查。');
  } catch (error) { return tell(error.message, 'error'); }
  const submitted = clone(snapshot);
  const ticket = calculateGate.begin(submitted);
  activeCalculation = ticket;
  const base = apiBase;
  hasCalculated = true;
  result = null;
  $('resultOutput').setAttribute('aria-busy', 'true');
  $('resultOutput').innerHTML = '<p class="loading-output">正在按这份已确认清单计算。修改内容后，本次结果会失效。</p>';
  busy($('calculate'), true, '检查冲突与容量', '正在检查…');
  tell('');
  try {
    await ensureCapabilities(base);
    if (!calculateGate.accepts(ticket, snapshot.revision) || base !== apiBase) return;
    $('connectionStatus').textContent = '已连接支持任务确认与重算的服务';
    const computed = await request('/api/v2/calculate', submitted, base);
    if (!calculateGate.accepts(ticket, snapshot.revision) || base !== apiBase) return;
    if (computed.schema_version !== 2 || computed.revision !== submitted.revision || !['information_needed', 'conflicts_detected', 'no_conflict_detected'].includes(computed.status)) throw new Error('计算结果与当前清单不匹配，请重新检查服务版本。');
    result = computed;
    renderResult();
  } catch (error) {
    if (activeCalculation === ticket) {
      $('resultOutput').removeAttribute('aria-busy');
      $('resultOutput').innerHTML = '<p class="field-error">本次检查未完成，清单已保留。检查服务连接或输入后可以重试。</p>';
      tell(`检查未完成：${error.message}`, 'error');
    }
  } finally { if (activeCalculation === ticket) { activeCalculation = null; busy($('calculate'), false, '检查冲突与容量'); } }
});

$('apiBase').value = apiBase;
$('apiForm').addEventListener('submit', async event => {
  event.preventDefault();
  const connectionTicket = ++connectionSequence;
  try {
    apiBase = normalizeApiBase($('apiBase').value.trim());
    capabilityBase = null;
    invalidateResults();
    try { storage?.setItem('sixu.api-base', apiBase); } catch { /* Current session can still connect. */ }
    $('connectionStatus').textContent = '正在检查连接…';
    const checkedBase = apiBase;
    await ensureCapabilities(checkedBase);
    if (checkedBase !== apiBase || connectionTicket !== connectionSequence) return;
    $('connectionStatus').textContent = '已连接支持任务确认与重算的服务';
    tell('服务已连接。通知仍需由你点击提取后才会发送。');
  } catch (error) {
    if (connectionTicket !== connectionSequence) return;
    capabilityBase = null;
    $('connectionStatus').textContent = error.message; tell(error.message, 'error');
  }
});
$('exportSnapshot').addEventListener('click', () => {
  try {
    if (invalidEdits.size && !window.confirm('有无效输入尚未保存，导出文件只包含已接受的字段值。是否仍导出这份有效清单？')) return;
    const blob = new Blob([serializeSnapshot(snapshot)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `司序-个人清单-${toLocalInput(nowISO()).slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    tell('已导出清单，文件包含通知原文与个人安排，请妥善保存。');
  } catch (error) { tell(error.message, 'error'); }
});
$('importSnapshot').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const ticket = ++importSequence;
  try {
    if (file.size > 15000000) throw new Error('导入文件超过15MB，请缩小清单。');
    const next = parseSnapshot(await file.text());
    if (ticket !== importSequence) return tell('读取文件期间清单发生变化，未覆盖当前修改，请重新导入。', 'warning');
    if (snapshot.tasks.length && !window.confirm('导入会替换当前清单。请先导出需要保留的内容，是否继续？')) return;
    invalidEdits.clear();
    commit(next, { unlock: true });
    hasCalculated = false;
    renderResult();
    tell('已载入清单。导入未发送数据，计算时仍会校验字段和原文依据。');
  } catch (error) { tell(`导入未完成：${(error.errors || [error.message]).join('；')}`, 'error'); }
  finally { event.target.value = ''; }
});
$('clearSnapshot').addEventListener('click', () => {
  if (!window.confirm('清空此浏览器中的当前清单？请先导出需要保留的内容。')) return;
  hasCalculated = false;
  invalidEdits.clear();
  commit(createSnapshot({ referenceTime: currentMinuteISO() }), { unlock: true });
  $('noticeText').value = ''; $('noticeDate').value = ''; $('availabilityForm').hidden = true;
  tell('清单已清空，可以重新导入通知。');
});
$('reloadLatest').addEventListener('click', () => {
  const latest = readSnapshot(storage);
  if (latest.error || !latest.snapshot) return tell('最新清单无法读取，请先导出当前内容，保留备份后重试。', 'error');
  if (!window.confirm('载入另一个标签页保存的清单？当前未保存修改将被替换，请先导出需要保留的内容。')) return;
  snapshot = latest.snapshot;
  invalidEdits.clear();
  snapshotStore.adoptRaw(latest.raw);
  externalConflict = false;
  storageLocked = false;
  $('storageConflict').hidden = true;
  invalidateResults(); renderAll();
  $('saveState').textContent = '已载入浏览器保存的最新清单';
});
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  try { if (event.newValue === serializeSnapshot(snapshot)) return; } catch { /* Oversized memory state must not overwrite stored data. */ }
  externalConflict = true;
  snapshotStore.invalidate();
  invalidateResults();
  $('storageConflict').hidden = false;
  $('saveState').textContent = '其他标签页已修改，请先处理版本变化';
});

$('fillExample').addEventListener('click', () => {
  const day = new Date(Date.parse(nowISO()) + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  $('noticeText').value = `【虚构示例】讲座与课程报告安排\n请于${day}15:00前完成讲座报名。讲座于${day}18:00-20:00举行，地点为主楼405。请于${day}23:59前提交课程报告。`;
  $('noticeDate').value = '';
  parseGate.invalidate(); activeParse = null; busy($('parseNotice'), false, '提取待确认事项');
  tell('已填入虚构通知。点击提取后，仍需要逐项核对与补充剩余耗时。');
  $('noticeText').focus();
});
$('loadNineMinutes').addEventListener('click', () => {
  if (snapshot.tasks.length && !window.confirm('载入虚构场景会替换当前清单，请先导出要保留的内容。是否继续？')) return;
  const day = new Date(Date.parse(nowISO()) + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  const source = { id: sourceId(), kind: 'synthetic', text: `【虚构示例】${day}23:59前提交课程报告。预计还需要180分钟。`, published_at: null };
  let next = createSnapshot({ referenceTime: `${day}T23:50:00+08:00` });
  next.label = '虚构示例：九分钟缺口';
  const task = createTask('flexible', source.id);
  Object.assign(task, { title: '虚构示例：课程报告', deadline_at: `${day}T23:59:00+08:00`, remaining_minutes: 180, must_do: true, priority: 90, splittable: true, min_block_minutes: 1, evidence: [{ field: 'deadline_at', origin: 'source_text', source_id: source.id, quote: `${day}23:59前提交课程报告` }], uncertainties: ['这是虚构场景，计算起始固定为23:50，空闲到23:59；请核对后确认。'] });
  next = addSource(next, source); next = addTask(next, task);
  next = setAvailability(next, [{ start: `${day}T23:50:00+08:00`, end: `${day}T23:59:00+08:00` }]);
  hasCalculated = false; invalidEdits.clear(); commit(next, { unlock: !externalConflict && !storageLocked });
  $('availabilityForm').hidden = true;
  tell('已载入虚构场景，时间不是当前时刻。先确认报告事项，再检查180分钟工作面对9分钟空闲会发生什么。');
});

renderAll();
if (recovered.error) tell(`本地清单未能读取：${recovered.error}。为保护原数据，当前修改暂不覆盖保存；请导入备份或明确清空后重建。`, 'warning');
if (location.protocol === 'file:') tell('请通过本地HTTP服务打开此页面，直接打开文件无法完整加载编辑模块。', 'warning');
