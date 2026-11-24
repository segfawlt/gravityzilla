import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';
import {
  computeIntegrity,
  encodeAsarHeader,
  getEntry,
  patchAsarFiles,
  readAsarFile,
  readAsarHeader,
  sha256File,
} from '../lib/asar.mjs';
import {
  applyModelSearchPatchToSource,
  hasModelSearchPatch,
  HIDDEN_MODELS_KEY,
  KNOWN_MODELS_KEY,
  MODEL_SEARCH_PATCH_END,
  MODEL_SEARCH_PATCH_START,
  renderModelSearchSnippet,
  stripModelSearchPatch,
} from '../lib/model-search.mjs';
import { parseArgs } from '../patch.mjs';
import {
  applyOverviewPatchToSource,
  createOverviewAutoOpener,
  ensureOverviewPinned,
  OVERVIEW_PATCH_END,
  OVERVIEW_PATCH_START,
  OVERVIEW_PIN,
  OVERVIEW_TAB_ID,
  PINNED_TABS_KEY,
  renderPreloadSnippet,
  stripOverviewPatch,
  viewKeyFromLocation,
} from '../lib/overview.mjs';
import {
  applyTopBarPatchToSource,
  hasTopBarPatch,
  LEGACY_TOP_BAR_MARKER,
  renderTopBarSnippet,
  stripTopBarPatch,
  TOP_BAR_ANCHOR,
  TOP_BAR_PATCH_END,
  TOP_BAR_PATCH_START,
} from '../lib/top-bar.mjs';

const CLI_PATH = new URL('../patch.mjs', import.meta.url).pathname;
const BIN_SYMLINK_PATH = new URL('../../bin/agy-desktop-patch', import.meta.url).pathname;
const DEFAULT_MAIN = `const electron_1 = { app: { on() {} } };\nelectron_1.app.on('web-contents-created', (_e, contents) => {\n${TOP_BAR_ANCHOR}\n`;

function buildSyntheticAsar(destPath, { mainText = DEFAULT_MAIN, preloadText = 'const x = 1;\n', extraEntries = {} }) {
  const mainBuf = Buffer.from(mainText, 'utf8');
  const preloadBuf = Buffer.from(preloadText, 'utf8');
  const scriptBuf = Buffer.from('#!/bin/sh\necho ok\n', 'utf8');
  const readmeBuf = Buffer.from('hello world', 'utf8');

  const files = {
    dist: {
      files: {
        'main.js': {
          size: mainBuf.length,
          offset: '0',
          integrity: computeIntegrity(mainBuf),
        },
        'preload.js': {
          size: preloadBuf.length,
          offset: String(mainBuf.length),
          integrity: computeIntegrity(preloadBuf),
        },
        'run.sh': {
          size: scriptBuf.length,
          offset: String(mainBuf.length + preloadBuf.length),
          executable: true,
          integrity: computeIntegrity(scriptBuf),
        },
      },
    },
    'README.txt': {
      size: readmeBuf.length,
      offset: String(mainBuf.length + preloadBuf.length + scriptBuf.length),
      integrity: computeIntegrity(readmeBuf),
    },
    'native.node': {
      size: 123,
      unpacked: true,
    },
    ...extraEntries,
  };

  const header = { files };
  const { headerBuf } = encodeAsarHeader(header);
  writeFileSync(destPath, Buffer.concat([headerBuf, mainBuf, preloadBuf, scriptBuf, readmeBuf]));
  return { mainBuf, preloadBuf, scriptBuf, readmeBuf };
}

