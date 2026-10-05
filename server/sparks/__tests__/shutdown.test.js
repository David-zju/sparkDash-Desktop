import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLocalPower, hostMountNs, localPowerCommand, spawnLocalPower } from '../../shutdown.js';
test('local operations use fixed systemctl commands in the host mount namespace', () => {
  assert.deepEqual(localPowerCommand({ action: 'reboot', mntNs: '/host/proc/1/ns/mnt' }), {
    file: 'nsenter', args: ['--mount=/host/proc/1/ns/mnt', '--', 'sudo', '-n', '--', 'systemctl', 'reboot'],
  });
  assert.deepEqual(localPowerCommand({ mntNs: null }), { file: 'sudo', args: ['-n', '--', 'systemctl', 'poweroff'] });
  assert.throws(() => localPowerCommand({ action: 'reboot; id' }), /Unsupported/);
});
test('local execution reports command exit failure, not just process creation', async () => {
  const fake = code => () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', code)); return child; };
  await assert.rejects(spawnLocalPower({ mntNs: null, spawnFn: fake(1) }), /failed/);
  assert.equal(await spawnLocalPower({ action: 'reboot', mntNs: null, spawnFn: fake(0) }), 'Reboot requested');
});
test('hostMountNs: the PID 1 namespace when the host proc mount exists, else null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-proc-'));
  fs.mkdirSync(path.join(dir, '1', 'ns'), { recursive: true });
  fs.writeFileSync(path.join(dir, '1', 'ns', 'mnt'), '');
  assert.equal(hostMountNs(dir), path.join(dir, '1', 'ns', 'mnt'));
  assert.equal(hostMountNs(path.join(dir, 'absent')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('local preflight asks sudo -n -l instead of assuming authorization', async () => {
  const calls = [];
  const spawnWith = codes => (file, args) => { calls.push(args); const child = new EventEmitter(); const code = codes.shift(); queueMicrotask(() => child.emit('exit', code)); return child; };
  assert.deepEqual(await checkLocalPower({ mntNs: null, spawnFn: spawnWith([1, 0]) }), { status: 'ready', passwordSupported: false });
  assert.deepEqual(calls, [['-n', '-l', '--', 'systemctl', 'poweroff'], ['-n', '-l', '--', 'systemctl', 'reboot']]);
  const denied = await checkLocalPower({ mntNs: null, spawnFn: spawnWith([1, 1]) });
  assert.equal(denied.status, 'password_required');
  assert.equal(denied.passwordSupported, false);
  const missing = await checkLocalPower({ mntNs: null, spawnFn: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; } });
  assert.equal(missing.status, 'password_required');
});
