function timestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 100_000_000_000 ? numeric : numeric * 1000;
}

function availableCount(credits) {
  const raw = credits && typeof credits === 'object' ? credits.availableCount : credits;
  if (raw === undefined || raw === null || raw === '') return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

function updateFullResetHistory(previousState, credits, now = Date.now()) {
  const previous =
    previousState && typeof previousState === 'object' && Number(previousState.version) === 2 ? previousState : {};
  const previousCount = availableCount(previous.availableCount);
  const currentCount = availableCount(credits);
  let lastDecreasedAt = timestamp(previous.lastDecreasedAt);

  if (currentCount !== null && previousCount !== null && currentCount < previousCount) {
    lastDecreasedAt = now;
  }

  const nextState = {
    version: 2,
    trackingSince: previous.trackingSince || new Date(now).toISOString(),
    availableCount: currentCount ?? previousCount,
    lastDecreasedAt
  };

  return {
    state: nextState,
    summary: {
      availableCount: currentCount,
      lastDecreasedAt,
      trackingSince: nextState.trackingSince
    }
  };
}

module.exports = {
  updateFullResetHistory
};
