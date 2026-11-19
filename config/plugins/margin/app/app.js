(() => {
  'use strict';

  // Glyph constants via code points to keep source clean of raw unicode emoji ranges
  const CHECK = String.fromCodePoint(0x2713);
  const CROSS = String.fromCodePoint(0x2717);
  const CIRCLE_DOT = String.fromCodePoint(0x25CF);
  const CIRCLE_OPEN = String.fromCodePoint(0x25CB);
  const CIRCLE_DASH = String.fromCodePoint(0x25CC);
  const SQUARE = String.fromCodePoint(0x25A0);
  const EM_DASH = String.fromCodePoint(0x2014);
  const SEP = ' ' + String.fromCodePoint(0x00B7) + ' ';

  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5000;
  const PROTOCOL = '2026-01-26';
  const ID_RE = /^[0-9a-f-]{8,64}$/i;
  const isSidecar = Boolean(window.sidecar || /^https?:$|^plugin:$/.test(location.protocol));
  const urlParams = new URLSearchParams(location.search);

  const STATUS_CONFIG = {
    planning: { label: 'Planning…', dotState: 'planning' },
    working: { label: 'Working', dotState: 'working' },
    waiting_agents: { label: 'Waiting on agents', dotState: 'waiting_agents' },
    done: { label: 'Done', dotState: 'done' },
    stopped: { label: 'Stopped', dotState: 'stopped' },
    idle: { label: 'Idle', dotState: 'idle' },
    reconnecting: { label: 'Reconnecting', dotState: 'planning' },
  };

  const STANCE_MARKS = {
    fine: CHECK,
    concern: '!',
    against: CROSS,
    unsure: '?',
  };

  const CATEGORY_NAMES = {
    files: 'Files',
    memory: 'Memory',
    skills: 'Skills',
    shell: 'Shell',
    web: 'Web',
    agents: 'Agents',
    other: 'Other',
  };

  const AGENT_GLYPHS = {
    running: CIRCLE_DASH,
    waiting: CIRCLE_DASH,
    completed: CHECK,
    failed: CROSS,
    stopped: SQUARE,
    killed: SQUARE,
    planned: CIRCLE_OPEN,
    pending: CIRCLE_OPEN,
  };

  const state = {
    ov: null,
    conv: '',
    pinned: false,
    lastOk: 0,
    polling: false,
    reconnecting: false,
    etag: '',
    expandedSteps: new Set(),
    userScrolled: false,
    activeStepIndex: null,
    selectedCategory: null,
    askExpanded: false,
  };

  // Detect user manual scroll to avoid disruptive auto-scrolling
  window.addEventListener('wheel', () => { state.userScrolled = true; }, { passive: true });
  window.addEventListener('touchmove', () => { state.userScrolled = true; }, { passive: true });

  // ── MCP Apps Bridge (SEP-1865 JSON-RPC 2.0 over postMessage) ──
  let nextId = 1;
  const pending = new Map();
  const post = (msg) => window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ id, method, params });
  });
  const notify = (method, params) => post({ method, params });

  function parseColorLum(val) {
    if (!val || typeof val !== 'string') return null;
    val = val.trim();
    if (val.startsWith('#')) {
      const hex = val.length === 4 ? [...val.slice(1)].map((c) => c + c).join('') : val.slice(1);
      if (hex.length >= 6) {
        const r = parseInt(hex.slice(0, 2), 16) || 0;
        const g = parseInt(hex.slice(2, 4), 16) || 0;
        const b = parseInt(hex.slice(4, 6), 16) || 0;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      }
    }
    const rgbMatch = val.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10);
      const g = parseInt(rgbMatch[2], 10);
      const b = parseInt(rgbMatch[3], 10);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    return null;
  }

  function updateTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      return;
    }
    const cs = root.style.colorScheme || '';
    if (cs === 'dark' || cs === 'light') {
      root.dataset.theme = cs;
      return;
    }

    // Check inline variables explicitly injected on root
    const bg = root.style.getPropertyValue('--background') || root.style.getPropertyValue('--bg');
    const bgLum = parseColorLum(bg);
    if (bgLum !== null) {
      const mode = bgLum < 0.5 ? 'dark' : 'light';
      root.dataset.theme = mode;
      root.style.colorScheme = mode;
      return;
    }

    const fg = root.style.getPropertyValue('--foreground') || root.style.getPropertyValue('--fg');
    const fgLum = parseColorLum(fg);
    if (fgLum !== null) {
      const mode = fgLum > 0.5 ? 'dark' : 'light';
      root.dataset.theme = mode;
      root.style.colorScheme = mode;
      return;
    }

    // Default to system / OS color scheme preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.dataset.theme = 'dark';
      root.style.colorScheme = 'dark';
    } else {
      root.dataset.theme = 'light';
      root.style.colorScheme = 'light';
    }
  }

  function applyHost(ctx) {
    if (!ctx) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(ctx.styles?.variables ?? {})) {
      if (typeof v === 'string') root.style.setProperty(k, v);
    }
    if (ctx.theme === 'light' || ctx.theme === 'dark') {
      updateTheme(ctx.theme);
    } else {
      updateTheme();
    }
  }

  function pin(id) {
    if (typeof id === 'string' && ID_RE.test(id)) {
      state.conv = id;
      state.pinned = true;
    }
  }

  function onResult(result, fromPoll = false) {
    const sc = result?.structuredContent;
    if (!sc?.overview) return;
    if (!fromPoll) pin(sc.conversationId);
    else if (!state.pinned && !state.conv) state.conv = sc.conversationId || '';
    if (fromPoll && state.pinned && sc.conversationId !== state.conv) return;
    render(sc.overview);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (m?.type === 'theme-change') {
      if (m.payload?.cssVariables && typeof m.payload.cssVariables === 'object') {
        const root = document.documentElement;
        for (const [k, v] of Object.entries(m.payload.cssVariables)) {
          if (typeof v === 'string') root.style.setProperty(k, v);
        }
      }
      setTimeout(() => updateTheme(), 0);
      return;
    }
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.method) {
      if (m.method === 'ui/notifications/tool-input') pin(m.params?.arguments?.conversation_id);
      else if (m.method === 'ui/notifications/tool-result') onResult(m.params);
      else if (m.method === 'ui/notifications/host-context-changed') applyHost(m.params);
      if (m.id !== undefined) {
        const known = m.method === 'ping' || m.method === 'ui/resource-teardown';
        post(known ? { id: m.id, result: {} } : { id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
      }
    } else if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'request failed'));
      else p.resolve(m.result);
    }
  });

  async function connect() {
    const res = await request('ui/initialize', {
      protocolVersion: PROTOCOL,
      appInfo: { name: 'Margin', version: '0.2.0' },
      appCapabilities: {},
    });
    applyHost(res?.hostContext);
    notify('ui/notifications/initialized');
  }

  // ── Formatters ──
  function fmtElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return totalSec + 's';
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const sStr = s < 10 ? '0' + s : String(s);
    if (m < 60) return m + 'm ' + sStr + 's';
    const h = Math.floor(m / 60);
    const remM = m % 60;
    const mStr = remM < 10 ? '0' + remM : String(remM);
    return h + 'h ' + mStr + 'm';
  }

  function fmtTokens(n) {
    if (typeof n !== 'number' || isNaN(n) || n <= 0) return EM_DASH;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  const show = (id, on) => {
    const node = $(id);
    if (node) node.hidden = !on;
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };

  // ── Status & Telemetry Rendering ──
  function renderStatus(ov) {
    const row = $('status-row');
    const label = $('status-text');
    const cfg = STATUS_CONFIG[ov.status] || { label: ov.status, dotState: 'idle' };

    row.dataset.state = cfg.dotState;
    if (ov.status === 'waiting_agents' && ov.waitingAgents) {
      label.textContent = `Waiting on ${ov.waitingAgents} agent${ov.waitingAgents > 1 ? 's' : ''}`;
    } else {
      label.textContent = cfg.label;
    }

    // Step summary pill
    const pill = $('step-summary-pill');
    let summaryText = '';
    let isActive = false;
    if (ov.stepProgress?.label && (ov.stepProgress?.total ?? 0) > 0) {
      summaryText = ov.stepProgress.label;
      isActive = ov.stepProgress.active !== null;
    } else if (ov.steps && ov.steps.length > 0) {
      const total = ov.steps.length;
      const done = ov.steps.filter((s) => s.status === 'completed').length;
      const activeIdx = ov.steps.findIndex((s) => s.status === 'in_progress');
      if (activeIdx >= 0) {
        summaryText = `${done} done` + SEP + `on ${activeIdx + 1} of ${total}`;
        isActive = true;
      } else if (done === total) {
        summaryText = `${total}/${total} steps`;
      } else {
        summaryText = `${done}/${total} steps`;
      }
    }

    if (summaryText) {
      pill.hidden = false;
      pill.textContent = summaryText;
      pill.classList.toggle('active', isActive);
    } else {
      pill.hidden = true;
    }
  }

  function renderTelemetry(ov) {
    // 1. Context size telemetry
    const ctx = ov.context;
    const ctxVal = $('context-val');
    const ctxFill = $('context-fill');
    const ctxBar = $('context-bar');
    const ctxTooltip = $('context-tooltip');

    if (ctx && typeof ctx.tokens === 'number' && ctx.tokens > 0) {
      const pct = ctx.pct !== null && ctx.pct !== undefined
        ? ctx.pct
        : (ctx.maxTokens ? Math.round((ctx.tokens / ctx.maxTokens) * 100) : null);

      if (ctx.maxTokens && pct !== null) {
        ctxVal.textContent = `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.maxTokens)}` + SEP + `${pct}%`;
        const clampedPct = Math.min(Math.max(pct, 0), 100);
        ctxFill.style.width = `${clampedPct}%`;
        ctxBar.setAttribute('aria-valuenow', String(clampedPct));

        if (pct >= 85) ctxFill.style.background = 'var(--bad)';
        else if (pct >= 65) ctxFill.style.background = 'var(--warn)';
        else ctxFill.style.background = 'var(--accent)';
      } else {
        ctxVal.textContent = fmtTokens(ctx.tokens);
        ctxFill.style.width = '0%';
        ctxBar.setAttribute('aria-valuenow', '0');
      }

      const lines = [
        `Model: ${ctx.model || 'Standard'}`,
        `Total tokens: ${fmtTokens(ctx.tokens)}${ctx.maxTokens ? ` (${pct}% of ${fmtTokens(ctx.maxTokens)})` : ''}`,
      ];
      if (ctx.inputTokens) lines.push(`Input tokens: ${fmtTokens(ctx.inputTokens)}`);
      if (ctx.cacheReadTokens) lines.push(`Cache read: ${fmtTokens(ctx.cacheReadTokens)}`);
      if (ctx.outputTokens) lines.push(`Output tokens: ${fmtTokens(ctx.outputTokens)}`);
      if (ctx.source) lines.push(`Source: ${ctx.source}`);
      ctxTooltip.textContent = lines.join('\n');
    } else {
      ctxVal.textContent = EM_DASH;
      ctxFill.style.width = '0%';
      ctxBar.setAttribute('aria-valuenow', '0');
      ctxTooltip.textContent = 'Context tokens not yet reported this session';
    }

    // 2. Watchdog telemetry
    const wd = ov.watchdog;
    const wdVal = $('watchdog-val');
    const wdMeta = $('watchdog-meta');
    const wdAlert = $('watchdog-alert-badge');
    const wdTooltip = $('watchdog-tooltip');

    const isRunning = ov.status === 'planning' || ov.status === 'working' || ov.status === 'waiting_agents';
    const startIso = wd?.turnStartedAt || ov.turnStartedAt;
    const endIso = wd?.lastStepAt || ov.lastStepAt;
    const startTime = startIso ? Date.parse(startIso) : 0;
    const endTime = isRunning ? Date.now() : (endIso ? Date.parse(endIso) : Date.now());
    const elapsed = startTime > 0 ? Math.max(0, endTime - startTime) : (wd?.elapsedMs || 0);

    const stepCount = wd?.turnSteps !== undefined ? wd.turnSteps : (ov.stepCount || 0);
    const toolCount = wd?.turnTools !== undefined ? wd.turnTools : (ov.used ? Object.values(ov.used).reduce((a, b) => a + b, 0) : 0);

    if (startTime > 0 || elapsed > 0 || stepCount > 0) {
      let valStr = fmtElapsed(elapsed);
      if (stepCount > 0 && toolCount > 0) valStr += SEP + `${stepCount}s/${toolCount}t`;
      else if (stepCount > 0) valStr += SEP + `${stepCount}s`;
      wdVal.textContent = valStr || EM_DASH;

      wdMeta.textContent = isRunning ? 'Active turn' : (ov.status === 'done' ? 'Turn done' : 'Stopped');
    } else {
      wdVal.textContent = EM_DASH;
      wdMeta.textContent = 'Idle';
    }

    if (wd?.alert) {
      wdAlert.hidden = false;
      wdAlert.textContent = `! ${wd.alert.kind}`;
      wdTooltip.textContent = `Watchdog Alert: ${wd.alert.kind}\n${wd.alert.detail || 'Stall/loop threshold reached'}`;
    } else {
      wdAlert.hidden = true;
      const wdLines = [
        `Watchdog: ${isRunning ? 'Monitoring active turn' : (ov.status === 'done' ? 'Completed' : 'Idle')}`,
        `Elapsed: ${fmtElapsed(elapsed) || '0s'}`,
        `Steps: ${stepCount} · Tools: ${toolCount}`,
      ];
      if (wd?.status) wdLines.push(`Status: ${wd.status}`);
      wdTooltip.textContent = wdLines.join('\n');
    }
  }

  // ── Used Details Extraction ──
  function getUsedCategories(ov) {
    const cats = {};
    if (ov.usedDetails && typeof ov.usedDetails === 'object') {
      for (const [k, d] of Object.entries(ov.usedDetails)) {
        if (!d) continue;
        const total = (d.main || 0) + (d.agents || 0);
        if (total > 0 || (d.items && d.items.length > 0)) {
          cats[k] = {
            key: k,
            name: CATEGORY_NAMES[k] || k,
            main: d.main || 0,
            agents: d.agents || 0,
            items: Array.isArray(d.items) ? d.items : [],
          };
        }
      }
    } else {
      // Graceful fallback to ov.used + ov.files
      const files = Array.isArray(ov.files) ? ov.files : [];
      if (files.length > 0 || ov.used?.files) {
        cats.files = {
          key: 'files',
          name: CATEGORY_NAMES.files,
          main: files.length || ov.used?.files || 0,
          agents: 0,
          items: files.map((p) => ({
            name: p,
            short: p.split('/').filter(Boolean).pop() || p,
            count: 1,
            source: 'read_file',
            reader: 'main',
          })),
        };
      }
      for (const [k, count] of Object.entries(ov.used || {})) {
        if (k === 'files' || !count) continue;
        cats[k] = {
          key: k,
          name: CATEGORY_NAMES[k] || k,
          main: count,
          agents: 0,
          items: [],
        };
      }
    }
    return cats;
  }

  // ── Details Drawer / Modal (claudzilla 1:1) ──
  function openDrawer(categoryKey) {
    state.selectedCategory = categoryKey;
    renderDrawer();
    show('drawer-backdrop', true);
    show('details-drawer', true);
    $('details-drawer').focus();
  }

  function closeDrawer() {
    state.selectedCategory = null;
    show('drawer-backdrop', false);
    show('details-drawer', false);
  }

  function renderDrawer() {
    if (!state.selectedCategory || !state.ov) return;
    const cats = getUsedCategories(state.ov);
    const cat = cats[state.selectedCategory];
    if (!cat) return closeDrawer();

    $('drawer-title').textContent = cat.name;
    const totalCount = cat.main + cat.agents;
    $('drawer-count').textContent = cat.agents > 0
      ? `${totalCount} items (${cat.main} main` + SEP + `${cat.agents} agents)`
      : `${totalCount} items`;

    const body = $('drawer-body');
    body.replaceChildren();

    // Group items by reader
    const byReader = new Map();
    for (const item of cat.items) {
      const reader = item.reader || 'main';
      if (!byReader.has(reader)) byReader.set(reader, []);
      byReader.get(reader).push(item);
    }

    if (byReader.size === 0) {
      const p = el('p', 'empty-note', `Recorded ${cat.main} ${cat.name.toLowerCase()} operation${cat.main === 1 ? '' : 's'} this turn.`);
      body.append(p);
      return;
    }

    // Ensure main agent is rendered first
    const readers = [...byReader.keys()].sort((a, b) => {
      if (a === 'main' || a === 'Main agent') return -1;
      if (b === 'main' || b === 'Main agent') return 1;
      return a.localeCompare(b);
    });

    for (const r of readers) {
      const items = byReader.get(r);
      const group = el('div', 'reader-group');
      const header = el('div', 'reader-group-header');
      header.append(
        el('span', '', r === 'main' ? 'Main agent' : `Agent: ${r}`),
        el('span', 'reader-badge', `${items.length}`)
      );
      group.append(header);

      const ul = el('ul', 'reader-items');
      for (const item of items) {
        const row = el('li', 'drawer-item-row');
        const left = el('div', 'item-left');

        const isWeb = cat.key === 'web' && /^https?:\/\//i.test(item.name);
        const isFile = (cat.key === 'files' || cat.key === 'memory' || cat.key === 'skills') &&
          typeof item.name === 'string' && (item.name.startsWith('/') || cat.key === 'files');

        if (isWeb) {
          const a = el('a', 'item-link', item.name);
          a.href = item.name;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          left.append(a);
        } else {
          const nameSpan = el('span', 'item-name', item.short || item.name);
          nameSpan.title = item.name;
          left.append(nameSpan);
        }

        if (isFile) {
          row.classList.add('is-clickable');
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.title = `Click to view ${item.name} in Antigravity file viewer`;
          row.addEventListener('click', () => {
            if (window.sidecar?.ui?.toggleAuxPane) {
              window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: 'file://' + item.name });
            }
          });
          row.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              if (window.sidecar?.ui?.toggleAuxPane) {
                window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: 'file://' + item.name });
              }
            }
          });
        }

        const right = el('div', 'item-right');
        if (item.count > 1) {
          right.append(el('span', 'item-repeat-badge', `×${item.count}`));
        }
        if (item.source) {
          right.append(el('span', 'item-source-badge', item.source));
        }

        row.append(left, right);
        ul.append(row);
      }
      group.append(ul);
      body.append(group);
    }
  }

  $('drawer-close-btn').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedCategory) {
      closeDrawer();
    }
  });

  // ── Main Render Pipeline ──
  function render(ov) {
    state.ov = ov;
    updateTheme();
    renderStatus(ov);
    renderTelemetry(ov);

    // Stale / Planning Dim State (claudzilla 1:1)
    const isStalePlanning = ov.status === 'planning' && !ov.reported && Boolean(ov.previous);
    const content = $('content');
    const planningBanner = $('planning-banner');

    content.classList.toggle('is-stale', isStalePlanning);
    planningBanner.hidden = !isStalePlanning;

    // Use current intent or fall back to previous turn intent during planning
    const target = isStalePlanning ? ov.previous : ov;

    // 1. Ask Section
    const askVal = target.wants || target.ask || '';
    show('sec-ask', Boolean(askVal));
    const askEl = $('ask');
    if (askEl.textContent !== askVal) askEl.textContent = askVal;
    if (target.wants && target.ask && target.wants !== target.ask) {
      askEl.title = `You asked: ${target.ask}`;
    } else {
      askEl.title = '';
    }

    const askBtn = $('ask-toggle-btn');
    askEl.classList.toggle('open', state.askExpanded);
    askEl.classList.toggle('clamp', !state.askExpanded);
    askEl.setAttribute('aria-expanded', String(state.askExpanded));
    askBtn.textContent = state.askExpanded ? 'Less' : 'More';
    askBtn.hidden = !(state.askExpanded || askEl.scrollHeight > askEl.clientHeight + 1);

    // 2. Take Section
    const take = target.take;
    show('sec-take', Boolean(take));
    if (take) {
      const chip = $('take-chip');
      const glyph = $('take-glyph');
      const label = $('take-label');
      const why = $('take-why');

      const stance = take.stance || 'unsure';
      chip.dataset.stance = stance;
      glyph.textContent = take.mark || STANCE_MARKS[stance] || CHECK;
      label.textContent = take.label || stance;
      why.textContent = take.why || '';
    }

    // 3. Plan Section
    const steps = target.steps || [];
    show('sec-plan', steps.length > 0);
    if (steps.length > 0) {
      const total = steps.length;
      const done = steps.filter((s) => s.status === 'completed').length;
      const inProgressIdx = steps.findIndex((s) => s.status === 'in_progress');
      const pct = Math.round((done / total) * 100);

      const planSummary = $('plan-summary');
      if (!isStalePlanning && ov.stepProgress?.label && (ov.stepProgress?.total ?? 0) > 0) {
        planSummary.textContent = ov.stepProgress.label;
      } else if (inProgressIdx >= 0) {
        planSummary.textContent = `${done} done` + SEP + `on ${inProgressIdx + 1} of ${total}`;
      } else {
        planSummary.textContent = `${done}/${total} steps`;
      }

      $('plan-fill').style.width = `${pct}%`;
      $('plan-bar').setAttribute('aria-valuenow', String(pct));

      let activeStepEl = null;

      $('steps').replaceChildren(...steps.map((s, idx) => {
        const stepNum = s.index || (idx + 1);
        const li = el('li', 'step-row');
        li.dataset.status = s.status;

        const mainDiv = el('div', 'step-main');
        const glyphSpan = el('span', 'step-glyph');
        if (s.status === 'completed') glyphSpan.textContent = CHECK;
        else if (s.status === 'in_progress') glyphSpan.textContent = CIRCLE_DOT;
        else glyphSpan.textContent = CIRCLE_OPEN;

        const contentDiv = el('div', 'step-content');
        const headerLine = el('div', 'step-header-line');
        const badge = el('span', 'step-index-badge');
        if (s.status === 'in_progress') badge.textContent = `Step ${stepNum}` + SEP + 'Now';
        else badge.textContent = `#${stepNum}`;

        headerLine.append(badge);

        const textSpan = el('span', 'step-text', s.text);
        contentDiv.append(headerLine, textSpan);
        mainDiv.append(glyphSpan, contentDiv);
        li.append(mainDiv);

        if (s.status === 'in_progress') {
          activeStepEl = li;
        }

        // Nested subagents / swarm workers
        const agents = s.agents;
        if (Array.isArray(agents) && agents.length > 0) {
          const isExpanded = state.expandedSteps.has(stepNum);
          const visibleAgents = isExpanded ? agents : agents.slice(0, 3);

          const ul = el('ul', 'agent-tree');
          visibleAgents.forEach((ag, aIdx) => {
            const isLast = aIdx === visibleAgents.length - 1;
            const agRow = el('li', 'agent-row');
            const branch = el('span', 'tree-branch', isLast && agents.length <= 3 ? '└─' : '├─');
            const agGlyph = el('span', 'agent-glyph', AGENT_GLYPHS[ag.status] || CIRCLE_DASH);
            agGlyph.dataset.status = ag.status || 'running';
            agGlyph.title = `Status: ${ag.status}`;

            const agName = el('span', 'agent-name', ag.name);
            const agDesc = el('span', 'agent-desc', ag.description || '');
            agDesc.title = ag.description || '';

            agRow.append(branch, agGlyph, agName, agDesc);
            if (ag.model || ag.type) {
              const fullModel = ag.model || ag.type;
              let disp = fullModel;
              if (disp.startsWith('gemini-')) disp = disp.slice(7);
              if (disp.endsWith('-worker-agy')) disp = disp.slice(0, -11);
              const tag = el('span', 'agent-tag', disp);
              tag.title = `Type: ${ag.type || 'agent'}${SEP}Model: ${ag.model || 'default'}`;
              agRow.append(tag);
            }
            ul.append(agRow);
          });
          li.append(ul);

          if (agents.length > 3) {
            const toggleBtn = el('button', 'agents-toggle-btn');
            toggleBtn.type = 'button';
            toggleBtn.textContent = isExpanded
              ? 'Show less'
              : `Show ${agents.length - 3} more agents`;
            toggleBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (state.expandedSteps.has(stepNum)) state.expandedSteps.delete(stepNum);
              else state.expandedSteps.add(stepNum);
              render(state.ov);
            });
            li.append(toggleBtn);
          }
        }

        return li;
      }));

      // Auto-scroll active task into view unless user scrolled manually
      if (activeStepEl) {
        if (state.activeStepIndex !== inProgressIdx) {
          state.activeStepIndex = inProgressIdx;
          state.userScrolled = false;
        }
        if (!state.userScrolled) {
          activeStepEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    }

    // 4. Verdict Section
    show('sec-verdict', Boolean(target.verdict));
    if (target.verdict) {
      $('verdict-icon').textContent = CHECK;
      $('verdict').textContent = target.verdict;
    }

    // 5. Used Section
    const cats = getUsedCategories(ov);
    const catKeys = Object.keys(cats);
    show('sec-used', catKeys.length > 0);

    const usedList = $('used-list');
    usedList.replaceChildren(...catKeys.map((k) => {
      const cat = cats[k];
      const card = el('button', 'used-card');
      card.type = 'button';
      card.setAttribute('aria-haspopup', 'dialog');

      const left = el('div', 'used-card-left');
      const name = el('span', 'used-cat-name', cat.name);
      const count = el('span', 'used-count-pill', String(cat.main));
      left.append(name, count);
      if (cat.agents > 0) {
        left.append(el('span', 'used-agent-pill', `+${cat.agents}`));
      }

      const right = el('div', 'used-card-right');
      if (cat.items && cat.items.length > 0) {
        const sortedItems = [...cat.items].sort((a, b) => {
          const aMain = a.reader === 'main' || a.reader === 'Main agent';
          const bMain = b.reader === 'main' || b.reader === 'Main agent';
          if (aMain && !bMain) return -1;
          if (!aMain && bMain) return 1;
          return 0;
        });
        const preview = sortedItems.slice(0, 3).map((it) => it.short || it.name).join(', ');
        right.append(el('span', 'used-preview-text', preview));
      }
      right.append(el('span', 'used-chevron', '›'));

      card.append(left, right);
      card.addEventListener('click', () => openDrawer(k));
      return card;
    }));

    // If drawer is currently open, refresh its contents with latest poll data
    if (state.selectedCategory) {
      renderDrawer();
    }

    // 6. Empty / Status Note
    const note = $('empty-note');
    if (!ov.ask && !ov.wants) {
      note.hidden = false;
      note.textContent = 'Send a message to start. The overview fills in as the agent works.';
    } else if (!ov.reported && ov.status !== 'done' && !ov.previous) {
      note.hidden = false;
      note.textContent = ov.status === 'stopped'
        ? 'The agent did not report a reading or plan this turn.'
        : 'Waiting for the agent to report its reading and plan.';
    } else {
      note.hidden = true;
    }
  }

  // ── Ask Expand Handler ──
  function toggleAsk() {
    state.askExpanded = !state.askExpanded;
    const askEl = $('ask');
    const askBtn = $('ask-toggle-btn');
    askEl.classList.toggle('open', state.askExpanded);
    askEl.classList.toggle('clamp', !state.askExpanded);
    askEl.setAttribute('aria-expanded', String(state.askExpanded));
    askBtn.textContent = state.askExpanded ? 'Less' : 'More';
    askBtn.hidden = !(state.askExpanded || askEl.scrollHeight > askEl.clientHeight + 1);
  }

  $('ask').addEventListener('click', toggleAsk);
  $('ask').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleAsk();
    }
  });
  $('ask-toggle-btn').addEventListener('click', toggleAsk);

  // ── Polling & Lifecycle ──
  async function pollSidecar() {
    if (state.polling) return;
    state.polling = true;
    try {
      const q = new URLSearchParams({ etag: state.etag });
      const conv = window.sidecar?.conversationId || urlParams.get('conversationId') || '';
      if (conv) q.set('conversationId', conv);
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/overview?${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      state.lastOk = Date.now();
      const wasReconnecting = state.reconnecting;
      state.reconnecting = false;
      if (r.overview) {
        state.etag = r.etag || '';
        render(r.overview);
      } else if (r.unchanged) {
        if (wasReconnecting && state.ov) renderStatus(state.ov);
      } else {
        $('status-text').textContent = 'Idle';
        $('empty-note').hidden = false;
        $('empty-note').textContent = 'Send a message to start. The overview fills in as the agent works.';
      }
    } catch {
      state.etag = '';
      if (state.lastOk > 0 && Date.now() - state.lastOk > 12000) {
        state.reconnecting = true;
        renderStatus({ ...(state.ov || {}), status: 'reconnecting' });
      }
    } finally {
      state.polling = false;
    }
  }

  async function poll() {
    if (isSidecar) return pollSidecar();
    if (state.polling) return;
    state.polling = true;
    try {
      const r = await request('tools/call', {
        name: 'margin_overview',
        arguments: state.conv ? { conversation_id: state.conv } : {},
      });
      state.lastOk = Date.now();
      state.reconnecting = false;
      onResult(r, true);
    } catch {
      if (state.lastOk > 0 && Date.now() - state.lastOk > 12000) {
        state.reconnecting = true;
        renderStatus({ ...(state.ov || {}), status: 'reconnecting' });
      }
    } finally {
      state.polling = false;
    }
  }

  // Live 1s client timer updates for status & watchdog ticker
  setInterval(() => {
    if (state.ov && !state.reconnecting) {
      renderStatus(state.ov);
      renderTelemetry(state.ov);
    }
  }, 1000);

  updateTheme();
  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => updateTheme());
    } catch {}
  }

  if (isSidecar) {
    poll();
    setInterval(poll, POLL_MS);
  } else {
    connect().then(() => {
      setTimeout(poll, 400);
      setInterval(poll, POLL_MS);
    }).catch(() => {
      $('status-text').textContent = 'Not connected';
    });
  }
})();
