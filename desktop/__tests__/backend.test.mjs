import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { backendEnvironment } from '../runtime-env.mjs';

test('real desktop HTTP/WS server authenticates reads, rejects foreign origins and shuts down', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-backend-'));
  const token = 'a'.repeat(64);
  Object.assign(process.env, backendEnvironment({ dataDir, token, secretsKey: 'b'.repeat(64) }));
  const { createBackend } = await import('../../server/index.js');
  let started = 0;
  let stopped = 0;
  const backend = createBackend({ monitorFactory: (spark) => ({
    start() { started++; }, stop() { stopped++; },
    snapshot: () => ({ id: spark.id, online: false, metrics: {} }),
  }) });
  assert.equal(backend.server.listening, false, 'import and construction must not listen');
  const { origin } = await backend.start();
  t.after(async () => { await backend.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/sparks`)).status, 403);
  assert.equal((await fetch(`${origin}/api/sparks?token=${token}`)).status, 403);
  assert.equal((await fetch(`${origin}/api/sparks`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${origin}/api/sparks`, { headers: { ...headers, Host: 'evil.example' } }, (res) => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${origin}/api/sparks`, { headers })).status, 200);
  const local = await fetch(`${origin}/api/sparks`, { method: 'POST', headers, body: JSON.stringify({ id: 'mac', isLocal: true }) });
  assert.equal(local.status, 400);
  const remote = await fetch(`${origin}/api/sparks`, { method: 'POST', headers, body: JSON.stringify({
    id: 'test-node', name: 'Test', lanIp: '192.0.2.1', isLocal: false,
    ssh: { host: '192.0.2.1', user: 'test', auth: 'pass', password: 'fixture-password' },
  }) });
  assert.equal(remote.status, 200, await remote.text());
  assert.equal(started, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, 'sparks.json'), 'utf8').includes('fixture-password'), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'sparks-secrets.json'), 'utf8').includes('fixture-password'), false);
  assert.equal(fs.existsSync(path.join(dataDir, '.unused-plaintext-key')), false);
  const wsUrl = origin.replace('http:', 'ws:') + '/ws';
  const ws = new WebSocket(wsUrl, { headers: { ...headers, Origin: origin } });
  const snapshot = await new Promise((resolve, reject) => { ws.once('message', (data) => resolve(JSON.parse(data))); ws.once('error', reject); });
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.sparks[0].id, 'test-node');
  const badWs = new WebSocket(wsUrl, { headers: { ...headers, Origin: 'https://evil.example' } });
  await new Promise((resolve, reject) => { badWs.once('error', resolve); badWs.once('open', () => { badWs.terminate(); reject(new Error('Foreign WS origin accepted')); }); });
  await backend.stop('Test complete');
  assert.equal(stopped, 1);
  assert.equal(backend.server.listening, false);
  await assert.rejects(fetch(`${origin}/api/sparks`, { headers }));
});
