import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../snapshot-store.js';
import { createSnapshot, serializeSnapshot, STORAGE_KEY } from '../task-state.js';

const lockName = key => `sixu.snapshot-store:${key}`;
const snapshot = (label, revision = 1) => ({ ...createSnapshot({ referenceTime: '2026-10-25T12:00:00+08:00' }), revision, label });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class SharedStorage {
  values = new Map();
  writes = 0;
  readError = null;
  writeError = null;
  constructor(raw = null, key = STORAGE_KEY) { if (raw !== null) this.values.set(key, raw); }
  getItem(key) { if (this.readError) throw this.readError; return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.writeError) throw this.writeError; this.values.set(key, value); this.writes += 1; }
}

/** Browser Web Locks' exclusive queue, shared by all test store instances. */
class ExclusiveLocks {
  tails = new Map();
  requests = [];
  request(name, options, callback) {
    assert.equal(options.mode, 'exclusive');
    this.requests.push(name);
    const previous = this.tails.get(name) ?? Promise.resolve();
    const released = deferred();
    this.tails.set(name, released.promise);
    return previous.then(() => callback({ name, mode: 'exclusive' })).finally(() => {
      released.resolve();
      if (this.tails.get(name) === released.promise) this.tails.delete(name);
    });
  }
  async hold(key = STORAGE_KEY) {
    const entered = deferred();
    const release = deferred();
    const finished = this.request(lockName(key), { mode: 'exclusive' }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    return async () => { release.resolve(); await finished; };
  }
}

test('writes under an exclusive key-specific lock and advances expected bytes', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const store = new SnapshotStore(storage, { lockManager: locks });
  const first = snapshot('第一版');
  const second = snapshot('第二版', 2);
  assert.deepEqual(await store.save(first), { saved: true, raw: serializeSnapshot(first) });
  assert.equal((await store.save(second)).saved, true);
  assert.equal(storage.getItem(STORAGE_KEY), serializeSnapshot(second));
  assert.equal(storage.writes, 2);
  assert.deepEqual(locks.requests, [lockName(STORAGE_KEY), lockName(STORAGE_KEY)]);
});

test('simultaneous equal-revision branches never overwrite the first tab', async () => {
  const original = serializeSnapshot(snapshot('原始', 0));
  const storage = new SharedStorage(original);
  const locks = new ExclusiveLocks();
  const a = new SnapshotStore(storage, { lockManager: locks, initialRaw: original });
  const b = new SnapshotStore(storage, { lockManager: locks, initialRaw: original });
  const left = snapshot('页面甲独立修改', 1);
  const right = snapshot('页面乙独立修改', 1);
  const results = await Promise.all([a.save(left), b.save(right)]);
  assert.equal(results.filter(result => result.saved).length, 1);
  assert.equal(results.filter(result => result.conflict).length, 1);
  const saved = results.find(result => result.saved);
  const conflict = results.find(result => result.conflict);
  assert.equal(conflict.raw, saved.raw);
  assert.equal(storage.getItem(STORAGE_KEY), saved.raw);
  assert.equal(storage.writes, 1);
});

test('strict byte comparison rejects same snapshot with changed whitespace', async () => {
  const raw = serializeSnapshot(snapshot('数据相同', 1));
  const otherRaw = JSON.stringify(JSON.parse(raw));
  const storage = new SharedStorage(otherRaw);
  const store = new SnapshotStore(storage, { lockManager: new ExclusiveLocks(), initialRaw: raw });
  const result = await store.save(snapshot('新数据', 2));
  assert.equal(result.conflict, true);
  assert.equal(result.raw, otherRaw);
  assert.equal(storage.getItem(STORAGE_KEY), otherRaw);
  assert.equal(storage.writes, 0);
});

test('an unknown nonempty saved value is preserved, including malformed JSON', async () => {
  const storage = new SharedStorage('{损坏且不可默默清空');
  const store = new SnapshotStore(storage, { lockManager: new ExclusiveLocks() });
  const result = await store.save(snapshot('新的空白页'));
  assert.equal(result.conflict, true);
  assert.equal(storage.getItem(STORAGE_KEY), '{损坏且不可默默清空');
  assert.equal(storage.writes, 0);
});

