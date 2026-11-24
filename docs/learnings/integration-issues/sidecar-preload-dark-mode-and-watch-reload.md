---
title: sidecar_sdk preload.js inline body styles break dark mode and ESM sidecars cache lib imports without --watch
category: integration-issues
module: config/plugins/margin
tags: [sidecar, sidecar_sdk, dark-mode, preload, node-watch, antigravity, css]
problem_type: integration-issue
date: 2026-11-19
---

# `sidecar_sdk` `/preload.js` Inline Styles Override Dark Theme & Sidecar ESM Module Caching

## Problem

Related: [Host theme-change inline :root CSS variables override sidecar --muted text tokens](./sidecar-host-css-variable-collision.md).

1. In an Antigravity Desktop `SIDECAR_UI_ENTRYPOINT_AUX_PANE` webview, CSS dark-mode `@media (prefers-color-scheme: dark)` rules rendered white text (`#e8eaed`) on a bright `#fafafa` background when the host ran dark theme on a light-OS desktop or before CSS variables arrived.
2. Updating helper modules (`lib/*.mjs`) imported by a running `sidecars/<name>/main.mjs` left the live sidecar serving stale cached ESM exports even after `RefreshMcpServers` or `app/*` static file edits.

## Root Causes (`Observed`)

1. `sidecar_sdk/preload.js` injects inline styles on `DOMContentLoaded`:
   `document.body.style.background = 'var(--background, #fafafa)'; document.body.style.color = 'var(--foreground, #333)';`
   Inline `body` styles take specificity precedence over normal `html, body` CSS rules whenever `--background` / `--foreground` have not yet been populated. Furthermore, host theme updates arrive via `window.postMessage({ type: 'theme-change', payload: { cssVariables } })` (without `jsonrpc: '2.0'`), which an MCP-App-only `postMessage` listener drops.
2. `SidecarManager` launches `node --import .../register_loader.js main.mjs` as a persistent daemon and only restarts the process when `sidecar.json` changes (whereas `lsrpc ManageSidecar` is `permission_denied` for `run_command` subprocesses).

## Solution

1. **Theme bridge & CSS precedence (`app/app.css` & `app/app.js`):**
   - Mirror `@media (prefers-color-scheme: dark)` under `:root[data-theme="dark"]`, guard `html, body` with `background: var(--bg) !important; color: var(--fg) !important;`, derive hover/raised/soft surfaces with `color-mix(in srgb, ...)`, and include `--on-accent` (`#202124` in dark mode) for badge contrast.
   - Intercept `m?.type === 'theme-change'` before any `jsonrpc !== '2.0'` filter, apply `m.payload?.cssVariables` to `:root`, and detect dark theme via `ctx.theme`, `colorScheme`, and computed `rgb()`/`#hex` luminance (`parseColorLum`) to toggle `data-theme="dark"`.
2. **Live reload on `lib/*.mjs` edits (`sidecars/margin/sidecar.json`):**
   - Set `"args": ["--watch", "main.mjs"]` in `sidecar.json`. Updating `sidecar.json` immediately triggers `SidecarManager.reloadSidecarConfig`, and Node `--watch` restarts `main.mjs` cleanly on future `lib/*.mjs` changes.

## Verification

- Verified `sidecars/margin/sidecar.json` restart on live Language Server (`lsrpc GetSidecars` -> `SIDECAR_STATUS_RUNNING` with `["--watch", "main.mjs"]`), confirmed live `/api/overview` returned updated backend fields (`stepProgress`, `context`, `watchdog`, `usedDetails`), and verified light/dark headless Chromium screenshots against the live sidecar URL.
