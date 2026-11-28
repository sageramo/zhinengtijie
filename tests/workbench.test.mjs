/**
 * Pure Node DOM unit tests for the four-layer workbench: no browser, layout
 * engine, screenshots, HTTP server or live network. fetch and Web Locks are
 * in-memory fakes; API responses are real backend output saved as fixtures.
 * These checks do not claim visual, keyboard or real-browser verification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { STORAGE_KEY as V2_KEY } from '../task-state.js';
import { TIME_STORAGE_KEY, createTimeSnapshot, addImported, addTask, serializeTimeSnapshot } from '../time-state.js';
import { weekRange, weekStart } from '../calendar.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const API = JSON.parse(readFileSync(new URL('./fixtures/v3-api.json', import.meta.url), 'utf8'));
const CALENDAR = JSON.parse(readFileSync(new URL('./fixtures/calendar-v3.json', import.meta.url), 'utf8')).result;
const BASE = 'https://sixu-api.invalid';
const CAPABILITIES = ['time_layers_v3', 'timetable_v3'];
let instance = 0;
const settle = async (ms = 320) => { await sleep(ms); for (let turn = 0; turn < 6; turn += 1) await sleep(0); };

/** A calendar answer shaped like the real one, with task states derived from the posted snapshot. */
function calendarAnswer(body) {
  const tasks = body.snapshot.tasks.map(task => ({ id: task.id, estimate_minutes: task.estimate_minutes, scheduled_minutes: 0, assumptions: [],
    state: task.status !== 'active' ? task.status : task.deadline_at === null ? 'deadline_undefined' : task.estimate_minutes === null ? 'estimate_undefined' : 'scheduled' }));
  const answer = { ...structuredClone(CALENDAR), revision: body.snapshot.revision, range: body.range, tasks };
  // Align the fixture's Monday conflict date to the requested week so weekly conflict scoping matches real backend output.
  if (body.range?.from && body.range.from !== '2026-11-09') {
    const swap = value => typeof value === 'string' ? value.replaceAll('2026-11-09', body.range.from) : value;
    for (const conflict of answer.conflicts) {
      conflict.start = swap(conflict.start);
      conflict.end = swap(conflict.end);
      for (const item of conflict.items) { item.id = swap(item.id); item.start = swap(item.start); item.end = swap(item.end); }
    }
  }
  return answer;
}

async function boot(t, { routes = {}, health = {}, initial = {}, ocrEngine = null } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost:8873/', runScripts: 'outside-only' });
  const { window } = dom;
  window.CAMPUS_AGENT_API = BASE;
  if (ocrEngine) window.SIXU_OCR_ENGINE = ocrEngine;
  window.URL.createObjectURL = () => 'blob:preview';
  window.URL.revokeObjectURL = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.confirm = () => true;
  const data = new Map(Object.entries(initial));
  const writes = [];
  const storage = {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); writes.push({ key, value: String(value) }); },
    removeItem(key) { data.delete(key); },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(window.navigator, 'locks', { value: { async request(name, options, callback) { return callback(); } }, configurable: true });
  const calls = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body, headers: options.headers || {} });
    let status = 200;
    let payload;
    if (path === '/api/health') payload = { version: '1.13', capabilities: CAPABILITIES, model_extraction: { configured: false }, timetable_model: { configured: false }, ...health };
    else if (routes[path]) [status, payload] = await routes[path](body, options.headers || {});
    else if (path === '/api/v3/calendar') payload = calendarAnswer(body);
    else throw new Error(`Unexpected request: ${path}`);
    return { ok: status < 300, status, async text() { return JSON.stringify(payload); } };
  };
  const globals = { window, document: window.document, location: window.location, navigator: window.navigator, fetch, DOMParser: window.DOMParser };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const errors = [];
  window.addEventListener('error', event => { errors.push(event.error || event.message); event.preventDefault(); });
  t.after(async () => {
    await settle();
    window.close();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(errors, [], 'DOM event handlers must not throw');
  });
  await import(`../agent.js?dom-unit=${++instance}`);
  await settle();
  const find = selector => window.document.querySelector(selector);
  const all = selector => [...window.document.querySelectorAll(selector)];
  const click = selector => { const element = find(selector); assert.ok(element, selector); element.click(); };
  const set = (selector, value, type = 'change') => { const element = find(selector); assert.ok(element, selector); element.value = value; element.dispatchEvent(new window.Event(type, { bubbles: true })); };
  const submit = selector => { const form = find(selector); assert.ok(form, selector); form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  const stored = () => { const raw = data.get(TIME_STORAGE_KEY); return raw ? JSON.parse(raw) : null; };
  return { window, find, all, click, set, submit, calls, data, writes, stored, message: () => find('#appMessage').textContent };
}

const extractRoute = (status = 200, payload = API.extract) => ({ '/api/v3/extract': async () => [status, structuredClone(payload)] });
async function imported(t, options = {}) {
  const app = await boot(t, { routes: extractRoute(), ...options });
  app.set('#noticeText', API.notice, 'input');
  app.submit('#noticeForm');
  await settle();
  return app;
}

