const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

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
  const candidates = [
    path.join(home, 'state_5.sqlite'),
    path.join(home, 'sqlite', 'state_5.sqlite')
  ];
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
  const updatedMs = normalizeEpoch(row.updated_at_ms) || normalizeEpoch(row.updated_at);
  const createdMs = normalizeEpoch(row.created_at_ms) || normalizeEpoch(row.created_at);
  const archivedMs = normalizeEpoch(row.archived_at);
  const title =
    asString(row.title).trim() ||
    asString(row.first_user_message).trim() ||
    asString(row.preview).trim() ||
    'Untitled Codex thread';

  return {
    id: asString(row.id),
    title,
    preview: asString(row.preview || row.first_user_message),
    tokens: safeNumber(row.tokens_used),
    updatedAt: updatedMs ? new Date(updatedMs).toISOString() : null,
    updatedMs,
    createdAt: createdMs ? new Date(createdMs).toISOString() : null,
    archivedAt: archivedMs ? new Date(archivedMs).toISOString() : null,
    archivedMs,
    model: asString(row.model || row.model_provider, 'unknown'),
    cwd: asString(row.cwd),
    workspace: shortWorkspaceName(asString(row.cwd)),
    rolloutPath: resolveCodexPath(asString(row.rollout_path)),
    archived: Boolean(row.archived)
  };
}

function resolveCodexPath(value) {
  if (!value) return '';
  if (value.startsWith('~')) return path.join(os.homedir(), value.slice(1));
  if (path.isAbsolute(value)) return value;
  return path.join(codexHome(), value);
}

function shortWorkspaceName(cwd) {
  if (!cwd) return 'unknown';
  const normalized = cwd.replace(/[\\/]+$/, '');
  return path.basename(normalized) || normalized;
}

function makeDailyBuckets(threads, now = new Date()) {
  const formatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });
  const start = startOfLocalDay(now) - 6 * DAY_MS;
  const buckets = [];
  for (let index = 0; index < 7; index += 1) {
    const dayStart = start + index * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const tokens = threads
      .filter((thread) => thread.updatedMs >= dayStart && thread.updatedMs < dayEnd)
      .reduce((sum, thread) => sum + thread.tokens, 0);
    buckets.push({
      id: new Date(dayStart).toISOString().slice(0, 10),
      label: formatter.format(new Date(dayStart)),
      tokens
    });
  }
  return buckets;
}

function readLocalUsage(messages) {
  const dbPath = findStateDb();
  if (!dbPath) {
    messages.push('未找到 Codex state_5.sqlite。');
    return null;
  }

  let db;
  try {
    db = openDatabase(dbPath);
    const rows = allRows(db, `
      SELECT
        id,
        rollout_path,
        created_at,
        updated_at,
        created_at_ms,
        updated_at_ms,
        model_provider,
        cwd,
        title,
        tokens_used,
        archived,
        archived_at,
        first_user_message,
        preview,
        model
      FROM threads
      ORDER BY COALESCE(NULLIF(updated_at_ms, 0), updated_at * 1000) DESC
    `);

    const threads = rows.map(normalizeThread);
    const now = new Date();
    const todayStart = startOfLocalDay(now);
    const sevenStart = todayStart - 6 * DAY_MS;
    const monthStart = startOfLocalMonth(now);

    const lifetimeTokens = threads.reduce((sum, thread) => sum + thread.tokens, 0);
    const todayTokens = threads
      .filter((thread) => thread.updatedMs >= todayStart)
      .reduce((sum, thread) => sum + thread.tokens, 0);
    const sevenDayTokens = threads
      .filter((thread) => thread.updatedMs >= sevenStart)
      .reduce((sum, thread) => sum + thread.tokens, 0);
    const monthTokens = threads
      .filter((thread) => thread.updatedMs >= monthStart)
      .reduce((sum, thread) => sum + thread.tokens, 0);

    return {
      dbPath,
      threads,
      threadsCount: threads.length,
      lifetimeTokens,
      todayTokens,
      sevenDayTokens,
      monthTokens,
      dailyBuckets: makeDailyBuckets(threads, now),
      recentThreads: threads.slice(0, 8)
    };
  } catch (error) {
    messages.push(`SQLite 读取失败：${error.message}`);
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
  return delta.totalTokens > 0 && ![
    delta.inputTokens,
    delta.cachedInputTokens,
    delta.outputTokens,
    delta.reasoningOutputTokens,
    delta.totalTokens
  ].some((value) => value < 0);
}

function modelTokenPrice(model) {
  const value = asString(model).toLowerCase();
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
  return { model: 'gpt-5.5', inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 };
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
    estimatedCostUSD: 0
  };
}

