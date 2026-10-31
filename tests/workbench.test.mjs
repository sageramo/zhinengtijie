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
import { STORAGE_KEY, createSnapshot, createTask, addSource, addTask, editTask, confirmTask, setAvailability, serializeSnapshot } from '../task-state.js';

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

async function boot(t, { route, healthRoute, httpStatus, initialRaw = null, capabilities = ['snapshot_v2'] } = {}) {
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
    const status = httpStatus ? httpStatus(call) : 200;
    return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(payload); } };
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

function planned(body, status = 'feasible_found') {
  const start = body.reference_time;
  const end = new Date(Date.parse(start) + body.tasks[0].remaining_minutes * 60000).toISOString();
  return { schema_version: 1, revision: body.revision, status,
    horizon: { start, end: body.tasks[0].deadline_at },
    schedule: status === 'feasible_found' ? [{ task_id: body.tasks[0].id, kind: 'work', start, end }] : [],
    validation: { passed: status === 'feasible_found' ? true : null, errors: [], checked_constraints: ['confirmed_inputs', 'availability', 'fixed_occupancy', 'no_overlap', 'release_and_deadline', 'exact_remaining_work', 'continuous_blocks', 'dependencies'] },
    issues: [], conflicts: [], capacity_checks: [], warnings: [], limitations: ['四种排序不保证最优，未找到不代表无解。'],
    algorithm: { name: 'bounded_greedy_v1', attempts: 1, max_attempts: 4 } };
}
async function shortWork(t, options = {}) {
  const app = await nineMinutes(t, { capabilities: ['snapshot_v2', 'bounded_planning_v1'], ...options });
  app.input('[data-task-field="remaining_minutes"]', '5');
  app.click('[data-action="confirm"]');
  await flush();
  return app;
}

test('an old service receives no snapshot when concrete planning is unavailable', async t => {
  const app = await shortWork(t, { capabilities: ['snapshot_v2'] });
  app.click('#generatePlan'); await flush();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health']);
  assert.match(app.find('#appMessage').textContent, /重启本地服务加载1.5/);
  assert.equal(app.find('#generatePlan').disabled, false);
});

test('concrete planning is read only and renders a complete independently checked schedule', async t => {
  const app = await shortWork(t, { route(call) { assert.equal(call.path, '/api/v2/plan'); return planned(call.body); } });
  const before = app.data.get(STORAGE_KEY), writes = app.writes.length;
  app.click('#generatePlan'); await flush();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health', '/api/v2/plan']);
  assert.match(app.find('#resultOutput h3').textContent, /通过校验/);
  assert.equal(app.document.querySelectorAll('.schedule-row').length, 1);
  assert.match(app.find('.schedule-time').textContent, /23:50 至 23:55/);
  assert.match(app.find('#resultOutput').textContent, /全部 1 件/);
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.equal(app.writes.length, writes);
  assert.equal(app.stored().tasks[0].status, 'confirmed');
  app.input('[data-task-field="priority"]', '20');
  assert.equal(app.find('.schedule-row'), null);
  assert.match(app.find('#resultOutput').textContent, /原结果已失效/);
});

test('an edited checklist cannot be replaced by a late concrete schedule', async t => {
  const response = deferred(); let submitted;
  const app = await shortWork(t, { route(call) { submitted = call.body; return response.promise; } });
  app.click('#generatePlan'); await flush();
  app.input('[data-task-field="remaining_minutes"]', '4');
  response.resolve(planned(submitted)); await flush();
  assert.equal(app.find('.schedule-row'), null);
  assert.match(app.find('#resultOutput').textContent, /原结果已失效/);
  assert.equal(app.find('#generatePlan').disabled, false);
});

for (const first of ['plan', 'calculate']) test(`a late ${first} result cannot replace the other newer action`, async t => {
  const response = deferred(); let older;
  const app = await shortWork(t, { route(call) {
    const isFirst = call.path.endsWith(`/${first}`);
    if (isFirst) { older = call.body; return response.promise; }
    return first === 'plan' ? calculated(call.body, { required: 5, available: 9 }) : planned(call.body);
  } });
  app.click(first === 'plan' ? '#generatePlan' : '#calculate'); await flush();
  app.click(first === 'plan' ? '#calculate' : '#generatePlan'); await flush();
  const newer = app.find('#resultOutput').innerHTML;
  response.resolve(first === 'plan' ? planned(older) : calculated(older)); await flush();
  assert.equal(app.find('#resultOutput').innerHTML, newer);
  assert.equal(app.find('#generatePlan').disabled, false);
  assert.equal(app.find('#calculate').disabled, false);
});

