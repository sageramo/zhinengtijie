// Router behaviour that needs no service: page arrows and arrow keys across the four workbench pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ROUTER = readFileSync(new URL('../router.js', import.meta.url), 'utf8');

function boot(hash) {
  const dom = new JSDOM(HTML, { url: `http://localhost:8873/${hash}`, runScripts: 'outside-only' });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.scrollTo = () => {};
  window.eval(ROUTER);
  const doc = window.document;
  const key = (target, name) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }));
  return { window, doc, key, current: () => doc.documentElement.dataset.current, find: selector => doc.querySelector(selector) };
}

test('side arrows step through 研墨 → 铺纸 → 画卷 and hide at the ends', () => {
  const app = boot('#/import');
  assert.equal(app.current(), 'import');
  assert.equal(app.find('.page-arrow.is-prev').hidden, true, 'no page before 研墨');
  assert.equal(app.find('.page-arrow.is-next').getAttribute('aria-label'), '下一页：铺纸');
  assert.equal(app.find('.page-arrow.is-next .page-arrow-label').textContent, '铺纸');
  app.find('.page-arrow.is-next').click();
  assert.equal(app.current(), 'time');
  assert.equal(app.find('.page-arrow.is-prev').getAttribute('aria-label'), '上一页：研墨');
});

test('the arrow keys turn pages across 3 primary routes, and #/items highlights 研墨', () => {
  const app = boot('#/time');
  app.key(app.doc.body, 'ArrowRight');
  assert.equal(app.current(), 'calendar');
  assert.equal(app.find('.page-arrow.is-next').hidden, true, 'no page after 画卷');
  app.key(app.find('#noticeText'), 'ArrowLeft');
  assert.equal(app.current(), 'calendar', 'inside a text box the arrow keys move the caret');
  app.doc.body.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
  assert.equal(app.current(), 'calendar');
  app.key(app.doc.body, 'ArrowLeft');
  assert.equal(app.current(), 'time');

  app.window.SixuRouter.go('items');
  assert.equal(app.current(), 'items');
  assert.equal(app.find('[data-tab="import"]').getAttribute('aria-current'), 'page', 'items keeps 研墨 highlighted');
  assert.ok([...app.doc.querySelectorAll('.page-arrow')].every(button => button.hidden), 'subpage hides side arrows');
});

test('the root URL opens the landing page (home)', () => {
  const app = boot('');
  assert.equal(app.current(), 'home');
  app.window.close();
});

test('the landing page has no page arrows and the keys do nothing there', () => {
  const app = boot('#/');
  assert.equal(app.current(), 'home');
  assert.ok([...app.doc.querySelectorAll('.page-arrow')].every(button => button.hidden));
  app.key(app.doc.body, 'ArrowRight');
  assert.equal(app.current(), 'home');
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('leaving the workbench for the landing gathers the ink veil, switches, then lets it recede', async () => {
  const app = boot('#/calendar');
  app.window.SixuRouter.go('home');
  const veil = app.find('#routeVeil');
  assert.equal(veil.className, 'route-veil is-back');
  assert.equal(app.current(), 'calendar', 'the page switches only once the veil covers it');
  await sleep(330);
  assert.equal(app.current(), 'home');
  assert.equal(veil.className, 'route-veil is-back is-recede');
  await sleep(800);
  assert.equal(veil.className, 'route-veil');
});

test('the opening plays the same ink veil and can be skipped', async () => {
  const app = boot('');
  let opened = 0;
  const skip = app.window.SixuVeil.intro(() => { opened += 1; });
  const veil = app.find('#routeVeil');
  assert.equal(veil.className, 'route-veil is-on is-intro');
  skip();
  skip();
  assert.equal(opened, 1, 'skipping twice opens once');
  assert.equal(veil.className, 'route-veil is-on is-intro is-out');
  await sleep(700);
  assert.equal(veil.className, 'route-veil');
});