function addPricedUsage(bucket, delta, price) {
  addBreakdown(bucket.tokens, delta);
  bucket.estimatedCostUSD += estimatedCostUSD(delta, price);
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

  return candidates.find((candidate) =>
    candidate &&
    typeof candidate === 'object' &&
    (
      candidate.input_tokens !== undefined ||
      candidate.inputTokens !== undefined ||
      candidate.total_tokens !== undefined ||
      candidate.totalTokens !== undefined
    )
  ) || null;
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

async function parseUsageFile(filePath, model, accumulator, windows) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return 0;

  let previous = null;
  let events = 0;
  const price = modelTokenPrice(model);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.includes('token_count')) continue;
    let object;
    try {
      object = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = findTokenPayload(object);
    const usage = findUsageObject(payload);
    const current = extractBreakdown(usage);
    if (!current) continue;

    const delta = deltaBreakdown(current, previous);
    previous = current;
    if (!isUsableDelta(delta)) continue;

    const eventMs = extractEventTimeMs(object, stat.mtimeMs);
    addPricedUsage(accumulator.lifetime, delta, price);
    if (eventMs >= windows.monthStart) addPricedUsage(accumulator.month, delta, price);
    if (eventMs >= windows.sevenStart) addPricedUsage(accumulator.sevenDay, delta, price);
    if (eventMs >= windows.todayStart) addPricedUsage(accumulator.today, delta, price);
    events += 1;
  }

  return events;
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

  for (const folder of [
    path.join(codexHome(), 'sessions'),
    path.join(codexHome(), 'archived_sessions')
  ]) {
    if (!pathExists(folder)) continue;
    for (const file of walkFiles(folder, 700)) {
      if (/\.jsonl$/i.test(file) && /rollout-|session-|\.jsonl$/i.test(path.basename(file))) {
        const resolved = path.resolve(file);
        if (!sources.has(resolved)) sources.set(resolved, 'gpt-5.5');
      }
    }
  }

  return [...sources.entries()].map(([filePath, model]) => ({ filePath, model }));
}

