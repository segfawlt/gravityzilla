---
title: Ephemeral agy worker sessions and 0-step CLI stubs require SQLite/flock-guarded cleanup
category: integration-issues
module: bin/agent-memory
tags: [agy, worker, sqlite, cleanup, cli-log, json-schema, flock, zero-step-stubs]
problem_type: integration-issue
date: 2026-11-18
---

# Ephemeral `agy` Worker Sessions and `0-Step` CLI Stubs Require SQLite & `flock`-Guarded Cleanup

## Problem

1. **Internal workers**: Background helpers (`agent-memory`, `agy-compound`) spawn non-interactive `agy --output-format json --json-schema ... --print="[AGY_INTERNAL_WORKER]..."` runs. Legacy cleanup only unlinked `conversations/<cid>.pb` in `antigravity-cli`, omitted `--log-file`, and ran without `--mode plan`.
2. **Eager `0-step` CLI stubs**: Every interactive `agy` launch (`conversation_manager.go`) eagerly creates an untitled `0-step` conversation on disk (`title=''`, `preview=''`, `step_count=0`) before any user input, holding an `FLOCK ADVISORY WRITE` (`fcntl.flock(LOCK_EX)`) on `presence/<cid>.lock` while the TUI session is live. When the user exits, `/resume`s into another chat, or uses Remote Control without typing into that initial buffer, the empty stub persists in `conversation_summaries.db`.

## Symptoms

- Leaked `[AGY_INTERNAL_WORKER]` entries appeared in Antigravity Desktop/CLI conversation lists as untitled chats showing only the prompt (under `--json-schema`, the reply is recorded as an internal `finish(...)` tool call at step type 132 with zero assistant text).
- On every `agy` startup, `store_client.go` background reconciliation (`conversation_summaries.db` rebuild from `conversations/*.db`) re-inserted lingering worker `.db` files even if `conversation_summaries` rows had been deleted.
- Worker invocations truncated `~/.gemini/antigravity-cli/cli.log` and, under user `"agentMode": "auto"` / `"toolPermission": "always-proceed"`, could run `run_command`/`read_file` inside `/tmp`.
- Abandoned `0-step` CLI stubs accumulated as blank `"Untitled Conversation"` items alongside worker leaks.

## What Didn't Work

- Deleting only `conversations/<cid>.pb` and `conversation_summaries`: modern `agy` writes `conversations/<cid>.db` (+ `-wal`, `-shm`) and `presence/<cid>.lock`, and startup reconciliation re-indexes any surviving `.db`.
- Filtering only by `transcript.jsonl`: timed-out or pre-flush workers may only leave `conversations/<cid>.db` with `[AGY_INTERNAL_WORKER]` in `steps.step_payload` at `idx = 0`.
- Blindly deleting `step_count = 0` summary rows: would clobber active TUI buffers currently holding `presence/<cid>.lock` or rows with stale summaries whose `.db` actually has steps or `brain/<cid>` artifacts.

## Solution

1. **Worker isolation & purge**: Snapshot `brain/` and `conversations/*.db|*.pb` across `("antigravity-cli", "antigravity", "antigravity-ide")` before launching `agy`, then in `finally:` discover new worker CIDs via `ephemeral_cid`, `transcript.jsonl`, `steps.step_payload` at `idx = 0`, and `conversation_summaries.preview`, and unlink `brain/<cid>`, `conversations/<cid>.{pb,db,db-wal,db-shm}`, `presence/<cid>.lock`, plus rows in `conversation_summaries`, `conversations_fts`, and `conversation_parents`. Pass `--mode plan`, `--disable-slash-commands`, `--log-file <temp>` (unlinked in `finally:`), `--print-timeout`, and an explicit no-tool prompt guard.
2. **Safe `0-step` CLI stub reaper (`_find_reapable_zero_step_stubs`)**: During `agent-memory sync` (600s grace window) and `agent-memory doctor --fix` (60s grace window), reap top-level `0-step` stubs (`step_count = 0 AND title = '' AND preview = '' AND parent_conversation_id = ''`) **only** when across all product dirs:
   - The CID is not open in `/proc/[0-9]*/fd/*` under `conversations/` or `presence/`.
   - `presence/<cid>.lock` is not actively held via `fcntl.flock(LOCK_EX | LOCK_NB)`.
   - `brain/<cid>` contains zero files recursively, `conversations/<cid>.db` has `SELECT count(*) FROM steps == 0`, and `.db`/brain `mtime` exceeds the grace window.

## Why This Works

Removing `.db` (+ WAL/SHM) across all Antigravity product directories prevents `store_client.go` startup reconciliation from resurrecting ephemeral worker runs or dead stubs, while checking `/proc/*/fd/*`, `presence/<cid>.lock` `flock`, recursive `brain/` contents, SQLite `steps`, and `mtime` age guarantees live TUI stubs (like an active Remote Control buffer) and real sessions are never deleted.

## Prevention

Covered by unit tests in `config/plugins/memory/tests/test_worker_cleanup.py` (including `test_reap_zero_step_stubs_respects_locks_age_and_artifacts`) and verified live against `call_llm_json()` + `agent-memory doctor --fix`.

## References

0
