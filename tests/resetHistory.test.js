const test = require('node:test');
const assert = require('node:assert/strict');
const { updateFullResetHistory } = require('../src/services/resetHistory');

test('full-reset tracking starts from the server-provided available count', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const result = updateFullResetHistory(null, { availableCount: 3 }, now);

  assert.equal(result.summary.availableCount, 3);
  assert.equal(result.summary.lastDecreasedAt, null);
  assert.equal(result.state.availableCount, 3);
});

test('a lower full-reset credit count records when it was observed', () => {
  const firstNow = Date.UTC(2026, 6, 16, 12);
  const first = updateFullResetHistory(null, { availableCount: 3 }, firstNow);
  const secondNow = firstNow + 60_000;
  const second = updateFullResetHistory(first.state, { availableCount: 2 }, secondNow);

  assert.equal(second.summary.availableCount, 2);
  assert.equal(second.summary.lastDecreasedAt, secondNow);
});

test('newly granted full-reset credits do not look like expirations', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const first = updateFullResetHistory(null, { availableCount: 1 }, now);
  const increased = updateFullResetHistory(first.state, { availableCount: 2 }, now + 60_000);

  assert.equal(increased.summary.availableCount, 2);
  assert.equal(increased.summary.lastDecreasedAt, null);
});

test('legacy seven-day history is not reused as full-reset credit history', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const result = updateFullResetHistory({ version: 1, count: 99, lastResetAt: now - 1 }, { availableCount: 1 }, now);

  assert.equal(result.summary.availableCount, 1);
  assert.equal(result.summary.lastDecreasedAt, null);
  assert.equal(result.state.version, 2);
});

test('missing server credits do not erase the last observed local count', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const first = updateFullResetHistory(null, { availableCount: 1 }, now);
  const missing = updateFullResetHistory(first.state, null, now + 60_000);

  assert.equal(missing.summary.availableCount, null);
  assert.equal(missing.state.availableCount, 1);
});
