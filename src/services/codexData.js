const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { version: APP_VERSION } = require('../../package.json');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_READ_CONCURRENCY = 4;
const usageFileCache = new Map();

function codexHome() {
  return path.join(os.homedir(), '.codex');
}

function normalizeEpoch(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number > 100_000_000_000) return number;
  return number * 1000;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfLocalMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampPercent(value, fallback = 0) {
  const number = safeNumber(value, fallback);
  return Math.max(0, Math.min(100, number));
}

function asString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findStateDb() {
  const home = codexHome();
  const candidates = [path.join(home, 'state_5.sqlite'), path.join(home, 'sqlite', 'state_5.sqlite')];
  return candidates.find(pathExists) || null;
}

function openDatabase(dbPath) {
  if (!DatabaseSync) {
    throw new Error('当前 Electron/Node 不支持 node:sqlite，无法读取 Codex SQLite。');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
  } catch {
    // Some older runtimes may not allow PRAGMA in read-only mode. Reads still work.
  }
  return db;
}

function allRows(db, sql) {
  return db.prepare(sql).all();
}

function normalizeThread(row) {
  return {
    model: asString(row.model || row.model_provider, 'unknown'),
    rolloutPath: resolveCodexPath(asString(row.rollout_path))
  };
}

function resolveCodexPath(value) {
  if (!value) return '';
  if (value.startsWith('~')) return path.join(os.homedir(), value.slice(1));
  if (path.isAbsolute(value)) return value;
  return path.join(codexHome(), value);
}

