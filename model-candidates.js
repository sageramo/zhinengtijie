import { createTask, isTimestamp } from './task-state.js';

const fields = ['title', 'kind', 'deadline_at', 'fixed_start_at', 'fixed_end_at', 'visit_windows', 'location', 'materials', 'evidence', 'uncertainties'];
const sourcedFields = new Set(['title', 'kind', 'deadline_at', 'fixed_start_at', 'fixed_end_at', 'visit_windows', 'location', 'materials']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() && Array.from(value).length <= max;
const strings = (value, count, max) => Array.isArray(value) && value.length <= count && value.every(item => text(item, max));
function requireShape(value, keys) {
  if (!object(value) || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('模型服务返回的事项结构不匹配，请检查工作流版本；清单没有改动。');
}
function invalid() { throw new Error('模型候选缺少有效原文依据或字段不合法，清单没有改动。请检查工作流后重试。'); }

/** Accept only extraction data. User decisions and task identity are always local. */
export function modelCandidates(result, source) {
  requireShape(result, ['schema_version', 'provider', 'parsing_status', 'candidates', 'warnings']);
  if (result.schema_version !== 1 || result.provider !== 'dify' || result.parsing_status !== 'needs_confirmation' || !Array.isArray(result.candidates) || result.candidates.length > 40 || !strings(result.warnings, 40, 1000) || !text(source?.id, 100) || !text(source?.text, 100000)) invalid();
  return result.candidates.map(candidate => {
    requireShape(candidate, fields);
    if (!text(candidate.title, 200) || !['flexible', 'fixed', 'milestone', 'visit_window'].includes(candidate.kind) || !strings(candidate.materials, 30, 500) || !strings(candidate.uncertainties, 100, 1000) || !(candidate.location === null || text(candidate.location, 500))) invalid();
    for (const key of ['deadline_at', 'fixed_start_at', 'fixed_end_at']) if (candidate[key] !== null && !isTimestamp(candidate[key])) invalid();
    if (!Array.isArray(candidate.visit_windows) || candidate.visit_windows.length > 40) invalid();
    for (const window of candidate.visit_windows) {
      requireShape(window, ['start', 'end']);
      if (!isTimestamp(window.start) || !isTimestamp(window.end) || Date.parse(window.start) >= Date.parse(window.end)) invalid();
    }
    if (candidate.kind === 'fixed') {
      if (candidate.deadline_at || candidate.visit_windows.length || (!candidate.fixed_start_at && candidate.fixed_end_at) || (candidate.fixed_start_at && candidate.fixed_end_at && Date.parse(candidate.fixed_start_at) >= Date.parse(candidate.fixed_end_at))) invalid();
    } else if (candidate.fixed_start_at || candidate.fixed_end_at || (candidate.kind !== 'visit_window' && candidate.visit_windows.length) || (candidate.kind === 'visit_window' && candidate.deadline_at)) invalid();
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length > 100) invalid();
    for (const evidence of candidate.evidence) {
      requireShape(evidence, ['field', 'origin', 'quote']);
      if (!sourcedFields.has(evidence.field) || evidence.origin !== 'source_text' || !text(evidence.quote, 3000) || !source.text.includes(evidence.quote)) invalid();
    }
    const supported = field => candidate.evidence.some(item => item.field === field);
    for (const field of ['title', 'kind', 'deadline_at', 'fixed_start_at', 'fixed_end_at', 'location']) if (candidate[field] !== null && !supported(field)) invalid();
    if (candidate.visit_windows.length && !supported('visit_windows')) invalid();
    if (candidate.location !== null && !candidate.evidence.some(item => item.field === 'location' && item.quote === candidate.location)) invalid();
    if (candidate.materials.some(material => !candidate.evidence.some(item => item.field === 'materials' && item.quote === material))) invalid();
    const task = createTask(candidate.kind, source.id);
    for (const key of fields.filter(key => !['evidence', 'uncertainties'].includes(key))) task[key] = structuredClone(candidate[key]);
    task.evidence = candidate.evidence.map(item => ({ ...item, source_id: source.id }));
    task.uncertainties = [...new Set([...candidate.uncertainties, ...result.warnings, '模型生成的事项名称、类型及原文关联均需核对；原文片段存在不代表理解一定正确。'])];
    return task;
  });
}
