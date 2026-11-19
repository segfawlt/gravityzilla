# Learnings Index

Indexed catalog of durable lessons captured by the `compound` skill. Check entries with relevant
tags before non-trivial work.

## Pending Terms

## Promote Candidates

Lessons referenced 3+ times. Promotion is a user decision.

## integration-issues/

- [Antigravity Desktop right-sidebar tabs require UI Sidecars when enable-mcp-apps is off (plus auxPane camelCase mismatch)](./integration-issues/antigravity-aux-pane-sidecar-vs-mcp-apps.md) — Use `sidecars/<name>/sidecar.json` (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`, `sidecar_sdk`, `/preload.js`) for right-pane tabs when `enable-mcp-apps` is disabled, and use camelCase `"auxPane"` in MCP App `_meta` entrypoints to match `mcpcore.parseEntrypoints`. `#antigravity #sidecar #mcp-apps #aux-pane #ui-plugins #language-server #mendel`
- [Node.js ES Modules realpath symlink resolution defeats string equality main-module guards](./integration-issues/node-esm-symlink-main-module-guard.md) — Normalize `process.argv[1]` with `realpathSync()` when comparing against `fileURLToPath(import.meta.url)` in ESM entry guards so stdio MCP servers and CLI tools spawn cleanly when paths pass through symlinked plugin directories. `#node #esm #symlinks #mcp #plugins #stdio #language-server`
- [Ephemeral agy worker sessions and 0-step CLI stubs require SQLite/flock-guarded cleanup](./integration-issues/agy-ephemeral-worker-sqlite-cleanup.md) — Purge `conversations/<cid>.db*`, WAL/SHM, locks, and FTS rows across agy product dirs, isolate `--log-file` + `--mode plan` for workers, and reap unlocked/artifact-free `0-step` CLI stubs after a grace window. `#agy #worker #sqlite #cleanup #cli-log #json-schema #flock #zero-step-stubs`

## logic-errors/

- [Defaulting empty DB titles at ingest shadows subagent and preview fallbacks](./logic-errors/agy-stats-untitled-fallback-shadowing.md) — Preserve empty DB titles until `_resolve_session_display_title()` so swarm/subagent children and previewed sessions do not collapse to `"Untitled Session"`. `#agy-stats #subagents #swarm #title-fallback`
