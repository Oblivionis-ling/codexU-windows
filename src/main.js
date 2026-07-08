const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadSnapshot } = require('./services/codexData');

let mainWindow;
let tray;
let cachedSnapshot = null;
let isQuitting = false;
let preferences = {
  theme: 'dark',
  alwaysOnTop: true
};

function hasUsableRateLimit(limit) {
  return Boolean(
    limit &&
    Number.isFinite(Number(limit.remainingPercent)) &&
    Number.isFinite(Number(limit.usedPercent))
  );
}

function mergeWithCachedLimits(nextSnapshot, previousSnapshot) {
  if (!previousSnapshot) return nextSnapshot;

  const merged = { ...nextSnapshot };
  const preserved = [];

  for (const key of ['primary', 'secondary']) {
    if (!hasUsableRateLimit(merged[key]) && hasUsableRateLimit(previousSnapshot[key])) {
      merged[key] = previousSnapshot[key];
      preserved.push(key === 'primary' ? '5h' : '7d');
    }
  }

  if (!merged.account && previousSnapshot.account) {
    merged.account = previousSnapshot.account;
  }

  if (!Number(merged.cloudLifetimeTokens) && Number(previousSnapshot.cloudLifetimeTokens)) {
    merged.cloudLifetimeTokens = previousSnapshot.cloudLifetimeTokens;
  }

  if (preserved.length) {
    merged.diagnostics = [
      ...(Array.isArray(merged.diagnostics) ? merged.diagnostics : []),
      {
        id: 'cached-rate-limits',
        message: `app-server 本次未返回 ${preserved.join('/')} 额度，已沿用上一次有效数据（${previousSnapshot.refreshedAt}）。`
      }
    ];
  }

  return merged;
}

if (process.argv.includes('--smoke')) {
  loadSnapshot()
    .then((snapshot) => {
      const report = JSON.stringify({
        refreshedAt: snapshot.refreshedAt,
        hasPrimaryLimit: Boolean(snapshot.primary),
        hasSecondaryLimit: Boolean(snapshot.secondary),
        localThreads: snapshot.local && snapshot.local.threadsCount,
        todayTokens: snapshot.local && snapshot.local.todayTokens,
        sevenDayTokens: snapshot.local && snapshot.local.sevenDayTokens,
        lifetimeTokens: snapshot.local && snapshot.local.lifetimeTokens,
        detailEvents: snapshot.local && snapshot.local.detailedUsage && snapshot.local.detailedUsage.tokenEvents,
        diagnostics: snapshot.diagnostics.map((item) => item.message)
      }, null, 2);
      if (process.env.CODEXU_SMOKE_OUT) {
        fs.writeFileSync(process.env.CODEXU_SMOKE_OUT, report);
      } else {
        console.log(report);
      }
      app.exit(0);
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}

function preferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function loadPreferences() {
  try {
    const raw = fs.readFileSync(preferencesPath(), 'utf8');
    preferences = { ...preferences, ...JSON.parse(raw) };
    delete preferences.language;
  } catch {
    // Defaults are acceptable on first run.
  }
}

function savePreferences() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(preferencesPath(), JSON.stringify(preferences, null, 2));
  } catch (error) {
    console.warn('Failed to save preferences:', error.message);
  }
}

function createTrayImage() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'codexu-icon.ico'));
  if (!icon.isEmpty()) return icon.resize({ width: 16, height: 16 });
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'codexu-icon.png')).resize({ width: 16, height: 16 });
}

