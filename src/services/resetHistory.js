function timestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 100_000_000_000 ? numeric : numeric * 1000;
}

function validCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function completedBoundary(nextResetAt, durationMs, now) {
  if (!nextResetAt) return null;
  if (!durationMs) return nextResetAt <= now ? nextResetAt : null;
  if (nextResetAt > now) {
    const boundary = nextResetAt - durationMs;
    return boundary <= now ? boundary : null;
  }
  return nextResetAt + Math.floor((now - nextResetAt) / durationMs) * durationMs;
}

function updateResetHistory(previousState, limits, now = Date.now()) {
  const previous = previousState && typeof previousState === 'object' ? previousState : {};
  const previousWindows = previous.windows && typeof previous.windows === 'object' ? previous.windows : {};
  const nextState = {
    version: 1,
    count: validCount(previous.count),
    trackingSince: previous.trackingSince || new Date(now).toISOString(),
    windows: { ...previousWindows }
  };
  let lastResetAt = timestamp(previous.lastResetAt);

  for (const limit of Array.isArray(limits) ? limits : []) {
    if (!limit || typeof limit !== 'object') continue;
    const durationMins = Number(limit.windowDurationMins);
    const durationMs = Number.isFinite(durationMins) && durationMins > 0 ? durationMins * 60_000 : 0;
    const nextResetAt = timestamp(limit.resetsAt);
    if (!nextResetAt) continue;

    const key = durationMs ? `duration:${durationMins}` : 'default';
    const previousWindow = previousWindows[key] && typeof previousWindows[key] === 'object' ? previousWindows[key] : {};
    const latestBoundary = completedBoundary(nextResetAt, durationMs, now);
    let lastCountedResetAt = timestamp(previousWindow.lastCountedResetAt);

    if (!lastCountedResetAt && latestBoundary) {
      lastCountedResetAt = latestBoundary;
    } else if (latestBoundary && latestBoundary > lastCountedResetAt) {
      const advance = latestBoundary - lastCountedResetAt;
      const isRealReset = !durationMs || advance >= durationMs * 0.5;
      if (isRealReset) {
        const increments = durationMs ? Math.max(1, Math.round(advance / durationMs)) : 1;
        nextState.count += increments;
        lastCountedResetAt = latestBoundary;
      }
    }

    if (latestBoundary) lastResetAt = Math.max(lastResetAt || 0, latestBoundary);
    nextState.windows[key] = {
      nextResetAt,
      lastCountedResetAt
    };
  }

  nextState.lastResetAt = lastResetAt;
  return {
    state: nextState,
    summary: {
      count: nextState.count,
      lastResetAt,
      trackingSince: nextState.trackingSince
    }
  };
}

module.exports = {
  completedBoundary,
  updateResetHistory
};
