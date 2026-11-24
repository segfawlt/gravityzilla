# Margin Overview Reporting (`margin_margin` / `margin_intent`)

The user watches the Margin side panel showing your reading of their request (`wants`), your pre-work reaction (`take`), and your plan (`steps`). Call `margin_intent` via `call_mcp_tool` without reading any schema file first:

```json
{
  "ServerName": "margin_margin",
  "ToolName": "margin_intent",
  "Arguments": {
    "conversation_id": "<UUID from brain/<conversation-id>>",
    "wants": "3-8w telegraphic goal <=60ch, user language; drop articles/filler",
    "take": { "stance": "fine|concern|against|unsure", "label": "1-2w <=14ch", "why": "optional 2-5w fragment <=40ch" },
    "steps": [{ "text": "2-8 items, 2-5w verb+noun <=40ch", "agents": ["Exact role or worker name"] }],
    "now": 1
  }
}
```

Rules:
- **Step 1 (including Plan Mode):** Call `margin_intent` with `wants`, `take`, and `steps` (plus `now: 1`) at the start of every main-session turn answering a user prompt, as your **first** tool call before reading files or searching. (Subagents skip this.)
- **Clean-caveman style:** Write `wants`, `take.why`, and `steps` as ultra-terse telegraphic plain words — drop articles (`a`/`an`/`the`), copulas (`is`/`are`), and filler while keeping negations exact and everyday words readable (never mangled caveman like `"me fix"`). Avoid code symbols, internal filenames, camelCase identifiers, hashes, acronyms, and backticks unless the user specifically asked about them.
- **Pre-work `take` only (never the answer):** On a work ask, state your stance on doing it as asked. On a pure question, state how sure you are and what source you will check, or a premise you doubt; never leak your expected answer even when context already holds it (Bad: `"plausible: wording invites mini-answer"`; Good: `"check rule: read take rule"`).
  - `stance`: `fine` = do as asked; `concern` = doable with a real risk or better way; `against` = ask user to reconsider first (irreversible, bypasses review/CI/backup/confirmation, or breaks a stated rule — choose `against` over `concern` whenever one holds, even if you would proceed after confirming); `unsure` = cannot judge yet.
  - `label`: required, 1–2 words, `<= 14` chars (max 16), no mood words (`excited`, `happy`). Pure question asks: verb + target (`check labels`, `read session`, `count names`), never `naming q`, `design q`, `answer`, or `question`. Examples: `fine` `"clear"`, `"small fix"`; `concern` `"risky"`, `"overkill"`, `"check first"`; `against` `"breaks rule"`, `"data loss"`; `unsure` `"needs repro"`, `"unclear goal"`.
  - `why`: optional 2–5 word telegraphic fragment (`<= 40` chars; good: `"needs app patch"`, `"check margin + memory code"`; bad: `"requires dist/preload.js hook in app.asar"`). Omit on `fine` when `label` says enough. With `unsure`, name the input/source to check (file, command, session), never a finding.
- **1-based pings & turn end:** Ping `{ conversation_id, now: n }` (`n` is 1-based step index) as the first block starting a new step, and only then. Re-send `wants`/`take`/`steps` only when your reading or plan changes, keeping `step.agents` populated across redrafts. Never call `margin_intent` alone at turn end just to mark the last step done — your answer closes it. Never mention the tool in your reply.
