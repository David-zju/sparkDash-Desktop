import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { localPowerCommand, spawnLocalPower } from '../../shutdown.js';
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