test('a fresh list shows free time as undefined and asks the v3 calendar for the reference week', async t => {
  const app = await boot(t);
  assert.match(app.find('#windowState').textContent, /待书/);
  const request = app.calls.find(call => call.path === '/api/v3/calendar');
  assert.ok(request, 'calendar requested on load');
  assert.equal(request.body.snapshot.schema_version, 3);
  assert.match(request.body.range.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(app.find('#calendarView').textContent, /叠墨/);
});

test('the task starter uses only the supplied excerpt, never writes back, and clears when the text changes', async t => {
  const snapshot = addTask(createTimeSnapshot({ referenceTime: '2026-11-22T09:00:00+08:00' }), { title: '写摄影分析报告' });
  const material = '至少选两张照片。<em>提交 PDF</em>';
  const app = await boot(t, {
    health: { capabilities: [...CAPABILITIES, 'starter_material_v1'] },
    initial: { [TIME_STORAGE_KEY]: serializeTimeSnapshot(snapshot) },
    routes: { '/api/v3/starter': async () => [200, { action: '选一条原文作为小节标题。', material_brief: { excerpts: [material] } }] },
  });
  const input = '[data-task-starter] textarea[name="material"]';
  app.set(input, material, 'input');
  app.submit('[data-task-starter]');
  await settle();
  const request = app.calls.find(call => call.path === '/api/v3/starter');
  assert.ok(request);
  assert.equal(request.body.material_text, material);
  assert.equal(request.body.mode, 'rules');
  assert.equal(request.body.snapshot, undefined);
  assert.equal(app.find('[data-starter-result]').hidden, false);
  assert.equal(app.find('[data-starter-result] li').textContent, material);
  assert.equal(app.find('[data-starter-result] li em'), null);
  assert.deepEqual(app.stored(), snapshot);
  assert.deepEqual(app.writes, []);
  app.click('[data-starter-copy]');
  await settle();
  const fallback = app.find('[data-starter-copy-fallback]');
  assert.equal(fallback.hidden, false);
  assert.ok(fallback.querySelector('textarea').value.includes(material));
  app.set(input, '修改后的材料', 'input');
  assert.equal(app.find('[data-starter-result]').hidden, true);
});

test('tabs start at 研墨 (with bottom-left 笔墨 entry linking to #/items), and the 3-step workbench links cleanly', async t => {
  const app = await boot(t);
  assert.deepEqual(app.all('.page-tabs a').map(tab => [tab.dataset.tab, tab.querySelector('.tab-name').textContent, tab.querySelector('.tab-sub').textContent]),
    [['import', '研墨', '通知与笔墨'], ['time', '铺纸', '底色与留白'], ['calendar', '画卷', '一周日历']]);
  assert.equal(app.find('#inkRail .rail-foot #inkItemsEntry').getAttribute('href'), '#/items');
  assert.equal(app.find('[data-page="items"] .subpage-back').getAttribute('href'), '#/import');
  assert.ok(app.find('[data-page="items"] #inkPool'), '#inkPool lives on #/items subpage');
  assert.deepEqual(app.all('#inkPool [data-pool-filter]').map(b => b.dataset.poolFilter), ['all', 'timed', 'deadline', 'day', 'pending']);
  assert.ok(app.find('#addPersonal') && app.find('#addTask') && app.find('#addEvent') && app.find('#addAppointment'));
  assert.equal(app.find('.aux-nav a[href="#/"]').textContent, '项目介绍');
  assert.deepEqual(app.all('.next-step').map(link => link.getAttribute('href')).sort(), ['#/calendar', '#/time']);
  assert.deepEqual(app.all('.feature-card').map(card => card.getAttribute('href')), ['#/import', '#/time', '#/calendar']);
  assert.equal(app.find('.hero-actions .cta').getAttribute('href'), '#/import');
});

test('an old service without time layers is explained instead of failing silently', async t => {
  const app = await boot(t, { health: { capabilities: ['snapshot_v2'] } });
  assert.match(app.find('#calendarView').textContent, /四层时间版本/);
  assert.equal(app.calls.some(call => call.path === '/api/v3/calendar'), false);
});

test('rules import adds events and tasks at once, explains what is still undefined and clears the box', async t => {
  const app = await imported(t);
  const call = app.calls.find(item => item.path === '/api/v3/extract');
  assert.deepEqual(call.body, { text: API.notice, reference_date: null, mode: 'rules' });
  const stored = app.stored();
  assert.deepEqual([stored.events.length, stored.tasks.length, stored.sources.length], [1, 2, 1]);
  assert.equal(stored.sources[0].kind, 'synthetic');
  assert.match(app.find('#importSummary').textContent, /已加入 1 处点墨、2 件截止之事/);
  assert.match(app.find("#importSummary").textContent, /预计用时可以不填，只标截止/);
  assert.doesNotMatch(app.find("#importSummary").textContent, /预计用时还是待书/);
  assert.equal(app.find('#noticeText').value, '');
  assert.equal(app.all('#eventList [data-item-id]').length, 1);
  assert.equal(app.all('#taskList [data-item-id]').length, 2);
  // A missing estimate is optional now, so it no longer lights the 笔墨 tab.
  assert.equal(app.find('#itemsCount').textContent, '');
  const last = app.calls.filter(item => item.path === '/api/v3/calendar').at(-1);
  assert.equal(last.body.snapshot.revision, stored.revision, 'calendar recomputed for the new list');
  assert.match(app.find("#taskList").textContent, /只标截止/);
});

test('the roadshow case starts at the roadshow (11-24 14:15) and puts the 摄影社 notice for the 25th in the box without importing it', async t => {
  const app = await boot(t);
  app.click('#loadPhotoCase');
  await settle();
  const stored = app.stored();
  const wednesday = '2026-11-25';
  assert.equal(stored.reference_time.slice(0, 16), '2026-11-24T14:15');
  assert.deepEqual(stored.daily_window[2], { start: '14:00', end: '18:00' });
  assert.deepEqual(stored.routines.find(routine => routine.title === '专业课') && [stored.routines.find(routine => routine.title === '专业课').start, stored.routines.find(routine => routine.title === '专业课').end], ['14:00', '15:00']);
  assert.equal(stored.routines_confirmed, true);
  assert.deepEqual([stored.events.length, stored.tasks.length], [0, 0]);
  const [year, month, day] = wednesday.split('-').map(Number);
  assert.equal(app.find('#noticeText').value, `【摄影社招新通知】\n${year}年${month}月${day}日14:30-15:30举行摄影社招新说明会（学活204）。\n${year}年${month}月${day}日18:00前提交社团报名表。`);
  assert.equal(app.find('#noticeDate').value, wednesday);
  assert.equal(app.calls.some(call => call.path === '/api/v3/extract'), false);
});

test('笔墨 filters items by precision tier, counts them, and opens card editors when needed', async t => {
  const app = await imported(t);
  assert.equal(app.find('#eventCount').textContent, '1');
  assert.equal(app.find('#deadlineCount').textContent, '2');
  assert.equal(app.find('#appointmentCount').textContent, '0');
  assert.equal(app.find('[data-tier-count="all"]').textContent, '3');
  assert.equal(app.find('[data-tier-count="timed"]').textContent, '1');
  assert.equal(app.find('[data-tier-count="deadline"]').textContent, '2');
  const [first] = app.stored().tasks;
  let card = app.find(`#item-${first.id}`);
  assert.ok(card.classList.contains('is-deadline'));
  assert.equal(card.dataset.tier, 'deadline');
  assert.equal(card.querySelector('.pool-tier-badge').textContent, '定期限');
  // An estimate is optional: the card says so and stays folded; it is not 待书.
  assert.match(card.querySelector('[data-item-meta]').textContent, /用时选填/);
  assert.equal(card.querySelector('[data-item-state]').textContent, '只标截止');
  assert.equal(card.querySelector('.item-edit').open, false);
  card.querySelector('[data-estimate="30"]').click();
  await settle();
  card = app.find(`#item-${first.id}`);
  assert.match(card.querySelector('[data-item-meta]').textContent, /预计 30 分钟/);

  // Filtering by 定时 shows only the timed event
  app.click('[data-pool-filter="timed"]');
  assert.equal(app.find(`#item-${first.id}`).hidden, true);
  assert.equal(app.all('#inkPool [data-item-id]:not([hidden])').length, 1);
  app.click('[data-pool-filter="all"]');

  app.click('[data-tab="calendar"]');
  app.click('#inkItemsEntry');
  app.find('#addEvent').click();
  await settle();
  assert.equal(app.find('#eventList').lastElementChild.querySelector('.item-edit').open, true, 'a 点墨 without a time opens its editor');
  card = app.find(`#item-${first.id}`);
  assert.equal(card.querySelector('.item-edit').open, false, 'a complete card folds after a re-render');
  card.querySelector('.item-edit > summary').click();
  await settle();
  assert.equal(card.querySelector('.item-edit').open, true);
  app.find('#addEvent').click();
  await settle();
  assert.equal(app.find(`#item-${first.id}`).querySelector('.item-edit').open, true, 'an editor the user opened stays open');
});

test('笔墨 renders flat groups on #/items and clicking a block on 画卷 jumps to its card in 笔墨', async t => {
  const app = await imported(t);
  const routes = [];
  app.window.SixuRouter = { go: r => routes.push(r) };
  assert.equal(app.find('#deadlineCount').textContent, '2');
  assert.equal(app.find('#taskSection').dataset.active, 'deadline', 'the group that has items marks active');
  const [task] = app.stored().tasks;
  app.find('#calendarView').insertAdjacentHTML('beforeend', `<button type="button" data-cal-item="${task.id}" data-cal-layer="task">t</button>`);
  app.find(`#calendarView [data-cal-item="${task.id}"]`).click();
  assert.deepEqual(routes, ['items']);
  assert.ok(app.find(`#item-${task.id}`).classList.contains('is-flash'));
});

test('1.26 notice diff: a change notice shows field changes instead of importing duplicates, and applies on one click', async t => {
  const routes = {
    ...extractRoute(),
    '/api/v3/notice-diff': async body => {
      const event = body.snapshot.events[0];
      const preview = structuredClone(body.snapshot);
      preview.events[0] = { ...preview.events[0], start_at: '2026-11-26T19:00:00+08:00', end_at: '2026-11-26T20:00:00+08:00', location: '学活305' };
      return [200, { summary: { updated: 1, cancelled: 0, added: 0, unchanged: 0 }, operations: [{ kind: 'event', action: 'update', target_id: event.id, target_title: event.title,
        changes: { location: { from: event.location, to: '学活305' } } }], impact: { conflicts_before: 1, conflicts_after: 0, free_delta_minutes: 30, work_shifts: [] }, preview_snapshot: preview }];
    },
  };
  const app = await imported(t, { routes, health: { capabilities: [...CAPABILITIES, 'notice_diff_v1'] } });
  const extracts = app.calls.filter(call => call.path === '/api/v3/extract').length;
  app.set('#noticeText', '【紧急变更】讲座地点改为学活305。', 'input');
  app.submit('#noticeForm');
  await settle();
  assert.match(app.find('#importSummary').textContent, /这像是一条变更通知/);
  assert.match(app.find('#importSummary').textContent, /学活305/);
  assert.equal(app.calls.filter(call => call.path === '/api/v3/extract').length, extracts, 'no duplicate import');
  app.find('[data-diff-apply]').click();
  await settle();
  assert.equal(app.stored().events.length, 1);
  assert.equal(app.stored().events[0].location, '学活305');
  assert.match(app.find('#importSummary').textContent, /已采用：改动 1 件/);
});

test('1.26 exact solver: 画卷 offers 多方案对比 on demand and applies a whole plan', async t => {
  const app = await imported(t, { routes: { ...extractRoute(), '/api/v3/solve': async body => {
    const routine = body.snapshot.routines[0];
    const event = body.snapshot.events[0];
    return [200, { algorithm: { nodes_explored: 6, transit_minutes: 10 }, validation: { passed: true }, transit_warnings: [{ reason: '「甲」结束后仅隔 5 分钟就要到「乙」' }],
      pareto_plans: [{ name: '保作息与课表方案', summary: '叠墨清零', metrics: { remaining_conflicts: 0, skipped_routine_occurrences: 0, kept_temporary_events: 0, net_free_minutes: 600 },
        work_blocks: [], actions: [{ action: 'cancel_event', label: `不去「${event.title}」`, params: { event_id: event.id } }] }] }];
  } } });
  app.click('[data-tab="calendar"]');
  await settle();
  // Default calendar opens in full-width solo mode; clicking 解析画卷 opens the left analysis panel.
  assert.ok(app.find('#calendarView .scroll').classList.contains('is-solo'));
  assert.equal(app.find('#calendarView .scroll-side').hidden, true);
  app.find('#calendarView [data-scroll-open]')?.click();
  await settle(1500);
  app.find('#calendarView [data-cal-analyze]').click();
  assert.ok(app.find('#calendarView .scroll').classList.contains('is-analyzed'));
  assert.equal(app.find('#calendarView .scroll-side').hidden, false);
  app.find('#calendarView [data-solve]').click();
  await settle();
  assert.equal(app.calls.filter(call => call.path === '/api/v3/solve').at(-1).body.transit_minutes, 10);
  assert.match(app.find('#calendarView .plans').textContent, /保作息与课表方案/);
  assert.match(app.find('#calendarView .plans').textContent, /仅隔 5 分钟/);
  app.find('#calendarView [data-plan="0"]').click();
  await settle();
  assert.equal(app.stored().events[0].status, 'cancelled');
});

test('1.26 calibration: a capacity question is checked against the personal record and warns about optimism', async t => {
  const history = [{ kind: '写作', estimated_minutes: 30, actual_minutes: 45 }, { kind: '写作', estimated_minutes: 60, actual_minutes: 90 }];
  const app = await boot(t, {
    initial: { 'sixu.calibration': JSON.stringify(history) },
    health: { capabilities: [...CAPABILITIES, 'capacity_calibration_v1'] },
    routes: { '/api/v3/calibrate-capacity': async body => [200, { calibration: { factor: 1.5, sample_count: 2 }, nominal_minutes: body.nominal_minutes, calibrated_minutes: 135, reserve_minutes: body.reserve_minutes,
      nominal_verdict: { fits: true, summary: '排得下' }, calibrated_verdict: { fits: false, summary: '排不下' }, optimism_risk: true }] },
  });
  app.click('#loadDemoWeek');
  await settle();
  app.click('[data-tab="import"]');
  app.set('#noticeText', '这周再接1个半小时社团工作，留半小时休息，时间够吗？', 'input');
  app.submit('#noticeForm');
  await settle(600);
  const call = app.calls.find(item => item.path === '/api/v3/calibrate-capacity');
  assert.ok(call, 'calibration requested');
  assert.deepEqual([call.body.nominal_minutes, call.body.reserve_minutes, call.body.history.length], [90, 30, 2]);
  assert.match(app.find('#importSummary').textContent, /乐观偏差预警/);
});

test('1.26 group scheduling: codes carry only a 0/1 mask, and common slots come back from the service', async t => {
  const app = await boot(t, { routes: {
    '/api/v3/group/export-mask': async body => [200, { free_mask: '0'.repeat(300) + '1'.repeat(36), slots_total: 336, range: body.range }],
    '/api/v3/group/coordinate': async body => [200, { participant_count: body.participants.length, recommended_slots: [{ start: '2099-01-01T10:00:00+08:00', end: '2099-01-01T11:00:00+08:00', available_count: 2, conflict_count: 0 }] }],
  } });
  app.find('#groupExport').click();
  await settle();
  const code = app.find('#groupMine').value;
  assert.match(code, /^SX1\.\d{4}-\d{2}-\d{2}\.\d{4}-\d{2}-\d{2}\.30\.336\.[0-9a-f]+$/);
  assert.doesNotMatch(code, /[一-鿿]/);
  app.set('#groupOthers', code, 'input');
  app.find('#groupFind').click();
  await settle();
  const sent = app.calls.find(call => call.path === '/api/v3/group/coordinate').body;
  assert.equal(sent.participants.length, 2);
  assert.ok(sent.participants.every(item => /^[01]+$/.test(item.free_mask) && item.free_mask.length === 336));
  assert.match(app.find('#groupResult').textContent, /2\/2 人有空/);
});

test('an unreachable service is explained in plain words and the notice stays in the box', async t => {
  const app = await boot(t, { routes: { '/api/v3/extract': async () => { throw new TypeError('Failed to fetch'); } } });
  app.set('#noticeText', API.notice, 'input');
  app.submit('#noticeForm');
  await settle();
  assert.match(app.message(), /连不上计算服务/);
  assert.doesNotMatch(app.message(), /Failed to fetch/);
  assert.equal(app.find('#noticeText').value, API.notice);
});

test('the import reply separates what occupies time from what must be done, and takes an estimate in place', async t => {
  const app = await imported(t);
  const fixed = app.find('#importSummary .turn-group.is-fixed');
  const due = app.find('#importSummary .turn-group.is-due');
  assert.match(fixed.querySelector('h4').textContent, /要到场/);
  assert.equal(fixed.querySelectorAll('.turn-item.is-temporary').length, 1);
  assert.match(fixed.textContent, /占用 \d/);
  assert.match(due.querySelector('h4').textContent, /要完成/);
  assert.equal(due.querySelectorAll('.turn-item.is-deadline').length, 2);
  const task = app.stored().tasks[0];
  const chip = app.find(`#importSummary [data-turn-estimate="${task.id}:30"]`);
  assert.ok(chip, 'estimate chips sit on the deadline row');
  const before = app.calls.filter(call => call.path === '/api/v3/calendar').length;
  chip.click();
  await settle();
  assert.equal(app.stored().tasks.find(entry => entry.id === task.id).estimate_minutes, 30);
  assert.match(app.find('#importSummary').textContent, /预计 30 分钟/);
  assert.match(app.find("#importSummary").textContent, /预计用时可以不填/);
  assert.equal(app.all(`#importSummary [data-turn-estimate^="${task.id}:"]`).length, 0);
  assert.ok(app.calls.filter(call => call.path === '/api/v3/calendar').length > before, 'calendar recomputed');
});

test('the same notice is not imported twice and a failed import keeps the text', async t => {
  const app = await imported(t);
  app.set('#noticeText', API.notice, 'input');
  app.submit('#noticeForm');
  await settle();
  assert.match(app.message(), /已经导入过/);
  assert.equal(app.calls.filter(item => item.path === '/api/v3/extract').length, 1);

  const failing = await boot(t, { routes: extractRoute(400, { error: 'text 必须是非空通知原文' }) });
  failing.set('#noticeText', '一段通知', 'input');
  failing.submit('#noticeForm');
  await settle();
  assert.match(failing.message(), /处理未完成/);
  assert.equal(failing.find('#noticeText').value, '一段通知');
  assert.equal(failing.stored(), null);
});

test('model import is refused before sending when the service has no model', async t => {
  const app = await boot(t, { routes: extractRoute() });
  app.set('#extractionMode', 'model', 'input');
  app.set('#noticeText', API.notice, 'input');
  app.submit('#noticeForm');
  await settle();
  assert.match(app.message(), /没有启用模型提取/);
  assert.equal(app.calls.some(call => call.path === '/api/v3/extract'), false);
});

test('estimate chips, field edits and invalid input on a work card', async t => {
  const app = await imported(t);
  const card = app.all('#taskList [data-item-id]')[0];
  const id = card.dataset.itemId;
  card.querySelector('[data-estimate="60"]').click();
  await settle();
  assert.equal(app.stored().tasks.find(task => task.id === id).estimate_minutes, 60);
  assert.equal(card.querySelector('[data-estimate="60"]').getAttribute('aria-pressed'), 'true');
  assert.equal(card.querySelector('[data-field="estimate_minutes"]').value, '60');

  const priority = card.querySelector('[data-field="priority"]');
  priority.value = '150';
  priority.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.match(card.querySelector('[data-item-error]').textContent, /没有保存/);
  assert.equal(priority.getAttribute('aria-invalid'), 'true');
  assert.equal(app.stored().tasks.find(task => task.id === id).priority, null);

  const deadline = card.querySelector('[data-field="deadline_at"]');
  deadline.value = '2026-11-10T20:00';
  deadline.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle();
  const task = app.stored().tasks.find(item => item.id === id);
  assert.equal(task.deadline_at, '2026-11-10T20:00:00+08:00');
  assert.deepEqual(task.evidence.filter(item => item.field === 'deadline_at').map(item => item.origin), ['user_input']);
});

test('complete, cancel, delete and manual add on the items page', async t => {
  const app = await imported(t);
  const [first, second] = app.all('#taskList [data-item-id]').map(card => card.dataset.itemId);
  app.find(`[data-item-id="${first}"] [data-action="complete"]`).click();
  await settle();
  assert.equal(app.stored().tasks.find(task => task.id === first).status, 'completed');
  assert.match(app.find(`[data-item-id="${first}"]`).textContent, /恢复/);
  app.find(`[data-item-id="${second}"] [data-action="delete"]`).click();
  await settle();
  assert.equal(app.stored().tasks.some(task => task.id === second), false);
  const event = app.find('#eventList [data-item-id]').dataset.itemId;
  app.find(`[data-item-id="${event}"] [data-action="cancel"]`).click();
  await settle();
  assert.equal(app.stored().events[0].status, 'cancelled');
  app.click('#addTask');
  app.click('#addEvent');
  await settle();
  assert.equal(app.stored().tasks.at(-1).title, '新的截止之事');
  assert.equal(app.stored().events.at(-1).title, '新的点墨');
  assert.match(app.find('#eventList').textContent, /时间待定/);
});

test('appointments are added under 落笔 and switching the kind moves the card', async t => {
  const app = await boot(t);
  app.click('#addAppointment');
  await settle();
  const stored = app.stored();
  assert.deepEqual([stored.events[0].kind, stored.events[0].title], ['appointment', '新的约定']);
  const id = stored.events[0].id;
  assert.ok(app.find(`#appointmentList [data-item-id="${id}"]`));
  const select = app.find(`[data-item-id="${id}"] [data-field="kind"]`);
  select.value = 'temporary';
  select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(app.stored().events[0].kind, 'temporary');
  assert.ok(app.find(`#eventList [data-item-id="${id}"]`), 'card moved to 点墨');
  assert.equal(app.find(`#appointmentList [data-item-id="${id}"]`), null);
});

test('the daily window can be filled in one click, edited per day and cleared', async t => {
  const app = await boot(t);
  app.click('#presetWindow');
  await settle();
  assert.deepEqual(app.stored().daily_window[0], { start: '08:00', end: '23:00' });
  assert.deepEqual(app.stored().daily_window[6], { start: '09:00', end: '23:00' });
  app.find('[data-day-on="6"]').checked = false;
  app.set('[data-day-start="0"]', '07:30', 'input');
  app.submit('#windowForm');
  await settle();
  assert.equal(app.stored().daily_window[6], null);
  assert.equal(app.stored().daily_window[0].start, '07:30');
  app.set('[data-day-end="1"]', '06:00', 'input');
  app.submit('#windowForm');
  assert.match(app.find('#windowError').textContent, /晚于/);
  app.click('#clearWindow');
  await settle();
  assert.equal(app.stored().daily_window, null);
});

test('routines are added by hand and the routines-filled switch is saved', async t => {
  const app = await boot(t);
  app.click('#addRoutine');
  app.set('#routineTitle', '社团例会', 'input');
  app.find('#routineWeekdays input[value="2"]').checked = true;
  app.set('#routineStart', '19:00', 'input');
  app.set('#routineEnd', '20:00', 'input');
  app.submit('#routineForm');
  await settle();
  const routine = app.stored().routines[0];
  assert.deepEqual([routine.title, routine.weekdays, routine.start, routine.end, routine.week_interval], ['社团例会', [2], '19:00', '20:00', 1]);
  assert.equal(app.stored().routines_confirmed, true);
  assert.match(app.find('#routineList').textContent, /每周二 19:00–20:00/);
  app.find('#routineList [data-remove]').click();
  await settle();
  assert.equal(app.stored().routines.length, 0);
  assert.match(app.find('#routineList').textContent, /底色可以不铺/);
  app.click('#addRoutine');
  app.set('#routineTitle', '空', 'input');
  app.submit('#routineForm');
  assert.match(app.find('#routineError').textContent, /星期/);
});

test('free time can be added or removed for a period', async t => {
  const app = await boot(t);
  app.click('#addAdjustment');
  app.set('#adjustmentKind', 'remove', 'input');
  app.set('#adjustmentStart', '2026-11-14T13:00', 'input');
  app.set('#adjustmentEnd', '2026-11-14T18:00', 'input');
  app.set('#adjustmentNote', '回家', 'input');
  app.submit('#adjustmentForm');
  await settle();
  assert.deepEqual(app.stored().free_adjustments.map(item => [item.kind, item.start_at, item.note]), [['remove', '2026-11-14T13:00:00+08:00', '回家']]);
  assert.match(app.find('#adjustmentList').textContent, /扣除 · 回家/);
});

test('timetable: needs a configured key, sends parsed period times, previews and imports after review', async t => {
  const posted = [];
  const routes = { '/api/v3/timetable': async body => { posted.push(body); return [200, structuredClone(body.mode === 'convert' ? API.timetable : API.timetable)]; } };
  const missing = await boot(t, { routes });
  missing.set('#timetableText', API.timetable_text, 'input');
  missing.submit('#timetableForm');
  await settle();
  assert.match(missing.message(), /DeepSeek Key/);
  assert.equal(posted.length, 0);

  const app = await boot(t, { routes, health: { timetable_model: { configured: true } } });
  app.set('#timetableText', API.timetable_text, 'input');
  app.set('#termStart', '2026-09-07', 'input');
  app.submit('#timetableForm');
  await settle();
  assert.equal(posted[0].mode, 'model');
  assert.equal(posted[0].term_start, '2026-09-07');
  assert.deepEqual(posted[0].periods['1'], { start: '08:00', end: '08:50' });
  assert.equal(Object.keys(posted[0].periods).length, 12);
  assert.match(app.find('#timetablePreview').textContent, /整理出 2 处底色/);
  assert.equal(app.stored(), null, 'nothing is saved before the user imports');
  app.click('#reconvertTimetable');
  await settle();
  assert.equal(posted[1].mode, 'convert');
  assert.deepEqual(posted[1].courses, API.timetable.courses);
  app.click('#adoptTimetable');
  await settle();
  const stored = app.stored();
  assert.equal(stored.routines.length, 2);
  assert.equal(stored.routines_confirmed, true);
  assert.equal(stored.sources[0].kind, 'timetable');
  assert.match(app.find('#routineList').textContent, /高等数学/);
});

test('timetable notes are not shown as rejected courses; only real rejections are', async t => {
  const answer = { ...structuredClone(API.timetable), warnings: ['「某课」未采用：原文依据不在课表文字中。', '所有课程均未标注周次信息'] };
  const app = await boot(t, { routes: { '/api/v3/timetable': async () => [200, answer] }, health: { timetable_model: { configured: true } } });
  app.set('#timetableText', API.timetable_text, 'input');
  app.submit('#timetableForm');
  await settle();
  const preview = app.find('#timetablePreview').textContent;
  assert.match(preview, /没有采用的部分「某课」未采用/);
  assert.match(preview, /整理时的提醒所有课程均未标注周次信息/);
});

test('timetable screenshot: uploads the image, fills the transcript and offers the period times seen in it', async t => {
  const posted = [];
  const seen = { '1': { start: '08:00', end: '08:45' }, '2': { start: '08:55', end: '09:40' } };
  const answer = { ...structuredClone(API.timetable), mode: 'image', periods_seen: seen,
    source: { ...API.timetable.source, text: '周一 第1-2节 高等数学 @主楼301' } };
  const routes = { '/api/v3/timetable': async body => { posted.push(body); return [200, structuredClone(answer)]; } };
  const app = await boot(t, { routes, health: { capabilities: [...CAPABILITIES, 'timetable_image_v3'], timetable_model: { configured: true } } });
  const picker = app.find('#timetableImage');
  const file = new app.window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'grid.png', { type: 'image/png' });
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(posted[0].mode, 'image');
  assert.match(posted[0].image, /^data:image\/png;base64,/);
  assert.equal(posted[0].text, undefined);
  assert.equal(app.find('#timetableText').value, '周一 第1-2节 高等数学 @主楼301');
  assert.match(app.find('#timetablePreview').textContent, /截图上的节次时间与下面填的不同/);
  app.click('#usePeriodsSeen');
  await settle();
  assert.match(app.find('#periodText').value, /^1 08:00-08:45\n2 08:55-09:40$/);
  assert.equal(posted[1].mode, 'convert');
  assert.equal(posted[1].text, '周一 第1-2节 高等数学 @主楼301');
  assert.deepEqual(posted[1].periods, seen);
});

