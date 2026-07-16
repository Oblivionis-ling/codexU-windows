const fs = require('fs');
const os = require('os');
const path = require('path');

const FULL_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const MAX_RESPONSE_BYTES = 256 * 1024;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function defaultAuthPath() {
  return path.join(codexHome(), 'auth.json');
}

function nonNegativeInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

function normalizeExpiry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString();
}

function normalizeTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title ? title.slice(0, 120) : null;
}

function normalizeFullResetCreditsResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Full reset detail response is not an object.');
  }

  const rawCredits = Array.isArray(value.credits) ? value.credits : [];
  const availableCredits = rawCredits
    .filter((credit) => credit && typeof credit === 'object' && (!credit.status || credit.status === 'available'))
    .map((credit) => ({
      title: normalizeTitle(credit.title),
      expiresAt: normalizeExpiry(credit.expires_at ?? credit.expiresAt)
    }));
  const availableCount = nonNegativeInteger(value.available_count ?? value.availableCount) ?? availableCredits.length;
  const expiringCredits = availableCredits
    .filter((credit) => credit.expiresAt)
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
  const nearest = expiringCredits[0] || null;

  return {
    availableCount,
    nearestExpiresAt: nearest && nearest.expiresAt,
    nearestCreditTitle: nearest && nearest.title,
    detailsAvailable: true,
    source: 'chatgpt-backend'
  };
}

async function readCodexCredentials(authPath = defaultAuthPath()) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(authPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read the local Codex sign-in: ${error.message}`);
  }

  const accessToken = parsed && parsed.tokens && parsed.tokens.access_token;
  const accountId = parsed && parsed.tokens && parsed.tokens.account_id;
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('The local Codex sign-in does not contain an access token.');
  }

  return {
    accessToken: accessToken.trim(),
    accountId: typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null
  };
}

async function fetchFullResetCredits(options = {}) {
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  const credentials = await readCodexCredentials(options.authPath);
  const controller = new globalThis.AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(FULL_RESET_CREDITS_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.accessToken}`,
        ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {})
      },
      signal: controller.signal
    });

    if (!response || !response.ok) {
      const status = response && Number(response.status);
      throw new Error(`Full reset detail request failed${Number.isFinite(status) ? ` (HTTP ${status})` : ''}.`);
    }

    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Full reset detail response is unexpectedly large.');
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('Full reset detail response is not valid JSON.');
    }
    return normalizeFullResetCreditsResponse(parsed);
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Full reset detail request timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  FULL_RESET_CREDITS_URL,
  defaultAuthPath,
  normalizeFullResetCreditsResponse,
  readCodexCredentials,
  fetchFullResetCredits
};
