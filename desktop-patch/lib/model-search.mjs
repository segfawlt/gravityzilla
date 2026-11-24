// Sandbox-safe Electron preload helper for model selector search and Settings-based model visibility filtering.
export const MODEL_SEARCH_PATCH_START = '/* agy-model-search-patch:start v1 */';
export const MODEL_SEARCH_PATCH_END = '/* agy-model-search-patch:end */';
export const HIDDEN_MODELS_KEY = 'agy-model-picker-hidden';
export const KNOWN_MODELS_KEY = 'agy-model-picker-known';

const LEGACY_UX_PATCH_RE = /\/\* agy-ux-patch:start[^*]*\*\/[\s\S]*?\/\* agy-ux-patch:end \*\//g;

/** Return true if dist/preload.js already contains the agy-model-search-patch block. */
export function hasModelSearchPatch(source) {
  return source.includes(MODEL_SEARCH_PATCH_START) && source.includes(MODEL_SEARCH_PATCH_END);
}

/** Strip any agy-model-search-patch (and legacy agy-ux-patch) blocks from dist/preload.js source. */
export function stripModelSearchPatch(source) {
  let out = source.replace(LEGACY_UX_PATCH_RE, '');
  const startIdx = out.indexOf(MODEL_SEARCH_PATCH_START);
  const endIdx = out.indexOf(MODEL_SEARCH_PATCH_END);
  if (startIdx === -1 && endIdx === -1) {
    if (out === source) return out;
    const cleaned = out.replace(/\r?\n{3,}/g, '\n\n').replace(/\s+$/, '');
    return cleaned ? `${cleaned}\n` : '';
  }
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('Corrupt agy-model-search-patch marker block in dist/preload.js');
  }
  const before = out.slice(0, startIdx).replace(/\r?\n+$/, '');
  const after = out.slice(endIdx + MODEL_SEARCH_PATCH_END.length).replace(/^\r?\n+/, '');
  if (!before) return after ? `${after}\n` : '';
  if (!after) return `${before}\n`;
  return `${before}\n${after}`;
}

