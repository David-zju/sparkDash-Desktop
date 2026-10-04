import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { normalizeMac, effectiveMac, broadcastForLanIp, sendWol } from '../../wol.js';

test('Wake-on-LAN validates overrides and selects the expected broadcast', () => {
  assert.equal(normalizeMac('invalid'), null);
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(effectiveMac({ macAddress: 'aa:bb:cc:dd:ee:ff', detectedMacAddress: '00:11:22:33:44:55' }), 'aa:bb:cc:dd:ee:ff');
  assert.equal(effectiveMac({ detectedMacAddress: '00:11:22:33:44:55' }), '00:11:22:33:44:55');
  assert.equal(broadcastForLanIp('192.168.12.34'), '192.168.12.255');
  assert.equal(broadcastForLanIp('ssh-alias'), '255.255.255.255');
});

test('Wake-on-LAN sends the exact magic packet to an isolated loopback UDP receiver', { timeout: 3000 }, async (t) => {
  const receiver = dgram.createSocket('udp4');
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => receiver.close());
  const received = once(receiver, 'message');
  const result = await sendWol('00:11:22:33:44:55', '127.0.0.1', receiver.address().port);
  const [packet] = await received;
  assert.equal(result.broadcast, '127.0.0.1');
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 255));
  for (let n = 0; n < 16; n++) assert.equal(packet.subarray(6 + n * 6, 12 + n * 6).toString('hex'), '001122334455');
});
