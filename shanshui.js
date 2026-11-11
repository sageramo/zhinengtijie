/**
 * 本周山水: the week drawn as an ink landscape, from the same calendar items as the 画卷.
 * Each day is a peak whose height is how many hours are already taken (底色, 落笔, 点墨, 约定);
 * 留白 rises as cloud between the peaks; 点墨 are ink dots on the ridge at their hour, 截止 are gold
 * stars, 叠墨 bleeds 胭脂 into the ridge on its day, and a moon hangs over today. Pure markup:
 * deterministic for the same week, no randomness, so a re-render paints the same mountains.
 */
const DAY = 86400000;
const HOUR = 3600000;
const W = 1000;
const H = 420;
const BASE = 330; // ridge height for an empty day
const PEAK = 230; // extra height for a full day
const FULL = 12; // a 12-hour day is a full peak; a lighter week is scaled to its own busiest day (at least 6 h)
const LEFT = 70;
const STEP = (W - 2 * LEFT) / 6;
const NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const BUSY = new Set(['routine', 'work', 'temporary', 'appointment']);
const smooth = t => t * t * (3 - 2 * t);
const fixed = value => Number(value.toFixed(1));

function dayTotals(items, start, types) {
  return NAMES.map((_, index) => {
    const from = start + index * DAY;
    const to = from + DAY;
    return items.filter(item => types.has(item.type))
      .reduce((sum, item) => sum + Math.max(0, Math.min(item.end, to) - Math.max(item.start, from)), 0) / HOUR;
  });
}

/** The ridge as y(x): peaks at day centres, valleys between, eased so the line reads as a brush stroke. */
function ridge(hours, lift = 1, offset = 0) {
  const full = Math.min(FULL, Math.max(6, ...hours) * 1.08);
  const peaks = hours.map((h, index) => ({ x: LEFT + index * STEP + offset, y: BASE - (0.12 + 0.88 * Math.min(h, full) / full) * PEAK * lift }));
  const points = [{ x: -40, y: BASE + 40 }];
  peaks.forEach((peak, index) => {
    points.push(peak);
    const next = peaks[index + 1];
    if (next) points.push({ x: (peak.x + next.x) / 2, y: Math.max(peak.y, next.y) + 26 + 18 * lift });
  });
  points.push({ x: W + 40, y: BASE + 40 });
  return x => {
    const index = Math.max(0, points.findIndex((point, i) => points[i + 1] && x >= point.x && x <= points[i + 1].x));
    const a = points[index];
    const b = points[index + 1] || a;
    const t = b.x === a.x ? 0 : smooth((x - a.x) / (b.x - a.x));
    return a.y + (b.y - a.y) * t;
  };
}

function range(y, close = true) {
  let path = '';
  for (let x = -20; x <= W + 20; x += 10) path += `${path ? 'L' : 'M'}${x} ${fixed(y(x))}`;
  return close ? `${path}L${W + 20} ${H}L-20 ${H}Z` : path;
}

/** x of a moment in the week: its day column, nudged by the hour (08:00 left of centre, 20:00 right). */
const xAt = (time, start) => {
  const day = Math.min(6, Math.max(0, Math.floor((time - start) / DAY)));
  const hour = (time - start - day * DAY) / HOUR;
  return LEFT + day * STEP + (hour - 14) / 14 * STEP * 0.45;
};

