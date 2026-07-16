const test = require('node:test');
const assert = require('node:assert/strict');
const { updateResetHistory } = require('../src/services/resetHistory');

const DAY = 24 * 60 * 60 * 1000;
const WEEK_MINS = 7 * 24 * 60;

function limit(nextResetAt) {
  return {
    remainingPercent: 99,
    windowDurationMins: WEEK_MINS,
    resetsAt: nextResetAt
  };
}

test('reset tracking starts from the inferred previous boundary without inventing a count', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const result = updateResetHistory(null, [limit(now + 7 * DAY)], now);

  assert.equal(result.summary.count, 0);
  assert.equal(result.summary.lastResetAt, now);
});

test('a newly completed quota window increments the local reset count', () => {
  const firstNow = Date.UTC(2026, 6, 16, 12);
  const first = updateResetHistory(null, [limit(firstNow + 7 * DAY)], firstNow);
  const secondNow = firstNow + 7 * DAY + 1000;
  const second = updateResetHistory(first.state, [limit(firstNow + 14 * DAY)], secondNow);

  assert.equal(second.summary.count, 1);
  assert.equal(second.summary.lastResetAt, firstNow + 7 * DAY);
});

test('a small reset schedule correction does not count as a completed window', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const first = updateResetHistory(null, [limit(now + 7 * DAY)], now);
  const corrected = updateResetHistory(first.state, [limit(now + 7 * DAY + 30 * 60 * 1000)], now + 60 * 60 * 1000);

  assert.equal(corrected.summary.count, 0);
});

test('a reset window that has not started does not report a future previous reset', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const result = updateResetHistory(null, [limit(now + 14 * DAY)], now);

  assert.equal(result.summary.count, 0);
  assert.equal(result.summary.lastResetAt, null);
});
