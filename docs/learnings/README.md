# Learnings Index

Indexed catalog of durable lessons captured by the `compound` skill. Check entries with relevant
tags before non-trivial work.

## Pending Terms

## Promote Candidates

Lessons referenced 3+ times. Promotion is a user decision.

## integration-issues/

- [Ephemeral agy worker sessions and 0-step CLI stubs require SQLite/flock-guarded cleanup](./integration-issues/agy-ephemeral-worker-sqlite-cleanup.md) — Purge `conversations/<cid>.db*`, WAL/SHM, locks, and FTS rows across agy product dirs, isolate `--log-file` + `--mode plan` for workers, and reap unlocked/artifact-free `0-step` CLI stubs after a grace window. `#agy #worker #sqlite #cleanup #cli-log #json-schema #flock #zero-step-stubs`

## logic-errors/

- [Defaulting empty DB titles at ingest shadows subagent and preview fallbacks](./logic-errors/agy-stats-untitled-fallback-shadowing.md) — Preserve empty DB titles until `_resolve_session_display_title()` so swarm/subagent children and previewed sessions do not collapse to `"Untitled Session"`. `#agy-stats #subagents #swarm #title-fallback`