test('changing the service discards an in-flight schedule without sending it to the new service', async t => {
  const response = deferred(); let submitted;
  const app = await shortWork(t, { route(call) { submitted = call.body; return response.promise; } });
  app.click('#generatePlan'); await flush();
  app.input('#apiBase', 'https://second.invalid'); app.submit('#apiForm'); await flush();
  response.resolve(planned(submitted)); await flush();
  assert.equal(app.find('.schedule-row'), null);
  assert.equal(app.calls.filter(call => call.path === '/api/v2/plan').length, 1);
});

test('a claimed success with failed validation is rejected rather than shown as green', async t => {
  const app = await shortWork(t, { route(call) { const result = planned(call.body); result.validation.passed = false; return result; } });
  app.click('#generatePlan'); await flush();
  assert.equal(app.find('.schedule-row'), null);
  assert.equal(app.find('.result-success'), null);
  assert.match(app.find('#appMessage').textContent, /结果不完整/);
});

test('not found remains distinct from a proven conflict and displays no partial time slots', async t => {
  const app = await shortWork(t, { route(call) { const result = planned(call.body, 'not_found'); result.algorithm.attempts = 4; return result; } });
  app.click('#generatePlan'); await flush();
  assert.match(app.find('#resultOutput').textContent, /不能证明无解/);
  assert.equal(app.find('.schedule-row'), null);
  assert.equal(app.find('.result-success'), null);
});

test('invalid visible inputs and unfinished availability forms prevent concrete planning', async t => {
  const app = await shortWork(t, { route(call) { return planned(call.body); } });
  app.input('[data-task-field="priority"]', 'wrong');
  app.click('#generatePlan'); await flush();
  assert.deepEqual(app.calls, []);
  app.input('[data-task-field="priority"]', '50'); app.click('[data-action="confirm"]'); await flush();
  app.click('#addAvailability'); app.click('#generatePlan'); await flush();
  assert.deepEqual(app.calls, []);
  assert.match(app.find('#appMessage').textContent, /保存或取消/);
});

test('the evening example is explicitly synthetic, draft-only and does not send data automatically', async t => {
  const app = await boot(t);
  app.click('#loadEveningPlan'); await flush();
  assert.deepEqual(app.calls, []);
  assert.equal(app.stored().sources[0].kind, 'synthetic');
  assert.equal(app.stored().tasks.length, 3);
  assert.ok(app.stored().tasks.every(task => task.status === 'draft'));
  app.click('#generatePlan'); assert.deepEqual(app.calls, []);
  for (const task of app.stored().tasks) app.click(`[data-task-id="${task.id}"] [data-action="confirm"]`);
  await flush();
  assert.ok(app.stored().tasks.every(task => task.status === 'confirmed'));
  assert.equal(app.stored().tasks.find(task => task.kind === 'fixed').depends_on.length, 1);
});

test('declining an evening example replacement preserves the existing snapshot', async t => {
  const app = await nineMinutes(t);
  const before = app.data.get(STORAGE_KEY);
  app.window.confirm = () => false;
  app.click('#loadEveningPlan'); await flush();
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.deepEqual(app.calls, []);
});

async function plannedApp(t, options = {}) {
  const app = await shortWork(t, { route(call) { return planned(call.body); }, ...options });
  app.click('#generatePlan'); await flush();
  assert.ok(app.find('#scenarioForm'));
  return app;
}
async function measureRemaining(app, value) {
  app.input('#scenarioMinutes', value); app.submit('#scenarioForm'); await flush();
}

test('a hypothetical comparison leaves the original snapshot and result intact until adoption', async t => {
  const app = await plannedApp(t);
  const before = app.data.get(STORAGE_KEY), writes = app.writes.length;
  const originalHeading = app.find('#resultOutput h3').textContent;
  await measureRemaining(app, '4');
  assert.equal(app.find('#resultOutput h3').textContent, originalHeading);
  assert.equal(app.data.get(STORAGE_KEY), before); assert.equal(app.writes.length, writes);
  const hypothetical = app.calls.filter(call => call.path === '/api/v2/plan').at(-1).body;
  assert.equal(hypothetical.tasks[0].remaining_minutes, 4);
  assert.equal(hypothetical.tasks[0].status, 'confirmed');
  assert.ok(!Object.hasOwn(hypothetical, 'proposal'));
  assert.match(app.find('#scenarioOutput').textContent, /假设方案，尚未采用/);
  assert.equal(app.find('[data-scenario-action="adopt"]').disabled, true);
  app.click('[data-scenario-action="adopt"]'); assert.equal(app.data.get(STORAGE_KEY), before);
  app.click('#scenarioReality'); app.click('[data-scenario-action="adopt"]'); await flush();
  assert.equal(app.stored().tasks[0].remaining_minutes, 4);
  assert.equal(app.stored().tasks[0].status, 'draft');
  assert.ok(!app.stored().tasks[0].confirmed_fields.includes('remaining_minutes'));
  assert.equal(app.document.activeElement.dataset.action, 'confirm');
  assert.equal(app.find('.schedule-row'), null);
  const calls = app.calls.length; app.click('#generatePlan'); await flush();
  assert.equal(app.calls.length, calls); assert.match(app.find('#appMessage').textContent, /需要核对/);
});