function readLocalUsage(options = {}) {
  const dbPath = options.dbPath || findStateDb();
  if (!dbPath) return null;

  let db;
  try {
    db = openDatabase(dbPath);
    const rows = allRows(
      db,
      `
      SELECT
        rollout_path,
        model_provider,
        model
      FROM threads
    `
    );

    const threads = rows.map(normalizeThread);
    return { threads };
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

function zeroBreakdown() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function addBreakdown(target, source) {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
}

function deltaBreakdown(current, previous) {
  if (!previous) return current;
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens
  };
}

function isUsableDelta(delta) {
  return (
    delta.totalTokens > 0 &&
    ![
      delta.inputTokens,
      delta.cachedInputTokens,
      delta.outputTokens,
      delta.reasoningOutputTokens,
      delta.totalTokens
    ].some((value) => value < 0)
  );
}

function modelTokenPrice(model) {
  const value = asString(model).toLowerCase();
  if (!value) return null;
  if (value.includes('gpt-5.5-pro')) {
    return { model: 'gpt-5.5-pro', inputPerMillion: 30, cachedInputPerMillion: 30, outputPerMillion: 180 };
  }
  if (value.includes('gpt-5.5')) {
    return { model: 'gpt-5.5', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 };
  }
  if (value.includes('gpt-5.4-pro')) {
    return { model: 'gpt-5.4-pro', inputPerMillion: 30, cachedInputPerMillion: 30, outputPerMillion: 180 };
  }
  if (value.includes('gpt-5.4-mini')) {
    return { model: 'gpt-5.4-mini', inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 };
  }
  if (value.includes('gpt-5.4-nano')) {
    return { model: 'gpt-5.4-nano', inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.25 };
  }
  if (value.includes('gpt-5.4')) {
    return { model: 'gpt-5.4', inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 };
  }
  if (value.includes('gpt-5.2-codex') || value.includes('codex')) {
    return { model: 'gpt-5.2-codex', inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 };
  }
  if (value.includes('gpt-5')) {
    return { model: 'gpt-5', inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 };
  }
  return null;
}

function estimatedCostUSD(tokens, price) {
  const cached = Math.min(Math.max(tokens.cachedInputTokens, 0), Math.max(tokens.inputTokens, 0));
  const uncached = Math.max(tokens.inputTokens - cached, 0);
  return (
    (uncached / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * price.cachedInputPerMillion +
    (Math.max(tokens.outputTokens, 0) / 1_000_000) * price.outputPerMillion
  );
}

function usageBucket() {
  return {
    tokens: zeroBreakdown(),
    estimatedCostUSD: 0,
    pricedTokens: 0,
    unpricedTokens: 0
  };
}

function cloneBreakdown(value) {
  return {
    inputTokens: safeNumber(value && value.inputTokens),
    cachedInputTokens: safeNumber(value && value.cachedInputTokens),
    outputTokens: safeNumber(value && value.outputTokens),
    reasoningOutputTokens: safeNumber(value && value.reasoningOutputTokens),
    totalTokens: safeNumber(value && value.totalTokens)
  };
}

function mergeUsageBucket(target, source) {
  if (!source) return;
  addBreakdown(target.tokens, source.tokens);
  target.estimatedCostUSD += safeNumber(source.estimatedCostUSD);
  target.pricedTokens += safeNumber(source.pricedTokens);
  target.unpricedTokens += safeNumber(source.unpricedTokens);
}

function addPricedUsage(bucket, delta, price) {
  addBreakdown(bucket.tokens, delta);
  if (price) {
    bucket.estimatedCostUSD += estimatedCostUSD(delta, price);
    bucket.pricedTokens += delta.totalTokens;
  } else {
    bucket.unpricedTokens += delta.totalTokens;
  }
}

function findTokenPayload(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  if (value.type === 'token_count') return value;
  if (value.payload && value.payload.type === 'token_count') return value.payload;
  if (value.info && value.info.type === 'token_count') return value.info;
  for (const key of ['payload', 'message', 'event', 'data', 'body']) {
    const found = findTokenPayload(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function findUsageObject(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.total_token_usage,
    payload.totalTokenUsage,
    payload.usage,
    payload.token_usage,
    payload.tokenUsage,
    payload.info && payload.info.total_token_usage,
    payload.info && payload.info.totalTokenUsage,
    payload.info && payload.info.usage,
    payload.info && payload.info.token_usage,
    payload.info && payload.info.tokenUsage
  ].filter(Boolean);

  return (
    candidates.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        (candidate.input_tokens !== undefined ||
          candidate.inputTokens !== undefined ||
          candidate.total_tokens !== undefined ||
          candidate.totalTokens !== undefined)
    ) || null
  );
}

function extractBreakdown(usage) {
  if (!usage) return null;
  const breakdown = {
    inputTokens: safeNumber(usage.input_tokens ?? usage.inputTokens),
    cachedInputTokens: safeNumber(usage.cached_input_tokens ?? usage.cachedInputTokens),
    outputTokens: safeNumber(usage.output_tokens ?? usage.outputTokens),
    reasoningOutputTokens: safeNumber(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens),
    totalTokens: safeNumber(usage.total_tokens ?? usage.totalTokens)
  };
  if (!breakdown.totalTokens) {
    breakdown.totalTokens = breakdown.inputTokens + breakdown.outputTokens;
  }
  return breakdown.totalTokens > 0 ? breakdown : null;
}

function extractEventTimeMs(object, fallbackMs) {
  const candidates = [
    object.timestamp,
    object.time,
    object.created_at,
    object.createdAt,
    object.payload && object.payload.timestamp,
    object.payload && object.payload.created_at,
    object.payload && object.payload.createdAt
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'number') return normalizeEpoch(candidate);
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

function looksLikeModelName(value) {
  const model = asString(value).trim();
  return /^(gpt-|o[1-9](?:-|$))|codex/i.test(model) ? model : null;
}

function extractModelName(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  for (const key of ['model', 'model_name', 'modelName', 'model_slug', 'modelSlug']) {
    const model = looksLikeModelName(value[key]);
    if (model) return model;
  }
  for (const key of ['payload', 'message', 'event', 'data', 'body', 'session', 'context', 'turn_context']) {
    const model = extractModelName(value[key], depth + 1);
    if (model) return model;
  }
  return null;
}

function createUsageFileState(filePath, sourceModel) {
  return {
    filePath,
    sourceModel,
    model: looksLikeModelName(sourceModel),
    offset: 0,
    size: 0,
    mtimeMs: 0,
    previous: null,
    lifetime: usageBucket(),
    daily: new Map()
  };
}

function addUsageToFileState(state, eventMs, delta) {
  const price = modelTokenPrice(state.model);
  addPricedUsage(state.lifetime, delta, price);
  const dayStart = startOfLocalDay(new Date(eventMs));
  if (!state.daily.has(dayStart)) state.daily.set(dayStart, usageBucket());
  addPricedUsage(state.daily.get(dayStart), delta, price);
}

function processUsageLine(lineBuffer, state, fallbackMs, requireValidJson = false) {
  const text = lineBuffer.toString('utf8').replace(/\r$/, '');
  if (!text.trim()) return true;

  const mayContainUsage = text.includes('token_count');
  const mayContainModel = /"model(?:_name|Name|_slug|Slug)?"\s*:/.test(text);
  if (!requireValidJson && !mayContainUsage && !mayContainModel) return true;

  let object;
  try {
    object = JSON.parse(text);
  } catch {
    return !requireValidJson;
  }

  const detectedModel = extractModelName(object);
  if (detectedModel) state.model = detectedModel;
  if (!mayContainUsage) return true;
  const payload = findTokenPayload(object);
  const usage = findUsageObject(payload);
  const current = extractBreakdown(usage);
  if (!current) return true;

  const delta = deltaBreakdown(current, state.previous);
  state.previous = cloneBreakdown(current);
  if (!isUsableDelta(delta)) return true;

  const eventMs = extractEventTimeMs(object, fallbackMs);
  addUsageToFileState(state, eventMs, delta);
  return true;
}

async function appendUsageFile(filePath, state, stat) {
  const startOffset = state.offset;
  let consumedOffset = startOffset;
  let pending = Buffer.alloc(0);
  const stream = fs.createReadStream(filePath, { start: startOffset });

  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const lineBuffer = pending.subarray(0, newlineIndex);
      processUsageLine(lineBuffer, state, stat.mtimeMs, false);
      consumedOffset += newlineIndex + 1;
      pending = pending.subarray(newlineIndex + 1);
      newlineIndex = pending.indexOf(0x0a);
    }
  }

  if (pending.length && processUsageLine(pending, state, stat.mtimeMs, true)) {
    consumedOffset += pending.length;
  }

  state.offset = consumedOffset;
  state.size = stat.size;
  state.mtimeMs = stat.mtimeMs;
  return Math.max(0, stat.size - startOffset);
}

async function updateUsageFile(source) {
  const stat = await fsp.stat(source.filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    usageFileCache.delete(source.filePath);
    return { state: null, cacheHit: false, bytesRead: 0 };
  }

  let state = usageFileCache.get(source.filePath);
  const modelChanged = state && state.sourceModel !== source.model;
  const rewritten = state && stat.size === state.size && stat.mtimeMs !== state.mtimeMs;
  const truncated = state && stat.size < state.offset;
  if (!state || modelChanged || rewritten || truncated) {
    state = createUsageFileState(source.filePath, source.model);
    usageFileCache.set(source.filePath, state);
  }

  if (stat.size === state.size && stat.mtimeMs === state.mtimeMs && state.offset === stat.size) {
    return { state, cacheHit: true, bytesRead: 0 };
  }

  const bytesRead = await appendUsageFile(source.filePath, state, stat);
  return { state, cacheHit: false, bytesRead };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function aggregateUsageStates(states, windows) {
  const accumulator = {
    today: usageBucket(),
    sevenDay: usageBucket(),
    month: usageBucket(),
    lifetime: usageBucket()
  };

  for (const state of states) {
    mergeUsageBucket(accumulator.lifetime, state.lifetime);
    for (const [dayStart, bucket] of state.daily) {
      if (dayStart >= windows.monthStart) mergeUsageBucket(accumulator.month, bucket);
      if (dayStart >= windows.sevenStart) mergeUsageBucket(accumulator.sevenDay, bucket);
      if (dayStart >= windows.todayStart) mergeUsageBucket(accumulator.today, bucket);
    }
  }
  return accumulator;
}

function collectUsageSources(localUsage) {
  const sources = new Map();
  if (localUsage && Array.isArray(localUsage.threads)) {
    for (const thread of localUsage.threads) {
      if (thread.rolloutPath && pathExists(thread.rolloutPath)) {
        sources.set(path.resolve(thread.rolloutPath), thread.model);
      }
    }
  }

  for (const folder of [path.join(codexHome(), 'sessions'), path.join(codexHome(), 'archived_sessions')]) {
    if (!pathExists(folder)) continue;
    for (const file of walkFiles(folder)) {
      if (/\.jsonl$/i.test(file) && /rollout-|session-|\.jsonl$/i.test(path.basename(file))) {
        const resolved = path.resolve(file);
        if (!sources.has(resolved)) sources.set(resolved, null);
      }
    }
  }

  return [...sources.entries()].map(([filePath, model]) => ({ filePath, model }));
}

function walkFiles(root, limit = Number.POSITIVE_INFINITY) {
  const result = [];
  const stack = [root];
  while (stack.length && result.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs
        .readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) result.push(fullPath);
      if (result.length >= limit) break;
    }
  }
  return result;
}

async function readDetailedUsage(localUsage, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const windows = {
    todayStart: startOfLocalDay(now),
    sevenStart: startOfLocalDay(now) - 6 * DAY_MS,
    monthStart: startOfLocalMonth(now)
  };
  const sources = Array.isArray(options.sources) ? options.sources : collectUsageSources(localUsage);
  const activePaths = new Set(sources.map((source) => source.filePath));
  for (const cachedPath of usageFileCache.keys()) {
    if (!activePaths.has(cachedPath)) usageFileCache.delete(cachedPath);
  }

  const updates = await mapWithConcurrency(sources, USAGE_READ_CONCURRENCY, async (source) => {
    try {
      return await updateUsageFile(source);
    } catch {
      return { state: usageFileCache.get(source.filePath) || null, cacheHit: false, bytesRead: 0 };
    }
  });
  const states = updates.map((item) => item.state).filter(Boolean);
  const accumulator = aggregateUsageStates(states, windows);
  const cacheHits = updates.filter((item) => item.cacheHit).length;
  const bytesRead = updates.reduce((sum, item) => sum + item.bytesRead, 0);

  return {
    ...accumulator,
    cacheHits,
    filesParsed: sources.length - cacheHits,
    bytesRead
  };
}

function resetUsageFileCache() {
  usageFileCache.clear();
}

function parseRateWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const usedRaw = value.usedPercent ?? value.used_percent ?? value.used;
  const remainingRaw = value.remainingPercent ?? value.remaining_percent;
  const usedPercent =
    remainingRaw === undefined || remainingRaw === null
      ? clampPercent(usedRaw)
      : clampPercent(usedRaw, 100 - clampPercent(remainingRaw));
  const remainingPercent =
    remainingRaw === undefined || remainingRaw === null ? clampPercent(100 - usedPercent) : clampPercent(remainingRaw);
  return {
    usedPercent,
    remainingPercent,
    windowDurationMins: value.windowDurationMins ?? value.window_duration_mins ?? value.windowMinutes ?? null,
    resetsAt: normalizeEpoch(value.resetsAt ?? value.resets_at ?? value.resetAt ?? value.reset_at)
  };
}

