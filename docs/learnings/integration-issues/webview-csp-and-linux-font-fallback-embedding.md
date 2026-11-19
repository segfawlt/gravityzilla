---
title: Host CSP blocks external fonts and Linux webviews fall back to Noto Sans without embedded WOFF2
category: integration-issues
module: config/plugins/margin
tags: [fonts, typography, inter, webview, sidecar, csp, fontconfig, linux]
problem_type: integration-issue
date: 2026-11-19
---

# Host Webview CSP & Linux OS Fallbacks Require Inlined Base64 Font Embedding

## Problem

In Antigravity Desktop auxiliary pane webviews and MCP Apps:
1. Setting `--font: 'Inter', -apple-system, system-ui, sans-serif` or `--font: 'Google Sans', Roboto, sans-serif` failed to render the requested font on Linux desktops, falling back to heavy, wide system defaults (`Noto Sans` or `Liberation Sans`).
2. Attempting to load web fonts via `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` or `@import url(...)` is blocked by the host webview Content Security Policy (CSP), which prevents external styles and font fetching in sandboxed aux panes.

## Root Causes (`Observed`)

1. Linux desktop installations (e.g. Arch Linux, Debian minimal) rarely install Google Sans, Inter, or SF Pro as system packages (`fc-list` only returned `Noto Sans` and `Liberation Sans`).
2. CSS `system-ui` and `-apple-system` resolve to the local OS fontconfig default (`Noto Sans`) on Linux. When the primary font (`Inter` or `Google Sans`) is not locally installed, browser rendering engines immediately fall back to `Noto Sans`.
3. Sandboxed Electron webviews and MCP App iframes enforce strict local-origin CSPs that disallow external domain requests (`fonts.googleapis.com`, `fonts.gstatic.com`), making remote CDN font loading non-viable both online and offline.

## Solution

1. **Embedded Inlined WOFF2 Data URI (`config/plugins/margin/app/fonts.css`):**
   - Download the variable WOFF2 font binary covering weights 100–900 (e.g., `Inter` variable latin subset, ~85KB).
   - Encode the binary as a base64 `data:font/woff2;base64,...` URI inside an `@font-face` declaration.
   - Concatenate `fonts.css` with `app.css` in `appHtml()` so the stylesheet is completely self-contained. `data:` URIs inside inlined stylesheets bypass network CSP blocks and render offline instantly without FOIT/FOUT.
2. **Local Fontconfig Sync:**
   - Write the `.woff2` file to `~/.local/share/fonts/` and run `fc-cache -f ~/.local/share/fonts` so the entire desktop environment and host Antigravity Electron process recognize the font family.
3. **Typography & Metric Tuning (`app.css`):**
   - Use `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif`.
   - Set `font-variant-numeric: tabular-nums` and reduce telemetry chip font-size to `11px` with negative tracking (`letter-spacing: -0.02em`) to avoid layout overflows in narrow sidebars.

## Verification

- Captured Chromium headless screenshots (`380x800`) against the live sidecar (`http://localhost:46729/`) before and after embedding. Confirmed pixel-perfect rendering of `Inter` typography without scrollbar clipping.
- Verified `fc-list : family | grep -i inter` returned `Inter`.
- All 16 unit tests passed (`node --test config/plugins/margin/tests/`).
- `avoid-ai-design` linter: 0 findings.
