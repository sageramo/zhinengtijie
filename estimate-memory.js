/**
 * 越用越准的估时: when a 截止之事 is marked done, the user may say how long it really took. Those
 * minutes are kept per kind of work (writing, homework, forms, …) in this browser only, and a new
 * task of the same kind without an estimate gets "按你以往…约N分钟" as a one-tap suggestion.
 * Pure functions over a plain object { kind: [minutes, …] }; the page stores it in localStorage.
 */
export const MEMORY_KEY = 'sixu.actuals';
const KEEP = 8;
// First match wins, so narrower kinds come first.
export const KINDS = [
  ['展示', /PPT|ppt|幻灯|展示|汇报|演讲|答辩|路演/],
  ['填报', /报名|登记|填表|填写|问卷|申请表|提交表|签到|确认/],
  ['写作', /报告|论文|作文|心得|总结|感想|综述|文案|稿/],
  ['复习', /复习|备考|背诵|考试|测验|期中|期末|四六级/],
  ['作品', /作品|剪辑|拍摄|视频|海报|设计|排版|整理/],
  ['阅读', /阅读|读书|读完|看完|文献/],
  ['作业', /作业|习题|练习|题目|实验|上机/],
];
export function kindOf(title) {
  const text = String(title || '');
  return KINDS.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

/** A copy of the memory with one more actual duration for this kind of task. */
export function recordActual(memory, title, minutes) {
  const kind = kindOf(title);
  if (!kind || !Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) return memory;
  const list = [...(Array.isArray(memory?.[kind]) ? memory[kind] : []), minutes].slice(-KEEP);
  return { ...(memory || {}), [kind]: list };
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const lengthText = minutes => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours && rest ? `${hours}小时${rest}分` : hours ? `${hours}小时` : `${rest}分钟`;
};

/** The suggestion for a task title: the median of past actuals of its kind, rounded to 15 minutes. */
export function suggestEstimate(memory, title) {
  const kind = kindOf(title);
  const list = kind && Array.isArray(memory?.[kind]) ? memory[kind].filter(Number.isFinite) : [];
  if (!list.length) return null;
  const minutes = Math.max(15, Math.round(median(list) / 15) * 15);
  return { kind, minutes, count: list.length, label: `按你以往${list.length}次「${kind}」约${lengthText(minutes)}` };
}

export function readMemory(storage) {
  try {
    const value = JSON.parse(storage?.getItem(MEMORY_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function writeMemory(storage, memory) {
  try { storage?.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch { /* kept for this visit */ }
}

// ---- 个人承诺校准闭环（预计 vs 实际偏差系数，与后端 calibration.py 口径一致） ----
export const CALIBRATION_KEY = 'sixu.calibration';
const KEEP_CALIBRATION = 12;
const clampRatio = ratio => Math.max(0.3, Math.min(4.0, ratio));

/** Record one (estimated, actual) pair for bias calibration; preserves existing actual-duration memory separately. */
export function recordCalibration(log, title, estimatedMinutes, actualMinutes) {
  if (!Number.isFinite(estimatedMinutes) || !Number.isFinite(actualMinutes)) return log || [];
  if (estimatedMinutes < 5 || actualMinutes < 5 || estimatedMinutes > 24 * 60 || actualMinutes > 24 * 60) return log || [];
  const kind = kindOf(title);
  const entry = { kind, title: String(title || '').slice(0, 60), estimated_minutes: Math.round(estimatedMinutes), actual_minutes: Math.round(actualMinutes) };
  return [...(Array.isArray(log) ? log : []), entry].slice(-(KEEP_CALIBRATION * 3));
}

/** Return personal inflation factor (median of actual/estimated) for a kind or globally when >= 2 samples exist. */
export function calibrationFor(log, titleOrKind) {
  const list = Array.isArray(log) ? log : [];
  const targetKind = KINDS.some(([k]) => k === titleOrKind) ? titleOrKind : kindOf(titleOrKind);
  const ratiosOf = items => items
    .filter(item => Number.isFinite(item?.estimated_minutes) && Number.isFinite(item?.actual_minutes) && item.estimated_minutes >= 5 && item.actual_minutes >= 5)
    .map(item => clampRatio(item.actual_minutes / item.estimated_minutes))
    .slice(-KEEP_CALIBRATION);
  const kindRatios = targetKind ? ratiosOf(list.filter(item => (item.kind || kindOf(item.title)) === targetKind)) : [];
  const allRatios = ratiosOf(list);
  const used = kindRatios.length >= 2 ? kindRatios : allRatios.length >= 2 ? allRatios : [];
  const source = kindRatios.length >= 2 ? `kind:${targetKind}` : allRatios.length >= 2 ? 'global' : 'none';
  const factor = used.length ? Math.round(median(used) * 100) / 100 : 1;
  return { kind: targetKind, source, factor, count: used.length };
}

/** Calibrate a nominal duration (minutes) rounded up to 5-minute granularity using personal history. */
export function calibratedMinutes(log, titleOrKind, nominalMinutes) {
  const profile = calibrationFor(log, titleOrKind);
  const minutes = profile.count >= 2 ? Math.max(5, Math.ceil((nominalMinutes * profile.factor) / 5) * 5) : nominalMinutes;
  return { ...profile, nominal: nominalMinutes, minutes };
}

export function readCalibration(storage) {
  try {
    const value = JSON.parse(storage?.getItem(CALIBRATION_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function writeCalibration(storage, log) {
  try { storage?.setItem(CALIBRATION_KEY, JSON.stringify(log)); } catch { /* kept for this visit */ }
}