test('discarding a measured hypothesis does not save or change current numbers', async t => {
  const app = await plannedApp(t); const before = app.data.get(STORAGE_KEY);
  await measureRemaining(app, '4');
  app.click('[data-scenario-action="discard"]'); await flush();
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.match(app.find('#scenarioOutput').textContent, /已放弃/);
  assert.equal(app.document.activeElement.id, 'measureScenario');
  assert.equal(app.find('[data-scenario-action="adopt"]'), null);
  assert.match(app.find('#resultOutput > h3').textContent, /通过校验/);
});

test('changing hypothesis input removes its old result and consent without editing the snapshot', async t => {
  const app = await plannedApp(t); const before = app.data.get(STORAGE_KEY);
  await measureRemaining(app, '4'); app.click('#scenarioReality');
  app.input('#scenarioMinutes', '3');
  assert.equal(app.find('[data-scenario-action="adopt"]'), null);
  assert.match(app.find('#scenarioOutput').textContent, /原试算结果失效/);
  assert.equal(app.data.get(STORAGE_KEY), before);
  await measureRemaining(app, '3');
  assert.equal(app.find('#scenarioReality').checked, false);
});

test('an invalid hypothesis is explained beside the form and never posted', async t => {
  const app = await plannedApp(t); const before = app.calls.length;
  for (const value of ['', '0', '-1', '1.5', '10000001', '5']) {
    await measureRemaining(app, value);
    assert.equal(app.calls.length, before);
    assert.ok(app.find('#scenarioOutput .field-error'));
    assert.equal(app.find('.result-success').textContent, '找到一份通过校验的安排');
  }
});

test('a late hypothetical result cannot repaint a checklist that was edited meanwhile', async t => {
  const response = deferred(); let submitted, posts = 0;
  const app = await plannedApp(t, { route(call) { if (++posts === 1) return planned(call.body); submitted = call.body; return response.promise; } });
  await measureRemaining(app, '4');
  app.input('[data-task-field="remaining_minutes"]', '6');
  response.resolve(planned(submitted)); await flush();
  assert.equal(app.find('#scenarioForm'), null); assert.equal(app.find('.schedule-row'), null);
  assert.equal(app.stored().tasks[0].remaining_minutes, 6);
});

test('newer hypothetical measurements win without a snapshot revision change', async t => {
  const first = deferred(); let older, posts = 0;
  const app = await plannedApp(t, { route(call) { posts += 1; if (posts === 2) { older = call.body; return first.promise; } return planned(call.body); } });
  const revision = app.stored().revision;
  await measureRemaining(app, '4'); await measureRemaining(app, '3');
  assert.match(app.find('#scenarioOutput').textContent, /→ 3分钟/);
  const newer = app.find('#scenarioOutput').innerHTML;
  first.resolve(planned(older)); await flush();
  assert.equal(app.find('#scenarioOutput').innerHTML, newer);
  assert.equal(app.stored().revision, revision);
});

for (const action of ['calculate', 'generatePlan']) test(`starting ${action} discards an in-flight hypothesis even when revision stays the same`, async t => {
  const pending = deferred(); let older, posts = 0;
  const app = await plannedApp(t, { route(call) {
    posts += 1;
    if (posts === 2) { older = call.body; return pending.promise; }
    return call.path === '/api/v2/calculate' ? calculated(call.body, { required: 5, available: 9 }) : planned(call.body);
  } });
  await measureRemaining(app, '4'); app.click(`#${action}`); await flush();
  const newer = app.find('#resultOutput').innerHTML;
  pending.resolve(planned(older)); await flush();
  assert.equal(app.find('#resultOutput').innerHTML, newer);
  assert.equal(app.find('[data-scenario-action="adopt"]'), null);
});

