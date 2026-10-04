import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DecodeBenchManager } from '../DecodeBench.js';
import { PrefillBenchManager } from '../PrefillBench.js';

for (const Manager of [DecodeBenchManager, PrefillBenchManager]) {
  test(`${Manager.name} shows the latest interrupted run, never an older success or another port`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-bench-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const history = path.join(dir, 'history.json');
    const active = path.join(dir, 'active.json');
    fs.writeFileSync(history, JSON.stringify({ fixture: [{ benchId: 'completed', sparkId: 'fixture', status: 'completed', startedAt: 1, completedAt: 2, config: { port: 8888 }, results: [{}] }] }));
    fs.writeFileSync(active, JSON.stringify([{ benchId: 'interrupted', sparkId: 'fixture', status: 'running', startedAt: 3, config: { port: 8888 }, results: [] }]));
    const manager = new Manager(history, active);
    const last = manager.getLast('fixture', 8888);
    assert.equal(last.benchId, 'interrupted');
    assert.equal(last.status, 'failed');
    assert.match(last.error, /Interrupted/);
    assert.equal(manager.getLast('fixture', 9999), null);
    assert.equal(manager.getHistory('fixture').length, 2, 'previous results remain in history');
  });
}
