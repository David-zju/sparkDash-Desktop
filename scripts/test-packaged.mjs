import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { testPackagedFeatures } from './packaged-features.mjs';

const executablePath = path.resolve('release/sparkDash-darwin-arm64/sparkDash.app/Contents/MacOS/sparkDash');
const live = process.argv.includes('--live');
const dataDir = path.resolve(live ? '.desktop-test/live-data' : '.desktop-test/packaged-alias-only-data');
fs.mkdirSync(dataDir, { recursive: true });
const keyPath = path.join(dataDir, 'secrets-key.encrypted');
const initialKey = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
const errors = [];
let application;
let origin;
const report = { testedAt: new Date().toISOString(), checks: [] };
const check = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };

async function waitForLiveMetrics(page) {
  await page.waitForFunction(async () => {
    const nodes = (await (await fetch('/api/sparks')).json()).sparks;
    const metrics = await Promise.all(nodes.map(async (node) => (await fetch(`/api/sparks/${node.id}/metrics`)).json()));
    return metrics.length === 4 && metrics.every((node) => node.online && node.metrics.gpu && node.metrics.cpu);
  }, undefined, { timeout: 45000 });
  await page.getByText('4/4 online', { exact: true }).waitFor({ timeout: 45000 });
}

async function launch() {
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  // macOS may wait for the user to authorize this build's Safe Storage item.
  application = await electron.launch({ executablePath, args: [`--data-dir=${dataDir}`], env, timeout: 120000 });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 120000 });
  await page.getByTitle('Settings', { exact: true }).waitFor();
  origin = new URL(page.url()).origin;
  return page;
}

try {
  let page = await launch();
  assert.equal(await page.evaluate(() => window.sparkDesktop?.isDesktop), true);
  assert.deepEqual(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process })), { require: 'undefined', process: 'undefined' });
  check('packaged app starts with no external Node and an isolated renderer');
  assert.equal((await fetch(`${origin}/api/sparks`)).status, 403);
  check('unauthenticated local clients cannot read the API');
  const api = async (url, init) => page.evaluate(async ({ url, init }) => {
    const response = await fetch(url, init);
    return { status: response.status, body: await response.json() };
  }, { url, init });
  assert.equal((await api('/api/runtime')).body.desktop, true);
  const socket = await page.evaluate(() => new Promise((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws');
    ws.onerror = () => reject(new Error('WebSocket rejected'));
    ws.onmessage = (event) => { ws.close(); resolve(JSON.parse(event.data).type); };
  }));
  assert.equal(socket, 'snapshot');
  check('renderer API and WebSocket receive main-process authentication');
  if (!live) {
    await testPackagedFeatures({ page, application, api, check, executablePath, dataDir });
    origin = new URL(page.url()).origin;
  }
  if (live) {
    await waitForLiveMetrics(page);
    check('packaged app collects current metrics from all four real DGX devices');
    await page.getByRole('navigation', { name: 'Sparks' }).getByRole('button', { name: 'DGX 1', exact: true }).click();
    await page.getByText('CPU power (estimate)', { exact: true }).waitFor();
    await page.getByText('GPU-attributed memory (estimate)', { exact: true }).waitFor();
    await page.getByText('Sample times and data sources', { exact: true }).click();
    await page.getByText(/SSH · nvidia-smi/).waitFor();
    await page.screenshot({ path: '.desktop-test/packaged-live-detail.png', fullPage: true });
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    check('device detail shows metric provenance and labels estimated CPU power');
  }
  await page.getByRole('button', { name: /Switch theme/ }).click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.getByTitle('Settings', { exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  check('settings dialog and theme controls work');
  const settings = (await api('/api/settings')).body;
  assert.equal((await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, pollIntervalMs: 5000 }) })).status, 200);
  if (live) await waitForLiveMetrics(page);
  await page.screenshot({ path: `.desktop-test/packaged-${live ? 'live' : 'empty'}.png`, fullPage: true });
  await page.evaluate(() => window.addEventListener('beforeunload', () => {
    window.sparkDesktop.setPreference('sparkdash.lifecycle-test', 'saved-during-unload');
  }, { once: true }));
  const beforeSleep = origin;
  await application.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByText('Sampling paused', { exact: true }).waitFor();
  await assert.rejects(fetch(`${beforeSleep}/api/sparks`));
  await application.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30000 });
  origin = new URL(page.url()).origin;
  assert.equal(await page.evaluate(() => window.sparkDesktop.getPreference('sparkdash.lifecycle-test')), 'saved-during-unload');
  if (live) await waitForLiveMetrics(page);
  check('sleep stops sampling and wake starts a fresh backend');
  const firstOrigin = origin;
  await application.close();
  await assert.rejects(fetch(`${firstOrigin}/api/sparks`));
  check('closing the app stops its backend');
  if (!live) {
    // With no saved secrets, an unusable key left by a prior install is irrelevant.
    assert.equal(fs.existsSync(path.join(dataDir, 'sparks-secrets.json')), false);
    if (!initialKey) assert.equal(fs.existsSync(keyPath), false, 'key-only launch must not initialize Keychain');
    fs.writeFileSync(keyPath, 'unused-legacy-key-fixture');
  }
  page = await launch();
  if (live) await waitForLiveMetrics(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  assert.equal((await api('/api/settings')).body.pollIntervalMs, 5000);
  check('preferences and settings survive an app restart and backend port change');
  if (live) {
    if (initialKey) assert.deepEqual(fs.readFileSync(keyPath), initialKey);
    else assert.equal(fs.existsSync(keyPath), false);
  } else assert.equal(fs.readFileSync(keyPath, 'utf8'), 'unused-legacy-key-fixture');
  check('SSH-key-only profiles start and restart without requiring Keychain, preserving unused old keys');
  assert.deepEqual(errors, []);
  fs.writeFileSync(`.desktop-test/packaged-${live ? 'live-' : ''}report.json`, JSON.stringify(report, null, 2));
} finally {
  await application?.close();
}
