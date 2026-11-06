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
import { TIME_STORAGE_KEY, createTimeSnapshot, addImported, serializeTimeSnapshot } from '../time-state.js';

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
  return { ...structuredClone(CALENDAR), revision: body.snapshot.revision, range: body.range, tasks };
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
    calls.push({ path, body });
    let status = 200;
    let payload;
    if (path === '/api/health') payload = { version: '1.13', capabilities: CAPABILITIES, model_extraction: { configured: false }, timetable_model: { configured: false }, ...health };
    else if (routes[path]) [status, payload] = await routes[path](body);
    else if (path === '/api/v3/calendar') payload = calendarAnswer(body);
    else throw new Error(`Unexpected request: ${path}`);
    return { ok: status < 300, status, async text() { return JSON.stringify(payload); } };
  };
  const globals = { window, document: window.document, location: window.location, navigator: window.navigator, fetch };
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
  assert.match(app.find('#windowState').textContent, /未定义/);
  const request = app.calls.find(call => call.path === '/api/v3/calendar');
  assert.ok(request, 'calendar requested on load');
  assert.equal(request.body.snapshot.schema_version, 3);
  assert.match(request.body.range.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(app.find('#calendarView').textContent, /冲突/);
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
  assert.match(app.find('#importSummary').textContent, /已加入 1 个临时占用、2 件工作/);
  assert.match(app.find('#importSummary').textContent, /2 件工作的预计用时还未定义/);
  assert.equal(app.find('#noticeText').value, '');
  assert.equal(app.all('#eventList [data-item-id]').length, 1);
  assert.equal(app.all('#taskList [data-item-id]').length, 2);
  assert.equal(app.find('#itemsCount').textContent, '2');
  const last = app.calls.filter(item => item.path === '/api/v3/calendar').at(-1);
  assert.equal(last.body.snapshot.revision, stored.revision, 'calendar recomputed for the new list');
  assert.match(app.find('#taskList').textContent, /预计用时未定义/);
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
  assert.match(failing.message(), /导入未完成/);
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
  assert.equal(app.stored().tasks.at(-1).title, '新的工作');
  assert.equal(app.stored().events.at(-1).title, '新的临时占用');
  assert.match(app.find('#eventList').textContent, /时间待定/);
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
  app.find('#routinesConfirmed').checked = false;
  app.find('#routinesConfirmed').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(app.stored().routines_confirmed, false);
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
  assert.deepEqual(posted[0].periods['1'], { start: '08:00', end: '08:45' });
  assert.equal(Object.keys(posted[0].periods).length, 12);
  assert.match(app.find('#timetablePreview').textContent, /整理出 2 条例行占用/);
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
  const seen = { '1': { start: '08:00', end: '08:50' }, '2': { start: '09:00', end: '09:50' } };
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
  assert.match(app.find('#periodText').value, /^1 08:00-08:50\n2 09:00-09:50$/);
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
  assert.match(app.find('#eventList').textContent, /与其他占用冲突/);
  const card = app.find('#item-e1');
  app.find('#calendarView [data-cal-item="e1"]').click();
  assert.ok(card.classList.contains('is-flash'));
  const before = app.calls.filter(call => call.path === '/api/v3/calendar').length;
  app.click('#calendarView [data-cal-week="1"]');
  await settle();
  const after = app.calls.filter(call => call.path === '/api/v3/calendar');
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).body.range.from, '2026-11-16');
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
  assert.deepEqual([stored.events.length, stored.tasks.length], [1, 2]);
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
