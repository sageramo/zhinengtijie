// In-memory handoff only; no browser, rendering, storage, fetch, or model call.
import { readFileSync } from 'node:fs';
import { modelCandidates } from '../model-candidates.js';
import { createSnapshot, addSource, addTask, serializeSnapshot } from '../task-state.js';
const records = JSON.parse(readFileSync(0, 'utf8'));
const output = records.map(record => {
  try {
    const source = { id: `evaluation-${record.id}`, kind: record.source_kind ?? 'synthetic', text: record.text, published_at: null };
    let snapshot = addSource(createSnapshot({ referenceTime: record.reference_time ?? '2026-10-26T00:00:00+08:00' }), source);
    for (const task of modelCandidates(record.result, source)) snapshot = addTask(snapshot, task);
    return { id: record.id, accepted: true, snapshot: JSON.parse(serializeSnapshot(snapshot)) };
  } catch {
    return { id: record.id, accepted: false, error: 'draft_adapter_rejected' };
  }
});
process.stdout.write(JSON.stringify(output));
