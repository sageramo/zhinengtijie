/** Real HTTP + actual app module, in jsdom. No browser/layout/screenshots.
 * Pass --scenarios to additionally exercise hypothetical comparison/adoption.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { STORAGE_KEY } from '../task-state.js';

const base = process.argv[2];
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Pass a temporary loopback test API.');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8873/', runScripts: 'outside-only' });
const { window } = dom;
const data = new Map();
const calls = [];
const nativeFetch = globalThis.fetch;
window.CAMPUS_AGENT_API = base;
window.confirm = () => true;
window.HTMLElement.prototype.scrollIntoView = function () {};
Object.defineProperty(window, 'localStorage', { value: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } });
Object.defineProperty(window.navigator, 'locks', { value: { request: async (_name, _options, callback) => callback() } });
const responses = [];
for (const [name, value] of Object.entries({ window, document: window.document, location: window.location, navigator: window.navigator, fetch: async (url, options) => {
  calls.push(new URL(url).pathname);
  assert.ok(['/api/health', '/api/v2/plan'].includes(new URL(url).pathname));
  const response = await nativeFetch(url, options);
  responses.push({ path: new URL(url).pathname, status: response.status, payload: await response.clone().json() });
  return response;
} })) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const errors = [];
window.addEventListener('error', event => { errors.push(String(event.error)); });
const doc = window.document;
const click = selector => { assert.ok(doc.querySelector(selector), selector); doc.querySelector(selector).click(); };
const input = (selector, value) => { const node = doc.querySelector(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })); };
const submit = selector => { const node = doc.querySelector(selector); assert.ok(node, selector); node.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
const flush = () => setTimeout(20);
async function settlePlan() {
  const deadline = Date.now() + 10000;
  while (doc.getElementById('resultOutput').getAttribute('aria-busy') === 'true' && Date.now() < deadline) await flush();
  assert.notEqual(doc.getElementById('resultOutput').getAttribute('aria-busy'), 'true', 'request must settle');
}
async function settleScenario() {
  const deadline = Date.now() + 10000;
  while (doc.getElementById('scenarioOutput').getAttribute('aria-busy') === 'true' && Date.now() < deadline) await flush();
  assert.notEqual(doc.getElementById('scenarioOutput').getAttribute('aria-busy'), 'true', 'hypothesis must settle');
}
const stored = () => JSON.parse(data.get(STORAGE_KEY));
const confirmAll = () => { for (const task of stored().tasks) click(`[data-task-id="${task.id}"] [data-action="confirm"]`); };
const cases = [];
try {
  await import('../agent.js'); await flush();
  assert.deepEqual(calls, []);
  click('#loadEveningPlan'); await flush();
  assert.equal(stored().tasks.length, 3); assert.ok(stored().tasks.every(task => task.status === 'draft'));
  click('#generatePlan'); assert.deepEqual(calls, []);
  confirmAll(); await flush();
  const before = data.get(STORAGE_KEY);
  click('#generatePlan'); await settlePlan();
  const evening = responses.filter(item => item.path === '/api/v2/plan').at(-1);
  assert.equal(evening.status, 200); assert.equal(evening.payload.status, 'feasible_found');
  assert.equal(evening.payload.validation.passed, true);
  assert.ok(doc.querySelector('.result-success')); assert.equal(doc.querySelectorAll('.schedule-row').length, 4);
  assert.equal(data.get(STORAGE_KEY), before);
  cases.push({ id: 'evening_three_tasks', passed: true, status: evening.payload.status, independently_validated: true, schedule: evening.payload.schedule, snapshot_unchanged: true });
  const priority = doc.querySelector('[data-task-field="priority"]');
  priority.value = '65'; priority.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('.schedule-row'), null);
  cases.push({ id: 'edit_invalidates_schedule', passed: true });
  click('#loadNineMinutes'); await flush(); confirmAll(); await flush();
  click('#generatePlan'); await settlePlan();
  const shortage = responses.filter(item => item.path === '/api/v2/plan').at(-1).payload;
  assert.equal(shortage.status, 'conflicts_detected'); assert.equal(shortage.schedule.length, 0);
  assert.match(doc.getElementById('resultOutput').textContent, /当前条件存在冲突/);
  cases.push({ id: 'nine_minutes_shortage', passed: true, status: shortage.status, required: shortage.capacity_checks[0].known_required_minutes, available: shortage.capacity_checks[0].available_minutes });
  const work = doc.querySelector('[data-task-field="remaining_minutes"]');
  work.value = '5'; work.dispatchEvent(new window.Event('input', { bubbles: true }));
  confirmAll(); await flush(); click('#generatePlan'); await settlePlan();
  const short = responses.filter(item => item.path === '/api/v2/plan').at(-1).payload;
  assert.equal(short.status, 'feasible_found'); assert.equal(doc.querySelectorAll('.schedule-row').length, 1);
  cases.push({ id: 'change_and_reconfirm_then_replan', passed: true, status: short.status, schedule: short.schedule });
  if (process.argv.includes('--scenarios')) {
    const beforeHypothesis = data.get(STORAGE_KEY);
    input('#scenarioMinutes', '4'); submit('#scenarioForm'); await settleScenario();
    const measured = responses.filter(item => item.path === '/api/v2/plan').at(-1).payload;
    assert.equal(measured.status, 'feasible_found');
    assert.equal(data.get(STORAGE_KEY), beforeHypothesis);
    assert.equal(doc.querySelector('[data-scenario-action="adopt"]').disabled, true);
    cases.push({ id: 'work_hypothesis_readonly', passed: true, preview_minutes: 4, actual_minutes: stored().tasks[0].remaining_minutes, adoption_requires_consent: true });
    const beforeAdoptionCalls = calls.length;
    click('#scenarioReality'); click('[data-scenario-action="adopt"]'); await flush();
    assert.equal(stored().tasks[0].remaining_minutes, 4); assert.equal(stored().tasks[0].status, 'draft');
    assert.equal(doc.querySelector('.schedule-row'), null);
    click('#generatePlan'); assert.equal(calls.length, beforeAdoptionCalls);
    confirmAll(); await flush(); click('#generatePlan'); await settlePlan();
    assert.equal(responses.filter(item => item.path === '/api/v2/plan').at(-1).payload.status, 'feasible_found');
    cases.push({ id: 'work_adoption_requires_reconfirmation_and_formal_replan', passed: true });
    const beforeOverlap = data.get(STORAGE_KEY);
    const reference = stored().reference_time;
    const toInput = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16);
    input('#scenarioKind', 'availability');
    input('#scenarioStart', toInput(reference)); input('#scenarioEnd', toInput(new Date(Date.parse(reference) + 120 * 60000).toISOString()));
    submit('#scenarioForm'); await settleScenario();
    const overlap = responses.filter(item => item.path === '/api/v2/plan').at(-1).payload;
    assert.equal(overlap.capacity_checks[0].available_minutes, 9);
    assert.equal(data.get(STORAGE_KEY), beforeOverlap);
    click('[data-scenario-action="discard"]');
    assert.equal(data.get(STORAGE_KEY), beforeOverlap);
    cases.push({ id: 'overlap_and_time_after_deadline_do_not_inflate_capacity', passed: true, available: 9, discarded_without_changes: true });
    click('#loadEveningPlan'); await flush(); confirmAll(); await flush();
    click('[data-remove-availability="0"]'); click('#addAvailability');
    const start = toInput(stored().reference_time);
    input('#availabilityStart', start); input('#availabilityEnd', `${start.slice(0, 10)}T19:00`); submit('#availabilityForm'); await flush();
    click('#generatePlan'); await settlePlan();
    const scarce = responses.filter(item => item.path === '/api/v2/plan').at(-1).payload;
    assert.equal(scarce.status, 'conflicts_detected');
    const beforeExtraTime = data.get(STORAGE_KEY);
    input('#scenarioKind', 'availability');
    input('#scenarioStart', `${start.slice(0, 10)}T20:00`); input('#scenarioEnd', `${start.slice(0, 10)}T21:00`); submit('#scenarioForm'); await settleScenario();
    const enough = responses.filter(item => item.path === '/api/v2/plan').at(-1).payload;
    assert.equal(enough.status, 'feasible_found'); assert.equal(enough.validation.passed, true);
    const deficit = plan => Math.max(0, ...plan.capacity_checks.map(row => row.known_required_minutes - row.available_minutes));
    assert.equal(deficit(scarce), 60); assert.equal(deficit(enough), 0);
    assert.equal(data.get(STORAGE_KEY), beforeExtraTime);
    cases.push({ id: 'extra_time_hypothesis_resolves_real_capacity_deficit', passed: true, baseline_status: scarce.status, hypothetical_status: enough.status, before_deficit: 60, after_deficit: 0, snapshot_unchanged: true });
    const tasksBeforeAdoption = stored().tasks;
    click('#scenarioReality'); click('[data-scenario-action="adopt"]'); await flush();
    assert.equal(stored().availability.length, 2); assert.deepEqual(stored().tasks, tasksBeforeAdoption);
    assert.equal(doc.querySelector('.schedule-row'), null);
    click('#generatePlan'); await settlePlan();
    const formal = responses.filter(item => item.path === '/api/v2/plan').at(-1).payload;
    assert.equal(formal.status, 'feasible_found'); assert.equal(formal.validation.passed, true);
    cases.push({ id: 'extra_time_adoption_preserves_tasks_and_requires_formal_replan', passed: true, schedule: formal.schedule });
    if (process.argv.includes('--validation')) {
      const beforeInvalid = calls.length;
      const saved = data.get(STORAGE_KEY);
      const reference = Date.parse(stored().reference_time);
      input('#scenarioKind', 'availability');
      input('#scenarioStart', toInput(new Date(reference - 60000).toISOString()));
      input('#scenarioEnd', toInput(new Date(reference + 1200000).toISOString()));
      submit('#scenarioForm'); await flush();
      assert.equal(calls.length, beforeInvalid);
      assert.equal(doc.activeElement.id, 'scenarioStart');
      assert.equal(doc.getElementById('scenarioStart').getAttribute('aria-invalid'), 'true');
      assert.notEqual(doc.getElementById('scenarioEnd').getAttribute('aria-invalid'), 'true');
      assert.ok(doc.getElementById('scenarioStart').getAttribute('aria-describedby').includes('scenarioValidationError'));
      cases.push({ id: 'invalid_start_focuses_and_labels_correct_field_without_http', passed: true });
      input('#scenarioStart', toInput(new Date(reference + 600000).toISOString()));
      submit('#scenarioForm'); await settleScenario();
      assert.equal(responses.filter(item => item.path === '/api/v2/plan').at(-1).payload.status, 'feasible_found');
      assert.equal(doc.querySelector('#scenarioForm [aria-invalid="true"]'), null);
      assert.equal(doc.querySelector('#scenarioForm [aria-describedby~="scenarioValidationError"]'), null);
      assert.equal(data.get(STORAGE_KEY), saved);
      cases.push({ id: 'corrected_start_clears_error_and_completes_http_trial', passed: true, snapshot_unchanged: true });
      const ids = Array.from(doc.querySelectorAll('[id]'), node => node.id);
      assert.equal(new Set(ids).size, ids.length, 'authored document IDs must remain unique');
      let fields = 0, references = 0;
      for (const node of doc.querySelectorAll('input,select,textarea')) {
        if (node.closest('[hidden]') || node.type === 'hidden') continue;
        assert.ok(node.labels?.length || node.getAttribute('aria-label') || node.getAttribute('aria-labelledby'), `field needs a label: ${node.id || node.dataset.taskField}`);
        fields += 1;
      }
      for (const node of doc.querySelectorAll('[aria-describedby],[aria-labelledby]')) {
        for (const attribute of ['aria-describedby', 'aria-labelledby']) {
          for (const id of (node.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
            assert.ok(doc.getElementById(id), `missing authored accessibility reference: ${id}`);
            references += 1;
          }
        }
      }
      cases.push({ id: 'authored_semantics_unique_ids_labelled_fields_and_resolved_references', passed: true, checked_fields: fields, checked_references: references, rendered_accessibility_test: false });
    }
  }
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ kind: 'real_http_and_jsdom_not_browser', ui_version: doc.querySelector('meta[name="sixu-ui-version"]').content, backend_version: responses.find(item => item.path === '/api/health').payload.version, passed: cases.length, cases, request_paths: calls }, null, 2));
} finally { window.close(); }