export function shanshuiMarkup({ items, start, now, conflicts = [], id = 'ss' }) {
  const busy = dayTotals(items, start, BUSY);
  const free = dayTotals(items, start, new Set(['free']));
  const near = ridge(busy);
  const far = ridge(busy.map((h, index) => (h + (busy[(index + 1) % 7] || 0)) / 2), 0.78, STEP * 0.32);
  const distant = ridge(busy.map((h, index) => Math.max(h, busy[(index + 6) % 7] || 0)), 1.05, -STEP * 0.4);
  const today = now >= start && now < start + 7 * DAY ? Math.floor((now - start) / DAY) : -1;
  const clouds = free.map((hours, index) => {
    if (hours < 0.5) return '';
    const x = LEFT + index * STEP;
    const width = 60 + Math.min(hours, 15) * 11;
    const y = fixed(near(x) + 34);
    return `<ellipse class="ss-cloud" style="--d:${index}" cx="${fixed(x)}" cy="${y}" rx="${fixed(width)}" ry="${fixed(10 + Math.min(hours, 15))}"/>`;
  }).join('');
  const dots = items.filter(item => item.type === 'temporary' && item.start >= start && item.start < start + 7 * DAY).map(item => {
    const x = xAt(item.start, start);
    return `<circle class="ss-dot" cx="${fixed(x)}" cy="${fixed(near(x) - 10)}" r="7"/>`;
  }).join('');
  const stars = items.filter(item => item.type === 'deadline' && item.start >= start && item.start < start + 7 * DAY).map(item => {
    const x = fixed(xAt(item.start, start));
    const y = fixed(near(x) - 34);
    return `<path class="ss-star" transform="translate(${x} ${y}) scale(.9)" d="M0 -11Q1.1 -1.1 11 0Q1.1 1.1 0 11Q-1.1 1.1 -11 0Q-1.1 -1.1 0 -11Z"/>`;
  }).join('');
  const bleeds = conflicts.filter(conflict => conflict.start).map(conflict => {
    const x = fixed(xAt(Date.parse(conflict.start), start));
    return `<ellipse class="ss-bleed" cx="${x}" cy="${fixed(near(x) + 6)}" rx="34" ry="26" filter="url(#${id}-bleed)"/>`;
  }).join('');
  const moon = today >= 0 ? `<g class="ss-moon"><circle cx="${fixed(LEFT + today * STEP)}" cy="62" r="34" class="ss-moon-glow"/><circle cx="${fixed(LEFT + today * STEP)}" cy="62" r="17"/></g>` : '';
  const labels = NAMES.map((name, index) => `<text x="${fixed(LEFT + index * STEP)}" y="${H - 14}" class="ss-day${index === today ? ' is-today' : ''}">${name}</text>`).join('');
  const busiest = busy.indexOf(Math.max(...busy));
  const summary = `本周山水：${busy.map((h, index) => `周${NAMES[index]}${Number(h.toFixed(1))}小时`).join('，')}${busy[busiest] >= 1 ? `；最高的峰是周${NAMES[busiest]}` : ''}。`;
  return `<svg class="shanshui" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${summary}">
    <defs>
      <linearGradient id="${id}-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d3a5f"/><stop offset=".45" stop-color="#2d5b8c" stop-opacity=".85"/><stop offset="1" stop-color="#9fcdf5" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5e8fc4" stop-opacity=".55"/><stop offset="1" stop-color="#cfe3f7" stop-opacity="0"/></linearGradient>
 <linearGradient id="${id}-distant" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fbedf" stop-opacity=".45"/><stop offset=".6" stop-color="#dbe9f7" stop-opacity=".2"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
      <radialGradient id="${id}-glow" cx="50%" cy="20%" r="60%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
      <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eaf3fc"/><stop offset="1" stop-color="#fbfdff"/></linearGradient>
      <filter id="${id}-brush" x="-5%" y="-10%" width="110%" height="130%"><feTurbulence type="fractalNoise" baseFrequency=".018 .06" numOctaves="3" seed="7"/><feDisplacementMap in="SourceGraphic" scale="9"/></filter>
      <filter id="${id}-mist" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id="${id}-bleed" x="-60%" y="-60%" width="220%" height="220%"><feTurbulence type="fractalNoise" baseFrequency=".06" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="18"/><feGaussianBlur stdDeviation="2.5"/></filter>
    </defs>
    <rect class="ss-sky" width="${W}" height="${H}" fill="url(#${id}-sky)"/>
 <rect width="${W}" height="${H}" fill="url(#${id}-glow)" opacity=".8"/>
    ${moon}
    <path class="ss-distant" d="${range(y => distant(y) - 40)}" fill="url(#${id}-distant)" filter="url(#${id}-brush)"/>
    <path class="ss-far" d="${range(far)}" fill="url(#${id}-far)" filter="url(#${id}-brush)"/>
    <path class="ss-near" d="${range(near)}" fill="url(#${id}-near)" filter="url(#${id}-brush)"/>
    <path class="ss-line" d="${range(near, false)}" filter="url(#${id}-brush)"/>
    ${bleeds}
    <g class="ss-clouds" filter="url(#${id}-mist)">${clouds}</g>
    ${dots}${stars}
    <path class="ss-water" d="M40 ${H - 46}Q260 ${H - 54} 500 ${H - 46}T960 ${H - 46}M140 ${H - 34}Q360 ${H - 40} 560 ${H - 34}T880 ${H - 34}"/>
    ${labels}
  </svg>`;
}
