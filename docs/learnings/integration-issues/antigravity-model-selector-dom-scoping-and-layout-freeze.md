---
title: Antigravity Model Selector DOM Scoping and Side-Top Layout Freeze
category: integration-issues
module: desktop-patch/lib/model-search.mjs
tags: [antigravity, model-selector, dom, css, layout, desktop-patch, preload]
problem_type: integration-issue
date: 2026-11-24
---

# Antigravity Model Selector DOM Scoping and `side="top"` Layout Freeze

## Problem

Heuristic menu detection and naive item filtering corrupt Antigravity Desktop's model selector popup (`n0c`/`l0c`/`Qdd`/`Rdd` in Hub `main.js`), hijacking `Thinking effort` submenus, hiding or breaking footer/custom controls, and collapsing the upward-anchored popup under the user's cursor.

## Symptoms

- Hovering effort-tier models (e.g., `Gemini 4 Pro`) injects a second search bar inside the nested `Low`/`Medium`/`High` submenu.
- Filtering hides the footer `View Usage` item (`Rdd`), or hides a custom model while leaving its sibling `Edit Model` button visible (`d0c`).
- Best-of-N checkboxes (`[role="menuitemcheckbox"]`) are skipped by `[role="menuitem"]`-only queries, and typing a query collapses the `placement="top-start"` (`!w-max`) menu downward.

## What Didn't Work

- **Keyword matching on any `[role="menu"]` / `[role="listbox"]`:** Matches submenus and unrelated menus opened right after `Ctrl+/`.
- **Querying all `[role="menuitem"]` inside `[role="menu"]` and prepending to `initialItems[0].parentElement`:** Prepending inside the React-rendered group container (`Pdd`) puts the search box below the `"Model"` header and forces the query to include footer items outside the scroll list.
- **Toggling `display: none` directly without freezing dimensions:** Collapses `side="top"` menus while typing, generating spurious pointer motion over shifted rows.

## Solution

1. **Exact panel targeting (`desktop-patch/lib/model-search.mjs`):** Detect only `[role="menu"]` containing `[data-testid="model-selector-panel"]`, skip while `[data-testid="model-selector-loading"]` is present (re-scanning via `MutationObserver` once populated), prepend `.agy-model-search-wrap` directly inside `[data-testid="model-selector-panel"]`, and append `.agy-model-search-empty` inside the scroll container (`[data-testid="model-selector-header"]?.parentElement` fallback `.overflow-y-auto`).
2. **Strict item & wrapper scoping:** Query `[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]` only inside the scroll container where `el.closest('[role="menu"]') === menu`, ignoring `Thinking effort` submenus and footer `View Usage`. When hiding `[data-testid="model-selector-custom-item"]` paired with `button[aria-label="Edit Model"]`, toggle `data-agy-model-hidden="true"` on the `.group.relative` parent. Detect the active item via `[data-testid="menu-item-check"]` alongside `aria-checked`/`aria-selected`/`data-state="checked"`.
3. **Dimension freeze while filtering:** Capture `offsetHeight`/`offsetWidth` of the scroll container and panel before hiding items, apply `minHeight`/`minWidth` while `input.value.trim()` is non-empty, and clear them when cleared (mirroring Antigravity's native `JW` component).

Related event/focus handling: [Base UI Menu Hover-Focus and Typeahead Fight Injected Search Inputs Unless Routed via Capture Keydown](./base-ui-menu-hover-focus-and-typeahead-search-injection.md).

## Why This Works

Scoping to `[data-testid="model-selector-panel"]` and `[data-testid="model-selector-header"]` isolates the patch cleanly from submenus, footers, and `@` mention pickers without brittle model-name regexes, while freezing `minHeight`/`minWidth` keeps the `top-start` popup anchored in place during incremental typing.

## Prevention

Keep `patch.test.mjs` fixtures mirroring `Qdd`/`Rdd`/`d0c`/`h0c` DOM (`model-selector-panel`, `model-selector-header`, `.group.relative` custom items with `Edit Model`, `[role="menuitemcheckbox"]`, nested `Thinking effort` submenu, and `View Usage` footer) and assert size freeze/unfreeze and wrapper hiding on every edit.

## References

0