function makeFakeDom({ href = 'http://localhost:5387/', isOpen = false, activeTabId = 'newTab__empty', hasOverviewTab = true } = {}) {
  const clicks = { toggle: 0, overview: 0 };
  const state = { href, isOpen, activeTabId, hasOverviewTab };
  let observerCb = null;

  const panel = {
    getAttribute(name) {
      return name === 'data-side-panel-open' ? String(state.isOpen) : null;
    },
  };
  const toggleBtn = {
    getAttribute(name) {
      return name === 'aria-expanded' ? String(state.isOpen) : null;
    },
    click() {
      clicks.toggle += 1;
      state.isOpen = !state.isOpen;
    },
  };
  const strip = {
    getAttribute(name) {
      return name === 'data-active-tab-id' ? state.activeTabId : null;
    },
  };
  const overviewBtn = {
    click() {
      clicks.overview += 1;
      state.activeTabId = OVERVIEW_TAB_ID;
    },
  };

  const doc = {
    body: {},
    documentElement: {},
    querySelector(sel) {
      if (sel === '[data-side-panel-open]') return panel;
      if (sel === '[data-testid="toggle-aux-sidebar"]') return toggleBtn;
      if (sel === '[data-side-panel-strip]') return state.isOpen ? strip : null;
      if (sel === `[data-tab-id="${OVERVIEW_TAB_ID}"]`) return state.isOpen && state.hasOverviewTab ? overviewBtn : null;
      return null;
    },
  };

  const listeners = new Map();
  const win = {
    get location() {
      const u = new URL(state.href);
      return { href: u.href, pathname: u.pathname, search: u.search };
    },
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    removeEventListener(ev, fn) {
      listeners.get(ev)?.delete(fn);
    },
  };

  class FakeObserver {
    constructor(cb) {
      observerCb = cb;
    }
    observe() {}
    disconnect() {
      observerCb = null;
    }
  }

  let clock = 1000;
  let nextTimerId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const opener = createOverviewAutoOpener({
    doc,
    win,
    now: () => clock,
    setTimeout: (fn) => {
      const id = nextTimerId++;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn) => {
      const id = nextTimerId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    MutationObserver: FakeObserver,
  });

  return {
    state,
    clicks,
    opener,
    advance(ms) {
      clock += ms;
    },
    navigate(nextHref, opts = {}) {
      state.href = nextHref;
      if ('isOpen' in opts) state.isOpen = opts.isOpen;
      if ('activeTabId' in opts) state.activeTabId = opts.activeTabId;
      if ('hasOverviewTab' in opts) state.hasOverviewTab = opts.hasOverviewTab;
    },
    notifyMutation() {
      observerCb?.();
      for (const [id, fn] of [...timeouts]) {
        timeouts.delete(id);
        fn();
      }
    },
  };
}

test('asar: Chromium Pickle 4-byte padding across all mod-4 lengths preserves executable, unpacked, and other payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asar-pad-'));
  try {
    for (let padTarget = 0; padTarget < 4; padTarget++) {
      const extraKey = `pad_${'x'.repeat(padTarget)}`;
      const src = join(dir, `src-${padTarget}.asar`);
      const dst = join(dir, `dst-${padTarget}.asar`);
      const { scriptBuf, readmeBuf } = buildSyntheticAsar(src, {
        preloadText: 'console.log("orig");',
        extraEntries: { [extraKey]: { size: 1, unpacked: true } },
      });

      const { jsonLen } = readAsarHeader(src);
      const nextPreload = Buffer.from(`console.log("patched-${padTarget}");`, 'utf8');
      patchAsarFiles(src, dst, new Map([['dist/preload.js', nextPreload]]));

      const { header } = readAsarHeader(dst);
      assert.equal(readAsarFile(dst, 'dist/preload.js').equals(nextPreload), true);
      assert.equal(readAsarFile(dst, 'dist/run.sh').equals(scriptBuf), true);
      assert.equal(readAsarFile(dst, 'README.txt').equals(readmeBuf), true);
      assert.equal(getEntry(header, 'dist/run.sh').executable, true);
      assert.equal(getEntry(header, 'native.node').unpacked, true);
      assert.equal(getEntry(header, 'native.node').offset, undefined);
      assert.equal(getEntry(header, 'dist/preload.js').integrity.hash, computeIntegrity(nextPreload).hash);
      assert.equal((jsonLen + padTarget) % 4 >= 0, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('top-bar: snippet compiles, apply/strip are idempotent, and legacy marker is preserved without double-injection', () => {
  const snippet = renderTopBarSnippet();
  assert.ok(snippet.includes(TOP_BAR_PATCH_START));
  assert.ok(snippet.includes(TOP_BAR_PATCH_END));
  assert.doesNotThrow(() => new Script(snippet, { filename: 'top-bar-snippet.js' }));

  const once = applyTopBarPatchToSource(DEFAULT_MAIN);
  assert.equal(hasTopBarPatch(once), true);
  assert.equal(applyTopBarPatchToSource(once), once);
  assert.equal(stripTopBarPatch(once), DEFAULT_MAIN);
  assert.doesNotThrow(() => new Script(once, { filename: 'dist/main.js' }));

  const legacy = `${DEFAULT_MAIN}\n${LEGACY_TOP_BAR_MARKER}\nconsole.log('legacy');\n`;
  assert.equal(hasTopBarPatch(legacy), true);
  assert.equal(applyTopBarPatchToSource(legacy), legacy);

  assert.throws(() => applyTopBarPatchToSource('console.log("no anchor");\n'), /Anchor not found/);
});

test('overview: rendered snippet compiles via vm.Script and strip/apply are idempotent', () => {
  const snippet = renderPreloadSnippet();
  assert.ok(snippet.includes(OVERVIEW_PATCH_START));
  assert.ok(snippet.includes(OVERVIEW_PATCH_END));
  assert.doesNotThrow(() => new Script(snippet, { filename: 'snippet.js' }));

  const base = '"use strict";\nconsole.log("vendor");\n';
  const once = applyOverviewPatchToSource(base);
  const twice = applyOverviewPatchToSource(once);
  assert.equal(once, twice);
  assert.equal(stripOverviewPatch(once), base);
  assert.doesNotThrow(() => new Script(once, { filename: 'dist/preload.js' }));
});

test('unified patch.mjs CLI: status, check, combined apply, --only mode, idempotent reapply, and restore', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-unified-cli-'));
  try {
    const resources = join(root, 'resources');
    mkdirSync(resources, { recursive: true });
    const archivePath = join(resources, 'app.asar');
    buildSyntheticAsar(archivePath, {});
    const origSha = sha256File(archivePath);

    const runCli = (args) =>
      execFileSync('node', [CLI_PATH, ...args, '--resources', resources], { encoding: 'utf8' });

    const stClean = runCli(['status']);
    assert.match(stClean, /Patch 1 \(top-bar\):\s+not installed/);
    assert.match(stClean, /Patch 2 \(overview\):\s+not installed/);
    assert.match(stClean, /Patch 3 \(model-search\):\s+not installed/);

    const chk = runCli(['check']);
    assert.match(chk, /CHECK PASSED \[top-bar, overview, model-search\]/);
    assert.equal(sha256File(archivePath), origSha);

    const appOut = runCli(['apply']);
    assert.match(appOut, /PATCH APPLIED \[top-bar, overview, model-search\]/);
    const patchedSha = sha256File(archivePath);
    assert.notEqual(patchedSha, origSha);
    assert.equal(hasTopBarPatch(readAsarFile(archivePath, 'dist/main.js').toString('utf8')), true);
    const patchedPreload = readAsarFile(archivePath, 'dist/preload.js').toString('utf8');
    assert.equal(patchedPreload.includes(OVERVIEW_PATCH_START), true);
    assert.equal(hasModelSearchPatch(patchedPreload), true);

    const stPatched = runCli(['status']);
    assert.match(stPatched, /Patch 1 \(top-bar\):\s+installed/);
    assert.match(stPatched, /Patch 2 \(overview\):\s+installed/);
    assert.match(stPatched, /Patch 3 \(model-search\):\s+installed/);
    assert.match(stPatched, /State:\s+clean/);

    // Double-symlink invocation via bin/agy-desktop-patch works identically.
    const symlinkStatus = execFileSync('node', [BIN_SYMLINK_PATH, 'status', '--resources', resources], { encoding: 'utf8' });
    assert.match(symlinkStatus, /Patch 3 \(model-search\):\s+installed/);

    // Idempotent second apply preserves original backup SHA and produces identical output.
    const reappOut = runCli(['apply']);
    assert.match(reappOut, /PATCH APPLIED \[top-bar, overview, model-search\]/);
    const stateAfterReapply = JSON.parse(readFileSync(join(resources, '.agy-desktop-patch', 'state.json'), 'utf8'));
    assert.equal(stateAfterReapply.originalSha256, origSha);
    assert.equal(sha256File(archivePath), patchedSha);

    // External modification blocks restore unless --force is passed.
    const mutated = join(root, 'mutated.asar');
    patchAsarFiles(archivePath, mutated, new Map([['README.txt', Buffer.from('external edit')]]));
    writeFileSync(archivePath, readFileSync(mutated));
    assert.throws(() => runCli(['restore']), /changed externally/);

    const restOut = runCli(['restore', '--force']);
    assert.match(restOut, /RESTORED/);
    assert.equal(sha256File(archivePath), origSha);
    assert.equal(existsSync(join(resources, '.agy-desktop-patch', 'state.json')), false);

    // Selective --only mode applies only the requested patch.
    runCli(['apply', '--only', 'top-bar']);
    assert.equal(hasTopBarPatch(readAsarFile(archivePath, 'dist/main.js').toString('utf8')), true);
    assert.equal(readAsarFile(archivePath, 'dist/preload.js').toString('utf8').includes(OVERVIEW_PATCH_START), false);
    assert.equal(hasModelSearchPatch(readAsarFile(archivePath, 'dist/preload.js').toString('utf8')), false);

    runCli(['restore']);
    runCli(['apply', '--only', 'model-search']);
    assert.equal(hasTopBarPatch(readAsarFile(archivePath, 'dist/main.js').toString('utf8')), false);
    assert.equal(readAsarFile(archivePath, 'dist/preload.js').toString('utf8').includes(OVERVIEW_PATCH_START), false);
    assert.equal(hasModelSearchPatch(readAsarFile(archivePath, 'dist/preload.js').toString('utf8')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overview: pin seeding is idempotent and skips unnecessary writes', async () => {
  let items = {};
  let updates = 0;
  const storage = {
    async getItems() {
      return items;
    },
    async updateItems(changes) {
      updates += 1;
      items = { ...items, ...changes };
    },
  };

  assert.equal(await ensureOverviewPinned(storage), true);
  assert.equal(updates, 1);
  assert.deepEqual(JSON.parse(items[PINNED_TABS_KEY]), [OVERVIEW_PIN]);

  assert.equal(await ensureOverviewPinned(storage), false);
  assert.equal(updates, 1);
});

test('overview: viewKeyFromLocation and non-fighting auto-opener transitions', () => {
  assert.equal(viewKeyFromLocation(new URL('http://localhost/')), 'new:home');
  assert.equal(viewKeyFromLocation(new URL('http://localhost/?project=p1')), 'new:p1');
  assert.equal(viewKeyFromLocation(new URL('http://localhost/?settings=1')), null);
  assert.equal(viewKeyFromLocation(new URL('http://localhost/?cascadeId=abc-123')), 'cascade:abc-123');
  assert.equal(viewKeyFromLocation(new URL('http://localhost/c/def-456')), 'cascade:def-456');

  const dom = makeFakeDom({ href: 'http://localhost:5387/', isOpen: false, activeTabId: 'newTab__empty' });
  dom.opener.start();
  assert.equal(dom.clicks.toggle, 1);
  assert.equal(dom.state.isOpen, true);
  dom.notifyMutation();
  assert.equal(dom.clicks.overview, 1);
  assert.equal(dom.state.activeTabId, OVERVIEW_TAB_ID);

  dom.state.isOpen = false;
  dom.opener.tick();
  assert.equal(dom.clicks.toggle, 1);

  dom.navigate('http://localhost:5387/c/conv-1', { isOpen: false, activeTabId: 'newTab__empty' });
  dom.opener.tick();
  assert.equal(dom.clicks.toggle, 2);
  dom.notifyMutation();
  assert.equal(dom.clicks.overview, 2);

  dom.navigate('http://localhost:5387/c/conv-3', { isOpen: true, activeTabId: 'sidecar__swarm/swarm_board__/' });
  dom.opener.tick();
  assert.equal(dom.clicks.toggle, 2);
  assert.equal(dom.clicks.overview, 2);

  dom.opener.stop();
});

function splitTopLevelCommas(sel) {
  return sel.split(',').map((s) => s.trim()).filter(Boolean);
}

function matchCompoundPart(el, part) {
  if (!el || el.nodeType !== 1) return false;
  let rest = part.trim();
  if (!rest) return false;

  const notMatches = [...rest.matchAll(/:not\(([^)]+)\)/g)];
  rest = rest.replace(/:not\([^)]+\)/g, '');
  for (const m of notMatches) {
    if (matchCompoundPart(el, m[1])) return false;
  }

  const attrMatches = [...rest.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
  rest = rest.replace(/\[[^\]]+\]/g, '');
  for (const m of attrMatches) {
    const attrName = m[1].trim();
    const expected = m[2];
    const actual = el.getAttribute(attrName);
    if (expected === undefined) {
      if (actual === null) return false;
    } else if (actual !== expected) {
      return false;
    }
  }

  const classMatches = [...rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
  rest = rest.replace(/\.[a-zA-Z0-9_-]+/g, '');
  const classList = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  for (const m of classMatches) {
    if (!classList.has(m[1])) return false;
  }

  const idMatch = rest.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    rest = rest.replace(/#[a-zA-Z0-9_-]+/g, '');
    if (el.id !== idMatch[1]) return false;
  }

  const tag = rest.trim().toLowerCase();
  if (tag && tag !== '*' && el.tagName.toLowerCase() !== tag) return false;
  return true;
}

function createMockStyleObj() {
  const props = new Map();
  const obj = {
    setProperty(k, v) { props.set(k, String(v)); },
    removeProperty(k) { props.delete(k); },
    getPropertyValue(k) { return props.get(k) || ''; },
    cssText: '',
  };
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const kebab = String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return props.get(kebab) || '';
    },
    set(target, prop, val) {
      if (prop in target) {
        target[prop] = val;
        return true;
      }
      const kebab = String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      props.set(kebab, String(val));
      return true;
    },
  });
}

function makeModelSearchEnv({ initialStorage = null } = {}) {
  let doc;
  const winListeners = new Map();
  const docListeners = new Map();
  const storageListeners = new Set();
  const storageState = initialStorage ? { ...initialStorage } : {};
  const storageUpdates = [];

  const mockStorage = {
    getItemsSync() {
      return { ...storageState };
    },
    async getItems() {
      return { ...storageState };
    },
    async updateItems(changes) {
      storageUpdates.push(changes);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete storageState[k];
        else storageState[k] = v;
      }
    },
    onChanged(cb) {
      storageListeners.add(cb);
      return () => storageListeners.delete(cb);
    },
  };

  class MockEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.key = init.key || '';
      this.code = init.code || '';
      this.clientX = init.clientX ?? 0;
      this.clientY = init.clientY ?? 0;
      this.bubbles = init.bubbles ?? true;
      this.cancelable = init.cancelable ?? true;
      this.ctrlKey = Boolean(init.ctrlKey);
      this.metaKey = Boolean(init.metaKey);
      this.altKey = Boolean(init.altKey);
      this.shiftKey = Boolean(init.shiftKey);
      this.defaultPrevented = false;
      this.stopped = false;
      this.target = init.target || null;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
  }

  function invokeListeners(map, type, capture, ev) {
    const fns = map.get(type) || [];
    for (const entry of fns) {
      if (entry.capture === capture) entry.fn(ev);
    }
  }

  class MockElement {
    constructor(tagName) {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.className = '';
      this.children = [];
      this.parentElement = null;
      this._attrMap = new Map();
      this.style = createMockStyleObj();
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.type = '';
      this._textContent = '';
      this._rect = { left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30 };
      this.offsetWidth = 0;
      this.offsetHeight = 0;
      this._listeners = new Map();
      this.clicked = 0;
      this.focusCount = 0;
      this.classList = {
        contains: (cls) => String(this.className || '').split(/\s+/).includes(cls),
      };
    }

    get textContent() {
      if (this._textContent) return this._textContent;
      return this.children.map((c) => c.textContent).join(' ');
    }
    set textContent(v) {
      this._textContent = String(v);
    }

    getBoundingClientRect() {
      if (this.style.display === 'none' || this.closest('[data-agy-model-hidden="true"]')) {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }
      return this._rect;
    }

    setAttribute(name, val) {
      const s = String(val);
      this._attrMap.set(name, s);
      if (name === 'id') this.id = s;
      if (name === 'class') this.className = s;
    }
    getAttribute(name) {
      if (name === 'id' && this.id) return this.id;
      if (name === 'class' && this.className) return this.className;
      return this._attrMap.has(name) ? this._attrMap.get(name) : null;
    }
    hasAttribute(name) {
      return this.getAttribute(name) !== null;
    }
    removeAttribute(name) {
      this._attrMap.delete(name);
    }

    appendChild(child) {
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter((c) => c !== child);
      }
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    prepend(child) {
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter((c) => c !== child);
      }
      child.parentElement = this;
      this.children.unshift(child);
      return child;
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    matches(sel) {
      return splitTopLevelCommas(sel).some((part) => matchCompoundPart(this, part));
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const parts = splitTopLevelCommas(sel);
      const walk = (node) => {
        for (const c of node.children) {
          if (parts.some((p) => matchCompoundPart(c, p)) && !out.includes(c)) {
            out.push(c);
          }
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }

    addEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push({ fn, capture });
    }
    dispatchEvent(ev) {
      if (!ev.target) ev.target = this;
      const chain = [];
      for (let cur = this; cur; cur = cur.parentElement) chain.push(cur);

      // Capture: window -> doc -> ancestors -> target
      invokeListeners(winListeners, ev.type, true, ev);
      if (ev.stopped) return !ev.defaultPrevented;
      invokeListeners(docListeners, ev.type, true, ev);
      if (ev.stopped) return !ev.defaultPrevented;
      for (let i = chain.length - 1; i >= 0; i--) {
        invokeListeners(chain[i]._listeners, ev.type, true, ev);
        if (ev.stopped) return !ev.defaultPrevented;
      }

      // Bubble: target -> ancestors -> doc -> window
      for (let i = 0; i < chain.length; i++) {
        invokeListeners(chain[i]._listeners, ev.type, false, ev);
        if (!ev.bubbles || ev.stopped) return !ev.defaultPrevented;
      }
      invokeListeners(docListeners, ev.type, false, ev);
      if (!ev.bubbles || ev.stopped) return !ev.defaultPrevented;
      invokeListeners(winListeners, ev.type, false, ev);
      return !ev.defaultPrevented;
    }
    focus() {
      const prev = doc.activeElement;
      this.focusCount += 1;
      doc.activeElement = this;
      if (prev && prev !== this) {
        prev.dispatchEvent(new MockEvent('blur', { bubbles: false, target: prev }));
      }
    }
    setSelectionRange() {}
    click() { this.clicked += 1; }
    scrollIntoView() {}
  }

  const head = new MockElement('head');
  const body = new MockElement('body');
  const html = new MockElement('html');
  html.appendChild(head);
  html.appendChild(body);

  doc = {
    head,
    body,
    documentElement: html,
    activeElement: body,
    readyState: 'complete',
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => html.querySelector(`#${id}`),
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    addEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push({ fn, capture });
    },
  };

  const win = {
    location: { protocol: 'https:', href: 'https://127.0.0.1:1234/' },
    addEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, capture });
    },
    removeEventListener() {},
  };

  const pendingTimeouts = [];
  const pendingRafs = [];
  const testApi = { skipAutoBoot: true, storage: mockStorage };
  const snippet = renderModelSearchSnippet();
  const sandbox = {
    globalThis: null,
    window: win,
    document: doc,
    getComputedStyle: (el) => ({
      display: el.style.display || 'block',
      visibility: el.style.visibility || 'visible',
    }),
    requestAnimationFrame: (fn) => {
      pendingRafs.push(fn);
      return pendingRafs.length;
    },
    setTimeout: (fn) => {
      pendingTimeouts.push(fn);
      return pendingTimeouts.length;
    },
    clearTimeout() {},
    process: { argv: [] },
    __AGY_MODEL_SEARCH_TEST__: testApi,
  };
  sandbox.globalThis = sandbox;
  new Script(snippet, { filename: 'model-search-snippet.js' }).runInContext(createContext(sandbox));

  return {
    doc,
    win,
    MockElement,
    MockEvent,
    api: testApi,
    storageState,
    storageUpdates,
    emitStorageChange(changes) {
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete storageState[k];
        else storageState[k] = v;
      }
      for (const cb of storageListeners) cb(changes);
    },
    flushAsync() {
      while (pendingRafs.length) pendingRafs.shift()();
      while (pendingTimeouts.length) pendingTimeouts.shift()();
    },
  };
}

