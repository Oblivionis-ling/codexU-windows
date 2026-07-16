const { contextBridge, ipcRenderer } = require('electron');

const allowedWindowActions = new Set(['minimize', 'hide', 'toggleAlwaysOnTop']);

contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  refreshSnapshot: () => ipcRenderer.invoke('snapshot:refresh'),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  setPreferences: (preferences) => ipcRenderer.invoke('preferences:set', preferences),
  windowAction: (action) => {
    if (!allowedWindowActions.has(action)) return Promise.reject(new Error('Unsupported window action.'));
    return ipcRenderer.invoke('window:action', action);
  },
  openPath: (filePath) => {
    if (typeof filePath !== 'string' || !filePath.trim()) return Promise.reject(new Error('A path is required.'));
    return ipcRenderer.invoke('shell:openPath', filePath);
  },
  onSnapshotUpdated: (callback) => {
    ipcRenderer.on('snapshot-updated', (_event, snapshot) => callback(snapshot));
  },
  onPreferencesUpdated: (callback) => {
    ipcRenderer.on('preferences-updated', (_event, preferences) => callback(preferences));
  }
});
