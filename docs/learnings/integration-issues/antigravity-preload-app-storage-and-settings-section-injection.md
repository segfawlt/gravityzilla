---
title: Antigravity Preload Features Must Persist via App Storage IPC and Mount Outside Async Settings Sections
category: integration-issues
module: desktop-patch/lib/model-search.mjs
tags: [antigravity, electron, ipc, storage, settings, preload, localstorage, desktop-patch]
problem_type: integration-issue
date: 2026-11-24
---

# Antigravity Preload Features Must Persist via App Storage IPC and Mount Outside Async Settings Sections

## Problem

Electron preload patches in `dist/preload.js` cannot rely on browser `localStorage` or quota-screen data to persist and configure model picker visibility in Antigravity Desktop's **Settings → Models** screen (`$Vb` / `YU` in Hub `main.js`).

## Symptoms

- `localStorage` preferences disappear after every Antigravity restart because the local server rotates its port (`https://127.0.0.1:<port>/`).
- Settings → Models only receives async quota buckets (`YVb`), omitting non-quota or custom models (such as `Orchestrator (Neon)` and local custom models).
- Matching the Settings screen by `h2.textContent.trim() === 'Models & Usage'` misses because the inline `<sx name="refresh">` icon ligature renders `"Models & Usagerefresh"`.
- Sharing one hidden attribute between user preferences and search filtering causes clearing the search box to restore hidden models.

## What Didn't Work

- **Origin `localStorage`:** Every app launch assigns a new localhost port, creating a fresh browser storage origin.
- **Reusing `[data-agy-model-hidden="true"]` for both user hiding and search:** `filterItems()` toggles `data-agy-model-hidden` on every keystroke and removes it when the query is cleared.
- **Scraping Settings → Models quota cards:** Misses custom models and non-bucket models, and collides with React re-renders inside the async `Model Quota` container (`retrieveUserQuotaSummary`).

## Solution

1. **Persist via Electron `app_storage.json` IPC (`desktop-patch/lib/model-search.mjs`):** Use `ipcRenderer.sendSync('storage:get-items-sync')`, `ipcRenderer.invoke('storage:get-items')`, `ipcRenderer.invoke('storage:update-items', changes)`, and `ipcRenderer.on('storage:changed', ...)` (exposed unconditionally by `dist/ipcHandlers.js` and `dist/storage.js` with no key allowlist) for `agy-model-picker-hidden` and `agy-model-picker-known`. This survives restarts and syncs toggles live across windows.
2. **Cache known models from the picker via stable keys:** On picker mount, record ordered keys from `[data-model-base]` (stable across `Low`/`Medium`/`High` effort changes) or `[data-model-label]` into `agy-model-picker-known`, and show a `"Press Ctrl+/ once"` prompt in Settings when empty.
3. **Mount cleanly in `YU`'s sections container:** Match `h2` via `h2.querySelector('span')?.textContent?.trim() === 'Models & Usage'` (or `/^Models\s*&\s*Usage\b/i`), walk ancestors to find the sibling `.flex.flex-col.gap-8` sections container, and append `[data-agy-model-visibility-section="true"]` as the last child using Antigravity's native `.agy-card` and `role="switch"` classes.
4. **Isolate visibility with two attributes:** Apply `[data-agy-model-user-hidden="true"]` independently from `[data-agy-model-hidden="true"]`, keep hidden models excluded during search, and expose a non-`menuitem` `"Show hidden (N)"` footer button in the picker to prevent lockout.

Related model picker DOM rules: [Antigravity Model Selector DOM Scoping and `side="top"` Layout Freeze](./antigravity-model-selector-dom-scoping-and-layout-freeze.md).

## Why This Works

`dist/storage.js` stores key-value pairs in a single port-independent file (`~/.config/Antigravity/app_storage.json`) and broadcasts `storage:changed` to all open Hub windows, while mounting outside React's async `Model Quota` subtree keeps injected Settings switches intact across quota refreshes.

## Prevention

Verify with `desktop-patch/tests/patch.test.mjs`: `Models & Usagerefresh` heading detection, empty-cache hint before first `Ctrl+/`, `storage:changed` cross-window sync, and search-clear preservation of `[data-agy-model-user-hidden="true"]`.

## References

0
