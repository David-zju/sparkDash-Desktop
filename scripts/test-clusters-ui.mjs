import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { backendEnvironment } from '../desktop/runtime-env.mjs';

// Isolated fixture backend: real HTTP, persistence and WebSocket paths; no remote commands.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-cluster-ui-'));
const token = 'c'.repeat(64);
const responsive = process.argv.includes('--responsive');
const previewThree = responsive || process.argv.includes('--three-node-preview');
Object.assign(process.env, backendEnvironment({ dataDir, token }));
const nodes = [1, 2, 3, 4].map((n) => ({ id: `dgx-${n}`, name: `DGX ${n}`, kind: 'spark', role: 'standalone', ssh: { host: `fixture-${n}` } }));
if (previewThree) {
  Object.assign(nodes[0], { role: 'head', clusterName: '三机集群 · 示例数据' });
  for (const node of nodes.slice(1, 3)) Object.assign(node, { role: 'worker', workerHeadId: 'dgx-1' });
}
fs.writeFileSync(path.join(dataDir, 'sparks.json'), JSON.stringify({ sparks: nodes }));
const { createBackend } = await import('../server/index.js');
const { SparkMonitor } = await import('../server/sparks/SparkMonitor.js');
const backend = createBackend({
  monitorFactory: (spark) => {
    const monitor = new SparkMonitor(spark);
    monitor.start = () => {};
    monitor.online = true;
    if (previewThree) {
      const snapshot = monitor.snapshot.bind(monitor);
      monitor.snapshot = () => {
        const s = snapshot();
        const n = Number(spark.id.slice(-1));
        s.metrics.gpu = { usage: 38 + n * 3, temperature: 44 + n,
          power: { draw: 42 + n, limit: 120 }, vram: { used: 49152, total: 124544, available: 75392, percentage: 39 } };
        s.metrics.cpu = { usage: 12, temperature: 43 + n };
        s.metrics.unifiedMemory = { used: 49152, total: 124544, available: 75392, percentage: 39 };
        return s;
      };
    }
    return monitor;
  },
  fabricDiscovery: async (sparks) => ({ checkedAt: Date.now(), nodes: sparks.map((s) => ({ id: s.id, name: s.name, error: null, interfaces: [
    { name: 'enp1s0f1np1', carrier: true, state: 'up', speedMbps: 200000, addresses: [{ address: `10.100.240.${s.id.slice(-1)}`, prefix: 24 }], rdmaDevices: [] },
  ] })), links: sparks.flatMap((a, i) => sparks.slice(i + 1).map((b) => ({ a: a.id, b: b.id, paths: [],
    status: a.id === 'dgx-1' && b.id === 'dgx-2' || a.id === 'dgx-3' && b.id === 'dgx-4' ? 'connected' : 'unknown',
    verified200G: a.id === 'dgx-1' && b.id === 'dgx-2' || a.id === 'dgx-3' && b.id === 'dgx-4',
  }))) }),
});
let browser;
const errors = [];
try {
  const { origin } = await backend.start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${origin}/api/clusters/discover`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${origin}/api/clusters/discover`, { method: 'POST', headers, body: JSON.stringify({ ids: ['unknown', 'dgx-1'] }) })).status, 400);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1050 }, extraHTTPHeaders: headers });
  await page.addInitScript(() => {
    localStorage.setItem('sparkdash-language', 'zh-CN');
    window.sparkDesktop = { isDesktop: true, platform: 'darwin',
      getPreference: (key) => localStorage.getItem(key), setPreference: (key, value) => localStorage.setItem(key, value),
      onPreferenceChange: () => () => {}, listSshAliases: async () => ({ aliases: [], warnings: [] }) };
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(origin);
  if (responsive) {
    const group = page.getByRole('region', { name: '三机集群 · 示例数据', exact: true });
    await group.waitFor();
    fs.mkdirSync('.desktop-test', { recursive: true });
    const layoutFailures = [];
    // Keep the window wide: the cluster must respond to its own available space.
    for (const desktop of [true, false]) {
      await page.evaluate((desktop) => {
        if (desktop) document.documentElement.dataset.desktop = 'darwin';
        else delete document.documentElement.dataset.desktop;
      }, desktop);
      for (const [width, columns] of [[1100, 3], [760, 2], [360, 1]]) {
        await group.evaluate((el, width) => { el.style.width = `${width}px`; }, width);
        const rects = await group.locator('.overview-card').evaluateAll((els) => els.map((el) => {
          const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width };
        }));
        if (rects.filter((r) => Math.abs(r.y - rects[0].y) < 1).length !== columns) {
          layoutFailures.push(`${desktop ? 'desktop' : 'web'} cluster at ${width}px should use ${columns} columns`);
        }
      }
    }
    await group.evaluate((el) => { el.style.removeProperty('width'); });
    await page.evaluate(() => { document.documentElement.dataset.desktop = 'darwin'; });
    for (const [style, label] of [['sections', '分区卡片'], ['compact', '紧凑监控行'], ['trends', '实时趋势']]) {
      await page.setViewportSize({ width: 1400, height: 1050 });
      await page.getByRole('button', { name: label, exact: true }).click();
      const card = group.locator('.overview-card').first();
      const value = card.locator(style === 'trends' ? '.overview-trend-value' : '.overview-usage-value').first();
      const wideFont = await value.evaluate((el) => getComputedStyle(el).fontSize);
      if (style === 'sections') {
        const ys = await card.locator('.overview-sectioned-usage .overview-usage-summary').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
        assert.equal(ys[1], ys[0], 'Wide cards retain side-by-side compute sections');
      }
      for (const viewport of [1400, 320]) {
        await page.setViewportSize({ width: viewport, height: 1050 });
        await group.evaluate((el, viewport) => { el.style.width = viewport === 1400 ? '320px' : ''; }, viewport);
        const overflow = await group.locator('.overview-card').evaluateAll((cards) => cards.flatMap((el) => Array.from(el.querySelectorAll('*'))
          .filter((child) => child instanceof HTMLElement && child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1)
          .map((child) => child.className)));
        if (overflow.length) layoutFailures.push(`${style} at viewport ${viewport}: overflowing content: ${overflow.join(', ')}`);
        assert.equal(await value.evaluate((el) => getComputedStyle(el).fontSize), wideFont, 'Reflow preserves metric font size');
        if (style === 'sections') {
          const ys = await card.locator('.overview-sectioned-usage .overview-usage-summary').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
          if (ys[1] <= ys[0]) layoutFailures.push(`Narrow cluster cards must stack GPU and CPU sections at viewport ${viewport}`);
        }
        if (style === 'compact') {
          const sizes = await card.locator('.overview-usage-summary').first().evaluate((el) => ({
            row: el.getBoundingClientRect().width,
            track: el.querySelector('.overview-usage-track').getBoundingClientRect().width,
          }));
          assert.ok(Math.abs(sizes.row - sizes.track) < 1, 'Narrow compact cards give the usage bar its own full-width row');
        }
      }
      await card.screenshot({ path: `.desktop-test/cluster-responsive-${style}-narrow.png` });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(layoutFailures, []);
    console.log('PASS cluster container widths 1100/760/360; all three card styles at 320px');
  } else if (previewThree) {
    const group = page.getByRole('region', { name: '三机集群 · 示例数据', exact: true });
    await group.waitFor();
    fs.mkdirSync('.desktop-test', { recursive: true });
    for (const [width, columns, suffix] of [[1200, 3, 'wide'], [800, 2, 'medium'], [390, 1, 'narrow']]) {
      await page.setViewportSize({ width, height: 1050 });
      const cards = group.locator('.overview-card');
      assert.equal(await cards.count(), 3);
      const rects = await cards.evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width };
      }));
      assert.equal(rects.filter((r) => Math.abs(r.y - rects[0].y) < 1).length, columns);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await group.screenshot({ path: `.desktop-test/cluster-three-${suffix}-zh.png` });
      console.log(`PASS ${width}px: ${columns} columns, Head first, all three cards within the cluster`);
    }
    assert.deepEqual(errors, []);
  } else {
  await page.getByRole('button', { name: '检测 200G / 创建集群', exact: true }).click();
  await page.getByRole('button', { name: 'DGX 1 + DGX 2', exact: true }).waitFor();
  fs.mkdirSync('.desktop-test', { recursive: true });
  await page.screenshot({ path: '.desktop-test/cluster-network-zh.png' });
  await page.getByRole('button', { name: 'DGX 1 + DGX 2', exact: true }).click();
  await page.getByRole('button', { name: '分配角色', exact: true }).click();
  await page.getByLabel('集群名称', { exact: true }).fill('推理实验室');
  await page.locator('input[type="radio"][value="dgx-1"]').check();
  await page.screenshot({ path: '.desktop-test/cluster-roles-zh.png' });
  await page.getByRole('button', { name: '确认集群', exact: true }).click();
  await page.getByRole('button', { name: '保存集群', exact: true }).click();
  await page.getByRole('region', { name: '推理实验室', exact: true }).waitFor();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'sparks.json'))).sparks[1].workerHeadId, 'dgx-1');
  await page.reload();
  await page.getByRole('region', { name: '推理实验室', exact: true }).waitFor();
  await page.getByRole('button', { name: '检测 200G / 创建集群', exact: true }).click();
  await page.getByRole('button', { name: 'DGX 3 + DGX 4', exact: true }).waitFor();
  await page.getByRole('button', { name: '分配角色', exact: true }).click();
  await page.getByLabel('集群名称', { exact: true }).fill('模型验证');
  await page.locator('input[type="radio"][value="dgx-3"]').check();
  await page.getByRole('button', { name: '确认集群', exact: true }).click();
  await page.getByRole('button', { name: '保存集群', exact: true }).click();
  await page.getByRole('region', { name: '模型验证', exact: true }).waitFor();
  await page.screenshot({ path: '.desktop-test/cluster-overview-zh.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Overview overflows mobile viewport');
  await page.getByRole('region', { name: '推理实验室', exact: true }).getByRole('button', { name: '检测网络 / 编辑集群', exact: true }).click();
  await page.getByRole('button', { name: '分配角色', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '分配角色', exact: true }).click();
  await page.locator('input[type="radio"][value="dgx-2"]').check();
  await page.getByRole('button', { name: '确认集群', exact: true }).click();
  await page.screenshot({ path: '.desktop-test/cluster-mobile-review-zh.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Dialog overflows mobile viewport');
  await page.getByRole('button', { name: '保存集群', exact: true }).click();
  await page.getByRole('region', { name: '推理实验室', exact: true }).getByText('Head · DGX 2', { exact: false }).waitFor();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'sparks.json'))).sparks;
  assert.equal(saved[0].workerHeadId, 'dgx-2');
  assert.equal(saved[1].role, 'head');
  await page.getByRole('region', { name: '推理实验室', exact: true }).getByRole('button', { name: '检测网络 / 编辑集群', exact: true }).click();
  await page.getByRole('button', { name: '解散集群', exact: true }).click();
  await page.getByRole('button', { name: '解散集群', exact: true }).click();
  await page.getByRole('region', { name: '推理实验室', exact: true }).waitFor({ state: 'detached' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'sparks.json'))).sparks[0].role, 'standalone');
  assert.deepEqual(errors, []);
  console.log('PASS real HTTP/WS create, persist, reload, two groups, change Head, dissolve; Chinese desktop/mobile UI');
  }
} finally {
  await browser?.close();
  await backend.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