test('switching services discards an in-flight hypothesis and cannot enable its adoption', async t => {
  const pending = deferred(); let older, posts = 0;
  const app = await plannedApp(t, { route(call) { if (++posts === 1) return planned(call.body); older = call.body; return pending.promise; } });
  await measureRemaining(app, '4');
  app.input('#apiBase', 'https://second.invalid'); app.submit('#apiForm'); await flush();
  pending.resolve(planned(older)); await flush();
  assert.equal(app.find('#scenarioForm'), null); assert.equal(app.find('[data-scenario-action="adopt"]'), null);
});

test('a stale or failed hypothetical response preserves the original successful result', async t => {
  let posts = 0;
  const app = await plannedApp(t, { route(call) {
    const result = planned(call.body);
    if (++posts > 1) result.revision -= 1;
    return result;
  } });
  const before = app.data.get(STORAGE_KEY);
  await measureRemaining(app, '4');
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.match(app.find('#scenarioOutput').textContent, /试算未完成/);
  assert.equal(app.find('[data-scenario-action="adopt"]'), null);
  assert.match(app.find('#resultOutput > h3').textContent, /通过校验/);
});

test('old planning capability on a fresh handshake prevents posting a hypothesis', async t => {
  let checks = 0;
  const app = await plannedApp(t, { healthRoute() { return { capabilities: ++checks === 1 ? ['snapshot_v2', 'bounded_planning_v1'] : ['snapshot_v2'] }; } });
  await measureRemaining(app, '4');
  assert.equal(app.calls.filter(call => call.path === '/api/v2/plan').length, 1);
  assert.match(app.find('#scenarioOutput').textContent, /假设未提交/);
});

test('new availability adoption preserves task confirmations and does not install a preview schedule', async t => {
  const day = '2031-03-14';
  let snapshot = createSnapshot({ referenceTime: `${day}T18:00:00+08:00` });
  const task = createTask('flexible');
  Object.assign(task, { title: '报告', deadline_at: `${day}T22:00:00+08:00`, remaining_minutes: 120, priority: 75, must_do: true, splittable: true, min_block_minutes: 30 });
  snapshot = confirmTask(addTask(snapshot, task), task.id);
  snapshot = setAvailability(snapshot, [{ start: `${day}T18:00:00+08:00`, end: `${day}T19:00:00+08:00` }]);
  const app = await boot(t, { initialRaw: serializeSnapshot(snapshot), capabilities: ['snapshot_v2', 'bounded_planning_v1'], route(call) {
    const body = call.body; const hasNew = body.availability.length === 2;
    const result = planned(body, hasNew ? 'feasible_found' : 'conflicts_detected');
    result.capacity_checks = [{ deadline: body.tasks[0].deadline_at, known_required_minutes: 120, available_minutes: hasNew ? 120 : 60 }];
    result.conflicts = hasNew ? [] : [{ reason: '容量缺少60分钟', tasks: ['报告'] }];
    if (hasNew) result.schedule = body.availability.map(interval => ({ ...interval, task_id: task.id, kind: 'work' }));
    return result;
  } });
  app.click('#generatePlan'); await flush();
  const before = app.data.get(STORAGE_KEY);
  app.input('#scenarioKind', 'availability');
  assert.equal(app.find('#scenarioWorkFields').disabled, true);
  assert.equal(app.find('#scenarioAvailabilityFields').hidden, false);
  app.input('#scenarioStart', `${day}T20:00`); app.input('#scenarioEnd', `${day}T21:00`);
  app.submit('#scenarioForm'); await flush();
  assert.equal(app.data.get(STORAGE_KEY), before);
  const cells = app.find('#scenarioOutput tbody').children[1].children;
  assert.equal(cells[1].textContent, '60 分钟'); assert.equal(cells[2].textContent, '0 分钟');
  app.click('#scenarioReality'); app.click('[data-scenario-action="adopt"]'); await flush();
  assert.equal(app.stored().availability.length, 2);
  assert.deepEqual(app.stored().tasks, snapshot.tasks);
  assert.equal(app.find('.schedule-row'), null);
  assert.equal(app.document.activeElement.id, 'generatePlan');
});

