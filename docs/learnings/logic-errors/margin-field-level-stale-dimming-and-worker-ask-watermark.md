---
title: Sidecar polling askUserStep watermark and field-level stale dimming
category: logic-errors
module: config/plugins/margin
tags: [margin, sidecar, polling, topics-worker, ui-flicker, state-machine]
problem_type: logic-error
date: 2026-11-26
---

# Sidecar Polling `askUserStep` Watermark and Field-Level Stale Dimming

## Problem

Folding instant `Ask` (`= ...`) generation into `topics-worker.mjs` while `overview.mjs` polls every `1000 ms` introduced two subtle state-coupling hazards: re-spawning the Flash worker on omitted `= ` lines, and clobbering fresh `Ask` or blanking `Take` during `working`.

## Symptoms

1. Because `resolveOverview` triggers `spawnTopicsWorker` on every `1000 ms` sidecar poll, leaving `askUserStep < lastUserStep` when Flash omits an optional `= ` line would re-launch an ephemeral LLM worker every second.
2. In [app.js](../../../config/plugins/margin/app/app.js), `isStalePlanning = ov.status === 'planning' && !ov.reported && Boolean(ov.previous)` switched the entire render target to `ov.previous`, overwriting a fresh worker `ov.wants` with the prior turn's text while `reported` was still `false`.
3. In [overview.mjs](../../../config/plugins/margin/lib/overview.mjs), restricting `previous` to `status === 'planning'` wiped prior `Take` blank as soon as tools started running (`status === 'working'`) before `margin_intent` landed.

## What Didn't Work

- Treating `ask` freshness as strictly conditional on non-empty `parseAsk` output, and dimming `#turn-group` wholesale via a single `isStalePlanning` target swap.

## Solution

1. In [topics.mjs](../../../config/plugins/margin/lib/topics.mjs) and [topics-worker.mjs](../../../config/plugins/margin/lib/topics-worker.mjs), advance `askUserStep = lastUserStep` whenever `applyTopicsReply` completes for a known step (even if `ask` is `''`), and track `targetUserStep` while `running: true` so each user step spawns at most once.
2. In [overview.mjs](../../../config/plugins/margin/lib/overview.mjs), keep `previous` populated whenever `(status === 'planning' || status === 'working' || status === 'waiting_agents') && !fresh?.take`, expose `wants: fresh?.wants || workerAsk || ''` with `wantsSource`, and keep `reported` independent of `workerAsk`.
3. In [app.js](../../../config/plugins/margin/app/app.js) and [app.css](../../../config/plugins/margin/app/app.css), apply `isFullStalePlanning` only when `!ov.wants && !ov.take && !ov.steps?.length`, and dim stale `Ask` / `Take` rows individually via `.row-sec.is-stale-field` so fresh `Ask` and live `Plan` / `Used` remain at full contrast.

## Why This Works

Separating the worker completion watermark (`askUserStep`) from optional text presence (`ask`) keeps `1000 ms` polling idempotent, while field-level stale resolution lets `0 ms` Flash `Ask` and live `working` telemetry appear immediately without erasing prior `Take`.

## Prevention

Pinned in `workerAsk: parseAsk, extractUserPromptsWithSteps, missing = tolerance, precedence, working-state previous, and rule wording` in [margin.test.mjs](../../../config/plugins/margin/tests/margin.test.mjs).

## References

0