test('timetable screenshot needs a service that can read images', async t => {
  const app = await boot(t, { health: { timetable_model: { configured: true } } });
  const picker = app.find('#timetableImage');
  Object.defineProperty(picker, 'files', { value: [new app.window.File([new Uint8Array([1])], 'grid.png', { type: 'image/png' })], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle();
  assert.match(app.message(), /1\.15/);
  assert.equal(app.calls.some(call => call.path === '/api/v3/timetable'), false);
});

test('timetable period lines that cannot be read are reported before sending', async t => {
  const app = await boot(t, { health: { timetable_model: { configured: true } } });
  app.set('#timetableText', API.timetable_text, 'input');
  app.set('#periodText', '第一节 早上', 'input');
  app.submit('#timetableForm');
  await settle();
  assert.match(app.message(), /看不懂/);
  assert.equal(app.calls.some(call => call.path === '/api/v3/timetable'), false);
});

test('the calendar marks conflicts on the tab and a click opens the matching item', async t => {
  const snapshot = addImported(createTimeSnapshot({ referenceTime: '2026-11-09T08:00:00+08:00' }), {
    events: [{ id: 'e1', title: '讲座', start_at: '2026-11-09T09:00:00+08:00', end_at: '2026-11-09T11:00:00+08:00', location: null, status: 'active', source_id: null, evidence: [], notes: [] }] });
  const app = await boot(t, { initial: { [TIME_STORAGE_KEY]: serializeTimeSnapshot(snapshot) } });
  assert.equal(app.find('#conflictCount').textContent, '1');
  assert.match(app.find('#eventList').textContent, /叠墨：与他事相撞/);
  const card = app.find('#item-e1');
  app.find('#calendarView [data-cal-item="e1"]').click();
  assert.ok(card.classList.contains('is-flash'));
  const earlier = app.calls.filter(call => call.path === '/api/v3/calendar');
  app.click('#calendarView [data-cal-week="1"]');
  await settle();
  const after = app.calls.filter(call => call.path === '/api/v3/calendar');
  assert.equal(after.length, earlier.length + 1);
  // The shown week starts from today, so check the step rather than a fixed date.
  const shown = Date.parse(`${earlier.at(-1).body.range.from}T00:00:00Z`);
  const next = new Date(shown + 7 * 86400000).toISOString().slice(0, 10);
  assert.equal(after.at(-1).body.range.from, next);
  assert.equal(earlier.at(-1).body.range.from, weekRange(weekStart(Date.now())).from);
});

test('a v2 list in the browser is converted to v3 and the v2 bytes are kept', async t => {
  const v2 = { schema_version: 2, revision: 3, timezone: 'Asia/Shanghai', reference_time: '2026-11-09T08:00:00+08:00', sources: [],
    availability: [], tasks: [{ id: 'a', source_id: null, title: '报告', kind: 'flexible', status: 'confirmed', earliest_start_at: null, deadline_at: '2026-11-10T23:59:00+08:00', fixed_start_at: null, fixed_end_at: null, visit_windows: [], remaining_minutes: 90, splittable: true, min_block_minutes: 30, must_do: true, priority: 60, location: null, materials: [], depends_on: [], confirmed_fields: [], evidence: [], uncertainties: [] }] };
  const raw = JSON.stringify(v2);
  const app = await boot(t, { initial: { [V2_KEY]: raw } });
  assert.match(app.message(), /转换成四层时间格式/);
  assert.equal(app.stored().tasks[0].estimate_minutes, 90);
  assert.equal(app.data.get(V2_KEY), raw);
});

test('another tab saving the list stops this tab from overwriting it', async t => {
  const app = await boot(t);
  const event = new app.window.Event('storage');
  Object.assign(event, { key: TIME_STORAGE_KEY, newValue: '{}' });
  app.window.dispatchEvent(event);
  assert.equal(app.find('#storageConflict').hidden, false);
  const writes = app.writes.length;
  app.click('#presetWindow');
  await settle();
  assert.equal(app.writes.length, writes);
  assert.match(app.find('#saveState').textContent, /尚未保存/);
});

test('the demo week fills every layer for next week and opens on that week', async t => {
  const app = await boot(t);
  app.click('#loadDemoWeek');
  await settle();
  const stored = app.stored();
  assert.equal(stored.routines.length, 3);
  assert.deepEqual([stored.events.length, stored.tasks.length], [2, 2]);
  assert.deepEqual(stored.events.map(event => event.kind), ['appointment', 'temporary']);
  assert.ok(stored.daily_window);
  const request = app.calls.filter(call => call.path === '/api/v3/calendar').at(-1);
  assert.ok(Date.parse(`${request.body.range.from}T00:00:00+08:00`) > Date.now(), 'demo week is in the future');
});

function ocrEngine(result) {
  const jobs = [];
  return { jobs, async createWorker(lang, oem, options) {
    return { async recognize(image) { jobs.push(image); options.logger({ status: 'recognizing text', progress: 1 }); return { data: { text: await result() } }; }, async terminate() {} };
  } };
}
function chooseImage(app, file) {
  const picker = app.find('#noticeImage');
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
}
const screenshot = () => ({ type: 'image/png', size: 2048, name: 'notice.png' });

test('a screenshot is recognised locally into the notice box without any request', async t => {
  const engine = ocrEngine(async () => '报 名 截 止 ： 2026 年 10 月 28 日 15:00');
  const app = await boot(t, { ocrEngine: engine });
  const before = app.calls.length;
  chooseImage(app, screenshot());
  await settle(20);
  assert.equal(app.find('#noticeText').value, '报名截止：2026年10月28日15:00');
  assert.equal(app.calls.length, before);
  assert.equal(app.find('#ocrPreview').hidden, false);
  assert.match(app.find('#ocrStatus').textContent, /对照截图/);
  app.find('#clearOcrPreview').click();
  assert.equal(app.find('#ocrPreview').hidden, true);
  assert.equal(app.find('#ocrAsTimetable').hidden, true);
  assert.equal(app.find('#ocrStatus').textContent, '');
});

test('starting a new thread clears any lingering screenshot preview', async t => {
  const engine = ocrEngine(async () => '2026年11月24日15:00举办主题大课');
  const app = await boot(t, { ocrEngine: engine });
  chooseImage(app, screenshot());
  await settle(20);
  assert.equal(app.find('#ocrPreview').hidden, false);
  app.find('#newThread').click();
  assert.equal(app.find('#ocrPreview').hidden, true);
  assert.equal(app.find('#ocrAsTimetable').hidden, true);
  assert.equal(app.find('#ocrStatus').textContent, '');
});

test('recognised text is appended, failures keep the text and non-images are refused', async t => {
  let attempt = 0;
  const engine = ocrEngine(async () => { attempt += 1; if (attempt === 2) throw new Error('wasm failed'); return '第二段'; });
  const app = await boot(t, { ocrEngine: engine });
  app.set('#noticeText', '第一段', 'input');
  chooseImage(app, screenshot());
  await settle(20);
  assert.equal(app.find('#noticeText').value, '第一段\n\n第二段');
  chooseImage(app, screenshot());
  await settle(20);
  assert.equal(app.find('#noticeText').value, '第一段\n\n第二段');
  assert.match(app.find('#ocrStatus').textContent, /未能识别/);
  chooseImage(app, { type: 'application/pdf', size: 100, name: 'a.pdf' });
  await settle(20);
  assert.equal(engine.jobs.length, 2);
  assert.match(app.find('#ocrStatus').textContent, /图片/);
});

test('a timetable screenshot pasted into the notice box is recognised as a timetable and can be sent to timetable reading', async t => {
  const posted = [];
  const engine = ocrEngine(async () => '第010周(非本周)\n和导三四五六日\n数据结由复变函');
  const routes = { '/api/v3/timetable': async body => { posted.push(body); return [200, structuredClone({ ...API.timetable, mode: 'image', periods_seen: null })]; } };
  const app = await boot(t, { ocrEngine: engine, routes, health: { capabilities: [...CAPABILITIES, 'timetable_image_v3'], timetable_model: { configured: true } } });
  app.set('#noticeText', '原来的通知', 'input');
  const picker = app.find('#noticeImage');
  const file = new app.window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'grid.png', { type: 'image/png' });
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle(20);
  assert.match(app.find('#ocrStatus').textContent, /像是一张课表/);
  const button = app.find('#ocrAsTimetable');
  assert.equal(button.hidden, false);
  button.click();
  await settle();
  assert.equal(app.find('#noticeText').value, '原来的通知', 'the garbled text is taken back out');
  assert.equal(posted[0].mode, 'image');
  assert.match(app.find('#timetablePreview').textContent, /整理出 2 处底色/);
  assert.equal(button.hidden, true);
});

test('an ordinary notice screenshot still offers the timetable route without warning about it', async t => {
  const app = await boot(t, { ocrEngine: ocrEngine(async () => '请于11月10日前提交报告') });
  const picker = app.find('#noticeImage');
  Object.defineProperty(picker, 'files', { value: [screenshot()], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle(20);
  assert.doesNotMatch(app.find('#ocrStatus').textContent, /像是一张课表/);
  assert.equal(app.find('#ocrAsTimetable').hidden, false);
});

test('pasting an image recognises it; pasting text behaves normally', async t => {
  const engine = ocrEngine(async () => '粘 贴 的 通 知');
  const app = await boot(t, { ocrEngine: engine });
  const paste = items => {
    const event = new app.window.Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = { items };
    app.find('#noticeText').dispatchEvent(event);
    return event;
  };
  assert.equal(paste([{ kind: 'string', type: 'text/plain', getAsFile: () => null }]).defaultPrevented, false);
  assert.equal(paste([{ kind: 'file', type: 'image/png', getAsFile: () => screenshot() }]).defaultPrevented, true);
  await settle(20);
  assert.equal(app.find('#noticeText').value, '粘贴的通知');
});

test('the fictional example notice is written so rules extraction can read every time', async t => {
  const posted = [];
  const app = await boot(t, { routes: { '/api/v3/extract': async body => { posted.push(body); return [200, structuredClone(API.extract)]; } } });
  app.click('#fillExample');
  const text = app.find('#noticeText').value;
  assert.match(text, /\d{4}年\d{1,2}月\d{1,2}日15:00前完成讲座报名/);
  assert.match(text, /\d{4}年\d{1,2}月\d{1,2}日18:00-20:00举行/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}\d{2}:/);
});

test('铺纸 shows two rolled cards; one unrolls at a time and 返回 rolls it up while 笔墨 stays docked on 研墨', async t => {
  const app = await boot(t);
  const group = app.find('[data-roll="routine"]').closest('[data-rolls]');
  assert.match(app.find('#rollSummary-routine').textContent, /没有底色也能算/);
  assert.match(app.find('#rollSummary-free').textContent, /作息未设定/);
  assert.ok(app.find('#inkPool'));
  app.click('[data-roll-open="routine"]');
  assert.equal(group.dataset.open, 'routine');
  assert.ok(app.find('[data-roll="routine"]').classList.contains('is-open'));
  assert.equal(app.find('[data-roll-open="routine"]').getAttribute('aria-expanded'), 'true');
  app.click('[data-roll="routine"] [data-roll-close]');
  assert.equal(group.dataset.open, undefined);
});

test('messages float and fade on their own; a click dismisses them', async t => {
  const app = await boot(t);
  app.click('#fillExample');
  app.find('#appMessage').hidden = false;
  app.find('#appMessage').textContent = '提示';
  app.click('#appMessage');
  assert.equal(app.find('#appMessage').hidden, true);
  assert.ok(app.find('#appMessage').classList.contains('toast'));
});

test('after import, 点墨 with only a start are asked 大约几点结束 with a suggested time, saved on one click', async t => {
  const extract = structuredClone(API.extract);
  extract.events = [{ ...extract.events[0], id: 'e-open', title: '学术讲座', end_at: null, evidence: [] }];
  const estimates = [];
  const routes = {
    '/api/v3/extract': async () => [200, structuredClone(extract)],
    '/api/v3/estimate-end': async body => { estimates.push(body); return [200, { estimates: [{ id: 'e-open', minutes: 90, end_at: '2026-11-10T19:30:00+08:00', basis: body.mode, reason: '按常见讲座时长估计约1小时30分钟。' }] }]; },
  };
  const app = await boot(t, { routes, health: { capabilities: [...CAPABILITIES, 'end_estimate_v1'], timetable_model: { configured: true } } });
  app.set('#noticeText', API.notice, 'input');
  app.submit('#noticeForm');
  await settle();
  assert.match(app.find('#importSummary').textContent, /大约几点结束/);
  assert.equal(estimates[0].mode, 'rules');
  assert.equal(estimates[0].items[0].start_at, '2026-11-10T18:00:00+08:00');
  assert.match(estimates[0].items[0].context, /讲座/);
  assert.equal(app.find('[data-end-for="e-open"] [data-end-input]').value, '19:30');
  assert.equal(app.find('[data-end-model]').hidden, false);
  app.find('[data-end-for="e-open"] [data-end-input]').value = '20:00';
  app.click('[data-end-for="e-open"] [data-end-save]');
  await settle();
  assert.equal(app.stored().events.find(event => event.id === 'e-open').end_at, '2026-11-10T20:00:00+08:00');
  assert.match(app.find('[data-end-for="e-open"]').textContent, /已补上：20:00 结束/);
});

test('page styles never show one page on another: only the current page is displayed', () => {
  const css = readFileSync(new URL('../agent.css', import.meta.url), 'utf8');
  // A bare .page-* rule must not set display, or that page appears under every tab.
  for (const rule of css.match(/^\.page-(?:import|calendar|items|time)\s*\{[^}]*\}/gm) || []) assert.doesNotMatch(rule, /display\s*:/, rule);
});


test('on the public site a model call asks for the access code once, keeps it and sends it', async t => {
  let seen = 0;
  const routes = { '/api/v3/extract': async (body, headers) => {
    seen += 1;
    if (headers['X-Sixu-Access'] !== 'ink-and-paper') return [401, { error: '使用模型功能需要访问口令。', code: 'access_code_required' }];
    return [200, structuredClone(API.extract)];
  } };
  const app = await boot(t, { routes, health: { model_extraction: { configured: true } } });
  app.set('#noticeText', API.notice, 'input');
  app.set('#extractionMode', 'model', 'input');
  app.submit('#noticeForm');
  await settle();
  assert.equal(app.find('#accessAsk').hidden, false, 'the code is asked for');
  app.set('#accessCode', 'ink-and-paper', 'input');
  app.submit('#accessForm');
  await settle();
  assert.equal(app.find('#accessAsk').hidden, true);
  assert.equal(seen, 2, 'the call is retried once with the code');
  assert.equal(app.data.get('sixu.model-access'), 'ink-and-paper');
  assert.equal(app.stored().events.length + app.stored().tasks.length > 0, true, 'the notice was imported');
  const calendarCalls = app.calls.filter(call => call.path === '/api/v3/calendar');
  assert.ok(calendarCalls.every(call => !call.headers['X-Sixu-Access']), 'the code goes only with model calls');
});

test('cancelling the access code leaves the notice in the box and calls no model', async t => {
  const routes = { '/api/v3/extract': async () => [401, { error: '使用模型功能需要访问口令。', code: 'access_code_required' }] };
  const app = await boot(t, { routes, health: { model_extraction: { configured: true } } });
  app.set('#noticeText', API.notice, 'input');
  app.set('#extractionMode', 'model', 'input');
  app.submit('#noticeForm');
  await settle();
  app.click('#accessCancel');
  await settle();
  assert.match(app.message(), /没有输入访问口令/);
  assert.equal(app.find('#noticeText').value, API.notice);
});

test('a saved 教务网页 fills the timetable, period times and first Monday, then previews without a model', async t => {
  const posted = [];
  const routes = { '/api/v3/timetable': async body => { posted.push(body); return [200, { ...structuredClone(API.timetable), mode: 'convert' }]; } };
  const app = await boot(t, { routes });
  const html = readFileSync(new URL('./fixtures/jw-timetable.html', import.meta.url), 'utf8');
  const file = new app.window.File([html], '我的课表.html', { type: 'text/html', lastModified: Date.parse('2026-11-07T10:00:00+08:00') });
  const picker = app.find('#jwPage');
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].mode, 'convert', 'only the convert step, no model');
  assert.equal(posted[0].term_start, '2026-09-07');
  assert.deepEqual(posted[0].periods['1'], { start: '08:00', end: '08:50' });
  assert.equal(posted[0].courses.length, 4);
  assert.match(app.find('#timetableText').value, /^高等数学A 1-16周,星期1,08:00-09:50,主楼301/);
  assert.match(app.message(), /读出 4 种上课安排.*第9周.*2026-09-07.*1 个格子没读懂/);
});