test('an availability start before the reference marks and focuses the start, with an associated error', async t => {
  const app = await plannedApp(t);
  const toInput = value => new Date(value + 8 * 3600000).toISOString().slice(0, 16);
  const reference = Date.parse(app.stored().reference_time), before = app.calls.length;
  app.input('#scenarioKind', 'availability');
  app.input('#scenarioStart', toInput(reference - 60000)); app.input('#scenarioEnd', toInput(reference + 180000));
  app.submit('#scenarioForm'); await flush();
  assert.equal(app.calls.length, before);
  assert.match(app.find('#scenarioOutput').textContent, /不能早于/);
  assert.equal(app.find('#scenarioStart').getAttribute('aria-invalid'), 'true');
  assert.notEqual(app.find('#scenarioEnd').getAttribute('aria-invalid'), 'true');
  assert.equal(app.document.activeElement.id, 'scenarioStart');
  assert.ok(app.find('#scenarioStart').getAttribute('aria-describedby')?.split(/\s+/).includes('scenarioValidationError'));
});

test('correcting an availability error clears stale error labels before a successful trial', async t => {
  const app = await plannedApp(t);
  const toInput = value => new Date(value + 8 * 3600000).toISOString().slice(0, 16);
  const reference = Date.parse(app.stored().reference_time);
  app.input('#scenarioKind', 'availability');
  app.input('#scenarioStart', toInput(reference - 60000)); app.input('#scenarioEnd', toInput(reference + 180000));
  app.submit('#scenarioForm'); await flush();
  app.input('#scenarioStart', toInput(reference + 60000)); app.submit('#scenarioForm'); await flush();
  assert.ok(app.find('#scenarioOutput table'));
  assert.equal(app.find('#scenarioForm [aria-invalid="true"]'), null);
  assert.equal(app.find('#scenarioForm [aria-describedby~="scenarioValidationError"]'), null);
  assert.equal(app.find('#scenarioValidationError'), null);
});

test('a failed trial connection keeps the original plan and can be retried without losing input', async t => {
  let posts = 0;
  const app = await plannedApp(t, { route(call) { if (++posts === 2) throw new Error('模拟断网'); return planned(call.body); } });
  const before = app.data.get(STORAGE_KEY);
  await measureRemaining(app, '4');
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.match(app.find('#scenarioOutput').textContent, /模拟断网/);
  assert.equal(app.find('[data-scenario-action="adopt"]'), null);
  assert.equal(app.find('#scenarioMinutes').value, '4');
  assert.equal(app.find('#measureScenario').disabled, false);
  assert.match(app.find('#resultOutput > h3').textContent, /通过校验/);
  app.submit('#scenarioForm'); await flush();
  assert.ok(app.find('#scenarioOutput table'));
  assert.equal(app.data.get(STORAGE_KEY), before);
});

test('HTTP 503 during trial is recoverable and never masquerades as a successful hypothesis', async t => {
  const app = await plannedApp(t, {
    httpStatus(call) { return call.path === '/api/v2/plan' && call.body.tasks[0].remaining_minutes === 4 ? 503 : 200; },
    route(call) { return call.body.tasks[0].remaining_minutes === 4 ? { error: '模拟服务维护' } : planned(call.body); },
  });
  const before = app.data.get(STORAGE_KEY);
  await measureRemaining(app, '4');
  assert.match(app.find('#scenarioOutput').textContent, /模拟服务维护/);
  assert.equal(app.find('#scenarioOutput .result-success'), null);
  assert.equal(app.find('[data-scenario-action="adopt"]'), null);
  assert.equal(app.data.get(STORAGE_KEY), before);
  await measureRemaining(app, '3');
  assert.ok(app.find('#scenarioOutput table'));
  assert.equal(app.data.get(STORAGE_KEY), before);
});

test('adopting after a missed cross-tab event never overwrites the foreign saved snapshot', async t => {
  const app = await plannedApp(t);
  await measureRemaining(app, '4'); app.click('#scenarioReality');
  const foreign = app.stored(); foreign.label = '其他标签页已保存的新版本';
  const raw = serializeSnapshot(foreign); app.data.set(STORAGE_KEY, raw);
  app.click('[data-scenario-action="adopt"]'); await flush();
  assert.equal(app.data.get(STORAGE_KEY), raw);
  assert.equal(app.find('#storageConflict').hidden, false);
  assert.match(app.find('#saveState').textContent, /保存遇到版本变化/);
  assert.equal(app.find('#scenarioForm'), null);
});

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
  assert.match(app.find('#resultOutput').textContent, /累计需求已超过/);
  assert.doesNotMatch(app.find('#resultOutput').textContent, /容量没有超出/);
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

