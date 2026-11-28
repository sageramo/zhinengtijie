// Shared by 研墨 and 画卷 on the web and in the mini program.
import { minutesLabel, remainingCapacity, weekStart, weekRange } from './calendar.js';
import { isPersonal, isRoughPersonalBounds, setPersonalDay, setReferenceTime, updateTask } from './time-state.js';

const MINUTE = 60000;
const DAY = 1440 * MINUTE;
const OFFSET = 8 * 60 * MINUTE;
const number = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]{1,3})`;
const duration = String.raw`(?:半\s*(?:个\s*)?小时|(?<hours>${number})\s*(?:个\s*(?<leadingHalf>半\s*)?)?(?:小时|h(?![a-z]))(?:\s*(?<extra>${number})\s*分钟|\s*(?<half>半))?|(?<minutes>${number})\s*分钟)`;
const durationPattern = new RegExp(String.raw`(?<![\d.点:：])${duration}`, 'gi');
const reservePrefix = /(?:预留|保留|留(?:出|下|够)?)\s*$/;
const reserveSuffix = /^\s*(?:(?:的)?(?:休息|留白|缓冲)(?:时间)?|(?:给|用来|用于)\s*(?:休息|放松|吃饭))/;
const numberValue = value => {
  if (/^\d/.test(value)) return Number(value);
  const digit = char => '零一二三四五六七八九'.indexOf(char === '两' ? '二' : char === '〇' ? '零' : char);
  if (!value.includes('十')) return value.length === 1 && digit(value) >= 0 ? digit(value) : NaN;
  if (!/^[一二两三四五六七八九]?十[一二两三四五六七八九]?$/.test(value)) return NaN;
  const [tens, ones] = value.split('十');
  return (tens ? digit(tens) : 1) * 10 + (ones ? digit(ones) : 0);
};
const durationMinutes = match => {
  const { hours, extra, half, leadingHalf, minutes } = match.groups;
  const value = hours ? numberValue(hours) * 60 + (extra ? numberValue(extra) : half || leadingHalf ? 30 : 0)
    : minutes ? numberValue(minutes) : 30;
  return Math.ceil(value);
};
const dayOf = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);
const dayLabel = ms => dayOf(ms).slice(5).replace('-', '月') + '日';
const clock = ms => new Date(ms + OFFSET).toISOString().slice(11, 16);

const WEEKDAY_CHARS = '一二三四五六日天';
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** The day-level scope of a question: 今天/明天/周末/下周末/本周X/下周X/本周/下周 (default: this week). */
export function questionScope(text) {
  const weekendMatch = text.match(/(下个?|本|这)?周末/);
  const weekdayMatch = text.match(/(下个?|本|这)?(?:周|星期|礼拜)([一二三四五六日天])/);
  let scope = 'week';
  let weekdayIndex = null;
  let weekdayNext = false;
  if (weekendMatch) {
    scope = weekendMatch[1] && weekendMatch[1].startsWith('下') ? 'next_weekend' : 'weekend';
  } else if (weekdayMatch) {
    scope = 'weekday';
    const rawIdx = WEEKDAY_CHARS.indexOf(weekdayMatch[2]);
    weekdayIndex = rawIdx === 7 ? 6 : rawIdx;
    weekdayNext = Boolean(weekdayMatch[1] && weekdayMatch[1].startsWith('下'));
  } else if (/明天|明早|明晚/.test(text)) {
    scope = 'tomorrow';
  } else if (/下周/.test(text)) {
    scope = 'next';
  } else if (/今天|今晚|今日/.test(text)) {
    scope = 'today';
  }
  return { scope, weekdayIndex, weekdayNext };
}

function capacityQuestion(text) {
  const planning = /(?:^试算|剩.*(?:时间|空档|空闲|留白|空(?=$|[？?！!。，,、\s]))|(?:多少|几个|多长).*(?:时间|空档|空闲|留白|空(?=$|[？?！!。，,、\s]))|还有.*(?:空档|空闲|留白|空(?=$|[？?！!。，,、\s]))|有没有(?:时间|空|空档|空闲)|有时间(?:吗|没|么|去|参加|做|[？?])|有空(?:吗|没|么|去|参加|做|[？?])|(?:还)?有(?:时间|空)[^，,。；;\n]{0,10}(?:吗|么|没有?|[？?])|(?:排|安排|忙|顾)得(?:开|过来|下)|(?:能|可以)出去|出去玩|能(?:不能)?(?:参加|去|抽空|安排)|可(?:以|不可以)(?:参加|去)|排得下|排不下|时间够|够不够|来得及|(?:再接|能接|还能|想接).*(?:社团|活动|组织|工作))/;
  if (/\n|^【|^.{0,12}通知[:：]|各位同学|请各班/.test(text) || text.length > 250) return null;
  if (!planning.test(text)) return null;
  const needed = [], reserved = [];
  let masked = text;
  const durationRange = /[\d一二两三四五六七八九十半]\s*(?:到|至|[-~～–—])\s*(?:\d|[一二两三四五六七八九十半])/;
  for (const match of text.matchAll(durationPattern)) {
    const end = match.index + match[0].length;
    const prefix = text.slice(0, match.index);
    const suffix = text.slice(end);
    const values = reservePrefix.test(prefix) || reserveSuffix.test(suffix) ? reserved : needed;
    values.push(durationMinutes(match));
    masked = masked.slice(0, match.index) + ' '.repeat(match[0].length) + masked.slice(end);
  }
  // Ask for an explicit minute count when any part of the request is still ambiguous.
  const ambiguous = ((needed.length || reserved.length) > 0 && durationRange.test(text) && !/\d{1,2}[:：]\d{2}/.test(text))
    || needed.length > 1 || reserved.length > 1
    || [...needed, ...reserved].some(value => !Number.isSafeInteger(value))
    || /(?:预留|保留|留(?:出|下|够)?)\s*[^，,。]{0,10}(?:休息|缓冲|小时|钟头|分钟|个钟)/.test(masked) && !reserved.length
    || /[\d半一二两三四五六七八九十几]+\s*(?:个\s*)?(?:小时|钟头|分钟|个钟|天|个半小时)/.test(masked);
  // Specific clock times or calendar dates still need visual checking on 画卷;
  // day-level scopes (今天/明天/周末/下周末/本周X/下周X/本周/下周) are computed directly here!
  const fixed = /(?:上午|下午|中午|晚上|早上)|\d{1,2}(?:月|日|号|点|[:：]\d{2})/.test(text);
  const { scope, weekdayIndex, weekdayNext } = questionScope(text);
  return { scope, weekdayIndex, weekdayNext,
    needed: needed[0] ?? null, reserve: reserved[0] ?? 0, ambiguous, fixed,
    split: /(?:可以|能|允许|愿意)拆|分开做|分几次/.test(text) && !/不能拆|不可以拆|一次做完/.test(text) };

}

function capacityBounds(question, now) {
  const scope = typeof question === 'string' ? question : question.scope;
  const week = weekStart(now);
  const nowMin = Math.ceil(now / MINUTE) * MINUTE;
  const dayStart = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET;
  if (scope === 'today') return { start: week, from: nowMin, to: dayStart + DAY, label: '今天' };
  if (scope === 'tomorrow') {
    const tom = dayStart + DAY;
    return { start: weekStart(tom), from: tom, to: tom + DAY, label: '明天' };
  }
  if (scope === 'weekend' || scope === 'next_weekend') {
    const baseWeek = scope === 'next_weekend' ? week + 7 * DAY : week;
    const sat = baseWeek + 5 * DAY;
    const sunEnd = baseWeek + 7 * DAY;
    return { start: baseWeek, from: Math.max(sat, nowMin), to: sunEnd, label: scope === 'next_weekend' ? '下周末' : '本周末' };
  }
  if (scope === 'weekday' && typeof question === 'object' && Number.isInteger(question.weekdayIndex)) {
    const todayIdx = Math.floor((dayStart - week) / DAY);
    const offsetWeeks = question.weekdayNext || question.weekdayIndex < todayIdx ? 1 : 0;
    const baseWeek = week + offsetWeeks * 7 * DAY;
    const targetDay = baseWeek + question.weekdayIndex * DAY;
    const prefix = offsetWeeks ? '下' : '本';
    return { start: baseWeek, from: Math.max(targetDay, nowMin), to: targetDay + DAY, label: `${prefix}${WEEKDAY_LABELS[question.weekdayIndex]}` };
  }
  const start = scope === 'next' ? week + 7 * DAY : week;
  return { start, from: Math.max(start, nowMin), to: start + 7 * DAY, label: scope === 'next' ? '下周' : '本周' };
}

export async function answerCapacity(snapshot, question, now, calculate) {
  const bounds = capacityBounds(question, now);
  const { start, from, to, label } = bounds;
  if (question.ambiguous) return { text: '请分别写清新增用时和想预留的时间，例如「再接90分钟，留30分钟休息」。' };
  if (question.fixed) return { text: '这次试算支持今天、明天、周末、具体某天或整周的总量和连续空档。你提到了具体钟点或日期，可以到画卷核对那一段是否有安排。', action: 'calendar', week: start };
  if (!snapshot.daily_window) return { text: '先设置作息，再把课表和固定例会补进来，我才能估算还有多少时间。', action: 'setup' };
  if (question.needed === 0) return { text: '新承诺至少需要 1 分钟，请再告诉我预计用时。' };
  const nowMinute = Math.ceil(now / MINUTE) * MINUTE;
  const savedRef = Date.parse(snapshot.reference_time);
  // If the user asks about a window before a future demo reference_time, calculate from real `now`
  // so current/weekend tasks are never falsely treated as overdue.
  const reference = savedRef >= to ? nowMinute : Math.max(nowMinute, savedRef);
  const current = setReferenceTime(snapshot, new Date(reference).toISOString());
  const result = await calculate({ snapshot: current, range: weekRange(start), now: new Date(nowMinute).toISOString() });
  const capacity = remainingCapacity(result, from, to);
  if (!capacity) return { text: '作息还未设置，暂时算不出可用时间。', action: 'setup' };
  const { total, longest, slots } = capacity;
  const byId = new Map([...snapshot.tasks, ...snapshot.events].map(item => [item.id, item]));
  const affects = issue => {
    const item = byId.get(issue.id);
    if (!item) return false;
    const date = Date.parse(item.start_at || item.deadline_at);
    if (issue.type.endsWith('_time_invalid') || issue.type === 'event_time_pending') return true;
    if (item.start_at) return date < to;
    const earliest = Date.parse(item.earliest_start_at);
    return (!Number.isFinite(earliest) || earliest < to) && (!Number.isFinite(date) || date >= from);
  };
  const pending = result.undefined.filter(affects).length;
  const unestimated = snapshot.tasks.filter(task => task.status === 'active' && task.estimate_minutes === null && task.deadline_at !== null
    && !result.undefined.some(issue => issue.id === task.id) && affects({ id: task.id, type: 'estimate_undefined' })).length;
  const shortages = result.conflicts.filter(issue => issue.type === 'work_shortage' && issue.items.some(affects)).length;
  let text = `${label}还剩 ${minutesLabel(total)}，最长连续 ${minutesLabel(longest)}。已扣除已录入的固定占用和已排任务。`;
  if (question.needed !== null) {
    const { needed, reserve, split } = question;
    const available = Math.max(0, total - reserve);
    const missing = needed + reserve - total;
    if (missing > 0) text += ` 按新增 ${minutesLabel(needed)}、预留 ${minutesLabel(reserve)} 算，总量还差 ${minutesLabel(missing)}。`;
    else if (!split && longest < needed) text += ` 预留 ${minutesLabel(reserve)} 后总量够，但没有连续 ${minutesLabel(needed)} 的空档。可以试着分开做，或先确定活动的具体时段。`;
    else {
      text += ` 按${split ? '可分开做' : '一次做完'}估算，${minutesLabel(needed)}排得下，扣掉预留的 ${minutesLabel(reserve)}后还剩 ${minutesLabel(available - needed)}。`;
      const slot = !split && slots.find(item => item.end - item.start >= needed * MINUTE);
      if (slot) {
        const end = slot.start + needed * MINUTE;
        text += ` 例如 ${dayLabel(slot.start)} ${clock(slot.start)}–${dayOf(end) === dayOf(slot.start) ? clock(end) : '24:00'}。`;
      }
    }
  } else {
    if (question.reserve) text += ` 预留 ${minutesLabel(question.reserve)}后，${total < question.reserve ? `还差 ${minutesLabel(question.reserve - total)} 才能留足。` : `还可用 ${minutesLabel(total - question.reserve)}。`}`;
    const examples = slots.filter(s => s.end - s.start >= 30 * MINUTE).slice(0, 3)
      .map(s => `${dayLabel(s.start)} ${clock(s.start)}–${dayOf(s.end) === dayOf(s.start) ? clock(s.end) : '24:00'}`);
    if (examples.length) text += ` 可用空档例如：${examples.join('、')}。`;
    text += ' 说一下新承诺预计几小时，就可以试算。';
  }
  if (pending || shortages) text += ` 还有 ${pending + shortages} 件待补时间或尚未排下的事，补齐后空档可能减少。`;
  if (unestimated) text += ` 另有 ${unestimated} 件未估时的截止事项未占空档，若耗时较多需自行预留。`;
  if (!snapshot.routines.length) text += ' 当前清单还没有课表或固定例会。';
  else if (!snapshot.routines_confirmed) text += ' 请确认课表和固定例会已经补齐。';
  // The numbers behind the answer, so a page can check them against the user's own track record.
  return { text, action: 'calendar', week: start, capacity: question.needed !== null ? { needed: question.needed, reserve: question.reserve, split: question.split, scope: question.scope } : null };
}

// Explicit conversational commands can only touch the most recent, still-existing personal task.
// ---- 排不排得开：一句话里的几项活动 ------------------------------------------------------------------
// "这周末出去玩半天、写3小时作业、社团2小时，排得开吗" -> two or more activities, each with a length,
// for /api/v3/capacity/plan (capacity_plan_v1). Rules only: the backend does the placing.
const SPANS = [[/一整天|一天/, 600], [/半天|一上午|一下午|整个上午|整个下午/, 240], [/一晚上|一个晚上|整晚|半晚/, 180]];
const CATEGORIES = [
  [/作业|复习|学习|论文|报告|背单词|背书|刷题|自习|预习|考试|课设|实验|网课|写代码|读书/, 'study'],
  [/社团|学生会|部门|志愿|例会|排练|训练|比赛|招新|值班|班会/, 'club'],
  [/休息|睡觉|补觉|放松|躺/, 'rest'],
  [/玩|逛|电影|唱歌|聚餐|吃饭|约会|旅游|爬山|打球|球|游戏|聚会|出去|追剧|看剧|购物|健身|运动|跑步/, 'leisure'],
];
const FILLER = /^(?:我|自己|上午|下午|中午|晚上|早上|白天|夜里|这周末|本周末|下周末|周末|这周|本周|下周|今天|明天|后天|今晚|明晚|(?:下个?|本|这)?(?:周|星期|礼拜)[一二三四五六日天]|还|还要|还得|要|想|想要|打算|准备|得|需要|大概|大约|再|去|花|用|安排|留)+|(?:左右|上下|的时间|时间|吧|呢|吗|么|，|,)+$/g;
const ASKS = /(?:排得开|排不开|排得下|排不下|够不够|够吗|来得及|来不及|能不能|可不可以|行不行|有没有时间|还有时间|有空|安排得过来|忙得过来|[？?]$|吗$)/;
export function parseActivities(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 200 || /\n|^【|通知|各位同学/.test(line) || !ASKS.test(line)) return null;
  const parts = line.replace(/[。！!？?]+$/, '').split(/[、，,；;]|还要|还得|另外|以及|然后|加上|并且|和|跟|再/).map(part => part.trim()).filter(Boolean);
  const activities = [];
  let reserve = 0;
  for (const part of parts) {
    let minutes = null;
    let rest = part;
    const match = [...part.matchAll(durationPattern)][0];
    if (match) { minutes = durationMinutes(match); rest = part.slice(0, match.index) + part.slice(match.index + match[0].length); }
    else {
      const span = SPANS.find(([pattern]) => pattern.test(part));
      if (span) { minutes = span[1]; rest = part.replace(span[0], ''); }
    }
    if (!Number.isSafeInteger(minutes) || minutes < 1) continue;
    if (/(?:预留|保留|留(?:出|下|够)?).*(?:休息|放松|缓冲)|(?:休息|放松|缓冲).*(?:预留|保留)/.test(part)) { reserve += minutes; continue; }
    const title = rest.replace(ASKS, '').replace(FILLER, '').replace(/^[写做看去打上参加]?$/, '').trim();
    const category = (CATEGORIES.find(([pattern]) => pattern.test(part)) || [null, 'other'])[1];
    const name = title || { study: '学习', club: '社团', rest: '休息', leisure: '出去玩', other: '活动' }[category];
    const preferred = /晚上|今晚|明晚|夜里/.test(part) ? 'evening' : /白天|上午|下午|中午/.test(part) ? 'daytime' : 'any';
    const splittable = category === 'study';
    activities.push({ title: name.slice(0, 40), minutes: Math.min(minutes, 10080), category, splittable,
      ...(splittable ? { min_block_minutes: Math.min(60, minutes) } : {}), preferred });
  }
  if (activities.length < 2) return null;
  return { ...questionScope(line), activities, reserve_rest_minutes: Math.min(reserve, 10080) };
}

export async function agendaReply(text, { snapshot, lastTaskId, calculate, now = Date.now() }) {
  const line = text.trim().replace(/[。！!？?]+$/, '');
  if (/(?:每天|每晚|每早|每周|每个星期|工作日).*(?:提醒我|问(?:一问|一下)?我|叫我)|(?:提醒我|问我).*(?:每天|每晚|每早|每周)|^到点(?:叫|提醒|问)我/.test(line)) {
    return { text: '这类定时追问需要重复提醒。现在可以帮你记一次任务，并把完成结果记在清单里。' };
  }
  const question = !/^(?:提醒我|帮我记|别忘了|记得|待办)/.test(line) && capacityQuestion(line);
  if (question) return answerCapacity(snapshot, question, now, calculate);
  const completed = /^(?:我)?(?:刚刚|已经)?(?:做完了|完成了|搞定了|交了|练了|练完了|好了|做了|健身了|做完啦|完成啦)$/;
  const unfinished = /^(?:我)?(?:今天)?(?:还没做(?:完)?|没做|没练|没完成|没有完成|没健身)(?:了)?$/;
  const move = line.match(/^(?:把它|把刚才那件事|那件事)?(?:改到|挪到|推到)(今天|明天|后天)(?:做)?$/);
  const changeDuration = line.match(new RegExp(String.raw`^(?:它|刚才那件事)?(?:大概|大约|预计|要用|需要|用时|改成|要)?\s*${duration}(?:左右|吧|就够了)?$`, 'i'));
  if (completed.test(line) || unfinished.test(line) || move || changeDuration) {
    const task = snapshot.tasks.find(item => item.id === lastTaskId && isPersonal(item) && item.status !== 'cancelled');
    if (!task) return { text: '你说的是哪件事？可以在落笔里找到对应任务并更新。', action: 'tasks' };
    if (move && task.status !== 'active') return { text: `「${task.title}」已经完成。可以在落笔里恢复后改期。`, action: 'tasks' };
    if (move && hasPersonalClock(task)) {
      return { text: `「${task.title}」有具体截止。请在落笔里核对并修改截止时间。`, action: 'tasks' };
    }
    if (move) {
      const day = dayOf(now + ['今天', '明天', '后天'].indexOf(move[1]) * DAY);
      return { text: `把「${task.title}」挪到 ${move[1]}了。`, next: setPersonalDay(snapshot, task.id, day), action: 'calendar' };
    }
    if (changeDuration) {
      const estimate = durationMinutes(changeDuration);
      if (!Number.isSafeInteger(estimate) || estimate < 1 || estimate > 20160) return { text: '预计用时需要在 1 到 20160 分钟之间。' };
      return { text: `「${task.title}」的预计用时改成 ${minutesLabel(estimate)}。`,
        next: updateTask(snapshot, task.id, { estimate_minutes: estimate }), action: 'calendar' };
    }
    if (unfinished.test(line)) return { text: task.status === 'completed'
      ? `「${task.title}」已经标成完成，可以在落笔里恢复。`
      : `「${task.title}」还留在待做清单里。要换一天，可以说“挪到明天”。`, action: 'tasks' };
    return { text: `已把「${task.title}」标记完成。`,
      next: task.status === 'active' ? updateTask(snapshot, task.id, { status: 'completed' }) : null, action: 'tasks' };
  }
  if (/^(?:你好[呀啊！!，, ]*|嗨|哈喽|hello|hi|早上好|晚上好|早安|晚安)$/i.test(line)) {
    return { text: '你好，我在。今天有什么想记的，或者想一起看看这周的安排？' };
  }
  if (/^(?:谢谢(?:你|啦)?|好的|好呀|收到|明白了|知道了|嗯嗯|好)$/i.test(line)) {
    return { text: '好，有新安排随时告诉我。' };
  }
  if (/^(?:唉|好累|今天好累|我好累|最近好累|有点累|今天有点累|我今天好累|我累了|最近压力好大)$/.test(line)) {
    return { text: '听起来今天已经用了不少精力。如果还在犹豫要不要接新事情，可以先说说想给自己留几小时，我帮你看看还剩多少空间。' };
  }
  return null;
}

export function isConversation(text) {
  return !/^(?:提醒我|帮我记|记得|别忘了|待办)|【|通知|各位同学|报名方式/.test(text)
    && (/[？?]$|(?:吗|呢|如何|怎么办)$|(?:有没有|能不能|可不可以|是否|会不会)/.test(text) || /^(?:聊|陪我|我觉得|我感觉|我今天(?:好|很|有点)|我最近)/.test(text));
}

// Timed personal tasks should expose the original clock time when users edit the list.
export const hasPersonalClock = task => isPersonal(task) && Boolean(task.deadline_at)
  && !isRoughPersonalBounds(task);
