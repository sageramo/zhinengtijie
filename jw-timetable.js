/**
 * Read a saved 金智 (wisedu) 「我的课表」 page into the course format of /api/v3/timetable mode
 * "convert". Everything happens in the browser: the page is parsed with DOMParser, nothing is sent
 * except the courses themselves. The grid gives the weekday and periods of every cell; each course
 * item also states its weeks, weekday, clock times and room, e.g.
 *   <div class="mtt_item_kcmc">2131030028&nbsp;数据结构D[02]</div>
 *   <div class="mtt_item_room">1-9周(单),星期3,10:10-12:00,四教308</div>
 * Teacher names (mtt_item_jxbmc) and course codes are left out on purpose.
 */
const ITEM_LINE = /^(.+?)周(?:\((单|双)\))?\s*[,，]\s*星期\s*([1-7一二三四五六日天])\s*[,，]\s*(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})\s*[,，]?\s*(.*)$/;
const CHINESE_DAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const pad = clock => clock.padStart(5, '0');
const squash = text => String(text ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function weekRanges(text) {
  const ranges = [];
  for (const part of text.split(/[,，、]/).map(squash).filter(Boolean)) {
    const match = part.match(/^(\d{1,2})(?:\s*[-~—]\s*(\d{1,2}))?$/);
    if (!match) return null;
    const low = Number(match[1]);
    const high = Number(match[2] ?? match[1]);
    if (low < 1 || high > 30 || low > high) return null;
    ranges.push([low, high]);
  }
  return ranges.length ? ranges : null;
}

/** "2131030028 数据结构D[02]" → "数据结构D" */
export function courseTitle(text) {
  return squash(text).replace(/^[A-Za-z]?\d{5,}\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

/**
 * Parse the page. `parse` is a DOMParser-like function (html → Document), so tests can pass jsdom's.
 * Returns { courses, text, periods, currentWeek, term, skipped }.
 */
export function parseJwTimetable(html, parse = source => new DOMParser().parseFromString(source, 'text/html')) {
  const doc = parse(String(html ?? ''));
  const table = doc.querySelector('table.wut_table') || doc.querySelector('[data-begin-unit]')?.closest('table');
  if (!table) throw new Error('这个网页里没有找到课表格子。请在「我的课表」页面切到学期课表的格子视图后再另存。');

  const periods = {};
  for (const cell of table.querySelectorAll('[data-unit]')) {
    const match = squash(cell.textContent).match(/^(\d{1,2})\s*\(\s*(\d{1,2}:\d{2})\s*[~\-—]\s*(\d{1,2}:\d{2})\s*\)/);
    if (match) periods[match[1]] = { start: pad(match[2]), end: pad(match[3]) };
  }

  const courses = [];
  const skipped = [];
  const seen = new Set();
  for (const cell of table.querySelectorAll('td[data-role="item"]')) {
    for (const item of cell.querySelectorAll('.mtt_arrange_item')) {
      const title = courseTitle(item.querySelector('.mtt_item_kcmc')?.textContent);
      const line = squash(item.querySelector('.mtt_item_room')?.textContent);
      if (!title && !line) continue;
      const id = item.querySelector('[data-jxbid]')?.getAttribute('data-jxbid') || title;
      const key = `${id}|${line}`;
      if (seen.has(key)) continue; // the same arrangement is drawn in every cell it spans
      seen.add(key);
      const match = line.match(ITEM_LINE);
      const weeks = match && weekRanges(match[1]);
      if (!title || !match || !weeks) {
        skipped.push(title || line);
        continue;
      }
      const weekday = CHINESE_DAY[match[3]] || Number(match[3]);
      const quote = `${title} ${line}`;
      courses.push({
        title, quote, weekdays: [weekday], start_period: null, end_period: null,
        start_time: pad(match[4]), end_time: pad(match[5]), weeks,
        parity: match[2] === '单' ? 'odd' : match[2] === '双' ? 'even' : 'all',
        location: squash(match[6]) || null,
      });
    }
  }
  if (!courses.length && !skipped.length) throw new Error('课表格子是空的：另存时课表可能还没加载出来，请等课表显示完整后再保存一次。');

  const week = Number(squash(doc.querySelector('#zkbzc')?.textContent));
  const term = doc.querySelector('.jxrw-label-term')?.getAttribute('value') || null;
  return { courses, text: courses.map(course => course.quote).join('\n'), periods, currentWeek: Number.isInteger(week) && week > 0 ? week : null, term, skipped };
}

/** Monday of week 1, given that `onDay` (YYYY-MM-DD, Beijing) falls in teaching week `week`. */
export function termStartFrom(onDay, week) {
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(onDay || '')) return null;
  const day = new Date(`${onDay}T00:00:00Z`);
  const monday = day.getTime() - ((day.getUTCDay() + 6) % 7) * 86400000;
  return new Date(monday - (week - 1) * 7 * 86400000).toISOString().slice(0, 10);
}