test('a page that is not a timetable is refused with a hint', async t => {
  const app = await boot(t);
  const file = new app.window.File(['<p>请登录</p>'], 'login.html', { type: 'text/html' });
  const picker = app.find('#jwPage');
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle();
  assert.match(app.message(), /没有找到课表格子/);
});

test('画卷 opens full-width by default, toggles 解析画卷, and scopes conflicts strictly to the shown week', async t => {
  // Backend returns a conflict ONLY in next week (never in this week)
  const nextMon = weekRange(weekStart(Date.now()) + 7 * 86400000).from;
  const routes = {
    '/api/v3/calendar': async body => {
      const answer = structuredClone(CALENDAR);
      answer.revision = body.snapshot.revision;
      answer.range = body.range;
      answer.conflicts.forEach(c => {
        c.start = `${nextMon}T14:30:00+08:00`;
        c.end = `${nextMon}T15:00:00+08:00`;
      });
      return [200, answer];
    },
  };
  const app = await boot(t, { routes });
  // On current week, next week's conflict must NOT show on the tab badge or analysis panel
  assert.equal(app.find('#conflictCount').textContent, '');
  assert.ok(app.find('#calendarView .scroll').classList.contains('is-solo'));
  assert.equal(app.find('#calendarView .scroll-side').hidden, true);
  app.find('#calendarView [data-cal-analyze]').click();
  assert.equal(app.find('#calendarView .scroll-side').hidden, false);
  assert.match(app.find('#calendarView .scroll-side').textContent, /这一卷是干净的/);
  // Step to next week: now the conflict appears cleanly for next week
  app.click('#calendarView [data-cal-week="1"]');
  await settle();
  assert.equal(app.find('#conflictCount').textContent, '1');
  assert.match(app.find('#calendarView .scroll-side').textContent, /点墨压在底色上/);
  // Toggle close returns to full-width solo mode
  app.find('#calendarView [data-cal-analyze]').click();
  assert.equal(app.find('#calendarView .scroll-side').hidden, true);
});

