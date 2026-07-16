const state = {
  snapshot: null,
  preferences: {
    theme: 'dark',
    alwaysOnTop: true,
    subscriptionPriceUSD: null
  },
  loading: true,
  error: null,
  refreshing: false
};

let rendererRefreshPromise = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function icon(name) {
  const icons = {
    refresh:
      '<path d="M19.2 7.2V3.8m0 0h-3.4m3.4 0-2.6 2.6a7.3 7.3 0 1 0 1.2 9.9"/><path d="M18 12a6 6 0 0 1-.2 1.5"/>',
    close: '<path d="m7.2 7.2 9.6 9.6m0-9.6-9.6 9.6"/>',
    reset: '<path d="M12 5.2a6.8 6.8 0 1 1-6.4 4.5"/><path d="M4.8 5.6v4.2H9"/><path d="M12 8.2v4.2l2.8 1.7"/>',
    value: '<path d="M5 16.5 9.4 12l3 3 6.6-7"/><path d="M15.5 8H19v3.5"/>',
    pin: '<path d="m14.5 4.5 5 5-2.5.7-3.2 3.2.3 3.5-1.7 1.7-3.1-5-4.8-2.9L6.2 9l3.4.3 3.2-3.2.7-2.5Z"/>'
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.value}</svg>`;
}

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function timestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 100_000_000_000 ? numeric : numeric * 1000;
}

function hasRateLimit(limit) {
  return Boolean(limit && Number.isFinite(Number(limit.remainingPercent)));
}

function quotaWindows(snapshot) {
  const unique = new Map();
  for (const limit of [snapshot?.primary, snapshot?.secondary]) {
    if (!hasRateLimit(limit)) continue;
    const duration = Number(limit.windowDurationMins || 0);
    const key = duration > 0 ? `duration:${duration}` : `window:${unique.size}`;
    if (!unique.has(key)) unique.set(key, limit);
  }
  return [...unique.values()].sort(
    (left, right) =>
      Number(left.windowDurationMins || Number.MAX_SAFE_INTEGER) -
      Number(right.windowDurationMins || Number.MAX_SAFE_INTEGER)
  );
}

function durationLabel(minutes) {
  const value = Number(minutes || 0);
  if (value > 0 && value % 1440 === 0) return `${value / 1440}d`;
  if (value > 0 && value % 60 === 0) return `${value / 60}h`;
  return value > 0 ? `${value}m` : '额度';
}

function formatDate(value, includeTime = false) {
  const dateValue = timestamp(value);
  if (!dateValue) return '--';
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return '--';
  const options = {
    month: 'short',
    day: 'numeric'
  };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
  }
  return new Intl.DateTimeFormat('zh-CN', options).format(date);
}

function formatRefreshTime(value) {
  const numeric = timestamp(value);
  if (!numeric) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(numeric));
}

function money(value) {
  const number = Number(value || 0);
  const digits = number >= 100 ? 0 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(number);
}

function planDetails(planType, configuredPrice) {
  const normalized = String(planType || '')
    .trim()
    .toLowerCase();
  const labels = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Team',
    self_serve_business_usage_based: 'Business',
    business: 'Business',
    enterprise_cbp_usage_based: 'Enterprise',
    enterprise: 'Enterprise',
    edu: 'Edu'
  };
  const knownPrices = { plus: 20, pro: 200, team: 30, business: 30 };
  const selectedPrice = Number(configuredPrice);
  const price = Number.isFinite(selectedPrice) && selectedPrice > 0 ? selectedPrice : (knownPrices[normalized] ?? null);
  return {
    label: labels[normalized] || (normalized ? String(planType) : '未知套餐'),
    price
  };
}

function renderLoading() {
  return `
    <section class="widget-frame loading-frame" aria-label="正在加载 CodexU">
      <div class="skeleton skeleton-title"></div>
      <div class="loading-grid">
        <div class="skeleton skeleton-ring"></div>
        <div class="loading-stack">
          <div class="skeleton skeleton-card"></div>
          <div class="skeleton skeleton-card"></div>
        </div>
      </div>
    </section>
  `;
}

function renderError(message) {
  return `
    <section class="widget-frame error-frame">
      <div>
        <strong>暂时无法读取额度</strong>
        <span>${escapeHtml(message)}</span>
      </div>
      <button id="retryButton" class="retry-button" type="button">重试</button>
    </section>
  `;
}

function renderQuota(limit) {
  const percent = hasRateLimit(limit) ? Math.round(clamp(limit.remainingPercent)) : 0;
  const label = durationLabel(limit?.windowDurationMins);
  return `
    <section class="quota-panel" aria-label="${escapeHtml(label)} 额度剩余 ${percent}%">
      <div class="quota-ring">
        <svg viewBox="0 0 128 128" role="img" aria-label="额度剩余 ${percent}%">
          <circle class="ring-track" cx="64" cy="64" r="52" pathLength="100"></circle>
          <circle class="ring-progress" cx="64" cy="64" r="52" pathLength="100" style="stroke-dasharray:${percent} 100"></circle>
        </svg>
        <div class="ring-copy">
          <span>${escapeHtml(label)}</span>
          <strong>${hasRateLimit(limit) ? `${percent}%` : '--'}</strong>
          <small>可用额度</small>
        </div>
      </div>
    </section>
  `;
}

function renderResetCard(fullResetHistory) {
  const rawCount = fullResetHistory?.availableCount;
  const count = rawCount === null || rawCount === undefined ? null : Math.max(0, Math.floor(Number(rawCount)));
  const lastDecreasedAt = timestamp(fullResetHistory?.lastDecreasedAt);
  return `
    <section class="metric-card reset-card">
      <div class="metric-heading">
        <span>${icon('reset')}Full reset</span>
        <b>${count === null || !Number.isFinite(count) ? '--' : `${count} 次`}</b>
      </div>
      <strong class="countdown">${count === null || !Number.isFinite(count) ? '暂不可用' : `${count} 次可用`}</strong>
      <div class="metric-meta" title="OpenAI 未提供 full reset 的过期日期；这里只记录可用次数最近一次减少的时间">
        <span>最近减少 ${formatDate(lastDecreasedAt)}</span>
        <span>有效期未提供</span>
      </div>
    </section>
  `;
}

function renderValueCard(snapshot, preferences) {
  const detailed = snapshot?.local?.detailedUsage || {};
  const month = detailed.month || {};
  const earned = Number(month.estimatedCostUSD || 0);
  const unpriced = Number(month.unpricedTokens || 0);
  const plan = planDetails(snapshot?.account?.planType, preferences?.subscriptionPriceUSD);
  const hasPrice = Number.isFinite(plan.price) && plan.price > 0;
  const rawProgress = hasPrice ? (earned / plan.price) * 100 : 0;
  const progress = clamp(rawProgress);
  const multiple = hasPrice ? earned / plan.price : 0;
  return `
    <section class="metric-card value-card">
      <div class="metric-heading">
        <span>${icon('value')}薅羊毛进度</span>
        <b>${hasPrice ? (multiple >= 1 ? `${multiple.toFixed(multiple >= 10 ? 0 : 1)}×` : `${Math.round(rawProgress)}%`) : '待设置'}</b>
      </div>
      <div class="value-line">
        <strong>${unpriced > 0 ? '≥' : ''}${money(earned)}</strong>
        <span>/ ${hasPrice ? money(plan.price) : '未设置'}</span>
      </div>
      <div class="value-track" role="progressbar" aria-label="薅羊毛进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}">
        <i style="width:${progress}%"></i>
      </div>
      <div class="metric-meta">
        <span>${escapeHtml(plan.label)} 套餐</span>
        <span>${hasPrice ? '本月估算' : '托盘中设置价格'}</span>
      </div>
    </section>
  `;
}

function render() {
  const root = document.getElementById('app');
  document.body.dataset.theme = 'dark';

  if (state.loading) {
    root.innerHTML = renderLoading();
    return;
  }

  if (state.error && !state.snapshot) {
    root.innerHTML = renderError(state.error);
    document.getElementById('retryButton')?.addEventListener('click', refresh);
    return;
  }

  const snapshot = state.snapshot || {};
  const windows = quotaWindows(snapshot);
  const primaryLimit = windows[0] || null;
  root.innerHTML = `
    <section class="widget-frame${state.refreshing ? ' is-refreshing' : ''}">
      <header class="titlebar">
        <div class="brand-block">
          <span class="brand-orb" aria-hidden="true"></span>
          <div>
            <strong>codexU</strong>
            <span>${state.preferences.alwaysOnTop ? `${icon('pin')} 已置顶` : '桌面组件'}</span>
          </div>
        </div>
        <div class="title-actions">
          <span class="live-status"><i></i>实时</span>
          <span class="shortcut-hint">Ctrl U</span>
          <button id="refreshButton" class="icon-button refresh-button" type="button" aria-label="立即刷新" title="立即刷新" ${state.refreshing ? 'disabled' : ''}>${icon('refresh')}</button>
          <button id="hideButton" class="icon-button hide-button" type="button" aria-label="隐藏窗口" title="隐藏窗口">${icon('close')}</button>
        </div>
      </header>
      <main class="widget-content">
        ${renderQuota(primaryLimit)}
        <div class="metrics-stack">
          ${renderResetCard(snapshot.fullResetHistory)}
          ${renderValueCard(snapshot, state.preferences)}
        </div>
      </main>
      <div class="refresh-stamp" title="最近刷新时间">${formatRefreshTime(snapshot.refreshedAt)}</div>
    </section>
  `;

  document.getElementById('refreshButton')?.addEventListener('click', refresh);
  document.getElementById('hideButton')?.addEventListener('click', () => window.codexU.windowAction('hide'));
}

async function refresh() {
  if (rendererRefreshPromise) return rendererRefreshPromise;
  state.loading = false;
  state.refreshing = true;
  render();
  const operation = (async () => {
    try {
      state.snapshot = await window.codexU.refreshSnapshot();
      state.error = null;
    } catch (error) {
      state.error = error.message;
    } finally {
      state.refreshing = false;
      render();
    }
  })();
  rendererRefreshPromise = operation;
  try {
    return await operation;
  } finally {
    if (rendererRefreshPromise === operation) rendererRefreshPromise = null;
  }
}

async function init() {
  try {
    const [preferences, snapshot] = await Promise.all([window.codexU.getPreferences(), window.codexU.getSnapshot()]);
    state.preferences = preferences;
    state.snapshot = snapshot;
    state.loading = false;
    render();
  } catch (error) {
    state.error = error.message;
    state.loading = false;
    render();
  }
}

setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, 15_000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

window.codexU.onSnapshotUpdated((snapshot) => {
  state.snapshot = snapshot;
  state.loading = false;
  state.error = null;
  render();
});

window.codexU.onPreferencesUpdated((preferences) => {
  state.preferences = preferences;
  render();
});

init();