function parseAccount(result) {
  if (!result || typeof result !== 'object') return null;
  const account = result.account || result;
  return { planType: account.planType || account.plan_type || account.plan || null };
}

function parseRateLimits(result) {
  const root = result && (result.rateLimits || result.rate_limits || result.limits || result);
  return {
    primary: parseRateWindow(root && (root.primary || root.primaryWindow)),
    secondary: parseRateWindow(root && (root.secondary || root.secondaryWindow)),
    fullResetCredits: parseFullResetCredits(result)
  };
}

function parseFullResetCredits(result) {
  if (!result || typeof result !== 'object') return null;
  const credits = result.rateLimitResetCredits || result.rate_limit_reset_credits;
  if (!credits || typeof credits !== 'object') return null;
  const rawCount = credits.availableCount ?? credits.available_count;
  const availableCount = Number(rawCount);
  if (!Number.isFinite(availableCount) || availableCount < 0) return null;
  return { availableCount: Math.floor(availableCount) };
}

function codexCommandCandidates() {
  const candidates = [];
  candidates.push(...bundledCodexCandidates());
  if (process.env.CODEX_CLI_PATH) candidates.push(process.env.CODEX_CLI_PATH);
  candidates.push('codex');
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'codex.exe'));
  candidates.push(path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'OpenAI Codex', 'codex.exe'));
  return [...new Set(candidates.filter(Boolean))];
}

