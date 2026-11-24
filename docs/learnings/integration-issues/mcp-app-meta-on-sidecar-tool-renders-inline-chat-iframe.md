---
title: Leaving _meta.ui.resourceUri on a sidecar-backed MCP tool renders unwanted inline chat iframes
category: integration-issues
module: config/plugins/margin/mcp/server.mjs
tags: [antigravity, mcp-apps, sidecar, aux-pane, chat-scroll, iframes, margin]
problem_type: integration-issue
date: 2026-11-25
---

# Leaving `_meta.ui.resourceUri` on a Sidecar-Backed MCP Tool Renders Unwanted Inline Chat Iframes

## Problem

After Antigravity Desktop `44.9.1` enabled MCP Apps support, every `margin_intent` tool call began embedding a live Margin Overview `<iframe>` inline inside the chat message stream (`[data-testid="autoscroll-viewport"]`). Users saw duplicate Overview cards mid-conversation and experienced intermittent upward chat scrolling while at the bottom.

## Symptoms

- Every `margin_intent` step inside the chat transcript expanded an interactive MCP App card (`s5b` / `mcpTool` with `appView.resourceUri`).
- The inline `<iframe>` loaded `ui://margin/overview.html`, firing `ui/notifications/size-changed` resizes and `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` inside `app.js`, which destabilized the chat auto-scroll viewport (`FX`).

## Root Cause

When Margin previously moved its UI to an HTTP UI Sidecar (`sidecars/margin/`) because `enable-mcp-apps` had been disabled in earlier builds, `mcp/server.mjs` kept `_meta.ui.resourceUri = 'ui://margin/overview.html'`, `_meta['com.google.antigravity/ui'].entrypoints`, the `margin_overview` app-only tool, `structuredContent`, and `resources/list` / `resources/read` handlers as a fallback. Once Antigravity `44.9.1` activated `s5b` (`a.step.case === "mcpTool" && !!a.step.value?.appView?.resourceUri`), that dormant `_meta.ui` triggered inline chat iframe rendering on every tool invocation.

## Solution

Strip all MCP App UI metadata and resource endpoints from data-only MCP servers whose UI lives in a right-pane sidecar:

1. Remove `_meta` (`ui.resourceUri` and `'com.google.antigravity/ui'`) from `margin_intent` in [server.mjs](file:///home/domixi/Projects/gravityzilla/config/plugins/margin/mcp/server.mjs).
2. Remove `OVERVIEW_TOOL` (`margin_overview`), `structuredContent` payloads, and `resources/list` / `resources/read` handlers, returning `capabilities: { tools: {} }` from `initialize`.
3. Keep `appHtml()` exported for [main.mjs](file:///home/domixi/Projects/gravityzilla/config/plugins/margin/sidecars/margin/main.mjs), so the right-side Overview tab continues rendering cleanly without touching the chat stream.
4. Assert `intent._meta === undefined` and `capabilities` equals `['tools']` in [margin.test.mjs](file:///home/domixi/Projects/gravityzilla/config/plugins/margin/tests/margin.test.mjs#L529-L567).

## Prevention

Never keep `_meta.ui.resourceUri` on a bookkeeping or data-only MCP tool as a "harmless" fallback when a plugin uses a UI Sidecar (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`). Only declare `_meta.ui` when you explicitly want every tool call to render an interactive widget inside chat.

Related: [Antigravity Desktop right-sidebar tabs require UI Sidecars when enable-mcp-apps is off](./antigravity-aux-pane-sidecar-vs-mcp-apps.md).
