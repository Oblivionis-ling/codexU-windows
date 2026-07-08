const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexU', {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  refreshSnapshot: () => ipcRenderer.invoke('snapshot:refresh'),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  setPreferences: (preferences) => ipcRenderer.invoke('preferences:set', preferences),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  onSnapshotUpdated: (callback) => {
    ipcRenderer.on('snapshot-updated', (_event, snapshot) => callback(snapshot));
  },
  onPreferencesUpdated: (callback) => {
    ipcRenderer.on('preferences-updated', (_event, preferences) => callback(preferences));
  }
});
