import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { sshExec } from '../../server/collectors/ssh.js';
test('SSH forwards sudo credentials on stdin and suppresses sensitive remote errors', async t => {
  const calls = [];
  let fail = false;
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    let input = '';
    child.stdin.on('data', data => { input += data; });
    child.stdin.on('finish', () => {
      calls.push({ file, args, options, input });
      queueMicrotask(() => { callback(fail ? Object.assign(new Error('secret'), { code: 1 }) : null, '', fail ? 'secret' : ''); child.emit('close', fail ? 1 : 0); });
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const spark = { id: 'fixture', lanIp: 'fixture-host', ssh: { host: 'fixture-host', user: 'fixture', auth: 'key' } };
  const options = { input: 'secret\n', sensitive: true, multiplex: false };
  await sshExec(spark, "sudo -S -k -p '' -- systemctl reboot", options);
  assert.equal(calls[0].input, 'secret\n');
  assert.equal(calls[0].args.join(' ').includes('secret'), false);
  assert.equal(JSON.stringify(calls[0].options).includes('secret'), false);
  fail = true;
  await assert.rejects(sshExec(spark, "sudo -S -k -p '' -v", options), err => !err.message.includes('secret') && err.exitCode === 1 && err.timedOut === false);
});