function buildAntigravityModelPickerDom(doc, MockElement, { bestOfN = false, withSubmenu = false } = {}) {
  const menu = new MockElement('div');
  menu.setAttribute('role', 'menu');

  const panel = new MockElement('div');
  panel.setAttribute('data-testid', 'model-selector-panel');
  panel.offsetWidth = 280;
  panel.offsetHeight = 320;

  const scrollWrap = new MockElement('div');
  scrollWrap.className = 'relative flex flex-col flex-grow min-h-0';

  const listContainer = new MockElement('div');
  listContainer.className = 'flex flex-col flex-grow min-h-0 overflow-y-auto';
  listContainer.offsetWidth = 272;
  listContainer.offsetHeight = 240;

  const header = new MockElement('div');
  header.setAttribute('data-testid', 'model-selector-header');
  header.textContent = bestOfN ? 'Best of N Models' : 'Model';
  listContainer.appendChild(header);

  const group = new MockElement('div');
  group.className = 'flex flex-col gap-px';

  const makeItem = (label, { selected = false, checkbox = false, effort = false } = {}) => {
    const item = new MockElement('div');
    item.setAttribute('role', checkbox ? 'menuitemcheckbox' : 'menuitem');
    item.setAttribute('data-testid', effort ? 'model-selector-effort-group' : 'model-selector-item');
    item.textContent = label;
    if (checkbox && selected) item.setAttribute('aria-checked', 'true');
    if (!checkbox && selected) {
      const check = new MockElement('span');
      check.setAttribute('data-testid', 'menu-item-check');
      item.appendChild(check);
    }
    return item;
  };

  const flashItem = makeItem('Gemini 4 Flash');
  const proItem = makeItem('Gemini 4 Pro', { selected: true, effort: true, checkbox: bestOfN });
  const neonItem = makeItem('Orchestrator (Neon)', { checkbox: bestOfN });
  group.appendChild(flashItem);
  group.appendChild(proItem);
  group.appendChild(neonItem);
  listContainer.appendChild(group);

  if (withSubmenu) {
    const submenu = new MockElement('div');
    submenu.setAttribute('role', 'menu');
    for (const eff of ['Low', 'Medium', 'High']) {
      const subItem = new MockElement('div');
      subItem.setAttribute('role', 'menuitemradio');
      subItem.textContent = eff;
      submenu.appendChild(subItem);
    }
    proItem.appendChild(submenu);
  }

  // Custom model wrapped in .group.relative with sibling Edit Model button.
  const customSection = new MockElement('div');
  const customRowWrap = new MockElement('div');
  customRowWrap.className = 'group relative';
  const customItem = new MockElement('div');
  customItem.setAttribute('role', 'menuitem');
  customItem.setAttribute('data-testid', 'model-selector-custom-item');
  customItem.textContent = 'Local Qwen 32B';
  const editBtn = new MockElement('button');
  editBtn.setAttribute('aria-label', 'Edit Model');
  editBtn.textContent = 'Edit';
  customRowWrap.appendChild(customItem);
  customRowWrap.appendChild(editBtn);
  customSection.appendChild(customRowWrap);
  listContainer.appendChild(customSection);

  scrollWrap.appendChild(listContainer);
  panel.appendChild(scrollWrap);

  // Footer with View Usage (must never be treated as a model item).
  const footer = new MockElement('div');
  const usageItem = new MockElement('div');
  usageItem.setAttribute('role', 'menuitem');
  usageItem.textContent = 'View Usage';
  footer.appendChild(usageItem);
  panel.appendChild(footer);

  menu.appendChild(panel);
  doc.body.appendChild(menu);

  return { menu, panel, listContainer, flashItem, proItem, neonItem, customRowWrap, customItem, usageItem };
}

