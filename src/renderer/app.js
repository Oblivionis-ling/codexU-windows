const state = {
  snapshot: null,
  preferences: {
    theme: 'dark',
    alwaysOnTop: true
  },
  loading: true,
  error: null
};

const labels = {
  subtitle: 'Codex 用量、额度和今日任务',
  shortcut: 'Ctrl + Alt + U 显示/隐藏',
  refresh: '刷新',
  top: '置顶',
  untop: '取消置顶',
  unavailable: '不可用',
  remaining: '剩余',
  resets: '重置',
  account: '账号',
  today: '今日',
  seven: '近 7 天',
  lifetime: '累计',
  localUsage: '本地用量',
  details: 'Token 拆分与 API 等效价值',
  input: '未缓存',
  cached: '缓存',
  output: '输出',
  reasoning: '推理',
  tasks: '今日任务看板',
  recent: '最近线程',
  env: '环境检查',
  scanned: '扫描',
  events: '事件',
  refreshed: '刷新',
  noData: '暂无',
  threads: '线程',
  wool: '羊毛进度',
  referenceCap: '满额',
  pro: 'PRO'
};

function t(key) {
  return labels[key] || key;
}

function icon(name, className = 'ui-icon') {
  const icons = {
    app: '<rect x="4.2" y="5.2" width="15.6" height="13.2" rx="3.4"/><path d="m7.7 10.2 2.1 1.8-2.1 1.8"/><path d="M11.3 13.8h3.4"/><path d="M16.5 8.1a3.8 3.8 0 0 1 1.4 3.7"/><path d="M15.2 9.6a2 2 0 0 1 .7 1.9"/><path class="star-fill" d="m16.8 3.4.6 1.2 1.3.2-1 .9.3 1.3-1.2-.7-1.2.7.3-1.3-1-.9 1.3-.2.6-1.2Z"/>',
    pin: '<path d="m14.2 3.8 6 6-2.9.8-3.8 3.8.4 4.1-2 2-3.7-6.1-5.8-3.5 2-2 4 .3 3.9-3.9.9-2.8Z"/>',
    refresh: '<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18 9a6.7 6.7 0 0 0-11.1-2.6L4 9m16 6-2.9 2.6A6.7 6.7 0 0 1 6 15"/>',
    minimize: '<path d="M5 12h14"/>',
    close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
    today: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
    week: '<path d="M4.8 5.5h14.4v14H4.8Z"/><path d="M4.8 9.2h14.4"/><path d="M8.3 4v3M15.7 4v3"/><path d="M8.2 13h2M13.8 13h2M8.2 16.3h2"/>',
    total: '<path d="M16.8 5H7.2l4.8 7-4.8 7h9.6"/><path d="M8.8 12h5.8"/>',
    wool: '<path d="M4.5 17.5h15"/><path d="M6.2 16V9.5"/><path d="M11.8 16V6.2"/><path d="M17.4 16v-4.8"/><path d="m6.2 9.5 5.6-3.3 5.6 5"/>',
    input: '<path d="M4 12h11"/><path d="m11 8 4 4-4 4"/><path d="M19 5v14"/>',
    cached: '<path d="M7 7.2c1.3-1.4 3.1-2.2 5-2.2a7 7 0 1 1-6.5 9.6"/><path d="M7 4.5v2.7h2.7"/><path d="M10 12h4"/>',
    output: '<path d="M20 12H9"/><path d="m13 8-4 4 4 4"/><path d="M5 5v14"/>',
    active: '<circle cx="12" cy="12" r="7"/><path d="m12 8 2.6 4-2.6 4-2.6-4Z"/>',
    pending: '<circle cx="12" cy="12" r="7"/><path d="M12 8v4l2.5 2"/>',
    scheduled: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M8 3.5v3M16 3.5v3M5 9h14"/><path d="M12 12v3l2 1"/>',
    done: '<circle cx="12" cy="12" r="7"/><path d="m8.8 12.2 2.1 2.1 4.5-4.8"/>',
    more: '<circle cx="6.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="17.5" cy="12" r="1"/>',
    sun: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
    moon: '<path d="M18.4 14.2A6.8 6.8 0 0 1 9.8 5.6a7 7 0 1 0 8.6 8.6Z"/>'
  };
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.total}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function hasRateLimit(limit) {
  return Boolean(limit && Number.isFinite(Number(limit.remainingPercent)));
}

function gaugePercent(limit) {
  return hasRateLimit(limit) ? clamp(limit.remainingPercent) : 0;
}

function gaugePercentLabel(limit) {
  return hasRateLimit(limit) ? String(Math.round(clamp(limit.remainingPercent))) + '%' : '--';
}

