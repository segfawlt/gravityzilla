---
title: Ephemeral agy worker sessions require SQLite cleanup and log/mode isolation
category: integration-issues
module: bin/agent-memory
tags: [agy, worker, sqlite, cleanup, cli-log, json-schema]
problem_type: integration-issue
date: 2026-11-17
---

# Ephemeral `agy` Worker Sessions Require SQLite Cleanup and Log/Mode Isolation

## Problem

Background helpers (`agent-memory`, `agy-compound`) spawn non-interactive `agy --output-format json --json-schema ... --print="[AGY_INTERNAL_WORKER]..."` runs. Legacy cleanup only unlinked `conversations/<cid>.pb` in `antigravity-cli`, omitted `--log-file`, and ran without `--mode plan`.

## Symptoms

- Leaked `[AGY_INTERNAL_WORKER]` entries appeared in Antigravity Desktop/CLI conversation lists as untitled chats showing only the prompt (under `--json-schema`, the reply is recorded as an internal `finish(...)` tool call at step type 132 with zero assistant text).
- On every `agy` startup, `store_client.go` background reconciliation (`conversation_summaries.db` rebuild from `conversations/*.db`) re-inserted lingering worker `.db` files even if `conversation_summaries` rows had been deleted.
- Worker invocations truncated `~/.gemini/antigravity-cli/cli.log` and, under user `"agentMode": "auto"` / `"toolPermission": "always-proceed"`, could run `run_command`/`read_file` inside `/tmp`.

## What Didn't Work

- Deleting only `conversations/<cid>.pb` and `conversation_summaries`: modern `agy` writes `conversations/<cid>.db` (+ `-wal`, `-shm`) and `presence/<cid>.lock`, and startup reconciliation re-indexes any surviving `.db`.
- Filtering only by `transcript.jsonl`: timed-out or pre-flush workers may only leave `conversations/<cid>.db` with `[AGY_INTERNAL_WORKER]` in `steps.step_payload` at `idx = 0`.

## Solution

1. Snapshot `brain/` and `conversations/*.db|*.pb` across `("antigravity-cli", "antigravity", "antigravity-ide")` before launching `agy`, then in `finally:` discover new worker CIDs via `ephemeral_cid`, `transcript.jsonl`, `steps.step_payload` at `idx = 0`, and `conversation_summaries.preview`, and unlink `brain/<cid>`, `conversations/<cid>.{pb,db,db-wal,db-shm}`, `presence/<cid>.lock`, plus rows in `conversation_summaries`, `conversations_fts`, and `conversation_parents`.
2. Pass `--mode plan`, `--disable-slash-commands`, `--log-file <temp>` (unlinked in `finally:`), `--print-timeout`, and an explicit no-tool prompt guard.

## Why This Works

Removing the `.db` (plus WAL/SHM) across all Antigravity product directories prevents `store_client.go` startup reconciliation from resurrecting ephemeral worker runs, while `--mode plan` + isolated `--log-file` stops unintended tool calls and `cli.log` clobbering.

## Prevention

Covered by unit tests in `config/plugins/memory/tests/test_worker_cleanup.py` and verified live against `call_llm_json()` + `agent-memory doctor`.

## References

0