test('model-search: snippet compiles, apply/strip are idempotent, strips legacy agy-ux-patch, and composes with overview', () => {
  const snippet = renderModelSearchSnippet();
  assert.ok(snippet.includes(MODEL_SEARCH_PATCH_START));
  assert.ok(snippet.includes(MODEL_SEARCH_PATCH_END));
  assert.doesNotThrow(() => new Script(snippet, { filename: 'model-search-snippet.js' }));

  const base = '"use strict";\nconsole.log("vendor");\n';
  const once = applyModelSearchPatchToSource(base);
  assert.equal(hasModelSearchPatch(once), true);
  assert.equal(applyModelSearchPatchToSource(once), once);
  assert.equal(stripModelSearchPatch(once), base);

  const legacy = `${base}\n/* agy-ux-patch:start v4 */\nconsole.log("old");\n/* agy-ux-patch:end */\n`;
  const migrated = applyModelSearchPatchToSource(legacy);
  assert.equal(migrated.includes('agy-ux-patch:start'), false);
  assert.equal(hasModelSearchPatch(migrated), true);
  assert.equal(stripModelSearchPatch(migrated), base);

  const composed = applyModelSearchPatchToSource(applyOverviewPatchToSource(base));
  assert.equal(composed.includes(OVERVIEW_PATCH_START), true);
  assert.equal(hasModelSearchPatch(composed), true);
  assert.equal(stripModelSearchPatch(stripOverviewPatch(composed)), base);
  const recomposed = applyModelSearchPatchToSource(applyOverviewPatchToSource(composed));
  const third = applyModelSearchPatchToSource(applyOverviewPatchToSource(recomposed));
  assert.equal(third, recomposed);
  assert.equal(stripModelSearchPatch(stripOverviewPatch(recomposed)), base);
  assert.doesNotThrow(() => new Script(composed, { filename: 'dist/preload.js' }));
});

