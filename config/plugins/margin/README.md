# margin

Right-side **Overview** pane for the main agent chat in Antigravity Desktop: live status, the ask,
the agent's take, plan progress, verdict, and what it used. Modeled on claudzilla's `margin` plugin.

## How it works

The plugin combines two lightweight Node pieces sharing the same `app/` UI and `lib/` readers:

| Piece | Role |
| --- | --- |
| `sidecars/margin/` (UI sidecar) | Serves the right-pane **Overview** tab (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) via `sidecar_sdk` and exposes `GET /api/overview`, polling `transcript.jsonl` + `intent.json`. Appears in the side pane `+` menu and opens via `[Overview](sidecar://margin/margin/)`. |
| `mcp/server.mjs` (`margin_intent`) | Model-visible MCP tool where the agent reports `wants`, `take`, `steps`, `now`, `verdict`. Also serves the MCP App `ui://margin/overview.html` resource (`auxPane` entrypoint) when `enable-mcp-apps` is enabled. |
| `lib/overview.mjs` & `lib/transcript.mjs` | Deterministic status (`planning`, `working`, `done`, `stopped`), ASK, USED counts, and ETag-cached `resolveOverview`. |
| `lib/intent.mjs` | Validate and merge reports; a new user message starts a clean turn. |

Intent is stored at `<brain>/<conversation>/.system_generated/margin/intent.json`.

## Degrades gracefully

If the model skips `margin_intent`, the pane still shows status, the ask, and USED, plus a note that no
reading or plan was reported. Intent from an earlier user message is never shown for the current one.

## Limits

- Desktop only. The `agy` CLI has no pane; `agy -p` did not load plugin MCP servers in our test.
- The pane learns its conversation from the host (`window.sidecar.conversationId` or `conversation_id`). Opened standalone before any call, it falls back to the most recently active conversation.
- Disable with `agy plugin disable margin` if CLI sessions waste tokens calling the tool.

## Tests

`node --test tests/`
