import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { backendEnvironment } from '../desktop/runtime-env.mjs';

// Real UI / HTTP / manager, with explicitly simulated tool output. No remote commands.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-bandwidth-ui-'));
const token = 'b'.repeat(64);
Object.assign(process.env, backendEnvironment({ dataDir, token }));
const { FabricBenchmark } = await import('../server/collectors/FabricBenchmark.js');
const nodes = ['a', 'b'].map((id, i) => ({ id, name: `Spark ${i + 1}`, kind: 'spark', role: i ? 'worker' : 'head',
  clusterName: i ? null : '网络检测 · 模拟环境', workerHeadId: i ? 'a' : null, llmMonitoring: false, ssh: { host: `fixture-${id}` } }));
fs.writeFileSync(path.join(dataDir, 'sparks.json'), JSON.stringify({ sparks: nodes }));
const networkPath = { key: 'p', aInterface: 'cx0', aIp: '192.0.2.1', bInterface: 'cx0', bIp: '192.0.2.2',
  speedMbps: 200000, forward: true, reverse: true, forwardReason: 'reachable', reverseReason: 'reachable' };
const discover = async () => ({ checkedAt: Date.now(), nodes: nodes.map((n) => ({ id: n.id, name: n.name, error: null, interfaces: [] })),
  links: [{ a: 'a', b: 'b', paths: [networkPath], verified200G: true, status: 'connected' }] });
let runs = 0, missing = false;
const benchmark = new FabricBenchmark({ discover, exec: async (_spark, command, options) => {
  const config = JSON.parse(Buffer.from(command.match(/'([A-Za-z0-9+/=]+)'$/)[1], 'base64').toString());
  if (config.action === 'cancel') return '{"stopped":1}';
  if (config.action === 'inspect') return JSON.stringify({ tools: {
    iperf3: { available: !missing, reason: missing ? 'missing-tool' : null, version: 'fixture' },
    ib_write_bw: { available: !missing, reason: missing ? 'missing-tool' : null, version: 'fixture' },
  }, rdma: { device: 'fixture-roce0', port: 1, gid: 3 } });
  runs++;
  if (config.server) options.onStdout('{"ready":true}\n');
  await new Promise((resolve) => setTimeout(resolve, config.server ? 1000 : 600));
  return JSON.stringify({ code: 0, stderr: '', stdout: config.kind === 'tcp'
    ? JSON.stringify({ end: { sum_received: { bits_per_second: 125e9 } } })
    : '#bytes #iterations BW peak[Gb/sec] BW average[Gb/sec] MsgRate[Mpps]\n65536 20000 0.00 178.25 0.34\n' });
} });
const { createBackend } = await import('../server/index.js');
const { SparkMonitor } = await import('../server/sparks/SparkMonitor.js');
const backend = createBackend({ fabricDiscovery: discover, fabricBenchmark: benchmark, monitorFactory: (spark) => {
  const monitor = new SparkMonitor(spark); monitor.start = () => {}; monitor.online = true; return monitor;
} });
let browser, page;
const errors = [];
try {
  const { origin } = await backend.start();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  await page.addInitScript(() => {
    localStorage.setItem('sparkdash-language', 'zh-CN');
    window.sparkDesktop = { isDesktop: true, platform: 'darwin', getPreference: (key) => localStorage.getItem(key),
      setPreference: (key, value) => localStorage.setItem(key, value), onPreferenceChange: () => () => {} };
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(origin);
  const open = () => page.getByRole('button', { name: '带宽 / RDMA 检测', exact: true }).click();
  await open();
  await page.getByRole('button', { name: '查找网口', exact: true }).click();
  const start = page.getByRole('button', { name: '开始测试', exact: true });
  await start.waitFor();
  assert.equal(runs, 0);
  await start.click();
  await page.getByRole('button', { name: '停止测试', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await open();
  await page.getByText('178.25 Gb/s', { exact: true }).last().waitFor();
  await page.waitForFunction(() => document.querySelector('[role="dialog"] h3')?.textContent.includes('已结束'));
  assert.equal(runs, 8);
  assert.equal(await page.getByText('125.00 Gb/s', { exact: true }).count(), 2);
  assert.equal(await page.getByText('178.25 Gb/s', { exact: true }).count(), 2);
  fs.mkdirSync('.desktop-test', { recursive: true });
  await page.screenshot({ path: '.desktop-test/cluster-bandwidth-fixture-zh.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.desktop-test/cluster-bandwidth-fixture-mobile.png' });
  missing = true;
  await page.getByRole('button', { name: '查找网口', exact: true }).click();
  await start.click();
  await page.getByText('a: iperf3: 缺少检测工具', { exact: true }).waitFor();
  assert.equal(runs, 8, 'missing tools must not launch a traffic process');
  assert.deepEqual(errors, []);
  console.log('PASS: explicit start, two directions, reopen, Chinese results, narrow viewport, missing tools; fixture data only');
} catch (error) {
  fs.mkdirSync('.desktop-test', { recursive: true });
  if (page) { await page.screenshot({ path: '.desktop-test/cluster-bandwidth-failure.png' }); console.error(await page.locator('body').innerText()); }
  console.error(errors);
  throw error;
} finally {
  await browser?.close(); await backend.stop(); fs.rmSync(dataDir, { recursive: true, force: true });
}