function asarUnpackedPath(filePath) {
  if (!filePath || !filePath.includes('.asar')) return filePath;
  const unpacked = filePath.replace('.asar', '.asar.unpacked');
  return pathExists(unpacked) ? unpacked : filePath;
}

function bundledCodexCandidates() {
  const candidates = [];
  try {
    const codexPackageRoot = path.dirname(require.resolve('@openai/codex/package.json'));
    const platformPackageJson = require.resolve('@openai/codex-win32-x64/package.json', {
      paths: [codexPackageRoot, path.dirname(codexPackageRoot), __dirname]
    });
    candidates.push(
      path.join(path.dirname(platformPackageJson), 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    );
  } catch {
    // The bundled CLI is optional; PATH-based candidates still run below.
  }

  try {
    const codexPackageRoot = path.dirname(require.resolve('@openai/codex/package.json'));
    candidates.push(
      path.join(codexPackageRoot, '..', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    );
  } catch {
    // Ignore.
  }

  return candidates.map((candidate) => asarUnpackedPath(path.normalize(candidate))).filter(pathExists);
}

function tryAppServerCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const snapshot = {
      account: null,
      primary: null,
      secondary: null,
      fullResetCredits: null
    };
    let settled = false;
    let buffer = '';
    let completed = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      resolve({
        ok: Boolean(snapshot.account || snapshot.primary || snapshot.secondary),
        snapshot
      });
    };

    let child;
    try {
      child = spawn(command, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch {
      resolve({ ok: false, snapshot });
      return;
    }

    const timer = setTimeout(finish, timeoutMs);

    child.on('error', finish);
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const line of parts) parseAppServerLine(line);
    });

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // Ignore write errors; timeout/error handlers will finish.
      }
    };

    const initialize = {
      id: 1,
      method: 'initialize',
      params: {
        capabilities: { experimentalApi: true },
        clientInfo: { name: 'codex-usage', version: APP_VERSION }
      }
    };
    send(initialize);
    setTimeout(() => {
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      send({ id: 3, method: 'account/rateLimits/read', params: {} });
    }, 80);

    function parseAppServerLine(line) {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.error) {
        if (message.id === 2 || message.id === 3) completed += 1;
        if (completed >= 2) finish();
        return;
      }
      if (!message.result) return;
      if (message.id === 2) {
        snapshot.account = parseAccount(message.result);
        completed += 1;
      }
      if (message.id === 3) {
        const limits = parseRateLimits(message.result);
        snapshot.primary = limits.primary;
        snapshot.secondary = limits.secondary;
        snapshot.fullResetCredits = limits.fullResetCredits;
        completed += 1;
      }
      if (completed >= 2) finish();
    }
  });
}

async function readAppServer() {
  for (const command of codexCommandCandidates()) {
    const result = await tryAppServerCommand(command, 12000);
    if (result.ok && (result.snapshot.primary || result.snapshot.secondary || result.snapshot.account)) {
      return result.snapshot;
    }
  }
  return {
    account: null,
    primary: null,
    secondary: null,
    fullResetCredits: null
  };
}

async function loadSnapshot() {
  const local = readLocalUsage();
  const [detailedUsage, appServer] = await Promise.all([readDetailedUsage(local), readAppServer()]);

  return {
    refreshedAt: new Date().toISOString(),
    account: appServer.account,
    primary: appServer.primary,
    secondary: appServer.secondary,
    fullResetCredits: appServer.fullResetCredits,
    local: { detailedUsage }
  };
}

module.exports = {
  loadSnapshot,
  readLocalUsage,
  readDetailedUsage,
  resetUsageFileCache,
  modelTokenPrice,
  deltaBreakdown,
  isUsableDelta,
  extractBreakdown,
  parseRateLimits,
  parseFullResetCredits
};
