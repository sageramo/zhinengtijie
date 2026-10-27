// Node subprocesses only, no browser, renderer, networking or user storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/evaluation-drafts.mjs', import.meta.url));
function handoff(extra = {}) {
  const record = { id: 'source-check', text: '一条用于来源测试的说明。',
    result: { schema_version: 1, provider: 'dify', parsing_status: 'needs_confirmation', candidates: [], warnings: [] }, ...extra };
  const run = spawnSync(process.execPath, [script], { input: JSON.stringify([record]), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout)[0];
}
test('old authored fixtures retain their synthetic source by default', () => {
  assert.equal(handoff().snapshot.sources[0].kind, 'synthetic');
});
test('real notice review preserves pasted provenance and does not invent a publication timestamp', () => {
  const output = handoff({ source_kind: 'pasted_notice', reference_time: '2031-03-14T10:00:00+08:00' });
  assert.equal(output.accepted, true);
  assert.equal(output.snapshot.sources[0].kind, 'pasted_notice');
  assert.equal(output.snapshot.sources[0].published_at, null);
  assert.equal(output.snapshot.reference_time, '2031-03-14T10:00:00+08:00');
});
test('unsupported provenance is rejected rather than silently relabelled as synthetic', () => {
  assert.equal(handoff({ source_kind: 'unknown' }).accepted, false);
});