test('submitting a notice clears hidden #noticeDate so subsequent relative reminders use real today', async t => {
  const seenDates = [];
  const routes = {
    '/api/v3/extract': async body => {
      seenDates.push(body.reference_date);
      return [200, {
        source: { id: `src-${seenDates.length}`, kind: 'notice', text: body.text, published_at: null },
        events: [],
        tasks: [{
          id: `t-${seenDates.length}`, title: '健身',
          earliest_start_at: '2026-11-21T00:00:00+08:00',
          deadline_at: '2026-11-21T23:59:00+08:00',
          estimate_minutes: null, splittable: true, min_block_minutes: null,
          priority: null, status: 'active', location: null, materials: [],
          source_id: `src-${seenDates.length}`, evidence: [], notes: ['个人任务'],
        }],
        warnings: [],
      }];
    },
  };
  const app = await boot(t, { routes });
  app.click('#loadPhotoCase');
  assert.ok(app.find('#noticeDate').value, 'photo case pre-fills #noticeDate for its notice');
  app.submit('#noticeForm');
  await settle();
  assert.equal(app.find('#noticeDate').value, '', 'hidden #noticeDate must reset after submission');
  app.find('#noticeText').value = '提醒我今天健身';
  app.submit('#noticeForm');
  await settle();
  assert.equal(seenDates[1], null, 'next message must not inherit stale future noticeDate');
});

