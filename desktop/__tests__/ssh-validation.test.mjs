import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { sshTest } from '../../server/collectors/ssh.js';

test('connection validation authenticates afresh even when OpenSSH config enables connection reuse', async (t) => {
  const calls = [];
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => { callback(null, 'ok\n', ''); child.emit('close', 0); });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const target = { id: 'validation-fixture', lanIp: 'fixture-host', ssh: { host: 'fixture-host', user: 'fixture', auth: 'key' } };
  assert.equal((await sshTest(target)).ok, true);
  assert.equal((await sshTest(target)).ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.args.includes('ControlMaster=no'));
    assert.ok(call.args.includes('ControlPath=none'));
    assert.equal(call.args.at(-1), 'echo ok');
  }
});