function formatTokens(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 10_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 10_000) return `${(number / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('zh-CN').format(number);
}

function formatCost(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatCompactCost(value) {
  const number = Number(value || 0);
  if (number >= 1000) return `$${(number / 1000).toFixed(1)}K`;
  return formatCost(number);
}

function formatPercent(value, digits = 1) {
  if (value === null || value === undefined) return '--';
  return `${Number(value).toFixed(digits)}%`;
}

function formatTime(value) {
  if (!value) return '--';
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) && String(value).trim() !== ''
    ? (numeric > 100_000_000_000 ? numeric : numeric * 1000)
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function relativeTime(value) {
  if (!value) return '--';
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return '--';
  const minutes = Math.max(0, Math.floor(delta / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function durationLabel(minutes) {
  const value = Number(minutes || 0);
  if (value === 300) return '5h';
  if (value === 10080) return '7d';
  if (value > 0 && value % 1440 === 0) return `${value / 1440}d`;
  if (value > 0 && value % 60 === 0) return `${value / 60}h`;
  return value > 0 ? `${value} min` : '--';
}

function tokensFromUsage(usage, fallback = 0) {
  return Number(usage?.tokens?.totalTokens || fallback || 0);
}

function tokenParts(usage) {
  const tokens = usage?.tokens || {};
  const cached = Math.max(Number(tokens.cachedInputTokens || 0), 0);
  const input = Math.max(Number(tokens.inputTokens || 0) - cached, 0);
  const output = Math.max(Number(tokens.outputTokens || 0), 0);
  const reasoning = Math.max(Number(tokens.reasoningOutputTokens || 0), 0);
  const total = Math.max(input + cached + output, Number(tokens.totalTokens || 0), 1);
  return { input, cached, output, reasoning, total };
}

function widthPercent(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100);
}

function renderQuotaGauge(primary, secondary) {
  const primaryPercent = gaugePercent(primary);
  const secondaryPercent = gaugePercent(secondary);
  const primaryReset = formatTime(primary?.resetsAt);
  const secondaryReset = formatTime(secondary?.resetsAt);
  return `
    <section class="quota-card glass-panel">
      <div class="dual-gauge" style="--outer:${primaryPercent}; --inner:${secondaryPercent}">
        <svg class="gauge-rings" viewBox="0 0 240 240" aria-hidden="true">
          <circle class="gauge-track gauge-track-outer" cx="120" cy="120" r="92" pathLength="100"></circle>
          <circle class="gauge-progress gauge-progress-outer" cx="120" cy="120" r="92" pathLength="100" stroke-dasharray="${primaryPercent} 100"></circle>
          <circle class="gauge-track gauge-track-inner" cx="120" cy="120" r="61" pathLength="100"></circle>
          <circle class="gauge-progress gauge-progress-inner" cx="120" cy="120" r="61" pathLength="100" stroke-dasharray="${secondaryPercent} 100"></circle>
        </svg>
        <div class="gauge-center">
          <div><span>5h</span><strong>${gaugePercentLabel(primary)}</strong></div>
          <div><span>7d</span><strong>${gaugePercentLabel(secondary)}</strong></div>
        </div>
      </div>
      <div class="quota-legend">
        <div class="legend-row outer">
          <span><i></i>5h ${t('resets')}</span>
          <strong>${primaryReset}</strong>
        </div>
        <div class="legend-row inner">
          <span><i></i>7d ${t('resets')}</span>
          <strong>${secondaryReset}</strong>
        </div>
        <div class="quota-foot">
          ${durationLabel(primary?.windowDurationMins)} / ${durationLabel(secondary?.windowDurationMins)}
        </div>
      </div>
    </section>
  `;
}

function renderSplitRows(parts) {
  return `
    <div class="split-list">
      <div><span class="dot input"></span>${t('input')}</div><strong>${formatTokens(parts.input)}</strong>
      <div><span class="dot cached"></span>${t('cached')}</div><strong>${formatTokens(parts.cached)}</strong>
      <div><span class="dot output"></span>${t('output')}</div><strong>${formatTokens(parts.output)}</strong>
    </div>
  `;
}

function renderTokenCard(title, iconName, usage, fallbackTokens = 0) {
  const parts = tokenParts(usage);
  const total = tokensFromUsage(usage, fallbackTokens);
  return `
    <section class="token-card glass-panel">
      <div class="token-head">
        <div class="token-title">${icon(iconName)}<span>${title}</span></div>
        <strong class="cost-value">${formatCost(usage?.estimatedCostUSD)}</strong>
      </div>
      <div class="token-value">${formatTokens(total)}</div>
      <div class="stacked-bar" title="${t('details')}">
        <span class="bar-input" style="width:${widthPercent(parts.input, parts.total)}%"></span>
        <span class="bar-cached" style="width:${widthPercent(parts.cached, parts.total)}%"></span>
        <span class="bar-output" style="width:${widthPercent(parts.output, parts.total)}%"></span>
      </div>
      ${renderSplitRows(parts)}
    </section>
  `;
}

function renderWoolProgress(detailed = {}) {
  const todayCost = Number(detailed.today?.estimatedCostUSD || 0);
  const weekCost = Number(detailed.sevenDay?.estimatedCostUSD || 0);
  const monthCost = Number(detailed.month?.estimatedCostUSD || 0);
  const visualCap = Math.max(1000, todayCost, weekCost, monthCost);
  const referenceCap = Math.max(46500, todayCost, weekCost, monthCost);
  const progress = widthPercent(todayCost, visualCap);
  const tiers = [
    { label: 'Plus', position: 7 },
    { label: 'Pro100', position: 24 },
    { label: 'Pro200', position: 56 }
  ];
  return `
    <section class="wool-card glass-panel">
      <div class="section-title compact">
        <span>${icon('wool')}${t('wool')}</span>
        <strong>${formatCost(todayCost)} <em>/ ${formatCompactCost(referenceCap)}</em></strong>
      </div>
      <div class="wool-track">
        <span class="wool-fill" style="width:${progress}%"></span>
        ${tiers.map((tier) => `
          <i class="wool-marker" style="left:${tier.position}%">
            <b></b><small>${tier.label}</small>
          </i>
        `).join('')}
      </div>
      <div class="wool-meta">
        <span class="wool-legend"><i class="dot input"></i>Plus <i class="dot cached"></i>Pro100 <i class="dot pro200"></i>Pro200</span>
        <span>${t('referenceCap')} ${formatCompactCost(referenceCap)}</span>
      </div>
    </section>
  `;
}

function renderHero(snapshot) {
  const local = snapshot.local || {};
  const detailed = local.detailedUsage || {};
  return `
    <section class="hero-grid">
      ${renderQuotaGauge(snapshot.primary, snapshot.secondary)}
      <div class="hero-right">
        <div class="token-grid">
          ${renderTokenCard(t('today'), 'today', detailed.today, local.todayTokens)}
          ${renderTokenCard(t('seven'), 'week', detailed.sevenDay, local.sevenDayTokens)}
          ${renderTokenCard(t('lifetime'), 'total', detailed.lifetime, snapshot.cloudLifetimeTokens || local.lifetimeTokens)}
        </div>
        ${renderWoolProgress(detailed)}
      </div>
    </section>
  `;
}

function statusIcon(column) {
  const id = column.id || column.kind || '';
  if (id.includes('active')) return 'active';
  if (id.includes('pending')) return 'pending';
  if (id.includes('scheduled')) return 'scheduled';
  if (id.includes('done')) return 'done';
  if (column.title === '进行中') return 'active';
  if (column.title === '待处理') return 'pending';
  if (column.title === '定时') return 'scheduled';
  if (column.title === '完成') return 'done';
  return 'pending';
}

function normalizeTaskColumns(board) {
  const sourceColumns = board?.columns || [];
  const specs = [
    { status: 'active', title: '进行中' },
    { status: 'pending', title: '待处理' },
    { status: 'scheduled', title: '定时' },
    { status: 'done', title: '完成' }
  ];
  return specs.map((spec) => {
    const found = sourceColumns.find((column) => statusIcon(column) === spec.status);
    return found ? { ...found, title: found.title || spec.title } : { id: spec.status, title: spec.title, count: 0, items: [] };
  });
}

function taskCode(item) {
  const raw = String(item.id || item.title || 'TASK').replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return raw ? raw.toUpperCase() : 'TASK';
}

function statusBadge(status) {
  if (status === 'scheduled') return 'Cron';
  if (status === 'done') return 'Done';
  if (status === 'active') return 'Medium';
  return 'Medium';
}

function renderTaskItem(item, status = 'pending') {
  const title = escapeHtml(item.title);
  const detail = escapeHtml(item.detail || '');
  const avatar = escapeHtml((item.workspace || item.title || 'N').trim().slice(0, 1).toUpperCase());
  return `
    <button class="task-item task-item-${status}" data-open-path="${escapeHtml(item.path || '')}">
      <div class="task-top"><strong>${taskCode(item)}</strong><time>${relativeTime(item.updatedAt)}</time></div>
      <span class="task-title">${title}</span>
      <small>${detail}</small>
      <div class="task-foot"><em>${statusBadge(status)}</em><b>${avatar}</b></div>
    </button>
  `;
}

function renderTasks(board) {
  const columns = normalizeTaskColumns(board);
  return `
    <section class="board-panel glass-panel">
      <div class="section-title board-title">
        <span>${t('tasks')}</span>
        <small>${columns.reduce((sum, column) => sum + Number(column.count || 0), 0)} 事项 · ${formatTime(board?.refreshedAt)}</small>
      </div>
      <div class="task-board">
        ${columns.map((column) => {
          const status = statusIcon(column);
          return `
            <div class="task-column ${status}">
              <div class="column-head">
                <span class="column-label">${icon(status)}${escapeHtml(column.title)} <strong>${column.count || 0}</strong></span>
                <button class="more-button" type="button" tabindex="-1">${icon('more')}</button>
              </div>
              <div class="task-list">
                ${column.items?.length ? column.items.map((item) => renderTaskItem(item, status)).join('') : `<div class="task-empty">${t('noData')}</div>`}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderRecent(threads = []) {
  return `
    <section class="recent-panel glass-panel">
      <div class="section-title">
        <span>${t('recent')}</span>
        <small>${threads.length}</small>
      </div>
      <div class="recent-list">
        ${threads.length ? threads.map((thread) => `
          <button class="recent-item" data-open-path="${escapeHtml(thread.cwd || '')}">
            <span>${escapeHtml(thread.title)}</span>
            <small>${escapeHtml(thread.workspace)} · ${formatTokens(thread.tokens)} · ${relativeTime(thread.updatedAt)}</small>
          </button>
        `).join('') : `<div class="task-empty">${t('noData')}</div>`}
      </div>
    </section>
  `;
}

function renderDiagnostics(items = []) {
  return `
    <section class="diagnostics glass-panel">
      <div class="section-title">
        <span>${t('env')}</span>
        <small>${items.length}</small>
      </div>
      <ul>
        ${items.map((item) => `<li>${escapeHtml(item.message)}</li>`).join('')}
      </ul>
    </section>
  `;
}

function render() {
  const root = document.getElementById('app');
  document.body.dataset.theme = 'dark';

  if (state.loading) {
    root.innerHTML = '<div class="loading">正在加载 CodexU...</div>';
    return;
  }

  if (state.error) {
    root.innerHTML = `<div class="loading error">${escapeHtml(state.error)}</div>`;
    return;
  }

  const snapshot = state.snapshot || {};
  const local = snapshot.local || {};
  const detailed = local.detailedUsage || {};
  const accountText = snapshot.account
    ? `${snapshot.account.type}${snapshot.account.planType ? ' · ' + snapshot.account.planType : ''}`
    : t('unavailable');

  root.innerHTML = `
    <section class="window-frame">
      <header class="titlebar">
        <div class="drag-region">
          <div class="brand-row">
            <span class="app-mark">${icon('app', 'app-mark-icon')}</span>
            <div class="app-title">codexU</div>
          </div>
        </div>
        <div class="window-actions">
          <button id="refreshButton" class="window-control refresh-control" title="${t('refresh')}">${icon('refresh')}</button>
          <button id="hideButton" class="window-control close" title="关闭">${icon('close')}</button>
        </div>
      </header>

      <main class="content-scroll">
        ${renderHero(snapshot)}
        ${renderTasks(snapshot.taskBoard)}
      </main>
      <footer class="footer-status">
        <span>${t('refreshed')} ${formatTime(snapshot.refreshedAt)}</span>
      </footer>
    </section>
  `;

  bindActions();
}

function bindActions() {
  document.getElementById('refreshButton')?.addEventListener('click', refresh);
  document.getElementById('hideButton')?.addEventListener('click', () => window.codexU.windowAction('hide'));
  for (const button of document.querySelectorAll('[data-open-path]')) {
    button.addEventListener('click', () => {
      const filePath = button.getAttribute('data-open-path');
      if (filePath) window.codexU.openPath(filePath);
    });
  }
}

async function refresh() {
  state.loading = false;
  try {
    state.snapshot = await window.codexU.refreshSnapshot();
    state.error = null;
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function init() {
  try {
    const [preferences, snapshot] = await Promise.all([
      window.codexU.getPreferences(),
      window.codexU.getSnapshot()
    ]);
    state.preferences = preferences;
    state.snapshot = snapshot;
    state.loading = false;
    render();
  } catch (error) {
    state.error = error.message;
    state.loading = false;
    render();
  }
  setInterval(refresh, 60_000);
}

window.codexU.onSnapshotUpdated((snapshot) => {
  state.snapshot = snapshot;
  state.loading = false;
  render();
});

window.codexU.onPreferencesUpdated((preferences) => {
  state.preferences = preferences;
  render();
});

init();
