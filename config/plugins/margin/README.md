# margin

Right-side **Overview** pane for the main agent chat in Antigravity Desktop: live status, the ask,
the agent's take, plan progress, verdict, context window usage, watchdog timer, and what it used.
Built in a crisp, ultra-readable **Google style** (Google Workspace / Cloud Console / Material 3 utility
aesthetic) with full 1:1 `claudzilla` Overview feature parity.

## Overview UI Features

1. **Pinned Header & Telemetry Strip**:
   - **Live Status Indicator**: `◐ Planning…`, `● Working`, `◌ Waiting on N agents`, `✓ Done`, `■ Stopped`, `Idle`.
   - **Step Summary Chip**: Right-aligned live summary pill (`2 done · on 3 of 5` during progress, `5/5 steps` on done).
   - **Context Window Gauge**: Live usage (`171.2k / 1.0M · 17%`) with thin 3px fill bar (Google blue `#1a73e8`/`#8ab4f8`, amber >=65%, red >=85%) and multi-tier tooltip (`Model`, `Input`, `Cache`, `Output`, `Total`).
   - **Watchdog Live Timer**: Client timer ticking every 1s during active turns (`1m 04s · 6s/8t`), frozen at final duration on done/stopped, with semantic amber/red warning badge on stall/loop alerts.

2. **Stale/Planning Dim State (`claudzilla` 1:1)**:
   - When a turn starts (`status === 'planning'` and not yet reported), the previous turn's intent renders softly dimmed (`opacity: 0.58`) beneath a `"Planning next turn…"` banner until the current turn's `margin_intent` arrives.

3. **Ask & Take Sections**:
   - **Ask**: 4-line clamped summary (`wants || ask`) with click-to-expand and hover tooltip showing raw user ask.
   - **Take**: Semantic tonal chip with stance glyph (`✓ clear`, `! check first`, `✗ breaks rule`, `? unclear goal`) and crisp `why` rationale sentence.

4. **Plan Section — Highlighted Active Task & Nested Subagents**:
   - Header shows live progress summary (`2 done · on 3 of 5`) and Google blue progress bar.
   - **Active Task Row**: Elevated container in soft Google blue (`color-mix(in srgb, var(--accent) 10%, var(--surface))`), `●` active indicator, bold `Step k · Now` badge, high-contrast primary text, and auto-scroll tracking.
   - **Completed Steps**: Green `✓` glyph and clean, readable text (no strikethrough).
   - **Nested Subagents**: Swarm workers rendered with tree connectors (`├─`, `└─`), live status glyphs (`◌`, `✓`, `✗`, `■`, `○`), description, and model/type tags. Steps with >3 agents fold cleanly behind an interactive `Show N more agents` button.

5. **Verdict Section**:
   - High-contrast outcome card with green check badge when `verdict` is delivered.

6. **Used Section & Drill-Down Details Drawer (`claudzilla` 1:1)**:
   - Category rows (`Files`, `Memory`, `Skills`, `Shell`, `Web`, `Agents`) displaying main count, muted `+N` subagent count, recent file/tool preview, and chevron affordance.
   - Clicking any category row slides up an in-pane **Details Drawer** (closes on `Esc`, backdrop click, or `×` button) grouping operations by reader (`Main agent`, subagents), with repeat badges (`×2`), source badges (`read_file`, `bash`), external links for web, and clickable file rows triggering `window.sidecar?.ui?.toggleAuxPane({ tabType: 'fileView', uri: 'file://' + item.name })`.

## Architecture

The plugin combines two lightweight Node pieces sharing the same `app/` UI and `lib/` readers:

| Piece | Role |
| --- | --- |
| `app/` (`index.html`, `app.css`, `app.js`) | Google Workspace / Material 3 utility UI for both Sidecar and MCP Apps transports. |
| `sidecars/margin/` (UI sidecar) | Serves the right-pane **Overview** tab (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) via `sidecar_sdk` and exposes `GET /api/overview`, polling `transcript.jsonl` + `intent.json` with ETag caching. Appears in the side pane `+` menu and opens via `[Overview](sidecar://margin/margin/)`. |
| `mcp/server.mjs` (`margin_intent`) | Model-visible MCP tool where the agent reports `wants`, `take`, `steps`, `now`, `verdict`. Also serves the MCP App `ui://margin/overview.html` resource (`auxPane` entrypoint) when `enable-mcp-apps` is enabled. |
| `lib/overview.mjs` & `lib/transcript.mjs` | Deterministic status (`planning`, `working`, `waiting_agents`, `done`, `stopped`), ASK, USED counts, subagent discovery, and ETag-cached `resolveOverview`. |
| `lib/intent.mjs` | Validate and merge reports; a new user message starts a clean turn. |

Intent is stored at `<brain>/<conversation>/.system_generated/margin/intent.json`.

## Design Verification & Anti-Slop Compliance

- **`avoid-ai-design`**: 0 findings (`P0 0 · P1 0 · P2 0`) via `node <skill>/scripts/detect.mjs app/`.
- **`taste-skill`**: 0 FAIL via `node <skill>/scripts/lint.mjs --app app/`.
- **Pre-rendered Preview Screenshots** (`380x780`, headless Chromium):
  - `/tmp/margin-ui-check-working-light.png` (working turn "2 done · on 3 of 5", subagents, context gauge, watchdog)
  - `/tmp/margin-ui-check-working-dark.png` (dark theme counterpart)
  - `/tmp/margin-ui-check-done-verdict-dark.png` (turn completed, 5/5 steps, verdict card)
  - `/tmp/margin-ui-check-used-modal-light.png` (interactive Used drill-down drawer, light)
  - `/tmp/margin-ui-check-used-modal-dark.png` (interactive Used drill-down drawer, dark)

## Tests

Run tests with Node.js built-in runner:

```bash
node --test tests/
```