test('1.31 several activities in one question go to the planner, and a fitting plan can be written in as appointments', async t => {
  const plan = { tool: 'plan_activities', scope: { type: 'weekend', label: '本周末', from: '2099-01-03T00:00:00+08:00', to: '2099-01-05T00:00:00+08:00' },
    feasible: true, available_minutes: 900, leftover_minutes: 480, longest_free_minutes: 300, reserve_rest_minutes: 0, warnings: [], tradeoffs: [],
    placements: [
      { index: 0, title: '出去玩', status: 'placed', blocks: [{ start: '2099-01-03T09:00:00+08:00', end: '2099-01-03T13:00:00+08:00', minutes: 240, label: '1月3日 周六 09:00–13:00' }] },
      { index: 1, title: '写作业', status: 'placed', blocks: [{ start: '2099-01-03T14:00:00+08:00', end: '2099-01-03T17:00:00+08:00', minutes: 180, label: '1月3日 周六 14:00–17:00' }] },
    ], summary: '本周末排得开：2 项活动共需 7 小时，全部可放入。' };
  const app = await boot(t, {
    health: { capabilities: [...CAPABILITIES, 'capacity_plan_v1'] },
    routes: { '/api/v3/capacity/plan': async () => [200, plan] },
  });
  app.click('#loadDemoWeek');
  await settle();
  app.click('[data-tab="import"]');
  app.set('#noticeText', '这周末出去玩半天、写3小时作业，排得开吗', 'input');
  app.submit('#noticeForm');
  await settle(600);
  const call = app.calls.find(item => item.path === '/api/v3/capacity/plan');
  assert.ok(call, 'planner requested');
  assert.equal(call.body.scope, 'weekend');
  assert.deepEqual(call.body.activities.map(item => [item.title, item.minutes, item.category]), [['出去玩', 240, 'leisure'], ['写作业', 180, 'study']]);
  assert.match(app.find('#inkThread').textContent, /本周末排得开/);
  assert.match(app.find('#inkThread').textContent, /1月3日 周六 09:00–13:00/);
  const before = app.stored().events.length;
  app.click('[data-plan-adopt]');
  await settle();
  const added = app.stored().events.slice(before);
  assert.deepEqual(added.map(event => [event.kind, event.title, event.start_at]), [['appointment', '出去玩', '2099-01-03T09:00:00+08:00'], ['appointment', '写作业', '2099-01-03T14:00:00+08:00']]);
});

