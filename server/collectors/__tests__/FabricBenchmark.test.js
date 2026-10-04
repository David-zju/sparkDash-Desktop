import test from 'node:test';
import assert from 'node:assert/strict';
import { FabricBenchmark, parseBandwidth } from '../FabricBenchmark.js';

const sparks = ['a', 'b'].map((id) => ({ id, name: id, ssh: { host: id, password: 'private' } }));
const path = { key: '0:1:0', aInterface: 'cx0', aIp: '10.1.1.1', bInterface: 'cx0', bIp: '10.1.1.2', speedMbps: 200000 };
const request = { kinds: ['tcp', 'rdma'], path };
const config = (cmd) => JSON.parse(Buffer.from(cmd.match(/'([A-Za-z0-9+/=]+)'$/)[1], 'base64').toString());
const tcp = JSON.stringify({ end: { sum_received: { bits_per_second: 125e9 } } });
const rdma = '#bytes #iterations BW peak[Gb/sec] BW average[Gb/sec] MsgRate[Mpps]\n65536 20000 0.00 178.25 0.34\n';
function fixture({ inspect, execute } = {}) {
  const calls = [];
  const manager = new FabricBenchmark({
    discover: async () => ({ links: [{ a: 'a', b: 'b', paths: [path] }] }),
    exec: async (spark, cmd, options) => {
      const c = config(cmd); calls.push({ id: spark.id, ...c });
      if (c.action === 'cancel') return '{"stopped":1}';
      if (c.action === 'inspect') return JSON.stringify(inspect?.(spark) ?? { tools: { iperf3: { available: true, version: 'iperf3 3.19' }, ib_write_bw: { available: true, version: '6.26' } }, rdma: { device: 'roce0', port: 1, gid: 3 } });
      if (execute) return execute(spark, c, options);
      if (c.server) {
        options.onStdout('{"rea'); options.onStdout('dy":true}\n');
        await new Promise((r) => setTimeout(r, 5));
      }
      return JSON.stringify({ code: 0, stdout: c.kind === 'tcp' ? tcp : rdma, stderr: '' });
    },
  });
  return { manager, calls };
}

test('runs both directions on the selected path and reports receiver / average Gb/s', async () => {
  const { manager, calls } = fixture();
  manager.start(sparks, request);
  await manager.active.done;
  const job = manager.snapshot();
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.results.map((r) => [r.kind, r.direction, r.gbps]), [
    ['tcp', 'forward', 125], ['tcp', 'reverse', 125], ['rdma', 'forward', 178.25], ['rdma', 'reverse', 178.25],
  ]);
  assert.ok(job.results.every((r) => r.status === 'passed'));
  assert.ok(calls.filter((c) => c.action === 'run').every((c) => c.interface === 'cx0' && c.ip === (c.id === 'a' ? path.aIp : path.bIp)));
  assert.equal(calls.filter((c) => c.action === 'cancel').length, 8);
  assert.equal(JSON.stringify(job).includes('private'), false);
});

test('missing tools / missing GID skip traffic instead of inventing a zero result', async () => {
  const { manager, calls } = fixture({ inspect: () => ({ tools: { iperf3: { available: false, reason: 'missing-tool' }, ib_write_bw: { available: true } }, rdma: null }) });
  manager.start(sparks, request); await manager.active.done;
  assert.ok(manager.snapshot().results.every((r) => r.status === 'unavailable' && r.gbps === null));
  assert.equal(calls.filter((c) => c.action === 'run').length, 0);
});

test('rejects concurrent jobs, arbitrary paths and malformed test kinds', async () => {
  const { manager, calls } = fixture();
  for (const kinds of [[], ['shell'], ['tcp', 'tcp'], 'tcp']) assert.throws(() => manager.start(sparks, { ...request, kinds }));
  manager.start(sparks, { ...request, path: { ...path, bIp: '203.0.113.1' } });
  assert.throws(() => manager.start(sparks, request), /already running/);
  await manager.active.done;
  assert.equal(manager.snapshot().status, 'failed');
  assert.equal(calls.length, 0);
});

test('listener failure never starts a client and cleanup targets both devices', async () => {
  const { manager, calls } = fixture({ execute: async () => JSON.stringify({ error: 'Address already in use' }) });
  manager.start(sparks, { ...request, kinds: ['tcp'] }); await manager.active.done;
  assert.ok(manager.snapshot().results.every((r) => r.status === 'failed' && /Address already/.test(r.error)));
  assert.equal(calls.filter((c) => c.action === 'run' && !c.server).length, 0);
  assert.equal(calls.filter((c) => c.action === 'cancel').length, 4);
});

test('cancel during readiness stops both endpoints and suppresses client and later tests', async () => {
  let release;
  const { manager, calls } = fixture({ execute: async (_spark, _c, options) => {
    await new Promise((resolve) => { release = () => { options.onStdout('{"ready":true}\n'); resolve(); }; });
    return JSON.stringify({ code: 0, stdout: tcp, stderr: '' });
  } });
  manager.start(sparks, request);
  const done = manager.active.done;
  while (!release) await new Promise((r) => setImmediate(r));
  await manager.cancel(); release(); await done;
  assert.equal(manager.snapshot().status, 'cancelled');
  assert.equal(calls.filter((c) => c.action === 'run').length, 1);
  assert.ok(calls.filter((c) => c.action === 'cancel').length >= 2);
});

test('stopping during discovery prevents later remote execution and further starts', async () => {
  let resolve;
  const manager = new FabricBenchmark({ discover: () => new Promise((r) => { resolve = r; }), exec: async () => assert.fail('Remote command after shutdown') });
  manager.start(sparks, request); const done = manager.active.done;
  await manager.stop(); resolve({ links: [] }); await done;
  assert.equal(manager.snapshot().status, 'cancelled');
  assert.throws(() => manager.start(sparks, request), /stopping/);
});

test('strict parsers reject missing, zero, malformed and wrong-unit results', () => {
  assert.equal(parseBandwidth('rdma', rdma), 178.25);
  for (const raw of ['{}', '{"error":"connection failed"}', '{"end":{"sum_received":{"bits_per_second":0}}}']) assert.throws(() => parseBandwidth('tcp', raw));
  assert.throws(() => parseBandwidth('rdma', rdma.replaceAll('Gb/sec', 'MiB/sec')));
  assert.throws(() => parseBandwidth('rdma', rdma.replace('178.25', 'nan')));
});
