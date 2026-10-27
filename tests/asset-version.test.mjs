// Static manifest checks only: no browser, layout engine, HTTP or cache emulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
for (const base of ['http://127.0.0.1:8873/', 'https://sageramo.github.io/campus-action-agent/']) {
  test(`all workbench assets share a version including transitive module imports at ${base}`, () => {
    const dom = new JSDOM(html, { url: base });
    try {
      const doc = dom.window.document;
      const version = doc.querySelector('meta[name="sixu-ui-version"]').content;
      assert.match(version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
      assert.ok(doc.getElementById('uiVersion').textContent.includes(version));
      for (const node of doc.querySelectorAll('link[rel="stylesheet"],script[src]')) {
        const target = new URL(node.getAttribute('href') || node.getAttribute('src'), base);
        assert.equal(target.searchParams.get('v'), version);
        const filename = target.pathname.slice(new URL(base).pathname.length);
        assert.ok(readFileSync(new URL(`../${filename}`, import.meta.url)).length);
      }
      const imports = JSON.parse(doc.querySelector('script[type="importmap"]').textContent).imports;
      const visited = new Set();
      const entry = doc.querySelector('script[type="module"][src]').getAttribute('src');
      const inspect = path => {
        if (visited.has(path)) return;
        visited.add(path);
        const source = readFileSync(new URL(`../${path.replace(/^\.\//, '')}`, import.meta.url), 'utf8');
        for (const [, specifier] of source.matchAll(/from\s+['"]([.][/]([^'"]+)[.]js)['"]/g)) {
          assert.ok(Object.hasOwn(imports, specifier), `missing import-map entry for ${specifier}`);
          const mapped = new URL(imports[specifier], base);
          assert.equal(mapped.searchParams.get('v'), version);
          assert.equal(mapped.origin + mapped.pathname, new URL(specifier, base).href);
          inspect(specifier);
        }
      };
      inspect(entry.split('?')[0]);
      assert.deepEqual([...visited].sort(), ['./agent.js', './model-candidates.js', './planning-result.js', './snapshot-store.js', './task-state.js', './time-review.js']);
    } finally { dom.window.close(); }
  });
}
