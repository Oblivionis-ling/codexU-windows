const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  refreshSnapshot: () => ipcRenderer.invoke('snapshot:refresh'),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  onSnapshotUpdated: (callback) => {
    ipcRenderer.on('snapshot-updated', (_event, snapshot) => callback(snapshot));
  },
  onPreferencesUpdated: (callback) => {
    ipcRenderer.on('preferences-updated', (_event, preferences) => callback(preferences));
  }
});
