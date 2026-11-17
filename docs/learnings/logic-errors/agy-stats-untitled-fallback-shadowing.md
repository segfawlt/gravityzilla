---
title: Defaulting empty DB titles at ingest shadows subagent and preview fallbacks
category: logic-errors
module: config/plugins/stats/bin/agy-stats
tags: [agy-stats, subagents, swarm, title-fallback]
problem_type: logic-error
date: 2026-11-17
---

# Defaulting Empty DB Titles at Ingest Shadows Subagent and Preview Fallbacks

## Problem

In `config/plugins/stats/bin/agy-stats`, `load_raw_telemetry()` populated `conv_meta[cid_row]["title"] = r[1] or "Untitled Session"` when reading `conversation_summaries.db`.

## Symptoms

- Downstream resolution (`meta_entry.get("title") or (f"{agent_type} ({cid[:8]})" if meta_entry.get("parent") else "Untitled Session")`) never ran for subagents or native swarm workers (`agent_name` + `parent_conversation_id` set, `title == ""`) because `"Untitled Session"` is truthy.
- All 19 subagent/swarm worker sessions and short untitled chats (with valid `preview`) rendered as `"Untitled Session"`.

## What Didn't Work

Adding fallback branches only at `session_base` / `req_obj` construction while `conv_meta` still replaced empty strings with `"Untitled Session"`.

## Solution

Keep `conv_meta[cid_row]["title"] = (r[1] or "").strip()` raw at ingest, detect `[AGY_INTERNAL_WORKER]` from `preview` into `internal_worker_cids` as well, and resolve display titles in `_resolve_session_display_title()`:
- Non-empty non-placeholder DB title -> use it.
- Internal worker -> `"Internal Worker (<cid[:8]>)"`.
- Child with `parent` -> `"<parent_title> › <agent_type>"` (or `"<agent_type> (<cid[:8]>)"`).
- Top-level untitled session -> cleaned first line of `first_user_text` / `preview` (ignoring bare `/resume` stubs) before falling back to `"Untitled Session"`.

## Why This Works

Preserving `""` until the unified resolver runs lets parent-title inheritance, agent labeling, and prompt-preview fallback take effect uniformly across `session_base`, `all_requests`, `errors`, and `frustrations`.

## Prevention

Tested in `config/plugins/memory/tests/test_worker_cleanup.py` (`test_agy_stats_resolve_session_display_title`).

## References

0
