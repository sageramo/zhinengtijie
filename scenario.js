import { editTask, confirmTask, setAvailability, serializeSnapshot, isTimestamp, MAX_SNAPSHOT_BYTES } from './task-state.js';
import { planMarkup, timestampMicros } from './planning-result.js';

const inactive = task => ['completed', 'cancelled'].includes(task.status);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const canCompare = plan => ['feasible_found', 'conflicts_detected', 'not_found'].includes(plan?.status);
function inputError(field, message) {
  throw Object.assign(new Error(message), { scenarioField: field });
}

/** A user-entered hypothesis lives only in memory until explicitly adopted. */
export function buildScenario(snapshot, input) {
  const baseline = serializeSnapshot(snapshot);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请选择一种调整方式。');
  const expected = input.kind === 'remaining' ? ['kind', 'minutes', 'task_id'] : input.kind === 'availability' ? ['end', 'kind', 'start'] : [];
  if (!expected.length || Object.keys(input).sort().join(',') !== expected.join(',')) throw new Error('本轮只支持调整剩余工时或增加空闲，不修改正式截止、固定活动或必做选择。');
  if (snapshot.tasks.some(task => !inactive(task) && (task.status === 'draft' || task.uncertainties.length))) throw new Error('请先核对当前清单，再测算调整。');
  let candidate, summary;
  if (input.kind === 'remaining') {
    const task = snapshot.tasks.find(task => task.id === input.task_id);
    if (!task || inactive(task) || task.kind !== 'flexible') inputError('task_id', '只能测算未完成工作的剩余工时。');
    if (!Number.isSafeInteger(input.minutes) || input.minutes < 1 || input.minutes > 10000000) inputError('minutes', '剩余工时须为1至10000000的整数分钟；已完成请使用“标记完成”。');
    if (input.minutes === task.remaining_minutes) inputError('minutes', '新工时与当前相同，请填写实际变化后的估计。');
    if (task.splittable && input.minutes < task.min_block_minutes) inputError('minutes', '新工时小于最小连续时长，请先核对分段规则；试算不会自动放松约束。');
    // Confirmation applies only to the explicitly requested hypothetical copy.
    candidate = confirmTask(editTask(snapshot, task.id, { remaining_minutes: input.minutes }), task.id);
    summary = `${task.title}：剩余${task.remaining_minutes}分钟 → ${input.minutes}分钟（假设）`;
  } else {
    if (!isTimestamp(input.start)) inputError('start', '请填写有效的新增空闲开始时间。');
    if (!isTimestamp(input.end) || timestampMicros(input.end) <= timestampMicros(input.start)) inputError('end', '请填写完整的新增空闲时段，结束须晚于开始。');
    if (timestampMicros(input.start) < timestampMicros(snapshot.reference_time)) inputError('start', '新增空闲不能早于本次计算起点。');
    if (snapshot.availability.some(row => timestampMicros(row.start) === timestampMicros(input.start) && timestampMicros(row.end) === timestampMicros(input.end))) inputError('start', '这段空闲已经存在，请填写不同的实际时段。');
    candidate = setAvailability(snapshot, [...snapshot.availability, { start: input.start, end: input.end }]);
    summary = '假设可以增加一段实际空闲；重叠部分不会重复增加容量。';
  }
  if (new TextEncoder().encode(serializeSnapshot(candidate)).byteLength > MAX_SNAPSHOT_BYTES) throw new Error('调整后的快照超过15MB，请先导出并拆分清单。');
  return { candidate, proposal: { baseline, input: structuredClone(input), summary } };
}

/** Adoption edits the real snapshot, never installs the hypothetical confirmed copy. */
export function adoptScenario(snapshot, proposal) {
  if (!proposal || proposal.baseline !== serializeSnapshot(snapshot)) throw new Error('当前清单已经变化，旧方案不能采用，请重新测算。');
  buildScenario(snapshot, proposal.input);
  return proposal.input.kind === 'remaining'
    ? editTask(snapshot, proposal.input.task_id, { remaining_minutes: proposal.input.minutes })
    : setAvailability(snapshot, [...snapshot.availability, { start: proposal.input.start, end: proposal.input.end }]);
}

