import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { WebSocket, WebSocketServer } from 'ws';
import { sshCommandSpec } from '../../server/collectors/ssh.js';
import { openSshLlmTunnel, resolveLlmHttpTarget } from '../../server/collectors/llmTunnel.js';
import { ServiceTargets } from '../../server/collectors/ServiceTargets.js';

const execute = promisify(execFile);

test('system SSH performs password/key authentication and shared HTTP/WS forwarding with isolated host trust', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-ssh-transport-'));
  const previous = { desktop: process.env.SPARKDASH_DESKTOP, helper: process.env.SPARKDASH_ASKPASS_PATH };
  process.env.SPARKDASH_DESKTOP = '1';
  process.env.SPARKDASH_ASKPASS_PATH = path.resolve('desktop/ssh-askpass.sh');
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519');
  const loginKey = ssh2.utils.generateKeyPairSync('ed25519');
  const publicKey = ssh2.utils.parseKey(loginKey.public);
  const keyPath = path.join(dir, 'private key with spaces');
  fs.writeFileSync(keyPath, loginKey.private, { mode: 0o600 });
  const clients = new Set();
  const children = new Set();
  const sockets = new Set();
  const methods = [];
  const service = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'loopback-fixture' }] }));
  });
  service.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const wsServer = new WebSocketServer({ server: service });
  wsServer.on('connection', (socket) => socket.on('message', (data) => socket.send(data)));
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  const remotePort = service.address().port;
  const sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (context) => {
      if (context.username !== 'fixture') return context.reject();
      if (context.method === 'password' && context.password === 'test-only-password') {
        methods.push('password'); return context.accept();
      }
      if (context.method === 'publickey' && context.key.data.equals(publicKey.getPublicSSH()) &&
        (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo) === true)) {
        methods.push('publickey'); return context.accept();
      }
      context.reject(['password', 'publickey']);
    });
    client.on('session', (accept) => {
      accept().on('exec', (accept) => { const stream = accept(); stream.write('fixture-ok\n'); stream.exit(0); stream.end(); });
    });
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== remotePort) return reject();
      const target = net.connect(remotePort, '127.0.0.1');
      target.once('connect', () => {
        const channel = accept();
        target.pipe(channel).pipe(target);
        channel.on('close', () => target.destroy());
        channel.on('error', () => target.destroy());
      });
      target.on('error', () => { try { reject(); } catch {} });
    });
  });
  await new Promise((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
  const port = sshServer.address().port;
  const knownHosts = path.join(dir, 'known_hosts');
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey.public}\n`);
  const config = path.join(dir, 'ssh_config');
  fs.writeFileSync(config, `Host *\n  UserKnownHostsFile "${knownHosts}"\n  GlobalKnownHostsFile /dev/null\n  IdentitiesOnly yes\n  IdentityAgent none\n`);
  const isolatedSpawn = (file, args, options) => {
    const child = spawn(file, ['-F', config, ...args], options);
    children.add(child); child.on('exit', () => children.delete(child));
    return child;
  };
  const pool = new ServiceTargets({ idleMs: 10, resolve: (spark, port, options) => resolveLlmHttpTarget(spark, port, {
    ...options, openTunnel: (spark, port, options) => openSshLlmTunnel(spark, port, { ...options, spawnImpl: isolatedSpawn }),
  }) });
  t.after(async () => {
    pool.stop();
    for (const child of children) child.kill();
    for (const client of clients) client.end();
    for (const socket of wsServer.clients) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((resolve) => sshServer.close(resolve)), new Promise((resolve) => service.close(resolve))]);
    for (const [name, value] of [['SPARKDASH_DESKTOP', previous.desktop], ['SPARKDASH_ASKPASS_PATH', previous.helper]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const spark = { id: 'local-fixture', isLocal: false, lanIp: '', ssh: {
    host: '127.0.0.1', port, user: 'fixture', auth: 'pass', password: 'test-only-password',
  } };
  const run = async (target) => {
    const spec = sshCommandSpec(target, { multiplex: false, extraSshArgs: ['-F', config], remoteArgv: ['fixture-command'] });
    assert.equal(spec.args.join(' ').includes('test-only-password'), false);
    return execute(spec.file, spec.args, { env: spec.env, timeout: 5000 });
  };
  assert.equal((await run(spark)).stdout.trim(), 'fixture-ok');
  await assert.rejects(run({ ...spark, ssh: { ...spark.ssh, password: 'wrong-fixture-password' } }), /Permission denied/);
  assert.equal((await run({ ...spark, ssh: { ...spark.ssh, auth: 'key', identityFile: keyPath } })).stdout.trim(), 'fixture-ok');
  assert.ok(methods.includes('password') && methods.includes('publickey'));

  const [a, b] = await Promise.all([pool.acquire(spark, remotePort), pool.acquire(spark, remotePort)]);
  assert.equal(a.via, 'ssh-tunnel');
  assert.equal(a.port, b.port);
  const url = `http://127.0.0.1:${a.port}/v1/models`;
  const request = () => fetch(url, { headers: { Authorization: 'Bearer fixture-key' }, signal: AbortSignal.timeout(2000) });
  assert.equal((await (await request()).json()).data[0].id, 'loopback-fixture');
  const socket = new WebSocket(`ws://127.0.0.1:${a.port}/ws`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const echoed = new Promise((resolve) => socket.once('message', (data) => resolve(data.toString())));
  socket.send('fixture-progress');
  assert.equal(await echoed, 'fixture-progress');
  socket.close();
  a.close();
  assert.equal((await request()).status, 200, 'another consumer still owns the tunnel');
  b.close();
  pool.stop();
  for (let i = 0; i < 40 && children.size; i++) await sleep(25);
  assert.equal(children.size, 0, 'owned SSH forwarding process exits');
  await assert.rejects(request());
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${ssh2.utils.generateKeyPairSync('ed25519').public}\n`);
  await assert.rejects(run(spark), /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
});
