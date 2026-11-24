---
title: "Zero-tool-call turn completion must not force Plan steps done or override failed tool evidence"
category: logic-errors
module: config/plugins/margin/lib/overview.mjs
tags: [margin, state-machine, outcome, verification, guardrails, plan-steps]
problem_type: logic-error
date: 2026-11-20
---

# Zero-Tool-Call Turn Completion Must Not Force `Plan` Steps Done or Override Failed Tool Evidence

## Problem

In `config/plugins/margin/lib/overview.mjs`, `summarize()` marks any turn whose last `PLANNER_RESPONSE` has `tool_calls.length === 0` and `status === 'DONE'` as `status = 'done'`. Previously, `buildOverview()` used `status === 'done'` to force every remaining `Plan` step to `completed` and surfaced `✓ done` in the footer, even when the agent paused midway to ask a `Decision`/`**Next:**` question, ran no checks after editing files, or left a failing check behind.

## Symptoms

- Pausing at Step 2 of 3 to ask the user a choice showed `3/3 steps` and `✓ done` in the Margin pane, causing users to mistake blocked or interactive turns for finished work.
- Relying purely on an LLM summary for end-of-turn triage risks false-green `clear` badges when the model edits files without running checks or glosses over a failing test command.

## What Didn't Work

- Removing zero-tool-call detection for `status = 'done'`: zero tool calls is the runtime signal that the agent yielded control back to the user, and removing it would force every turn to spend an extra main-model MCP call.
- Trusting Flash worker classification (`clear`) unconditionally over transcript tool execution facts.

## Solution

1. **Separate control yield (`status`) from turn outcome (`outcome.kind`):** Compute `outcome` (`clear | needs_input | caveats | blocked`) from `extractTurnExecution()` + `buildHeuristicOutcome()` merged with the async Flash worker (`outcome.json`).
2. **Gate `Plan` auto-completion on `outcome.kind`:** Only auto-complete remaining `Plan` steps (both in live `steps` and stale-planning `previous.steps`) when `outcome?.kind !== 'needs_input' && outcome?.kind !== 'blocked'`.
3. **Enforce hard execution guardrails in `mergeOutcome()`:** Upgrade `clear` to `blocked` (`check failed`) when `verifyState === 'failed'`, to `caveats` (`unverified`) when edits lack post-edit verification (`verifyState === 'unverified'`), and to `needs_input` when `askedQuestion` is true. Set `archiveSafe = true` only when `kind === 'clear'` with no failed, unverified, or unresolved tool errors.

## Why This Works

Zero tool calls tells you *the agent stopped running*, not *why it stopped*. Combining deterministic tool-call evidence (which cannot be hallucinated away) with semantic classification of the final reply separates "yielded to ask or failed" from "cleanly finished" without adding any extra main-model inference step.

## Prevention

In `config/plugins/margin/tests/margin.test.mjs`:
- Assert `mergeOutcome()` overrides a `worker` `clear` response when `verifyState` is `'unverified'` or `'failed'`, or when `askedQuestion` is true.
- Assert `buildOverview()` leaves `in_progress` and `pending` `Plan` steps incomplete (both live and in `previous` during the next turn) whenever `outcome.kind` is `'needs_input'` or `'blocked'`.

## References

0
