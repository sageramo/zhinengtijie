/**
 * 本周山水: the week drawn as an ink landscape, from the same calendar items as the 画卷.
 * Each day is a peak whose height is how many hours are already taken (底色, 落笔, 点墨, 约定);
 * 留白 rises as cloud between the peaks; 点墨 are ink dots on the ridge at their hour, 截止 are gold
 * stars, 叠墨 bleeds 胭脂 into the ridge on its day, and a moon hangs over today. Pure markup:
 * deterministic for the same week, no randomness, so a re-render paints the same mountains.
 */
const DAY = 86400000;
const HOUR = 3600000;
const OFFSET = 8 * HOUR;
const W = 1000;
const H = 420;
const FAR = [1.5, 2.4, 1.2, 2.8, 1.8, 2.2, 1.4];
const DISTANT = [2.4, 1.8, 3, 2, 3.2, 1.8, 2.5];
const BASE = 318; // ridge height for an empty day
const PEAK = 272; // extra height for a full day
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

/**
 * 精力 in the painting, from the same self-reported intervals as the 专注时段 in the week: a day with
 * focus time has warm light on its peak (the longer, the wider the glow); a day said to be low on energy
 * has a grey haze over it; a rest is a pale clearing at the mountain's foot. Intervals, not a curve.
 */
function energyMarks(energy, start, near) {
  const per = NAMES.map(() => ({ focus: 0, low: 0, rest: 0 }));
  for (const segment of energy) {
    const day = Math.floor((segment.start - start) / DAY);
    if (day < 0 || day > 6) continue;
    const hours = Math.max(0, segment.end - segment.start) / HOUR;
    const kind = segment.kind === 'high' ? 'focus' : segment.kind;
    if (per[day][kind] !== undefined) per[day][kind] += hours;
  }
  return per.map((day, index) => {
    const x = LEFT + index * STEP;
    const ridge = near(x);
    let out = '';
    if (day.focus > 0) out += `<ellipse class="ss-glow" cx="${fixed(x)}" cy="${fixed(ridge - 18)}" rx="${fixed(46 + Math.min(day.focus, 6) * 9)}" ry="${fixed(30 + Math.min(day.focus, 6) * 4)}"/>`;
    if (day.low > 0) out += `<ellipse class="ss-haze" cx="${fixed(x)}" cy="${fixed(ridge + 10)}" rx="${fixed(60 + Math.min(day.low, 6) * 8)}" ry="34"/>`;
    if (day.rest > 0) out += `<ellipse class="ss-rest" cx="${fixed(x)}" cy="${fixed(Math.min(H - 70, ridge + 70))}" rx="${fixed(40 + Math.min(day.rest, 4) * 10)}" ry="14"/>`;
    return out;
  }).join('');
}

