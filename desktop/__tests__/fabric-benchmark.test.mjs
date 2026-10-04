import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendEnvironment } from '../runtime-env.mjs';

test('cluster benchmark API requires authenticated saved cluster members and stops with backend', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-fabric-api-'));
  const token = 'c'.repeat(64);
  Object.assign(process.env, backendEnvironment({ dataDir, token }));
  fs.writeFileSync(path.join(dataDir, 'sparks.json'), JSON.stringify({ sparks: [
    { id: 'a', name: 'A', role: 'head', ssh: { host: 'fixture-a' } },
    { id: 'b', name: 'B', role: 'worker', workerHeadId: 'a', ssh: { host: 'fixture-b' } },
    { id: 'c', name: 'C', role: 'standalone', ssh: { host: 'fixture-c' } },
  ] }));
  let job = null, stopped = false, starts = 0;
  const benchmark = {
    snapshot: () => job,
    start(sparks) { starts++; assert.deepEqual(sparks.map((s) => s.id), ['a', 'b']); job = { id: 'job', status: 'running' }; return job; },
    async cancel() { job.status = 'cancelled'; return job; },
    async stop() { stopped = true; },
  };
  const { createBackend } = await import('../../server/index.js');
  const backend = createBackend({ fabricBenchmark: benchmark, monitorFactory: (spark) => ({ start() {}, stop() {}, snapshot: () => ({ id: spark.id, metrics: {} }) }) });
  t.after(async () => { await backend.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { origin } = await backend.start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const url = `${origin}/api/clusters/benchmark`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const post = (body) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ headId: 'a', a: 'a', b: 'c' })).status, 400);
  assert.equal((await post({ headId: 'a', a: 'a', b: 'missing' })).status, 400);
  assert.equal((await post({ headId: 'a', a: 'a', b: 'a' })).status, 400);
  assert.equal(starts, 0);
  assert.equal((await post({ headId: 'a', a: 'a', b: 'b', kinds: ['tcp'] })).status, 202);
  assert.equal((await (await fetch(url, { headers })).json()).job.id, 'job');
  assert.equal((await fetch(`${url}/missing`, { method: 'DELETE', headers })).status, 404);
  assert.equal((await fetch(`${url}/job`, { method: 'DELETE', headers })).status, 200);
  assert.equal(job.status, 'cancelled');
  await backend.stop(); assert.equal(stopped, true);
});
