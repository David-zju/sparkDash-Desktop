import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendEnvironment } from '../runtime-env.mjs';

test('power APIs use per-device saved or one-use sudo credentials without persisting one-use secrets', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-sudo-routes-'));
  Object.assign(process.env, backendEnvironment({ dataDir: dir, token: 'a'.repeat(64), secretsKey: 'b'.repeat(64) }));
  const { createBackend } = await import('../../server/index.js');
  const calls = [];
  let denied = false;
  const backend = createBackend({
    monitorFactory: spark => ({ online: true, start() {}, stop() {}, updateConfig() {}, snapshot: () => ({ id: spark.id, online: true, metrics: {} }) }),
    powerExec: async (spark, cmd, opts) => { calls.push({ id: spark.id, cmd, opts }); if (denied) throw new Error('secret: unsafe remote output'); return cmd.startsWith('if ') ? 'present' : ''; },
  });
  const { origin } = await backend.start();
  t.after(async () => { await backend.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(origin + url, { method, headers: { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  for (const id of ['one', 'two']) assert.equal((await request('/api/sparks', 'POST', { id, name: id, lanIp: '127.0.0.1', ssh: { host: '127.0.0.1' } })).status, 200);
  assert.equal((await request('/api/sparks/one/sudo', 'PUT', { password: 'saved-secret' })).status, 200);
  assert.deepEqual((await request('/api/sparks/one/sudo')).body, { hasPassword: true });
  assert.equal((await request('/api/sparks/one/power-check', 'POST', {})).body.status, 'ready');
  const targetBeforeEdit = (await request('/api/sparks/two/power-check', 'POST', {})).body.target;
  calls.length = 0;
  const result = await request('/api/sparks/reboot-all', 'POST', { ids: ['one', 'two'], sudoPasswords: { two: 'one-use-secret' } });
  assert.equal(result.body.results.length, 2); assert.equal(result.body.success, true);
  assert.equal(calls[0].opts.input, 'saved-secret\n'); assert.equal(calls[1].opts.input, 'one-use-secret\n');
  assert.equal(calls.every(c => c.cmd.endsWith('systemctl reboot')), true);
  assert.deepEqual((await request('/api/sparks/two/sudo')).body, { hasPassword: false });
  const stored = fs.readFileSync(path.join(dir, 'sparks-secrets.json'), 'utf8');
  assert.equal(stored.includes('saved-secret'), false); assert.equal(stored.includes('one-use-secret'), false);
  calls.length = 0;
  assert.equal((await request('/api/sparks/shutdown-all', 'POST', { ids: ['one'] })).body.results.length, 1);
  assert.equal(calls.length, 1); assert.ok(calls[0].cmd.endsWith('systemctl poweroff'));
  assert.equal((await request('/api/sparks/two', 'PATCH', { ssh: { host: 'new-fixture-target' } })).status, 200);
  calls.length = 0;
  const changed = await request('/api/sparks/two/reboot', 'POST', { targets: { two: targetBeforeEdit }, sudoPasswords: { two: 'one-use-secret' } });
  assert.equal(changed.status, 400);
  assert.match(changed.body.error, /target changed/);
  assert.equal(calls.length, 0, 'a one-use secret cannot follow an edited target');
  denied = true;
  const failure = await request('/api/sparks/one/reboot', 'POST', {});
  assert.equal(failure.status, 400); assert.equal(JSON.stringify(failure.body).includes('unsafe remote'), false);
  assert.equal((await request('/api/sparks/one/sudo', 'DELETE')).status, 200);
  assert.deepEqual((await request('/api/sparks/one/sudo')).body, { hasPassword: false });
});
