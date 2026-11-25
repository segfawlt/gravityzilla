# Zero-Token Execution Watchdog (`watchdog` v1.0.0)

Deterministic step timestamping, retry/error loop circuit-breaking, and silent `stdin`/hang recovery for Antigravity CLI (`agy`) with **zero LLM tokens**.

## Architecture

- **`PreInvocation` (`<5ms`):** Records model inference start (`model_start`), resets turn state on new `lastUserInput`, injects queued watchdog guidance (`ABAB_HASH_FLIP`, late-hang recovery notices, `>=3` identical error thrash circuit-breaker, 45-step check), and starts the self-exiting watcher if idle.
- **`PreToolUse` (`<5ms`):** Closes `model_done`, blocks `>=3` identical `(tool, canonical_args, ws_sig)` calls within a 6-tool window when workspace state hasn't changed (`{"decision": "deny"}`), and starts monotonic `tool_start` timing.
- **`PostToolUse` (`<5ms`):** Computes exact `duration_ms` matched by `toolCall.id`, tracks normalized error streaks, detects `ABAB_HASH_FLIP` edit oscillation, and updates workspace `mutation_seq`.
- **`Stop` (`<=20s` only on `fullyIdle: false`):** Polls active backgrounded `run_command` task logs + `/proc/<pid>/stat` CPU ticks (`4s` on interactive `stdin` prompt match, `12s` on 0-CPU/0-output) and bounces control back (`{"decision": "continue"}`) so the agent inspects `manage_task` automatically. Fast-exits immediately for active builds, `Timer:` schedules, and `IsDaemon` commands.
- **`daemon-loop`:** Singleton self-exiting watcher (stops after 15s of full idle) monitoring `presence/<cid>.lock`, SQLite `CORTEX_STEP_STATUS_WAITING` (`9`), sync tool/model stalls (`notify-send` + `agy-statusline` badge), and surgical child-shell `SIGTERM` recovery on unambiguous late hangs.

## CLI Usage (`~/.local/bin/agy-watch`)

```bash
~/.local/bin/agy-watch status                   # Show enabled state, thresholds, counters, active sessions
~/.local/bin/agy-watch ps                       # Active session & subagent snapshot (-a/--all, -w/--watch, --json)
~/.local/bin/agy-watch stream                   # Live chronological event & background task tail (--no-follow, --json)
~/.local/bin/agy-watch on                       # Enable watchdog hooks & watcher
~/.local/bin/agy-watch off                      # Disable watchdog (fail-open pass-through)
~/.local/bin/agy-watch autokill on|off          # Toggle surgical child-shell kill on late bg hangs
~/.local/bin/agy-watch logs -n 30               # Tail ~/.agents/watchdog/watchdog.log
~/.local/bin/agy-watch events -n 30             # Tail raw ~/.agents/watchdog/events.jsonl
~/.local/bin/agy-watch reset                    # Reset counters and session files
```

### Split-Screen / Sidebar Usage

Point a Ghostty split, `zellij` pane, or external UI at either handle:

```bash
agy-watch ps -w 1                  # Live refreshing multi-session tree
agy-watch stream                   # Continuous human-readable activity feed
agy-watch ps -w 1 --json           # Machine-readable NDJSON session snapshots
agy-watch stream --json            # Machine-readable NDJSON event + task log stream
```
