# margin

Right-pane **Overview** sidecar and MCP App for Antigravity, aligned with Claude Code's Margin workflow: prompt-derived **Session** & **Topic**, the **Ask**, inline **Take**, live **Plan** with nested subagents/swarm workers, **Used** tool ledger, and live Context + Watchdog telemetry.

## Overview UI Features

1. **Session & Topic (`0 ms` prompt-only reader):**
   - `PreInvocation` (`bin/agy-watch`) and Overview open/poll spawn a detached background worker (`lib/topics-worker.mjs`) reading only explicit user prompts (`USER_EXPLICIT`) to write `.system_generated/margin/topics.json` (with ephemeral `agy` worker cleanup so `"Untitled Session"` entries never leak into history), populating **Session**, **Topic**, and an instant `0 ms` **Ask** (`= ...`) for the newest prompt.
   - **Session** summarizes the overall goal as a telegraphic fragment (`<= 8` words), showing `updating…` or `update failed` inline when active or failed.
   - **Topic** shows the latest work topic (`<= 5` words; `updating…` on first turn) with a `show all` button opening the **Topics** modal newest-first when 2+ topics exist.
2. **Stale Planning & Turn Group:**
   - When a new prompt arrives and Margin has not reported yet, `Ask` / `Take` / `Plan` dim (`is-stale`) over the previous turn's report alongside a `Planning…` banner while **Session** and **Topic** stay full brightness. Once the `0 ms` worker populates `Ask` (or tools begin running), `Ask` / `Plan` / `Used` render at full brightness while prior `Take` remains dimmed (`is-stale-field`) until the main agent reports.
3. **Unified `Ask` / `Take` / `Plan` / `Result` / `Used` Grid (`54px 1fr`):**
   - **Ask** renders the telegraphic `wants` summary (`<= 60` chars), populated immediately by the `0 ms` Flash worker and overridden if the main agent supplies `wants`, always expanded (no line clamp, no toggle, no raw-prompt fallback).
   - **Take** renders inline (`✓ clear`, `! check first: <reason>`, `✗ data loss`, `? needs repro: <source>`) with no pill border and `<= 40`-char reasons. On questions without edits, `take` names the source to check rather than leaking the expected answer.
   - **Plan** reads Antigravity's native `update_steps` tool calls from `transcript.jsonl` (mapping `done` → `completed` and preserving `failed`/`skipped` with `✗`/`–`, falling back to `intent.json` steps if present). Clean turn completion closes remaining pending/active steps automatically unless the turn's `Result` paused for user input or hit a blocker (`needs_input` / `blocked`). Subagents and `.system_generated/swarm/members.json` workers nest along a `1px` vertical guide rail (`.agent-tree`), folding past 3 with `… N more` / `… less`.
   - **Result** renders end-of-turn `Outcome` triage (`✓ clear`, `? needs input`, `! caveats` / `! unverified`, `✗ blocked` / `✗ check failed`) with telegraphic `<= 65`-char summaries, combining instant deterministic transcript facts (`N file(s) edited · checks passed / no check run / check failed`) with an asynchronous detached Flash pass (`lib/outcome-worker.mjs`) triggered on `Stop` and Overview poll. Hard execution guardrails prevent false-green `clear` results when edits lack checks, checks fail, or questions were asked.
   - **Used** renders compact interactive rows (`files`, `memory`, `learnings`, `skills`, `shell`, `web`, `agents`) with counts, `Google Sans Code` filename previews (prefixing saved memories and captured learnings with `--ok` `+slug`), and hover `›` chevrons. Clicking any row opens the **Inspection Sheet** (`Details Drawer`) with dimmed directory paths (`Main`/`@worker` headers when multiple readers contribute), `Esc` / backdrop dismiss, external `↗` links, and Antigravity `fileView` clicks. `Memory` splits main items into `Captured & extracted` (`agent-memory` `memory.db` rollouts, memory writes, `remember` notes) vs `Read` (reads + `search`/`drift`), and `Learnings` splits main items into `Captured` (session-wide `agy-compound` `audit.jsonl` and `docs/learnings/*` writes) vs `Read`, both with 2-line summary excerpts; clicking opens the file in a new tab (`fileView` or `/api/memory-view`) and hover `peek` reads it inline (`memory-doc`).