test('专注时段 follow-up: "常在下午专注" answers the weekend question and is never imported as a task', async t => {
  const app = await boot(t);
  const say = async text => { app.set('#noticeText', text, 'input'); app.submit('#noticeForm'); await settle(300); };
  await say('我需要在周末专注');
  assert.match(app.find('#inkThread').textContent, /周末常在几点到几点最能专注/);
  await say('常在下午专注');
  assert.equal(app.calls.filter(call => call.path === '/api/v3/extract').length, 0, 'the answer is not sent to /api/v3/extract');
  assert.equal(app.stored()?.tasks?.length ?? 0, 0, 'no task named 常在下午专注');
  const focus = JSON.parse(app.data.get('sixu.focus.v1'));
  assert.deepEqual(focus.windows.map(w => [w.id, w.start, w.end]), [['w-weekend', '14:00', '18:00']]);
  assert.match(app.find('#inkThread').textContent, /先按下午 14:00–18:00 记下，可以在铺纸/);
  await say('我需要在周末的全天专注');
  assert.deepEqual(JSON.parse(app.data.get('sixu.focus.v1')).windows.map(w => [w.id, w.start, w.end]), [['w-weekend', '09:00', '22:00']]);
});

test('chat proposal card and one-click model escalation commit only after user confirmation', async t => {
  const app = await boot(t, {
    health: { capabilities: [...CAPABILITIES, 'agenda_chat_v1', 'agenda_chat_tools_v1', 'agenda_chat_proposals_v1'], timetable_model: { configured: true } },
    routes: {
      '/api/v3/chat': async body => {
        const preview = structuredClone(body.snapshot);
        preview.revision = (preview.revision || 0) + 1;
        preview.tasks.push({
          id: 't-prop-1', title: '大创结题PPT', deadline_at: '2099-01-05T15:00:00+08:00',
          estimate_minutes: 180, splittable: true, min_block_minutes: null, earliest_start_at: null,
          priority: null, status: 'active', location: null, materials: [], source_id: null, evidence: [], notes: ['草案'],
        });
        return [200, {
          reply: '已整理好草案，点下方按钮确认即可记入清单。',
          proposal: {
            tool: 'propose_items', kind: 'add_items',
            items: [{ kind: 'task', title: '大创结题PPT', deadline_at: '2099-01-05T15:00:00+08:00', estimate_minutes: 180 }],
            preview_snapshot: preview, impact: { conflicts_before: 0, conflicts_after: 0, free_delta_minutes: -180 },
          },
        }];
      },
    },
  });
  // Step 1: default mode hits dead-end on vague sentence -> offers one-click escalation without calling model
  app.set('#noticeText', '我最近觉得大创结题PPT压力好大，不知道怎么排呢', 'input');
  app.submit('#noticeForm');
  await settle(200);
  assert.equal(app.calls.filter(c => c.path === '/api/v3/chat').length, 0);
  assert.ok(app.find('[data-escalate-chat]'), 'one-click model escalation button is shown');
  // Step 2: clicking escalation sends exact text to /api/v3/chat and shows proposal card WITHOUT mutating snapshot yet
  app.click('[data-escalate-chat]');
  await settle(300);
  assert.equal(app.calls.filter(c => c.path === '/api/v3/chat').length, 1);
  assert.equal(app.stored()?.tasks?.length ?? 0, 0, 'proposal must not silently mutate snapshot');
  assert.ok(app.find('[data-proposal-adopt]'), 'proposal confirmation button rendered');
  // Step 3: clicking confirm commits the validated preview snapshot
  app.click('[data-proposal-adopt]');
  await settle(100);
  assert.equal(app.stored().tasks.some(task => task.title === '大创结题PPT'), true);
});

test('user can switch a proposed item layer inline (点墨/约定/截止/个人任务/临时打断) before confirming', async t => {
  const replans = [];
  const app = await boot(t, {
    health: { capabilities: [...CAPABILITIES, 'agenda_chat_v1', 'agenda_chat_tools_v1', 'agenda_chat_proposals_v1', 'replan_loop_v1'], timetable_model: { configured: true } },
    routes: {
      '/api/v3/chat': async body => {
        const preview = structuredClone(body.snapshot);
        preview.revision = (preview.revision || 0) + 1;
        return [200, {
          reply: '已整理好草案，归类不对可直接切换。',
          proposal: {
            tool: 'propose_items', kind: 'add_items',
            items: [
              { kind: 'task', layer: 'deadline', title: '复习高数', deadline_at: '2099-01-05T23:59:00+08:00', estimate_minutes: 60 },
              { kind: 'event', layer: 'appointment', title: '系里临时开会', start_at: '2099-01-05T15:00:00+08:00', end_at: '2099-01-05T16:30:00+08:00' },
            ],
            preview_snapshot: preview, impact: null,
          },
        }];
      },
      '/api/v3/replan/preview': async body => {
        replans.push(body);
        return [200, { status: 'clear', applied: true, decision_reason: '无冲突', candidate_plans: [], missing_windows: [] }];
      },
    },
  });
  app.set('#extractionMode', 'chat', 'change');
  app.set('#noticeText', '周五复习高数，下午三点系里临时开会', 'input');
  app.submit('#noticeForm');
  await settle(300);
  // Switch item 0 (deadline -> personal) and item 1 (appointment -> disruption)
  app.click('[data-prop-kind$=":0:personal"]');
  app.click('[data-prop-kind$=":1:disruption"]');
  assert.match(app.find('[data-proposal-adopt]').textContent, /确认记入并重算/);
  app.click('[data-proposal-adopt]');
  await settle(300);
  const savedTask = app.stored().tasks.find(task => task.title === '复习高数');
  assert.ok(savedTask, 'personal task saved');
  assert.ok(savedTask.notes.includes('个人任务'), 'marked as 个人任务 after inline toggle');
  assert.equal(replans.length, 1, 'switched disruption item triggered deterministic replan preview');
  assert.equal(replans[0].disruptions[0].title, '系里临时开会');
});

test('adopting a start-only event or unestimated task from chat proposal offers optional end-time and duration pickers', async t => {
  const app = await boot(t, {
    health: { capabilities: [...CAPABILITIES, 'agenda_chat_v1', 'agenda_chat_tools_v1', 'agenda_chat_proposals_v1', 'end_estimate_v1'], timetable_model: { configured: true } },
    routes: {
      '/api/v3/chat': async body => {
        const preview = structuredClone(body.snapshot);
        preview.revision = (preview.revision || 0) + 1;
        preview.events.push({
          id: 'e-open-chat', kind: 'temporary', title: '主题大课', start_at: '2099-01-05T15:00:00+08:00', end_at: null,
          location: '中传礼堂', status: 'active', source_id: null, evidence: [], notes: ['草案'],
        });
        preview.tasks.push({
          id: 't-unest-chat', title: '整理笔记', deadline_at: '2099-01-05T23:59:00+08:00', estimate_minutes: null,
          splittable: true, min_block_minutes: null, earliest_start_at: '2099-01-05T00:00:00+08:00',
          priority: null, status: 'active', location: null, materials: [], source_id: null, evidence: [], notes: ['个人任务'],
        });
        return [200, {
          reply: '已整理好草案。',
          proposal: {
            tool: 'propose_items', kind: 'add_items',
            items: [
              { kind: 'event', layer: 'temporary', title: '主题大课', start_at: '2099-01-05T15:00:00+08:00', end_at: null, location: '中传礼堂' },
              { kind: 'task', layer: 'personal', title: '整理笔记', deadline_at: '2099-01-05T23:59:00+08:00', estimate_minutes: null },
            ],
            preview_snapshot: preview, impact: null,
          },
        }];
      },
      '/api/v3/estimate-end': async () => [200, { estimates: [{ id: 'e-open-chat', minutes: 90, end_at: '2099-01-05T16:30:00+08:00', basis: 'rules', reason: '按常见讲座时长估计约1小时30分钟。' }] }],
    },
  });
  app.set('#extractionMode', 'chat', 'change');
  app.set('#noticeText', '周五三点中传礼堂大课，顺便整理笔记', 'input');
  app.submit('#noticeForm');
  await settle(300);
  app.click('[data-proposal-adopt]');
  await settle(300);
  // Both optional pickers appear right after adopting
  assert.match(app.find('#importSummary').textContent, /大约几点结束/);
  assert.ok(app.find('[data-turn-estimate="t-unest-chat:30"]'), 'optional 30-min preset shown for unestimated task');
  // Clicking optional preset & end-save updates snapshot cleanly
  app.click('[data-turn-estimate="t-unest-chat:30"]');
  app.click('[data-end-save]');
  await settle(100);
  assert.equal(app.stored().tasks.find(tk => tk.id === 't-unest-chat').estimate_minutes, 30);
  assert.equal(app.stored().events.find(ev => ev.id === 'e-open-chat').end_at, '2099-01-05T16:30:00+08:00');
});

