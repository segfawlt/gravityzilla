(() => {
  'use strict';

  const CHECK = String.fromCodePoint(0x2713);
  const CROSS = String.fromCodePoint(0x2717);
  const CIRCLE_DOT = String.fromCodePoint(0x25CF);
  const CIRCLE_OPEN = String.fromCodePoint(0x25CB);
  const CIRCLE_DASH = String.fromCodePoint(0x25CC);
  const HALF_CIRCLE = String.fromCodePoint(0x25D0);
  const SQUARE = String.fromCodePoint(0x25A0);
  const ELLIPSIS = String.fromCodePoint(0x2026);
  const EM_DASH = String.fromCodePoint(0x2014);
  const ARROW_UP_RIGHT = String.fromCodePoint(0x2197);
  const SEP = ' ' + String.fromCodePoint(0x00B7) + ' ';

  // Watchdog states and alert kinds as words; anything unmapped draws as reported.
  const WD_WORD = { ok: 'no alerts', stall: 'stalled', loop: 'looping', off: 'off' };
  // Footer tiers from the pane width, measured on the footer: full phrases at 380px,
  // trimmed at 280px (watchdog keeps steps), time-only watchdog below 200px.
  const sizeTier = (w) => (w >= 380 ? 'full' : w >= 280 ? 'mid' : 'tiny');

  const $ = (id) => document.getElementById(id);
  const POLL_MS = 1000;
  const PROTOCOL = '2026-01-26';
  const ID_RE = /^[0-9a-f-]{8,64}$/i;
  const isSidecar = Boolean(window.sidecar || /^https?:$|^plugin:$/.test(location.protocol));
  const urlParams = new URLSearchParams(location.search);

  const STANCE_MARKS = {
    fine: CHECK,
    concern: '!',
    against: CROSS,
    unsure: '?',
  };

  const OUTCOME_MARKS = {
    clear: CHECK,
    needs_input: '?',
    caveats: '!',
    blocked: CROSS,
  };

  const CATEGORY_NAMES = {
    files: 'files',
    memory: 'memory',
    learnings: 'learnings',
    skills: 'skills',
    shell: 'shell',
    web: 'web',
    agents: 'agents',
    other: 'other',
  };

  const DRAWER_TITLES = {
    files: 'Files',
    memory: 'Memory',
    learnings: 'Learnings',
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
    drawerMode: null,
    selectedCategory: null,
    memoryDoc: null,
    paneW: 0,
  };

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

  const MARGIN_PROTECTED_VARS = new Set(['--muted', '--faint', '--fg-muted', '--fg-faint']);

  function applyHostVariables(vars) {
    if (!vars || typeof vars !== 'object') return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) {
      if (MARGIN_PROTECTED_VARS.has(k)) {
        root.style.removeProperty(k);
        continue;
      }
      if (typeof v === 'string') root.style.setProperty(k, v);
    }
  }

  function updateTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      return;
    }

    const bg = root.style.getPropertyValue('--background')
      || root.style.getPropertyValue('--color-background-primary')
      || root.style.getPropertyValue('--bg');
    const bgLum = parseColorLum(bg);
    if (bgLum !== null) {
      const mode = bgLum < 0.5 ? 'dark' : 'light';
      root.dataset.theme = mode;
      root.style.colorScheme = mode;
      return;
    }

    const fg = root.style.getPropertyValue('--foreground')
      || root.style.getPropertyValue('--color-text-primary')
      || root.style.getPropertyValue('--fg');
    const fgLum = parseColorLum(fg);
    if (fgLum !== null) {
      const mode = fgLum > 0.5 ? 'dark' : 'light';
      root.dataset.theme = mode;
      root.style.colorScheme = mode;
      return;
    }

    const mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
  }

  function applyHost(ctx) {
    if (!ctx) return;
    applyHostVariables(ctx.styles?.variables);
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
      applyHostVariables(m.payload?.cssVariables);
      const theme = m.payload?.theme;
      setTimeout(() => updateTheme(theme), 0);
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

  function fmtClock(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const hh = d.getHours();
    const mm = d.getMinutes();
    return `${hh < 10 ? '0' + hh : hh}:${mm < 10 ? '0' + mm : mm}`;
  }

  function shortModel(raw) {
    let disp = String(raw || '').trim();
    if (!disp) return '';
    if (disp.startsWith('gemini-')) disp = disp.slice(7);
    if (disp.endsWith('-worker-agy')) disp = disp.slice(0, -11);
    return disp;
  }

  function splitPath(fullPath, shortName) {
    const raw = String(fullPath || '');
    const slash = raw.lastIndexOf('/');
    if (slash > 0) {
      const base = raw.slice(slash + 1);
      const dirRaw = raw.slice(0, slash + 1);
      const segments = dirRaw.split('/').filter(Boolean);
      const prefix = segments.length > 3
        ? `/${segments[0]}/${ELLIPSIS}/${segments.slice(-2).join('/')}/`
        : dirRaw;
      return { dir: prefix, base };
    }
    return { dir: '', base: shortName || raw };
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

  function setEmptyNote(visible, title = '', sub = '') {
    const note = $('empty-note');
    if (!note) return;
    note.hidden = !visible;
    if (visible) {
      note.replaceChildren(
        el('span', 'empty-title', title),
        el('span', 'empty-sub', sub),
      );
    }
  }

  // ── Status & Unified Bottom HUD Rendering ──
  function renderStatus(ov) {
    const row = $('status-row');
    const glyph = $('status-glyph');
    const label = $('status-text');
    const st = ov.status || 'idle';
    const clock = fmtClock(ov.lastStepAt);
    const tier = sizeTier(state.paneW);
    // Full phrase with "at" when wide, bare words with the clock when tight, the word alone when tiny.
    const stamp = tier === 'full' ? (clock ? ` at ${clock}` : '') : tier === 'mid' ? (clock ? ` ${clock}` : '') : '';

    row.dataset.state = st === 'reconnecting' ? 'planning' : st;
    if (st === 'planning') {
      glyph.textContent = HALF_CIRCLE;
      label.textContent = `planning${ELLIPSIS}`;
    } else if (st === 'working') {
      glyph.textContent = HALF_CIRCLE;
      label.textContent = tier === 'tiny' ? 'working' : `working${ELLIPSIS}`;
    } else if (st === 'waiting_agents') {
      const n = ov.waitingAgents || 0;
      glyph.textContent = CIRCLE_DASH;
      label.textContent = n > 0
        ? (tier === 'full' ? `waiting · ${n} agent${n === 1 ? '' : 's'}` : tier === 'mid' ? `waiting (${n})` : 'waiting')
        : 'waiting';
    } else if (st === 'done') {
      const oKind = ov.outcome?.kind || 'clear';
      if (oKind === 'needs_input') {
        row.dataset.state = 'needs_input';
        glyph.textContent = '?';
        label.textContent = `needs input${stamp}`;
      } else if (oKind === 'caveats') {
        row.dataset.state = 'caveats';
        glyph.textContent = '!';
        label.textContent = `caveats${stamp}`;
      } else if (oKind === 'blocked') {
        row.dataset.state = 'blocked';
        glyph.textContent = CROSS;
        label.textContent = `blocked${stamp}`;
      } else {
        glyph.textContent = CHECK;
        label.textContent = `done${stamp}`;
      }
    } else if (st === 'stopped') {
      glyph.textContent = SQUARE;
      label.textContent = `stopped${stamp}`;
    } else if (st === 'reconnecting') {
      glyph.textContent = HALF_CIRCLE;
      label.textContent = `reconnecting${ELLIPSIS}`;
    } else {
      glyph.textContent = CIRCLE_OPEN;
      label.textContent = st;
    }

    const pill = $('step-summary-pill');
    const steps = Array.isArray(ov.steps) ? ov.steps : [];
    let summaryText = '';
    let isActive = false;

    if (steps.length > 0) {
      const total = steps.length;
      const done = steps.filter((s) => s.status === 'completed').length;
      summaryText = `${done}/${total} steps`;
      isActive = st === 'working' || st === 'planning';
    } else if (st === 'planning' && !ov.waitingAgents) {
      summaryText = `${ELLIPSIS} steps`;
      isActive = true;
    }

    if (summaryText) {
      pill.hidden = false;
      pill.textContent = summaryText;
      pill.classList.toggle('active', isActive);
    } else {
      pill.hidden = true;
    }
  }

  function telemetrySnapshot(ov) {
    const ctx = ov.context;
    let pct = null;
    if (ctx && typeof ctx.tokens === 'number' && ctx.tokens > 0) {
      pct = ctx.pct !== null && ctx.pct !== undefined
        ? ctx.pct
        : (ctx.maxTokens ? Math.round((ctx.tokens / ctx.maxTokens) * 100) : null);
    }

    const wd = ov.watchdog;
    const isRunning = ov.status === 'planning' || ov.status === 'working' || ov.status === 'waiting_agents';
    const startIso = wd?.turnStartedAt || ov.turnStartedAt;
    const endIso = wd?.lastStepAt || ov.lastStepAt;
    const startTime = startIso ? Date.parse(startIso) : 0;
    const endTime = isRunning ? Date.now() : (endIso ? Date.parse(endIso) : Date.now());
    const elapsed = startTime > 0 ? Math.max(0, endTime - startTime) : (wd?.elapsedMs || 0);
    const stepCount = wd?.turnSteps !== undefined ? wd.turnSteps : (ov.stepCount || 0);
    const toolCount = wd?.turnTools !== undefined ? wd.turnTools : (ov.used ? Object.values(ov.used).reduce((a, b) => a + b, 0) : 0);

    return { ctx, pct, wd, isRunning, elapsed, stepCount, toolCount };
  }

  function renderTelemetry(ov) {
    const snap = telemetrySnapshot(ov);
    const { ctx, pct, wd, elapsed, stepCount, toolCount } = snap;

    const ctxVal = $('context-val');
    const ctxFill = $('context-fill');
    const ctxBar = $('context-bar');
    const ctxChip = $('context-chip');

    if (ctx && typeof ctx.tokens === 'number' && ctx.tokens > 0) {
      if (ctx.maxTokens && pct !== null) {
        ctxVal.textContent = `${fmtTokens(ctx.tokens)}${SEP}${pct}%`;
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
      ctxChip.title = `${ctx.model || 'Standard'}: ${fmtTokens(ctx.tokens)} tokens (click for details)`;
    } else {
      ctxVal.textContent = EM_DASH;
      ctxFill.style.width = '0%';
      ctxBar.setAttribute('aria-valuenow', '0');
      ctxChip.title = 'Click to view session telemetry';
    }

    const wdVal = $('watchdog-val');
    const wdAlert = $('watchdog-alert-badge');
    const wdChip = $('watchdog-chip');

    if (elapsed > 0 || stepCount > 0 || wd?.turnStartedAt || ov.turnStartedAt) {
      let valStr = fmtElapsed(elapsed) || '0s';
      if (state.paneW >= 200 && stepCount > 0) valStr += `${SEP}${stepCount} steps`;
      if (state.paneW >= 280 && toolCount > 0) valStr += `${SEP}${toolCount} tools`;
      wdVal.textContent = valStr;
    } else {
      wdVal.textContent = EM_DASH;
    }

    if (wd?.alert) {
      wdAlert.hidden = false;
      wdAlert.textContent = `! ${WD_WORD[wd.alert.kind] || wd.alert.kind}`;
      wdChip.title = `Watchdog alert: ${WD_WORD[wd.alert.kind] || wd.alert.kind} (click for details)`;
    } else {
      wdAlert.hidden = true;
      wdChip.title = 'Click to view watchdog and context breakdown';
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
            title: DRAWER_TITLES[k] || k,
            main: d.main || 0,
            agents: d.agents || 0,
            items: Array.isArray(d.items) ? d.items : [],
          };
        }
      }
    } else {
      const files = Array.isArray(ov.files) ? ov.files : [];
      if (files.length > 0 || ov.used?.files) {
        cats.files = {
          key: 'files',
          name: CATEGORY_NAMES.files,
          title: DRAWER_TITLES.files,
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
          title: DRAWER_TITLES[k] || k,
          main: count,
          agents: 0,
          items: [],
        };
      }
    }
    return cats;
  }

  function toFileUri(absPath) {
    const norm = String(absPath || '').replace(/\\/g, '/');
    if (!norm.startsWith('/')) return 'file://' + norm;
    return 'file://' + norm.split('/').map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg))).join('/');
  }

  // ── Inspection Drawer (topics / used / telemetry / memory-doc) ──
  function openDrawer(categoryKey) {
    state.drawerMode = 'used';
    state.selectedCategory = categoryKey;
    state.memoryDoc = null;
    renderDrawer();
    show('drawer-backdrop', true);
    show('details-drawer', true);
    $('details-drawer').focus();
  }

  function openTopicsDrawer() {
    state.drawerMode = 'topics';
    state.selectedCategory = null;
    state.memoryDoc = null;
    renderDrawer();
    show('drawer-backdrop', true);
    show('details-drawer', true);
    $('details-drawer').focus();
  }

  function openTelemetryDrawer() {
    state.drawerMode = 'telemetry';
    state.selectedCategory = null;
    state.memoryDoc = null;
    renderDrawer();
    show('drawer-backdrop', true);
    show('details-drawer', true);
    $('details-drawer').focus();
  }

  function closeDrawer() {
    state.drawerMode = null;
    state.selectedCategory = null;
    state.memoryDoc = null;
    show('drawer-backdrop', false);
    show('details-drawer', false);
  }

  function appendInlineMd(parent, text) {
    const codeParts = String(text || '').split(/(`[^`]+`)/g);
    for (const cp of codeParts) {
      if (!cp) continue;
      if (cp.startsWith('`') && cp.endsWith('`') && cp.length > 2) {
        parent.append(el('code', 'mem-doc-code', cp.slice(1, -1)));
        continue;
      }
      const boldParts = cp.split(/(\*\*[^*]+\*\*)/g);
      for (const bp of boldParts) {
        if (!bp) continue;
        if (bp.startsWith('**') && bp.endsWith('**') && bp.length > 4) {
          parent.append(el('strong', '', bp.slice(2, -2)));
        } else {
          parent.append(document.createTextNode(bp));
        }
      }
    }
  }

  function renderMarkdownDom(container, mdText) {
    let body = String(mdText || '').replace(/\r\n/g, '\n');
    if (body.startsWith('---\n')) {
      const endIdx = body.indexOf('\n---\n', 4);
      if (endIdx > 0) body = body.slice(endIdx + 5);
    }
    const lines = body.split('\n');
    let inCode = false;
    let codeLines = [];
    let listEl = null;
    const flushList = () => {
      if (listEl) {
        container.append(listEl);
        listEl = null;
      }
    };

    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        flushList();
        if (inCode) {
          const pre = el('pre', 'mem-doc-pre');
          pre.append(el('code', '', codeLines.join('\n')));
          container.append(pre);
          codeLines = [];
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const t = line.trim();
      if (!t) {
        flushList();
        continue;
      }
      if (/^---+$/.test(t)) {
        flushList();
        container.append(el('hr', 'mem-doc-rule'));
        continue;
      }
      const hm = /^(#{1,4})\s+(.+)$/.exec(t);
      if (hm) {
        flushList();
        const h = el('h4', 'mem-doc-h');
        appendInlineMd(h, hm[2]);
        container.append(h);
        continue;
      }
      const lm = /^(?:[-•*]|\d+\.)\s+(.+)$/.exec(t);
      if (lm) {
        if (!listEl) listEl = el('ul', 'mem-doc-list');
        const li = el('li', '');
        appendInlineMd(li, lm[1]);
        listEl.append(li);
        continue;
      }
      flushList();
      const p = el('p', 'mem-doc-p');
      appendInlineMd(p, t);
      container.append(p);
    }
    flushList();
    if (inCode && codeLines.length) {
      const pre = el('pre', 'mem-doc-pre');
      pre.append(el('code', '', codeLines.join('\n')));
      container.append(pre);
    }
  }

  function openMemoryTab(item, categoryKey) {
    const catKey = categoryKey || state.selectedCategory || 'memory';
    const fp = item?.filePath;
    if (!fp) {
      openMemoryPeek(item, catKey);
      return;
    }
    const uri = toFileUri(fp);
    if (window.sidecar?.ui?.toggleAuxPane && window.parent && window.parent !== window) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
      return;
    }
    if (!isSidecar) {
      request('com.google.antigravity/toggle-aux-pane', { tabType: 'fileView', uri })
        .then((res) => { if (res?.isError) openMemoryPeek(item, catKey); })
        .catch(() => openMemoryPeek(item, catKey));
      return;
    }
    window.open(`/api/memory-view?path=${encodeURIComponent(fp)}`, '_blank', 'noopener,noreferrer');
  }

  async function openMemoryPeek(item, categoryKey) {
    const catKey = categoryKey || state.selectedCategory || 'memory';
    const noun = catKey === 'learnings' ? 'learning' : 'memory';
    state.drawerMode = 'memory-doc';
    state.selectedCategory = catKey;
    state.memoryDoc = {
      item,
      loading: Boolean(item?.filePath && isSidecar),
      content: '',
      error: '',
    };
    renderDrawer();
    show('drawer-backdrop', true);
    show('details-drawer', true);
    $('details-drawer').focus();

    if (!item?.filePath) return;
    if (!isSidecar) {
      state.memoryDoc.loading = false;
      state.memoryDoc.content = item.summary || '';
      renderDrawer();
      return;
    }
    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(`/api/memory-doc?path=${encodeURIComponent(item.filePath)}`);
      const data = await res.json();
      if (state.drawerMode !== 'memory-doc' || state.memoryDoc?.item !== item) return;
      state.memoryDoc.loading = false;
      if (data?.ok) state.memoryDoc.content = data.content || '';
      else state.memoryDoc.error = data?.error || `Could not load ${noun}.`;
    } catch (err) {
      if (state.drawerMode !== 'memory-doc' || state.memoryDoc?.item !== item) return;
      state.memoryDoc.loading = false;
      state.memoryDoc.error = err?.message || `Could not load ${noun}.`;
    }
    renderDrawer();
  }

  function addTelemetryRow(section, keyText, valText, asCode = false) {
    const row = el('div', 'tl-row');
    row.append(el('span', 'tl-key', keyText));
    const valNode = asCode ? el('code', 'tl-val', valText) : el('span', 'tl-val', valText);
    row.append(valNode);
    section.append(row);
  }

  function bindRowActivation(row, handler) {
    row.classList.add('is-clickable');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', handler);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        handler();
      }
    });
  }

  function buildMemoryGroup(heading, items, showHeader, categoryKey = 'memory') {
    const group = el('div', 'reader-group');
    if (showHeader) group.append(el('div', 'reader-group-header', `${heading} (${items.length})`));
    const ul = el('ul', 'reader-items');
    for (const item of items) {
      const row = el('li', 'drawer-item-row memory-item-row');
      const head = el('div', 'memory-item-head');
      const left = el('div', 'item-left');

      const codeEl = el('code', 'item-path');
      codeEl.title = item.filePath || item.name;
      if (item.filePath && item.filePath.includes('/')) {
        const { dir, base } = splitPath(item.filePath, item.short);
        if (dir) codeEl.append(el('span', 'item-dir', dir));
        codeEl.append(el('span', 'item-base', base));
      } else {
        codeEl.append(el('span', 'item-base', item.short || item.name));
      }
      left.append(codeEl);
      if (item.filePath) left.append(el('span', 'item-link-glyph', ARROW_UP_RIGHT));

      const right = el('div', 'item-right');
      if (item.filePath) {
        const peekBtn = el('button', 'item-peek-btn', 'peek');
        peekBtn.type = 'button';
        peekBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openMemoryPeek(item, categoryKey);
        });
        right.append(peekBtn);
      }
      if (item.count > 1) right.append(el('span', 'item-repeat', `×${item.count}`));
      const act = item.action || item.source || '';
      if (act) {
        const actSpan = el('span', 'item-action', act);
        actSpan.dataset.group = item.group === 'saved' ? 'saved' : 'read';
        right.append(actSpan);
      }
      if (item.earlier) right.append(el('span', 'item-earlier', 'earlier'));

      head.append(left, right);
      row.append(head);
      if (item.summary) row.append(el('div', 'item-summary', item.summary));

      row.title = item.filePath
        ? `Open ${item.filePath} in new tab`
        : (categoryKey === 'learnings' ? 'View learning' : 'View memory');
      bindRowActivation(row, () => openMemoryTab(item, categoryKey));
      ul.append(row);
    }
    group.append(ul);
    return group;
  }

  function renderDrawer() {
    if (!state.ov) return closeDrawer();
    const body = $('drawer-body');
    body.replaceChildren();
    show('drawer-back-btn', state.drawerMode === 'memory-doc');
    show('drawer-open-tab-btn', state.drawerMode === 'memory-doc' && Boolean(state.memoryDoc?.item?.filePath));

    if (state.drawerMode === 'memory-doc') {
      const docState = state.memoryDoc;
      if (!docState?.item) return openDrawer(state.selectedCategory || 'memory');
      const { item } = docState;
      $('drawer-title').textContent = item.short || (state.selectedCategory === 'learnings' ? 'Learning' : 'Memory');
      $('drawer-count').textContent = [item.action, item.earlier ? 'earlier' : ''].filter(Boolean).join(SEP);
      if (item.filePath) body.append(el('code', 'mem-doc-path', item.filePath));
      if (docState.loading) {
        body.append(el('p', 'drawer-empty-note', `Loading${ELLIPSIS}`));
      } else if (docState.error) {
        body.append(el('p', 'drawer-empty-note', docState.error));
      } else if (docState.content) {
        const view = el('div', 'mem-doc-view');
        renderMarkdownDom(view, docState.content);
        body.append(view);
      } else {
        body.append(el('p', 'mem-doc-p', item.summary || item.name));
      }
      return;
    }

    if (state.drawerMode === 'topics') {
      const topics = Array.isArray(state.ov.about?.topics) ? state.ov.about.topics : [];
      if (!topics.length) return closeDrawer();
      $('drawer-title').textContent = 'Topics';
      $('drawer-count').textContent = `${topics.length} topic${topics.length === 1 ? '' : 's'}`;
      const list = el('ol', 'topic-list');
      const newestFirst = [...topics].reverse();
      newestFirst.forEach((topic, idx) => {
        const isCurrent = idx === 0;
        const li = el('li', isCurrent ? 'topic-list-item is-current' : 'topic-list-item');
        li.append(el('span', 'topic-idx', `#${topics.length - idx}`));
        if (isCurrent) li.append(el('span', 'topic-dot'));
        li.append(el('span', 'topic-text', topic));
        if (isCurrent) li.append(el('span', 'topic-current', 'current'));
        list.append(li);
      });
      body.append(list);
      return;
    }

    if (state.drawerMode === 'telemetry') {
      const snap = telemetrySnapshot(state.ov);
      const { ctx, pct, wd, isRunning, elapsed, stepCount, toolCount } = snap;

      $('drawer-title').textContent = 'Session Telemetry';
      $('drawer-count').textContent = shortModel(ctx?.model) || (isRunning ? 'active' : (state.ov.status || 'idle'));

      const groups = el('div', 'tl-groups');

      const ctxSec = el('div', 'tl-section');
      ctxSec.append(el('div', 'tl-heading', 'Context'));
      addTelemetryRow(ctxSec, 'Model', ctx?.model || 'Standard', Boolean(ctx?.model));
      const totalLine = ctx?.tokens
        ? `${fmtTokens(ctx.tokens)}${ctx.maxTokens && pct !== null ? ` (${pct}% of ${fmtTokens(ctx.maxTokens)})` : ''}`
        : EM_DASH;
      addTelemetryRow(ctxSec, 'Total tokens', totalLine);
      if (ctx?.inputTokens) addTelemetryRow(ctxSec, 'Input tokens', fmtTokens(ctx.inputTokens));
      if (ctx?.cacheReadTokens) addTelemetryRow(ctxSec, 'Cache read', fmtTokens(ctx.cacheReadTokens));
      if (ctx?.outputTokens) addTelemetryRow(ctxSec, 'Output tokens', fmtTokens(ctx.outputTokens));
      if (ctx?.source) addTelemetryRow(ctxSec, 'Source', ctx.source);
      groups.append(ctxSec);

      const wdSec = el('div', 'tl-section');
      wdSec.append(el('div', 'tl-heading', 'Watchdog'));
      const wdStateLabel = wd?.enabled === false
        ? 'Disabled'
        : (wd?.status ? (WD_WORD[wd.status] || wd.status) : (isRunning ? 'Monitoring active turn' : (state.ov.status || 'idle')));
      addTelemetryRow(wdSec, 'State', wdStateLabel);
      addTelemetryRow(wdSec, 'Elapsed', fmtElapsed(elapsed) || '0s');
      addTelemetryRow(wdSec, 'Turn steps', String(stepCount));
      addTelemetryRow(wdSec, 'Tool calls', String(toolCount));
      if (wd?.alert) {
        addTelemetryRow(wdSec, 'Alert', `${WD_WORD[wd.alert.kind] || wd.alert.kind}${wd.alert.detail ? ` — ${wd.alert.detail}` : ''}`);
      }
      groups.append(wdSec);

      body.append(groups);
      return;
    }

    if (state.drawerMode !== 'used' || !state.selectedCategory) return;
    const cats = getUsedCategories(state.ov);
    const cat = cats[state.selectedCategory];
    if (!cat) return closeDrawer();

    $('drawer-title').textContent = cat.title || cat.name;
    const totalCount = cat.main + cat.agents;
    $('drawer-count').textContent = cat.agents > 0
      ? `${totalCount} items (${cat.main} main${SEP}${cat.agents} agents)`
      : `${totalCount} items`;

    const byReader = new Map();
    for (const item of cat.items) {
      const reader = item.reader || 'main';
      if (!byReader.has(reader)) byReader.set(reader, []);
      byReader.get(reader).push(item);
    }

    if (byReader.size === 0) {
      body.append(el('p', 'drawer-empty-note', `${cat.main} ${cat.name} call${cat.main === 1 ? '' : 's'}.`));
      return;
    }

    const readers = [...byReader.keys()].sort((a, b) => {
      if (a === 'main' || a === 'Main agent') return -1;
      if (b === 'main' || b === 'Main agent') return 1;
      return a.localeCompare(b);
    });
    const showHeaders = readers.length > 1 || (readers[0] !== 'main' && readers[0] !== 'Main agent');

    if (cat.key === 'memory' || cat.key === 'learnings') {
      const mainItems = byReader.get('main') || byReader.get('Main agent') || [];
      const savedItems = mainItems.filter((it) => it.group === 'saved');
      const readItems = mainItems.filter((it) => it.group !== 'saved');
      const savedTitle = cat.key === 'memory' ? 'Captured & extracted' : 'Captured';
      if (savedItems.length > 0) {
        body.append(buildMemoryGroup(savedTitle, savedItems, true, cat.key));
        if (readItems.length > 0) body.append(buildMemoryGroup('Read', readItems, true, cat.key));
      } else if (readItems.length > 0) {
        body.append(buildMemoryGroup('Read', readItems, showHeaders, cat.key));
      }
      for (const r of readers) {
        if (r === 'main' || r === 'Main agent') continue;
        body.append(buildMemoryGroup(`@${r}`, byReader.get(r), true, cat.key));
      }
      return;
    }

    for (const r of readers) {
      const items = byReader.get(r);
      const group = el('div', 'reader-group');
      if (showHeaders) {
        const hdrText = (r === 'main' || r === 'Main agent') ? 'Main' : `@${r}`;
        group.append(el('div', 'reader-group-header', `${hdrText} (${items.length})`));
      }

      const ul = el('ul', 'reader-items');
      for (const item of items) {
        const row = el('li', 'drawer-item-row');
        const left = el('div', 'item-left');
        const isWeb = cat.key === 'web' && /^https?:\/\//i.test(item.name);
        const isFile = (cat.key === 'files' || cat.key === 'memory' || cat.key === 'skills') &&
          typeof item.name === 'string' && (item.name.startsWith('/') || cat.key === 'files');

        if (isWeb) {
          const a = el('a', 'item-link');
          a.href = item.name;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.append(
            el('span', '', item.name),
            el('span', 'item-link-glyph', ARROW_UP_RIGHT),
          );
          left.append(a);
        } else if (isFile && item.name.includes('/')) {
          const { dir, base } = splitPath(item.name, item.short);
          const codeEl = el('code', 'item-path');
          codeEl.title = item.name;
          if (dir) codeEl.append(el('span', 'item-dir', dir));
          codeEl.append(el('span', 'item-base', base));
          left.append(codeEl);
        } else {
          const codeEl = el('code', 'item-path');
          codeEl.title = item.name;
          codeEl.append(el('span', 'item-base', item.short || item.name));
          left.append(codeEl);
        }

        if (isFile) {
          row.classList.add('is-clickable');
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.title = `Open ${item.name} in Antigravity`;
          const openFile = () => {
            if (window.sidecar?.ui?.toggleAuxPane) {
              window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: toFileUri(item.name) });
            }
          };
          row.addEventListener('click', openFile);
          row.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              openFile();
            }
          });
        }

        const right = el('div', 'item-right');
        if (item.count > 1) right.append(el('span', 'item-repeat', `×${item.count}`));
        if (item.source) right.append(el('span', 'item-source', item.source));
        row.append(left, right);
        ul.append(row);
      }
      group.append(ul);
      body.append(group);
    }
  }

  $('drawer-back-btn').addEventListener('click', () => openDrawer(state.selectedCategory || 'memory'));
  $('drawer-open-tab-btn').addEventListener('click', () => {
    if (state.memoryDoc?.item) openMemoryTab(state.memoryDoc.item);
  });
  $('drawer-close-btn').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  $('topics-all-btn').addEventListener('click', openTopicsDrawer);
  $('context-chip').addEventListener('click', openTelemetryDrawer);
  $('watchdog-chip').addEventListener('click', openTelemetryDrawer);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.drawerMode) closeDrawer();
  });

  // ── Main Render Pipeline ──
  function renderAbout(ov, hasReportBlock) {
    const about = ov.about || {};
    const topics = Array.isArray(about.topics) ? about.topics : [];
    const summary = typeof about.summary === 'string' ? about.summary.trim() : '';
    const running = Boolean(about.running);
    const failed = Boolean(about.failed && !running);

    const hasAbout = Boolean(summary || topics.length > 0 || running || failed);
    show('about-group', hasAbout);
    if (!hasAbout) return false;

    const slotText = running ? `updating${ELLIPSIS}` : failed ? 'update failed' : '';
    const showSession = Boolean(summary || (!topics.length && slotText));
    const showTopic = Boolean(topics.length > 0 || (!summary && slotText));

    show('sec-session', showSession);
    if (showSession) {
      const sSlot = $('session-slot');
      sSlot.textContent = slotText;
      sSlot.hidden = !slotText;
      sSlot.classList.toggle('is-failed', failed);

      const sBody = $('session-summary');
      sBody.textContent = summary;
      sBody.hidden = !summary;
      sBody.classList.toggle('is-running', running);
    }

    show('rule-session', showSession && showTopic);

    show('sec-topic', showTopic);
    if (showTopic) {
      const tSlot = $('topic-slot');
      const slotOnTopic = !showSession && Boolean(slotText);
      tSlot.textContent = slotOnTopic ? slotText : '';
      tSlot.hidden = !slotOnTopic;
      tSlot.classList.toggle('is-failed', failed);

      show('topics-all-btn', topics.length > 1);

      const latest = topics.length ? topics[topics.length - 1] : '';
      const tBody = $('topic-latest');
      tBody.textContent = latest;
      tBody.hidden = !latest;
      tBody.classList.toggle('is-running', running);
    }

    show('rule-topic', (showSession || showTopic) && hasReportBlock);
    return true;
  }

  function render(ov) {
    state.ov = ov;
    updateTheme();
    renderStatus(ov);
    renderTelemetry(ov);

    const isTurnActive = ov.status === 'working' || ov.status === 'planning' || ov.status === 'waiting_agents';
    const isFullStalePlanning =
      ov.status === 'planning' &&
      !ov.wants &&
      !ov.take &&
      !(ov.steps && ov.steps.length) &&
      Boolean(ov.previous);

    let askVal = '';
    let askStale = false;
    let take = null;
    let takeStale = false;
    let steps = ov.steps || [];
    let outcome = ov.outcome || null;

    if (isFullStalePlanning) {
      askVal = ov.previous.wants || '';
      take = ov.previous.take || null;
      steps = ov.previous.steps || [];
      outcome = ov.previous.outcome || null;
    } else {
      if (ov.wants) {
        askVal = ov.wants;
      } else if (isTurnActive && !ov.take && ov.previous && ov.previous.wants) {
        askVal = ov.previous.wants;
        askStale = true;
      }
      if (ov.take) {
        take = ov.take;
      } else if (isTurnActive && ov.previous && ov.previous.take) {
        take = ov.previous.take;
        takeStale = true;
      }
    }

    const cats = getUsedCategories(ov);
    const catKeys = Object.keys(cats);
    const hasReportBlock = Boolean(askVal || take || steps.length > 0 || outcome || catKeys.length > 0);

    const hasAbout = renderAbout(ov, hasReportBlock);

    $('turn-group').classList.toggle('is-stale', isFullStalePlanning);
    show('planning-banner', ov.status === 'planning' && !ov.reported && (Boolean(ov.previous) || Boolean(askVal)));

    // 1. Ask
    show('sec-ask', Boolean(askVal));
    $('sec-ask').classList.toggle('is-stale-field', askStale);
    const askEl = $('ask');
    if (askEl.textContent !== askVal) askEl.textContent = askVal;
    const rawAsk = !isFullStalePlanning && !askStale ? (ov.ask || '') : '';
    askEl.title = askVal && rawAsk && askVal !== rawAsk ? `You asked: ${rawAsk}` : '';

    // 2. Take (inline claudzilla format)
    show('rule-take', Boolean(take && askVal));
    show('sec-take', Boolean(take));
    $('sec-take').classList.toggle('is-stale-field', takeStale);
    if (take) {
      const stance = take.stance || 'unsure';
      const inline = $('take-inline');
      inline.dataset.stance = stance;
      $('take-glyph').textContent = take.mark || STANCE_MARKS[stance] || CHECK;
      $('take-label').textContent = take.label || stance;
      $('take-why').textContent = take.why ? `: ${take.why}` : '';
    }

    // 3. Plan (with vertical guide-rail .agent-tree)
    const inProgressIdx = steps.findIndex((s) => s.status === 'in_progress');
    show('rule-plan', Boolean(steps.length > 0 && (askVal || take)));
    show('sec-plan', steps.length > 0);
    if (steps.length > 0) {
      let activeStepEl = null;

      $('steps').replaceChildren(...steps.map((s, idx) => {
        const stepNum = s.index || (idx + 1);
        const li = el('li', 'step-row');
        li.dataset.status = s.status;

        const glyphSpan = el('span', 'step-glyph');
        if (s.status === 'completed') glyphSpan.textContent = CHECK;
        else if (s.status === 'in_progress') glyphSpan.textContent = CIRCLE_DOT;
        else if (s.status === 'failed') glyphSpan.textContent = CROSS;
        else if (s.status === 'skipped') glyphSpan.textContent = '–';
        else glyphSpan.textContent = CIRCLE_OPEN;

        const contentDiv = el('div', 'step-content');
        const stepLine = el('div', 'step-line');
        stepLine.append(el('span', 'step-text', s.text));
        contentDiv.append(stepLine);

        if (s.status === 'in_progress') activeStepEl = li;

        const agents = s.agents;
        if (Array.isArray(agents) && agents.length > 0) {
          const isExpanded = state.expandedSteps.has(stepNum);
          const folds = agents.length > 3;
          const visibleAgents = folds && !isExpanded ? agents.slice(0, 3) : agents;

          const ul = el('ul', 'agent-tree');
          visibleAgents.forEach((ag) => {
            const agRow = el('li', 'agent-row');
            const agGlyph = el('span', 'agent-glyph', AGENT_GLYPHS[ag.status] || CIRCLE_DASH);
            agGlyph.dataset.status = ag.status || 'running';
            agGlyph.title = `Status: ${ag.status}`;

            const agName = el('span', 'agent-name', ag.name);
            const agDesc = el('span', 'agent-desc', ag.description || '');
            agDesc.title = ag.description || '';

            agRow.append(agGlyph, agName, agDesc);
            if (ag.model || ag.type) {
              const disp = shortModel(ag.model || ag.type);
              const modelTag = el('span', 'agent-model', disp);
              modelTag.title = `Type: ${ag.type || 'agent'}${SEP}Model: ${ag.model || 'default'}`;
              agRow.append(modelTag);
            }
            ul.append(agRow);
          });

          if (folds) {
            const foldLi = el('li', 'agent-fold');
            const hiddenCount = agents.length - visibleAgents.length;
            const toggleBtn = el('button', 'agents-toggle-btn');
            toggleBtn.type = 'button';
            toggleBtn.textContent = isExpanded
              ? `${ELLIPSIS} less`
              : `${ELLIPSIS} ${hiddenCount} more`;
            toggleBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (state.expandedSteps.has(stepNum)) state.expandedSteps.delete(stepNum);
              else state.expandedSteps.add(stepNum);
              render(state.ov);
            });
            foldLi.append(toggleBtn);
            ul.append(foldLi);
          }

          contentDiv.append(ul);
        }

        li.append(glyphSpan, contentDiv);
        return li;
      }));

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

    // 4. Result (Outcome) row
    show('rule-outcome', Boolean(outcome && (askVal || take || steps.length > 0)));
    show('sec-outcome', Boolean(outcome));
    if (outcome) {
      const kind = outcome.kind || 'clear';
      const inline = $('outcome-inline');
      inline.dataset.kind = kind;
      $('outcome-glyph').textContent = outcome.mark || OUTCOME_MARKS[kind] || CHECK;
      $('outcome-label').textContent = outcome.label || kind;
      $('outcome-summary').textContent = outcome.summary ? `: ${outcome.summary}` : '';

      const slot = $('outcome-slot');
      slot.textContent = outcome.running ? `checking${ELLIPSIS}` : '';
      show('outcome-slot', Boolean(outcome.running));

      const items = Array.isArray(outcome.items) ? outcome.items.filter(Boolean).slice(0, 3) : [];
      const itemsUl = $('outcome-items');
      itemsUl.replaceChildren(...items.map((txt) => el('li', '', txt)));
      show('outcome-items', items.length > 0);

      const evEl = $('outcome-evidence');
      evEl.textContent = outcome.evidence || '';
      evEl.dataset.verify = outcome.verifyState || '';
      show('outcome-evidence', Boolean(outcome.evidence));
    }

    // 5. Used ledger rows
    show('rule-used', Boolean(catKeys.length > 0 && (askVal || take || steps.length > 0 || outcome)));
    show('sec-used', catKeys.length > 0);

    const usedList = $('used-list');
    usedList.replaceChildren(...catKeys.map((k) => {
      const cat = cats[k];
      const card = el('button', isTurnActive ? 'used-card is-active' : 'used-card');
      card.type = 'button';
      card.setAttribute('aria-haspopup', 'dialog');

      const name = el('span', 'used-cat-name', cat.name);
      const countVal = el('span', 'used-count-val', String(cat.main));
      const previewCode = el('code', 'used-preview-text', '');
      if (cat.items && cat.items.length > 0) {
        const sortedItems = [...cat.items].sort((a, b) => {
          const aMain = a.reader === 'main' || a.reader === 'Main agent';
          const bMain = b.reader === 'main' || b.reader === 'Main agent';
          if (aMain && !bMain) return -1;
          if (!aMain && bMain) return 1;
          if (k === 'memory' || k === 'learnings') {
            const aSaved = a.group === 'saved';
            const bSaved = b.group === 'saved';
            if (aSaved && !bSaved) return -1;
            if (!aSaved && bSaved) return 1;
          }
          return 0;
        });
        const previewItems = sortedItems.slice(0, 3);
        if (k === 'memory' || k === 'learnings') {
          previewItems.forEach((it, idx) => {
            if (idx > 0) previewCode.append(document.createTextNode(', '));
            const short = it.short || it.name;
            if (it.group === 'saved') previewCode.append(el('span', 'used-saved-tag', `+${short}`));
            else previewCode.append(document.createTextNode(short));
          });
        } else {
          previewCode.textContent = previewItems.map((it) => it.short || it.name).join(', ');
        }
      }
      const chevron = el('span', 'used-chevron', '›');
      chevron.setAttribute('aria-hidden', 'true');

      card.append(name, countVal);
      if (cat.agents > 0) card.append(el('span', 'used-agents', `+${cat.agents}`));
      card.append(previewCode, chevron);
      card.addEventListener('click', () => openDrawer(k));
      return card;
    }));

    if (state.drawerMode && state.drawerMode !== 'memory-doc') renderDrawer();

    // 5. Empty / Unreported Status Note
    if (!ov.reported && ov.status !== 'done' && !ov.previous && ov.ask) {
      setEmptyNote(
        true,
        ov.status === 'stopped' ? 'No plan' : 'Waiting for plan',
        ov.status === 'stopped'
          ? 'Turn ended without report.'
          : 'Agent hasn\'t reported yet.',
      );
    } else if (!hasAbout && !hasReportBlock) {
      setEmptyNote(true, 'Nothing yet', 'Turn plan, status, and used context.');
    } else {
      setEmptyNote(false);
    }
  }

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
        $('status-glyph').textContent = CIRCLE_OPEN;
        $('status-text').textContent = 'idle';
        setEmptyNote(true, 'Nothing yet', 'Turn plan, status, and used context.');
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

  setInterval(() => {
    if (state.ov && !state.reconnecting) {
      renderStatus(state.ov);
      renderTelemetry(state.ov);
    }
  }, 1000);

  // The pane's width steers the footer's wording; re-render when it changes.
  function watchWidth() {
    const bar = $('telemetry-bar');
    if (!bar || typeof ResizeObserver === 'undefined') return;
    let lastW = -1;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w === lastW) return;
      lastW = w;
      state.paneW = w;
      if (state.ov) {
        renderStatus(state.ov);
        renderTelemetry(state.ov);
      }
    }).observe(bar);
  }
  watchWidth();
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
