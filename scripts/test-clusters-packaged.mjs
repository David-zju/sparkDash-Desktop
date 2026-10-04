import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// The real app and real read-only fabric checks, with all configuration writes isolated.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-cluster-packaged-'));
const executablePath = path.resolve('release/sparkDash-darwin-arm64/sparkDash.app/Contents/MacOS/sparkDash');
const sparks = [1, 2, 3, 4].map((n) => ({ id: `dgx-${n}`, name: `DGX ${n}`, kind: 'spark', role: 'standalone',
  isLocal: false, llmMonitoring: false, ssh: { host: `dgx-${n}`, user: '', auth: 'key' } }));
fs.writeFileSync(path.join(dataDir, 'sparks.json'), JSON.stringify({ sparks }));
let app;
const errors = [];
try {
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, args: [`--data-dir=${dataDir}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  await page.evaluate(() => window.sparkDesktop.setPreference('sparkdash-language', 'zh-CN'));
  await page.getByRole('button', { name: '检测 200G / 创建集群', exact: true }).click();
  await page.getByRole('button', { name: 'DGX 1 + DGX 2', exact: true }).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'DGX 3 + DGX 4', exact: true }).waitFor();
  fs.mkdirSync('.desktop-test', { recursive: true });
  await page.screenshot({ path: '.desktop-test/cluster-packaged-live-network.png' });
  await page.getByRole('button', { name: 'DGX 1 + DGX 2', exact: true }).click();
  await page.getByRole('button', { name: '分配角色', exact: true }).click();
  await page.getByLabel('集群名称', { exact: true }).fill('DGX 1 + 2 · 集群预览');
  await page.locator('input[type="radio"][value="dgx-1"]').check();
  await page.getByRole('button', { name: '确认集群', exact: true }).click();
  await page.getByRole('button', { name: '保存集群', exact: true }).click();
  await page.getByRole('region', { name: 'DGX 1 + 2 · 集群预览', exact: true }).waitFor();
  await page.waitForFunction(async () => {
    const nodes = await Promise.all(['dgx-1', 'dgx-2'].map(async (id) => (await fetch(`/api/sparks/${id}/metrics`)).json()));
    return nodes.every((n) => n.online && n.metrics.gpu);
  }, undefined, { timeout: 45000 });
  // Wait for the next WebSocket broadcast to reach the rendered cards as well.
  await page.getByRole('region', { name: 'DGX 1 + 2 · 集群预览', exact: true }).getByText('2/2 在线', { exact: false }).waitFor();
  await page.getByRole('region', { name: 'DGX 1 + 2 · 集群预览', exact: true }).getByText('使用率', { exact: true }).first().waitFor();
  await page.screenshot({ path: '.desktop-test/cluster-packaged-live-overview.png', fullPage: true });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sparks.json'))).sparks;
  assert.equal(saved[1].workerHeadId, 'dgx-1');
  assert.equal(saved[0].clusterName, 'DGX 1 + 2 · 集群预览');
  assert.equal(fs.existsSync(path.join(dataDir, 'secrets-key.encrypted')), false);
  assert.deepEqual(errors, []);
  console.log('PASS packaged app discovers both real 200G pairs and saves/renders a cluster in isolated test data; no Keychain initialization');
} finally {
  await app?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
