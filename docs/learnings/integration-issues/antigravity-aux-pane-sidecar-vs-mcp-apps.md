---
title: Antigravity Desktop right-sidebar tabs require UI Sidecars when enable-mcp-apps is off (plus auxPane camelCase mismatch)
category: integration-issues
module: config/plugins/margin
tags: [antigravity, sidecar, mcp-apps, aux-pane, ui-plugins, language-server, mendel]
problem_type: integration-issue
date: 2026-11-19
---

# Antigravity Desktop Right-Sidebar Tabs Require UI Sidecars When `enable-mcp-apps` Is Off

## Problem

A plugin implemented solely as an MCP App (`ui://` resource + `_meta["com.google.antigravity/ui"].entrypoints`) did not appear in Antigravity Desktop's right-hand auxiliary pane (`+` menu or auto-open), even after the MCP server (`margin_margin`) reached `MCP_SERVER_STATUS_READY` and `margin_intent` completed successfully via `call_mcp_tool`.

## Root Causes

1. **`enable-mcp-apps` Mendel experiment is disabled in Antigravity Desktop builds:**
   - Querying `GetMendelFlags` on the running Language Server reports:
     `{"keyString": "enable-mcp-apps", "disabled": true, "source": "EXPERIMENT_SOURCE_LANGUAGE_SERVER"}`.
   - Calling `GetMcpAppResource` returns `failed_precondition: MCP Apps support is not enabled`.
   - Consequently, the host ignores `_meta.ui` and `_meta["com.google.antigravity/ui"].entrypoints` on MCP tools.
2. **Entrypoint casing mismatch in MCP Apps docs vs. Go binary:**
   - `mcp-app-development/SKILL.md` documents `"type": "aux_pane"`, whereas `language_server`'s `mcpcore.parseEntrypoints` strictly accepts `"auxPane"`, `"global"`, or `"file"` (`mcp server %q tool %q: unsupported entrypoint %q (want "auxPane", "global" or "file")`).
3. **Sidecars are the active auxiliary-pane mechanism:**
   - Electron spawns `language_server` with `--enable_sidecars` and mounts `plugin://` (`remoteSidecars.js`); `enable-sidecars`, `enable-ui-sidecars`, `enable-sidecar-sdk`, and `sidecar-gateway` are all enabled.

## Solution

Add a UI sidecar (`sidecars/margin/sidecar.json` + `main.mjs`) alongside `mcp/server.mjs` and share the `app/` frontend across both transports:

1. Declare `"has_web_ui": true` and `"entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE"` in `sidecars/<name>/sidecar.json`.
2. Serve the HTML page via `SidecarApp` (`sidecar_sdk`), injecting `<script src="/preload.js"></script>` when rendered for the sidecar so `window.sidecar` (`conversationId`, `fetch` with `X-Sidecar-Token`, theme CSS variables `--background`, `--foreground`, etc.) is active.
3. Have `app.js` detect `window.sidecar || /^https?:$|^plugin:$/.test(location.protocol)` to poll `/api/overview` over HTTP with ETag caching (`resolveOverview`).
4. Do NOT leave `_meta.ui.resourceUri` or `_meta["com.google.antigravity/ui"]` on a sidecar-only MCP tool once the sidecar is active (as of Antigravity `44.9.1`, `_meta.ui` embeds an inline iframe into every chat turn; see [Leaving `_meta.ui.resourceUri` on a sidecar-backed MCP tool renders unwanted inline chat iframes](./mcp-app-meta-on-sidecar-tool-renders-inline-chat-iframe.md)). When authoring an actual inline MCP App tool, keep camelCase `"auxPane"` in entrypoints.

## Verification

- `agy plugin validate --strict` outputs `mcpServers 1 · sidecars 1` and passes.
- `lsrpc GetSidecars '{}'` confirms `margin/margin` reaches `SIDECAR_STATUS_RUNNING` with `entrypoint: "SIDECAR_UI_ENTRYPOINT_AUX_PANE"` and serves live `/api/overview` JSON and `/preload.js` (HTTP 200) through the sidecar gateway.

Related: [Antigravity Desktop Side Panel Pin Tab Skips Auto-Open and Default Active Tab Selection](./antigravity-desktop-aux-pane-pin-vs-auto-open.md).