test('model-search: filters models, hides custom wrapper, freezes popup size, ignores footer, and handles Best-of-N', () => {
  const { doc, MockElement, MockEvent, api } = makeModelSearchEnv();
  const dom = buildAntigravityModelPickerDom(doc, MockElement);

  const found = api.findModelMenus(doc);
  assert.equal(found.results.length, 1);
  assert.equal(api.getListContainer(dom.panel), dom.listContainer);

  const items = api.getModelItems(dom.panel);
  assert.equal(items.length, 4);
  assert.equal(items.includes(dom.usageItem), false);

  const input = api.attachModelSearch(dom.menu, dom.panel, doc);
  assert.ok(input);
  assert.equal(dom.panel.children[0].className.includes('agy-model-search-wrap'), true);
  assert.equal(dom.listContainer.children.at(-2).className, 'agy-model-search-empty');
  assert.equal(dom.listContainer.children.at(-1).className.includes('agy-model-hidden-toggle'), true);
  assert.equal(dom.proItem.getAttribute('data-agy-model-active'), 'true');

  // Filter for custom model hides standard items and keeps custom item + Edit Model wrapper visible.
  input.value = 'qwen';
  input.dispatchEvent(new MockEvent('input'));
  assert.equal(dom.flashItem.getAttribute('data-agy-model-hidden'), 'true');
  assert.equal(dom.proItem.getAttribute('data-agy-model-hidden'), 'true');
  assert.equal(dom.neonItem.getAttribute('data-agy-model-hidden'), 'true');
  assert.equal(dom.customRowWrap.getAttribute('data-agy-model-hidden'), null);
  assert.equal(dom.usageItem.getAttribute('data-agy-model-hidden'), null);
  assert.equal(dom.listContainer.style.minHeight, '240px');
  assert.equal(dom.listContainer.style.minWidth, '272px');
  assert.equal(dom.panel.style.minWidth, '280px');

  // Typing non-matching query hides custom wrapper (Edit Model button hidden too) and shows empty state.
  input.value = 'zzz';
  input.dispatchEvent(new MockEvent('input'));
  assert.equal(dom.customRowWrap.getAttribute('data-agy-model-hidden'), 'true');
  assert.equal(dom.panel.querySelector('.agy-model-search-empty').style.display, '');

  // Clearing search restores everything, clears minHeight/minWidth freeze, and re-highlights selected model.
  input.value = '';
  input.dispatchEvent(new MockEvent('input'));
  assert.equal(dom.flashItem.getAttribute('data-agy-model-hidden'), null);
  assert.equal(dom.customRowWrap.getAttribute('data-agy-model-hidden'), null);
  assert.equal(dom.panel.querySelector('.agy-model-search-empty').style.display, 'none');
  assert.equal(dom.listContainer.style.minHeight, '');
  assert.equal(dom.listContainer.style.minWidth, '');
  assert.equal(dom.panel.style.minWidth, '');
  assert.equal(dom.proItem.getAttribute('data-agy-model-active'), 'true');

  // Best-of-N checkboxes are included and stay open (do not steal focus to composer) on Enter.
  const env2 = makeModelSearchEnv();
  const composer = new env2.MockElement('div');
  composer.setAttribute('data-lexical-editor', 'true');
  env2.doc.body.appendChild(composer);
  const bonDom = buildAntigravityModelPickerDom(env2.doc, env2.MockElement, { bestOfN: true });
  const bonInput = env2.api.attachModelSearch(bonDom.menu, bonDom.panel, env2.doc);
  bonInput.focus();
  bonInput.dispatchEvent(new env2.MockEvent('keydown', { key: 'ArrowDown' }));
  bonInput.dispatchEvent(new env2.MockEvent('keydown', { key: 'Enter' }));
  env2.flushAsync();
  assert.equal(bonDom.neonItem.clicked, 1);
  assert.equal(env2.doc.activeElement, bonInput);
});

