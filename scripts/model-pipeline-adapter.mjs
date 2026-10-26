// Pure Node handoff check. No browser, renderer, fetch, or real model call.
import { readFileSync } from 'node:fs';
import { modelCandidates } from '../model-candidates.js';
import { createSnapshot, addSource, addTask, serializeSnapshot } from '../task-state.js';
const records = JSON.parse(readFileSync(0, 'utf8'));
const snapshots = records.map(record => {
  const source = { id: `source-${record.id}`, kind: 'synthetic', text: record.text, published_at: null };
  const tasks = modelCandidates(record.result, source);
  let snapshot = createSnapshot({ referenceTime: '2026-10-26T00:00:00+08:00' });
  snapshot = addSource(snapshot, source);
  for (const task of tasks) snapshot = addTask(snapshot, task);
  return JSON.parse(serializeSnapshot(snapshot));
});
process.stdout.write(JSON.stringify(snapshots));
