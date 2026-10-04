import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { LANGUAGE_KEY, normalizeLanguage, applicationMenuTemplate, statusMessage } from '../language.mjs';
import { createPreferences } from '../preferences.mjs';

test('native language selection is exclusive, persistent, and does not reconnect the backend', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-language-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prefs = createPreferences(dir);
  let reconnects = 0;
  const menu = () => applicationMenuTemplate({
    language: normalizeLanguage(prefs.snapshot()[LANGUAGE_KEY]), platform: 'darwin',
    setLanguage: (value) => prefs.set(LANGUAGE_KEY, value), reconnect: () => reconnects++,
    openData() {}, openLog() {},
  });
  const choices = () => menu().find((item) => item.label === '语言 / Language').submenu;
  assert.equal(choices().find((item) => item.checked).id, 'language-en');
  choices().find((item) => item.id === 'language-zh-CN').click();
  assert.equal(choices().filter((item) => item.checked).length, 1);
  assert.equal(choices().find((item) => item.checked).label, '简体中文');
  assert.equal(menu()[2].label, '监控');
  assert.equal(createPreferences(dir).snapshot()[LANGUAGE_KEY], 'zh-CN');
  choices().find((item) => item.id === 'language-en').click();
  assert.equal(menu()[2].label, 'Monitoring');
  assert.equal(reconnects, 0);
  assert.equal(normalizeLanguage('invalid'), 'en');
});

test('preload updates its cached preference before notifying renderer listeners and supports cleanup', () => {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.sendSync = (channel) => channel === 'preferences:read' ? { [LANGUAGE_KEY]: 'en' } : { ok: true };
  let bridge;
  const electron = { ipcRenderer, contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } } };
  vm.runInNewContext(fs.readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8'), {
    require: () => electron, process: { platform: 'darwin' },
  });
  const received = [];
  const unsubscribe = bridge.onPreferenceChange((...args) => {
    received.push(args);
    assert.equal(bridge.getPreference(LANGUAGE_KEY), args[1]);
  });
  ipcRenderer.emit('preferences:changed', { privateIpcEvent: true }, LANGUAGE_KEY, 'zh-CN');
  assert.deepEqual(received, [[LANGUAGE_KEY, 'zh-CN']]);
  unsubscribe();
  ipcRenderer.emit('preferences:changed', {}, LANGUAGE_KEY, 'en');
  assert.equal(received.length, 1);
  assert.equal(bridge.getPreference(LANGUAGE_KEY), 'en');
});

test('native status pages translate while preserving original failure details', () => {
  assert.equal(statusMessage('en', 'suspended').title, 'Sampling paused');
  assert.equal(statusMessage('zh-CN', 'suspended').title, '采样已暂停');
  assert.match(statusMessage('zh-CN', 'failed', 'ECONNREFUSED 127.0.0.1').message, /^ECONNREFUSED 127.0.0.1 /);
});