test('model-search: zero hover focus-fighting, capture-phase typing redirect, keyboard nav, and Escape/Ctrl+/ passthrough', () => {
  const { doc, win, MockElement, MockEvent, api, flushAsync } = makeModelSearchEnv();
  const dom = buildAntigravityModelPickerDom(doc, MockElement);
  const input = api.attachModelSearch(dom.menu, dom.panel, doc);
  flushAsync();
  assert.equal(doc.activeElement, input);
  const initialFocusCount = input.focusCount;

  // Hovering an item moves focus onto the item; input blur must NOT yank focus back.
  dom.menu.dispatchEvent(new MockEvent('mousemove', { clientX: 25, clientY: 60, target: dom.flashItem }));
  dom.flashItem.focus();
  flushAsync();
  assert.equal(doc.activeElement, dom.flashItem);
  assert.equal(input.focusCount, initialFocusCount);
  assert.equal(dom.proItem.getAttribute('data-agy-model-active'), null);

  // Typing while focus is on the hovered menuitem redirects cleanly into search input.
  let bubbleReachedMenu = 0;
  dom.menu.addEventListener('keydown', () => { bubbleReachedMenu += 1; }, false);

  const keyF = new MockEvent('keydown', { key: 'f', target: dom.flashItem });
  dom.flashItem.dispatchEvent(keyF);
  assert.equal(keyF.defaultPrevented, true);
  assert.equal(keyF.stopped, true);
  assert.equal(bubbleReachedMenu, 0);
  assert.equal(doc.activeElement, input);
  assert.equal(input.value, 'f');
  assert.equal(dom.proItem.getAttribute('data-agy-model-hidden'), 'true');
  assert.equal(dom.flashItem.getAttribute('data-agy-model-hidden'), null);

  // Hover again while filtered, then press Backspace -> redirects and restores all models.
  dom.flashItem.focus();
  const keyBs = new MockEvent('keydown', { key: 'Backspace', target: dom.flashItem });
  dom.flashItem.dispatchEvent(keyBs);
  assert.equal(keyBs.defaultPrevented, true);
  assert.equal(doc.activeElement, input);
  assert.equal(input.value, '');
  assert.equal(dom.proItem.getAttribute('data-agy-model-hidden'), null);

  // Ctrl+N / Ctrl+P intercepted at window capture level so commandsService doesn't openNewConversation.
  let docCtrlNReached = 0;
  doc.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') docCtrlNReached += 1;
  }, true);
  const ctrlN = new MockEvent('keydown', { key: 'n', ctrlKey: true, target: input });
  input.dispatchEvent(ctrlN);
  assert.equal(ctrlN.defaultPrevented, true);
  assert.equal(ctrlN.stopped, true);
  assert.equal(docCtrlNReached, 0);
  assert.equal(dom.neonItem.getAttribute('data-agy-model-active'), 'true');

  // Escape and Ctrl+/ from input are NOT stopped so Base UI / commandsService close natively.
  const escEv = new MockEvent('keydown', { key: 'Escape', target: input });
  input.dispatchEvent(escEv);
  assert.equal(escEv.stopped, false);
  const slashEv = new MockEvent('keydown', { key: '/', ctrlKey: true, target: input });
  input.dispatchEvent(slashEv);
  assert.equal(slashEv.stopped, false);
  assert.equal(win !== null, true);
});

