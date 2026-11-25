# Margin Overview Reporting (`margin_margin` / `margin_intent`)

The user watches the Margin side panel showing your reading of their request (`wants`) and your pre-work reaction (`take`). Call `margin_intent` via `call_mcp_tool` without reading any schema file first:

```json
{
  "ServerName": "margin_margin",
  "ToolName": "margin_intent",
  "Arguments": {
    "conversation_id": "<UUID from brain/<conversation-id>>",
    "wants": "3-8w telegraphic goal <=60ch, user language; drop articles/filler",
    "take": { "stance": "fine|concern|against|unsure", "label": "1-2w <=14ch", "why": "optional 2-5w fragment <=40ch" }
  }
}
```

Rules:
- **Step 1 (including Plan Mode & queued follow-ups):** Call `margin_intent` with `wants` and `take` at the start of **every** main-session turn answering a user prompt — including short or queued follow-ups — as your **first** tool call or in parallel with your first read/search batch (never skip a follow-up turn, never wait until after scouting; subagents skip this).
- **Clean-caveman style:** Write `wants` and `take.why` as ultra-terse telegraphic plain words — drop articles (`a`/`an`/`the`), copulas (`is`/`are`), and filler while keeping negations exact and everyday words readable (never mangled caveman like `"me fix"`). Avoid code symbols, internal filenames, camelCase identifiers, hashes, acronyms, and backticks unless the user specifically asked about them.
- **Pre-work `take` only (never the answer):** On a work ask, state your stance on doing it as asked. On a pure question, state how sure you are and what source you will check, or a premise you doubt; never leak your expected answer even when context already holds it (Bad: `"plausible: wording invites mini-answer"`; Good: `"check rule: read take rule"`).
  - `stance`: `fine` = do as asked; `concern` = doable with a real risk or better way; `against` = ask user to reconsider first (irreversible, bypasses review/CI/backup/confirmation, or breaks a stated rule — choose `against` over `concern` whenever one holds, even if you would proceed after confirming); `unsure` = cannot judge yet.
  - `label`: required, 1–2 words, `<= 14` chars (max 16), no mood words (`excited`, `happy`). Pure question asks: verb + target (`check labels`, `read session`, `count names`), never `naming q`, `design q`, `answer`, or `question`. Examples: `fine` `"clear"`, `"small fix"`; `concern` `"risky"`, `"overkill"`, `"check first"`; `against` `"breaks rule"`, `"data loss"`; `unsure` `"needs repro"`, `"unclear goal"`.
  - `why`: optional 2–5 word telegraphic fragment (`<= 40` chars; good: `"needs app patch"`, `"check margin + memory code"`; bad: `"requires dist/preload.js hook in app.asar"`). Omit on `fine` when `label` says enough. With `unsure`, name the input/source to check (file, command, session), never a finding.
- **Steps via native `update_steps`:** Margin automatically reads Antigravity's native `update_steps` calls for its `Plan` section — do not send duplicate `steps` or step-progress pings to `margin_intent`. On every new user message, always send a fresh `take` immediately; within the same turn, only re-call `margin_intent` if `wants` or `take` changes. Never call it alone at turn end, and never mention the tool in your reply.
