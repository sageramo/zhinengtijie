/**
 * End-to-end encrypted recovery code (SXV1), persistent browser storage request,
 * and optional local auto-backup file writer. Zero plaintext ever leaves the device.
 */
export const VAULT_PREFIX = 'SXV1.';
export const MIN_PASSPHRASE_LENGTH = 4;
const PBKDF2_ITERATIONS = 150000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const FLAG_RAW = 0x00;
const FLAG_DEFLATE = 0x01;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持本机加密，请更换现代浏览器或使用导出清单功能。');
  return subtle;
}

function toBase64Url(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(segment) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('口令不对或恢复码已损坏，请核对后重试');
  }
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((segment.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function compressPayload(rawBytes) {
  if (typeof globalThis.CompressionStream !== 'function') {
    const out = new Uint8Array(rawBytes.length + 1);
    out[0] = FLAG_RAW;
    out.set(rawBytes, 1);
    return out;
  }
  const stream = new globalThis.Blob([rawBytes]).stream().pipeThrough(new globalThis.CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new globalThis.Response(stream).arrayBuffer());
  const out = new Uint8Array(compressed.length + 1);
  out[0] = FLAG_DEFLATE;
  out.set(compressed, 1);
  return out;
}

async function decompressPayload(packet) {
  if (!(packet instanceof Uint8Array) || packet.length < 2) {
    throw new Error('口令不对或恢复码已损坏，请核对后重试');
  }
  const flag = packet[0];
  const body = packet.subarray(1);
  if (flag === FLAG_RAW) return decoder.decode(body);
  if (flag !== FLAG_DEFLATE || typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('口令不对或恢复码已损坏，请核对后重试');
  }
  const stream = new globalThis.Blob([body]).stream().pipeThrough(new globalThis.DecompressionStream('deflate-raw'));
  return decoder.decode(await new globalThis.Response(stream).arrayBuffer());
}

async function deriveAesKey(passphrase, salt, iterations) {
  const subtle = subtleCrypto();
  const baseKey = await subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Whether a string looks like a Sixu SXV1 encrypted recovery code. */
export function isVaultCode(text) {
  return typeof text === 'string' && text.trim().startsWith(VAULT_PREFIX);
}

/** Seal snapshot JSON into an offline AES-256-GCM recovery code with PBKDF2 key derivation. */
export async function sealVault(snapshotJson, passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (typeof snapshotJson !== 'string' || !snapshotJson.length) {
    throw new Error('清单内容为空，无法生成恢复码');
  }
  const trimmed = typeof passphrase === 'string' ? passphrase.trim() : '';
  if ([...trimmed].length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`请设置至少${MIN_PASSPHRASE_LENGTH}位的恢复口令`);
  }
  const subtle = subtleCrypto();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesKey(trimmed, salt, iterations);
  const payload = await compressPayload(encoder.encode(snapshotJson));
  const cipherBuffer = await subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
  return `${VAULT_PREFIX}${toBase64Url(salt)}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipherBuffer))}`;
}

/** Decrypt and decompress an SXV1 recovery code using the matching passphrase. */
export async function openVault(code, passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  const trimmedPass = typeof passphrase === 'string' ? passphrase.trim() : '';
  if ([...trimmedPass].length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`请输入至少${MIN_PASSPHRASE_LENGTH}位的恢复口令`);
  }
  if (typeof code !== 'string') {
    throw new Error('口令不对或恢复码已损坏，请核对后重试');
  }
  const compact = code.replace(/\s+/g, '');
  const parts = compact.split('.');
  if (parts.length !== 4 || parts[0] !== 'SXV1') {
    throw new Error('这不是有效的司序加密恢复码（应以 SXV1. 开头）');
  }
  const salt = fromBase64Url(parts[1]);
  const iv = fromBase64Url(parts[2]);
  const cipher = fromBase64Url(parts[3]);
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || cipher.length < 16) {
    throw new Error('口令不对或恢复码已损坏，请核对后重试');
  }
  const subtle = subtleCrypto();
  const key = await deriveAesKey(trimmedPass, salt, iterations);
  let plainBuffer;
  try {
    plainBuffer = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  } catch {
    throw new Error('口令不对或恢复码已损坏，请核对后重试');
  }
  return decompressPayload(new Uint8Array(plainBuffer));
}

/** Read-only check of navigator.storage.persisted() without triggering a browser prompt. */
export async function checkPersistentStorage(nav = globalThis.navigator) {
  try {
    if (!nav?.storage || typeof nav.storage.persisted !== 'function') {
      return { supported: false, persisted: false };
    }
    const persisted = Boolean(await nav.storage.persisted());
    return { supported: true, persisted };
  } catch {
    return { supported: false, persisted: false };
  }
}

/** Request browser persistent storage so automated eviction is far less likely. */
export async function requestPersistentStorage(nav = globalThis.navigator) {
  try {
    if (!nav?.storage || typeof nav.storage.persist !== 'function') {
      return await checkPersistentStorage(nav);
    }
    if (typeof nav.storage.persisted === 'function' && await nav.storage.persisted()) {
      return { supported: true, persisted: true };
    }
    const persisted = Boolean(await nav.storage.persist());
    return { supported: true, persisted };
  } catch {
    return { supported: false, persisted: false };
  }
}

/** Whether File System Access API local auto-sync is available in this browser. */
export function supportsLocalFileSync(win = globalThis.window) {
  return typeof win?.showSaveFilePicker === 'function';
}

/** Dual-write serialized snapshot bytes to a user-selected FileSystemFileHandle. */
export async function writeLocalBackupFile(handle, text) {
  if (!handle || typeof handle.createWritable !== 'function') {
    return { ok: false, error: '未绑定可用的本地备份文件句柄' };
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || '写入本地备份文件失败' };
  }
}
