/** Real HTTP + actual app module, in jsdom. No browser/layout/screenshots. */
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
const flush = () => setTimeout(20);
async function settlePlan() {
  const deadline = Date.now() + 10000;
  while (doc.getElementById('resultOutput').getAttribute('aria-busy') === 'true' && Date.now() < deadline) await flush();
  assert.notEqual(doc.getElementById('resultOutput').getAttribute('aria-busy'), 'true', 'request must settle');
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
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ kind: 'real_temporary_http_and_jsdom_not_browser', ui_version: doc.querySelector('meta[name="sixu-ui-version"]').content, backend_version: responses.find(item => item.path === '/api/health').payload.version, passed: cases.length, cases, request_paths: calls }, null, 2));
} finally { window.close(); }
