const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { loadSnapshot } = require('./services/codexData');
const { updateResetHistory } = require('./services/resetHistory');

const RATE_LIMIT_CACHE_GRACE_MS = 5 * 60 * 1000;

let mainWindow;
let tray;
let cachedSnapshot = null;
let isQuitting = false;
let snapshotWorker = null;
let nextWorkerRequestId = 1;
const workerRequests = new Map();
let refreshPromise = null;
let refreshSequence = 0;
let appliedRefreshSequence = 0;
let resetHistoryState = null;
let preferences = {
  theme: 'dark',
  alwaysOnTop: true,
  widgetVersion: 3
};

function hasUsableRateLimit(limit) {
  return Boolean(
    limit && Number.isFinite(Number(limit.remainingPercent)) && Number.isFinite(Number(limit.usedPercent))
  );
}

function rateLimitWindowLabel(limit, fallback) {
  const minutes = Number(limit && limit.windowDurationMins);
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes > 0) return `${minutes}min`;
  return fallback;
}

function mergeWithCachedLimits(nextSnapshot, previousSnapshot) {
  if (!previousSnapshot) return nextSnapshot;

  const merged = { ...nextSnapshot };
  const preserved = [];
  const keys = ['primary', 'secondary'];
  const hasCurrentLimits = keys.some((key) => hasUsableRateLimit(merged[key]));
  const previousAgeMs = Date.now() - new Date(previousSnapshot.refreshedAt).getTime();
  const mayUseCachedLimits =
    !hasCurrentLimits &&
    Number.isFinite(previousAgeMs) &&
    previousAgeMs >= 0 &&
    previousAgeMs <= RATE_LIMIT_CACHE_GRACE_MS;

  if (mayUseCachedLimits) {
    for (const [index, key] of keys.entries()) {
      if (hasUsableRateLimit(previousSnapshot[key])) {
        merged[key] = previousSnapshot[key];
        preserved.push(rateLimitWindowLabel(previousSnapshot[key], `窗口 ${index + 1}`));
      }
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
      const report = JSON.stringify(
        {
          refreshedAt: snapshot.refreshedAt,
          hasPrimaryLimit: Boolean(snapshot.primary),
          hasSecondaryLimit: Boolean(snapshot.secondary),
          primary: snapshot.primary,
          secondary: snapshot.secondary,
          localThreads: snapshot.local && snapshot.local.threadsCount,
          todayTokens: snapshot.local && snapshot.local.todayTokens,
          sevenDayTokens: snapshot.local && snapshot.local.sevenDayTokens,
          lifetimeTokens: snapshot.local && snapshot.local.lifetimeTokens,
          detailEvents: snapshot.local && snapshot.local.detailedUsage && snapshot.local.detailedUsage.tokenEvents,
          diagnostics: snapshot.diagnostics.map((item) => item.message)
        },
        null,
        2
      );
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

function resetHistoryPath() {
  return path.join(app.getPath('userData'), 'reset-history.json');
}

function loadPreferences() {
  try {
    const raw = fs.readFileSync(preferencesPath(), 'utf8');
    const stored = JSON.parse(raw);
    const needsCompactWidgetMigration = Number(stored.widgetVersion || 0) < 3;
    preferences = { ...preferences, ...stored };
    delete preferences.language;
    if (needsCompactWidgetMigration) {
      preferences.alwaysOnTop = true;
      preferences.widgetVersion = 3;
      savePreferences();
    }
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

function loadResetHistory() {
  try {
    resetHistoryState = JSON.parse(fs.readFileSync(resetHistoryPath(), 'utf8'));
  } catch {
    resetHistoryState = null;
  }
}

function attachResetHistory(snapshot) {
  const result = updateResetHistory(resetHistoryState, [snapshot.primary, snapshot.secondary]);
  const changed = JSON.stringify(result.state) !== JSON.stringify(resetHistoryState);
  resetHistoryState = result.state;
  if (changed) {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(resetHistoryPath(), JSON.stringify(resetHistoryState, null, 2));
    } catch (error) {
      console.warn('Failed to save reset history:', error.message);
    }
  }
  return { ...snapshot, resetHistory: result.summary };
}

function createTrayImage() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'codexu-icon.ico'));
  if (!icon.isEmpty()) return icon.resize({ width: 16, height: 16 });
  return nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'codexu-icon.png'))
    .resize({ width: 16, height: 16 });
}

