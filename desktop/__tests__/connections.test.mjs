import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ServiceTargets, ServiceConnection } from '../../server/collectors/ServiceTargets.js';
import { sshCommandSpec } from '../../server/collectors/ssh.js';
import { HermesProbe } from '../../server/collectors/HermesProbe.js';

const spark = { id: 'test', lanIp: '192.0.2.1', ssh: { host: 'my-alias', auth: 'key' } };

test('concurrent monitor and benchmark leases share one connection and stop closes it', async () => {
  let opened = 0;
  let closed = 0;
  const pool = new ServiceTargets({ resolve: async () => {
    opened++;
    return { host: '127.0.0.1', port: 45678, via: 'ssh-tunnel', close: () => closed++ };
  } });
  const [a, b] = await Promise.all([pool.acquire(spark, 8000), pool.acquire(spark, 8000)]);
  assert.equal(opened, 1);
  a.close(); a.close();
  assert.equal(closed, 0);
  b.invalidate();
  pool.stop();
  assert.equal(closed, 1);
  await assert.rejects(pool.acquire(spark, 8000), /stopped/);
});

test('changed credentials get a different transport and failed connections can reconnect', async () => {
  let calls = 0;
  const pool = new ServiceTargets({ resolve: async () => {
    if (++calls === 1) throw new Error('network down');
    return { host: '127.0.0.1', port: 40000 + calls, close() {} };
  } });
  await assert.rejects(pool.acquire(spark, 8000), /network down/);
  const first = await pool.acquire(spark, 8000);
  const changed = await pool.acquire({ ...spark, ssh: { ...spark.ssh, identityFile: '/other/key' } }, 8000);
  assert.notEqual(first.port, changed.port);
  first.close(); changed.close(); pool.stop();
});

test('stopping a monitor while its tunnel opens releases the late result', async () => {
  let complete;
  let closed = 0;
  const pool = new ServiceTargets({ resolve: () => new Promise((resolve) => { complete = resolve; }) });
  const connection = new ServiceConnection(pool);
  const pending = connection.get(spark, 8000);
  connection.dispose();
  pool.stop();
  complete({ host: '127.0.0.1', port: 50000, close: () => closed++ });
  await assert.rejects(pending, /stopped/);
  assert.equal(closed, 1);
});

test('overlapping probes on one monitor release their shared lease on dispose', async () => {
  let acquired = 0;
  let released = 0;
  const connection = new ServiceConnection({ acquire: async () => {
    acquired++;
    return { host: '127.0.0.1', port: 50000, close: () => released++ };
  } });
  const [first, second] = await Promise.all([connection.get(spark, 8000), connection.get(spark, 8000)]);
  connection.dispose();
  assert.equal(first, second);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});

test('desktop SSH preserves aliases, handles key paths with spaces and keeps passwords out of argv', (t) => {
  const before = process.env.SPARKDASH_DESKTOP;
  const beforeHelper = process.env.SPARKDASH_ASKPASS_PATH;
  t.after(() => {
    if (before === undefined) delete process.env.SPARKDASH_DESKTOP; else process.env.SPARKDASH_DESKTOP = before;
    if (beforeHelper === undefined) delete process.env.SPARKDASH_ASKPASS_PATH; else process.env.SPARKDASH_ASKPASS_PATH = beforeHelper;
  });
  process.env.SPARKDASH_DESKTOP = '1';
  process.env.SPARKDASH_ASKPASS_PATH = path.resolve('desktop/ssh-askpass.sh');
  const key = sshCommandSpec({ ...spark, ssh: { ...spark.ssh, port: 2202, identityFile: '/path with spaces/key' } });
  assert.equal(key.file, '/usr/bin/ssh');
  assert.ok(key.args.includes('my-alias'));
  assert.ok(key.args.includes('/path with spaces/key'));
  assert.ok(key.args.includes('2202'));
  const secret = 'test-only-secret';
  const password = sshCommandSpec({ ...spark, ssh: { ...spark.ssh, auth: 'pass', password: secret } });
  assert.equal(password.args.join(' ').includes(secret), false);
  assert.equal(password.env.SSH_ASKPASS_REQUIRE, 'force');
  const response = execFileSync('/bin/sh', [process.env.SPARKDASH_ASKPASS_PATH, "user's password:"], { env: password.env, encoding: 'utf8' });
  assert.equal(response.trim(), secret);
});

test('Hermes status does not fetch, delete locks, repair ownership or update', async () => {
  const probe = new HermesProbe({ ...spark, ssh: { ...spark.ssh, user: 'test' } });
  let command;
  probe._run = async (value) => { command = value; return 'HERMES_BIN=/usr/bin/hermes\nhermes 0.9.0\n__CHECK_PHASE__\n__CHECK_EXIT__0'; };
  const result = await probe.status();
  assert.equal(result.installed, true);
  assert.equal(result.statusOnly, true);
  assert.doesNotMatch(command, /git.*fetch|-delete|chown|update --check/);
});