export function shanshuiMarkup({ items, start, now, conflicts = [], energy = [], id = 'ss' }) {
  const busy = dayTotals(items, start, BUSY);
  const free = dayTotals(items, start, new Set(['free']));
  const near = ridge(busy);
  // The far ranges are scenery only, the same every week: just the near ridge carries the week's hours
  // (they used to echo the week's hours, which read as a second chart nobody could explain).
  const far = ridge(FAR, 0.78, STEP * 0.32);
  const distant = ridge(DISTANT, 1.05, -STEP * 0.4);
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
  const moon = today >= 0 ? `<g class="ss-moon"><circle cx="${fixed(LEFT + today * STEP)}" cy="72" r="26" class="ss-moon-glow"/><circle cx="${fixed(LEFT + today * STEP)}" cy="72" r="13" class="ss-moon-disc"/></g>` : '';
  const marks = energy.length ? energyMarks(energy, start, near) : '';
  const glows = marks.replace(/<ellipse class="ss-(?:haze|rest)"[^>]*>/g, '').replace(/class="ss-glow"/g, `class="ss-glow" fill="url(#${id}-sun)"`);
  const veils = marks.replace(/<ellipse class="ss-glow"[^>]*>/g, '').replace(/class="ss-haze"/g, `class="ss-haze" fill="url(#${id}-grey)"`);
  const labels = NAMES.map((name, index) => `<text x="${fixed(LEFT + index * STEP)}" y="${H - 14}" class="ss-day${index === today ? ' is-today' : ''}">${name}</text>`).join('');
  const busiest = busy.indexOf(Math.max(...busy));
  const summary = `本周山水：${busy.map((h, index) => `周${NAMES[index]}${Number(h.toFixed(1))}小时`).join('，')}${busy[busiest] >= 1 ? `；最高的峰是周${NAMES[busiest]}` : ''}。`;
  return `<svg class="shanshui" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${summary}">
    <defs>
      <linearGradient id="${id}-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f2135"/><stop offset=".3" stop-color="#1e3953" stop-opacity=".96"/><stop offset=".56" stop-color="#46637f" stop-opacity=".62"/><stop offset=".8" stop-color="#f3eee6" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#36506b" stop-opacity=".88"/><stop offset=".45" stop-color="#6c859d" stop-opacity=".45"/><stop offset=".72" stop-color="#f3eee6" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-distant" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa2b4" stop-opacity=".66"/><stop offset=".4" stop-color="#bac5cf" stop-opacity=".24"/><stop offset=".6" stop-color="#f3eee6" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5f1ea"/><stop offset="1" stop-color="#eee8dd"/></linearGradient>
      <linearGradient id="${id}-foot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1ece3" stop-opacity="0"/><stop offset=".45" stop-color="#f1ece3" stop-opacity=".85"/><stop offset="1" stop-color="#efe9df"/></linearGradient>
      <filter id="${id}-paper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 .42  0 0 0 0 .38  0 0 0 0 .32  0 0 0 .05 0"/></filter>
      <filter id="${id}-brush" x="-5%" y="-10%" width="110%" height="130%"><feTurbulence type="fractalNoise" baseFrequency=".018 .06" numOctaves="3" seed="7"/><feDisplacementMap in="SourceGraphic" scale="9"/></filter>
      <filter id="${id}-haze" x="-5%" y="-10%" width="110%" height="130%"><feTurbulence type="fractalNoise" baseFrequency=".014 .05" numOctaves="2" seed="5"/><feDisplacementMap in="SourceGraphic" scale="12"/><feGaussianBlur stdDeviation="1.6"/></filter>
      <radialGradient id="${id}-sun"><stop offset="0" stop-color="#f6dfa8" stop-opacity=".75"/><stop offset=".55" stop-color="#f3d699" stop-opacity=".28"/><stop offset="1" stop-color="#f3d699" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}-grey"><stop offset="0" stop-color="#8e969c" stop-opacity=".55"/><stop offset="1" stop-color="#8e969c" stop-opacity="0"/></radialGradient>
      <filter id="${id}-mist" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id="${id}-bleed" x="-60%" y="-60%" width="220%" height="220%"><feTurbulence type="fractalNoise" baseFrequency=".06" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="18"/><feGaussianBlur stdDeviation="2.5"/></filter>
    </defs>
    <rect class="ss-sky" width="${W}" height="${H}" fill="url(#${id}-sky)"/>
    <rect class="ss-paper" width="${W}" height="${H}" filter="url(#${id}-paper)"/>
    ${moon}
    <g class="ss-energy-light">${glows}</g>
    <path class="ss-distant" d="${range(y => distant(y) - 40)}" fill="url(#${id}-distant)" filter="url(#${id}-haze)"/>
    <path class="ss-far" d="${range(far)}" fill="url(#${id}-far)" filter="url(#${id}-haze)"/>
    <path class="ss-near" d="${range(near)}" fill="url(#${id}-near)" filter="url(#${id}-brush)"/>
    <path class="ss-line" d="${range(near, false)}" filter="url(#${id}-brush)"/>
    ${bleeds}
    <g class="ss-energy-veil" filter="url(#${id}-mist)">${veils}</g>
    <rect class="ss-foot" y="${H - 150}" width="${W}" height="150" fill="url(#${id}-foot)"/>
    <g class="ss-clouds" filter="url(#${id}-mist)">${clouds}</g>
    ${dots}${stars}
    <path class="ss-water" d="M40 ${H - 46}Q260 ${H - 54} 500 ${H - 46}T960 ${H - 46}M140 ${H - 34}Q360 ${H - 40} 560 ${H - 34}T880 ${H - 34}"/>
    <g class="ss-seal" transform="translate(${W - 58} 26)"><rect width="30" height="44" rx="3"/><text x="15" y="19">山</text><text x="15" y="37">水</text></g>
    ${labels}
  </svg>`;
}

const dayYmd = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);