function createWindow() {
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  const defaultWidth = Math.min(420, workArea.width - 24);
  const defaultHeight = Math.min(220, workArea.height - 24);
  const defaultX = workArea.x + workArea.width - defaultWidth - 20;
  const defaultY = workArea.y + 20;
  mainWindow = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    x: defaultX,
    y: defaultY,
    minWidth: defaultWidth,
    minHeight: defaultHeight,
    maxWidth: defaultWidth,
    maxHeight: defaultHeight,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
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
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  const rendererEntry = path.join(__dirname, 'renderer', 'index.html');
  const rendererUrl = pathToFileURL(rendererEntry).toString();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, nextUrl) => {
    if (nextUrl !== rendererUrl) event.preventDefault();
  });
  mainWindow.loadFile(rendererEntry);

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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 / 隐藏 (Ctrl+U)', click: toggleWindow },
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
    ])
  );
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

function rejectWorkerRequests(error) {
  for (const request of workerRequests.values()) request.reject(error);
  workerRequests.clear();
}

function ensureSnapshotWorker() {
  if (snapshotWorker) return snapshotWorker;
  const worker = new Worker(path.join(__dirname, 'services', 'snapshotWorker.js'));
  snapshotWorker = worker;

  worker.on('message', (message) => {
    const request = workerRequests.get(message && message.id);
    if (!request) return;
    workerRequests.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      error.name = message.error.name || 'Error';
      if (message.error.stack) error.stack = message.error.stack;
      request.reject(error);
      return;
    }
    request.resolve(message.snapshot);
  });

  worker.on('error', (error) => {
    rejectWorkerRequests(error);
  });

  worker.on('exit', (code) => {
    if (snapshotWorker === worker) snapshotWorker = null;
    if (code !== 0 && !isQuitting) {
      rejectWorkerRequests(new Error(`Snapshot worker exited with code ${code}.`));
    }
  });

  return worker;
}

function loadSnapshotInWorker() {
  const worker = ensureSnapshotWorker();
  const id = nextWorkerRequestId;
  nextWorkerRequestId += 1;
  return new Promise((resolve, reject) => {
    workerRequests.set(id, { resolve, reject });
    worker.postMessage({ id });
  });
}

function withDiagnostic(snapshot, diagnostic) {
  const diagnostics = (Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : []).filter(
    (item) => item && item.id !== diagnostic.id
  );
  diagnostics.push(diagnostic);
  return {
    ...snapshot,
    diagnostics: diagnostics.slice(-50)
  };
}

function publishSnapshot(snapshot, sequence) {
  if (sequence < appliedRefreshSequence) return cachedSnapshot;
  appliedRefreshSequence = sequence;
  cachedSnapshot = snapshot;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot-updated', cachedSnapshot);
  }
  return cachedSnapshot;
}

async function performSnapshotRefresh(sequence) {
  const previousSnapshot = cachedSnapshot;
  let nextSnapshot;
  try {
    nextSnapshot = await loadSnapshotInWorker();
  } catch (error) {
    if (!previousSnapshot) throw error;
    return publishSnapshot(
      withDiagnostic(previousSnapshot, {
        id: 'cached-snapshot-after-error',
        message: `本次刷新失败，已保留上一次有效快照：${error.message}`
      }),
      sequence
    );
  }

  return publishSnapshot(attachResetHistory(mergeWithCachedLimits(nextSnapshot, previousSnapshot)), sequence);
}

async function refreshSnapshot(force = false) {
  if (!force && cachedSnapshot && Date.now() - new Date(cachedSnapshot.refreshedAt).getTime() < 8000) {
    return cachedSnapshot;
  }
  if (refreshPromise) return refreshPromise;

  const sequence = refreshSequence + 1;
  refreshSequence = sequence;
  const operation = performSnapshotRefresh(sequence);
  refreshPromise = operation;
  try {
    return await operation;
  } finally {
    if (refreshPromise === operation) refreshPromise = null;
  }
}

