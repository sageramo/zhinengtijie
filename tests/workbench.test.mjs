/**
 * Pure Node DOM unit tests: no browser, layout engine, screenshots, HTTP server,
 * or live network. fetch and Web Locks are in-memory fakes. These checks do not
 * claim visual, keyboard, or real-browser compatibility verification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { STORAGE_KEY, createSnapshot, createTask, addSource, addTask, serializeSnapshot } from '../task-state.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const BASE = 'https://sixu-api.invalid';
let instance = 0;
const flush = async () => { for (let turn = 0; turn < 6; turn += 1) await setImmediate(); };
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function calculated(body, { required = 180, available = 9, warning = '' } = {}) {
  const task = body.tasks[0];
  return {
    schema_version: 2, revision: body.revision,
    status: required > available ? 'conflicts_detected' : 'no_conflict_detected',
    conflicts: required > available ? [{ conflict_type: 'capacity_shortage', tasks: [task.title], reason: '累计工作量超过实际可用时间。' }] : [],
    capacity_checks: [{ deadline: task.deadline_at, known_required_minutes: required, available_minutes: available, unknown_workload_count: 0, result: required > available ? 'shortage' : 'within_capacity', free_intervals: body.availability }],
    missing_information: [], warnings: warning ? [warning] : [], limitations: ['本轮仅检查必要容量条件，尚未排程。'], excluded_task_ids: [], analyzed_task_ids: body.tasks.map(item => item.id),
  };
}

async function boot(t, { route, healthRoute, initialRaw = null, capabilities = ['snapshot_v2'] } = {}) {
  // No resources option: stylesheets/scripts/images are never fetched by jsdom.
  const dom = new JSDOM(HTML, { url: 'http://localhost:8873/', runScripts: 'outside-only' });
  const { window } = dom;
  window.CAMPUS_AGENT_API = BASE;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.confirm = () => true;
  const data = new Map(initialRaw === null ? [] : [[STORAGE_KEY, initialRaw]]);
  const writes = [];
  const storage = {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); writes.push({ key, value: String(value) }); },
    removeItem(key) { data.delete(key); },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  const locks = { async request(name, options, callback) { return callback(); } };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
  const calls = [];
  const mockedFetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { url, path, body, options };
    calls.push(call);
    let payload;
    if (path === '/api/health') payload = healthRoute ? await healthRoute(call) : { capabilities };
    else if (route) payload = await route(call);
    else if (path === '/api/v2/calculate') payload = calculated(body);
    else throw new Error(`Unexpected mocked request: ${path}`);
    return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
  };
  const globals = { window, document: window.document, location: window.location, navigator: window.navigator, fetch: mockedFetch };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const errors = [];
  window.addEventListener('error', event => { errors.push(event.error || event.message); event.preventDefault(); });
  t.after(async () => {
    await flush();
    window.close();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(errors, [], 'DOM event handlers must not throw');
  });
  await import(`../agent.js?dom-unit=${++instance}`);
  await flush();
  const find = selector => window.document.querySelector(selector);
  const click = selector => { const element = find(selector); assert.ok(element, selector); element.click(); };
  const input = (selector, value) => { const element = find(selector); assert.ok(element, selector); element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = selector => { const form = find(selector); assert.ok(form, selector); form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  const stored = () => JSON.parse(storage.getItem(STORAGE_KEY));
  return { window, document: window.document, find, click, input, submit, calls, data, writes, stored };
}

async function nineMinutes(t, options) {
  const app = await boot(t, options);
  app.click('#loadNineMinutes');
  app.click('[data-action="confirm"]');
  await flush();
  return app;
}

test('opening an empty workbench sends no network request and creates no saved data', async t => {
  const app = await boot(t);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.writes, []);
  assert.equal(app.document.querySelectorAll('[data-task-id]').length, 0);
  assert.match(app.find('#availabilityList').textContent, /还没有填写/);
});

test('manual task confirmation refuses missing explicit choices and preserves draft inputs', async t => {
  const app = await boot(t);
  app.click('#addTask');
  app.input('[data-task-field="title"]', '完成报告');
  app.input('[data-task-field="deadline_at"]', '2026-10-28T23:59');
  app.input('[data-task-field="remaining_minutes"]', '90');
  app.click('[data-action="confirm"]');
  await flush();
  assert.match(app.find('[data-task-error]').textContent, /必须完成/);
  assert.match(app.find('[data-task-error]').textContent, /优先级/);
  assert.equal(app.stored().tasks[0].status, 'draft');
  assert.equal(app.stored().tasks[0].title, '完成报告');
  app.click('#calculate');
  assert.match(app.find('#appMessage').textContent, /事项需要核对/);
  assert.deepEqual(app.calls, []);
});

test('confirmed nine-minute example posts one snapshot and displays 180 / 9 / 171 minutes', async t => {
  const app = await nineMinutes(t);
  app.click('#calculate');
  await flush();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health', '/api/v2/calculate']);
  const submitted = app.calls[1].body;
  assert.equal(submitted.tasks[0].status, 'confirmed');
  assert.equal(submitted.tasks[0].remaining_minutes, 180);
  assert.equal(submitted.availability_confirmed, true);
  const row = app.find('#resultOutput tbody tr');
  assert.ok(row);
  assert.match(row.children[1].textContent, /180 分钟/);
  assert.match(row.children[2].textContent, /9 分钟/);
  assert.match(row.children[3].textContent, /缺少 171 分钟/);
  assert.match(app.find('#resultOutput').textContent, /尚不能保证/);
});

test('editing any task field invalidates the displayed result immediately without losing focus', async t => {
  const app = await nineMinutes(t);
  app.click('#calculate');
  await flush();
  const field = app.find('[data-task-field="remaining_minutes"]');
  field.focus();
  app.input('[data-task-field="remaining_minutes"]', '60');
  assert.equal(app.find('#resultOutput table'), null);
  assert.match(app.find('#resultOutput').textContent, /原结果已失效/);
  assert.strictEqual(app.document.activeElement, field);
  assert.equal(app.find('[data-task-status]').textContent, '待核对');
  await flush();
  assert.equal(app.stored().tasks[0].remaining_minutes, 60);
});

test('calculate response arriving after an edit cannot repaint old numbers', async t => {
  const response = deferred();
  let submitted;
  const app = await nineMinutes(t, { route(call) { submitted = call.body; return response.promise; } });
  app.click('#calculate');
  await flush();
  assert.equal(app.calls.at(-1).path, '/api/v2/calculate');
  app.input('[data-task-field="remaining_minutes"]', '30');
  response.resolve(calculated(submitted, { warning: '过期响应，不应显示' }));
  await flush();
  assert.equal(app.find('#resultOutput table'), null);
  assert.doesNotMatch(app.find('#resultOutput').textContent, /过期响应|180 分钟/);
  assert.match(app.find('#resultOutput').textContent, /原结果已失效/);
});

test('a later request wins even at the same revision when responses arrive backwards', async t => {
  const pending = [];
  const app = await nineMinutes(t, { route(call) { const response = deferred(); pending.push({ ...response, body: call.body }); return response.promise; } });
  app.click('#calculate');
  await flush();
  assert.equal(pending.length, 1);
  // Reconnecting the same API invalidates the first request without editing data.
  app.submit('#apiForm');
  await flush();
  app.click('#calculate');
  await flush();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].body.revision, pending[1].body.revision);
  pending[1].resolve(calculated(pending[1].body, { warning: '最新响应' }));
  await flush();
  assert.match(app.find('#resultOutput').textContent, /最新响应/);
  pending[0].resolve(calculated(pending[0].body, { available: 999, warning: '过期响应' }));
  await flush();
  assert.match(app.find('#resultOutput').textContent, /最新响应/);
  assert.doesNotMatch(app.find('#resultOutput').textContent, /过期响应|999 分钟/);
});

test('notice extraction preserves escaped original text and draft status, with duplicate import blocked', async t => {
  const text = '<img src=x onerror="alert(1)">请于2026年10月28日15:00前报名。';
  const app = await boot(t, { route(call) {
    assert.equal(call.path, '/api/parse');
    assert.equal(call.body.text, text);
    return { task_name: '<script>unsafe title</script>', time_points: [{ time_type: '报名截止', value: '2026-10-28 15:00', precision: 'datetime', kind: 'point', evidence: '2026年10月28日15:00', timezone: 'Asia/Shanghai', warnings: [] }], warnings: [] };
  } });
  app.input('#noticeText', text);
  app.submit('#noticeForm');
  await flush();
  assert.equal(app.document.querySelectorAll('[data-task-id]').length, 1);
  assert.equal(app.stored().tasks[0].status, 'draft');
  assert.equal(app.stored().tasks[0].remaining_minutes, null);
  assert.equal(app.find('#sourceList pre').textContent, text);
  assert.equal(app.find('#sourceList img'), null);
  assert.equal(app.find('#taskList script'), null);
  assert.match(app.find('[data-task-name]').textContent, /<script>unsafe title<\/script>/);
  const callCount = app.calls.length;
  app.submit('#noticeForm');
  await flush();
  assert.equal(app.calls.length, callCount);
  assert.equal(app.document.querySelectorAll('[data-task-id]').length, 1);
  assert.match(app.find('#appMessage').textContent, /已导入，不会重复/);
});

const modelNotice = '请于2026年10月28日15:00前提交报告。';
const modelOutput = () => ({ schema_version: 1, provider: 'dify', parsing_status: 'needs_confirmation', candidates: [{ title: '提交报告', kind: 'flexible', deadline_at: '2026-10-28T15:00:00+08:00', fixed_start_at: null, fixed_end_at: null, visit_windows: [], location: null, materials: [], evidence: [{ field: 'title', origin: 'source_text', quote: '提交报告' }, { field: 'kind', origin: 'source_text', quote: '提交报告' }, { field: 'deadline_at', origin: 'source_text', quote: '2026年10月28日15:00' }], uncertainties: [] }], warnings: [] });
const modelHealth = () => ({ capabilities: ['snapshot_v2', 'model_notice_candidates_v1'], model_extraction: { configured: true } });

const basketballText = '各位同学：\n我院篮球队即将迎来新生杯比赛，对阵人文学院。\n比赛时间：10月26日18:00\n比赛地点：大学生活动中心\n现邀请大家到场观赛助威，用欢呼为队员加油，欢迎有空的同学前来！';
function basketballSnapshot() {
  const source = { id: 'source-basketball', kind: 'pasted_notice', text: basketballText, published_at: null };
  const task = createTask('fixed', source.id); task.title = '到场观赛助威';
  task.evidence = ['fixed_start_at', 'fixed_end_at'].map(field => ({ field, origin: 'source_text', source_id: source.id, quote: '10月26日18:00' }));
  return serializeSnapshot(addTask(addSource(createSnapshot(), source), task));
}
const basketballRuleTime = () => ({ time_points: [{ time_type: '活动/比赛时间', value: '2026-10-26 18:00', end_value: null, precision: 'datetime', kind: 'point', timezone: 'Asia/Shanghai', evidence: '10月26日18:00' }] });

test('missing fixed time shows the original fragment next to fields and no default priority', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot() });
  assert.match(app.find('.time-review').textContent, /10月26日18:00/);
  assert.match(app.find('.time-review').textContent, /结束按你计划的离场时间/);
  const priority = app.find('[data-task-field="priority"]');
  assert.equal(priority.value, '');
  assert.equal(priority.type, 'text');
  assert.equal(priority.autocomplete, 'off');
  assert.match(app.find('[data-priority-help]').textContent, /尚未选择/);
});
test('time completion requires an explicit reference day before transmitting the notice', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot() });
  app.click('[data-action="resolve-time"]'); await flush();
  assert.deepEqual(app.calls, []);
  assert.match(app.find('[data-task-error]').textContent, /通知的参照日期/);
});
test('reference-day time completion uses rules without a model call or duplicate tasks', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot(), route(call) {
    assert.equal(call.path, '/api/parse'); assert.equal(call.body.text, basketballText); assert.equal(call.body.reference_date, '2026-10-26'); return basketballRuleTime();
  } });
  app.input('#noticeDate', '2026-10-26'); app.click('[data-action="resolve-time"]'); await flush();
  const state = app.stored();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].fixed_start_at, '2026-10-26T18:00:00+08:00');
  assert.equal(state.tasks[0].fixed_end_at, null);
  assert.equal(state.tasks[0].priority, null);
  assert.equal(state.tasks[0].must_do, null);
  assert.equal(state.tasks[0].status, 'draft');
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health', '/api/parse']);
  assert.match(app.find('#appMessage').textContent, /原文缺少结束时间/);
  app.click('[data-action="confirm"]'); await flush();
  assert.equal(app.stored().tasks[0].status, 'draft');
});
test('time completion preserves an already entered personal arrival time', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot(), route: basketballRuleTime });
  app.input('[data-task-field="fixed_start_at"]', '2026-10-26T18:20');
  app.input('#noticeDate', '2026-10-26'); app.click('[data-action="resolve-time"]'); await flush();
  assert.equal(app.stored().tasks[0].fixed_start_at, '2026-10-26T18:20:00+08:00');
  assert.match(app.find('[data-task-error]').textContent, /没有可从原文补全/);
});
test('a changed reference day discards late time completion', async t => {
  const pending = deferred();
  const app = await boot(t, { initialRaw: basketballSnapshot(), route() { return pending.promise; } });
  app.input('#noticeDate', '2026-10-26'); app.click('[data-action="resolve-time"]'); await flush();
  app.input('#noticeDate', '2027-10-26'); pending.resolve(basketballRuleTime()); await flush();
  assert.equal(app.stored().tasks[0].fixed_start_at, null);
  assert.equal(app.find('[data-task-error]').textContent, '');
});
test('a failed old completion cannot add an error after task edits', async t => {
  const pending = deferred();
  const app = await boot(t, { initialRaw: basketballSnapshot(), async route() { await pending.promise; throw new Error('old failure'); } });
  app.input('#noticeDate', '2026-10-26'); app.click('[data-action="resolve-time"]'); await flush();
  app.input('[data-task-field="title"]', '我计划观赛'); pending.resolve(); await flush();
  assert.equal(app.find('[data-task-error]').textContent, '');
  assert.equal(app.stored().tasks[0].title, '我计划观赛');
});
test('an unsaved restored priority zero cannot masquerade as a chosen priority', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot() });
  // Mimic a visual form restoration without a corresponding accepted edit.
  app.find('[data-task-field="priority"]').value = '0';
  app.click('[data-action="confirm"]'); await flush();
  assert.equal(app.find('[data-task-field="priority"]').value, '');
  assert.equal(app.stored().tasks[0].priority, null);
  assert.match(app.find('[data-task-error]').textContent, /尚未保存为你的选择/);
});
test('blank or whitespace priority cannot become zero; a deliberately typed zero remains valid', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot() });
  app.input('[data-task-field="priority"]', ' '); await flush();
  assert.equal(app.stored().tasks[0].priority, null);
  assert.match(app.find('[data-task-error]').textContent, /优先级/);
  app.input('[data-task-field="priority"]', '0'); await flush();
  assert.equal(app.stored().tasks[0].priority, 0);
  assert.equal(app.find('[data-task-error]').textContent, '');
});

test('unconfigured model mode sends no notification and never silently uses rules', async t => {
  const app = await boot(t);
  app.input('#extractionMode', 'dify'); app.input('#noticeText', modelNotice); app.submit('#noticeForm');
  await flush();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health']);
  assert.match(app.find('#appMessage').textContent, /尚未启用模型提取/);
  assert.equal(app.find('#noticeText').value, modelNotice);
  assert.equal(app.writes.length, 0);
});
test('configured model mode posts only the notice and imports unconfirmed sourced drafts', async t => {
  const app = await boot(t, { healthRoute: modelHealth, route(call) { assert.equal(call.path, '/api/v2/extract'); return modelOutput(); } });
  app.input('#extractionMode', 'dify'); app.input('#noticeText', modelNotice); app.submit('#noticeForm');
  await flush();
  assert.deepEqual(Object.keys(app.calls[1].body).sort(), ['reference_date', 'text', 'timezone']);
  assert.equal(app.stored().tasks[0].status, 'draft');
  assert.equal(app.stored().tasks[0].priority, null);
  assert.match(app.find('#appMessage').textContent, /Dify 模型/);
  assert.match(app.find('.evidence').textContent, /不代表理解一定正确/);
});
test('switching extraction modes discards a late model response', async t => {
  const pending = deferred();
  const app = await boot(t, { healthRoute: modelHealth, route() { return pending.promise; } });
  app.input('#extractionMode', 'dify'); app.input('#noticeText', modelNotice); app.submit('#noticeForm'); await flush();
  app.input('#extractionMode', 'rules'); pending.resolve(modelOutput()); await flush();
  assert.equal(app.document.querySelectorAll('[data-task-id]').length, 0);
  assert.equal(app.writes.length, 0);
});
test('a failed model request preserves the input and does not issue a rules request', async t => {
  const app = await boot(t, { healthRoute: modelHealth, route() { throw new Error('模型服务暂时不可用'); } });
  app.input('#extractionMode', 'dify'); app.input('#noticeText', modelNotice); app.submit('#noticeForm'); await flush();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health', '/api/v2/extract']);
  assert.match(app.find('#appMessage').textContent, /模型服务暂时不可用/);
  assert.equal(app.find('#noticeText').value, modelNotice);
  assert.equal(app.writes.length, 0);
});
test('oversized model input is blocked before any network request', async t => {
  const app = await boot(t); app.input('#extractionMode', 'dify'); app.input('#noticeText', '字'.repeat(20001)); app.submit('#noticeForm'); await flush();
  assert.deepEqual(app.calls, []); assert.match(app.find('#appMessage').textContent, /两万字/);
});
test('no-action model output does not create an empty task or source', async t => {
  const app = await boot(t, { healthRoute: modelHealth, route() { return { ...modelOutput(), candidates: [], warnings: ['只是背景介绍。'] }; } });
  app.input('#extractionMode', 'dify'); app.input('#noticeText', modelNotice); app.submit('#noticeForm'); await flush();
  assert.equal(app.writes.length, 0); assert.match(app.find('#appMessage').textContent, /没有识别到行动事项/);
  assert.match(app.find('#appMessage').textContent, /只是背景介绍/);
});

test('unknown availability blocks calculation while explicitly confirmed zero is submitted', async t => {
  const app = await nineMinutes(t, { route(call) { return calculated(call.body, { available: 0 }); } });
  const saved = app.stored();
  saved.availability = [];
  saved.availability_confirmed = false;
  app.data.set(STORAGE_KEY, serializeSnapshot(saved));
  app.window.dispatchEvent(new app.window.StorageEvent('storage', { key: STORAGE_KEY, newValue: serializeSnapshot(saved) }));
  app.click('#reloadLatest');
  app.click('#calculate');
  assert.match(app.find('#appMessage').textContent, /没有填写不代表/);
  assert.deepEqual(app.calls, []);
  app.click('#confirmNoAvailability');
  app.click('#calculate');
  await flush();
  const submitted = app.calls.at(-1).body;
  assert.deepEqual(submitted.availability, []);
  assert.equal(submitted.availability_confirmed, true);
  assert.match(app.find('#resultOutput tbody tr').children[2].textContent, /0 分钟/);
  assert.match(app.find('#resultOutput tbody tr').children[3].textContent, /缺少 180 分钟/);
});

test('cross-tab storage change stops automatic writes while preserving local edits in memory', async t => {
  const app = await nineMinutes(t);
  const foreign = createSnapshot({ referenceTime: '2026-11-01T09:00:00+08:00' });
  foreign.label = '其他标签页的版本';
  const raw = serializeSnapshot(foreign);
  app.data.set(STORAGE_KEY, raw);
  app.window.dispatchEvent(new app.window.StorageEvent('storage', { key: STORAGE_KEY, newValue: raw }));
  assert.equal(app.find('#storageConflict').hidden, false);
  const before = app.writes.length;
  app.input('[data-task-field="title"]', '仍保留在本页的修改');
  await flush();
  assert.equal(app.writes.length, before);
  assert.equal(app.data.get(STORAGE_KEY), raw);
  assert.equal(app.find('[data-task-field="title"]').value, '仍保留在本页的修改');
  assert.match(app.find('#saveState').textContent, /尚未保存/);
  app.click('#calculate');
  assert.match(app.find('#appMessage').textContent, /另一个标签页/);
  assert.deepEqual(app.calls, []);
});

test('a missed storage event cannot let this tab overwrite different raw data at the same revision', async t => {
  const app = await nineMinutes(t);
  const foreign = app.stored();
  foreign.label = '其他标签页同revision的新内容';
  foreign.tasks[0].title = '另一个标签页的修改';
  const raw = serializeSnapshot(foreign);
  // No storage event: the lock-protected read/compare must still detect this.
  app.data.set(STORAGE_KEY, raw);
  const writesBefore = app.writes.length;
  app.input('[data-task-field="title"]', '本页新修改');
  await flush();
  assert.equal(app.writes.length, writesBefore);
  assert.equal(app.data.get(STORAGE_KEY), raw);
  assert.equal(app.find('#storageConflict').hidden, false);
  assert.match(app.find('#saveState').textContent, /版本变化/);
  assert.equal(app.find('[data-task-field="title"]').value, '本页新修改');
});

test('an old backend without snapshot capability receives no notification text', async t => {
  const app = await boot(t, { capabilities: [] });
  app.input('#noticeText', '请于2026年10月28日15:00前报名。');
  app.submit('#noticeForm');
  await flush();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health']);
  assert.equal(app.calls[0].body, undefined);
  assert.match(app.find('#appMessage').textContent, /服务尚未升级/);
  assert.equal(app.document.querySelectorAll('[data-task-id]').length, 0);
});

test('bad imported JSON leaves the current checklist and saved bytes intact', async t => {
  const app = await nineMinutes(t);
  const before = app.data.get(STORAGE_KEY);
  const title = app.find('[data-task-name]').textContent;
  const file = { size: 12, async text() { return '{broken json'; } };
  Object.defineProperty(app.find('#importFile'), 'files', { configurable: true, value: [file] });
  app.find('#importFile').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await flush();
  assert.match(app.find('#appMessage').textContent, /导入未完成/);
  assert.equal(app.find('[data-task-name]').textContent, title);
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.deepEqual(app.calls, []);
});

test('out-of-range remaining work cannot calculate a previously confirmed smaller value', async t => {
  const app = await nineMinutes(t);
  app.input('[data-task-field="remaining_minutes"]', '60');
  app.click('[data-action="confirm"]');
  await flush();
  assert.equal(app.stored().tasks[0].remaining_minutes, 60);
  app.input('[data-task-field="remaining_minutes"]', '10000001');
  app.click('#calculate');
  await flush();
  assert.deepEqual(app.calls, [], 'invalid visible work cannot silently calculate the old value');
  assert.equal(app.stored().tasks[0].remaining_minutes, null);
  assert.equal(app.stored().tasks[0].status, 'draft');
});

test('priority above 100 becomes an unknown draft choice rather than reusing the old confirmed value', async t => {
  const app = await nineMinutes(t);
  app.input('[data-task-field="priority"]', '101');
  app.click('#calculate');
  await flush();
  assert.deepEqual(app.calls, []);
  assert.equal(app.stored().tasks[0].priority, null);
  assert.equal(app.stored().tasks[0].status, 'draft');
});

test('a rejected field edit blocks confirmation and calculation until the visible value is corrected', async t => {
  const app = await nineMinutes(t);
  app.input('[data-task-field="location"]', '地'.repeat(501));
  app.input('[data-task-field="priority"]', '50');
  app.click('[data-action="confirm"]');
  app.click('#calculate');
  await flush();
  assert.deepEqual(app.calls, [], 'rejected visible edits must not use stale confirmed data');
  assert.match(`${app.find('[data-task-error]').textContent} ${app.find('#appMessage').textContent}`, /修正|未保存|无效|错误|超过|location/);
  app.input('[data-task-field="location"]', '主楼405');
  app.click('[data-action="confirm"]');
  app.click('#calculate');
  await flush();
  assert.equal(app.calls.at(-1).path, '/api/v2/calculate');
  assert.equal(app.calls.at(-1).body.tasks[0].location, '主楼405');
});

test('a superseded API connection failure cannot overwrite the later successful connection', async t => {
  const first = deferred();
  const app = await boot(t, { healthRoute(call) {
    if (call.url.startsWith('https://api-a.invalid')) return first.promise;
    return { capabilities: ['snapshot_v2'] };
  } });
  app.input('#apiBase', 'https://api-a.invalid');
  app.submit('#apiForm');
  await flush();
  app.input('#apiBase', 'https://api-b.invalid');
  app.submit('#apiForm');
  await flush();
  assert.match(app.find('#connectionStatus').textContent, /已连接/);
  // Health A responds with old-version capabilities only after B has succeeded.
  first.resolve({ capabilities: [] });
  await flush();
  assert.match(app.find('#connectionStatus').textContent, /已连接/);
  assert.match(app.find('#appMessage').textContent, /服务已连接/);
  assert.equal(app.find('#apiBase').value, 'https://api-b.invalid');
});

test('switching task kind preserves select focus and the open task editor after rebuilding fields', async t => {
  const app = await nineMinutes(t);
  const original = app.find('[data-task-field="kind"]');
  original.focus();
  app.input('[data-task-field="kind"]', 'fixed');
  const current = app.find('[data-task-field="kind"]');
  assert.notStrictEqual(current, original);
  assert.strictEqual(app.document.activeElement, current);
  assert.equal(current.value, 'fixed');
  assert.equal(app.find('.task-details').open, true);
  assert.ok(app.find('[data-task-field="fixed_start_at"]'));
  assert.ok(app.find('[data-task-field="fixed_end_at"]'));
  assert.equal(app.find('[data-task-field="remaining_minutes"]'), null);
  await flush();
  assert.equal(app.stored().tasks[0].status, 'draft');
  assert.equal(app.stored().tasks[0].remaining_minutes, 0);
});

test('splitting-choice rebuild preserves select focus while requiring a newly visible minimum block', async t => {
  const app = await nineMinutes(t);
  app.find('[data-task-field="splittable"]').focus();
  app.input('[data-task-field="splittable"]', 'false');
  assert.strictEqual(app.document.activeElement, app.find('[data-task-field="splittable"]'));
  assert.equal(app.find('[data-task-field="min_block_minutes"]'), null);
  app.input('[data-task-field="splittable"]', 'true');
  assert.strictEqual(app.document.activeElement, app.find('[data-task-field="splittable"]'));
  assert.ok(app.find('[data-task-field="min_block_minutes"]'));
  assert.equal(app.find('[data-task-field="min_block_minutes"]').value, '');
  app.click('[data-action="confirm"]');
  assert.match(app.find('[data-task-error]').textContent, /最小连续/);
});

test('confirming a reviewed task preserves focus on the confirmation action and editor disclosure', async t => {
  const app = await boot(t);
  app.click('#loadNineMinutes');
  const button = app.find('[data-action="confirm"]');
  button.focus();
  assert.equal(app.find('.task-details').open, true);
  app.click('[data-action="confirm"]');
  assert.notStrictEqual(app.document.activeElement, button);
  assert.strictEqual(app.document.activeElement, app.find('[data-action="confirm"]'));
  assert.equal(app.find('.task-details').open, true);
  assert.match(app.find('[data-task-status]').textContent, /已确认/);
  await flush();
  assert.equal(app.stored().tasks[0].status, 'confirmed');
});
