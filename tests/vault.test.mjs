import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PASSPHRASE_LENGTH,
  checkPersistentStorage,
  isVaultCode,
  openVault,
  requestPersistentStorage,
  sealVault,
  supportsLocalFileSync,
  writeLocalBackupFile,
} from '../vault.js';

test('sealVault and openVault round-trip Chinese JSON even across chat line wrapping', async () => {
  const payload = JSON.stringify({
    schema_version: 3,
    revision: 7,
    tasks: [{ id: 't1', title: '概率论作业 · 第三章', deadline_at: '2026-12-01T23:59:00+08:00' }],
    routines: [{ id: 'r1', title: '机器人学导论', weekdays: [2, 4], start: '10:10', end: '12:00' }],
  });
  const code = await sealVault(payload, 'sixu-2026', { iterations: 1000 });
  assert.ok(isVaultCode(code));
  assert.equal(code.split('.').length, 4);

  const wrapped = code.match(/.{1,42}/g).join('\n  ');
  const recovered = await openVault(wrapped, 'sixu-2026', { iterations: 1000 });
  assert.equal(recovered, payload);
});

test('sealVault and openVault reject short passphrases, wrong passphrases, and tampered codes', async () => {
  await assert.rejects(
    () => sealVault('{"a":1}', 'abc'.slice(0, MIN_PASSPHRASE_LENGTH - 1), { iterations: 1000 }),
    /至少4位/,
  );
  const code = await sealVault('{"schema_version":3}', 'correct-pass', { iterations: 1000 });
  await assert.rejects(() => openVault(code, 'wrong-pass', { iterations: 1000 }), /口令不对或恢复码已损坏/);
  const parts = code.split('.');
  const flipped = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].slice(0, -2)}${parts[3].endsWith('A') ? 'B' : 'A'}A`;
  await assert.rejects(() => openVault(flipped, 'correct-pass', { iterations: 1000 }), /口令不对或恢复码已损坏/);
  await assert.rejects(() => openVault('not-a-vault', 'correct-pass', { iterations: 1000 }), /SXV1/);
});

test('persistent storage and local auto-backup helpers degrade safely and write via handle', async () => {
  assert.deepEqual(await checkPersistentStorage(undefined), { supported: false, persisted: false });
  assert.deepEqual(await requestPersistentStorage({}), { supported: false, persisted: false });
  assert.deepEqual(await requestPersistentStorage({ storage: { persisted: async () => false, persist: async () => true } }), { supported: true, persisted: true });
  assert.equal(supportsLocalFileSync({}), false);
  assert.equal(supportsLocalFileSync({ showSaveFilePicker: () => {} }), true);

  let saved = '';
  let closed = false;
  const mockHandle = {
    createWritable: async () => ({
      write: async text => { saved = text; },
      close: async () => { closed = true; },
    }),
  };
  const result = await writeLocalBackupFile(mockHandle, '{"ok":true}');
  assert.deepEqual(result, { ok: true });
  assert.equal(saved, '{"ok":true}');
  assert.equal(closed, true);
  assert.equal((await writeLocalBackupFile(null, 'x')).ok, false);
});