test('a complex weekly poster screenshot can be sent to multimodal vision extraction and imported into the calendar', async t => {
  const posted = [];
  const engine = ocrEngine(async () => '14:00-17:00 乱码');
  const app = await boot(t, {
    ocrEngine: engine,
    health: { capabilities: [...CAPABILITIES, 'notice_image_v1', 'end_estimate_v1'], timetable_model: { configured: true } },
    routes: {
      '/api/v3/extract': async body => {
        posted.push(body);
        return [200, {
          source: { id: 's-poster', kind: 'pasted_notice', text: '【信息化实践与服务社】\nWED 11.25 14:00-17:00 智伴校园长者', published_at: null },
          events: [{ id: 'e-p1', kind: 'temporary', title: '智伴校园长者 · 共享信息服务', start_at: '2026-11-25T14:00:00+08:00', end_at: '2026-11-25T17:00:00+08:00', location: '艺术与传播大楼一层校园生活服务大厅', status: 'active', source_id: 's-poster', evidence: [], notes: [] }],
          tasks: [{ id: 't-p1', title: 'AI万象比赛报名截止', deadline_at: '2026-11-28T23:59:00+08:00', estimate_minutes: null, splittable: true, min_block_minutes: null, earliest_start_at: null, priority: null, status: 'active', location: null, materials: [], source_id: 's-poster', evidence: [], notes: [] }],
          warnings: ['以下事项由大模型直接识图整理，请对照原图核对日期、时刻与地点。'],
          mode: 'image',
        }];
      },
    },
  });
  const picker = app.find('#noticeImage');
  const file = new app.window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'poster.png', { type: 'image/png' });
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle(40);
  assert.equal(app.find('#ocrAsVision').hidden, false);
  app.click('#ocrAsVision');
  await settle(300);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].mode, 'image');
  assert.match(posted[0].image, /^data:image\/png;base64,/);
  assert.equal(app.stored().events.some(ev => ev.title === '智伴校园长者 · 共享信息服务'), true);
  assert.equal(app.stored().tasks.some(tk => tk.title === 'AI万象比赛报名截止'), true);
  assert.equal(app.find('#ocrPreview').hidden, true);
});

test('encrypted recovery code seals in-browser snapshot, survives clear, and restores cleanly', async t => {
  const app = await imported(t);
  app.set('#vaultPassphrase', 'sixu-test-key', 'input');
  app.click('#makeVaultCode');
  await settle(250);
  const code = app.find('#vaultCodeBox').value;
  assert.ok(code.startsWith('SXV1.'), 'vault recovery code generated');
  const beforeCount = app.stored().tasks.length + app.stored().events.length;
  assert.ok(beforeCount >= 2);

  app.click('#clearSnapshot');
  await settle(100);
  assert.equal(app.stored().tasks.length + app.stored().events.length, 0);

  app.set('#vaultPassphrase', 'sixu-test-key', 'input');
  app.set('#vaultCodeBox', code, 'input');
  app.click('#restoreVaultCode');
  await settle(250);
  assert.equal(app.stored().tasks.length + app.stored().events.length, beforeCount);
  assert.match(app.find('#vaultStatus').textContent, /已从加密恢复码还原/);
});

test('book-flip 画卷 (工笔 ↔ 写意), once-per-day cover, vertical 远山志, unified 定日/笔墨 & per-day ledger work end-to-end', async t => {
  const app = await imported(t);
  app.window.location.hash = '#/calendar';
  await settle(200);
  // Desktop starts rolled on 工笔 本周山水 cover on first entry of the day
  assert.ok(app.find('.scroll.is-rolled'), 'starts rolled on 工笔 cover');
  assert.match(app.find('#coverHeading').textContent, /峰高是忙/);
  assert.equal(app.window.SixuCalendarFlip.arrows().next.label, '写意 · 四时');

  // Flipping via book-flip hook / folio tab switches to 写意's own 四时烟水 cover
  assert.equal(app.window.SixuCalendarFlip.step(1), true);
  await settle(80);
  assert.ok(app.find('.scroll.is-rolled.is-xieyi'), 'xieyi keeps its own rolled cover');
  assert.ok(app.find('.shanshui-xieyi'), 'xieyi renders distinct bamboo-skiff painting');
  assert.match(app.find('#coverHeading').textContent, /竹影随心/);
  assert.equal(app.window.SixuCalendarFlip.arrows().next, null, 'no page after 写意');
  assert.equal(app.window.SixuCalendarFlip.arrows().prev.label, '工笔 · 时轴');

  // Unrolling xieyi opens .xy-layout with vertical .xy-colophon + .xy-grid and records seenDay
  app.click('[data-scroll-open]');
  await settle(80);
  assert.ok(app.find('.xy-layout .xy-colophon'), 'vertical 远山志 colophon rendered');
  assert.ok(app.find('.xy-layout .xy-grid'), 'xieyi grid rendered');
  assert.ok(app.window.localStorage.getItem('sixu.cover.seenDay'), 'saved once-per-day cover marker');
  assert.doesNotMatch(app.find('.xy-layout').textContent, /未定作息/);

  // Leaving and returning to 画卷 same day enters body directly without forcing cover
  app.window.document.dispatchEvent(new app.window.CustomEvent('sixu:route', { detail: 'import' }));
  await settle(40);
  app.window.document.dispatchEvent(new app.window.CustomEvent('sixu:route', { detail: 'calendar' }));
  await settle(80);
  assert.equal(app.find('.scroll.is-rolled'), null, 'same-day revisit enters scroll directly');

  // Reviewing the cover manually via ⋯ menu works anytime
  app.click('[data-scroll-roll]');
  await settle(60);
  assert.ok(app.find('.scroll.is-rolled.is-xieyi'), 'manual 查看本周封面 rolls back into cover');
  app.click('[data-scroll-open]');
  await settle(60);

  // Add 周志 goal in vertical .xy-colophon
  const goalForm = app.find('[data-xy-goal-form]');
  goalForm.querySelector('input[name="title"]').value = '完成本周文献精读';
  goalForm.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  assert.match(app.find('.xy-colophon').textContent, /完成本周文献精读/);

  // Add a unified 定日 item in 写意 — immediately creates a unified task in snapshot & #inkPool
  const beforeTasks = app.stored().tasks.length;
  const firstAddForm = app.find('[data-xy-add-form]');
  firstAddForm.querySelector('input[name="title"]').value = '整理相机标定公式';
  firstAddForm.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(100);
  assert.equal(app.stored().tasks.length, beforeTasks + 1);
  const created = app.stored().tasks.at(-1);
  assert.equal(created.title, '整理相机标定公式');
  assert.equal(app.find(`#item-${created.id}`).dataset.tier, 'day');

  // Inline duration upgrade fills estimate_minutes on the SAME task (no duplicate created)
  app.click(`[data-xy-upgrade="${created.id}:30"]`);
  await settle(100);
  assert.equal(app.stored().tasks.length, beforeTasks + 1);
  assert.equal(app.stored().tasks.find(item => item.id === created.id).estimate_minutes, 30);

  // Open per-day ledger strip inside 写意 and log study + leisure sessions
  app.click('[data-xy-day-log-toggle]');
  await settle(60);
  const logForm = app.find('.xy-day-log-form');
  assert.ok(logForm, 'per-day inline ledger form opened');
  logForm.querySelector('select[name="kind"]').value = 'study';
  logForm.querySelector('input[name="title"]').value = '三维视觉阅读';
  logForm.querySelector('input[name="minutes"]').value = '45';
  logForm.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  const logForm2 = app.find('.xy-day-log-form');
  logForm2.querySelector('select[name="kind"]').value = 'leisure';
  logForm2.querySelector('input[name="title"]').value = '操场慢跑';
  logForm2.querySelector('input[name="minutes"]').value = '30';
  logForm2.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(60);
  assert.match(app.find('.cal-folio-ledger').textContent, /砚耕 45分 · 闲暇 30分/);

  // Companion modal also toggles 本周学休账卷 drawer
  app.click('#openCompanion');
  await settle(60);
  app.click('[data-cmp-ledger-toggle]');
  await settle(60);
  assert.match(app.find('.cmp-ledger-drawer').textContent, /三维视觉阅读/);
  app.click('[data-cmp-close]');
  await settle(40);

  // Vault bundle preserves both snapshot and xieyi state
  app.set('#vaultPassphrase', 'bundle-2026', 'input');
  app.click('#makeVaultCode');
  await settle(200);
  const code = app.find('#vaultCodeBox').value;
  assert.ok(code.startsWith('SXV1.'));

  app.click('#clearSnapshot');
  await settle(100);
  app.set('#vaultPassphrase', 'bundle-2026', 'input');
  app.set('#vaultCodeBox', code, 'input');
  app.click('#restoreVaultCode');
  await settle(250);
  assert.match(app.find('.xy-colophon').textContent, /完成本周文献精读/);
  assert.match(app.find('.cal-folio-ledger').textContent, /砚耕 45分 · 闲暇 30分/);
});

test('study companion modal opens with gap advice, switches 3 West Lake phases (昼/暮/夜), finishes incense, and updates folio brief', async t => {
  const app = await imported(t);
  app.click('#openCompanion');
  await settle(60);
  const stage = app.find('#companionStage');
  assert.equal(stage.hidden, false);
  assert.match(stage.textContent, /依隙定香/);

  app.click('[data-cmp-scene="dusk"]');
  assert.equal(app.find('.cmp-card').style.getPropertyValue('--dusk'), '1');
  app.click('[data-cmp-scene="night"]');
  assert.ok(app.find('.cmp-card.is-night'), 'switched cleanly to night scene');

  app.click('[data-cmp-toggle]');
  await settle(1100);
  app.click('[data-cmp-finish]');
  await settle(80);
  assert.match(app.find('.cmp-settlement').textContent, /已收入学休账卷/);

  app.click('[data-cmp-close]');
  assert.equal(stage.hidden, true);
  assert.match(app.find('.cal-folio-ledger').textContent, /本周 砚耕 1分/);
});
