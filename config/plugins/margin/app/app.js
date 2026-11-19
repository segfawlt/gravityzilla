(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const LABELS = { planning: 'Planning', working: 'Working', done: 'Done', stopped: 'Stopped', idle: 'Idle' };
  const USED = { files: 'Files', shell: 'Shell', web: 'Web', agents: 'Agents', other: 'Other' };
  const POLL_MS = 2000;
  const PROTOCOL = '2026-01-26';
  const state = { ov: null, conv: '', pinned: false, lastOk: 0, polling: false };
  const ID_RE = /^[0-9a-f-]{8,64}$/i;

  // ---- Minimal MCP Apps (SEP-1865) view bridge: JSON-RPC 2.0 over postMessage ----
  let nextId = 1;
  const pending = new Map();
  const post = (msg) => window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ id, method, params });
  });
  const notify = (method, params) => post({ method, params });

  function applyHost(ctx) {
    if (!ctx) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(ctx.styles?.variables ?? {})) if (typeof v === 'string') root.style.setProperty(k, v);
    if (ctx.theme === 'light' || ctx.theme === 'dark') root.style.colorScheme = ctx.theme;
  }

  // A conversation id the agent passed (tool input/result) is authoritative. A poll
  // may only fill in a guess when nothing was pinned, and never overrides a pin.
  function pin(id) {
    if (typeof id === 'string' && ID_RE.test(id)) { state.conv = id; state.pinned = true; }
  }

  function onResult(result, fromPoll = false) {
    const sc = result?.structuredContent;
    if (!sc?.overview) return;
    if (!fromPoll) pin(sc.conversationId);
    else if (!state.pinned && !state.conv) state.conv = sc.conversationId || '';
    if (fromPoll && state.pinned && sc.conversationId !== state.conv) return; // stale in-flight poll
    render(sc.overview);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
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
      if (m.error) p.reject(new Error(m.error.message || 'request failed')); else p.resolve(m.result);
    }
  });

  async function connect() {
    const res = await request('ui/initialize', {
      protocolVersion: PROTOCOL,
      appInfo: { name: 'Margin', version: '0.1.0' },
      appCapabilities: {},
    });
    applyHost(res?.hostContext);
    notify('ui/notifications/initialized');
  }

  // ---- Rendering ----
  const fmt = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };

  function renderStatus(ov) {
    $('status').dataset.state = ov.status;
    $('status-label').textContent = LABELS[ov.status] || ov.status;
    const start = Date.parse(ov.turnStartedAt);
    const end = ov.status === 'done' || ov.status === 'stopped' ? Date.parse(ov.lastStepAt) : Date.now();
    const parts = [];
    if (ov.steps.length) parts.push(`${ov.done}/${ov.steps.length} steps`);
    if (start) parts.push(fmt(end - start));
    $('status-meta').textContent = parts.join(' · ');
  }

  const show = (id, on) => { $(id).hidden = !on; };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function render(ov) {
    state.ov = ov;
    renderStatus(ov);
    show('sec-ask', Boolean(ov.ask || ov.wants));
    const ask = ov.wants || ov.ask;
    if ($('ask').textContent !== ask) $('ask').textContent = ask;
    $('ask').title = ov.wants && ov.ask ? `You asked: ${ov.ask}` : '';

    show('sec-take', Boolean(ov.take));
    if (ov.take) {
      $('take-chip').textContent = ov.take.label;
      $('take-chip').dataset.stance = ov.take.stance;
      $('take-why').textContent = ov.take.why;
    }

    show('sec-plan', ov.steps.length > 0);
    if (ov.steps.length) {
      const pct = Math.round((ov.done / ov.steps.length) * 100);
      $('plan-count').textContent = `${ov.done}/${ov.steps.length}`;
      $('plan-fill').style.width = `${pct}%`;
      $('plan-bar').setAttribute('aria-valuenow', String(pct));
      $('steps').replaceChildren(...ov.steps.map((s) => {
        const li = el('li', 'step');
        li.dataset.status = s.status;
        li.append(el('i', 'mark'), el('span', 'text', s.text));
        return li;
      }));
    }

    show('sec-verdict', Boolean(ov.verdict));
    $('verdict').textContent = ov.verdict;

    const used = Object.entries(USED).filter(([k]) => ov.used[k]);
    show('sec-used', used.length > 0);
    $('used').replaceChildren(...used.map(([k, label]) => el('li', '', `${label} ${ov.used[k]}`)));
    $('files').replaceChildren(...ov.files.slice(-5).map((p) => {
      const li = el('li', '', p.split('/').filter(Boolean).slice(-2).join('/'));
      li.title = p;
      return li;
    }));

    const note = $('empty');
    if (!ov.ask && !ov.wants) {
      note.hidden = false;
      note.textContent = 'Send a message to start. The overview fills in as the agent works.';
    } else if (!ov.reported && ov.status !== 'done') {
      note.hidden = false;
      note.textContent = ov.status === 'stopped'
        ? 'The agent did not report a reading or plan this turn.'
        : 'Waiting for the agent to report its reading and plan.';
    } else {
      note.hidden = true;
    }
  }

  async function poll() {
    if (state.polling) return;
    state.polling = true;
    try {
      const r = await request('tools/call', { name: 'margin_overview', arguments: state.conv ? { conversation_id: state.conv } : {} });
      state.lastOk = Date.now();
      onResult(r, true);
    } catch {
      if (Date.now() - state.lastOk > 6000) $('status-label').textContent = 'Reconnecting';
    } finally {
      state.polling = false;
    }
  }

  $('ask').addEventListener('click', () => $('ask').classList.toggle('open'));
  $('ask').classList.add('clamp');
  setInterval(() => { if (state.ov) renderStatus(state.ov); }, 1000);
  // Short grace so the agent's tool-input/result (with the exact conversation id) can arrive first.
  connect().then(() => { setTimeout(poll, 500); setInterval(poll, POLL_MS); }).catch(() => {
    $('status-label').textContent = 'Not connected';
  });
})();
