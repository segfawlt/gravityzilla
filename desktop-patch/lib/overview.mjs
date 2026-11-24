// Sandbox-safe Electron preload helper that keeps Overview pinned and auto-opens it once per conversation.
export const PINNED_TABS_KEY = 'aux-pane-v2-pinned-tabs';
export const OVERVIEW_TAB_ID = 'sidecar__margin/margin__/';
export const OVERVIEW_PIN = Object.freeze({
  kind: 'sidecar',
  sidecarId: 'margin/margin',
  path: '/',
  title: 'Overview',
});

export const OVERVIEW_PATCH_START = '/* agy-overview-patch:start v1 */';
export const OVERVIEW_PATCH_END = '/* agy-overview-patch:end */';

/** Derive a stable conversation/draft view key from window.location, or null for non-chat views. */
export function viewKeyFromLocation(loc) {
  const pathname = typeof loc?.pathname === 'string' ? loc.pathname : '';
  const params = new URLSearchParams(typeof loc?.search === 'string' ? loc.search : '');

  if (pathname === '/') {
    if (params.has('settings')) return null;
    const cascadeId = params.get('cascadeId');
    if (cascadeId) return `cascade:${cascadeId}`;
    return `new:${params.get('project') || 'home'}`;
  }

  if (pathname.startsWith('/c/')) {
    const segment = pathname.slice(3).split('/')[0];
    return segment ? `cascade:${segment}` : null;
  }

  return null;
}

/** Seed margin/margin in aux-pane-v2-pinned-tabs if missing; performs zero writes when already present. */
export async function ensureOverviewPinned(storage) {
  if (!storage || typeof storage.getItems !== 'function' || typeof storage.updateItems !== 'function') {
    return false;
  }
  const items = await storage.getItems();
  const raw = items && items[PINNED_TABS_KEY];
  let list = [];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  }

  const hasOverview = list.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      item.kind === 'sidecar' &&
      item.sidecarId === 'margin/margin' &&
      item.path === '/',
  );
  if (hasOverview) return false;

  const next = [...list, { kind: 'sidecar', sidecarId: 'margin/margin', path: '/', title: 'Overview' }];
  await storage.updateItems({ [PINNED_TABS_KEY]: JSON.stringify(next) });
  return true;
}

/**
 * Create the non-fighting auto-opener state machine.
 * Opens the right Side Panel and selects Overview once when entering a new conversation or draft.
 */
export function createOverviewAutoOpener(env = {}) {
  const doc = env.doc ?? (typeof document !== 'undefined' ? document : null);
  const win = env.win ?? (typeof window !== 'undefined' ? window : null);
  const now = env.now ?? (() => Date.now());
  const setTimer = env.setTimeout ?? setTimeout;
  const clearTimer = env.clearTimeout ?? clearTimeout;
  const setPoll = env.setInterval ?? setInterval;
  const clearPoll = env.clearInterval ?? clearInterval;
  const ObserverCtor = env.MutationObserver ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

  const handledCascades = new Set();
  let lastViewKey = null;
  let lastHref = '';
  let pendingKey = null;
  let pendingSince = 0;
  let clickedOpenForKey = null;
  let debounceTimer = null;
  let pollTimer = null;
  let observer = null;
  let stopped = false;

  function markHandled(key) {
    if (key && key.startsWith('cascade:')) {
      handledCascades.add(key);
    }
  }

  function tick() {
    if (stopped || !doc || !win) return;
    lastHref = String(win.location?.href || '');
    const key = viewKeyFromLocation(win.location);

    if (key !== lastViewKey) {
      lastViewKey = key;
      clickedOpenForKey = null;
      if (!key) {
        pendingKey = null;
        return;
      }
      if (key.startsWith('new:') || !handledCascades.has(key)) {
        pendingKey = key;
        pendingSince = now();
      } else {
        pendingKey = null;
        return;
      }
    }

    if (!pendingKey) return;
    if (now() - pendingSince > 4000) {
      markHandled(pendingKey);
      pendingKey = null;
      return;
    }

    const panel = doc.querySelector('[data-side-panel-open]');
    const toggleBtn = doc.querySelector('[data-testid="toggle-aux-sidebar"]');
    if (!panel && !toggleBtn) return;

    const isOpen =
      panel?.getAttribute('data-side-panel-open') === 'true' ||
      toggleBtn?.getAttribute('aria-expanded') === 'true';

    if (!isOpen) {
      if (toggleBtn && clickedOpenForKey !== pendingKey) {
        clickedOpenForKey = pendingKey;
        toggleBtn.click();
      }
      return;
    }

    const strip = doc.querySelector('[data-side-panel-strip]');
    const activeTab = strip?.getAttribute('data-active-tab-id') || '';
    const overviewBtn = doc.querySelector(`[data-tab-id="${OVERVIEW_TAB_ID}"]`);

    if (activeTab === OVERVIEW_TAB_ID) {
      markHandled(pendingKey);
      pendingKey = null;
      return;
    }

    if (!activeTab || activeTab === 'newTab__empty' || clickedOpenForKey === pendingKey) {
      if (overviewBtn) {
        overviewBtn.click();
        markHandled(pendingKey);
        pendingKey = null;
      }
      return;
    }

    // Panel was already open on another tab (e.g. Swarm or a file); do not steal focus.
    markHandled(pendingKey);
    pendingKey = null;
  }

  function schedule() {
    if (stopped || debounceTimer !== null) return;
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      tick();
    }, 40);
  }

  const onRoute = () => tick();

  function start() {
    if (stopped || !doc || !win) return;
    const root = doc.body || doc.documentElement;
    if (ObserverCtor && root) {
      observer = new ObserverCtor(() => schedule());
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-side-panel-open', 'data-active-tab-id', 'aria-expanded'],
      });
    }
    win.addEventListener?.('popstate', onRoute);
    win.addEventListener?.('hashchange', onRoute);
    win.addEventListener?.('focus', onRoute);
    win.addEventListener?.('pagehide', stop, { once: true });
    pollTimer = setPoll(() => {
      if (String(win.location?.href || '') !== lastHref || pendingKey !== null) {
        tick();
      }
    }, 350);
    tick();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    observer = null;
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
    if (pollTimer !== null) {
      clearPoll(pollTimer);
      pollTimer = null;
    }
    win?.removeEventListener?.('popstate', onRoute);
    win?.removeEventListener?.('hashchange', onRoute);
    win?.removeEventListener?.('focus', onRoute);
  }

  return { start, stop, tick };
}

