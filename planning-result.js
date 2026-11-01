import { isTimestamp } from './task-state.js';

const SUCCESS = new Set(['feasible_found', 'nothing_to_schedule']);
const STATUSES = new Set([...SUCCESS, 'information_needed', 'unsupported', 'conflicts_detected', 'not_found', 'validation_failed']);
const CHECKS = ['confirmed_inputs', 'availability', 'fixed_occupancy', 'no_overlap', 'release_and_deadline', 'exact_remaining_work', 'continuous_blocks', 'dependencies'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length <= 10000;
const inactive = task => ['completed', 'cancelled'].includes(task.status);
const kinds = { flexible: 'work', fixed: 'fixed', milestone: 'milestone' };
// Python's datetime precision is microseconds. Do not round it to JS milliseconds.
function instant(value) {
  if (!isTimestamp(value)) throw new Error('安排中含无效时间。');
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  if (fraction.length > 6) throw new Error('安排时间精度超出服务约定。');
  return BigInt(Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, ''))) * 1000n + BigInt(fraction.padEnd(6, '0'));
}
export { instant as timestampMicros };

/** Response boundary checks; the independent constraint checker runs on the server. */
export function readPlanResponse(payload, snapshot) {
  const reject = () => { throw new Error('安排结果不完整或与当前清单不匹配，请检查服务版本后重试。'); };
  if (!object(payload) || payload.schema_version !== 1 || payload.revision !== snapshot.revision || !STATUSES.has(payload.status)) reject();
  if (!object(payload.horizon) || !isTimestamp(payload.horizon.start) || !isTimestamp(payload.horizon.end)) reject();
  if (instant(payload.horizon.start) !== instant(snapshot.reference_time) || instant(payload.horizon.end) < instant(payload.horizon.start)) reject();
  if (!Array.isArray(payload.schedule) || payload.schedule.length > 4096 || !object(payload.validation)) reject();
  if (!Array.isArray(payload.validation.errors) || !Array.isArray(payload.validation.checked_constraints)) reject();
  if (!payload.validation.errors.every(error => object(error) && text(error.code) && text(error.reason))) reject();
  if (!object(payload.algorithm) || payload.algorithm.name !== 'bounded_greedy_v1' || payload.algorithm.max_attempts !== 4 || !Number.isInteger(payload.algorithm.attempts) || payload.algorithm.attempts < 0 || payload.algorithm.attempts > 4) reject();
  if (!['issues', 'conflicts', 'capacity_checks', 'warnings', 'limitations'].every(key => Array.isArray(payload[key]) && payload[key].length <= 10000)) reject();
  if (![...payload.warnings, ...payload.limitations].every(text)) reject();
  if (!payload.issues.every(issue => object(issue) && text(issue.reason))) reject();
  if (!payload.conflicts.every(conflict => object(conflict) && text(conflict.reason))) reject();
  if (!payload.capacity_checks.every(check => object(check) && isTimestamp(check.deadline) && Number.isFinite(check.known_required_minutes) && check.known_required_minutes >= 0 && Number.isFinite(check.available_minutes) && check.available_minutes >= 0)) reject();
  const active = snapshot.tasks.filter(task => !inactive(task));
  const tasks = new Map(active.map(task => [task.id, task]));
  const seen = new Map();
  for (const row of payload.schedule) {
    if (!object(row) || Object.keys(row).sort().join(',') !== 'end,kind,start,task_id' || !tasks.has(row.task_id)) reject();
    const task = tasks.get(row.task_id);
    if (row.kind !== kinds[task.kind]) reject();
    const start = instant(row.start), end = instant(row.end);
    if (start < instant(payload.horizon.start) || end > instant(payload.horizon.end) || (row.kind === 'milestone' ? end !== start : end <= start)) reject();
    const rows = seen.get(task.id) || [];
    rows.push({ start, end }); seen.set(task.id, rows);
  }
  if (SUCCESS.has(payload.status)) {
    if (payload.validation.passed !== true || payload.validation.errors.length || payload.issues.length || payload.conflicts.length || !CHECKS.every(check => payload.validation.checked_constraints.includes(check))) reject();
    if (payload.status === 'nothing_to_schedule' ? active.length || payload.schedule.length : !active.length || seen.size !== active.length) reject();
    for (const task of active) {
      const rows = seen.get(task.id);
      if (!rows?.length) reject();
      if (task.kind === 'flexible') {
        if (!Number.isSafeInteger(task.remaining_minutes) || rows.reduce((sum, row) => sum + row.end - row.start, 0n) !== BigInt(task.remaining_minutes) * 60000000n) reject();
        if (task.splittable === false && rows.length !== 1) reject();
      } else {
        if (rows.length !== 1) reject();
        if (task.kind === 'fixed' && (rows[0].start !== (instant(task.fixed_start_at) < instant(snapshot.reference_time) ? instant(snapshot.reference_time) : instant(task.fixed_start_at)) || rows[0].end !== instant(task.fixed_end_at))) reject();
        if (task.kind === 'milestone' && rows[0].start !== instant(task.deadline_at)) reject();
      }
    }
  } else if (payload.schedule.length || payload.validation.passed === true) reject();
  return structuredClone(payload);
}

