---
name: blast-radius
description: >-
  Find what a change could break outside its own diff before it ships, and prove
  the one fact that makes it safe by running real code instead of writing it up.
  Use for "blast radius of X", "what could this break", "is this safe to merge",
  or reviewing a small diff you don't trust yet.
---

# Blast Radius

Find what a change breaks somewhere else, before it ships. Read-only toward the change under review: report findings, do not fix them unless the user asks.

Listing callers is not the job — `rg` does that in a second. The job is the breakage a symbol search won't show you.

Companion to `audit`: `audit` hunts for bugs across a surface; `blast-radius` asks what *one change* breaks downstream.

## Don't trust your own writeup

A blast-radius writeup that sounds right is worthless; it reads as convincing whether or not it's true. Find the one or two facts the change's safety depends on and prove them by running code.

### Evidence ladder

For each fact the change's safety depends on, push it as far down this list as is cheap, and say where it stopped:

1. **Asserted.** You said so. Worthless on its own.
2. **Cited.** A real `file:line`, or the dependency's own source at its pinned version.
3. **Walked.** You traced the failure path step by step and showed it can't reach.
4. **Ran.** A script or test calls the real code and fails loudly if you're wrong.
5. **Reproduced.** You exercised it in the running app (via the repo's `verify-<app>` skill when present).

Level 4 is usually one small script that imports the same library the app ships and calls the exact function in question. Put probe scripts in `<artifactDir>/scratch/`, not the repo, unless the user wants them committed as regression tests.

## Steps

1. **Read the change.** The diff, the symbols it adds, changes, and deletes, and what it now does differently — including behavior the diff doesn't spell out. Use `git log -p`, `git blame`, and the PR/commit messages for intent.
2. **Find the one fact it's safe because of.** Most risky-looking changes are safe because of a single fact, like "this call only drops already-dead cache entries". If it holds, most risk cases clear at once. Spend your time here, not on a long list of maybes.
3. **Look where grep stops.**
   - Dependency source at the pinned version, plus any local patch or override.
   - Timing: when things run — microtasks, teardown/unmount, async ordering, retries, process exit.
   - Data crossing boundaries: JSON an API returns, a DB column, a wire or file format, another language or service reading the same bytes, serialized caches, feature flags, config defaults, code several hops downstream.
4. **Rate each risk honestly.** Give each a real likelihood and a real cost. Keep confirmed risks; list checked-and-cleared ones separately. Cite real `file:line`. A search that finds nothing is still an answer — say what you searched. Never invent a caller or an API.
5. **Prove the one fact.** Write a script or test that runs the real code, run it, and paste the output.
6. **Wide changes only:** for a change spanning many modules or a public contract, optionally fan out two `research` subagents on different models with the same question and merge their findings — different models catch different real bugs. Verify any finding yourself before reporting it.

## Output

- **What it does.** What changed, including the non-obvious part.
- **The one safety fact.** State it, the ladder level reached, and the proof (command + output). If unproven, write `unproven` and why.
- **Risks.** Each with how it breaks, `file:line`, likelihood × cost, and how to check. Paste proof for the ones that matter. Tag `Observed` or `Inferred` per `audit`.
- **Cleared.** What you checked and why it's fine.
- **Before you merge.** The cheapest test or repro that would catch the real bug, including any probe script you wrote.

<!-- Adapted from pstack's blast-radius skill (MIT, © 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack -->
