/**
 * Week calendar for the four time layers (Beijing time, weeks start on Monday).
 * Pure markup from a /api/v3/calendar result: free time as bands behind
 * everything, routine / temporary / work as blocks, deadlines and start-only
 * events as lines, the present moment as a needle across today. Conflicts and
 * undefined items are listed beside the week. Blocks carry data-cal-item and
 * data-cal-layer so a click can open the matching entry.
 */
const DAY = 86400000;
const HOUR = 3600000;
const OFFSET = 8 * HOUR;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const local = value => new Date(value + OFFSET);
const clock = value => { const d = local(value); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const monthDay = value => { const d = local(value); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };
// On screen the layers use the 书画 names: 底色 routine, 留白 free, 落笔 work and appointments, 点墨 temporary.
export const LAYER_LABEL = { routine: '底色', temporary: '点墨', work: '落笔', appointment: '落笔·约定', free: '留白', deadline: '截止', start: '开始' };
const TASK_STATE = { scheduled: '已落笔', estimate_undefined: '预计用时未填', deadline_undefined: '截止未填', free_time_undefined: '留白未设定',
  short: '留白不够', overdue: '已过截止', beyond_horizon: '超出31天', not_attempted: '暂未安排', completed: '已完成', cancelled: '已取消' };
const CONFLICT_LABEL = { routine_overlap: '底色相叠', temporary_routine_overlap: '点墨压在底色上', temporary_overlap: '两处点墨相叠',
  appointment_routine_overlap: '约定压在底色上', appointment_overlap: '约定与他事相叠', work_shortage: '留白不够落笔', overdue: '已过截止' };

/** Monday 00:00 Beijing time of the week holding `value` (epoch ms). */
export function weekStart(value) {
  const d = local(value);
  const weekday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFFSET - weekday * DAY;
}

/** The YYYY-MM-DD range of a week, as /api/v3/calendar expects it. */
export function weekRange(start) {
  const day = value => local(value).toISOString().slice(0, 10);
  return { from: day(start), to: day(start + 6 * DAY) };
}

function weekNumber(start) {
  const thursday = local(start + 3 * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / (7 * DAY)) + 1;
}

/** Everything the week can place, as plain records with epoch times. */
export function calendarItems(result) {
  const items = [];
  if (!result) return items;
  const conflictIds = new Set(result.conflicts.flatMap(conflict => conflict.items.map(item => item.id)));
  for (const item of result.layers.free) items.push({ type: 'free', start: Date.parse(item.start), end: Date.parse(item.end) });
  for (const item of result.layers.routine) items.push({ type: 'routine', id: item.routine_id, key: item.id, title: item.title, location: item.location, start: Date.parse(item.start), end: Date.parse(item.end), conflict: conflictIds.has(item.id) });
  for (const item of result.layers.temporary) items.push({ type: 'temporary', id: item.id, key: item.id, title: item.title, location: item.location, start: Date.parse(item.start), end: Date.parse(item.end), conflict: conflictIds.has(item.id) });
  for (const item of result.layers.appointment || []) items.push({ type: 'appointment', id: item.id, key: item.id, title: item.title, location: item.location, start: Date.parse(item.start), end: Date.parse(item.end), conflict: conflictIds.has(item.id) });
  for (const item of result.layers.work) items.push({ type: 'work', id: item.task_id, key: item.task_id, title: item.title, start: Date.parse(item.start), end: Date.parse(item.end) });
  for (const marker of result.markers) {
    const at = Date.parse(marker.at);
    items.push({ type: marker.type === 'deadline' ? 'deadline' : 'start', id: marker.id, title: marker.title, start: at, end: at, state: marker.state, conflict: conflictIds.has(marker.id) });
  }
  return items;
}

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

const layerOf = { routine: 'routine', temporary: 'event', appointment: 'event', work: 'task', deadline: 'task', start: 'event' };
const attrs = item => `data-cal-item="${escape(item.id)}" data-cal-layer="${layerOf[item.type]}"`;
const isLine = item => item.type === 'deadline' || item.type === 'start';

function sideLists(result) {
  const conflicts = result.conflicts.map(conflict => {
    const first = conflict.items[0];
    const names = conflict.items.map(item => escape(item.title)).join(' × ');
    const when = conflict.start ? `${monthDay(Date.parse(conflict.start))} ${clock(Date.parse(conflict.start))}` : conflict.end ? `截止 ${monthDay(Date.parse(conflict.end))} ${clock(Date.parse(conflict.end))}` : '';
    const layer = first.layer === 'routine' ? 'routine' : ['temporary', 'appointment'].includes(first.layer) ? 'event' : 'task';
    const id = first.layer === 'routine' ? first.id.split('@')[0] : first.id;
    return `<li><button type="button" class="cal-issue is-conflict" data-cal-item="${escape(id)}" data-cal-layer="${layer}"><strong>${escape(CONFLICT_LABEL[conflict.type] || '叠墨')}${conflict.minutes ? ` · ${conflict.minutes}分钟` : ''}</strong><span>${names}${when ? ` · ${when}` : ''}</span><em>${escape(conflict.reason)}</em></button></li>`;
  }).join('');
  const undefinedRows = result.undefined.map(item => {
    const target = item.id ? `data-cal-item="${escape(item.id)}" data-cal-layer="${item.type.startsWith('event_') ? 'event' : 'task'}"` : `data-cal-goto="time"`;
    return `<li><button type="button" class="cal-issue is-undefined" ${target}><strong>${escape(item.title || (item.type === 'free_time_undefined' ? '留白' : '底色'))}</strong><span>${escape(item.reason)}</span></button></li>`;
  }).join('');
  return `<section class="cal-side-block" aria-labelledby="calConflictHeading"><h3 id="calConflictHeading">叠墨 <span>${result.conflicts.length}</span></h3><p class="cal-side-note">两件事落在同一处</p>${conflicts ? `<ul>${conflicts}</ul>` : '<p>底色、落笔与点墨之间没有相叠。</p>'}</section>
    <section class="cal-side-block" aria-labelledby="calUndefinedHeading"><h3 id="calUndefinedHeading">待书 <span>${result.undefined.length}</span></h3><p class="cal-side-note">还没写清楚的信息</p>${undefinedRows ? `<ul>${undefinedRows}</ul>` : '<p>所有信息都已写清楚。</p>'}</section>`;
}

export function calendarMarkup({ result, start, now, loading = false, error = '' }) {
  const items = calendarItems(result);
  const days = Array.from({ length: 7 }, (_, index) => start + index * DAY);
  const end = start + 7 * DAY;
  const inWeek = items.filter(item => (isLine(item) ? item.start >= start && item.start < end : item.end > start && item.start < end));
  let first = 8;
  let last = 22;
  for (const item of inWeek) {
    if (item.type === 'free') continue;
    const from = Math.max(item.start, start);
    // A line's label room stays inside its own day, so 23:59 does not pull the next day to 00:00.
    const ownDayEnd = start + (Math.floor((item.start - start) / DAY) + 1) * DAY;
    const to = Math.min(isLine(item) ? Math.min(item.start + HOUR / 2, ownDayEnd) : item.end, end);
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

  const columns = days.map((dayStart, index) => {
    const dayEnd = dayStart + DAY;
    const top = dayStart + first * HOUR;
    const segment = item => ({ ...item, start: Math.max(item.start, dayStart), end: Math.min(item.end, dayEnd) });
    const free = inWeek.filter(item => item.type === 'free' && item.end > dayStart && item.start < dayEnd).map(segment)
      .map(item => ({ ...item, start: Math.max(item.start, top), end: Math.min(item.end, top + span) })).filter(item => item.end > item.start);
    const blocks = lanes(inWeek.filter(item => ['routine', 'temporary', 'appointment', 'work'].includes(item.type) && item.end > dayStart && item.start < dayEnd).map(segment));
    const marks = inWeek.filter(item => isLine(item) && item.start >= dayStart && item.start < dayEnd);
    const bands = free.map(item => `<button type="button" class="cal-free" data-cal-goto="time" style="top:${pct(item.start - top)};height:${pct(item.end - item.start)}" aria-label="留白 ${clock(item.start)} 至 ${item.end === dayEnd ? '24:00' : clock(item.end)}"><span>留白</span></button>`).join('');
    const body = blocks.map(item => {
      const finish = item.end === dayEnd ? '24:00' : clock(item.end);
      const label = `${LAYER_LABEL[item.type]} ${item.title} ${clock(item.start)} 至 ${finish}${item.conflict ? '，有冲突' : ''}`;
      const short = item.end - item.start < 45 * 60000;
      return `<button type="button" class="cal-block cal-${item.type}${short ? ' is-short' : ''}${item.conflict ? ' is-conflict' : ''}" ${attrs(item)} title="${escape(label)}" style="top:${pct(item.start - top)};height:${pct(item.end - item.start)};left:calc(${(item.lane / item.lanes * 100).toFixed(3)}% + 3px);width:calc(${(100 / item.lanes).toFixed(3)}% - 6px)" aria-label="${escape(label)}"><strong>${escape(item.title)}</strong><span>${clock(item.start)}–${finish}${item.location ? ` · ${escape(item.location)}` : ''}</span></button>`;
    }).join('');
    const lines = marks.map(item => {
      const text = item.type === 'deadline' ? `截止 ${clock(item.start)}` : `开始 ${clock(item.start)}`;
      const state = item.type === 'deadline' ? TASK_STATE[item.state] || '' : '结束未定义';
      return `<button type="button" class="cal-deadline${item.type === 'start' ? ' is-start' : ''}${item.state === 'short' || item.state === 'overdue' ? ' is-short' : ''}" ${attrs(item)} style="top:${pct(item.start - top)}" title="${escape(`${item.title} · ${text} · ${state}`)}" aria-label="${escape(`${item.title} ${text}，${state}`)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 1.5Q13.2 10.8 22.5 12Q13.2 13.2 12 22.5Q10.8 13.2 1.5 12Q10.8 10.8 12 1.5Z" fill="currentColor"/></svg><span>${escape(item.title)} · ${text}</span></button>`;
    }).join('');
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

  const agenda = days.map((dayStart, index) => {
    const dayEnd = dayStart + DAY;
    const rows = inWeek.filter(item => (isLine(item) ? item.start >= dayStart && item.start < dayEnd : item.end > dayStart && item.start < dayEnd)).sort((a, b) => a.start - b.start);
    if (!rows.length && index !== today) return '';
    const list = rows.map(item => {
      const from = Math.max(item.start, dayStart);
      const to = Math.min(item.end, dayEnd);
      const time = isLine(item) ? clock(item.start) : `${clock(from)}–${to === dayEnd ? '24:00' : clock(to)}`;
      const target = item.type === 'free' ? 'data-cal-goto="time"' : attrs(item);
      return `<li><button type="button" class="cal-row cal-row-${item.type}${item.conflict ? ' is-conflict' : ''}" ${target}><time>${time}</time><span>${item.type === 'free' ? '留白' : escape(item.title)}</span><em>${LAYER_LABEL[item.type]}</em></button></li>`;
    }).join('');
    return `<li class="cal-agenda-day${index === today ? ' is-today' : ''}"><h3>${monthDay(dayStart)} <span>${WEEKDAYS[index]}${index === today ? ' · 今天' : ''}</span></h3>${list ? `<ul>${list}</ul>` : '<p>今天还没有安排。</p>'}</li>`;
  }).join('');

  const weekEnd = start + 6 * DAY;
  const range = local(start).getUTCMonth() === local(weekEnd).getUTCMonth() ? `${monthDay(start)} — ${local(weekEnd).getUTCDate()}日` : `${monthDay(start)} — ${monthDay(weekEnd)}`;
  const status = error ? `<p class="cal-hint is-error" role="status">${escape(error)}</p>`
    : loading ? '<p class="cal-hint" role="status">正在计算这一周…</p>'
    : result?.status === 'conflicts' ? `<p class="cal-hint is-error" role="status">有 ${result.conflicts.length} 处叠墨：两件事落在了同一处，详见右侧。</p>`
    : result?.status === 'incomplete' ? `<p class="cal-hint" role="status">有 ${result.undefined.length} 项待书，已按写清楚的部分落笔。</p>`
    : result ? '<p class="cal-hint" role="status">没有叠墨，所有信息都已写清楚。</p>' : '';
  const empty = result && !inWeek.length ? '<div class="cal-empty"><p>这一周还是一片空白。</p><span>在「时间」里铺好底色、定下留白，导入通知后，事情会落在这里。</span></div>' : '';
  const side = result ? sideLists(result) : '<section class="cal-side-block"><p>计算完成后，这里列出叠墨和待书。</p></section>';
  return `<header class="cal-top">
      <div><p class="cal-eyebrow">${local(start).getUTCFullYear()} · 第 ${weekNumber(start)} 周</p><h2 class="cal-range" id="calendarHeading">${range}</h2>
      <p class="cal-stats"><span><b>${count('routine')}</b> 处底色</span><span><b>${count('work') + count('appointment')}</b> 笔落笔</span><span><b>${count('temporary')}</b> 点墨</span><span><b>${count('deadline')}</b> 个截止</span><span><b>${Number(freeHours.toFixed(1))}</b> 小时留白</span></p></div>
      <div class="cal-nav"><button type="button" data-cal-week="-1" aria-label="上一周"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" data-cal-week="0">本周</button><button type="button" data-cal-week="1" aria-label="下一周"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    </header>
    <ul class="cal-legend" aria-label="图例"><li class="lg-routine">底色 · 每周照例</li><li class="lg-free">留白 · 自己支配</li><li class="lg-work">落笔 · 约定与截止之事</li><li class="lg-temporary">点墨 · 一次性安排</li><li class="lg-deadline">截止</li><li class="lg-conflict">叠墨 · 相撞</li><li class="lg-now">此刻</li></ul>
    ${status}
    <div class="cal-layout">
      <div class="cal-board">
        <div class="cal-week" style="--rows:${last - first}">
          <div class="cal-corner" aria-hidden="true"></div>${heads}
          <div class="cal-hours" aria-hidden="true">${hours}</div>${columns}
        </div>${empty}
        <ol class="cal-agenda">${agenda || '<li class="cal-agenda-day"><p>这一周还没有安排。</p></li>'}</ol>
      </div>
      <aside class="cal-pending" aria-label="冲突与未定义">${side}</aside>
    </div>`;
}
