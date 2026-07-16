const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  deltaBreakdown,
  extractBreakdown,
  isUsableDelta,
  modelTokenPrice,
  parseFullResetCredits,
  parseRateLimits,
  readDetailedUsage,
  readLocalUsage,
  resetUsageFileCache
} = require('../src/services/codexData');

function tokenEvent(timestamp, inputTokens, cachedInputTokens, outputTokens) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens
        }
      }
    }
  });
}

function createTempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('token breakdown uses cumulative deltas and rejects negative resets', () => {
  const first = extractBreakdown({ input_tokens: 100, output_tokens: 20, total_tokens: 120 });
  const second = extractBreakdown({ input_tokens: 150, output_tokens: 30, total_tokens: 180 });
  const reset = extractBreakdown({ input_tokens: 10, output_tokens: 10, total_tokens: 20 });

  assert.deepEqual(deltaBreakdown(first, null), first);
  assert.deepEqual(deltaBreakdown(second, first), {
    inputTokens: 50,
    cachedInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 60
  });
  assert.equal(isUsableDelta(deltaBreakdown(reset, second)), false);
});

test('incremental JSONL parsing keeps time windows accurate and reuses cache', async (t) => {
  resetUsageFileCache();
  const directory = createTempDir(t);
  const filePath = path.join(directory, 'session.jsonl');
  const now = new Date(2026, 6, 12, 12, 0, 0);
  const yesterday = new Date(2026, 6, 11, 10, 0, 0).toISOString();
  const today = new Date(2026, 6, 12, 8, 0, 0).toISOString();

  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.4' } }),
      tokenEvent(yesterday, 80, 20, 20),
      '{broken json',
      tokenEvent(today, 120, 30, 30)
    ].join('\n') + '\n'
  );

  const sources = [{ filePath, model: null }];
  const first = await readDetailedUsage(null, { now, sources });
  assert.equal(first.lifetime.tokens.totalTokens, 150);
  assert.equal(first.today.tokens.totalTokens, 50);
  assert.equal(first.unpricedTokens, undefined);
  assert.equal(first.lifetime.unpricedTokens, 0);
  assert.equal(first.filesParsed, 1);
  assert.ok(first.bytesRead > 0);

  const second = await readDetailedUsage(null, { now, sources });
  assert.equal(second.cacheHits, 1);
  assert.equal(second.bytesRead, 0);
  assert.equal(second.lifetime.tokens.totalTokens, 150);

  fs.appendFileSync(filePath, tokenEvent(today, 145, 35, 35) + '\n');
  const third = await readDetailedUsage(null, { now, sources });
  assert.equal(third.cacheHits, 0);
  assert.equal(third.lifetime.tokens.totalTokens, 180);
  assert.equal(third.today.tokens.totalTokens, 80);
  assert.ok(third.bytesRead > 0);
  assert.ok(third.bytesRead < fs.statSync(filePath).size);
});

test('unknown models remain counted but are not assigned a default price', async (t) => {
  resetUsageFileCache();
  const directory = createTempDir(t);
  const filePath = path.join(directory, 'unknown-model.jsonl');
  const now = new Date(2026, 6, 12, 12, 0, 0);
  fs.writeFileSync(filePath, tokenEvent(now.toISOString(), 80, 0, 20) + '\n');

  const usage = await readDetailedUsage(null, {
    now,
    sources: [{ filePath, model: null }]
  });

  assert.equal(usage.lifetime.tokens.totalTokens, 100);
  assert.equal(usage.lifetime.pricedTokens, 0);
  assert.equal(usage.lifetime.unpricedTokens, 100);
  assert.equal(usage.lifetime.estimatedCostUSD, 0);
  assert.equal(modelTokenPrice('unknown-provider'), null);
});

test('rate-limit variants are normalized', () => {
  const limits = parseRateLimits({
    rate_limits: {
      primary: { remaining_percent: 72, window_duration_mins: 300, resets_at: 1_800_000_000 },
      secondaryWindow: { usedPercent: 41, windowMinutes: 10080 }
    }
  });

  assert.equal(limits.primary.remainingPercent, 72);
  assert.equal(limits.primary.usedPercent, 28);
  assert.equal(limits.primary.windowDurationMins, 300);
  assert.equal(limits.secondary.remainingPercent, 59);
  assert.equal(limits.secondary.windowDurationMins, 10080);
  assert.equal(limits.fullResetCredits, null);
});

test('OpenAI full-reset credits are parsed separately from quota windows', () => {
  const result = {
    rateLimits: {
      primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
      secondary: null,
      planType: 'prolite'
    },
    rateLimitResetCredits: { availableCount: 1 }
  };

  const limits = parseRateLimits(result);
  assert.deepEqual(limits.fullResetCredits, { availableCount: 1 });
  assert.deepEqual(parseFullResetCredits({ rate_limit_reset_credits: { available_count: 3 } }), {
    availableCount: 3
  });
  assert.equal(parseFullResetCredits({ rateLimitResetCredits: null }), null);
});

test('a current single seven-day rate-limit window stays single', () => {
  const limits = parseRateLimits({
    rateLimits: {
      primary: {
        usedPercent: 1,
        remainingPercent: 99,
        windowDurationMins: 10080,
        resetsAt: 1_800_000_000
      },
      secondary: null
    }
  });

  assert.equal(limits.primary.usedPercent, 1);
  assert.equal(limits.primary.remainingPercent, 99);
  assert.equal(limits.primary.windowDurationMins, 10080);
  assert.equal(limits.secondary, null);
});

test('SQLite thread metadata supplies model and rollout-path fallbacks', (t) => {
  const directory = createTempDir(t);
  const dbPath = path.join(directory, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      rollout_path TEXT,
      model_provider TEXT,
      model TEXT
    )
  `);
  db.prepare(
    `
    INSERT INTO threads (
      rollout_path, model_provider, model
    ) VALUES (?, ?, ?)
  `
  ).run('sessions/thread-1.jsonl', 'openai', 'gpt-5.4');
  db.close();

  const local = readLocalUsage({ dbPath });
  assert.deepEqual(local.threads, [
    {
      model: 'gpt-5.4',
      rolloutPath: path.join(os.homedir(), '.codex', 'sessions', 'thread-1.jsonl')
    }
  ]);
});
