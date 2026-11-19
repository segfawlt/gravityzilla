# Learnings Index

Indexed catalog of durable lessons captured by the `compound` skill. Check entries with relevant
tags before non-trivial work.

## Pending Terms

## Promote Candidates

Lessons referenced 3+ times. Promotion is a user decision.

## integration-issues/

- [Unbounded JSON ETag in Sidecar GET Polling Overflows Node HTTP 431](./integration-issues/sidecar-query-etag-http-431-freeze.md) — Hash normalized overview payloads to a fixed 16-char SHA-1 ETag (zeroing `watchdog.elapsedMs`) and clear `state.etag` on error so multi-worker `usedDetails` never trigger `HTTP 431` poll freezes. `#sidecar #http-431 #etag #polling #compaction #margin #node-http`
- [Host Webview CSP & Linux OS Fallbacks Require Inlined Base64 Font Embedding](./integration-issues/webview-csp-and-linux-font-fallback-embedding.md) — Embed variable WOFF2 fonts via base64 data URIs in CSS and sync to `~/.local/share/fonts` with `fc-cache` so sandboxed Electron webviews render consistent typography without external network requests or CSP violations. `#fonts #typography #inter #webview #sidecar #csp #fontconfig #linux`
- [sidecar_sdk preload.js inline body styles override dark mode and ESM sidecars cache lib imports without --watch](./integration-issues/sidecar-preload-dark-mode-and-watch-reload.md) — Handle `{ type: 'theme-change' }` before `jsonrpc` guards, mirror `:root[data-theme="dark"]` with `!important` body guards + `color-mix()` surfaces, and run `node --watch main.mjs` in `sidecar.json` so `lib/*.mjs` edits reload live. `#sidecar #sidecar_sdk #dark-mode #preload #node-watch #antigravity #css`
- [Antigravity Desktop right-sidebar tabs require UI Sidecars when enable-mcp-apps is off (plus auxPane camelCase mismatch)](./integration-issues/antigravity-aux-pane-sidecar-vs-mcp-apps.md) — Use `sidecars/<name>/sidecar.json` (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`, `sidecar_sdk`, `/preload.js`) for right-pane tabs when `enable-mcp-apps` is disabled, and use camelCase `"auxPane"` in MCP App `_meta` entrypoints to match `mcpcore.parseEntrypoints`. `#antigravity #sidecar #mcp-apps #aux-pane #ui-plugins #language-server #mendel`
- [Node.js ES Modules realpath symlink resolution defeats string equality main-module guards](./integration-issues/node-esm-symlink-main-module-guard.md) — Normalize `process.argv[1]` with `realpathSync()` when comparing against `fileURLToPath(import.meta.url)` in ESM entry guards so stdio MCP servers and CLI tools spawn cleanly when paths pass through symlinked plugin directories. `#node #esm #symlinks #mcp #plugins #stdio #language-server`
- [Ephemeral agy worker sessions and 0-step CLI stubs require SQLite/flock-guarded cleanup](./integration-issues/agy-ephemeral-worker-sqlite-cleanup.md) — Purge `conversations/<cid>.db*`, WAL/SHM, locks, and FTS rows across agy product dirs, isolate `--log-file` + `--mode plan` for workers, and reap unlocked/artifact-free `0-step` CLI stubs after a grace window. `#agy #worker #sqlite #cleanup #cli-log #json-schema #flock #zero-step-stubs`

## logic-errors/

- [Unguarded 1s Render Ticker Overwrites Async Reconnecting Status at 1 Hz](./logic-errors/polling-error-vs-render-ticker-flicker.md) — Model degraded polling via explicit `state.reconnecting` (gated by `state.lastOk > 0`), render through `renderStatus()`, and pause 1s ticker status overwrites while disconnected so status text does not flicker at 1 Hz. `#polling #state-machine #timer #ui-flicker #margin`
- [agy CLI context_window stdin diverges on resume, mid-turn streams, and CHECKPOINT compactions](./logic-errors/agy-context-window-stdin-and-transcript-bugs.md) — Compute context usage from the latest post-`CHECKPOINT` `PLANNER_RESPONSE` (`input_tokens + cache_read_tokens + cache_write_tokens + output_tokens`), scanning backward past >32 KB tool outputs with dynamic model limits instead of trusting buggy `agy` stdin `context_window` or fixed `180k` thresholds. `#agy #statusline #context-window #tokens #checkpoint #transcript #margin`
- [Defaulting empty DB titles at ingest shadows subagent and preview fallbacks](./logic-errors/agy-stats-untitled-fallback-shadowing.md) — Preserve empty DB titles until `_resolve_session_display_title()` so swarm/subagent children and previewed sessions do not collapse to `"Untitled Session"`. `#agy-stats #subagents #swarm #title-fallback`
