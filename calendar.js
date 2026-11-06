import { isTimestamp } from './task-state.js';

/**
 * Week calendar for the workbench (Beijing time, weeks start on Monday). Pure markup from the
 * snapshot and, when one is current, the generated plan: free time as bands behind everything,
 * fixed activities, visit windows and planned work as blocks, deadlines as gold lines, and the
 * present moment as a needle across today. Items not yet in time (no time, or not yet planned)
 * are listed beside the week under 待定.
 * Every block carries data-cal-task so a click can open the matching task card.
 */
const DAY = 86400000;
const HOUR = 3600000;
const OFFSET = 8 * HOUR;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const inactive = task => ['completed', 'cancelled'].includes(task.status);
const title = task => task.title.trim() || '未命名事项';
const ms = value => (isTimestamp(value) ? Date.parse(value) : null);
const local = value => new Date(value + OFFSET);
const clock = value => { const d = local(value); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const monthDay = value => { const d = local(value); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };

/** Monday 00:00 Beijing time of the week holding `value` (epoch ms). */
export function weekStart(value) {
  const d = local(value);
  const weekday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFFSET - weekday * DAY;
}

// ISO week number, for the eyebrow line.
function weekNumber(start) {
  const thursday = local(start + 3 * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / (7 * DAY)) + 1;
}

/** Everything the calendar can place, as plain records; `undated` holds tasks with no time yet. */
export function calendarItems(snapshot, plan) {
  const items = [];
  const undated = [];
  const planned = new Set();
  const usable = plan && plan.status === 'feasible_found' ? plan : null;
  for (const row of usable?.schedule || []) {
    if (row.kind !== 'work') continue;
    const task = snapshot.tasks.find(item => item.id === row.task_id);
    if (!task) continue;
    planned.add(task.id);
    items.push({ type: 'work', id: task.id, title: title(task), start: ms(row.start), end: ms(row.end), location: task.location });
  }
  for (const interval of snapshot.availability) {
    const start = ms(interval.start);
    const end = ms(interval.end);
    if (start !== null && end !== null && end > start) items.push({ type: 'free', start, end });
  }
  for (const task of snapshot.tasks) {
    if (inactive(task)) continue;
    let placed = false;
    if (task.kind === 'fixed') {
      const start = ms(task.fixed_start_at);
      const end = ms(task.fixed_end_at);
      if (start !== null && end !== null && end > start) { items.push({ type: 'fixed', id: task.id, title: title(task), start, end, location: task.location }); placed = true; }
    }
    if (task.kind === 'visit_window') {
      for (const window of task.visit_windows || []) {
        const start = ms(window.start);
        const end = ms(window.end);
        if (start !== null && end !== null && end > start) { items.push({ type: 'visit', id: task.id, title: title(task), start, end, location: task.location }); placed = true; }
      }
    }
    const deadline = ms(task.deadline_at);
    if (deadline !== null && task.kind !== 'fixed') { items.push({ type: 'deadline', id: task.id, title: title(task), start: deadline, end: deadline, milestone: task.kind === 'milestone' }); placed = placed || task.kind === 'milestone' || planned.has(task.id); }
    if (task.kind === 'flexible' && planned.has(task.id)) placed = true;
    if (!placed) undated.push({ id: task.id, title: title(task), kind: task.kind, status: task.status, deadline });
  }
  return { items, undated };
}

// Side-by-side lanes for blocks that overlap within one day.
function lanes(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [];
  let clusterEnd = -Infinity;
  const finish = () => { const width = Math.max(1, ...cluster.map(block => block.lane + 1)); cluster.forEach(block => { block.lanes = width; }); };
  for (const block of sorted) {
    if (block.start >= clusterEnd && cluster.length) { finish(); cluster = []; }
    const taken = new Set(cluster.filter(other => other.end > block.start).map(other => other.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    block.lane = lane;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.end);
  }
  if (cluster.length) finish();
  return sorted;
}

const TYPE_LABEL = { work: '安排块', fixed: '固定活动', visit: '可前往时段', free: '空闲时段', deadline: '截止' };

export function calendarMarkup({ snapshot, plan, start, now }) {
  const { items, undated } = calendarItems(snapshot, plan);
  const days = Array.from({ length: 7 }, (_, index) => start + index * DAY);
  const end = start + 7 * DAY;
  const inWeek = items.filter(item => (item.type === 'deadline' ? item.start >= start && item.start < end : item.end > start && item.start < end));
  // Hours shown: 8 to 22 by default, widened to fit this week's items.
  let first = 8;
  let last = 22;
  for (const item of inWeek) {
    // A deadline needs a little room below its line for the label.
    const from = Math.max(item.start, start);
    const to = Math.min(item.type === 'deadline' ? item.start + HOUR / 2 : item.end, end);
    for (let dayStart = start + Math.floor((from - start) / DAY) * DAY; dayStart < to; dayStart += DAY) {
      first = Math.min(first, Math.floor((Math.max(from, dayStart) - dayStart) / HOUR));
      last = Math.max(last, Math.ceil((Math.min(to, dayStart + DAY) - dayStart) / HOUR));
    }
  }
  const span = (last - first) * HOUR;
  const pct = value => `${(Math.min(Math.max(value, 0), span) / span * 100).toFixed(3)}%`;
  const today = weekStart(now) === start ? Math.floor((now - start) / DAY) : -1;
  const count = type => inWeek.filter(item => item.type === type).length;
  const freeHours = inWeek.filter(item => item.type === 'free').reduce((sum, item) => sum + Math.min(item.end, end) - Math.max(item.start, start), 0) / HOUR;
  const hasPlan = plan && plan.status === 'feasible_found';

  const columns = days.map((dayStart, index) => {
    const dayEnd = dayStart + DAY;
    const top = dayStart + first * HOUR;
    const segment = item => ({ ...item, start: Math.max(item.start, dayStart), end: Math.min(item.end, dayEnd), cut: item.start < dayStart || item.end > dayEnd });
    const free = inWeek.filter(item => item.type === 'free' && item.end > dayStart && item.start < dayEnd).map(segment);
    const blocks = lanes(inWeek.filter(item => ['work', 'fixed', 'visit'].includes(item.type) && item.end > dayStart && item.start < dayEnd).map(segment));
    const marks = inWeek.filter(item => item.type === 'deadline' && item.start >= dayStart && item.start < dayEnd);
    const bands = free.map(item => `<button type="button" class="cal-free" data-cal-free style="top:${pct(item.start - top)};height:${pct(item.end - item.start)}" aria-label="空闲时段 ${clock(item.start)} 至 ${clock(item.end)}"><span>空闲</span></button>`).join('');
    const body = blocks.map(item => {
      const label = `${TYPE_LABEL[item.type]} ${item.title} ${clock(item.start)} 至 ${item.end === dayEnd ? '24:00' : clock(item.end)}`;
      const short = item.end - item.start < 45 * 60000;
      return `<button type="button" class="cal-block cal-${item.type}${short ? ' is-short' : ''}" data-cal-task="${escape(item.id)}" title="${escape(label)}" style="top:${pct(item.start - top)};height:${pct(item.end - item.start)};left:calc(${(item.lane / item.lanes * 100).toFixed(3)}% + 3px);width:calc(${(100 / item.lanes).toFixed(3)}% - 6px)" aria-label="${escape(label)}"><strong>${escape(item.title)}</strong><span>${clock(item.start)}–${item.end === dayEnd ? '24:00' : clock(item.end)}${item.location ? ` · ${escape(item.location)}` : ''}</span></button>`;
    }).join('');
    const lines = marks.map(item => `<button type="button" class="cal-deadline${item.milestone ? ' is-milestone' : ''}" data-cal-task="${escape(item.id)}" style="top:${pct(item.start - top)}" title="${escape(`${item.title} · ${clock(item.start)} 截止`)}" aria-label="${escape(`截止 ${item.title} ${clock(item.start)}`)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 1.5Q13.2 10.8 22.5 12Q13.2 13.2 12 22.5Q10.8 13.2 1.5 12Q10.8 10.8 12 1.5Z" fill="currentColor"/></svg><span>截止 ${clock(item.start)}</span></button>`).join('');
    const needle = index === today && now >= top && now <= top + span ? `<div class="cal-now" style="top:${pct(now - top)}" aria-hidden="true"><span>${clock(now)}</span></div>` : '';
    const state = index === today ? ' is-today' : dayEnd <= now ? ' is-past' : '';
    return `<div class="cal-day${state}" role="group" aria-label="${monthDay(dayStart)} ${WEEKDAYS[index]}">${bands}${body}${lines}${needle}</div>`;
  }).join('');

  const heads = days.map((dayStart, index) => {
    const d = local(dayStart);
    const state = index === today ? ' is-today' : dayStart + DAY <= now ? ' is-past' : '';
    return `<div class="cal-head-day${state}"><span>${WEEKDAYS[index]}</span><strong>${d.getUTCDate()}</strong>${d.getUTCDate() === 1 || index === 0 ? `<em>${d.getUTCMonth() + 1}月</em>` : ''}</div>`;
  }).join('');
  const hours = Array.from({ length: last - first }, (_, index) => `<span style="top:${((index / (last - first)) * 100).toFixed(3)}%">${String(first + index).padStart(2, '0')}:00</span>`).join('');

  // Phones: the same week as a list of days.
  const agenda = days.map((dayStart, index) => {
    const dayEnd = dayStart + DAY;
    const rows = inWeek.filter(item => (item.type === 'deadline' ? item.start >= dayStart && item.start < dayEnd : item.end > dayStart && item.start < dayEnd)).sort((a, b) => a.start - b.start);
    if (!rows.length && index !== today) return '';
    const list = rows.map(item => {
      const from = Math.max(item.start, dayStart);
      const to = Math.min(item.end, dayEnd);
      const time = item.type === 'deadline' ? clock(item.start) : `${clock(from)}–${to === dayEnd ? '24:00' : clock(to)}`;
      const attrs = item.type === 'free' ? 'data-cal-free' : `data-cal-task="${escape(item.id)}"`;
      return `<li><button type="button" class="cal-row cal-row-${item.type}" ${attrs}><time>${time}</time><span>${item.type === 'free' ? '空闲时段' : escape(item.title)}</span><em>${TYPE_LABEL[item.type]}</em></button></li>`;
    }).join('');
    return `<li class="cal-agenda-day${index === today ? ' is-today' : ''}"><h3>${monthDay(dayStart)} <span>${WEEKDAYS[index]}${index === today ? ' · 今天' : ''}</span></h3>${list ? `<ul>${list}</ul>` : '<p>今天还没有安排。</p>'}</li>`;
  }).join('');

  const pending = undated.length ? undated.map(item => `<li><button type="button" class="cal-pending-item" data-cal-task="${escape(item.id)}"><strong>${escape(item.title)}</strong><span>${item.status === 'draft' ? '待核对' : item.kind === 'fixed' ? '缺少开始和结束时间' : item.kind === 'milestone' ? '缺少截止时间' : item.kind === 'visit_window' ? '缺少可前往时段' : hasPlan ? '未排入本次安排' : item.deadline !== null ? `截止 ${monthDay(item.deadline)} ${clock(item.deadline)}，生成安排后出现` : '没有截止时间，生成安排后出现'}</span></button></li>`).join('') : '';

  const weekEnd = start + 6 * DAY;
  const range = local(start).getUTCMonth() === local(weekEnd).getUTCMonth() ? `${monthDay(start)} — ${local(weekEnd).getUTCDate()}日` : `${monthDay(start)} — ${monthDay(weekEnd)}`;
  const empty = !inWeek.length ? `<div class="cal-empty"><p>这一周还是一片空白。</p><span>在「空闲时间」里填写时段，确认事项并生成安排后，它们会出现在这里。</span></div>` : '';
  return `<header class="cal-top">
      <div><p class="cal-eyebrow">${local(start).getUTCFullYear()} · 第 ${weekNumber(start)} 周</p><h2 class="cal-range" id="calendarHeading">${range}</h2>
      <p class="cal-stats"><span><b>${count('work')}</b> 个安排块</span><span><b>${count('fixed')}</b> 个固定活动</span><span><b>${count('deadline')}</b> 个截止</span><span><b>${Number(freeHours.toFixed(1))}</b> 小时空闲</span></p></div>
      <div class="cal-nav"><button type="button" data-cal-week="-1" aria-label="上一周"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" data-cal-week="0">本周</button><button type="button" data-cal-week="1" aria-label="下一周"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    </header>
    <ul class="cal-legend" aria-label="图例"><li class="lg-work">安排块</li><li class="lg-fixed">固定活动</li><li class="lg-visit">可前往时段</li><li class="lg-free">空闲时段</li><li class="lg-deadline">截止</li><li class="lg-now">此刻</li></ul>
    ${hasPlan ? '' : `<p class="cal-hint">还没有可用的安排${snapshot.tasks.some(task => !inactive(task)) ? '：<a href="#/plan">去生成安排</a>，具体的工作块会排进这里。' : '。'}</p>`}
    <div class="cal-layout">
      <div class="cal-board">
        <div class="cal-week" style="--rows:${last - first}">
          <div class="cal-corner" aria-hidden="true"></div>${heads}
          <div class="cal-hours" aria-hidden="true">${hours}</div>${columns}
        </div>${empty}
        <ol class="cal-agenda">${agenda || '<li class="cal-agenda-day"><p>这一周还没有安排。</p></li>'}</ol>
      </div>
      <aside class="cal-pending" aria-labelledby="calPendingHeading"><h3 id="calPendingHeading">待定 <span>${undated.length}</span></h3>${pending ? `<ul>${pending}</ul>` : '<p>所有事项都已落进时间里。</p>'}</aside>
    </div>`;
}
