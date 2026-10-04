import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendEnvironment } from '../runtime-env.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-persistence-'));
Object.assign(process.env, backendEnvironment({ dataDir: dir, token: 'a'.repeat(64), secretsKey: 'b'.repeat(64) }));
const { SparkRegistry } = await import('../../server/sparks/SparkRegistry.js');
const { loadSettings, getSettings, updateSettings } = await import('../../server/settings.js');
const { loadSecrets, saveSecrets } = await import('../../server/secretsStore.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('corrupt and wrong-shaped desktop data is rejected without overwriting the original', () => {
  for (const [filename, read, samples] of [
    ['sparks.json', () => new SparkRegistry(), ['{truncated', '{}', '{"sparks":[{"id":"same"},{"id":"same"}]}']],
    ['settings.json', loadSettings, ['{truncated', 'null', '[]']],
    ['sparks-secrets.json', loadSecrets, ['{truncated', '{}', '{"version":2,"secrets":{"node":7},"llmApiKeys":{}}', '{"version":2,"secrets":{"node":"bad ciphertext"},"llmApiKeys":{}}']],
  ]) {
    const file = path.join(dir, filename);
    for (const value of samples) {
      fs.writeFileSync(file, value);
      assert.throws(read);
      assert.equal(fs.readFileSync(file, 'utf8'), value);
    }
    fs.unlinkSync(file);
  }
});

test('failed settings save rolls memory back, and an intact file can still be loaded', () => {
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"pollIntervalMs":2000}');
  loadSettings();
  fs.renameSync(file, file + '.backup');
  fs.mkdirSync(file);
  assert.throws(() => updateSettings({ pollIntervalMs: 5000 }));
  assert.equal(getSettings().pollIntervalMs, 2000);
  fs.rmdirSync(file);
  fs.renameSync(file + '.backup', file);
  assert.equal(loadSettings().pollIntervalMs, 2000);
});

test('legacy plaintext credentials migrate to encrypted storage without entering the public registry', () => {
  const file = path.join(dir, 'sparks.json');
  fs.writeFileSync(file, JSON.stringify({ sparks: [{ id: 'fixture', lanIp: '127.0.0.1', ssh: { host: 'fixture-alias', auth: 'pass', password: 'fixture-legacy' } }] }));
  const registry = new SparkRegistry();
  assert.equal(registry.getSpark('fixture').ssh.password, 'fixture-legacy');
  assert.equal(JSON.stringify(registry.publicSparks).includes('fixture-legacy'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('fixture-legacy'), false);
  assert.equal(fs.readFileSync(path.join(dir, 'sparks-secrets.json'), 'utf8').includes('fixture-legacy'), false);
  assert.equal(new SparkRegistry().getSpark('fixture').ssh.password, 'fixture-legacy');
  saveSecrets(new Map(), new Map());
});