test('missing Web Locks leaves storage untouched instead of unsafe fallback', async () => {
  const storage = new SharedStorage();
  const store = new SnapshotStore(storage, { lockManager: null });
  const result = await store.save(snapshot('只在内存'));
  assert.equal(result.saved, false);
  assert.match(result.error, /仅保留在本页内存/);
  assert.equal(storage.writes, 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('quota errors preserve bytes and do not advance the expected branch', async () => {
  const original = serializeSnapshot(snapshot('原始', 0));
  const storage = new SharedStorage(original);
  const store = new SnapshotStore(storage, { lockManager: new ExclusiveLocks(), initialRaw: original });
  storage.writeError = new Error('QuotaExceededError');
  const failed = await store.save(snapshot('超出配额'));
  assert.equal(failed.saved, false);
  assert.equal(failed.error, 'QuotaExceededError');
  assert.equal(storage.getItem(STORAGE_KEY), original);
  assert.equal(storage.writes, 0);
  storage.writeError = null;
  const retried = await store.save(snapshot('重试'));
  assert.equal(retried.saved, true);
  assert.equal(storage.writes, 1);
});

test('storage read errors fail closed without calling setItem', async () => {
  const storage = new SharedStorage();
  storage.readError = new Error('SecurityError');
  const store = new SnapshotStore(storage, { lockManager: new ExclusiveLocks() });
  assert.deepEqual(await store.save(snapshot('未写入')), { saved: false, error: 'SecurityError' });
  assert.equal(storage.writes, 0);
});

test('rejected lock requests leave bytes unchanged', async () => {
  const storage = new SharedStorage();
  const locks = { request: () => Promise.reject(new Error('lock unavailable')) };
  const store = new SnapshotStore(storage, { lockManager: locks });
  assert.deepEqual(await store.save(snapshot('未写入')), { saved: false, error: 'lock unavailable' });
  assert.equal(storage.writes, 0);
});

test('rapid queued edits persist only the latest serialized snapshot', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const release = await locks.hold();
  const store = new SnapshotStore(storage, { lockManager: locks });
  const latest = snapshot('第三次修改', 3);
  const saves = [store.save(snapshot('第一次修改', 1)), store.save(snapshot('第二次修改', 2)), store.save(latest)];
  await release();
  const results = await Promise.all(saves);
  assert.equal(results[0].superseded, true);
  assert.equal(results[1].superseded, true);
  assert.equal(results[0].saved, false);
  assert.equal(results[1].saved, false);
  assert.equal(results[2].saved, true);
  assert.equal(results[2].superseded, undefined);
  assert.equal(storage.getItem(STORAGE_KEY), serializeSnapshot(latest));
  assert.equal(storage.writes, 1);
});

test('caller mutation after queuing does not mutate the captured save', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const release = await locks.hold();
  const store = new SnapshotStore(storage, { lockManager: locks });
  const input = snapshot('排队时内容');
  const expected = serializeSnapshot(input);
  const saving = store.save(input);
  input.label = '后来更改';
  await release();
  assert.equal((await saving).saved, true);
  assert.equal(storage.getItem(STORAGE_KEY), expected);
});

test('adopting external bytes cancels queued old saves then enables the adopted branch', async () => {
  const original = serializeSnapshot(snapshot('原始', 0));
  const adopted = serializeSnapshot(snapshot('外部版本', 1));
  const storage = new SharedStorage(original);
  const locks = new ExclusiveLocks();
  const release = await locks.hold();
  const store = new SnapshotStore(storage, { lockManager: locks, initialRaw: original });
  const obsolete = store.save(snapshot('待撤回的本页修改', 1));
  storage.setItem(STORAGE_KEY, adopted);
  store.adoptRaw(adopted);
  await release();
  assert.deepEqual(await obsolete, { saved: false, superseded: true });
  assert.equal(storage.getItem(STORAGE_KEY), adopted);
  const next = snapshot('在接纳版本上继续', 2);
  assert.equal((await store.save(next)).saved, true);
  assert.equal(storage.getItem(STORAGE_KEY), serializeSnapshot(next));
});

test('invalidate cancels pending saves without discarding the known stored branch', async () => {
  const original = serializeSnapshot(snapshot('原始', 0));
  const storage = new SharedStorage(original);
  const locks = new ExclusiveLocks();
  const release = await locks.hold();
  const store = new SnapshotStore(storage, { lockManager: locks, initialRaw: original });
  const obsolete = store.save(snapshot('旧修改'));
  store.invalidate();
  await release();
  assert.deepEqual(await obsolete, { saved: false, superseded: true });
  assert.equal(storage.getItem(STORAGE_KEY), original);
  assert.equal(storage.writes, 0);
  assert.equal((await store.save(snapshot('新修改'))).saved, true);
});

test('a completed older write is explicitly superseded before its promise returns', async () => {
  const storage = new SharedStorage();
  const firstWritten = deferred();
  const releaseFirstResponse = deferred();
  let requests = 0;
  const locks = new ExclusiveLocks();
  const delayedLocks = {
    async request(name, options, callback) {
      const first = ++requests === 1;
      const result = await locks.request(name, options, callback);
      if (first) { firstWritten.resolve(); await releaseFirstResponse.promise; }
      return result;
    },
  };
  const store = new SnapshotStore(storage, { lockManager: delayedLocks });
  const earlier = store.save(snapshot('先写入的修改', 1));
  await firstWritten.promise;
  const latest = snapshot('现在的修改', 2);
  assert.equal((await store.save(latest)).saved, true);
  releaseFirstResponse.resolve();
  const result = await earlier;
  assert.equal(result.saved, true);
  assert.equal(result.superseded, true);
  assert.equal(storage.getItem(STORAGE_KEY), serializeSnapshot(latest));
});

test('conflict is not silently adopted by a retry', async () => {
  const storage = new SharedStorage();
  const store = new SnapshotStore(storage, { lockManager: new ExclusiveLocks() });
  const external = serializeSnapshot(snapshot('外部'));
  storage.setItem(STORAGE_KEY, external);
  assert.equal((await store.save(snapshot('冲突一'))).conflict, true);
  assert.equal((await store.save(snapshot('冲突二', 2))).conflict, true);
  assert.equal(storage.getItem(STORAGE_KEY), external);
  assert.equal(storage.writes, 1);
});

test('invalid snapshots are rejected before acquiring a lock or writing', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const store = new SnapshotStore(storage, { lockManager: locks });
  const result = await store.save({ revision: 2 });
  assert.equal(result.saved, false);
  assert.match(result.error, /快照格式无效/);
  assert.equal(storage.writes, 0);
  assert.equal(locks.requests.length, 0);
});

test('custom storage keys are isolated and use their own lock', async () => {
  const storage = new SharedStorage();
  const locks = new ExclusiveLocks();
  const store = new SnapshotStore(storage, { lockManager: locks, key: 'sixu.test.other' });
  const input = snapshot('隔离清单');
  assert.equal((await store.save(input)).saved, true);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem('sixu.test.other'), serializeSnapshot(input));
  assert.deepEqual(locks.requests, [lockName('sixu.test.other')]);
});
