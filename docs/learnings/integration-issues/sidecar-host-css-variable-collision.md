---
title: Host theme-change inline :root CSS variables override sidecar --muted text tokens
category: integration-issues
module: config/plugins/margin
tags: [sidecar, sidecar_sdk, preload, css-variables, shadcn, contrast, margin]
problem_type: integration-issue
date: 2026-11-19
---

# Host `theme-change` Inline `:root` CSS Variables Override Sidecar `--muted` Text Tokens

## Problem

Secondary labels and telemetry text in `config/plugins/margin` (`Ask`, `Take`, `Plan`, `Result`, `Used`, `2/2 steps`, `.take-why`, completed steps, `Context`, `Watchdog`) rendered near-white and nearly unreadable in the Antigravity sidebar webview while rendering with normal `#596069` contrast when opened directly in a standalone browser.

Related margin sidecar integration notes: [sidecar_sdk preload.js inline body styles break dark mode and ESM sidecars cache lib imports without --watch](./sidecar-preload-dark-mode-and-watch-reload.md).

## Symptoms

- Primary foreground text (`var(--fg)`) rendered crisp and dark in both environments.
- Every rule using `color: var(--muted)` rendered near-white on the light sidebar background (`Observed` in sidebar screenshot), whereas opening the served HTML page directly in a browser displayed `--muted: #596069`.

## What Didn't Work

- Defining `--muted: #596069` under `:root, :root[data-theme="light"]` in `app/app.css` fails inside the Antigravity host iframe because inline styles set on `<html>` (`document.documentElement.style.setProperty(...)`) have higher specificity than `:root[...]` stylesheet selectors.

## Solution

1. **Rename colliding tokens (`config/plugins/margin/app/app.css`):**
   - Replace `--muted` and `--faint` with `--fg-muted` and `--fg-faint` across all declarations and `var(...)` usages.
2. **Scope palette blocks onto `body` (`config/plugins/margin/app/app.css`):**
   - Apply light, dark, and `@media (prefers-color-scheme: dark)` variable blocks to `body` as well as `:root` (for example `:root, body, :root[data-theme="light"], :root[data-theme="light"] body`) so inline properties written onto `<html>` cannot shadow descendant lookups.
3. **Strip colliding host variables (`config/plugins/margin/app/app.js`):**
   - Share `applyHostVariables()` between `applyHost()` and the `theme-change` listener, calling `root.style.removeProperty(k)` for protected tokens (`--muted`, `--faint`, `--fg-muted`, `--fg-faint`).
4. **Regression check (`config/plugins/margin/tests/margin.test.mjs`):**
   - Assert `appHtml({ sidecar: true })` scopes `--fg-muted` and `--fg-faint` onto `body` and `app.css` has no `var(--muted)` or `var(--faint)` references.

## Why This Works

`sidecar_sdk/preload.js` listens for `theme-change` `postMessage` events from the Antigravity host and injects every key of `event.data.payload.cssVariables` directly onto `document.documentElement.style`. Antigravity's host theme uses shadcn/Tailwind semantics where `--muted` is a near-white muted surface background color (and `--muted-foreground` is muted text). Standalone browser tabs receive no `theme-change` message, masking the collision outside the host sidebar. Renaming custom text tokens away from shadcn surface names and scoping theme variables onto `body` eliminates both the semantic collision and `:root` inline-style shadowing.

## Prevention

- In sidecar and MCP App UIs, never define `--muted`, `--accent`, `--card`, `--border`, `--background`, or `--foreground` with opposite semantics from shadcn/Tailwind tokens; either consume `--muted-foreground` directly or use distinct app-prefixed names (`--fg-muted`) scoped onto `body`.
- Keep a regression test verifying `app.css` does not consume `var(--muted)` when paired with `preload.js`.

## References

0