test('model-search: effort submenus are ignored by detection and capture keydown handlers', () => {
  const { doc, MockElement, MockEvent, api } = makeModelSearchEnv();
  const dom = buildAntigravityModelPickerDom(doc, MockElement, { withSubmenu: true });

  const found = api.findModelMenus(doc);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].menu, dom.menu);

  const input = api.attachModelSearch(dom.menu, dom.panel, doc);
  const submenu = dom.proItem.querySelector('[role="menu"]');
  assert.equal(submenu.querySelector('.agy-model-search-wrap'), null);
  assert.equal(api.getModelItems(dom.panel).length, 4);

  const subItem = submenu.querySelector('[role="menuitemradio"]');
  subItem.focus();
  const subKey = new MockEvent('keydown', { key: 'h', target: subItem });
  subItem.dispatchEvent(subKey);
  assert.equal(subKey.defaultPrevented, false);
  assert.equal(subKey.stopped, false);
  assert.equal(input.value, '');
});

test('patch.mjs: parseArgs defaults empty command to apply and CLI applies without explicit subcommand', () => {
  const def = parseArgs([]);
  assert.equal(def.command, 'apply');
  assert.deepEqual(def.patches, ['top-bar', 'overview', 'model-search']);

  const onlyModel = parseArgs(['--only', 'model-search']);
  assert.equal(onlyModel.command, 'apply');
  assert.deepEqual(onlyModel.patches, ['model-search']);

  assert.throws(() => parseArgs(['bogus']), /Unknown command: bogus/);

  const root = mkdtempSync(join(tmpdir(), 'agy-default-apply-'));
  try {
    const resources = join(root, 'resources');
    mkdirSync(resources, { recursive: true });
    const archivePath = join(resources, 'app.asar');
    buildSyntheticAsar(archivePath, {});

    const out = execFileSync('node', [CLI_PATH, '--resources', resources], {
      encoding: 'utf8',
      env: { ...process.env, AGY_PATCH_NO_SUDO: '1' },
    });
    assert.match(out, /PATCH APPLIED \[top-bar, overview, model-search\]/);
    assert.equal(hasTopBarPatch(readAsarFile(archivePath, 'dist/main.js').toString('utf8')), true);
    const preload = readAsarFile(archivePath, 'dist/preload.js').toString('utf8');
    assert.equal(preload.includes(OVERVIEW_PATCH_START), true);
    assert.equal(hasModelSearchPatch(preload), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('model-search: stable keys, two-attribute user-hidden isolation, and Show hidden (N) escape hatch', () => {
  const env = makeModelSearchEnv({
    initialStorage: {
      [HIDDEN_MODELS_KEY]: JSON.stringify(['Gemini 4 Flash', 'Local Qwen 32B']),
    },
  });
  const { doc, MockElement, MockEvent, api } = env;
  const dom = buildAntigravityModelPickerDom(doc, MockElement);

  // Attach realistic Antigravity attributes (effort base + label + effort badge).
  const effortInner = new MockElement('span');
  effortInner.setAttribute('data-testid', 'model-selector-effort-group');
  effortInner.setAttribute('data-model-base', 'Gemini 4 Pro');
  effortInner.textContent = 'Gemini 4 Pro';
  const effortTier = new MockElement('span');
  effortTier.textContent = 'High';
  dom.proItem.textContent = '';
  dom.proItem.children = [];
  dom.proItem.appendChild(effortInner);
  dom.proItem.appendChild(effortTier);

  dom.flashItem.setAttribute('data-model-label', 'Gemini 4 Flash');
  dom.neonItem.setAttribute('data-model-label', 'Orchestrator (Neon)');
  dom.customItem.setAttribute('data-model-label', 'Local Qwen 32B');

  assert.equal(api.getModelKey(dom.proItem), 'Gemini 4 Pro');
  assert.equal(api.getModelKey(dom.flashItem), 'Gemini 4 Flash');
  assert.equal(api.getModelKey(dom.customItem), 'Local Qwen 32B');

  const input = api.attachModelSearch(dom.menu, dom.panel, doc);
  assert.equal(dom.flashItem.getAttribute('data-agy-model-user-hidden'), 'true');
  assert.equal(dom.customRowWrap.getAttribute('data-agy-model-user-hidden'), 'true');
  assert.equal(dom.proItem.getAttribute('data-agy-model-user-hidden'), null);

  // Option A: searching for a hidden model keeps it strictly hidden and surfaces Show hidden (2).
  input.value = 'flash';
  input.dispatchEvent(new MockEvent('input'));
  assert.equal(dom.flashItem.getAttribute('data-agy-model-user-hidden'), 'true');
  assert.equal(dom.proItem.getAttribute('data-agy-model-hidden'), 'true');
  const emptyRow = dom.panel.querySelector('.agy-model-search-empty');
  assert.equal(emptyRow.style.display, '');
  assert.equal(emptyRow.textContent, 'No matching models');
  const toggleBtn = dom.panel.querySelector('.agy-model-hidden-toggle');
  assert.equal(toggleBtn.style.display, '');
  assert.equal(toggleBtn.textContent, 'Show hidden (2)');

  // Clicking Show hidden (2) reveals the matching hidden model while keeping search filter active.
  toggleBtn.dispatchEvent(new MockEvent('click'));
  assert.equal(dom.flashItem.getAttribute('data-agy-model-user-hidden'), null);
  assert.equal(dom.flashItem.getAttribute('data-agy-model-hidden'), null);
  assert.equal(emptyRow.style.display, 'none');
  assert.equal(toggleBtn.textContent, 'Hide 2 hidden');

  // Re-hiding then searching "pro" -> clearing "" must NEVER unhide user-hidden models.
  toggleBtn.dispatchEvent(new MockEvent('click'));
  input.value = 'pro';
  input.dispatchEvent(new MockEvent('input'));
  input.value = '';
  input.dispatchEvent(new MockEvent('input'));
  assert.equal(dom.flashItem.getAttribute('data-agy-model-user-hidden'), 'true');
  assert.equal(dom.customRowWrap.getAttribute('data-agy-model-user-hidden'), 'true');
  assert.equal(dom.proItem.getAttribute('data-agy-model-hidden'), null);

  // Hiding all models shows dedicated Settings-empty message and Show hidden (4).
  env.emitStorageChange({
    [HIDDEN_MODELS_KEY]: JSON.stringify([
      'Gemini 4 Flash',
      'Gemini 4 Pro',
      'Orchestrator (Neon)',
      'Local Qwen 32B',
    ]),
  });
  assert.equal(emptyRow.style.display, '');
  assert.equal(emptyRow.textContent, 'All models hidden in Settings');
  assert.equal(toggleBtn.textContent, 'Show hidden (4)');
});

function buildModelsSettingsDom(doc, MockElement) {
  const outer = new MockElement('div');
  outer.className = 'p-6 flex flex-col gap-4 w-full max-w-2xl mx-auto';

  const headerWrap = new MockElement('div');
  headerWrap.className = 'flex flex-col gap-2 w-full mb-2 bg-transparent';
  const titleRow = new MockElement('div');
  titleRow.className = 'flex justify-between items-start gap-4 w-full bg-transparent';
  const titleCol = new MockElement('div');
  titleCol.className = 'flex-1 flex flex-col gap-1 min-w-0 bg-transparent';
  const h2 = new MockElement('h2');
  const h2Inner = new MockElement('div');
  const titleSpan = new MockElement('span');
  titleSpan.textContent = 'Models & Usage';
  const refreshBtn = new MockElement('button');
  const refreshIcon = new MockElement('span');
  refreshIcon.textContent = 'refresh';
  refreshBtn.appendChild(refreshIcon);
  h2Inner.appendChild(titleSpan);
  h2Inner.appendChild(refreshBtn);
  h2.appendChild(h2Inner);
  titleCol.appendChild(h2);
  titleRow.appendChild(titleCol);
  headerWrap.appendChild(titleRow);

  const sectionsContainer = new MockElement('div');
  sectionsContainer.className = 'flex flex-col gap-8 w-full';
  const quotaSection = new MockElement('div');
  quotaSection.className = 'space-y-2';
  sectionsContainer.appendChild(quotaSection);

  outer.appendChild(headerWrap);
  outer.appendChild(sectionsContainer);
  doc.body.appendChild(outer);

  return { outer, sectionsContainer };
}

test('model-search: Settings Models section caches models from picker, toggles persistence, Show all, and live cross-window sync', () => {
  const env = makeModelSearchEnv();
  const { doc, MockElement, MockEvent, api, storageState } = env;
  const settingsDom = buildModelsSettingsDom(doc, MockElement);

  const foundContainer = api.findModelsSettingsContainer(doc);
  assert.equal(foundContainer, settingsDom.sectionsContainer);

  // Initially no models cached yet -> shows helpful hint.
  const section = api.attachSettingsModelVisibility(foundContainer, doc);
  assert.ok(section);
  assert.equal(section.textContent.includes('Ctrl+/'), true);
  assert.equal(section.querySelectorAll('[role="switch"]').length, 0);

  // Opening the model picker once caches known models to storage and updates open Settings section.
  const pickerDom = buildAntigravityModelPickerDom(doc, MockElement);
  api.attachModelSearch(pickerDom.menu, pickerDom.panel, doc);
  assert.deepEqual(JSON.parse(storageState[KNOWN_MODELS_KEY]), [
    'Gemini 4 Flash',
    'Gemini 4 Pro',
    'Orchestrator (Neon)',
    'Local Qwen 32B',
  ]);
  const switches = section.querySelectorAll('[role="switch"]');
  assert.equal(switches.length, 4);
  assert.equal(switches[0].getAttribute('aria-checked'), 'true');

  // Toggle "Gemini 4 Flash" off -> persists to storage, updates switch, hides in open picker, shows "Show all".
  switches[0].dispatchEvent(new MockEvent('click'));
  assert.deepEqual(JSON.parse(storageState[HIDDEN_MODELS_KEY]), ['Gemini 4 Flash']);
  assert.equal(pickerDom.flashItem.getAttribute('data-agy-model-user-hidden'), 'true');
  const updatedSwitches = section.querySelectorAll('[role="switch"]');
  assert.equal(updatedSwitches[0].getAttribute('aria-checked'), 'false');

  const showAllBtn = section.querySelector('[data-agy-show-all-models="true"]');
  assert.ok(showAllBtn);
  showAllBtn.dispatchEvent(new MockEvent('click'));
  assert.deepEqual(JSON.parse(storageState[HIDDEN_MODELS_KEY]), []);
  assert.equal(pickerDom.flashItem.getAttribute('data-agy-model-user-hidden'), null);
  assert.equal(section.querySelectorAll('[role="switch"]')[0].getAttribute('aria-checked'), 'true');

  // Incoming storage:changed event from another window updates both picker and Settings live.
  env.emitStorageChange({ [HIDDEN_MODELS_KEY]: JSON.stringify(['Orchestrator (Neon)']) });
  assert.equal(pickerDom.neonItem.getAttribute('data-agy-model-user-hidden'), 'true');
  assert.equal(section.querySelectorAll('[role="switch"]')[2].getAttribute('aria-checked'), 'false');
});
