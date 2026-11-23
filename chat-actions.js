/**
 * 研墨里一句话就能做的事（不必去笔墨、铺纸里找）：
 * - 起步卡："帮我开个头：交实验报告"（另起一行可贴材料原文）
 * - 常用专注时段："我工作日晚上7点到9点最专注" / "周末上午9到11点效率最高"
 * - 任务标记："实验报告需要专注" / "报名表碎片时间做就行"
 * - 点名完成与估时："实验报告做完了" / "报名表要20分钟"
 * Pure parsing and markup; agent.js runs the action and writes the list.
 */
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const DAY = 86400000;
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const num = text => (/^\d+$/.test(text) ? Number(text) : CN[text] ?? NaN);
const pad = value => String(value).padStart(2, '0');

/**
 * The active task a sentence names: a title inside it, or a title it is inside (soonest deadline wins),
 * else the one task sharing two characters with it. { task, byName } — byName false means it fell back to
 * the task just talked about.
 */
export function findTask(snapshot, phrase, lastTaskId = null) {
  const active = snapshot.tasks.filter(task => task.status === 'active');
  const clean = String(phrase || '').replace(/[「」“”"'\s，。！？,.!?]/g, '').replace(/^(?:给|帮|把|我的?|那个|这个)/, '');
  const byDeadline = list => list.slice().sort((a, b) => Date.parse(a.deadline_at || '9999') - Date.parse(b.deadline_at || '9999'));
  if (clean.length >= 2) {
    const hits = active.filter(task => { const title = task.title.replace(/\s/g, ''); return clean.includes(title) || title.includes(clean); });
    if (hits.length) return { task: byDeadline(hits)[0], byName: true };
    const loose = active.filter(task => [...new Set(clean)].filter(c => task.title.includes(c)).length >= 2);
    if (loose.length === 1) return { task: loose[0], byName: true };
  }
  const last = active.find(task => task.id === lastTaskId);
  return { task: last || null, byName: false };
}
// Reminders, notices and questions are never sentence actions.
const NOT_ACTION = /^(?:提醒我|帮我记|记得|别忘了|待办)|【|通知|各位同学|[？?]$|吗$/;

const STARTER = /^(?:请|帮我|给我|替我)?(?:给)?(?:(.{1,30}?)(?:的)?)?(?:开个头|起个头|开头|五分钟起步|起步卡|起步|怎么开始|从哪(?:里|儿)?(?:开始|下手)|不知道(?:怎么|从哪)(?:开始|下手))(?:吧|呢|吗)?[：:，,]?\s*(.*)$/s;
/** "帮我开个头：交实验报告\n<材料>" → { kind: 'starter', phrase, material } */
export function parseStarter(text) {
  const raw = String(text || '').trim();
  const [first, ...rest] = raw.split('\n');
  const line = first.replace(/[。！!？?]+$/, '');
  if (line.length > 40 || /^(?:提醒我|帮我记|记得|别忘了|待办)|【|通知/.test(line)) return null;
  const match = line.match(STARTER);
  if (!match) return null;
  const phrase = [match[1], match[2]].filter(Boolean).join(' ').replace(/^(?:给|帮)?/, '').replace(/^(?:五分钟|5\s*分钟)$/, '').trim();
  const material = rest.join('\n').replace(/^(?:材料|要求|原文)[：:]\s*/, '').trim();
  return { kind: 'starter', phrase, material: material.slice(0, 6000) };
}

const HOUR = String.raw`(\d{1,2}|[一二两三四五六七八九十]{1,3})(?:点|:00)?(半)?`;
// 常 alone, but not inside 非常 / 异常 / 正常 / 日常 / 平常 / 反常 / 通常 (通常 is listed on its own).
const RECURRING = /(平时|每天|工作日|周一到周五|周末|一般|通常|往往|每周|常常|经常|习惯|总是|(?<![非异正日平反通])常)/;
const FOCUS_WORD = /(最专注|专注|效率最高|效率高|最清醒|脑子最好使|状态最好|最能静下心)/;
// Without an explicit X点到Y点, a part of the day stands for a default span (adjustable on 铺纸).
const PERIODS = [
  [/全天|整天|一整天/, '全天', '09:00', '22:00'],
  [/早上|上午|清早|早晨/, '上午', '08:00', '12:00'],
  [/下午/, '下午', '14:00', '18:00'],
  [/晚上|傍晚|夜里|晚间/, '晚上', '19:00', '22:00'],
];
/** Which days a sentence speaks of: { weekday, weekend } (neither named → null). */
function focusDays(line) {
  if (/每天|每周/.test(line)) return { weekday: true, weekend: true };
  if (/周末/.test(line) && !/工作日|平时/.test(line)) return { weekday: false, weekend: true };
  if (/工作日|平时|周一到周五/.test(line)) return { weekday: true, weekend: false };
  return null;
}
/**
 * "我工作日晚上7点到9点最专注" → { kind: 'focus-window', weekday?: {start,end}, weekend?: {...} }.
 * Without a clock range a part of the day maps to its default span ({ guessed: '下午 14:00–18:00' }).
 * Nothing to go on → { missing: true, days }, so the follow-up can be read against it.
 * afterAsk: the {weekday, weekend} of a focus question just asked; the reply then needs no 平时/经常 word and
 * may leave the days out ("常在下午专注" after "我需要在周末的全天专注" is about the weekend).
 */
export function parseFocusWindow(text, { afterAsk = null } = {}) {
  const line = String(text || '').trim();
  if (/累|困|休息|歇/.test(line) || !FOCUS_WORD.test(line)) return null;
  if (!RECURRING.test(line) && !afterAsk) return null;
  const said = focusDays(line);
  const days = said || afterAsk || { weekday: true, weekend: false };
  // byContext: only the question just asked makes this a focus answer; agent.js still lets a task name win.
  const byContext = !RECURRING.test(line);
  const out = span => ({ kind: 'focus-window', weekday: days.weekday ? span : null, weekend: days.weekend ? span : null, ...(byContext ? { byContext } : {}) });
  const missing = { kind: 'focus-window', missing: true, days, ...(byContext ? { byContext } : {}) };
  const range = line.match(new RegExp(`${HOUR}\\s*(?:到|至|-|—|~)\\s*${HOUR}`));
  if (!range) {
    const hits = PERIODS.filter(([pattern]) => pattern.test(line));
    if (!hits.length) return missing;
    const all = hits.find(([, name]) => name === '全天');
    const chosen = all ? [all] : hits;
    const start = chosen.map(item => item[2]).sort()[0];
    const end = chosen.map(item => item[3]).sort().at(-1);
    return { ...out({ start, end }), guessed: `${chosen.map(item => item[1]).join('、')} ${start}–${end}` };
  }
  const period = (line.match(/上午|早上|下午|晚上|傍晚/) || [''])[0];
  const toHour = (h, half) => { let hour = num(h); if (Number.isNaN(hour)) return null; if (/下午|晚上|傍晚/.test(period) && hour < 12) hour += 12; else if (!period && hour <= 6) hour += 12; return `${pad(hour)}:${half ? '30' : '00'}`; };
  const start = toHour(range[1], range[2]);
  let end = toHour(range[3], range[4]);
  if (!start || !end) return missing;
  if (end <= start && Number(end.slice(0, 2)) < 12) end = `${pad(Number(end.slice(0, 2)) + 12)}:${end.slice(3)}`;
  if (end <= start) return missing;
  return out({ start, end });
}

/** "实验报告需要专注" / "报名表碎片时间做就行" → { kind: 'mark', phrase, mark } */
export function parseMark(text) {
  const line = String(text || '').trim().replace(/[。！!]+$/, '');
  if (NOT_ACTION.test(line)) return null;
  const focus = line.match(/^(.{2,30}?)(?:需要|得|要)(?:专注|专心|整块时间|静下心)(?:做|写|来做)?(?:吧|才行)?$/);
  if (focus) return { kind: 'mark', phrase: focus[1], mark: 'focus' };
  const fragment = line.match(/^(.{2,30}?)(?:适合)?(?:用)?(?:碎片(?:时间)?|零碎时间)(?:做|弄|写)?(?:就行|就好|即可|就可以)?$/);
  if (fragment) return { kind: 'mark', phrase: fragment[1], mark: 'fragment' };
  return null;
}

const DURATION = String.raw`(\d+(?:\.\d+)?|[半一二两三四五六七八九十]+)\s*(?:个)?\s*(小时|钟头|分钟|min|h)(半)?`;
/** "实验报告做完了" / "报名表要20分钟" → named complete / estimate (agenda.js handles the unnamed "做完了"). */
export function parseNamedUpdate(text) {
  const line = String(text || '').trim().replace(/[。！!]+$/, '');
  if (NOT_ACTION.test(line) || /[，,]/.test(line)) return null;
  const done = line.match(/^(?:我)?(?:把)?(.{2,30}?)(?:已经|刚刚)?(?:做完了|完成了|搞定了|交了|交上去了|写完了)$/);
  if (done && !/^(?:我|刚刚|已经|都)$/.test(done[1])) return { kind: 'complete', phrase: done[1] };
  const est = line.match(new RegExp(`^(.{2,30}?)(?:大概|大约|预计|要|需要|得)\\s*${DURATION}(?:左右|吧)?$`, 'i'));
  if (est) {
    const n = num(est[2]) || (est[2] === '半' ? 0.5 : Number(est[2]));
    const minutes = Math.round((/小时|钟头|h/i.test(est[3]) ? n * 60 : n) + (est[4] ? 30 : 0));
    if (minutes > 0 && minutes <= 20160) return { kind: 'estimate', phrase: est[1], minutes };
  }
  return null;
}

/** First match of all the sentence actions above, in a fixed order. */
export function parseChatAction(text, { afterAsk = null } = {}) {
  return parseStarter(text) || parseFocusWindow(text, { afterAsk }) || parseMark(text) || parseNamedUpdate(text);
}

// ---- Markup in the 研墨 thread ------------------------------------------------------
/** The 起步卡 as a reply: one first step, the material lines it came from, start and copy. */
export function starterReply(task, card, { degraded = false } = {}) {
  const excerpts = card.material_brief?.excerpts || [];
  const head = card.resting ? '现在正休息' : '先做这一步';
  const draft = [task.title, ...(excerpts.length ? ['', '材料原文', ...excerpts.map(line => `- ${line}`)] : []), '', card.resting ? '休息结束后' : '第一步', card.action].join('\n');
  return `<div class="turn-card starter-card${card.resting ? ' is-resting' : ''}">
    <p class="turn-card-eyebrow">五分钟起步 · 「${escape(task.title)}」</p>
    <p class="starter-step"><strong>${head}</strong><span>${escape(card.action)}</span></p>
    ${excerpts.length ? `<div class="starter-source"><p>从你给的材料里摘出</p><ul>${excerpts.map(line => `<li>${escape(line)}</li>`).join('')}</ul></div>` : ''}
    ${degraded ? '<p class="field-help">当前计算服务还不能读材料，先按任务名给出第一步。</p>' : ''}
    <div class="turn-card-actions"><button type="button" class="primary-button" data-turn-timer>开始 5 分钟</button><button type="button" class="text-button" data-turn-copy>复制草稿</button><textarea class="sr-only" data-turn-draft readonly>${escape(draft)}</textarea></div>
  </div>`;
}
/** "下一步可以说" chips: each sends its sentence as if typed. */
export function nextChips(says) {
  const list = says.filter(Boolean);
  if (!list.length) return '';
  return `<div class="turn-next" role="group" aria-label="下一步可以直接说"><span>下一步可以说</span>${list.map(say => `<button type="button" class="turn-chip" data-say="${escape(say)}">${escape(say)}</button>`).join('')}</div>`;
}

// ---- 试算卡：/api/v3/capacity/plan 与 /api/v3/chat 的 capacity（capacity_plan_v1） ----------------------
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const span = minutes => { const h = Math.floor(minutes / 60); const m = Math.round(minutes % 60); return h && m ? `${h} 小时 ${m} 分` : h ? `${h} 小时` : `${m} 分钟`; };
/**
 * One card for both results: a verdict, where each activity goes (or what it still lacks), what is left,
 * and, when it does not fit, the backend's 2–3 verified trade-offs. id keys the card's "记进日历".
 */
export function planCardMarkup(plan, id = '') {
  if (!plan || typeof plan !== 'object') return '';
  const multi = plan.tool === 'plan_activities';
  const ok = multi ? plan.feasible : plan.available_minutes > 0;
  const scope = plan.scope?.label || '这段时间';
  const verdict = multi ? (ok ? `${scope}排得开` : `${scope}排不开`) : `${scope}还剩 ${span(plan.available_minutes || 0)}`;
  const rows = multi ? (plan.placements || []).map(item => {
    const blocks = (item.blocks || []).map(block => esc(block.label)).join('、');
    const state = item.status === 'placed' ? blocks : item.status === 'partial' ? `${blocks}（还差 ${span(item.shortfall_minutes || 0)}）` : `放不下，还差 ${span(item.shortfall_minutes || 0)}`;
    return `<li class="pc-row is-${esc(item.status)}"><b>${esc(item.title)}</b><span>${state}</span></li>`;
  }).join('') : (plan.free_slots || []).slice(0, 4).map(slot => `<li class="pc-row is-free"><b>空档</b><span>${esc(slot.label)}</span></li>`).join('');
  const left = `<p class="pc-left">排完还剩 <b>${span(plan.leftover_minutes ?? plan.available_minutes ?? 0)}</b> 留白 · 最长连续 ${span(plan.longest_free_minutes || 0)}${plan.reserve_rest_minutes ? ` · 已预留休息 ${span(plan.reserve_rest_minutes)}` : ''}</p>`;
  const trade = !ok && plan.tradeoffs?.length ? `<div class="pc-trades"><p>可以这样取舍：</p><ol>${plan.tradeoffs.map(option => `<li><b>${esc(option.title)}</b><span>${esc(option.consequence || '')}</span></li>`).join('')}</ol></div>` : '';
  const warn = plan.warnings?.length ? `<p class="pc-warn">${plan.warnings.map(esc).join(' ')}</p>` : '';
  const adopt = multi && ok && id ? `<div class="pc-actions"><button type="button" class="primary-button" data-plan-adopt="${esc(id)}">照这样记进日历</button><a href="#/calendar" data-agenda-calendar>看画卷</a></div>` : '<p class="inline-links"><a href="#/calendar" data-agenda-calendar>看画卷</a></p>';
  return `<section class="plan-card ${ok ? 'is-ok' : 'is-short'}" aria-label="${esc(verdict)}"><header><i aria-hidden="true"></i><strong>${esc(verdict)}</strong></header><ul>${rows}</ul>${left}${trade}${warn}${adopt}</section>`;
}

// ---- 语义草案确认卡：/api/v3/chat 的 proposal（agenda_chat_proposals_v1） -----------------------------
const PROPOSAL_FIELD = { start_at: '开始', end_at: '结束', deadline_at: '截止', earliest_start_at: '最早开始', location: '地点', estimate_minutes: '预计用时', status: '状态', title: '标题' };
function fmtBeijing(iso) {
  if (!iso) return '时间待书';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const d = new Date(ms + 8 * 3600000);
  const pad2 = n => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
function fmtFieldVal(field, value) {
  if (value === null || value === undefined || value === '') return '未填';
  if (field === 'status') return value === 'cancelled' ? '取消' : value === 'completed' ? '完成' : '照常';
  if (field === 'estimate_minutes') return span(Number(value));
  if (field.endsWith('_at')) return fmtBeijing(value);
  return String(value);
}
function impactLine(impact) {
  if (!impact || typeof impact !== 'object') return '';
  const parts = [`叠墨 ${impact.conflicts_before ?? 0} → ${impact.conflicts_after ?? 0} 处`];
  if (impact.free_delta_minutes) parts.push(`本周留白 ${impact.free_delta_minutes > 0 ? '+' : '−'}${span(Math.abs(impact.free_delta_minutes))}`);
  return `<p class="pc-left">确定性校验预览：${parts.join(' · ')}</p>`;
}
const PROPOSAL_KINDS = [
  ['temporary', '点墨', '外部安排，到点必须到场'],
  ['appointment', '约定', '自己或和朋友定的固定时段'],
  ['deadline', '截止', '有明确交付节点的任务'],
  ['personal', '个人任务', '给自己立的弹性待办'],
  ['disruption', '临时打断', '突发插入，按此重算这一周'],
];
export const PROPOSAL_KIND_LABEL = Object.fromEntries(PROPOSAL_KINDS.map(([key, label]) => [key, label]));
export function proposalCardMarkup(proposal, id = '') {
  if (!proposal || typeof proposal !== 'object' || !id) return '';
  if (proposal.kind === 'add_items') {
    const items = proposal.items || [];
    const title = `待确认记入清单（${items.length} 项）`;
    const rows = items.map((item, index) => {
      const layer = item.layer || (item.kind === 'event' ? 'appointment' : 'deadline');
      const badge = PROPOSAL_KIND_LABEL[layer] || (item.kind === 'event' ? '约定' : '截止');
      const when = item.kind === 'event'
        ? (item.start_at ? `${fmtBeijing(item.start_at)}${item.end_at ? `–${fmtBeijing(item.end_at).split(' ')[1]}` : ''}` : '时间待书')
        : (item.deadline_at ? `${fmtBeijing(item.deadline_at)} 前` : '时间待书');
      const extra = [item.estimate_minutes ? `约 ${span(item.estimate_minutes)}` : '', item.location || ''].filter(Boolean).join(' · ');
      const canDisrupt = Boolean(item.start_at || item.deadline_at);
      const pills = PROPOSAL_KINDS
        .filter(([key]) => key !== 'disruption' || canDisrupt)
        .map(([key, label, tip]) => `<button type="button" class="pc-pill${layer === key ? ' is-on' : ''}" data-prop-kind="${esc(id)}:${index}:${key}" aria-pressed="${layer === key}" title="${esc(tip)}">${label}</button>`)
        .join('');
      return `<li class="pc-row is-placed is-switchable" data-prop-item="${index}"><div class="pc-row-main"><b data-prop-title>${badge} · ${esc(item.title)}</b><span>${esc(when)}${extra ? `（${esc(extra)}）` : ''}</span></div><div class="pc-kind-pills" role="group" aria-label="切换归类">${pills}</div></li>`;
    }).join('');
    return `<section class="plan-card is-ok" aria-label="${esc(title)}"><header><i aria-hidden="true"></i><strong>${esc(title)}</strong></header><ul>${rows}</ul><p class="pc-hint">归类不准可直接点每项下方标签切换（点墨＝到点必到，约定＝自己定，截止＝要交付，个人任务＝弹性待办）。</p>${impactLine(proposal.impact)}<div class="pc-actions"><button type="button" class="primary-button" data-proposal-adopt="${esc(id)}">确认记入清单</button><a href="#/calendar" data-agenda-calendar>看画卷</a></div></section>`;
  }
  if (proposal.kind === 'update_item') {
    const verb = proposal.action === 'cancel' ? '取消' : proposal.action === 'complete' ? '标记完成' : '改动';
    const title = `待确认${verb}「${proposal.target_title || ''}」`;
    const rows = Object.entries(proposal.changes || {}).map(([field, diff]) => `<li class="pc-row is-placed"><b>${esc(PROPOSAL_FIELD[field] || field)}</b><span>${esc(fmtFieldVal(field, diff.from))} → ${esc(fmtFieldVal(field, diff.to))}</span></li>`).join('');
    return `<section class="plan-card is-ok" aria-label="${esc(title)}"><header><i aria-hidden="true"></i><strong>${esc(title)}</strong></header><ul>${rows}</ul>${impactLine(proposal.impact)}<div class="pc-actions"><button type="button" class="primary-button" data-proposal-adopt="${esc(id)}">采用这项改动</button><a href="#/calendar" data-agenda-calendar>看画卷</a></div></section>`;
  }
  if (proposal.kind === 'focus_window') {
    const title = '待确认常用专注时段';
    const rows = [
      proposal.weekday ? `<li class="pc-row is-placed"><b>工作日</b><span>${esc(proposal.weekday.start)}–${esc(proposal.weekday.end)}</span></li>` : '',
      proposal.weekend ? `<li class="pc-row is-placed"><b>周末</b><span>${esc(proposal.weekend.start)}–${esc(proposal.weekend.end)}</span></li>` : '',
    ].filter(Boolean).join('');
    return `<section class="plan-card is-ok" aria-label="${esc(title)}"><header><i aria-hidden="true"></i><strong>${esc(title)}</strong></header><ul>${rows}</ul><div class="pc-actions"><button type="button" class="primary-button" data-proposal-adopt="${esc(id)}">保存为常用专注时段</button><a href="#/time">去铺纸看</a></div></section>`;
  }
  if (proposal.kind === 'replan_draft') {
    const title = `按「${proposal.label || '当前状态'}」重排本周`;
    const rows = `<li class="pc-row is-placed"><b>${esc(proposal.label || '状态')}</b><span>${esc(fmtBeijing(proposal.start_at))} – ${esc(fmtBeijing(proposal.end_at))}</span></li>`;
    return `<section class="plan-card is-ok" aria-label="${esc(title)}"><header><i aria-hidden="true"></i><strong>${esc(title)}</strong></header><ul>${rows}</ul><div class="pc-actions"><button type="button" class="primary-button" data-proposal-adopt="${esc(id)}">按此重算这一周</button><a href="#/calendar" data-agenda-calendar>看画卷</a></div></section>`;
  }
  return '';
}
