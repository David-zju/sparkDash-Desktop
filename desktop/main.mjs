import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, safeStorage, session, shell, utilityProcess } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendEnvironment } from './runtime-env.mjs';
import { loadSecretsKey, needsSecretsKey } from './key-store.mjs';
import { createPreferences } from './preferences.mjs';
import { listSshAliases } from './ssh-config.mjs';
import { LANGUAGE_KEY, normalizeLanguage, applicationMenuTemplate, statusMessage } from './language.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
app.setName('sparkDash');
// Explicit data-dir supports isolated packaged tests and portable diagnostics.
const dataArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
if (dataArg) app.setPath('userData', path.resolve(dataArg.slice('--data-dir='.length)));
let window;
let worker;
let origin;
let token;
let quitting = false;
let suspended = false;
let intentionalStops = new WeakSet();
let transition = Promise.resolve();
let prefs;
let log;
let appSession;
let secretsKey;
let currentStatus;
const currentLanguage = () => normalizeLanguage(prefs?.snapshot()[LANGUAGE_KEY]);
const preferenceOrigins = new Set();
const windowThemes = {
  white: { background: '#f5f5f5', text: '#1a1a1a', muted: '#5a5a5a', appearance: 'light' },
  light: { background: '#f5f2ea', text: '#1a1a18', muted: '#5a5748', appearance: 'light' },
  dark: { background: '#1a1a1a', text: '#e4e4e4', muted: '#8a8a8a', appearance: 'dark' },
  oled: { background: '#000000', text: '#e4e4e4', muted: '#7a7a7a', appearance: 'dark' },
};
function currentWindowTheme() {
  const name = prefs?.snapshot()['sparkdash-theme'];
  return Object.hasOwn(windowThemes, name) ? windowThemes[name] : windowThemes.dark;
}
function syncWindowTheme() {
  const theme = currentWindowTheme();
  nativeTheme.themeSource = theme.appearance;
  if (window && !window.isDestroyed()) window.setBackgroundColor(theme.background);
}

function syncLanguage() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
    language: currentLanguage(), platform: process.platform,
    setLanguage(value) {
      try {
        prefs.set(LANGUAGE_KEY, value);
        syncLanguage();
      } catch (error) {
        // Restore the radio state if persistence fails.
        syncLanguage();
        dialog.showErrorBox(currentLanguage() === 'zh-CN' ? '无法保存语言设置' : 'Could not save language', error.message);
      }
    },
    reconnect: () => void enqueue(async () => { await stopWorker('Reconnect requested'); await startWorker(); }),
    openData: () => void shell.openPath(app.getPath('userData')),
    openLog: () => void shell.openPath(path.join(app.getPath('userData'), 'desktop.log')),
  })));
  if (window && !window.isDestroyed()) {
    window.webContents.send('preferences:changed', LANGUAGE_KEY, currentLanguage());
    if (currentStatus) void statusPage(currentStatus.kind, currentStatus.detail);
  }
}

function writeLog(message) {
  log?.write(`${new Date().toISOString()} ${message}\n`);
}
function trustedSender(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    [...preferenceOrigins].some((allowed) => event.senderFrame.url.startsWith(`${allowed}/`));
}
function statusPage(kind, detail = '') {
  currentStatus = { kind, detail };
  const { title, message } = statusMessage(currentLanguage(), kind, detail);
  if (!window || window.isDestroyed()) return;
  const escape = (value) => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const theme = currentWindowTheme();
  const titlebar = process.platform === 'darwin' ? '<div class="titlebar">sparkDash</div>' : '';
  const html = `<!doctype html><html lang="${currentLanguage()}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>sparkDash</title><style>body{background:${theme.background};color:${theme.text};color-scheme:${theme.appearance};font:16px system-ui;margin:80px;line-height:1.7}h1{font-size:28px}p{max-width:680px;color:${theme.muted}}.titlebar{position:fixed;inset:0 0 auto;height:38px;display:flex;align-items:center;justify-content:center;font-size:12px;color:${theme.muted};-webkit-app-region:drag;user-select:none}</style>${titlebar}<h1>${escape(title)}</h1><p>${escape(message)}</p>`;
  return window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
      void shell.openExternal(parsed.href);
    }
  } catch { /* Ignore invalid navigation. */ }
}

async function stopWorker(reason) {
  const child = worker;
  if (!child) return;
  intentionalStops.add(child);
  worker = null;
  origin = null;
  await new Promise((resolve) => {
    let timer;
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    timer = setTimeout(() => { child.kill(); }, 6000);
    child.postMessage({ type: 'stop', reason });
  });
}

