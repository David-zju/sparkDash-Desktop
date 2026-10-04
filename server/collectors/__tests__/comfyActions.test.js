import test from 'node:test';
import assert from 'node:assert/strict';
import { comfyCancelJob } from '../comfyActions.js';

const spark = { id: 'fixture', lanIp: '127.0.0.1', comfyPort: 8188 };
const response = (status, value = {}) => new Response(JSON.stringify(value), { status });

test('legacy pending cancellation never interrupts a different running job', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, ...init });
    if (url.includes('/api/jobs/')) return response(404);
    if (!init.method) return response(200, { queue_running: [[1, 'other']], queue_pending: [[2, 'target']] });
    return response(200);
  });
  const result = await comfyCancelJob(spark, 'target');
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.path), ['/api/jobs/target/cancel', '/queue', '/queue']);
  assert.deepEqual(JSON.parse(calls[2].body), { delete: ['target'] });
});

test('legacy interrupt failures are reported as failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (url.includes('/api/jobs/')) return response(404);
    if (!init.method) return response(200, { queue_running: [[1, 'target']], queue_pending: [] });
    return response(500);
  });
  assert.deepEqual(await comfyCancelJob(spark, 'target'), { ok: false, method: 'interrupt', message: 'HTTP 500' });
});

test('authorization and ambiguous transport failures never fall back to another mutation', async (t) => {
  let calls = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () => { calls++; return response(403); });
  assert.equal((await comfyCancelJob(spark, 'target')).ok, false);
  assert.equal(calls, 1);
  fetch.mock.mockImplementation(async () => { calls++; throw new Error('connection lost'); });
  assert.match((await comfyCancelJob(spark, 'target')).message, /could not be confirmed/);
  assert.equal(calls, 2);
});

test('a disappeared or ambiguous running job causes no legacy mutation', async (t) => {
  let running = [[1, 'other']];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push(new URL(url).pathname);
    if (init.method) return response(404);
    return response(200, { queue_running: running, queue_pending: [] });
  });
  assert.equal((await comfyCancelJob(spark, 'target')).ok, false);
  running = [[1, 'target'], [2, 'other']];
  assert.equal((await comfyCancelJob(spark, 'target')).ok, false);
  assert.equal(calls.includes('/interrupt'), false);
});
