---
title: Queued and repeated user prompts skip arrival PreInvocation in Watchdog
category: logic-errors
module: bin/agy-watch
tags: [watchdog, pre-invocation, margin, queued-turns, userStep, transcript]
problem_type: logic-error
date: 2026-11-26
---

# Queued and Repeated User Prompts Skip Arrival `PreInvocation` in Watchdog

## Problem

Antigravity does not fire `PreInvocation` before the immediate `PLANNER_RESPONSE` of a queued follow-up `USER_INPUT` — the hook arrives one tool batch later. Meanwhile, repeating the exact same prompt text (such as `"go"`) keeps `lastUserInput` unchanged across turns.

## Symptoms

- Watchdog's string-equality turn check (`user_in != sess["last_user_input"]`) failed to detect repeated short follow-up prompts as new turns.
- One-shot `turn_step_count == 2` Margin nudges missed delayed `PreInvocation` turns, could false-nudge when the agent had already reported `margin_intent` in the immediate batch, and accepted `wants`-only `intent.json` writes lacking a valid `take`.
- `_prev_turn_missed_margin` missed queued turns that never called `margin_intent`, because `sess["turn_started_epoch"]` still held the prior turn's timestamp.

## What Didn't Work

- Relying on `lastUserInput` text changes, `turn_step_count == 2`, and `updatedAt >= turn_started_epoch` alone in [agy-watch](../../../bin/agy-watch).

## Solution

In [agy-watch](../../../bin/agy-watch):
1. Scan `USER_INPUT` rows (`source == "USER_EXPLICIT"`) in `transcript.jsonl` via `_transcript_explicit_user_steps` to extract `(cur_user_step, prev_tx_user_step)`.
2. Treat `cur_user_step != sess["last_user_step"]` as `is_new_user_turn` even when `lastUserInput` matches the previous prompt verbatim.
3. Require both a valid `take` (`stance` in `{fine, concern, against, unsure}` + non-empty `label`) and `intent.userStep == cur_user_step` in `_intent_has_fresh_take`, suppressing duplicate Step-1 nudges when `already_fresh` is true and checking `userStep >= prev_user_step` in `_prev_turn_missed_margin`.
4. Replace the `turn_step_count == 2` one-shot nudge with a capped check (`margin_missing_nudges < 2`) whenever `_intent_has_fresh_take` remains false.

## Why This Works

`transcript.jsonl` records every explicit user turn's authoritative `step_index` regardless of whether `PreInvocation` ran at turn arrival or was deferred until the second tool batch, and `margin_intent` persists that exact `userStep` alongside `take`.

## Prevention

Pinned in `test_12_margin_pre_invocation_nudge_and_missed_turn` and `test_14_margin_queued_turn_user_step_and_already_reported` in [test_watchdog.py](../../../config/plugins/watchdog/tests/test_watchdog.py). Never gate turn boundaries or `intent.json` freshness solely on `lastUserInput` strings or `turn_step_count == 2`.

## References

0
