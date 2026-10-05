import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Existing ciphertext (or a legacy password awaiting migration) needs a key.
 * A profile using SSH aliases/keys alone must never touch macOS Keychain. */
export function needsSecretsKey(dataDir) {
  const savedPath = path.join(dataDir, 'sparks-secrets.json');
  if (fs.existsSync(savedPath)) {
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    const isMap = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (!saved || ![1, 2, 3].includes(saved.version) || !isMap(saved.secrets) ||
        (saved.version >= 2 && !isMap(saved.llmApiKeys)) ||
        (saved.version === 3 && !isMap(saved.sudoPasswords))) {
      throw new Error('Saved credential file has an invalid format. Original file preserved');
    }
    if (Object.keys(saved.secrets).length || Object.keys(saved.llmApiKeys || {}).length || Object.keys(saved.sudoPasswords || {}).length) return true;
  }
  const configPath = path.join(dataDir, 'sparks.json');
  if (!fs.existsSync(configPath)) return false;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return Array.isArray(config?.sparks) && config.sparks.some((spark) => Boolean(spark?.ssh?.password));
}

/** safeStorage uses macOS Keychain. Never create a plaintext fallback. */
export function loadSecretsKey(dataDir, safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('macOS Keychain（钥匙串）不可用。请解锁登录钥匙串，再从“监控”菜单重新连接后台');
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataDir, 'secrets-key.encrypted');
  if (fs.existsSync(keyPath)) {
    let key;
    try { key = safeStorage.decryptString(fs.readFileSync(keyPath)); }
    catch {
      throw new Error('未能解锁 sparkDash 安全存储。系统授权可能被拒绝、钥匙串已锁定，或密钥与当前系统不匹配。原有文件已保留；解锁并允许访问后，可从“监控”菜单重试');
    }
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('The saved secrets key is invalid. Restore it from backup.');
    return key;
  }
  if (fs.existsSync(path.join(dataDir, 'sparks-secrets.json'))) {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sparks-secrets.json'), 'utf8'));
    const emptyMap = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
    if (!saved || ![1, 2, 3].includes(saved.version) || !emptyMap(saved.secrets) ||
        (saved.version >= 2 && !emptyMap(saved.llmApiKeys)) ||
        (saved.version === 3 && !emptyMap(saved.sudoPasswords))) {
      throw new Error('Encrypted credentials exist but their Keychain-protected key is missing. Restore the key from backup.');
    }
  }
  const key = crypto.randomBytes(32).toString('hex');
  let encrypted;
  try { encrypted = safeStorage.encryptString(key); }
  catch {
    throw new Error('未能创建 sparkDash 安全存储。请在 macOS 钥匙串弹窗中允许本应用访问，再从“监控”菜单重试；未保存任何明文密钥');
  }
  fs.writeFileSync(keyPath, encrypted, { flag: 'wx', mode: 0o600 });
  return key;
}
