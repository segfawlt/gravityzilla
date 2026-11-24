---
name: systematic-debugging
description: >-
  Root-cause debugging workflow for bugs, test failures, flaky tests,
  regressions, and multi-layer failures. Load automatically before proposing
  fixes whenever unexpected behavior or failing tests occur.
---

# Systematic Root-Cause Debugging

Find and verify the root cause before writing a fix. Symptom patches mask bugs and waste turns.

## 1. Reproduce & Isolate Before Editing

1. **Read complete failure output:** Inspect full stack traces, exit codes, stderr, and line numbers without skimming.
2. **Check recent delta:** Inspect `git status`, `git diff`, and recent commits/config changes in the failing path.
3. **Lock a deterministic repro:** Identify the smallest command, test, or request that triggers the failure reliably. If non-deterministic, gather instrumentation data first — never guess at fixes blind.
4. **Reproduce on the matching surface yourself:** A UI bug reproduces in the UI, a CLI bug in the CLI, a service bug against the running service (use the repo's `verify-<app>` skill when present). Ask the user to reproduce only after driving the surface as far as it goes, with a specific reason it can't reach the target. If it won't fire directly, synthesize the trigger, tighten conditions, or add instrumentation until it does.

---

## 2. Single-Pass Multi-Boundary Probing

When a failure crosses multiple layers (`UI → API → service → DB`, `hook → CLI → subprocess`, `CI → build → env`):
- Instrument entry/exit inputs, config/env presence, and status at **each component boundary in a single diagnostic run** rather than guessing one layer per turn.
- Run once to pinpoint the exact boundary where valid input turns into missing/corrupt output, then remove temporary debug probes before committing.

---

## 3. Backward Call-Chain Tracing

When an error surfaces deep in the call stack (empty path, `undefined` field, wrong working directory, invalid ID):
1. Do **not** paper over the crash site (`if (!val) return`) as your primary fix.
2. Trace callers **upward** step-by-step to find where the bad/uninitialized value originated.
3. Fix the bug at the **source**, and keep local input/invariant guards at lower layers strictly as defense-in-depth.

---

## 4. Flaky & State-Polluted Tests

- **Condition waiting over `sleep`:** Never fix async test races by bumping `sleep()` / `setTimeout()` delays (unless explicitly testing timer/debounce durations). Poll or await the observable state transition (`waitFor(() => condition)` with a clear timeout message).
- **Suite pollution ("passes alone, fails together"):** When a test fails only alongside other tests due to leaked files, DB rows, mocks, or env vars, bisect the offending test file with `~/.agents/skills/systematic-debugging/scripts/find-polluter.sh <polluted_path_or_marker> '<test_glob>'`.

---

## 5. One Hypothesis at a Time & 2-Strike Stop

1. State one falsifiable root-cause hypothesis and make the smallest change to test it.
2. **Ship only what the evidence justifies:** Every shipped line traces to runtime evidence. Belt-and-suspenders code that "might help" is an untested hypothesis and does not ship. When evidence refutes a hypothesis, revert everything it motivated.
3. **Verify Red → Green on the same surface:** Confirm a regression test fails without the fix (or reproduce the failure before applying), then passes with the fix — on the surface where the bug was reproduced. Unit tests show branch behavior, not bug absence; an inconclusive or wrong-surface check is not a pass. When the bug has a cheap local test path, write the failing test before the fix; skip it when the test would be expensive, integration-heavy, or mostly test mocks. Commit test and fix together (never land a red commit).
4. **2-Strike Circuit Breaker — attack the premise:** If **2 consecutive fix attempts** fail the same check, **stop patching** and revert the failed edits so they don't compound. Then:
   - **Write the premise down:** the one sentence both failed fixes assumed (e.g., "the cache is stale because invalidation runs too late").
   - **Test the premise directly** before any third fix: make one observation that would come out differently if the premise were false. Look at how failures are distributed, not only how large they are.
   - **Follow the evidence:** if it contradicts the premise, the cause is elsewhere — look for what the failures share that the premise didn't predict. If it confirms the premise, ask the next "why"; earlier fixes may have treated a consequence.
   - **Remove the condition instead of compensating for it:** a cleanup mechanism that runs after the bug leaves the cause in place.
   - If the premise survives testing and fixes still fail, re-examine the architecture or surface what doesn't add up to the user.

---

## 6. Report

State what was broken, the root cause, the fix, and how it was verified. Paste the failing-before and passing-after output verbatim. If failing-before evidence could not be produced, say why and name the closest check used instead.
