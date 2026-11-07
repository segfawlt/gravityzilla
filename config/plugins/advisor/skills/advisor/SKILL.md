---
name: advisor
description: Configure, toggle, or inspect logs of the Persistent Advisor subagent system (/advisor, /advisor on, /advisor off, /advisor status, /advisor subagents, /advisor model, /advisor fallback, /advisor effort, /advisor thinking, /advisor logs, /advisor reset). Triggered by /advisor or when the user asks to toggle the main or subagent advisor, switch models, or view live advisor logs. Antigravity-only: it manages the agy-advisor daemon wired into Antigravity's PreInvocation/Stop hooks; in any other harness (ZCode, Claude Code, etc.) there is nothing to configure — never trigger it there.
---

# Persistent Advisor Subagent (`/advisor`)

Direct `/advisor` slash commands (`/advisor`, `/advisor status`, `/advisor on`, `/advisor off`, `/advisor subagents ...`, `/advisor model ...`, `/advisor fallback ...`, `/advisor effort ...`, `/advisor thinking ...`, `/advisor logs ...`, `/advisor reset`) are intercepted automatically in Python via `PreInvocation` before the LLM is called (**zero model tokens, ~15ms**).

This skill is used when the user asks a natural-language question or instruction in chat about configuring, toggling, or inspecting the Persistent Advisor v3.0 system (`~/.local/bin/agy-advisor`).

- **Isolated Continuous `advisor-core` Sessions**: Each mutating coding session (`Lead` + `self` subagents; read-only `research` and `image-generator` default to `off`) gets its own persistent 1-to-1 `--conversation <advisor_cid>` running the zero-tool `advisor-core` profile, seeded with `<memory-context>` (auto-memory `MEMORY.md` indexes), `ADVISOR.md`, and `WATCHDOG.md`.
- **Finish-Line Diff Check + Thrash Circuit-Breaker**: Reviews commit-aware, turn-isolated diffs at `Stop` (`0` tokens on Q&A or read-only turns) and injects a pivot after `>= 3` consecutive tool errors in `PreInvocation`. Attributed under `advisor` in `agy stats`.

## Subcommands (for Natural-Language Chat Requests)

Execute the matching command via `run_command` based on the user's request:

- **Check status, toggles & models** (`/advisor` or `/advisor status`):
  ```bash
  ~/.local/bin/agy-advisor status
  ```
- **Toggle Main (`Lead`) Advisor ON / OFF** (`/advisor on` or `/advisor off`):
  ```bash
  ~/.local/bin/agy-advisor on
  ~/.local/bin/agy-advisor off
  ```
- **Toggle Spawned Subagent Advisors — master or per-type** (`/advisor subagents ...`):
  ```bash
  ~/.local/bin/agy-advisor subagents
  ~/.local/bin/agy-advisor subagents on
  ~/.local/bin/agy-advisor subagents off
  ~/.local/bin/agy-advisor subagents research off
  ~/.local/bin/agy-advisor subagents self gemini-3.8-flash-high
  ```
- **Switch primary or fallback model** (`/advisor model <id>` or `/advisor fallback <id|off>`):
  ```bash
  ~/.local/bin/agy-advisor model claude-sonnet-5-5-high
  ~/.local/bin/agy-advisor fallback gemini-3.8-flash-high
  ```
- **Adjust reasoning effort or evidence-only thinking feed** (`/advisor effort <low|medium|high>` or `/advisor thinking <on|off>`):
  ```bash
  ~/.local/bin/agy-advisor effort high
  ~/.local/bin/agy-advisor thinking off
  ```
- **Inspect recent or live Advisor logs** (`/advisor logs`):
  ```bash
  ~/.local/bin/agy-advisor logs -n 30
  ```
  *(In an external terminal: `~/.local/bin/agy-advisor logs -f`)*
- **Reset session cursors, failure latches & EmissionGuard caches** (`/advisor reset`):
  ```bash
  ~/.local/bin/agy-advisor reset
  ```