4. **Unified HUD Footer (`1000 ms` polling):**
   - Single flat footer (`.hud-footer#telemetry-bar`) combining the `1.5px` Context gauge rail, a live status row (spinner glyph for `working…`, `◐ planning…`, `◌ waiting · N agent(s)`, `✓ done at HH:MM`, `? needs input at HH:MM`, `! caveats at HH:MM`, `✗ blocked at HH:MM`, `■ stopped at HH:MM`; wording trims as the pane narrows) with `done/total steps` beside it and the `ctx` chip right-aligned, and a second row holding the `watchdog` chip (`9s · 2 steps · 3 tools`, segments drop as the pane narrows); the chips open the **Session Telemetry** sheet.
5. **Antigravity Hub Typography (`DESIGN.md`):**
   - Uses embedded `Google Sans Flex` (Latin, Latin-Ext, Vietnamese with preserved `unicode-range` slices in `app/fonts.css`) and `Google Sans Code` on code/path elements alongside the Google Light/Dark ink palette.

## Architecture

| Component | Role |
|---|---|
| `rules/AGENTS.md` | Auto-loaded Margin protocol (`call_mcp_tool` inline schema for Plan Mode + Step 1 `wants`/`take`, plain-language wording rules, native `update_steps` step sourcing, no end-of-turn call). |
| `mcp/server.mjs` | Data-only stdio MCP server exposing `margin_intent` (no inline MCP App UI; Overview renders solely in the right-hand sidecar via `sidecars/margin/`). |
| `sidecars/margin/` | Serves the right-pane **Overview** tab and `GET /api/overview` with ETag caching. |
| `desktop-patch/patch.mjs` (`agy-desktop-patch`) | Reversible Antigravity Desktop `app.asar` patcher (`apply`, `status`, `check`, `restore`) bundling `top-bar`, `overview`, and `model-search`. |
| `desktop-patch/lib/` (`asar.mjs`, `overview.mjs`) | Zero-dependency ASAR repacker and sandbox-safe renderer preload hook powering `agy-desktop-patch`. |
| `lib/agy-worker.mjs` | Shared ephemeral `agy --mode plan` prompt runner with cross-product SQLite/brain cleanup. |
| `lib/topics.mjs` & `lib/topics-worker.mjs` | Prompt-only `Session` / `Topic` / instant `Ask` prompt templates (`OVERVIEW_ASK`, `LATEST_ASK`, `overviewMerge`), incremental/merge state updates, and background worker. |
| `lib/outcome.mjs` & `lib/outcome-worker.mjs` | Instant deterministic `Result` extraction (`extractTurnExecution`, `buildHeuristicOutcome`, `mergeOutcome` guardrails) plus detached Flash worker triggered on `Stop`/poll writing `outcome.json`. |
| `lib/intent.mjs` | Strict `readTake`, 1-based `applyNow` (tolerating `now: 0` with `steps`), and `{ prevAnswered }` merge state persisted to `intent.json`. |
| `lib/transcript.mjs` & `lib/overview.mjs` | Transcript derivation (`status`, `ask`, `extractNativeSteps` / `resolveTurnSteps`, `used`, `usedDetails`, `context`), swarm/subagent tree hanging (`hang`), Watchdog metrics, and ETag assembly. |
| `lib/memory.mjs` | Read-only session memory (`memory.db` rollouts, `agent-memory` CLI) and learnings (`audit.jsonl`, `docs/learnings/*`) aggregation, plus allowlisted HTML/JSON doc viewer. |
| `app/` | Single-bundle HTML/CSS/JS panel + inlined `fonts.css` (`Google Sans Flex` / `Google Sans Code`) supporting MCP Apps JSON-RPC and HTTP sidecar polling (`1000 ms`). Design contract in `DESIGN.md`. |

## Auto-Open Overview in Antigravity Desktop

Apply or revert the renderer preload patch (`~/.local/bin/agy-desktop-patch`) when Antigravity Desktop is closed (`agy-desktop-patch` auto-elevates with `sudo` when writing system paths):

```bash
agy-desktop-patch status
agy-desktop-patch apply --only overview
agy-desktop-patch restore
```

## Tests

Run tests with Node.js built-in runner:

```bash
node --test tests/
```