const labels = {
  feasible_found: ['找到一份通过校验的安排', 'result-success', '这是按当前清单找到的一份可行安排。请核对实际作息，执行中有变化就重新生成。'],
  nothing_to_schedule: ['当前没有待安排事项', '', '清单中的事项均已完成或取消，无需继续分配时间。'],
  information_needed: ['先补齐这些条件', 'result-warning', '信息还不完整，本次没有生成安排。补充后请重新确认事项。'],
  unsupported: ['这份清单超出当前排程范围', 'result-warning', '本次没有生成安排，请按下面的原因调整清单。'],
  conflicts_detected: ['当前条件存在冲突', 'result-danger', '本次没有生成安排。请核对冲突原因，调整工作量、空闲或约束后重试。'],
  not_found: ['暂未找到完整安排', 'result-warning', '已尝试四种排序，仍未排入全部事项。这不能证明无解；可调整连续时长、前置关系或空闲后重试。'],
  validation_failed: ['候选安排未通过校验', 'result-danger', '候选时间表已隐藏，清单仍保留。请导出备份并反馈本次问题。'],
};

export function planMarkup(plan, snapshot, readableTime) {
  const [heading, statusClass, help] = labels[plan.status];
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
  const name = id => tasks.get(id)?.title.trim() || '清单';
  const duration = row => {
    const elapsed = Number(instant(row.end) - instant(row.start));
    return elapsed < 60000000 ? `${(elapsed / 1000000).toLocaleString('zh-CN', { maximumFractionDigits: 6 })} 秒` : `${(elapsed / 60000000).toLocaleString('zh-CN', { maximumFractionDigits: 6 })} 分钟`;
  };
  const days = new Map();
  for (const row of [...plan.schedule].sort((a, b) => instant(a.start) < instant(b.start) ? -1 : instant(a.start) > instant(b.start) ? 1 : a.task_id.localeCompare(b.task_id))) {
    const day = readableTime(row.start).slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(row);
  }
  const schedule = [...days].map(([day, rows]) => `<section class="schedule-day" aria-label="${escape(day)}的安排"><h4>${escape(day)}</h4><ol class="schedule-list">${rows.map(row => {
    const task = tasks.get(row.task_id);
    const label = row.kind === 'work' ? '待安排工作' : row.kind === 'milestone' ? '截止节点，不占用工时' : instant(task.fixed_start_at) < instant(snapshot.reference_time) ? '进行中的固定活动，显示剩余占用' : '固定活动';
    const time = row.kind === 'milestone' ? readableTime(row.start).slice(11) : `${readableTime(row.start).slice(11)} 至 ${readableTime(row.end).slice(0, 10) === day ? readableTime(row.end).slice(11) : readableTime(row.end)}`;
    return `<li class="schedule-row"><div class="schedule-time"><time datetime="${escape(row.start)}">${escape(time)}</time>${row.kind === 'milestone' ? '' : `<span>${escape(duration(row))}</span>`}</div><div><strong>${escape(name(row.task_id))}</strong><p>${escape(label)}${task.location ? ` · ${escape(task.location)}` : ''}</p></div></li>`;
  }).join('')}</ol></section>`).join('');
  return `<h3 class="result-heading ${statusClass}">${heading}</h3><p class="result-caption">${help}</p>
    ${plan.status === 'feasible_found' ? `<p class="plan-verification">已校验全部 ${snapshot.tasks.filter(task => !inactive(task)).length} 件未完成事项的空闲归属、固定占用、截止、工时、连续块和前置关系。此安排不改变事项状态。</p>` : ''}
    ${plan.issues.map(issue => `<div class="result-entry"><strong>${escape(name(issue.task_id))}</strong><p>${escape(issue.reason)}</p></div>`).join('')}
    ${plan.conflicts.map(conflict => `<div class="result-entry"><strong class="result-danger">${escape((conflict.tasks || conflict.task_ids?.map(name) || []).join('、'))}</strong><p>${escape(conflict.reason)}</p></div>`).join('')}
    ${schedule}
    <details class="plan-details"><summary>容量与校验依据</summary>${plan.capacity_checks.length ? `<div class="result-table-wrap"><table><caption class="sr-only">各截止节点的累计需要与实际可用时长</caption><thead><tr><th scope="col">截至</th><th scope="col">累计需要</th><th scope="col">实际可用</th></tr></thead><tbody>${plan.capacity_checks.map(check => `<tr><td>${escape(readableTime(check.deadline))}</td><td>${escape(check.known_required_minutes)} 分钟</td><td>${escape(check.available_minutes)} 分钟</td></tr>`).join('')}</tbody></table></div>` : ''}
    <p class="result-caption">从 ${escape(readableTime(plan.horizon.start))} 开始，至 ${escape(readableTime(plan.horizon.end))}。本次尝试 ${plan.algorithm.attempts} 种排序。</p>${[...plan.warnings, ...plan.limitations].map(line => `<p class="result-caption">${escape(line)}</p>`).join('')}<p class="result-caption">修改清单或时间会使本结果失效。请自行预留未录入的路程、休息和其他占用。</p></details>`;
}
