---
name: correct
description: >-
  Find the mistakes agents keep repeating in this repo and make each one
  impossible instead of adding more prose: architecture first, then types, then
  a lint or CI check whose error names the fix, then a test, docs last. Proves
  each check fails on a real past mistake and keeps a rule→enforcement table.
  Use for /correct, "stop agents doing X", or when the user corrects the same
  class of mistake a second time.
---

# Correct

The user keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent can't make them.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design the repo so a change that looks right from one file is right for the whole repo.

Relationship to `compound`: `compound` records one verified lesson as prose in `docs/learnings/`. `correct` takes mistake *classes* — including `compound` promote candidates — and turns them into enforcement. Prose is the last resort here.

## 1. Find the mistake classes

Gather evidence, then group mistakes into classes. A class counts once it has happened twice.

- `git log` for reverts, `fix:` commits that undo agent work, and recurring review-comment themes.
- `docs/learnings/README.md` — especially `## Promote Candidates` (3+ references).
- `AGENTS.md`, `.agents/rules/*.md`, and code comments that explain workarounds — a rule written down that still gets violated is a class.
- The current conversation's corrections. Read other conversation transcripts only when the user points to them; do not sweep transcripts from unrelated projects.

## 2. Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code an agent would copy.
2. **Enforce it with types** so the bad state can't be written.
3. **Lint or CI check** when bad code still compiles: the error message names the file, type, or function to use instead. If the pattern is already common, fail only on new occurrences (ratchet), not existing ones.
4. **Test the behavior.** Fix or delete any test that still passes when the behavior it checks breaks, or fails when only internals change.
5. **Docs or agent rules last**, only for judgment calls. Nothing fails when an agent skips them. Prefer a path-scoped `.agents/rules/<topic>.md` over a project-wide `AGENTS.md` line.

**Escalation boundary (per `GEMINI.md`):** apply autonomously only changes that are local and reversible — a test, a rule in an *existing* linter config, a type tightening, deleting a dead duplicate. Escalate as a `decision` anything that changes a public API or schema, adds a dependency or CI infrastructure, or restructures architecture; include the evidence and your recommended level.

## 3. Fix and prove

- Fix the most frequent classes first, one commit each.
- **Prove each new check fails on a real past mistake:** reintroduce the mistake (or check out the offending commit's version of the file) and show the check's error output, then show it passing on the fixed tree. A check never seen failing is unproven.
- The check runs with the same command locally and in CI (if CI exists).
- Exceptions go on the offending line with a reason and, where the linter supports it, an expiry.

## 4. Keep the rule table

Maintain a table in the repo's `AGENTS.md` pairing each rule with what enforces it:

```markdown
## Enforced rules

| Rule | Enforced by |
| --- | --- |
| Use `db.tx()` for multi-row writes | lint: `no-raw-multi-write` (eslint.config.js) |
| Never import from `internal/` across packages | architecture: package `exports` map |
| Retry policy lives in `net/retry.ts` only | docs only — judgment call |
```

- When the user corrects you: fix the mistake and add the row.
- If the rule was already in the table with `docs only` and was violated again, that's a repeat — move it up a level in the same change.
- Drop a row once its mistake can't happen (e.g., the API it guarded was deleted).

## Output

For each class: the evidence (commits, comments, learnings), the level chosen, why a higher level didn't work, and the failing-then-passing proof. Then list escalated `decision` items with options and a recommendation.

<!-- Adapted from pstack's correct skill (MIT, © 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack -->
