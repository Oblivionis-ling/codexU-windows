const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, net, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { fetchFullResetCredits } = require('./services/fullResetCredits');
const { updateFullResetHistory } = require('./services/resetHistory');

const RATE_LIMIT_CACHE_GRACE_MS = 5 * 60 * 1000;
const FULL_RESET_DETAILS_REFRESH_MS = 60 * 1000;
const FULL_RESET_DETAILS_CACHE_GRACE_MS = 5 * 60 * 1000;

app.setName('Codex-Usage');

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
let fullResetDetailsCache = null;
let fullResetDetailsFetchedAt = 0;
let fullResetDetailsPromise = null;
let preferences = {
  theme: 'dark',
  alwaysOnTop: true,
  subscriptionPriceUSD: null,
  widgetVersion: 4
};

function normalizeSubscriptionPrice(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 10_000) return null;
  return Math.round(numeric * 100) / 100;
}

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
  const mayUseCachedSnapshot =
    Number.isFinite(previousAgeMs) && previousAgeMs >= 0 && previousAgeMs <= RATE_LIMIT_CACHE_GRACE_MS;

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

  if (!merged.fullResetCredits && previousSnapshot.fullResetCredits && mayUseCachedSnapshot) {
    merged.fullResetCredits = previousSnapshot.fullResetCredits;
    preserved.push('Full reset 次数');
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

function preferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function resetHistoryPath() {
  return path.join(app.getPath('userData'), 'full-reset-history.json');
}

function loadPreferences() {
  try {
    const raw = fs.readFileSync(preferencesPath(), 'utf8');
    const stored = JSON.parse(raw);
    const storedWidgetVersion = Number(stored.widgetVersion || 0);
    const needsCompactWidgetMigration = storedWidgetVersion < 3;
    const needsCurrentWidgetMigration = storedWidgetVersion < 4;
    preferences = { ...preferences, ...stored };
    delete preferences.language;
    preferences.subscriptionPriceUSD = normalizeSubscriptionPrice(preferences.subscriptionPriceUSD);
    if (needsCompactWidgetMigration) {
      preferences.alwaysOnTop = true;
    }
    if (needsCurrentWidgetMigration) {
      preferences.widgetVersion = 4;
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
  const result = updateFullResetHistory(resetHistoryState, snapshot.fullResetCredits);
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
  return { ...snapshot, fullResetHistory: result.summary };
}

function applyAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const enabled = Boolean(preferences.alwaysOnTop);
  mainWindow.setAlwaysOnTop(enabled, enabled ? 'screen-saver' : 'normal');
  if (typeof mainWindow.setVisibleOnAllWorkspaces === 'function') {
    mainWindow.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: enabled });
  }
}

function createTrayImage() {
  return nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'codex-usage.ico'))
    .resize({ width: 16, height: 16 });
}

