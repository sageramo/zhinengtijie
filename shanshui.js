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
const escapeXML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const SLOT_Y = { chen: 0.24, wu: 0.45, bu: 0.66, mu: 0.85 };

function bambooLeaf(x, y, angleDeg, len = 26, scaleY = 1) {
  const tipX = len;
  const tipY = 0;
  const ctrl1X = len * 0.36;
  const ctrl1Y = -4.2 * scaleY;
  const ctrl2X = len * 0.68;
  const ctrl2Y = 3.8 * scaleY;
  return `<path d="M0 0 Q${fixed(ctrl1X)} ${fixed(ctrl1Y)} ${fixed(tipX)} ${tipY} Q${fixed(ctrl2X)} ${fixed(ctrl2Y)} 0 0Z" transform="translate(${fixed(x)} ${fixed(y)}) rotate(${fixed(angleDeg)})"/>`;
}

/** 四时烟水（墨竹扁舟图）：以茶纸、青竹、烟波、扁舟与点朱绘写意四时手卷，与工笔山水截然分途。 */
export function xieyiShanshuiMarkup({ state, start, now, id = 'ss-xy', weekGoals = [] }) {
  const days = Array.from({ length: 7 }, (_, idx) => {
    const ymd = dayYmd(start + idx * DAY);
    const notes = (state?.notes || []).filter(n => n.date === ymd);
    return { ymd, notes };
  });
  const today = now >= start && now < start + 7 * DAY ? Math.floor((now - start) / DAY) : -1;

  // 远岸烟沙：平缓低伏的水墨沙渚与淡青远渚（绝非尖耸山峰）
  const distantShore = `M-20 302 Q160 278 340 296 T680 286 T1020 298 L1020 ${H} L-20 ${H}Z`;
  const midShore = `M-20 336 Q200 318 440 332 T820 322 T1020 334 L1020 ${H} L-20 ${H}Z`;

  // 烟波晨岚：无事日上浮起轻淡的竹林云气
  const mists = days.map((d, index) => {
    const x = LEFT + index * STEP;
    const rx = d.notes.length ? 68 : 96 + (index % 2) * 14;
    const y = d.notes.length ? 286 : 254 + (index % 3) * 12;
    return `<ellipse class="xy-mist-pool" cx="${fixed(x)}" cy="${fixed(y)}" rx="${rx}" ry="${d.notes.length ? 14 : 20}"/>`;
  }).join('');

  // 七日墨竹与平汀芦苇
  const groves = days.map((d, index) => {
    const baseX = LEFT + index * STEP;
    const baseY = 342;
    const lean = ((index % 3) - 1) * 7 + (index === 5 ? 6 : -4);
    if (!d.notes.length) {
      // 无事日：汀边几笔淡青芦草 + 平静水纹，显出"无事留白"的闲适
      const rx = baseX + (index % 2 ? -10 : 8);
      return `<g class="xy-reeds">
        <path d="M${fixed(rx)} ${baseY} Q${fixed(rx + 6)} ${baseY - 26} ${fixed(rx + 12)} ${baseY - 42}" fill="none" stroke="#6f877d" stroke-width="1.35" stroke-linecap="round" opacity=".52"/>
        <path d="M${fixed(rx + 7)} ${baseY} Q${fixed(rx + 15)} ${baseY - 18} ${fixed(rx + 22)} ${baseY - 30}" fill="none" stroke="#859c92" stroke-width="1.15" stroke-linecap="round" opacity=".45"/>
        <path class="xy-ripple" d="M${fixed(baseX - 28)} ${baseY + 14} Q${fixed(baseX)} ${baseY + 11} ${fixed(baseX + 28)} ${baseY + 14}"/>
      </g>`;
    }

    const cnt = d.notes.length;
    const height = Math.min(212, 118 + cnt * 22);
    const topY = baseY - height;
    const topX = baseX + lean;
    const midX = (baseX + topX) / 2 + (index % 2 ? -5 : 5);
    const midY = (baseY + topY) / 2;

    // 主竹竿 + 竹节
    const culm = `<path class="xy-bamboo-culm" d="M${fixed(baseX)} ${baseY} Q${fixed(midX)} ${fixed(midY)} ${fixed(topX)} ${fixed(topY)}"/>`;
    const nodes = [0.28, 0.54, 0.78].map(t => {
      const nx = baseX + (topX - baseX) * t + (index % 2 ? -2 : 2) * (1 - Math.abs(t - 0.5) * 2);
      const ny = baseY + (topY - baseY) * t;
      return `<line class="xy-bamboo-node" x1="${fixed(nx - 4.5)}" y1="${fixed(ny)}" x2="${fixed(nx + 4.5)}" y2="${fixed(ny - 1.5)}"/>`;
    }).join('');

    // 若当天有 2 笔及以上，添一枝浅青陪衬细竹
    const companion = cnt >= 2
      ? `<path class="xy-bamboo-sub" d="M${fixed(baseX - 11)} ${baseY + 2} Q${fixed(midX - 16)} ${fixed(midY + 18)} ${fixed(topX - 18)} ${fixed(topY + 46)}"/>`
      : '';

    // 冠部疏朗竹叶
    const crownLeaves = [
      bambooLeaf(topX, topY + 6, -34, 28, 1),
      bambooLeaf(topX + 2, topY + 12, 16, 25, -1),
      bambooLeaf(topX - 3, topY + 22, -148, 24, 1),
    ].join('');

    // 按晨/午/晡/暮落位绘枝叶与「点朱」成花
    const slotMarks = d.notes.map((note, ni) => {
      const t = SLOT_Y[note.slot] ?? (0.28 + (ni % 4) * 0.16);
      const y = topY + height * t;
      const sx = topX + (baseX - topX) * t + (ni % 2 ? 4 : -4);
      const side = ni % 2 ? 1 : -1;
      const twig = `<path d="M${fixed(sx)} ${fixed(y)} Q${fixed(sx + side * 12)} ${fixed(y - 8)} ${fixed(sx + side * 22)} ${fixed(y - 13)}" fill="none" stroke="#2f4f45" stroke-width="1.15" opacity=".75"/>`;
      if (note.done) {
        const bx = sx + side * 23;
        const by = y - 14;
        return `${twig}<g class="xy-blossom"><circle cx="${fixed(bx)}" cy="${fixed(by)}" r="7.5" class="xy-blossom-halo"/><circle cx="${fixed(bx)}" cy="${fixed(by)}" r="4.2" class="xy-blossom-core"/></g>`;
      }
      const lx = sx + side * 18;
      const ly = y - 11;
      return `${twig}<g class="xy-leaf">${bambooLeaf(lx, ly, side > 0 ? -18 : -162, 22, 1)}${bambooLeaf(lx, ly, side > 0 ? 18 : 162, 18, -1)}</g>`;
    }).join('');

    return `<g class="xy-grove">${companion}${culm}${nodes}<g class="xy-leaf is-crown">${crownLeaves}</g>${slotMarks}</g>`;
  }).join('');

  // 今日温润淡金月轮 + 江上一叶扁舟
  const todayX = today >= 0 ? LEFT + today * STEP : -1;
  const moon = today >= 0
    ? `<g class="xy-moon"><circle cx="${fixed(todayX)}" cy="78" r="30" class="xy-moon-glow"/><circle cx="${fixed(todayX)}" cy="78" r="14" class="xy-moon-disc"/></g>`
    : '';
  const boatX = today >= 0 ? Math.min(W - 90, Math.max(90, todayX + (today >= 4 ? -36 : 36))) : -1;
  const skiff = today >= 0
    ? `<g class="xy-skiff" transform="translate(${fixed(boatX)} 372)">
        <path class="xy-skiff-wake" d="M-46 5 Q-24 2 -14 4 M22 5 Q36 3 52 6"/>
        <path class="xy-skiff-hull" d="M-24 0 Q-4 7 24 -2 Q10 8 -18 5 Z"/>
        <path class="xy-skiff-canopy" d="M-7 -1 Q0 -11 9 -2 Z"/>
        <line x1="-17" y1="2" x2="-26" y2="-11" stroke="#2c3e44" stroke-width="1.25" stroke-linecap="round"/>
      </g>`
    : '';

  const goalText = weekGoals.length
    ? `远山志 · ${weekGoals.slice(0, 2).join(' / ')}`
    : '四时清闲 · 随意落笔';
  const inscription = `<text x="58" y="54" class="xy-inscribe">${escapeXML(goalText.slice(0, 38))}</text>`;
  const labels = NAMES.map((name, index) => `<text x="${fixed(LEFT + index * STEP)}" y="${H - 12}" class="ss-day xy-day-lbl${index === today ? ' is-today' : ''}">${name}</text>`).join('');
  const summary = `四时烟水：${days.map((d, index) => `周${NAMES[index]}${d.notes.length}笔`).join('，')}。`;

  return `<svg class="shanshui shanshui-xieyi" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${summary}">
    <defs>
      <linearGradient id="${id}-paperbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#faf5e8"/><stop offset=".68" stop-color="#f3ebd8"/><stop offset="1" stop-color="#ece2cb"/></linearGradient>
      <linearGradient id="${id}-distant" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b7c6bc" stop-opacity=".46"/><stop offset="1" stop-color="#efe6d3" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#87a095" stop-opacity=".44"/><stop offset=".75" stop-color="#efe6d3" stop-opacity="0"/></linearGradient>
      <filter id="${id}-paper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves="2" seed="17"/><feColorMatrix values="0 0 0 0 .45  0 0 0 0 .4  0 0 0 0 .3  0 0 0 .045 0"/></filter>
      <filter id="${id}-wash" x="-5%" y="-10%" width="110%" height="130%"><feTurbulence type="fractalNoise" baseFrequency=".012 .04" numOctaves="2" seed="19"/><feDisplacementMap in="SourceGraphic" scale="8"/><feGaussianBlur stdDeviation="2.2"/></filter>
      <filter id="${id}-mist" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="11"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#${id}-paperbg)"/>
    <rect width="${W}" height="${H}" filter="url(#${id}-paper)"/>
    ${moon}
    <path d="${distantShore}" fill="url(#${id}-distant)" filter="url(#${id}-wash)"/>
    <path d="${midShore}" fill="url(#${id}-mid)" filter="url(#${id}-wash)"/>
    <g filter="url(#${id}-mist)">${mists}</g>
    <path class="xy-river" d="M24 358 Q260 350 500 359 T976 357 M110 376 Q340 370 590 377 T900 375 M60 390 Q320 385 640 392 T940 389"/>
    ${groves}
    ${skiff}
    ${inscription}
    <g class="ss-seal is-xieyi" transform="translate(${W - 58} 26)"><rect width="30" height="44" rx="3"/><text x="15" y="19">写</text><text x="15" y="37">意</text></g>
    ${labels}
  </svg>`;
}
