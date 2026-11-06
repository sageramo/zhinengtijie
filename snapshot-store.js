import { serializeSnapshot, STORAGE_KEY } from './task-state.js';

/**
 * Browser-local optimistic persistence, coordinated across this origin's tabs.
 * Revision numbers identify edited snapshots; only exact previously-read bytes
 * identify the storage branch this tab is allowed to replace.
 *
 * Web Locks are required: a getItem/setItem pair alone is not atomic between
 * tabs. Callers keep their in-memory snapshot and can offer manual JSON export
 * when safe persistent storage is unavailable.
 */
export class SnapshotStore {
  #storage;
  #locks;
  #key;
  #expectedRaw;
  #intent = 0;
  #serialize;

  constructor(storage, { lockManager = globalThis.navigator?.locks, key = STORAGE_KEY, initialRaw = null, serialize = serializeSnapshot } = {}) {
    if (typeof key !== 'string' || !key) throw new TypeError('存储键必须是非空文本');
    this.#requireRaw(initialRaw);
    this.#storage = storage;
    this.#locks = lockManager;
    this.#key = key;
    this.#serialize = serialize;
    // The caller passes readSnapshot.raw and must gate malformed/failed reads;
    // no constructor read can silently turn unreadable data into an empty save.
    this.#expectedRaw = initialRaw;
  }

  #requireRaw(raw) {
    if (raw !== null && typeof raw !== 'string') throw new TypeError('已读取的存储内容必须是文本或null');
  }

  /** Adopt bytes only after the caller explicitly accepts the corresponding data. */
  adoptRaw(raw) {
    this.#requireRaw(raw);
    this.invalidate();
    this.#expectedRaw = raw;
  }

  /** Revoke queued save intents, for example before importing a different list. */
  invalidate() {
    this.#intent += 1;
  }

  /**
   * A superseded result must never update the UI's current-save indicator, even
   * if its synchronous storage write finished just before another edit began.
   */
  async save(snapshot) {
    const intent = ++this.#intent;
    const current = () => intent === this.#intent;
    let raw;
    try {
      // Serialize immediately, so later mutations of the caller's object cannot
      // change the queued intent or bypass the snapshot structure/byte checks.
      raw = this.#serialize(snapshot);
    } catch (error) {
      return { saved: false, error: error?.message || '任务清单格式无效，未保存' };
    }
    if (typeof this.#locks?.request !== 'function') {
      return { saved: false, error: '浏览器不支持安全的跨页保存，当前修改仅保留在本页内存，请导出JSON备份。' };
    }
    let result;
    try {
      result = await this.#locks.request(`sixu.snapshot-store:${this.#key}`, { mode: 'exclusive' }, () => {
        if (!current()) return { saved: false, superseded: true };
        const storedRaw = this.#storage.getItem(this.#key);
        this.#requireRaw(storedRaw);
        if (storedRaw !== this.#expectedRaw) {
          return {
            saved: false, conflict: true, raw: storedRaw,
            error: '其他页面已修改浏览器中的清单，本页未覆盖它；请先导出本页修改，再选择要继续使用的版本。',
          };
        }
        // The critical section is deliberately synchronous: no await between
        // comparing stored bytes and replacing them while holding the lock.
        this.#storage.setItem(this.#key, raw);
        this.#expectedRaw = raw;
        return { saved: true, raw };
      });
    } catch (error) {
      result = { saved: false, error: error?.message || '无法保存到浏览器，当前修改仅保留在本页内存，请导出JSON备份。' };
    }
    return current() ? result : { ...result, superseded: true };
  }
}
