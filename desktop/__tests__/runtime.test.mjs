import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendEnvironment } from '../runtime-env.mjs';
import { loadSecretsKey, needsSecretsKey } from '../key-store.mjs';
import { createPreferences } from '../preferences.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('desktop ignores inherited backend overrides and writes only into its own data directory', (t) => {
  const dataDir = temp(t);
  const env = backendEnvironment({ dataDir, token: 'a'.repeat(64), secretsKey: 'b'.repeat(64), inherited: {
    HOME: '/Users/test', BIND_HOST: '0.0.0.0', PORT: '5555', NODE_OPTIONS: '--inspect',
    SPARKS_JSON_PATH: '/readonly/config.json', GITHUB_TOKEN: 'should-not-leak', SSH_AUTH_SOCK: '/tmp/agent.sock',
  } });
  assert.equal(env.BIND_HOST, '127.0.0.1');
  assert.equal(env.PORT, '0');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, '/tmp/agent.sock');
  assert.equal(env.SPARKS_JSON_PATH, path.join(dataDir, 'sparks.json'));
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith('_PATH')) assert.equal(path.dirname(value), dataDir, key);
  }
  assert.throws(() => backendEnvironment({ dataDir, token: '', secretsKey: 'b'.repeat(64) }));
});

test('key store fails closed when Keychain or a saved key is unavailable', (t) => {
  const dataDir = temp(t);
  assert.throws(() => loadSecretsKey(dataDir, { isEncryptionAvailable: () => false }), /Keychain/);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  fs.writeFileSync(path.join(dataDir, 'sparks-secrets.json'), '{}');
  assert.throws(() => loadSecretsKey(dataDir, { isEncryptionAvailable: () => true }), /missing/);
  assert.equal(fs.existsSync(path.join(dataDir, 'secrets-key.encrypted')), false);
});

test('desktop preferences survive backend port changes and reject secret storage', (t) => {
  const dataDir = temp(t);
  const first = createPreferences(dataDir);
  first.set('sparkdash-theme', 'oled');
  first.set('sparkdash.ui.section.resources', '0');
  assert.equal(createPreferences(dataDir).snapshot()['sparkdash-theme'], 'oled');
  assert.equal(createPreferences(dataDir).snapshot()['sparkdash.ui.section.resources'], '0');
  assert.throws(() => first.set('sparkdash-token', 'secret'));
  assert.throws(() => first.set('__proto__', 'bad'));
  assert.throws(() => first.set('sparkdash-theme', 'a'.repeat(16384)));
});

test('denied Keychain access preserves the saved key and allows a later retry', (t) => {
  const dataDir = temp(t);
  const keyPath = path.join(dataDir, 'secrets-key.encrypted');
  const ciphertext = Buffer.from('test ciphertext');
  fs.writeFileSync(keyPath, ciphertext);
  assert.throws(() => loadSecretsKey(dataDir, {
    isEncryptionAvailable: () => true,
    decryptString: () => { throw new Error('User denied access'); },
  }), /原有文件已保留/);
  assert.deepEqual(fs.readFileSync(keyPath), ciphertext);
  assert.equal(loadSecretsKey(dataDir, {
    isEncryptionAvailable: () => true, decryptString: () => 'a'.repeat(64),
  }), 'a'.repeat(64));
  assert.deepEqual(fs.readFileSync(keyPath), ciphertext);
});

test('denied initial Keychain access does not create a plaintext or partial key', (t) => {
  const dataDir = temp(t);
  assert.throws(() => loadSecretsKey(dataDir, {
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error('User denied access'); },
  }), /未保存任何明文/);
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('SSH key profiles, including old unused encrypted keys, do not need Keychain access', (t) => {
  const dataDir = temp(t);
  assert.equal(needsSecretsKey(dataDir), false);
  fs.writeFileSync(path.join(dataDir, 'secrets-key.encrypted'), 'unused previous key');
  fs.writeFileSync(path.join(dataDir, 'sparks.json'), JSON.stringify({ sparks: [{ id: 'node', ssh: { host: 'alias', auth: 'key' } }] }));
  assert.equal(needsSecretsKey(dataDir), false);
  fs.writeFileSync(path.join(dataDir, 'sparks-secrets.json'), JSON.stringify({ version: 2, secrets: {}, llmApiKeys: {} }));
  assert.equal(needsSecretsKey(dataDir), false);
  fs.writeFileSync(path.join(dataDir, 'sparks-secrets.json'), JSON.stringify({ version: 2, secrets: {}, llmApiKeys: { node: 'ciphertext' } }));
  assert.equal(needsSecretsKey(dataDir), true);
  fs.unlinkSync(path.join(dataDir, 'sparks-secrets.json'));
  fs.writeFileSync(path.join(dataDir, 'sparks.json'), JSON.stringify({ sparks: [{ id: 'node', ssh: { password: 'legacy-fixture' } }] }));
  assert.equal(needsSecretsKey(dataDir), true);
  const env = backendEnvironment({ dataDir, token: 'a'.repeat(64), inherited: { SPARKDASH_SECRETS_KEY: 'inherited-key-must-not-leak' } });
  assert.equal(env.SPARKDASH_SECRETS_KEY, undefined);
});
