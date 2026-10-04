import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// No real devices or user profile: the only saved test device targets a closed loopback port.
fs.mkdirSync('.desktop-test', { recursive: true });
const dataDir = fs.mkdtempSync(path.resolve('.desktop-test/language-'));
const executablePath = path.resolve(process.argv.find((arg) => arg.startsWith('--executable='))?.slice('--executable='.length)
  ?? 'release/sparkDash-darwin-arm64/sparkDash.app/Contents/MacOS/sparkDash');
const errors = [];
const checks = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let application;

async function launch(language = 'en') {
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  application = await electron.launch({ executablePath, args: [`--data-dir=${dataDir}`], env });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  await page.getByTitle(language === 'en' ? 'Settings' : '设置', { exact: true }).waitFor();
  return page;
}

async function choose(language) {
  await application.evaluate(({ Menu }, selected) => {
    Menu.getApplicationMenu().getMenuItemById(`language-${selected}`).click();
  }, language);
}

async function checkedLanguage() {
  return application.evaluate(({ Menu }) => ['en', 'zh-CN'].filter((language) =>
    Menu.getApplicationMenu().getMenuItemById(`language-${language}`).checked));
}

try {
  let page = await launch();
  const origin = new URL(page.url()).origin;
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  let navigations = 0;
  let newSockets = 0;
  page.on('framenavigated', () => navigations++);
  page.on('websocket', () => newSockets++);
  await page.getByRole('button', { name: 'Add Spark/GPU Host', exact: true }).first().click();
  await page.getByLabel('Name', { exact: true }).fill('Offline');
  await page.getByLabel('Host / SSH alias', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('SSH Port', { exact: true }).fill('1');
  await page.getByLabel('SSH User', { exact: true }).fill('fixture-user');
  await choose('zh-CN');
  const add = page.getByRole('dialog', { name: '添加 Spark / GPU 主机', exact: true });
  await add.waitFor();
  assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), 'Offline');
  assert.equal(await page.getByLabel('SSH 用户名', { exact: true }).inputValue(), 'fixture-user');
  assert.equal(await page.getByLabel('SSH 认证方式', { exact: true }).inputValue(), 'key');
  assert.equal(await page.evaluate(() => window.sparkDesktop.getPreference('sparkdash-language')), 'zh-CN');
  assert.deepEqual(await checkedLanguage(), ['zh-CN']);
  await choose('en');
  await page.getByLabel('Name', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Offline');
  await choose('zh-CN');
  await add.waitFor();
  assert.equal(navigations, 0);
  assert.equal(newSockets, 0);
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
  assert.equal(new URL(page.url()).origin, origin);
  await add.locator('.modal-sheet__body').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: '.desktop-test/language-add-zh.png', fullPage: true });
  check('native menu updates mounted forms and accessibility labels without reload, lost drafts, or new WebSockets');

  await add.getByRole('button', { name: '保存', exact: true }).click();
  await add.waitFor({ state: 'hidden' });
  const device = await page.evaluate(async () => (await (await fetch('/api/sparks')).json()).sparks[0]);
  assert.equal(device.name, 'Offline');
  assert.equal(device.ssh.auth, 'key');
  assert.equal(device.ssh.port, 1);
  assert.equal(device.ssh.user, 'fixture-user');
  await page.getByRole('navigation', { name: 'Spark 设备' }).getByRole('button', { name: 'Offline', exact: true }).click();
  await page.getByText('CPU 指标不可用', { exact: true }).waitFor();
  await page.getByText('GPU 指标不可用', { exact: true }).waitFor();
  assert.equal(await page.getByText('Settings', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Refresh', { exact: true }).count(), 0);
  await page.screenshot({ path: '.desktop-test/language-detail-zh.png', fullPage: true });
  check('Chinese device form saves unchanged machine values; device names stay intact and panels translate');

  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('button', { name: '5s', exact: true }).click();
  await page.getByLabel('语言', { exact: true }).selectOption('en');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.deepEqual(await checkedLanguage(), ['en']);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  assert.deepEqual(await checkedLanguage(), ['zh-CN']);
  await page.locator('.settings-panel .overflow-y-auto').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: '.desktop-test/language-settings-zh.png', fullPage: true });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/settings')).json()).pollIntervalMs), 5000);
  check('settings and native menu synchronize both ways while keeping unsaved settings');

  await application.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await page.getByRole('heading', { name: '采样已暂停', exact: true }).waitFor();
  await choose('en');
  await page.getByRole('heading', { name: 'Sampling paused', exact: true }).waitFor();
  await choose('zh-CN');
  await page.getByRole('heading', { name: '采样已暂停', exact: true }).waitFor();
  await application.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  await page.getByTitle('设置', { exact: true }).waitFor();
  check('native status page switches language while suspended and retains it after reconnect');

  await application.close();
  application = null;
  page = await launch('zh-CN');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.deepEqual(await checkedLanguage(), ['zh-CN']);
  await choose('en');
  await page.getByTitle('Settings', { exact: true }).waitFor();
  await application.close();
  application = null;
  page = await launch('en');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.deepEqual(await checkedLanguage(), ['en']);
  check('both language choices survive full app restarts');
  assert.deepEqual(errors, []);
  fs.writeFileSync('.desktop-test/language-report.json', JSON.stringify({ testedAt: new Date().toISOString(), checks, errors }, null, 2));
} finally {
  await application?.close();
}
