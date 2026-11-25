---
title: agy CLI context_window stdin diverges on resume, mid-turn streams, and CHECKPOINT compactions
category: logic-errors
module: bin/agy-statusline
tags: [agy, statusline, context-window, tokens, checkpoint, transcript, margin]
problem_type: logic-error
date: 2026-11-19
---

# `agy` CLI `context_window` Stdin Diverges on `--resume`, Mid-Turn Streams, and Compactions

## Problem

`agy-statusline` and transcript telemetry showed wrong or zeroed context window counts in `agy` CLI sessions, and falsely colored 1M-window Gemini sessions red using a hardcoded `180k` threshold.

## Root Causes (`Observed`)

Disassembling `~/.local/bin/agy` (`store.BuildStatusLineData`, `agent_state_component.newContextWindowUsage`, `applyCompactionInfo`, `commitHistoryLoaded`) and comparing against 160 real `conversations/*.db` and `transcript.jsonl` logs revealed:

1. **Exact `PLANNER_RESPONSE` token formula (NOT double-counting):**
   - `tokens = input_tokens + cache_read_tokens + cache_write_tokens + output_tokens`
   - `input_tokens` is strictly the uncached prompt delta (never inclusive of `cache_read_tokens`), and `output_tokens` already sums thinking + response tokens.
2. **Three stdin `context_window` divergence modes in `agy`:**
   - **Mid-stream / cancelled `gen_metadata`:** `LatestGeneratorMetadata` is initialized at stream start with `{input: 0, output: 0, cache_read: 0}`, causing `current_usage` on stdin to sum to `0` mid-turn.
   - **`--resume` sessions:** `LatestGeneratorMetadata` remains `nil`, so `current_usage` is `null` and `BuildStatusLineData` sets `total_input_tokens` to only the last step's uncached `InputTokens` (e.g., `1,813` instead of `173,438`).
   - **Post-compaction (`CHECKPOINT`, `source == "SYSTEM"`):** `applyCompactionInfo` updates `CompactedStepIndices` without clearing `LatestGeneratorMetadata`, leaving stale pre-compaction `current_usage` on stdin. Conversely, `CHECKPOINT.input_tokens + cache_read_tokens` is the pre-compaction summarizer's prompt and must not be treated as active conversation context.
3. **Naive transcript tail reads:**
   - Reading only the last `32 KB` misses `PLANNER_RESPONSE` whenever trailing `GENERIC` tool outputs exceed `32 KB`.
   - Substring filtering for `'input_tokens'` skips 100%-cached steps.

## Solution

In `bin/agy-statusline` and `config/plugins/margin/lib/transcript.mjs`:
1. Scan backward across chunks (up to full post-`CHECKPOINT` window, with `chunks/transcript/` fallback in `agy-statusline` and 8 MiB tail read in `margin`) to find the latest main-agent `PLANNER_RESPONSE` strictly **after** the last `CHECKPOINT`.
2. Sum `input_tokens + cache_read_tokens + cache_write_tokens + output_tokens`.
3. Immediately after a `CHECKPOINT` before the next `PLANNER_RESPONSE`, estimate `(checkpoint.output_tokens || ceil(len(checkpoint.content) / 4)) + ceil(postCheckpointChars / 4)`.
4. Fall back to `context_window.total_input_tokens` (Cortex `EstimatedTokensUsed`) or `ceil(chars / 4)` only when the provider omits usage metadata completely (`custom-*`), and compute thresholds dynamically against `context_window_size` / model limits (e.g. `1M` for Gemini/Orchestrator vs `200k` for Claude).

## Verification

- `python3 -m unittest discover -v -s config/plugins/watchdog/tests -p 'test_*.py'`: 18/18 passed.
- Benchmarked across 18 real CLI and Desktop sessions: exact match with forward ground-truth token counts in ~20–23ms subprocess wall time (`<25ms` budget).
