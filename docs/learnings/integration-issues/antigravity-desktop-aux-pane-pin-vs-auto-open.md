---
title: Antigravity Desktop Side Panel Pin Tab Skips Auto-Open and Default Active Tab Selection
category: integration-issues
module: config/plugins/margin
tags: [antigravity, sidecar, aux-pane, preload, electron, state-machine, margin]
problem_type: integration-issue
date: 2026-11-20
---

# Antigravity Desktop Side Panel Pin Tab Skips Auto-Open and Default Active Tab Selection

## Problem

Even after registering a UI sidecar (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) and pinning it in the right-hand auxiliary pane (`aux-pane-v2-pinned-tabs`), opening a new conversation or draft in Antigravity Desktop leaves the right Side Panel closed and unselected. Related sidecar transport notes: [Antigravity Desktop right-sidebar tabs require UI Sidecars when enable-mcp-apps is off](./antigravity-aux-pane-sidecar-vs-mcp-apps.md).

## Root Causes

Observed directly in Antigravity Desktop `2.32.1` (`http://localhost:5387/main.js` and `~/.config/Antigravity/app_storage.json`):

1. **`sidecar.json` has no `auto_open` field:** `ui_config.views` only registers availability in the Side Panel `+` / Extensions menu.
2. **`isPaneOpen` defaults to `false` per conversation and draft:** The frontend Redux store (`sidePanel` / `sidePanelV2`, selectors `Ap` and `Bp`) keys pane visibility per `cascadeId` and per `newConversation` project ID (`conversationPanes[cascadeId]?.isPaneOpen ?? false`), so every new conversation starts closed.
3. **Active-tab selection explicitly excludes pinned tabs:** When choosing the initial tab without `?tab=` or a stored tab (`gxa` in `main.js`), the selector filters out `displayedPinnedIds` (`!c.has(h.id) && !h.pendingActivation`), leaving `data-active-tab-id="newTab__empty"` even when the panel opens.

## Solution

Inject a sandbox-safe Electron renderer preload hook (`config/plugins/margin/lib/overview-preload.mjs`) into `dist/preload.js` inside `/opt/Antigravity/resources/app.asar`:

1. **Seed the pin idempotently (`ensureOverviewPinned`):** Read `storage:get-items` and write `{"kind":"sidecar","sidecarId":"margin/margin","path":"/","title":"Overview"}` into `aux-pane-v2-pinned-tabs` only when missing, skipping remote SSH windows (`--agy-backend=ssh`) and non-HTTP origins.
2. **Route-keyed non-fighting state machine (`createOverviewAutoOpener`):**
   - Key views via `viewKeyFromLocation` into `new:<project|home>` (drafts) and `cascade:<id>` (conversations via `/c/<id>` or `/?cascadeId=<id>`), ignoring utility views (`/customizations`, `/history`, `/?settings=...`).
   - On first entry to a new conversation/draft (4s timeout bound), click `[data-testid="toggle-aux-sidebar"]` if `[data-side-panel-open]` is not `"true"`, then click `[data-tab-id="sidecar__margin/margin__/"]` if `[data-side-panel-strip]` is empty/`newTab__empty` or we just opened the panel.
   - Respect user intent: once handled for a `cascadeId` or current draft, manually closing the pane or switching tabs is preserved, and arriving at a pane already open on another tab (e.g., `Swarm`) never steals focus.

## Verification

- `node --test config/plugins/margin/tests/overview-patch.test.mjs` verifies pin idempotence, route classification, SSH/utility exclusions, non-fighting tab transitions, and `vm.Script` compilation of the rendered preload snippet (`23/23` total Margin tests pass).
- Live Electron runtime behavior after applying to `/opt/Antigravity/resources/app.asar` awaits closing and restarting Antigravity Desktop.

## References

0
