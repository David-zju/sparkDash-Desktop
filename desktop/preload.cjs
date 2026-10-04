const { contextBridge, ipcRenderer } = require('electron');
const preferences = ipcRenderer.sendSync('preferences:read') || {};
const preferenceListeners = new Set();
ipcRenderer.on('preferences:changed', (_event, key, value) => {
  if (typeof key !== 'string' || typeof value !== 'string') return;
  preferences[key] = value;
  for (const listener of preferenceListeners) listener(key, value);
});
contextBridge.exposeInMainWorld('sparkDesktop', {
  isDesktop: true,
  platform: process.platform,
  listSshAliases: () => ipcRenderer.invoke('ssh-config:list'),
  getPreference: (key) => preferences[key] ?? null,
  onPreferenceChange: (listener) => {
    preferenceListeners.add(listener);
    return () => preferenceListeners.delete(listener);
  },
  setPreference: (key, value) => {
    const result = ipcRenderer.sendSync('preferences:write', key, value);
    if (result?.error) throw new Error(result.error);
    preferences[key] = value;
  },
});
