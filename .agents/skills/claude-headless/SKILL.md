---
name: claude-headless
description: >-
  Delegate tasks or slash commands (/ship, /audit, /pr, multi-step edits, or
  first-pass checks) to headless Claude Code CLI (claude -p). Trigger whenever the
  user asks to run or delegate a task to headless Claude, claude -p, or a
  background Claude Code worker.
---

# Headless Claude Delegation (`claude -p`)

Runbook for delegating autonomous tasks or slash commands (such as `/ship`, `/pr`, `/audit`, or bounded implementation tasks) to the Claude Code CLI (`claude`) in non-interactive headless mode (`-p` / `--print`).

---

## 1. Model-Tier Limits & Prompt Scoping

Headless `claude -p` uses a fast flash-tier model. It handles bounded mechanical work quickly, but often misses subtle requirements, edge cases, invariants, or downstream callers.

- **Scope prompts tightly:** Specify exact file paths, domain invariants, acceptance criteria, and the exact verification commands to run.
- **Avoid open-ended delegation:** Never assign open-ended architecture work or rely on `claude -p` as the sole final verifier for risky or multi-layer changes.
- **Forbid nested internal subagents (`--disallowedTools "Agent,Task"`):** Backend model concurrency slots are limited. Letting a `claude -p` worker spawn internal subagents starves sibling outer workers, makes them appear stalled, and trips the 10-minute `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` kill (exiting `0` with partial uncommitted work). Always block nested subagents both mechanically (`--disallowedTools "Agent,Task"`) and explicitly in the worker prompt, and cap outer parallel `claude -p` runs (default max `3` at a time).

---

## 2. Pre-Flight Check: Prevent Duplicate Runs & Git Lock Races

Backgrounded `claude -p` processes survive harness restarts and keep mutating the repository on the OS. Before launching or retrying a headless run, always check whether an instance is already running:

```bash
pgrep -af "claude.*-p" || true
```

- **If a matching process is alive (`<PID>`):** Do **not** launch a second `claude -p` in the same repository (they will race on `.git/index.lock` and working-tree files). Instead, wait for the existing PID to finish:
  ```bash
  while kill -0 <PID> 2>/dev/null; do sleep 2; done
  ```
- **Inspecting a live run:** Check its active child command via `ps -ef | grep <PID>` or inspect the latest session transcript in `~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/*.jsonl`.

---

## 3. Canonical Invocation Contract

Always follow three rules when invoking `claude` headlessly:

1. **Prefix with `rtk bypass`:** Prevent the `rtk` pre-tool hook from rewriting CLI flags or condensing output.
2. **`cd` into the target repository or worktree first:** Claude Code scopes project context (`~/.claude/projects/<cwd-slug>/`), `CLAUDE.md`, skills, and Git operations to its initial working directory. Never launch repo tasks from `$HOME`.
3. **Pass explicit permission and tool-restriction flags:** Headless `-p` has no interactive TTY. Without permission flags, **every** `Bash`, `Edit`, and `Write` call (including inside subagents Claude spawns) is rejected with `"This command requires approval"`, and **`claude -p` still exits with code `0`** while printing a refusal summary. Always pass `--disallowedTools "Agent,Task"` on autonomous worker runs so the worker executes directly instead of spawning internal subagents.

### Autonomous Read/Write Delegation (e.g., `/ship`, code edits, test fixes)

```bash
cd /path/to/repo && rtk bypass claude --dangerously-skip-permissions --disallowedTools "Agent,Task" -p "/ship"
```

### Read-Only or Tool-Scoped Delegation

When restricting headless Claude to specific tools:

```bash
cd /path/to/repo && rtk bypass claude --allowedTools "Read" "Grep" "Glob" "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" --disallowedTools "Agent,Task" -p "<prompt>"
```

---

## 4. Output Buffering vs. Live Streaming

- **Default (`-p`):** Buffers all assistant text and tool activity until the final turn completes. A multi-step workflow produces zero stdout lines after startup for several minutes, then flushes the final summary at exit.
- **Streaming progress (`--output-format stream-json --verbose`):** Use when you need live turn-by-turn tool visibility in the background task log:
  ```bash
  cd /path/to/repo && rtk bypass claude --dangerously-skip-permissions --disallowedTools "Agent,Task" --output-format stream-json --verbose -p "<prompt>"
  ```

---

## 5. Claudzilla Hook Gates & Timeout Budgeting

`--dangerously-skip-permissions` bypasses interactive permission prompts, **not** `~/.claude` `PreToolUse` / `PostToolUse` hooks:

- **Pre-push / pre-PR verification gate:** If your `~/.claude` hooks (for example, Claudzilla's `PreToolUse:Bash` hook) intercept `git push` and `gh pr create` with:
  `Run superpowers:verification-before-completion this turn before push/PR (superpowers.md Order). Then run its check (tests, build)`
- When this fires, headless Claude must invoke `superpowers:verification-before-completion` and re-run `typecheck` / `test` / `build` in that same turn before `git push` succeeds.
- **Budgeting:** Expect repo-wide workflows like `/ship` to run verification suites twice and take **5–10+ minutes**. Let the background task run to completion rather than timing out or killing it mid-flight.

---

## 6. Mandatory Post-Run Verification & Audit

Never treat exit code `0` or Claude's final summary as sufficient proof. Verification runs in two tiers based on change size and risk.

### Tier 1 — Optional Fresh Read-Only Self-Check (Large or Multi-File Runs)

Use this pass only for larger runs (for example, 4+ files, `/ship`, or multi-file refactors). Skip it on small 1–3 file changes where direct caller review is faster.

- **Start a clean session:** Launch a fresh read-only `claude -p` session with `--allowedTools` and **never** pass `--resume` or `--continue`, avoiding in-session confirmation bias.
- **Prompt adversarially:** Pass only the original requirements and instruct Claude to inspect `git diff` or `git show` for missed requirements, broken callers, untested edge cases, TODO stubs, or weakened assertions — never to confirm success.

```bash
cd /path/to/repo && rtk bypass claude --allowedTools "Read" "Grep" "Glob" "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" --disallowedTools "Agent,Task" -p "Inspect git diff against these requirements: <requirements>. List only missed scope, broken callers, untested edge cases, TODO stubs, or weakened test assertions."
```

### Tier 2 — Always-On Caller Verification (Every Mutating Run)

Run these checks directly in the caller session after every mutating run:

1. **Check for silent permission blocks:** Read the task output to confirm commands actually ran and were not rejected by tool permissions or hooks.
2. **Verify disk & Git state directly (`Observed`):**
   ```bash
   git -C /path/to/repo status
   git -C /path/to/repo log -n 5 --oneline
   git -C /path/to/repo wt-sync 2>&1 || true
   ```
3. **Audit the real diff against requirements:** Inspect `git diff` or `git show <sha>` (and `git range-diff` after rebases or conflict resolution) requirement by requirement. Check explicitly for dropped scope, leftover stubs or TODOs, missed callers, and weakened or deleted test assertions.
4. **Independently re-run key checks:** Run the relevant focused tests, `typecheck`, lint, or real runtime check in the caller session instead of trusting headless Claude's claimed pass.
5. **Label evidence honestly:** Distinguish direct caller observations (`Observed`) from checks headless Claude reported running in its summary.

### Closing Findings (Fix-Up Cap)

- Fix subtle logic bugs, weakened tests, or small misses directly in the primary session.
- For large mechanical gaps, allow at most **1 targeted fix-up `claude -p` pass** citing exact `file:line` findings, then re-run Tier 2 caller verification. Do not loop endlessly — take over directly if issues remain.