/** 写意山水：依每日四时手卷笔数与已印「成」星数描绘这一周的心意山形，不依赖工笔时轴算力。 */
export function xieyiShanshuiMarkup({ state, start, now, id = 'ss-xy' }) {
  const days = Array.from({ length: 7 }, (_, idx) => {
    const ymd = dayYmd(start + idx * DAY);
    const notes = (state?.notes || []).filter(n => n.date === ymd);
    return { ymd, notes };
  });
  const heights = days.map(d => (d.notes.length ? Math.min(11, 2 + d.notes.length * 2.1) : 0));
  const near = ridge(heights);
  const far = ridge(FAR, 0.78, STEP * 0.32);
  const distant = ridge(DISTANT, 1.05, -STEP * 0.4);
  const today = now >= start && now < start + 7 * DAY ? Math.floor((now - start) / DAY) : -1;

  const clouds = days.map((d, index) => {
    if (d.notes.length > 0) return '';
    const x = LEFT + index * STEP;
    const y = fixed(near(x) + 26);
    return `<ellipse class="ss-cloud" style="--d:${index}" cx="${fixed(x)}" cy="${y}" rx="${76 + (index % 2) * 14}" ry="14"/>`;
  }).join('');

  const marks = days.map((d, index) => d.notes.map((note, ni) => {
    const spread = d.notes.length === 1 ? 0 : ((ni / (d.notes.length - 1)) - 0.5) * 0.42;
    const cx = LEFT + index * STEP + spread * STEP;
    const ridgeY = near(cx);
    if (note.done) {
      return `<path class="ss-star" transform="translate(${fixed(cx)} ${fixed(ridgeY - 28)}) scale(.88)" d="M0 -11Q1.1 -1.1 11 0Q1.1 1.1 0 11Q-1.1 1.1 -11 0Q-1.1 -1.1 0 -11Z"/>`;
    }
    return `<circle class="ss-dot" cx="${fixed(cx)}" cy="${fixed(ridgeY - 10)}" r="6.5"/>`;
  }).join('')).join('');

  const moon = today >= 0 ? `<g class="ss-moon"><circle cx="${fixed(LEFT + today * STEP)}" cy="72" r="26" class="ss-moon-glow"/><circle cx="${fixed(LEFT + today * STEP)}" cy="72" r="13" class="ss-moon-disc"/></g>` : '';
  const labels = NAMES.map((name, index) => `<text x="${fixed(LEFT + index * STEP)}" y="${H - 14}" class="ss-day${index === today ? ' is-today' : ''}">${name}</text>`).join('');
  const summary = `写意山水：${days.map((d, index) => `周${NAMES[index]}${d.notes.length}笔`).join('，')}。`;
  return `<svg class="shanshui" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${summary}">
    <defs>
      <linearGradient id="${id}-near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#173046"/><stop offset=".32" stop-color="#2c4a63" stop-opacity=".92"/><stop offset=".58" stop-color="#58758e" stop-opacity=".55"/><stop offset=".82" stop-color="#f3eee6" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#48637c" stop-opacity=".82"/><stop offset=".45" stop-color="#7c93a8" stop-opacity=".42"/><stop offset=".72" stop-color="#f3eee6" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-distant" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#96a8b9" stop-opacity=".62"/><stop offset=".4" stop-color="#c0cad3" stop-opacity=".22"/><stop offset=".6" stop-color="#f3eee6" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7f2ea"/><stop offset="1" stop-color="#efe8dc"/></linearGradient>
      <linearGradient id="${id}-foot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1ece3" stop-opacity="0"/><stop offset=".45" stop-color="#f1ece3" stop-opacity=".85"/><stop offset="1" stop-color="#efe9df"/></linearGradient>
      <filter id="${id}-paper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="9"/><feColorMatrix values="0 0 0 0 .42  0 0 0 0 .38  0 0 0 0 .32  0 0 0 .05 0"/></filter>
      <filter id="${id}-brush" x="-5%" y="-10%" width="110%" height="130%"><feTurbulence type="fractalNoise" baseFrequency=".018 .06" numOctaves="3" seed="11"/><feDisplacementMap in="SourceGraphic" scale="9"/></filter>
      <filter id="${id}-haze" x="-5%" y="-10%" width="110%" height="130%"><feTurbulence type="fractalNoise" baseFrequency=".014 .05" numOctaves="2" seed="13"/><feDisplacementMap in="SourceGraphic" scale="12"/><feGaussianBlur stdDeviation="1.6"/></filter>
      <filter id="${id}-mist" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="9"/></filter>
    </defs>
    <rect class="ss-sky" width="${W}" height="${H}" fill="url(#${id}-sky)"/>
    <rect class="ss-paper" width="${W}" height="${H}" filter="url(#${id}-paper)"/>
    ${moon}
    <path class="ss-distant" d="${range(y => distant(y) - 40)}" fill="url(#${id}-distant)" filter="url(#${id}-haze)"/>
    <path class="ss-far" d="${range(far)}" fill="url(#${id}-far)" filter="url(#${id}-haze)"/>
    <path class="ss-near" d="${range(near)}" fill="url(#${id}-near)" filter="url(#${id}-brush)"/>
    <path class="ss-line" d="${range(near, false)}" filter="url(#${id}-brush)"/>
    <rect class="ss-foot" y="${H - 150}" width="${W}" height="150" fill="url(#${id}-foot)"/>
    <g class="ss-clouds" filter="url(#${id}-mist)">${clouds}</g>
    ${marks}
    <path class="ss-water" d="M40 ${H - 46}Q260 ${H - 54} 500 ${H - 46}T960 ${H - 46}M140 ${H - 34}Q360 ${H - 40} 560 ${H - 34}T880 ${H - 34}"/>
    <g class="ss-seal is-xieyi" transform="translate(${W - 58} 26)"><rect width="30" height="44" rx="3"/><text x="15" y="19">写</text><text x="15" y="37">意</text></g>
    ${labels}
  </svg>`;
}