test('an extracted known start stays visible while only the missing end requires user input', async t => {
  const snapshot = JSON.parse(basketballSnapshot());
  snapshot.tasks[0].fixed_start_at = '2026-10-26T18:00:00+08:00';
  snapshot.tasks[0].evidence = snapshot.tasks[0].evidence.filter(item => item.field !== 'fixed_end_at');
  const app = await boot(t, { initialRaw: JSON.stringify(snapshot) });
  assert.equal(app.find('[data-task-field="fixed_start_at"]').value, '2026-10-26T18:00');
  assert.equal(app.find('[data-task-field="fixed_end_at"]').value, '');
  assert.equal(app.find('[data-action="resolve-time"]'), null);
  assert.match(app.find('.time-review').textContent, /不会自动估计/);
  app.input('[data-task-field="must_do"]', 'false');
  app.input('[data-task-field="priority"]', '20');
  app.click('[data-action="confirm"]');
  assert.strictEqual(app.document.activeElement, app.find('[data-task-field="fixed_end_at"]'));
  assert.deepEqual(app.calls, []);
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
test('an HTTP 504 model timeout preserves an existing checklist and notice without automatic retry', async t => {
  const pending = deferred();
  const app = await nineMinutes(t, {
    healthRoute: modelHealth,
    httpStatus(call) { return call.path === '/api/v2/extract' ? 504 : 200; },
    route(call) { assert.equal(call.path, '/api/v2/extract'); return pending.promise; },
  });
  const before = app.data.get(STORAGE_KEY), writes = app.writes.length;
  app.input('#extractionMode', 'dify');
  app.input('#noticeText', modelNotice);
  app.input('#noticeDate', '2026-10-28');
  app.submit('#noticeForm'); await flush();
  assert.equal(app.find('#parseNotice').disabled, true);
  pending.resolve({ error: '模型提取等待超时，本次未取得候选；请检查工作流运行记录后再决定是否重试。', code: 'model_timeout' });
  await flush();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/health', '/api/v2/extract']);
  assert.match(app.find('#appMessage').textContent, /提取未完成.*模型提取等待超时/);
  assert.doesNotMatch(app.find('#appMessage').textContent, /没有识别到行动事项/);
  assert.equal(app.find('#noticeText').value, modelNotice);
  assert.equal(app.find('#noticeDate').value, '2026-10-28');
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.equal(app.writes.length, writes);
  assert.equal(app.stored().tasks[0].status, 'confirmed');
  assert.equal(app.find('#parseNotice').disabled, false);
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
  assert.equal(app.find('[data-action="confirm"]').textContent, '已确认');
  assert.equal(app.find('[data-action="confirm"]').getAttribute('aria-disabled'), 'true');
  assert.match(app.find('[data-task-confirmation]').textContent, /事项已确认/);
  await flush();
  assert.equal(app.stored().tasks[0].status, 'confirmed');
});

test('the basketball task focuses missing priority and confirms after an explicit choice without a request', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot() });
  app.input('[data-task-field="must_do"]', 'false');
  app.input('[data-task-field="fixed_start_at"]', '2026-10-26T18:00');
  app.input('[data-task-field="fixed_end_at"]', '2026-10-26T20:00');
  await flush();
  const before = app.data.get(STORAGE_KEY);
  app.click('[data-action="confirm"]');
  const priority = app.find('[data-task-field="priority"]');
  assert.strictEqual(app.document.activeElement, priority);
  assert.equal(priority.getAttribute('aria-invalid'), 'true');
  assert.match(app.document.getElementById(priority.getAttribute('aria-describedby')).textContent, /优先级/);
  assert.match(app.find('[data-task-error]').textContent, /尚未确认/);
  assert.equal(app.find('[data-task-confirmation]').textContent, '');
  assert.equal(app.data.get(STORAGE_KEY), before);
  app.input('[data-task-field="priority"]', '50');
  assert.equal(app.find('[data-confirmation-error]'), null);
  assert.equal(priority.getAttribute('aria-invalid'), 'false');
  assert.equal(priority.hasAttribute('aria-describedby'), false);
  app.click('[data-action="confirm"]');
  await flush();
  assert.equal(app.find('[data-action="confirm"]').textContent, '已确认');
  assert.match(app.find('[data-task-confirmation]').textContent, /事项已确认/);
  assert.equal(app.stored().tasks[0].status, 'confirmed');
  assert.equal(app.stored().tasks[0].priority, 50);
  assert.equal(app.stored().tasks[0].must_do, false);
  assert.deepEqual(app.calls, []);
});

