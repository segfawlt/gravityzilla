# margin

Right-side **Overview** pane for the main agent chat in Antigravity Desktop: live status, the ask,
the agent's take, plan progress, verdict, and what it used. Modeled on claudzilla's `margin` plugin.

## How it works

It is an [MCP App](https://github.com/modelcontextprotocol/ext-apps): one dependency-free Node
stdio server (`mcp/server.mjs`) that serves both the tools and the pane UI (`app/`).

| Piece | Role |
| --- | --- |
| `margin_intent` (model-visible) | The agent reports `wants`, `take`, `steps`, `now`, `verdict`. The rules live in the tool description, so no always-on prompt rule. Declares an `aux_pane` entrypoint, so the pane auto-opens after a call and appears in the pane "+" menu. |
| `margin_overview` (app-only) | The pane polls it every 2 s. Merges the intent file with facts derived from `transcript.jsonl`. |
| `lib/transcript.mjs` | Deterministic status (planning, working, done, stopped), ASK, and USED counts (no model needed). |
| `lib/intent.mjs` | Validate and merge reports; a new user message starts a clean turn. |

Intent is stored at `<brain>/<conversation>/.system_generated/margin/intent.json`.

## Degrades gracefully

If the model skips `margin_intent`, the pane still shows status, the ask, and USED, plus a note that no
reading or plan was reported. Intent from an earlier user message is never shown for the current one.

## Limits

- Desktop only. The `agy` CLI has no pane; `agy -p` did not load plugin MCP servers in our test.
- The pane learns its conversation from the agent's `conversation_id`. Opened via "+" before any call, it
  falls back to the most recently active conversation.
- Disable with `agy plugin disable margin` if CLI sessions waste tokens calling the tool.

## Tests

`node --test tests/`
