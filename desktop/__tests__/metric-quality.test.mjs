import test from 'node:test';
import assert from 'node:assert/strict';
import { SparkMonitor } from '../../server/sparks/SparkMonitor.js';
import { hasFreshPowerTelemetry } from '../../server/energy/FleetEnergyRuntime.js';

test('desktop snapshots identify unknown, current and stale metric samples without inventing timestamps', (t) => {
  const previous = process.env.SPARKDASH_DESKTOP;
  process.env.SPARKDASH_DESKTOP = '1';
  t.after(() => { if (previous === undefined) delete process.env.SPARKDASH_DESKTOP; else process.env.SPARKDASH_DESKTOP = previous; });
  const monitor = new SparkMonitor({ id: 'fixture', llmMonitoring: false, hermesMonitoring: false });
  assert.equal(monitor.snapshot().metricQuality.gpu.status, 'unknown');
  assert.equal(monitor.snapshot().metricQuality.gpu.observedAt, null);
  monitor.online = true;
  monitor._metricCollectionSuccessful.gpu = true;
  monitor._lastUpdate.gpu = Date.now();
  let snapshot = monitor.snapshot();
  assert.equal(snapshot.metricQuality.gpu.status, 'current');
  assert.equal(snapshot.metricQuality.gpu.observedAt, monitor._lastUpdate.gpu);
  assert.match(snapshot.metricQuality.gpu.source, /nvidia-smi/);
  monitor._lastUpdate.gpu -= 20000;
  snapshot = monitor.snapshot();
  assert.equal(snapshot.metricQuality.gpu.status, 'stale');
  assert.equal(snapshot.metrics.gpu, null);
  monitor._metricCollectionSuccessful.gpu = false;
  assert.equal(monitor.snapshot().metricQuality.gpu.status, 'unknown');
});

test('generic GPU hosts and initial CPU baselines cannot feed the Spark energy estimate', () => {
  const now = Date.now();
  const snapshot = { online: true, metrics: { gpu: { power: { draw: 20 }, temperature: 40 }, cpu: { usage: 30 } } };
  const monitor = { _metricCollectionSuccessful: { gpu: true, cpu: true }, _lastUpdate: { gpu: now, cpu: now } };
  assert.equal(hasFreshPowerTelemetry(snapshot, monitor, now), true);
  assert.equal(hasFreshPowerTelemetry({ ...snapshot, kind: 'host' }, monitor, now), false);
  snapshot.metrics.cpu.usageAvailable = false;
  assert.equal(hasFreshPowerTelemetry(snapshot, monitor, now), false);
});