function createWindow() {
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const maxWidth = Math.max(320, workArea.width - 32);
  const maxHeight = Math.max(320, workArea.height - 32);
  let defaultHeight = Math.min(1040, maxHeight);
  let defaultWidth = Math.round(defaultHeight * 1.16);
  if (defaultWidth > maxWidth) {
    defaultWidth = maxWidth;
    defaultHeight = Math.round(defaultWidth / 1.16);
  }
  const maxX = workArea.x + workArea.width - defaultWidth - 16;
  const maxY = workArea.y + workArea.height - defaultHeight - 16;
  const defaultX = clamp(workArea.x + 24, workArea.x + 16, maxX);
  const defaultY = clamp(workArea.y + 24, workArea.y + 16, maxY);
  mainWindow = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    x: defaultX,
    y: defaultY,
    minWidth: Math.min(1120, defaultWidth),
    minHeight: Math.min(820, defaultHeight),
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: preferences.alwaysOnTop,
    backgroundColor: '#00000000',
    title: 'CodexU Windows',
    icon: path.join(__dirname, 'assets', 'codexu-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
    refreshSnapshot(true).catch((error) => {
      console.warn('Failed to refresh after showing window:', error.message);
    });
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 / 隐藏 (Ctrl+Alt+U)', click: toggleWindow },
    { label: '刷新数据', click: async () => refreshSnapshot(true) },
    {
      label: preferences.alwaysOnTop ? '取消置顶' : '窗口置顶',
      click: () => {
        preferences.alwaysOnTop = !preferences.alwaysOnTop;
        savePreferences();
        if (mainWindow) mainWindow.setAlwaysOnTop(preferences.alwaysOnTop);
        updateTrayMenu();
        broadcastPreferences();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setToolTip('CodexU Windows');
  tray.on('click', toggleWindow);
  updateTrayMenu();
}

function broadcastPreferences() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preferences-updated', preferences);
  }
}

async function refreshSnapshot(force = false) {
  if (!force && cachedSnapshot && Date.now() - new Date(cachedSnapshot.refreshedAt).getTime() < 8000) {
    return cachedSnapshot;
  }
  const previousSnapshot = cachedSnapshot;
  let nextSnapshot;
  try {
    nextSnapshot = await loadSnapshot();
  } catch (error) {
    if (!previousSnapshot) throw error;
    cachedSnapshot = {
      ...previousSnapshot,
      diagnostics: [
        ...(Array.isArray(previousSnapshot.diagnostics) ? previousSnapshot.diagnostics : []),
        {
          id: 'cached-snapshot-after-error',
          message: `本次刷新失败，已保留上一次有效快照：${error.message}`
        }
      ]
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('snapshot-updated', cachedSnapshot);
    }
    return cachedSnapshot;
  }
  cachedSnapshot = mergeWithCachedLimits(nextSnapshot, previousSnapshot);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot-updated', cachedSnapshot);
  }
  return cachedSnapshot;
}

function registerIpc() {
  ipcMain.handle('snapshot:get', () => refreshSnapshot(false));
  ipcMain.handle('snapshot:refresh', () => refreshSnapshot(true));
  ipcMain.handle('preferences:get', () => preferences);
  ipcMain.handle('preferences:set', (_event, next) => {
    preferences = {
      ...preferences,
      ...next,
      theme: ['dark', 'light', 'system'].includes(next.theme) ? next.theme : preferences.theme
    };
    savePreferences();
    if (mainWindow) mainWindow.setAlwaysOnTop(Boolean(preferences.alwaysOnTop));
    updateTrayMenu();
    broadcastPreferences();
    return preferences;
  });
  ipcMain.handle('window:action', (_event, action) => {
    if (!mainWindow) return false;
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'hide') mainWindow.hide();
    if (action === 'toggleAlwaysOnTop') {
      preferences.alwaysOnTop = !preferences.alwaysOnTop;
      mainWindow.setAlwaysOnTop(preferences.alwaysOnTop);
      savePreferences();
      updateTrayMenu();
      broadcastPreferences();
    }
    if (action === 'openDevTools') mainWindow.webContents.openDevTools({ mode: 'detach' });
    return true;
  });
  ipcMain.handle('shell:openPath', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath.length > 0) {
      shell.openPath(filePath);
    }
    return true;
  });
}

if (!process.argv.includes('--smoke')) {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.codexu.windows');
    loadPreferences();
    registerIpc();
    createWindow();
    createTray();
    globalShortcut.register('Control+Alt+U', toggleWindow);
  });
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
