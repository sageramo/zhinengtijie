import { candidateTimestamp } from './task-state.js';

function ambiguousContext(sourceText, evidence) {
  let position = 0;
  while (true) {
    const found = sourceText.indexOf(evidence, position);
    if (found < 0) return false;
    const before = sourceText.slice(0, found).search(/[^。；;\n！？!?]*$/);
    const tail = sourceText.slice(found + evidence.length).search(/[。；;\n！？!?]/);
    const end = tail < 0 ? sourceText.length : found + evidence.length + tail;
    if (/左右|大约|大概|约为|预计|暂定|待定|择日|另行通知|视情况|任选|或|约(?=[0-9一二三四五六七八九十本这下今明昨后])|每天|每日|每周|工作日|节假日|次日起|隔日|隔天|周末/.test(sourceText.slice(before, end))) return true;
    position = found + evidence.length;
  }
}

/** Resolve only the source fragments already associated with this draft. */
export function reviewTimePatch(result, task, source) {
  if (task.status !== 'draft' || !source || task.source_id !== source.id) throw new Error('只可补全当前待核对事项的原文时间。');
  const fields = task.kind === 'fixed' ? ['fixed_start_at', 'fixed_end_at'] : ['deadline_at'];
  const quotes = [...new Set(task.evidence.filter(item => item.origin === 'source_text' && item.source_id === source.id && fields.includes(item.field) && typeof item.quote === 'string' && source.text.includes(item.quote)).map(item => item.quote))];
  const points = (Array.isArray(result?.time_points) ? result.time_points : []).filter(point =>
    point.precision === 'datetime' && ['point', 'interval'].includes(point.kind) &&
    typeof point.evidence === 'string' && point.evidence.length > 0 && source.text.includes(point.evidence) &&
    quotes.some(quote => quote.includes(point.evidence)));
  if (points.length !== 1) throw new Error('原文时间仍不唯一、含重复规则或缺少日期时刻，请直接核对并填写；没有修改事项。');
  const point = points[0];
  if (ambiguousContext(source.text, point.evidence)) throw new Error('原文含暂定、约数或选择关系，补参照日不能消除这些歧义，请手动核实。');
  const start = candidateTimestamp(point.value, point.timezone);
  const end = candidateTimestamp(point.end_value, point.timezone);
  const patch = {};
  if (task.kind === 'fixed') {
    if (!/活动|比赛|考试|面试|签到|抽签/.test(point.time_type || '')) throw new Error('原文尚不能确定为固定活动时间，请核对类型后手动填写。');
    if (start && task.fixed_start_at === null) patch.fixed_start_at = start;
    if (point.kind === 'interval' && start && end && Date.parse(end) > Date.parse(start) && task.fixed_end_at === null) patch.fixed_end_at = end;
  } else if (['flexible', 'milestone'].includes(task.kind)) {
    if (point.kind !== 'point' || !/报名|材料|提交|截止|撤回|退赛|结果|公示/.test(point.time_type || '')) throw new Error('该原文时间尚不能认定为截止节点，请手动核对；没有修改事项。');
    if (start && task.deadline_at === null) patch.deadline_at = start;
  } else throw new Error('办理窗口暂不支持此补全操作，请核对后手动处理。');
  if (!Object.keys(patch).length) throw new Error('没有可从原文补全的空白字段；原文未给出的结束时间，需要按你的计划填写。');
  const proposedStart = patch.fixed_start_at || task.fixed_start_at;
  const proposedEnd = patch.fixed_end_at || task.fixed_end_at;
  if (task.kind === 'fixed' && proposedStart && proposedEnd && Date.parse(proposedStart) >= Date.parse(proposedEnd)) throw new Error('补全后的时间与已有输入不一致，请手动核对；没有修改事项。');
  return patch;
}
