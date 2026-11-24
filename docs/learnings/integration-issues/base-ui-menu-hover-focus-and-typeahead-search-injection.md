---
title: Base UI Menu Hover-Focus and Typeahead Fight Injected Search Inputs Unless Routed via Capture Keydown
category: integration-issues
module: desktop-patch/lib/model-search.mjs
tags: [base-ui, electron, preload, focus, typeahead, keydown, antigravity, desktop-patch]
problem_type: bug-fix
date: 2026-11-24
---

# Base UI Menu Hover-Focus and Typeahead Fight Injected Search Inputs Unless Routed via Capture Keydown

## Problem

Injecting a search `<input>` inside Antigravity Desktop's Base UI `[role="menu"]` popup (`n0c` / `wW` / `yW` in the Hub `main.js` bundle inside `/opt/Antigravity/resources/bin/language_server`) breaks keyboard typing and focus stability whenever the mouse moves over menu items.

## Symptoms

- Moving the pointer across menu rows repeatedly yanks focus back to the search bar and flashes focus rings.
- Typing after moving the mouse fails to reach `<input>` or triggers Base UI menu typeahead jumps instead of filtering.
- Pressing `Ctrl+N` inside the menu opens a new conversation instead of moving the highlight downward.

## What Didn't Work

- **Re-focusing on `input` `blur` (`setTimeout(() => input.focus(), 0)`):** Antigravity's `lTb.onMouseMove` and Base UI's `yXa` (`useListNavigation`) explicitly call `item.focus({ preventScroll: true })` on every pointer hover. Fighting that `blur` creates an infinite focus ping-pong loop between `<input>` and hovered items, and can disrupt `ZZa` (`Menu.SubmenuTrigger`) `onBlur` state.
- **Stop-propagation on `<input>` bubble phase alone:** Once mouse hover moves `document.activeElement` onto a `[role="menuitem"]`, keystrokes never reach `<input>`. They go straight to Base UI's `zXa` (`useTypeahead`) on `[role="menu"]`, which calls `preventDefault()` and `stopPropagation()`.
- **Handling `Ctrl+N`/`Ctrl+P` only on the menu:** Antigravity's `commandsService` (`nld`) binds capture listeners on `document.documentElement` and runs even inside `<input>` when `ctrlKey` is true, triggering `openNewConversation` before menu listeners run.

## Solution

1. **Drop `blur` focus reclamation (`desktop-patch/lib/model-search.mjs`):** Focus `<input>` once after attach (guarded by `!userHoveredItem`), apply `.no-focus-ring` plus `outline: none !important`, and let mouse hover focus items and open submenus freely. On real `mousemove` (`>= 2px` pointer delta), mark `userHoveredItem = true`, sync `activeIdx`, and clear `[data-agy-model-active]`.
2. **Capture-phase `keydown` redirect on `[role="menu"]`:** Ignore events whose `e.target.closest('[role="menu"]') !== menu` (preserving nested submenus). When `e.target === input`, stop propagation for normal typing/arrows/`Enter` while letting `Escape` (Base UI `Hx` dismiss), `Tab`, and `Ctrl+/` (`commandsService` toggle) pass through untouched. When `e.target !== input` (focus moved by hover), intercept printable characters, `Backspace` (when non-empty), and filtered `ArrowDown`/`ArrowUp`/`Enter` in capture phase, focus `<input>`, update `input.value`, and re-filter.
3. **Window-capture `Ctrl+N`/`Ctrl+P` guard:** Register one capture listener on `window` (ahead of `document.documentElement`) that intercepts `Ctrl+N`/`Ctrl+P` only while the model menu is connected and `document.activeElement` sits inside that root `[role="menu"]`.

Related Hub preload notes: [Antigravity Desktop Side Panel Pin Tab Skips Auto-Open and Default Active Tab Selection](./antigravity-desktop-aux-pane-pin-vs-auto-open.md) and [Antigravity Model Selector DOM Scoping and Layout Freeze](./antigravity-model-selector-dom-scoping-and-layout-freeze.md).

## Why This Works

Base UI's `FloatingFocusManager` (`Fx`) treats any element inside the floating `[role="menu"]` node as inside the focus scope (`Bw(y, la)`), so moving focus between `<input>` and `[role="menuitem"]` never triggers `focus-out` dismissal. Eliminating the `blur` loop lets native hover semantics work naturally, while capture-phase interception on `[role="menu"]` and `window` executes before Base UI `zXa`/`yXa` and `commandsService` `nld`.

## Prevention

Keep `patch.test.mjs` capture/bubble event dispatch tests exercising: `mousemove` + `blur` with zero follow-up `input.focus()` calls, capture-phase printable/`Backspace` redirection from a focused `[role="menuitem"]`, `Ctrl+N` blocking before `documentElement`, and `Escape`/`Ctrl+/` propagation passthrough.

## References

0
