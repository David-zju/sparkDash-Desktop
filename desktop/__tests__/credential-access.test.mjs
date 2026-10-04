import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendEnvironment } from '../runtime-env.mjs';

test('credential access is deferred; denial preserves data and monitoring, then save can retry', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-lazy-key-'));
  Object.assign(process.env, backendEnvironment({ dataDir, token: 'e'.repeat(64) }));
  delete process.env.SPARKDASH_SECRETS_KEY;
  // Empty stores from prior versions also start without a key.
  const secretsPath = path.join(dataDir, 'sparks-secrets.json');
  fs.writeFileSync(secretsPath, JSON.stringify({ version: 2, secrets: {}, llmApiKeys: {} }));
  const { createBackend } = await import('../../server/index.js');
  let accesses = 0;
  let allow = false;
  const backend = createBackend({
    monitorFactory: (spark) => ({ start() {}, stop() {}, updateConfig() {}, snapshot: () => ({ id: spark.id, online: false, metrics: {} }) }),
    prepareCredentials: async () => {
      accesses++;
      if (!allow) throw new Error('Fixture authorization denied');
      process.env.SPARKDASH_SECRETS_KEY = 'f'.repeat(64);
    },
  });
  const { origin } = await backend.start();
  t.after(async () => { await backend.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(origin + url, { method, headers: { Authorization: `Bearer ${'e'.repeat(64)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal(accesses, 0);
  assert.equal((await request('/api/sparks', 'POST', { id: 'fixture', name: 'Fixture', lanIp: '127.0.0.1', ssh: { host: '127.0.0.1' }, llmPorts: [8888] })).status, 200);
  assert.equal((await request('/api/settings', 'PUT', { pollIntervalMs: 3000 })).status, 200);
  assert.equal(accesses, 0);
  const before = fs.readFileSync(secretsPath, 'utf8');
  const registryBefore = (await request('/api/sparks')).body;
  const ephemeral = await request('/api/sparks/test', 'POST', {
    id: 'unsaved-test', lanIp: '127.0.0.1', llmMonitoring: false,
    comfyMonitoring: false, hermesMonitoring: false, tailscaleMonitoring: false,
    ssh: { host: '127.0.0.1', port: 1, auth: 'pass', password: 'ephemeral-password' },
  });
  assert.equal(ephemeral.status, 200);
  assert.equal(ephemeral.body.ssh.ok, false);
  assert.equal(ephemeral.body.llm.skipped, true);
  assert.equal(accesses, 0, 'testing a password must not request Keychain access');
  assert.equal(fs.readFileSync(secretsPath, 'utf8'), before);
  assert.deepEqual((await request('/api/sparks')).body, registryBefore);
  for (const [url, method, body] of [
    ['/api/sparks/fixture/password', 'PUT', { password: 'fixture-password' }],
    ['/api/sparks/fixture', 'PATCH', { name: 'Must not change', ssh: { password: 'fixture-password' } }],
    ['/api/sparks/fixture/llm-ports/8888/api-key', 'PUT', { apiKey: 'fixture-api-key' }],
    ['/api/sparks/fixture/test', 'POST', { password: 'fixture-password' }],
    ['/api/sparks', 'POST', { id: 'denied', lanIp: '127.0.0.1', ssh: { password: 'fixture-password' } }],
  ]) {
    assert.equal((await request(url, method, body)).status, 503);
    assert.equal(fs.readFileSync(secretsPath, 'utf8'), before);
  }
  const current = (await request('/api/sparks')).body.sparks;
  assert.equal(current.length, 1);
  assert.equal(current[0].name, 'Fixture');
  assert.equal(accesses, 5);
  allow = true;
  assert.equal((await request('/api/sparks/fixture/password', 'PUT', { password: 'fixture-password' })).status, 200);
  assert.equal((await request('/api/sparks/fixture/llm-ports/8888/api-key', 'PUT', { apiKey: 'fixture-api-key' })).status, 200);
  const saved = fs.readFileSync(secretsPath, 'utf8');
  assert.equal(saved.includes('fixture-password'), false);
  assert.equal(saved.includes('fixture-api-key'), false);
  const { loadSecrets } = await import('../../server/secretsStore.js');
  assert.equal(loadSecrets().passwords.get('fixture'), 'fixture-password');
  assert.equal(loadSecrets().llmApiKeys.get('fixture')['8888'], 'fixture-api-key');
});