export function scenarioForm(snapshot, toLocalInput) {
  const work = snapshot.tasks.filter(task => !inactive(task) && task.kind === 'flexible');
  const first = work.length ? 'remaining' : 'availability';
  const reference = timestampMicros(snapshot.reference_time);
  const nextMinute = new Date(Number((reference / 60000000n + (reference % 60000000n > 0n ? 1n : 0n)) * 60000n)).toISOString();
  return `<section class="scenario-workbench" aria-labelledby="scenarioHeading"><h3 id="scenarioHeading">试算一项调整</h3><p class="result-caption" id="scenarioHelp">先比较，再决定是否采用。试算不覆盖当前清单；工时应来自实际进展或范围变化，不能为了让结果变绿而改小。点击测算会向当前计算服务发送假设清单，不调用模型。</p>
    <form id="scenarioForm" aria-describedby="scenarioHelp" novalidate><label for="scenarioKind">想调整什么</label><select id="scenarioKind">${work.length ? '<option value="remaining">更新一件工作的剩余工时</option>' : ''}<option value="availability">增加一段可用时间</option></select>
    <fieldset id="scenarioWorkFields" ${first === 'remaining' ? '' : 'hidden disabled'}><legend class="sr-only">剩余工时假设</legend><label for="scenarioTask">选择工作</label><select id="scenarioTask">${work.map(task => `<option value="${escape(task.id)}">${escape(task.title)}（当前${task.remaining_minutes}分钟）</option>`).join('')}</select><label for="scenarioMinutes">假设还需要多少分钟</label><input id="scenarioMinutes" type="text" inputmode="numeric" pattern="[0-9]+" autocomplete="off" placeholder="填写新的剩余分钟，当前值不会自动改变"></fieldset>
    <fieldset id="scenarioAvailabilityFields" ${first === 'availability' ? '' : 'hidden disabled'}><legend class="sr-only">新增空闲假设</legend><div class="field-grid"><label for="scenarioStart">新增空闲开始<input type="datetime-local" id="scenarioStart" value="${escape(toLocalInput(nextMinute))}"></label><label for="scenarioEnd">新增空闲结束<input type="datetime-local" id="scenarioEnd"></label></div><p class="result-caption">只填写实际能够投入的时段，重复或重叠时长不会多算；请保留休息和路程。</p></fieldset>
    <div class="inline-actions"><button type="submit" id="measureScenario">按此假设测算</button></div></form><div id="scenarioOutput" role="status" aria-live="polite"><p class="result-caption">尚未试算。当前清单和上面的结果保持原样。</p></div></section>`;
}

const labels = { feasible_found: '找到通过校验的完整安排', conflicts_detected: '存在已发现的条件冲突', not_found: '暂未找到完整安排', information_needed: '仍需补充或核对条件', unsupported: '超出当前支持范围', validation_failed: '候选未通过独立校验', nothing_to_schedule: '没有待安排事项' };
const shortage = plan => Math.max(0, ...plan.capacity_checks.map(check => check.known_required_minutes - check.available_minutes));
const number = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
export function comparisonMarkup(current, hypothetical, proposal, candidate, readableTime) {
  const assumption = proposal.input.kind === 'availability'
    ? `假设新增空闲：${readableTime(proposal.input.start)} 至 ${readableTime(proposal.input.end)}` : proposal.summary;
  return `<p class="scenario-assumption">${escape(assumption)}</p><div class="result-table-wrap"><table><caption>当前清单与假设方案对比</caption><thead><tr><th scope="col">检查项</th><th scope="col">当前清单</th><th scope="col">假设方案，尚未采用</th></tr></thead><tbody><tr><th scope="row">完整排程结果</th><td>${escape(labels[current.status])}</td><td>${escape(labels[hypothetical.status])}</td></tr><tr><th scope="row">最大已知累计缺口</th><td>${number(shortage(current))} 分钟</td><td>${number(shortage(hypothetical))} 分钟</td></tr><tr><th scope="row">已发现的冲突项</th><td>${current.conflicts.length}</td><td>${hypothetical.conflicts.length}</td></tr></tbody></table></div><p class="result-caption">缺口取各截止节点的最大值，不把累计缺口相加；0分钟仍须结合完整排程结果判断。</p>
    <details><summary>查看假设下的完整结果</summary><p class="result-caption">以下时间表仅在这项假设成立时有效，尚未写入你的当前清单。</p>${planMarkup(hypothetical, candidate, readableTime)}</details>
    <label class="check-label"><input type="checkbox" id="scenarioReality">我确认改动符合实际，愿意写入当前清单。</label><p class="result-caption">${proposal.input.kind === 'remaining' ? '采用后该工作恢复待核对，请重新确认；试算结果不会直接替换正式安排。' : '采用后新增时段成为你确认的空闲，仍需重新生成正式安排。'}</p><div class="inline-actions"><button type="button" data-scenario-action="adopt" disabled>采用改动</button><button type="button" class="text-button" data-scenario-action="discard">放弃此方案</button></div>`;
}
