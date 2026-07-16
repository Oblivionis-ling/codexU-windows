const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FULL_RESET_CREDITS_URL,
  normalizeFullResetCreditsResponse,
  readCodexCredentials,
  fetchFullResetCredits
} = require('../src/services/fullResetCredits');

test('full-reset details keep the available count and nearest expiration', () => {
  const details = normalizeFullResetCreditsResponse({
    available_count: 3,
    credits: [
      { title: 'Later reset', status: 'available', expires_at: '2026-09-01T00:00:00Z' },
      { title: 'Full reset', status: 'available', expires_at: '2026-08-12T17:42:35.918967Z' },
      { title: 'Used reset', status: 'redeemed', expires_at: '2026-07-20T00:00:00Z' }
    ]
  });

  assert.deepEqual(details, {
    availableCount: 3,
    nearestExpiresAt: '2026-08-12T17:42:35.918Z',
    nearestCreditTitle: 'Full reset',
    detailsAvailable: true,
    source: 'chatgpt-backend'
  });
});

test('full-reset details fall back to the available credit list count', () => {
  const details = normalizeFullResetCreditsResponse({
    credits: [{ title: 'Full reset', status: 'available', expires_at: null }]
  });

  assert.equal(details.availableCount, 1);
  assert.equal(details.nearestExpiresAt, null);
  assert.equal(details.detailsAvailable, true);
});

test('Codex credentials are read without returning unrelated tokens', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexu-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, 'auth.json');
  fs.writeFileSync(
    authPath,
    JSON.stringify({ tokens: { access_token: 'access-secret', account_id: 'account-1', refresh_token: 'hidden' } })
  );

  assert.deepEqual(await readCodexCredentials(authPath), {
    accessToken: 'access-secret',
    accountId: 'account-1'
  });
});

test('full-reset request uses the local Codex sign-in and returns sanitized details', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexu-reset-fetch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: 'access-secret', account_id: 'account-1' } }));
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          available_count: 1,
          credits: [{ id: 'private-credit-id', title: 'Full reset', status: 'available', expires_at: '2026-08-13' }]
        })
    };
  };

  const details = await fetchFullResetCredits({ authPath, fetchImpl, timeoutMs: 1000 });

  assert.equal(request.url, FULL_RESET_CREDITS_URL);
  assert.equal(request.options.headers.Authorization, 'Bearer access-secret');
  assert.equal(request.options.headers['ChatGPT-Account-Id'], 'account-1');
  assert.equal(details.availableCount, 1);
  assert.equal(details.nearestExpiresAt, '2026-08-13T00:00:00.000Z');
  assert.equal(JSON.stringify(details).includes('private-credit-id'), false);
  assert.equal(JSON.stringify(details).includes('access-secret'), false);
});