function createWindow() {
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  const defaultWidth = Math.min(372, workArea.width - 24);
  const defaultHeight = Math.min(192, workArea.height - 24);
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
    title: 'Codex-Usage',
    icon: path.join(__dirname, 'assets', 'codex-usage.ico'),
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
  applyAlwaysOnTop();

  mainWindow.once('ready-to-show', () => {
    applyAlwaysOnTop();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('show', applyAlwaysOnTop);
  mainWindow.on('blur', () => {
    if (preferences.alwaysOnTop) process.nextTick(applyAlwaysOnTop);
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
    applyAlwaysOnTop();
    mainWindow.show();
    mainWindow.focus();
    refreshSnapshot(true).catch((error) => {
      console.warn('Failed to refresh after showing window:', error.message);
    });
  }
}

function setSubscriptionPrice(price) {
  preferences.subscriptionPriceUSD = normalizeSubscriptionPrice(price);
  savePreferences();
  updateTrayMenu();
  broadcastPreferences();
}

function subscriptionPriceMenu() {
  const current = normalizeSubscriptionPrice(preferences.subscriptionPriceUSD);
  const choices = [20, 30, 100, 200];
  return {
    label: current ? `套餐价格：$${current}/月` : '套餐价格：未设置',
    submenu: [
      {
        label: '未设置（不猜测价格）',
        type: 'radio',
        checked: current === null,
        click: () => setSubscriptionPrice(null)
      },
      ...choices.map((price) => ({
        label: `$${price} / 月`,
        type: 'radio',
        checked: current === price,
        click: () => setSubscriptionPrice(price)
      }))
    ]
  };
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 / 隐藏 (Ctrl+U)', click: toggleWindow },
      { label: '刷新数据', click: async () => refreshSnapshot(true) },
      subscriptionPriceMenu(),
      {
        label: preferences.alwaysOnTop ? '取消置顶' : '窗口置顶',
        click: () => {
          preferences.alwaysOnTop = !preferences.alwaysOnTop;
          savePreferences();
          applyAlwaysOnTop();
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
  tray.setToolTip('Codex-Usage');
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

function refreshFullResetDetails() {
  const cacheAge = Date.now() - fullResetDetailsFetchedAt;
  if (fullResetDetailsCache && cacheAge >= 0 && cacheAge < FULL_RESET_DETAILS_REFRESH_MS) {
    return Promise.resolve({ details: fullResetDetailsCache, error: null });
  }
  if (fullResetDetailsPromise) return fullResetDetailsPromise;

  const operation = fetchFullResetCredits({
    fetchImpl: (url, options) => net.fetch(url, options)
  })
    .then((details) => {
      fullResetDetailsCache = details;
      fullResetDetailsFetchedAt = Date.now();
      return { details, error: null };
    })
    .catch((error) => {
      const failedCacheAge = Date.now() - fullResetDetailsFetchedAt;
      const mayUseCache =
        fullResetDetailsCache && failedCacheAge >= 0 && failedCacheAge <= FULL_RESET_DETAILS_CACHE_GRACE_MS;
      return {
        details: mayUseCache ? fullResetDetailsCache : null,
        error
      };
    })
    .finally(() => {
      if (fullResetDetailsPromise === operation) fullResetDetailsPromise = null;
    });
  fullResetDetailsPromise = operation;
  return operation;
}

function attachFullResetDetails(snapshot, result) {
  let next = snapshot;
  if (result.details) {
    next = {
      ...next,
      fullResetCredits: result.details
    };
  }
  if (result.error) {
    next = withDiagnostic(next, {
      id: 'full-reset-details-unavailable',
      message: `Full reset 到期详情暂时不可用，已保留次数或最近缓存：${result.error.message}`
    });
  }
  return next;
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
  const fullResetDetailsOperation = refreshFullResetDetails();
  let nextSnapshot;
  try {
    nextSnapshot = await loadSnapshotInWorker();
  } catch (error) {
    if (!previousSnapshot) throw error;
    const fullResetDetails = await fullResetDetailsOperation;
    return publishSnapshot(
      attachResetHistory(
        attachFullResetDetails(
          withDiagnostic(previousSnapshot, {
            id: 'cached-snapshot-after-error',
            message: `本次刷新失败，已保留上一次有效快照：${error.message}`
          }),
          fullResetDetails
        )
      ),
      sequence
    );
  }

  const fullResetDetails = await fullResetDetailsOperation;
  return publishSnapshot(
    attachResetHistory(attachFullResetDetails(mergeWithCachedLimits(nextSnapshot, previousSnapshot), fullResetDetails)),
    sequence
  );
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
    if (Object.hasOwn(next, 'subscriptionPriceUSD')) {
      validated.subscriptionPriceUSD = normalizeSubscriptionPrice(next.subscriptionPriceUSD);
    }
    preferences = {
      ...preferences,
      ...validated
    };
    savePreferences();
    applyAlwaysOnTop();
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
      applyAlwaysOnTop();
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

app.whenReady().then(async () => {
  app.setAppUserModelId('io.github.oblivionisling.codexusage');
  loadPreferences();
  loadResetHistory();
  registerIpc();
  createWindow();
  createTray();
  if (!globalShortcut.register('Control+U', toggleWindow)) {
    console.warn('Failed to register the Ctrl+U global shortcut.');
  }
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  isQuitting = true;
  rejectWorkerRequests(new Error('Application is quitting.'));
  if (snapshotWorker) snapshotWorker.terminate();
});