/** Build the self-contained, sandbox-safe preload snippet appended to dist/preload.js. */
export function renderModelSearchSnippet() {
  return `${MODEL_SEARCH_PATCH_START}
(() => {
  'use strict';
  const testApi = typeof globalThis !== 'undefined' ? globalThis.__AGY_MODEL_SEARCH_TEST__ : undefined;
  const isSsh =
    typeof process !== 'undefined' &&
    Array.isArray(process.argv) &&
    process.argv.some((a) => typeof a === 'string' && a.startsWith('--agy-backend=ssh'));
  if (isSsh && !testApi) return;
  const proto = typeof window !== 'undefined' && window.location ? window.location.protocol : '';
  if (proto !== 'http:' && proto !== 'https:') return;

  const STYLE_ID = 'agy-model-search-style';
  const HIDDEN_MODELS_KEY = ${JSON.stringify(HIDDEN_MODELS_KEY)};
  const KNOWN_MODELS_KEY = ${JSON.stringify(KNOWN_MODELS_KEY)};
  const PANEL_SELECTOR = '[data-testid="model-selector-panel"]';
  const LOADING_SELECTOR = '[data-testid="model-selector-loading"]';
  const HEADER_SELECTOR = '[data-testid="model-selector-header"]';
  const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
  const WRAP_CLASS = 'agy-model-search-wrap';
  const INPUT_CLASS = 'agy-model-search-input';
  const EMPTY_CLASS = 'agy-model-search-empty';
  const HIDDEN_TOGGLE_CLASS = 'agy-model-hidden-toggle';

  let activeController = null;
  let activeSettingsSection = null;
  let winListenerInstalled = false;
  let hiddenModels = new Set();
  let knownModels = [];

  function resolveStorage() {
    if (testApi?.storage) return testApi.storage;
    try {
      const electron = typeof require === 'function' ? require('electron') : null;
      const ipc = electron?.ipcRenderer;
      if (!ipc) return null;
      return {
        getItemsSync: () => ipc.sendSync('storage:get-items-sync'),
        getItems: () => ipc.invoke('storage:get-items'),
        updateItems: (changes) => ipc.invoke('storage:update-items', changes),
        onChanged: (callback) => {
          const handler = (_event, changes) => callback(changes);
          ipc.on('storage:changed', handler);
          return () => ipc.removeListener('storage:changed', handler);
        },
      };
    } catch {
      return null;
    }
  }

  const storage = resolveStorage();

  function parseStringList(raw) {
    let arr = [];
    if (Array.isArray(raw)) {
      arr = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        arr = [];
      }
    }
    const seen = new Set();
    const out = [];
    for (const v of arr) {
      const s = typeof v === 'string' ? v.trim() : '';
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  function syncStorageItems(items) {
    if (!items || typeof items !== 'object') return;
    if (Object.hasOwn(items, HIDDEN_MODELS_KEY)) {
      hiddenModels =
        items[HIDDEN_MODELS_KEY] == null
          ? new Set()
          : new Set(parseStringList(items[HIDDEN_MODELS_KEY]));
    }
    if (Object.hasOwn(items, KNOWN_MODELS_KEY)) {
      knownModels =
        items[KNOWN_MODELS_KEY] == null ? [] : parseStringList(items[KNOWN_MODELS_KEY]);
    }
  }

  function refreshOpenViews() {
    if (typeof document === 'undefined') return;
    if (activeController && document.body?.contains?.(activeController.menu)) {
      activeController.refresh?.();
    }
    if (activeSettingsSection && document.body?.contains?.(activeSettingsSection.container)) {
      activeSettingsSection.render?.();
    }
  }

  function saveHiddenModels() {
    try {
      Promise.resolve(
        storage?.updateItems?.({ [HIDDEN_MODELS_KEY]: JSON.stringify([...hiddenModels]) }),
      ).catch(() => {});
    } catch {}
  }

  function syncKnownModels(keys) {
    const next = parseStringList(keys);
    if (next.length === 0) return;
    if (JSON.stringify(next) === JSON.stringify(knownModels)) return;
    knownModels = next;
    if (
      typeof document !== 'undefined' &&
      activeSettingsSection &&
      document.body?.contains?.(activeSettingsSection.container)
    ) {
      activeSettingsSection.render?.();
    }
    try {
      Promise.resolve(
        storage?.updateItems?.({ [KNOWN_MODELS_KEY]: JSON.stringify(next) }),
      ).catch(() => {});
    } catch {}
  }

  let storageSubscribed = false;
  function loadStorage() {
    if (!storage) return;
    try {
      if (typeof storage.getItemsSync === 'function') {
        const syncItems = storage.getItemsSync();
        if (syncItems && typeof syncItems === 'object') {
          syncStorageItems(syncItems);
        }
      }
    } catch {}
    if (typeof storage.getItems === 'function') {
      Promise.resolve(storage.getItems())
        .then((items) => {
          if (items && typeof items === 'object') {
            syncStorageItems(items);
            refreshOpenViews();
          }
        })
        .catch(() => {});
    }
    if (!storageSubscribed && typeof storage.onChanged === 'function') {
      storageSubscribed = true;
      storage.onChanged((changes) => {
        if (!changes || typeof changes !== 'object') return;
        if (Object.hasOwn(changes, HIDDEN_MODELS_KEY) || Object.hasOwn(changes, KNOWN_MODELS_KEY)) {
          syncStorageItems(changes);
          refreshOpenViews();
        }
      });
    }
  }

  function ensureStyles(doc = document) {
    if (!doc || doc.getElementById?.(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = \`
      [data-agy-model-hidden="true"],
      [data-agy-model-user-hidden="true"] {
        display: none !important;
      }
      .\${WRAP_CLASS} {
        flex-shrink: 0;
        padding: 6px;
        border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.22));
      }
      .\${INPUT_CLASS} {
        width: 100%;
        box-sizing: border-box;
        padding: 5px 8px;
        font-size: 12px;
        line-height: 1.4;
        border-radius: 6px;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
        background: var(--secondary, rgba(128, 128, 128, 0.12));
        color: var(--foreground, inherit);
        outline: none !important;
        box-shadow: none !important;
      }
      .\${INPUT_CLASS}:focus {
        border-color: var(--ring, rgba(128, 128, 128, 0.65));
        outline: none !important;
        box-shadow: none !important;
      }
      .\${EMPTY_CLASS} {
        padding: 10px 8px;
        font-size: 12px;
        opacity: 0.65;
        text-align: center;
        user-select: none;
      }
      .\${HIDDEN_TOGGLE_CLASS} {
        display: block;
        width: 100%;
        padding: 6px 8px;
        margin-top: 2px;
        font-size: 11px;
        line-height: 1.3;
        border: none;
        border-top: 1px solid var(--border, rgba(128, 128, 128, 0.18));
        background: transparent;
        color: var(--muted-foreground, rgba(128, 128, 128, 0.85));
        text-align: center;
        cursor: pointer;
        user-select: none;
        outline: none !important;
        box-shadow: none !important;
      }
      .\${HIDDEN_TOGGLE_CLASS}:hover {
        color: var(--foreground, inherit);
      }
      [data-agy-model-active="true"] {
        background: var(--secondary, rgba(128, 128, 128, 0.22)) !important;
        color: var(--foreground, inherit);
      }
    \`;
    (doc.head || doc.documentElement)?.appendChild?.(style);
  }

  function isVisibleElement(el) {
    if (!el || el.hidden) return false;
    if (el.getAttribute?.('data-state') === 'closed') return false;
    if (el.getAttribute?.('aria-hidden') === 'true') return false;
    if (el.closest?.('[hidden], [aria-hidden="true"], [data-state="closed"]')) return false;
    if (typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
    }
    return true;
  }

  function focusComposerAfterClose(doc = document) {
    const composers = [...(doc.querySelectorAll?.('[data-lexical-editor="true"]') || [])];
    const target = composers.find(
      (el) =>
        isVisibleElement(el) &&
        !el.closest?.('[data-side-panel-open], [role="dialog"], [role="menu"], [role="listbox"]'),
    );
    if (!target) return;
    if (doc.activeElement === target || target.contains?.(doc.activeElement)) return;
    target.focus?.({ preventScroll: true });
  }

  function getListContainer(panel) {
    if (!panel) return null;
    const header = panel.querySelector?.(HEADER_SELECTOR);
    if (header?.parentElement && panel.contains?.(header.parentElement)) {
      return header.parentElement;
    }
    const firstItem = panel.querySelector?.(
      '[data-testid="model-selector-item"], [data-testid="model-selector-effort-group"], [data-testid="model-selector-custom-item"], [role="menuitemcheckbox"]',
    );
    const scrollAncestor = firstItem?.closest?.('.overflow-y-auto');
    if (scrollAncestor && panel.contains?.(scrollAncestor)) {
      return scrollAncestor;
    }
    for (const child of panel.children || []) {
      if (!child.classList?.contains?.(WRAP_CLASS)) return child;
    }
    return panel;
  }

  function getHideTarget(item) {
    if (
      item?.getAttribute?.('data-testid') === 'model-selector-custom-item' &&
      item.parentElement?.querySelector?.('button[aria-label="Edit Model"]')
    ) {
      return item.parentElement;
    }
    return item;
  }

  function getModelKey(el) {
    if (!el) return '';
    const base =
      el.getAttribute?.('data-model-base') ||
      el.querySelector?.('[data-testid="model-selector-effort-group"]')?.getAttribute?.('data-model-base');
    if (base && base.trim()) return base.trim();
    const label = el.getAttribute?.('data-model-label');
    if (label && label.trim()) return label.trim();
    const trunc = el.querySelector?.('.truncate')?.textContent;
    if (trunc && trunc.trim()) return trunc.trim();
    return (el.textContent || '').trim();
  }

  function getModelItems(panel) {
    if (!panel) return [];
    const menu = panel.closest?.('[role="menu"]');
    const listContainer = getListContainer(panel);
    if (!listContainer) return [];

    const candidates = [...listContainer.querySelectorAll(ITEM_SELECTOR)].filter(
      (el) => !el.closest?.(\`.\${WRAP_CLASS}, .\${EMPTY_CLASS}\`),
    );

    const eligible = candidates.filter((el) => {
      if (menu && el.closest?.('[role="menu"]') !== menu) return false;
      if (el.getAttribute?.('aria-disabled') === 'true' || el.disabled) return false;
      const txt = (el.textContent || '').trim();
      if (!txt) return false;
      if (el.closest?.('[data-agy-model-hidden="true"], [data-agy-model-user-hidden="true"]')) return true;
      if (el.getAttribute?.('aria-hidden') === 'true' || el.hidden) return false;
      if (el.style?.display === 'none') return false;
      if (typeof getComputedStyle === 'function' && getComputedStyle(el).display === 'none') return false;
      return true;
    });

    return eligible.filter((el) => !eligible.some((other) => other !== el && other.contains?.(el)));
  }

  function findModelMenus(doc = document) {
    const panels = [...(doc.querySelectorAll?.(PANEL_SELECTOR) || [])];
    const results = [];
    let hasLoading = false;
    for (const panel of panels) {
      const menu = panel.closest?.('[role="menu"]');
      if (!menu) continue;
      if (menu.hasAttribute?.('data-agy-model-search-attached')) continue;
      if (panel.querySelector?.(\`.\${WRAP_CLASS}\`)) continue;
      if (panel.querySelector?.(LOADING_SELECTOR)) {
        hasLoading = true;
        continue;
      }
      if (getModelItems(panel).length === 0) continue;
      results.push({ menu, panel });
    }
    return { results, hasLoading };
  }

  function findModelsSettingsContainer(doc = document) {
    const headings = [...(doc.querySelectorAll?.('h2') || [])];
    for (const h2 of headings) {
      const spanText = h2.querySelector?.('span')?.textContent?.trim() || '';
      const rawText = (h2.textContent || '').trim();
      if (spanText !== 'Models & Usage' && !/^Models\\s*&\\s*Usage\\b/i.test(rawText)) {
        continue;
      }
      let cur = h2.parentElement;
      for (let depth = 0; depth < 6 && cur; depth += 1) {
        const parent = cur.parentElement;
        if (parent) {
          for (const child of parent.children || []) {
            if (
              child !== cur &&
              child.classList?.contains?.('flex') &&
              child.classList?.contains?.('flex-col') &&
              child.classList?.contains?.('gap-8')
            ) {
              return child;
            }
          }
        }
        cur = parent;
      }
    }
    return null;
  }

  function attachSettingsModelVisibility(sectionsContainer, doc = document) {
    if (!sectionsContainer) return null;
    const existing = sectionsContainer.querySelector?.('[data-agy-model-visibility-section="true"]');
    if (existing) {
      if (activeSettingsSection?.section === existing) {
        activeSettingsSection.render();
      }
      return existing;
    }

    ensureStyles(doc);
    const section = doc.createElement('div');
    section.setAttribute('data-agy-model-visibility-section', 'true');
    section.className = 'space-y-2';

    function render() {
      section.textContent = '';
      if (Array.isArray(section.children)) section.children.length = 0;

      const hiddenInKnown = knownModels.filter((k) => hiddenModels.has(k)).length;
      const visibleCount = knownModels.length - hiddenInKnown;

      const headWrap = doc.createElement('div');
      headWrap.className = 'flex flex-col gap-1';

      const topRow = doc.createElement('div');
      topRow.className = 'flex items-center justify-between';

      const leftGroup = doc.createElement('div');
      leftGroup.className = 'flex items-center gap-1.5';

      const titleEl = doc.createElement('h3');
      titleEl.className = 'm-0 font-medium';
      titleEl.textContent = 'Model Picker Visibility';
      leftGroup.appendChild(titleEl);

      if (knownModels.length > 0) {
        const badge = doc.createElement('span');
        badge.className =
          'text-[10px] font-semibold leading-none bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-full select-none border border-border';
        badge.textContent = \`\${visibleCount}/\${knownModels.length}\`;
        leftGroup.appendChild(badge);
      }

      topRow.appendChild(leftGroup);

      if (hiddenInKnown > 0 || hiddenModels.size > 0) {
        const showAllBtn = doc.createElement('button');
        showAllBtn.type = 'button';
        showAllBtn.setAttribute('data-agy-show-all-models', 'true');
        showAllBtn.className =
          'no-focus-ring text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0';
        showAllBtn.textContent = 'Show all';
        showAllBtn.addEventListener('click', () => {
          hiddenModels.clear();
          saveHiddenModels();
          render();
          activeController?.refresh?.();
        });
        topRow.appendChild(showAllBtn);
      }

      headWrap.appendChild(topRow);

      const subtitle = doc.createElement('div');
      subtitle.className = 'text-sm text-muted-foreground leading-relaxed';
      subtitle.textContent = 'Choose which models appear in the model selector (Ctrl+/).';
      headWrap.appendChild(subtitle);
      section.appendChild(headWrap);

      const card = doc.createElement('div');
      card.className =
        'agy-card bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border';

      if (knownModels.length === 0) {
        const emptyHint = doc.createElement('div');
        emptyHint.className = 'py-2 px-3 text-sm text-muted-foreground';
        emptyHint.textContent =
          'No models cached yet. Press Ctrl+/ once to open the model picker and load your models.';
        card.appendChild(emptyHint);
      } else {
        for (const key of knownModels) {
          const isVisible = !hiddenModels.has(key);
          const row = doc.createElement('div');
          row.setAttribute('data-agy-model-visibility-row', key);
          row.className = 'py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center';

          const labelWrap = doc.createElement('div');
          labelWrap.className = 'flex-1 flex flex-col gap-0.5 min-w-0';
          const labelSpan = doc.createElement('span');
          labelSpan.className = isVisible ? 'text-foreground truncate' : 'text-muted-foreground truncate';
          labelSpan.textContent = key;
          labelWrap.appendChild(labelSpan);

          const sw = doc.createElement('button');
          sw.type = 'button';
          sw.setAttribute('role', 'switch');
          sw.setAttribute('aria-checked', String(isVisible));
          sw.setAttribute('aria-label', \`Show \${key}\`);
          sw.className = \`no-focus-ring relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out shrink-0 h-6 w-11 cursor-pointer \${
            isVisible ? 'bg-primary' : 'bg-secondary'
          }\`;

          const thumb = doc.createElement('span');
          thumb.className =
            'inline-block rounded-full bg-white transition-transform duration-200 ease-in-out shadow-sm h-4 w-4';
          thumb.style.transform = isVisible ? 'translateX(24px)' : 'translateX(4px)';
          sw.appendChild(thumb);

          sw.addEventListener('click', () => {
            if (hiddenModels.has(key)) hiddenModels.delete(key);
            else hiddenModels.add(key);
            saveHiddenModels();
            render();
            activeController?.refresh?.();
          });

          row.appendChild(labelWrap);
          row.appendChild(sw);
          card.appendChild(row);
        }
      }

      section.appendChild(card);
    }

    sectionsContainer.appendChild(section);
    activeSettingsSection = { container: sectionsContainer, section, render };
    render();
    return section;
  }

  function installWindowController(doc = document) {
    if (winListenerInstalled || typeof window === 'undefined' || !window.addEventListener) return;
    winListenerInstalled = true;
    window.addEventListener(
      'keydown',
      (e) => {
        if (!activeController) return;
        if (!doc.body?.contains?.(activeController.menu)) {
          activeController = null;
          return;
        }
        if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
        if (k !== 'n' && k !== 'p') return;
        const active = doc.activeElement;
        if (!active || !activeController.menu.contains?.(active)) return;
        const activeMenu = active.closest?.('[role="menu"]');
        if (activeMenu && activeMenu !== activeController.menu) return;
        e.preventDefault();
        e.stopPropagation();
        activeController.move(k === 'n' ? 1 : -1);
      },
      true,
    );
  }

  function attachModelSearch(menu, panel, doc = document) {
    if (!menu || !panel) return null;
    if (menu.hasAttribute?.('data-agy-model-search-attached')) return null;
    if (panel.querySelector?.(\`.\${WRAP_CLASS}\`)) return null;
    const listContainer = getListContainer(panel);
    const initialItems = getModelItems(panel);
    if (!listContainer || initialItems.length === 0) return null;

    installWindowController(doc);
    menu.setAttribute('data-agy-model-search-attached', 'true');
    syncKnownModels(initialItems.map(getModelKey));

    const wrap = doc.createElement('div');
    wrap.className = \`\${WRAP_CLASS} no-focus-ring\`;
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = \`\${INPUT_CLASS} no-focus-ring\`;
    input.placeholder = 'Search model...';
    input.setAttribute('aria-label', 'Search model');
    input.autocomplete = 'off';
    input.spellcheck = false;
    wrap.appendChild(input);

    const emptyRow = doc.createElement('div');
    emptyRow.className = EMPTY_CLASS;
    emptyRow.textContent = 'No matching models';
    emptyRow.style.display = 'none';

    const hiddenToggleBtn = doc.createElement('button');
    hiddenToggleBtn.type = 'button';
    hiddenToggleBtn.className = \`\${HIDDEN_TOGGLE_CLASS} no-focus-ring\`;
    hiddenToggleBtn.style.display = 'none';

    panel.prepend(wrap);
    listContainer.appendChild(emptyRow);
    listContainer.appendChild(hiddenToggleBtn);

    let activeIdx = 0;
    let userHoveredItem = false;
    let revealHidden = false;
    let lastPointer = { x: -1, y: -1 };
    let savedListHeight = null;
    let savedListWidth = null;
    let savedPanelWidth = null;

    function getVisibleItems() {
      return getModelItems(panel).filter((el) => {
        const hideTarget = getHideTarget(el);
        return (
          hideTarget.getAttribute?.('data-agy-model-hidden') !== 'true' &&
          hideTarget.getAttribute?.('data-agy-model-user-hidden') !== 'true'
        );
      });
    }

    function updateHighlight() {
      const all = getModelItems(panel);
      for (const el of all) el.removeAttribute('data-agy-model-active');
      const vis = getVisibleItems();
      if (!vis.length) {
        activeIdx = 0;
        return;
      }
      if (activeIdx < 0) activeIdx = vis.length - 1;
      if (activeIdx >= vis.length) activeIdx = 0;
      const target = vis[activeIdx];
      target.setAttribute('data-agy-model-active', 'true');
      target.scrollIntoView?.({ block: 'nearest' });
    }

    function selectDefaultIndex(vis) {
      const idx = vis.findIndex(
        (el) =>
          el.getAttribute?.('aria-checked') === 'true' ||
          el.getAttribute?.('aria-selected') === 'true' ||
          el.getAttribute?.('data-state') === 'checked' ||
          Boolean(
            el.querySelector?.(
              '[aria-checked="true"], [data-state="checked"], [data-testid="menu-item-check"]',
            ),
          ),
      );
      return idx >= 0 ? idx : 0;
    }

    function applyFrozenSize(active) {
      if (active) {
        if (savedListHeight) listContainer.style.minHeight = \`\${savedListHeight}px\`;
        if (savedListWidth) listContainer.style.minWidth = \`\${savedListWidth}px\`;
        if (savedPanelWidth) panel.style.minWidth = \`\${savedPanelWidth}px\`;
      } else {
        savedListHeight = null;
        savedListWidth = null;
        savedPanelWidth = null;
        listContainer.style.minHeight = '';
        listContainer.style.minWidth = '';
        panel.style.minWidth = '';
      }
    }

    function filterItems() {
      const raw = input.value.trim();
      const tokens = raw ? raw.toLowerCase().split(/\\s+/).filter(Boolean) : [];
      if (tokens.length > 0) {
        if (!savedListHeight && listContainer.offsetHeight > 0) savedListHeight = listContainer.offsetHeight;
        if (!savedListWidth && listContainer.offsetWidth > 0) savedListWidth = listContainer.offsetWidth;
        if (!savedPanelWidth && panel.offsetWidth > 0) savedPanelWidth = panel.offsetWidth;
      }

      const all = getModelItems(panel);
      let hiddenCount = 0;
      let visibleCount = 0;
      for (const el of all) {
        const key = getModelKey(el);
        const isUserHidden = key ? hiddenModels.has(key) : false;
        if (isUserHidden) hiddenCount += 1;

        const target = getHideTarget(el);
        if (isUserHidden && !revealHidden) {
          target.setAttribute('data-agy-model-user-hidden', 'true');
          target.removeAttribute('data-agy-model-hidden');
          continue;
        }
        target.removeAttribute('data-agy-model-user-hidden');

        const txt = (el.textContent || '').toLowerCase();
        const match = tokens.length === 0 || tokens.every((tok) => txt.includes(tok));
        if (match) {
          target.removeAttribute('data-agy-model-hidden');
          visibleCount += 1;
        } else {
          target.setAttribute('data-agy-model-hidden', 'true');
        }
      }

      if (hiddenCount === 0) revealHidden = false;
      applyFrozenSize(tokens.length > 0);
      emptyRow.textContent =
        tokens.length === 0 && hiddenCount > 0 && !revealHidden
          ? 'All models hidden in Settings'
          : 'No matching models';
      emptyRow.style.display = visibleCount === 0 ? '' : 'none';

      hiddenToggleBtn.style.display = hiddenCount > 0 ? '' : 'none';
      if (hiddenCount > 0) {
        hiddenToggleBtn.textContent = revealHidden
          ? \`Hide \${hiddenCount} hidden\`
          : \`Show hidden (\${hiddenCount})\`;
      }

      const vis = getVisibleItems();
      activeIdx = tokens.length === 0 ? selectDefaultIndex(vis) : 0;
      updateHighlight();
    }

    function moveHighlight(delta) {
      activeIdx += delta;
      updateHighlight();
    }

    function activateCurrent() {
      const vis = getVisibleItems();
      const chosen = vis[activeIdx];
      if (!chosen) return;
      const isCheckbox = chosen.getAttribute?.('role') === 'menuitemcheckbox';
      chosen.click();
      if (!isCheckbox) {
        setTimeout(() => {
          if (!doc.body?.contains?.(menu) || !isVisibleElement(menu)) {
            focusComposerAfterClose(doc);
          }
        }, 60);
      }
    }

    hiddenToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealHidden = !revealHidden;
      filterItems();
      input.focus?.({ preventScroll: true });
    });

    menu.addEventListener(
      'mousemove',
      (e) => {
        const cx = typeof e.clientX === 'number' ? e.clientX : 0;
        const cy = typeof e.clientY === 'number' ? e.clientY : 0;
        if (lastPointer.x !== -1 && Math.abs(cx - lastPointer.x) < 2 && Math.abs(cy - lastPointer.y) < 2) {
          return;
        }
        lastPointer = { x: cx, y: cy };
        if (wrap.contains?.(e.target)) return;
        const item = e.target?.closest?.(ITEM_SELECTOR);
        if (item && item.closest?.('[role="menu"]') === menu && listContainer.contains?.(item)) {
          userHoveredItem = true;
          const vis = getVisibleItems();
          const idx = vis.indexOf(item);
          if (idx >= 0) activeIdx = idx;
          for (const el of getModelItems(panel)) el.removeAttribute('data-agy-model-active');
        }
      },
      true,
    );

    menu.addEventListener(
      'pointerdown',
      (e) => {
        if (!wrap.contains?.(e.target)) userHoveredItem = true;
      },
      true,
    );

    ['keyup', 'keypress', 'input'].forEach((ev) => {
      input.addEventListener(ev, (e) => e.stopPropagation());
    });

    input.addEventListener('input', () => {
      filterItems();
    });

    menu.addEventListener(
      'keydown',
      (e) => {
        const closestMenu = e.target?.closest?.('[role="menu"]');
        if (closestMenu && closestMenu !== menu) return;

        if (e.target === input) {
          if (e.key === 'Escape') {
            setTimeout(() => {
              if (!doc.body?.contains?.(menu) || !isVisibleElement(menu)) {
                focusComposerAfterClose(doc);
              }
            }, 60);
            return;
          }
          if (e.key === 'Tab') return;
          if ((e.ctrlKey || e.metaKey) && e.key === '/') return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            moveHighlight(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            moveHighlight(-1);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            activateCurrent();
          } else {
            e.stopPropagation();
          }
          return;
        }

        if (
          typeof e.key === 'string' &&
          e.key.length === 1 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          e.stopPropagation();
          input.focus?.({ preventScroll: true });
          input.value += e.key;
          input.setSelectionRange?.(input.value.length, input.value.length);
          filterItems();
          return;
        }

        if (
          e.key === 'Backspace' &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          input.value.length > 0
        ) {
          e.preventDefault();
          e.stopPropagation();
          input.focus?.({ preventScroll: true });
          input.value = input.value.slice(0, -1);
          input.setSelectionRange?.(input.value.length, input.value.length);
          filterItems();
          return;
        }

        if (
          input.value.trim().length > 0 &&
          (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')
        ) {
          e.preventDefault();
          e.stopPropagation();
          input.focus?.({ preventScroll: true });
          if (e.key === 'ArrowDown') moveHighlight(1);
          else if (e.key === 'ArrowUp') moveHighlight(-1);
          else activateCurrent();
        }
      },
      true,
    );

    activeController = {
      menu,
      input,
      move(delta) {
        if (doc.activeElement !== input) input.focus?.({ preventScroll: true });
        moveHighlight(delta);
      },
      refresh() {
        filterItems();
      },
    };

    filterItems();

    const grabFocus = () => {
      if (doc.body?.contains?.(input) && !userHoveredItem && doc.activeElement !== input) {
        input.focus?.({ preventScroll: true });
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(grabFocus);
    setTimeout(grabFocus, 35);

    return input;
  }

  let watchingLoading = false;

  function scanPage(doc = document) {
    const { results, hasLoading } = findModelMenus(doc);
    watchingLoading = hasLoading;
    for (const { menu, panel } of results) {
      attachModelSearch(menu, panel, doc);
    }
    const settingsContainer = findModelsSettingsContainer(doc);
    if (settingsContainer) {
      attachSettingsModelVisibility(settingsContainer, doc);
    }
  }

  function recordTouchesTarget(rec) {
    const sel = \`\${PANEL_SELECTOR}, [role="menu"], h2\`;
    for (const n of rec.addedNodes || []) {
      if (n.nodeType === 1 && (n.matches?.(sel) || n.querySelector?.(sel))) return true;
    }
    return false;
  }

  function boot() {
    loadStorage();
    ensureStyles(document);
    installWindowController(document);
    scanPage(document);

    const root = document.body || document.documentElement;
    if (typeof MutationObserver !== 'undefined' && root) {
      let pending = false;
      let rafScheduled = false;
      const flush = () => {
        rafScheduled = false;
        if (!pending) return;
        pending = false;
        scanPage(document);
      };
      const mo = new MutationObserver((records) => {
        if (watchingLoading) {
          pending = true;
        } else {
          for (const rec of records) {
            if (rec.type === 'childList' && recordTouchesTarget(rec)) {
              pending = true;
              break;
            }
          }
        }
        if (pending && !rafScheduled) {
          rafScheduled = true;
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(flush);
          } else {
            setTimeout(flush, 0);
          }
        }
      });
      mo.observe(root, { childList: true, subtree: true });
    }
  }

  if (testApi) {
    if (testApi.storage) loadStorage();
    Object.assign(testApi, {
      findModelMenus,
      getListContainer,
      getModelItems,
      getModelKey,
      attachModelSearch,
      findModelsSettingsContainer,
      attachSettingsModelVisibility,
      syncStorageItems,
      getActiveController: () => activeController,
    });
  }

  if (!testApi?.skipAutoBoot) {
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
})();
${MODEL_SEARCH_PATCH_END}`;
}

/** Return dist/preload.js source with the current agy-model-search-patch snippet cleanly appended. */
export function applyModelSearchPatchToSource(source) {
  const clean = stripModelSearchPatch(source).replace(/\s+$/, '');
  return `${clean}\n\n${renderModelSearchSnippet()}\n`;
}