async function startWorker() {
  if (quitting || suspended || worker) return;
  if (!secretsKey && needsSecretsKey(app.getPath('userData'))) {
    await statusPage('credentials');
    writeLog('Opening the application credential store');
    secretsKey = loadSecretsKey(app.getPath('userData'), safeStorage);
  }
  await statusPage('starting');
  token = crypto.randomBytes(32).toString('hex');
  const child = utilityProcess.fork(path.join(here, 'backend-worker.mjs'), [], {
    env: backendEnvironment({ dataDir: app.getPath('userData'), token, secretsKey,
      askpassPath: path.join(here.replace('app.asar', 'app.asar.unpacked'), 'ssh-askpass.sh') }),
    cwd: app.getPath('userData'),
    stdio: 'pipe',
    serviceName: 'sparkDash monitoring',
  });
  worker = child;
  child.on('message', (message) => {
    if (message.type !== 'secrets-key-request' || worker !== child) return;
    try {
      // Requested only by a credential-saving API call. Keep its form open;
      // a denied prompt returns an error without stopping ordinary monitoring.
      secretsKey ||= loadSecretsKey(app.getPath('userData'), safeStorage);
      child.postMessage({ type: 'secrets-key-result', requestId: message.requestId, key: secretsKey });
    } catch {
      child.postMessage({ type: 'secrets-key-result', requestId: message.requestId, error: '未能授权 sparkDash 安全存储，凭据未保存。普通 SSH 密钥监控可继续；需要保存密码或 API Key 时请重试并允许系统授权。' });
    }
  });
  child.stdout.on('data', (chunk) => writeLog(chunk.toString().trimEnd()));
  child.stderr.on('data', (chunk) => writeLog(chunk.toString().trimEnd()));
  child.on('exit', (code) => {
    writeLog(`Backend exited (${code})`);
    if (worker === child) { worker = null; origin = null; }
    if (!intentionalStops.has(child) && !quitting && !suspended) {
      void statusPage('stopped');
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 20000);
    const onExit = (code) => { clearTimeout(timer); reject(new Error(`Backend exited during startup (${code})`)); };
    child.once('exit', onExit);
    child.on('message', (message) => {
      if (message.type === 'ready' || message.type === 'failed') {
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        if (message.type === 'failed') reject(new Error(message.message));
        else resolve(message);
      }
    });
  });
  if (quitting || suspended) return;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.origin)) throw new Error('Unexpected backend address');
  origin = ready.origin;
  // The retiring page may save preferences during WebSocket close or unload,
  // after its backend stopped. Its IPC trust lasts until navigation completes;
  // backend request authentication still requires the current origin above.
  preferenceOrigins.add(origin);
  currentStatus = null;
  await window.loadURL(origin);
  preferenceOrigins.clear();
  preferenceOrigins.add(origin);
}

function enqueue(action) {
  transition = transition.then(action).catch(async (error) => {
    writeLog(error.stack || error.message);
    await stopWorker('Startup failed');
    await statusPage('failed', error.message);
  });
  return transition;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void enqueue(async () => { await stopWorker('App closed'); log?.end(); app.quit(); });
  });
  // Electron waits for the main ESM module to settle before emitting ready.
  // A top-level await on whenReady would prevent the first window from opening.
  void app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(dataDir, 'desktop.log');
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5_000_000) fs.renameSync(logPath, `${logPath}.previous`);
  log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  prefs = createPreferences(dataDir);
  syncWindowTheme();
  appSession = session.fromPartition('sparkdash-desktop');
  appSession.setPermissionRequestHandler((contents, permission, callback) => callback(
    permission === 'clipboard-sanitized-write' && contents.id === window?.webContents.id &&
    Boolean(origin && contents.getURL().startsWith(`${origin}/`))
  ));
  appSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    permission === 'clipboard-sanitized-write' && contents?.id === window?.webContents.id && requestingOrigin === origin
  );
  appSession.webRequest.onBeforeRequest((details, callback) => {
    const target = new URL(details.url);
    const httpOrigin = target.origin.replace(/^ws:/, 'http:');
    callback({ cancel: ['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) && httpOrigin !== origin });
  });
  appSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const target = new URL(details.url);
    const httpOrigin = target.origin.replace(/^ws:/, 'http:');
    const headers = { ...details.requestHeaders };
    // Only this BrowserWindow receives credentials. Never send them to a link target.
    if (origin && httpOrigin === origin && details.webContentsId === window?.webContents.id) {
      headers.Authorization = `Bearer ${token}`;
    }
    callback({ requestHeaders: headers });
  });
  ipcMain.on('preferences:read', (event) => {
    event.returnValue = trustedSender(event) ? prefs.snapshot() : {};
  });
  ipcMain.handle('ssh-config:list', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted SSH config request');
    return listSshAliases();
  });
  ipcMain.on('preferences:write', (event, key, value) => {
    try {
      if (!trustedSender(event)) throw new Error('Untrusted preference request');
      if (key === LANGUAGE_KEY && !['en', 'zh-CN'].includes(value)) throw new Error('Invalid language');
      prefs.set(key, value);
      if (key === LANGUAGE_KEY) syncLanguage();
      if (key === 'sparkdash-theme') syncWindowTheme();
      event.returnValue = { ok: true };
    } catch (error) { event.returnValue = { error: error.message }; }
  });
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 640,
    title: 'sparkDash', backgroundColor: currentWindowTheme().background,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      session: appSession,
      preload: path.join(here, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (!origin || !url.startsWith(`${origin}/`)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    void enqueue(async () => { await stopWorker('Window crashed'); await startWorker(); });
  });
  syncLanguage();
  powerMonitor.on('suspend', () => {
    suspended = true;
    void enqueue(async () => { await stopWorker('Mac sleeping'); await statusPage('suspended'); });
  });
  powerMonitor.on('resume', () => { suspended = false; void enqueue(startWorker); });
  try {
    await enqueue(startWorker);
  } catch (error) {
    writeLog(error.stack || error.message);
    dialog.showErrorBox(statusMessage(currentLanguage(), 'failed').title, error.message);
    app.quit();
  }
  }).catch((error) => {
    writeLog(error.stack || error.message);
    dialog.showErrorBox(statusMessage(currentLanguage(), 'failed').title, error.message);
    app.quit();
  });
}
