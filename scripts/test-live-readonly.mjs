import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { backendEnvironment } from '../desktop/runtime-env.mjs';

// The user supplied these four SSH aliases. No mutation or inference requests
// are sent to the devices. All test artifacts stay in an isolated local folder.
const dataDir = path.resolve('.desktop-test/live-data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const nodes = ['a533', '008c', 'ac62', 'af8d'].map((suffix, i) => ({
  id: `dgx-${i + 1}`, name: `DGX ${i + 1}`, lanIp: `aitopatom-${suffix}.local`,
  isLocal: false, kind: 'spark', role: 'standalone', llmMonitoring: false,
  comfyMonitoring: false, hermesMonitoring: false, tailscaleMonitoring: false,
  ssh: { host: `dgx-${i + 1}`, user: 'david', auth: 'key' },
}));
fs.writeFileSync(path.join(dataDir, 'sparks.json'), JSON.stringify({ sparks: nodes }, null, 2), { mode: 0o600 });
const token = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, backendEnvironment({ dataDir, token, secretsKey: crypto.randomBytes(32).toString('hex') }));
const { createBackend } = await import('../server/index.js');
const backend = createBackend();
let ws;
try {
  const { origin } = await backend.start();
  ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Authorization: `Bearer ${token}`, Origin: origin } });
  let last;
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Four current snapshots not received: ${JSON.stringify(last?.sparks?.map((s) => ({ id: s.id, online: s.online, gpu: !!s.metrics.gpu, cpu: !!s.metrics.cpu, storage: s.metrics.storage?.length })))}`)), 45000);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      last = JSON.parse(raw);
      if (last.sparks.length === 4 && last.sparks.every((s) => s.online && s.metrics.gpu && s.metrics.cpu && s.metrics.ram?.total > 0 && s.metrics.storage?.length && s.metrics.network?.interfaces?.length)) {
        clearTimeout(timer); resolve(last);
      }
    });
  });
  const report = { testedAt: new Date().toISOString(), mode: 'real devices, read-only', nodes: ready.sparks.map((s) => ({
    id: s.id, online: s.online, hardware: s.hardware,
    gpuTemperature: s.metrics.gpu.temperature, gpuUsage: s.metrics.gpu.usage,
    gpuPower: s.metrics.gpu.power, cpu: s.metrics.cpu, ramMB: s.metrics.ram.total,
    networkInterfaces: s.metrics.network.interfaces.map((i) => i.name),
    storageDevices: s.metrics.storage.length, memoryBandwidth: s.metrics.unifiedMemory?.bandwidth.current,
  })) };
  for (const node of report.nodes) {
    assert.ok(node.gpuTemperature > 0);
    assert.ok(node.ramMB > 100000);
    assert.equal(node.memoryBandwidth, null);
  }
  fs.writeFileSync('.desktop-test/live-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  ws?.terminate();
  await backend.stop('Read-only validation finished');
}