/** Build the self-contained, sandbox-safe preload snippet appended to dist/preload.js. */
export function renderPreloadSnippet() {
  return [
    OVERVIEW_PATCH_START,
    '(() => {',
    "  'use strict';",
    "  const electron_1 = require('electron');",
    `  const PINNED_TABS_KEY = ${JSON.stringify(PINNED_TABS_KEY)};`,
    `  const OVERVIEW_TAB_ID = ${JSON.stringify(OVERVIEW_TAB_ID)};`,
    `  ${viewKeyFromLocation.toString()}`,
    `  ${ensureOverviewPinned.toString()}`,
    `  ${createOverviewAutoOpener.toString()}`,
    "  const isSsh = typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.some((a) => typeof a === 'string' && a.startsWith('--agy-backend=ssh'));",
    "  if (isSsh) return;",
    "  const proto = typeof window !== 'undefined' && window.location ? window.location.protocol : '';",
    "  if (proto !== 'http:' && proto !== 'https:') return;",
    '  const storage = {',
    "    getItems: () => electron_1.ipcRenderer.invoke('storage:get-items'),",
    "    updateItems: (changes) => electron_1.ipcRenderer.invoke('storage:update-items', changes),",
    '  };',
    '  const boot = () => {',
    '    void ensureOverviewPinned(storage).catch(() => {});',
    '    createOverviewAutoOpener().start();',
    '  };',
    "  if (typeof document !== 'undefined' && document.readyState === 'loading') {",
    "    window.addEventListener('DOMContentLoaded', boot, { once: true });",
    '  } else {',
    '    boot();',
    '  }',
    '})();',
    OVERVIEW_PATCH_END,
  ].join('\n');
}

/** Strip any previously injected agy-overview-patch block from dist/preload.js source. */
export function stripOverviewPatch(source) {
  const startIdx = source.indexOf(OVERVIEW_PATCH_START);
  const endIdx = source.indexOf(OVERVIEW_PATCH_END);
  if (startIdx === -1 && endIdx === -1) return source;
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('Corrupt agy-overview-patch marker block in dist/preload.js');
  }
  let before = source.slice(0, startIdx).replace(/\r?\n+$/, '');
  const after = source.slice(endIdx + OVERVIEW_PATCH_END.length).replace(/^\r?\n+/, '');
  if (!before) return after ? `${after}\n` : '';
  if (!after) return `${before}\n`;
  return `${before}\n${after}`;
}

/** Return dist/preload.js source with the current agy-overview-patch snippet cleanly appended. */
export function applyOverviewPatchToSource(source) {
  const clean = stripOverviewPatch(source).replace(/\s+$/, '');
  return `${clean}\n\n${renderPreloadSnippet()}\n`;
}