function assertTrustedIpcEvent(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Rejected IPC request from an unknown renderer.');
  }
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function currentAllowedOpenPaths() {
  const paths = new Set();
  const columns = cachedSnapshot && cachedSnapshot.taskBoard && cachedSnapshot.taskBoard.columns;
  for (const column of Array.isArray(columns) ? columns : []) {
    for (const item of Array.isArray(column.items) ? column.items : []) {
      if (typeof item.path === 'string' && item.path.trim()) {
        paths.add(path.resolve(item.path).toLowerCase());
      }
    }
  }
  return paths;
}

async function openSafePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('A non-empty path is required.');
  }

  const resolved = path.resolve(filePath);
  if (!currentAllowedOpenPaths().has(resolved.toLowerCase())) {
    throw new Error('The requested path is not present in the current Codex snapshot.');
  }
  const stat = await fs.promises.stat(resolved);
  if (stat.isDirectory()) {
    const errorMessage = await shell.openPath(resolved);
    if (errorMessage) throw new Error(errorMessage);
    return { opened: true, kind: 'directory' };
  }

  const automationsRoot = path.join(app.getPath('home'), '.codex', 'automations');
  if (stat.isFile() && path.extname(resolved).toLowerCase() === '.toml' && isPathInside(resolved, automationsRoot)) {
    shell.showItemInFolder(resolved);
    return { opened: true, kind: 'automation' };
  }

  throw new Error('Only workspace directories and Codex automation TOML files can be opened.');
}

function registerIpc() {
  ipcMain.handle('snapshot:get', (event) => {
    assertTrustedIpcEvent(event);
    return refreshSnapshot(false);
  });
  ipcMain.handle('snapshot:refresh', (event) => {
    assertTrustedIpcEvent(event);
    return refreshSnapshot(true);
  });
  ipcMain.handle('preferences:get', (event) => {
    assertTrustedIpcEvent(event);
    return { ...preferences };
  });
  ipcMain.handle('preferences:set', (event, next) => {
    assertTrustedIpcEvent(event);
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new TypeError('Preferences must be an object.');
    }
    const validated = {};
    if (['dark', 'light', 'system'].includes(next.theme)) validated.theme = next.theme;
    if (typeof next.alwaysOnTop === 'boolean') validated.alwaysOnTop = next.alwaysOnTop;
    preferences = {
      ...preferences,
      ...validated
    };
    savePreferences();
    if (mainWindow) mainWindow.setAlwaysOnTop(Boolean(preferences.alwaysOnTop));
    updateTrayMenu();
    broadcastPreferences();
    return preferences;
  });
  ipcMain.handle('window:action', (event, action) => {
    assertTrustedIpcEvent(event);
    if (!mainWindow) return false;
    if (!['minimize', 'hide', 'toggleAlwaysOnTop'].includes(action)) {
      throw new Error(`Unsupported window action: ${action}`);
    }
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'hide') mainWindow.hide();
    if (action === 'toggleAlwaysOnTop') {
      preferences.alwaysOnTop = !preferences.alwaysOnTop;
      mainWindow.setAlwaysOnTop(preferences.alwaysOnTop);
      savePreferences();
      updateTrayMenu();
      broadcastPreferences();
    }
    return true;
  });
  ipcMain.handle('shell:openPath', async (event, filePath) => {
    assertTrustedIpcEvent(event);
    return openSafePath(filePath);
  });
}

if (!process.argv.includes('--smoke')) {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.codexu.windows');
    loadPreferences();
    loadResetHistory();
    registerIpc();
    createWindow();
    createTray();
    if (!globalShortcut.register('Control+U', toggleWindow)) {
      console.warn('Failed to register the Ctrl+U global shortcut.');
    }
  });
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  isQuitting = true;
  rejectWorkerRequests(new Error('Application is quitting.'));
  if (snapshotWorker) snapshotWorker.terminate();
});