function walkFiles(root, limit) {
  const result = [];
  const stack = [root];
  while (stack.length && result.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
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

async function readDetailedUsage(localUsage, messages) {
  const now = new Date();
  const windows = {
    todayStart: startOfLocalDay(now),
    sevenStart: startOfLocalDay(now) - 6 * DAY_MS,
    monthStart: startOfLocalMonth(now)
  };
  const accumulator = {
    today: usageBucket(),
    sevenDay: usageBucket(),
    month: usageBucket(),
    lifetime: usageBucket()
  };

  const sources = collectUsageSources(localUsage);
  let eventCount = 0;
  for (const source of sources) {
    try {
      eventCount += await parseUsageFile(source.filePath, source.model, accumulator, windows);
    } catch {
      // Corrupt or concurrently changing session logs should not break the widget.
    }
  }

  if (!eventCount) {
    messages.push('未找到可解析的 token_count 事件，详细拆分将为空。');
  }

  return {
    ...accumulator,
    sourcesScanned: sources.length,
    tokenEvents: eventCount
  };
}

function parseSimpleToml(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function scheduleSummary(raw) {
  const value = asString(raw).toUpperCase();
  if (!value) return 'scheduled';
  if (value.includes('FREQ=DAILY')) return 'daily';
  if (value.includes('FREQ=WEEKLY')) return 'weekly';
  if (value.includes('FREQ=MONTHLY')) return 'monthly';
  if (value.includes('FREQ=HOURLY')) return 'hourly';
  return raw;
}

function readAutomationTasks() {
  const dir = path.join(codexHome(), 'automations');
  if (!pathExists(dir)) return [];
  return walkFiles(dir, 200)
    .filter((file) => /\.toml$/i.test(file))
    .slice(0, 20)
    .map((file) => {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = parseSimpleToml(raw);
      return {
        id: file,
        title: parsed.title || parsed.name || parsed.objective || parsed.prompt || path.basename(file, '.toml'),
        detail: scheduleSummary(parsed.rrule || parsed.schedule || parsed.cron),
        path: file,
        updatedAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
        kind: 'scheduled'
      };
    });
}

function makeTaskBoard(localUsage) {
  const now = Date.now();
  const todayStart = startOfLocalDay(new Date());
  const activeCutoff = now - ACTIVE_WINDOW_MS;
  const active = [];
  const pending = [];
  const done = [];

  for (const thread of localUsage ? localUsage.threads : []) {
    if (thread.archived) {
      const doneMs = thread.archivedMs || thread.updatedMs;
      if (doneMs >= todayStart) done.push(taskFromThread(thread, 'done'));
      continue;
    }
    if (thread.updatedMs < todayStart) continue;
    if (thread.updatedMs >= activeCutoff) active.push(taskFromThread(thread, 'active'));
    else pending.push(taskFromThread(thread, 'pending'));
  }

  const scheduled = readAutomationTasks();
  return {
    refreshedAt: new Date().toISOString(),
    columns: [
      { id: 'active', title: '进行中', titleEn: 'Active', count: active.length, items: active },
      { id: 'pending', title: '待处理', titleEn: 'Pending', count: pending.length, items: pending },
      { id: 'scheduled', title: '定时', titleEn: 'Scheduled', count: scheduled.length, items: scheduled },
      { id: 'done', title: '完成', titleEn: 'Done', count: done.length, items: done }
    ]
  };
}

function taskFromThread(thread, kind) {
  return {
    id: thread.id,
    title: thread.title,
    detail: thread.workspace,
    updatedAt: thread.updatedAt,
    path: thread.cwd,
    kind
  };
}

function parseRateWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const usedRaw = value.usedPercent ?? value.used_percent ?? value.used;
  const remainingRaw = value.remainingPercent ?? value.remaining_percent;
  const usedPercent = remainingRaw === undefined || remainingRaw === null
    ? clampPercent(usedRaw)
    : clampPercent(usedRaw, 100 - clampPercent(remainingRaw));
  const remainingPercent = remainingRaw === undefined || remainingRaw === null
    ? clampPercent(100 - usedPercent)
    : clampPercent(remainingRaw);
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
  return {
    type: asString(account.type || account.authType || account.auth_type || 'unknown'),
    planType: account.planType || account.plan_type || account.plan || null,
    emailPresent: Boolean(account.email || account.emailPresent || account.email_present)
  };
}

function parseRateLimits(result) {
  const root = result && (result.rateLimits || result.rate_limits || result.limits || result);
  return {
    primary: parseRateWindow(root && (root.primary || root.primaryWindow)),
    secondary: parseRateWindow(root && (root.secondary || root.secondaryWindow))
  };
}

function parseCloudUsage(result) {
  const root = result && (result.usage || result.summary || result);
  return safeNumber(
    root && (
      root.totalTokens ??
      root.total_tokens ??
      root.lifetimeTokens ??
      root.lifetime_tokens ??
      root.tokens
    ),
    0
  );
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
    candidates.push(path.join(
      path.dirname(platformPackageJson),
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    ));
  } catch {
    // The bundled CLI is optional; PATH-based candidates still run below.
  }

  try {
    const codexPackageRoot = path.dirname(require.resolve('@openai/codex/package.json'));
    candidates.push(path.join(
      codexPackageRoot,
      '..',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    ));
  } catch {
    // Ignore.
  }

  return candidates
    .map((candidate) => asarUnpackedPath(path.normalize(candidate)))
    .filter(pathExists);
}

function tryAppServerCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const messages = [];
    const snapshot = {
      account: null,
      primary: null,
      secondary: null,
      cloudLifetimeTokens: 0
    };
    let settled = false;
    let buffer = '';
    let completed = 0;

    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      resolve({ ok, reason, snapshot, messages, command });
    };

    let child;
    try {
      child = spawn(command, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      resolve({ ok: false, reason: error.message, snapshot, messages, command });
      return;
    }

    const timer = setTimeout(() => finish(completed >= 2, completed >= 2 ? null : 'app-server 响应超时'), timeoutMs);

    child.on('error', (error) => finish(false, error.message));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) messages.push(text);
    });
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
        clientInfo: { name: 'codexu-windows', version: '0.1.0' }
      }
    };
    send(initialize);
    setTimeout(() => {
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      send({ id: 3, method: 'account/rateLimits/read', params: {} });
      send({ id: 4, method: 'account/usage/read', params: {} });
    }, 80);

    function parseAppServerLine(line) {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        messages.push(`app-server 非 JSON 输出：${line.slice(0, 120)}`);
        return;
      }
      if (message.error) {
        messages.push(`app-server ${message.id || ''}: ${message.error.message || JSON.stringify(message.error)}`);
        completed += 1;
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
        completed += 1;
      }
      if (message.id === 4) {
        snapshot.cloudLifetimeTokens = parseCloudUsage(message.result);
        completed += 1;
      }
      if (completed >= 3) finish(true, null);
    }
  });
}

async function readAppServer(messages) {
  for (const command of codexCommandCandidates()) {
    const result = await tryAppServerCommand(command, 12000);
    if (result.ok && (result.snapshot.primary || result.snapshot.secondary || result.snapshot.account)) {
      messages.push(`app-server 来源：${command}`);
      return result.snapshot;
    }
    const reason = result.reason || result.messages.join('; ') || '无可用响应';
    messages.push(`app-server 不可用（${command}）：${reason}`);
  }
  return {
    account: null,
    primary: null,
    secondary: null,
    cloudLifetimeTokens: 0
  };
}

async function loadSnapshot() {
  const messages = [];
  const local = readLocalUsage(messages);
  const [detailedUsage, appServer] = await Promise.all([
    readDetailedUsage(local, messages),
    readAppServer(messages)
  ]);

  if (local) {
    local.detailedUsage = detailedUsage;
  }
  const taskBoard = makeTaskBoard(local);
  if (local) delete local.threads;

  return {
    refreshedAt: new Date().toISOString(),
    account: appServer.account,
    primary: appServer.primary,
    secondary: appServer.secondary,
    cloudLifetimeTokens: appServer.cloudLifetimeTokens,
    local,
    taskBoard,
    diagnostics: messages.map((message, index) => ({ id: String(index + 1), message }))
  };
}

module.exports = {
  loadSnapshot,
  readLocalUsage,
  readDetailedUsage,
  makeTaskBoard,
  modelTokenPrice,
  estimatedCostUSD
};