test('missing or reversed fixed end time has an adjacent error and leaves entered times intact', async t => {
  const app = await boot(t, { initialRaw: basketballSnapshot() });
  app.input('[data-task-field="must_do"]', 'false');
  app.input('[data-task-field="priority"]', '0');
  app.input('[data-task-field="fixed_start_at"]', '2026-10-26T18:00');
  app.click('[data-action="confirm"]');
  const end = app.find('[data-task-field="fixed_end_at"]');
  assert.strictEqual(app.document.activeElement, end);
  assert.match(app.find('[data-confirmation-error]').textContent, /结束时间/);
  app.input('[data-task-field="fixed_end_at"]', '2026-10-26T17:00');
  app.click('[data-action="confirm"]');
  assert.strictEqual(app.document.activeElement, end);
  assert.match(app.find('[data-confirmation-error]').textContent, /晚于开始/);
  assert.equal(app.find('[data-task-field="fixed_start_at"]').value, '2026-10-26T18:00');
  assert.equal(end.value, '2026-10-26T17:00');
  await flush();
  assert.equal(app.stored().tasks[0].status, 'draft');
});

test('confirmation success survives another card render; repeat clicks do not create a revision or request', async t => {
  const app = await nineMinutes(t);
  const before = app.data.get(STORAGE_KEY);
  const writes = app.writes.length;
  for (let click = 0; click < 5; click += 1) app.click('[data-action="confirm"]');
  await flush();
  assert.equal(app.data.get(STORAGE_KEY), before);
  assert.equal(app.writes.length, writes);
  app.click('#addTask');
  assert.equal(app.find('[data-action="confirm"]').textContent, '已确认');
  assert.match(app.find('[data-task-confirmation]').textContent, /事项已确认/);
  assert.deepEqual(app.calls, []);
});

test('editing confirmed information clears success feedback and requires a fresh confirmation', async t => {
  const app = await nineMinutes(t);
  app.input('[data-task-field="priority"]', '30');
  assert.equal(app.find('[data-action="confirm"]').textContent, '已逐项核对，确认事项');
  assert.equal(app.find('[data-action="confirm"]').getAttribute('aria-disabled'), 'false');
  assert.equal(app.find('[data-task-confirmation]').textContent, '');
  await flush();
  assert.equal(app.stored().tasks[0].status, 'draft');
});

test('a rejected visible field is focused at confirmation and its raw input is preserved', async t => {
  const app = await nineMinutes(t);
  const raw = '地'.repeat(501);
  app.input('[data-task-field="location"]', raw);
  app.click('[data-action="confirm"]');
  const location = app.find('[data-task-field="location"]');
  assert.strictEqual(app.document.activeElement, location);
  assert.equal(location.closest('details').open, true);
  assert.equal(location.value, raw);
  assert.equal(location.getAttribute('aria-invalid'), 'true');
  assert.match(app.find('[data-task-error]').textContent, /尚未确认/);
  assert.equal(app.find('[data-task-confirmation]').textContent, '');
  assert.deepEqual(app.calls, []);
});

function capacitySnapshot({ reference = '2026-10-26T16:42:46.800+08:00', fixedOnly = false } = {}) {
  let state = createSnapshot({ referenceTime: reference });
  if (!fixedOnly) {
    const work = createTask();
    state = addTask(state, work);
    state = editTask(state, work.id, { title: '虚构复现：课程报告', must_do: true, priority: 90, deadline_at: '2026-10-26T23:59:00+08:00', remaining_minutes: 180, splittable: true, min_block_minutes: 1 });
    state = confirmTask(state, work.id);
  }
  const event = createTask('fixed');
  state = addTask(state, event);
  state = editTask(state, event.id, { title: '虚构复现：观赛', must_do: false, priority: 10, fixed_start_at: '2026-10-26T18:00:00+08:00', fixed_end_at: '2026-10-26T20:00:00+08:00' });
  state = confirmTask(state, event.id);
  return serializeSnapshot(setAvailability(state, [{ start: '2026-10-26T16:41:00+08:00', end: '2026-10-26T22:00:00+08:00' }]));
}

test('a fresh workbench starts at a visible whole minute without counting elapsed seconds', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-26T16:42:46.800+08:00'));
  const app = await boot(t);
  assert.equal(app.find('#referenceTime').value, '2026-10-26T16:43');
  assert.equal(app.find('#referencePrecision').hidden, true);
  assert.deepEqual(app.writes, []);
  app.click('#addTask');
  await flush();
  assert.equal(app.stored().reference_time, '2026-10-26T08:43:00.000Z');
  assert.deepEqual(app.calls, []);
});

test('using current time preserves exact minute boundaries and carries midnight forward', async t => {
  let now = Date.parse('2026-10-26T16:42:00+08:00');
  t.mock.method(Date, 'now', () => now);
  const app = await boot(t, { initialRaw: capacitySnapshot() });
  for (const [instant, display] of [
    ['2026-10-26T16:42:00+08:00', '2026-10-26T16:42'],
    ['2026-10-26T16:42:00.001+08:00', '2026-10-26T16:43'],
    ['2026-10-26T23:59:59.999+08:00', '2026-10-27T00:00'],
  ]) {
    now = Date.parse(instant);
    app.click('#useCurrentTime');
    await flush();
    assert.equal(app.find('#referenceTime').value, display);
    assert.equal(Date.parse(app.stored().reference_time) % 60000, 0);
    assert.ok(Date.parse(app.stored().reference_time) >= now);
    assert.ok(Date.parse(app.stored().reference_time) - now < 60000);
    assert.equal(app.find('#referencePrecision').hidden, true);
  }
  assert.deepEqual(app.calls, []);
});

test('legacy precise time is explicitly shown, preserved in requests and explained beside fractional capacity', async t => {
  const original = capacitySnapshot();
  const app = await boot(t, { initialRaw: original, route(call) {
    const result = calculated(call.body, { available: 197.22 });
    result.capacity_checks[0].free_intervals = [
      { start: '2026-10-26T16:42:46.800000+08:00', end: '2026-10-26T18:00:00+08:00' },
      { start: '2026-10-26T20:00:00+08:00', end: '2026-10-26T22:00:00+08:00' },
    ];
    return result;
  } });
  assert.equal(app.find('#referenceTime').value, '2026-10-26T16:42');
  assert.equal(app.find('#referencePrecision').hidden, false);
  assert.match(app.find('#referencePrecision').textContent, /实际计算起点：2026-10-26 16:42:46\.8/);
  assert.deepEqual(app.writes, []);
  app.click('#calculate');
  await flush();
  assert.equal(app.calls.at(-1).body.reference_time, '2026-10-26T16:42:46.800+08:00');
  assert.equal(app.data.get(STORAGE_KEY), original);
  assert.match(app.find('#resultOutput .result-caption').textContent, /16:42:46\.8/);
  assert.match(app.find('#resultOutput tbody tr').children[2].textContent, /197\.22 分钟/);
  assert.match(app.find('#resultOutput details').textContent, /16:42:46\.8 至 2026-10-26 18:00/);
  assert.match(app.find('#resultOutput').textContent, /容量没有超出/);
});

test('manually choosing a whole minute removes the old precision explanation without hiding an old result', async t => {
  const app = await boot(t, { initialRaw: capacitySnapshot() });
  app.click('#calculate'); await flush();
  app.input('#referenceTime', '2026-10-26T16:42');
  await flush();
  assert.equal(app.find('#referencePrecision').hidden, true);
  assert.equal(app.find('#referencePrecision').textContent, '');
  assert.equal(app.stored().reference_time, '2026-10-26T16:42:00+08:00');
  assert.equal(app.find('#resultOutput table'), null);
  assert.match(app.find('#resultOutput').textContent, /原结果已失效/);
});

test('a fixed-only checklist does not claim that a nonexistent workload capacity check passed', async t => {
  const app = await boot(t, { initialRaw: capacitySnapshot({ fixedOnly: true }), route(call) {
    return { ...calculated(call.body, { required: 0, available: 0 }), capacity_checks: [] };
  } });
  app.click('#calculate');
  await flush();
  assert.match(app.find('#resultOutput').textContent, /没有可列出的工作量容量节点/);
  assert.doesNotMatch(app.find('#resultOutput').textContent, /容量没有超出/);
  assert.equal(app.find('#resultOutput table'), null);
});

test('clearing the checklist starts the next snapshot at a whole minute and retains the rounding rule', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-26T16:42:46.800+08:00'));
  const app = await boot(t, { initialRaw: capacitySnapshot() });
  app.click('#clearSnapshot');
  await flush();
  assert.equal(app.find('#referenceTime').value, '2026-10-26T16:43');
  assert.equal(app.find('#referencePrecision').hidden, true);
  assert.match(app.find('#referenceTimeHelp').textContent, /不足一分钟顺延/);
  assert.equal(app.stored().tasks.length, 0);
  assert.equal(Date.parse(app.stored().reference_time) % 60000, 0);
  assert.deepEqual(app.calls, []);
});
