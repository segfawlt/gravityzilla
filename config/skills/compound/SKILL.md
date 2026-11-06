---
name: compound
description: Capture a verified, non-trivial, durable bug fix, workaround, pattern, or design decision in the current repository's versioned docs/learnings/ tree. Trigger after phrases such as "that worked", "it's fixed", "working now", or "problem solved", or after resolving a non-obvious bug.
---

# Compound Learning

Capture verified project knowledge so future agents do not repeat the investigation. This workflow
writes version-controlled team knowledge under `<repo>/docs/learnings/`.

Layer boundaries (do not duplicate a lesson across them):

| Layer | Holds |
| --- | --- |
| `AGENTS.md` | Static project contract: map, stack, commands, invariants |
| `.agents/rules/*.md` | Short path-scoped DO / DO NOT guardrails (promoted learnings) |
| `docs/learnings/` (this skill) | Full technical postmortems, root causes, patterns |
| Auto memory (`~/.agents/memories/`) | Non-code only: user, feedback, project status, references |

Never write a technical lesson into auto memory, and never write personal preferences here.

## Strict Gate

Write a learning only when all three conditions hold:

1. The problem or decision is solved and verified.
2. The lesson is non-trivial; not a typo or obvious one-line correction.
3. The lesson is durable; a future agent could plausibly repeat the mistake.

Then require at least two "yes" answers:

- Would a future agent likely make the same mistake without this document?
- Is this a non-obvious library, framework, platform, or project workaround?
- Does it contradict a likely assumption?
- Will the pattern recur in the same module or area?

If either gate fails, do not write. Report: `No learning captured — <reason>.`

## Storage

Write `docs/learnings/<category>/<slug>.md` at the repository root. Use a descriptive 3–6 word
kebab-case slug with no date; frontmatter `date` is canonical.

**Categories:** if `docs/learnings/README.md` already lists categories, use those (first match
wins). Otherwise use the first matching default:

- `build-errors/` — compiler, bundler, package manager, toolchain
- `test-failures/` — test runner, mocks, fixtures, assertions
- `runtime-errors/` — crashes, unhandled rejections, resource leaks
- `database-issues/` — schema, migrations, queries, transactions
- `security/` — auth, permissions, secrets, injection, trust boundaries
- `integration-issues/` — HTTP routes, APIs, IPC, streaming, middleware
- `platform-issues/` — OS, desktop environment, drivers, shells, packaging
- `logic-errors/` — state machines, ordering, concurrency, business logic
- `performance/` — latency, memory, scaling
- `architecture-patterns/` — module boundaries and architecture decisions
- `design-patterns/` — reusable non-architectural patterns
- `conventions/` — team-agreed practices
- `tooling-decisions/` — durable tool or library choices
- `best-practices/` — fallback only when no narrower category fits

**Bootstrap:** if `docs/learnings/` does not exist, create `docs/learnings/README.md` with this
skeleton before writing the first learning:

```markdown
# Learnings Index

Indexed catalog of durable lessons captured by the `compound` skill. Check entries with relevant
tags before non-trivial work.

## Pending Terms

## Promote Candidates

Lessons referenced 3+ times. Promotion is a user decision.
```

## Document Tracks

### Bug track

```markdown
---
title: Short searchable title
category: logic-errors
module: src/path/to/module.ts
tags: [area, invariant]
problem_type: logic-error
date: YYYY-MM-DD
---

# Short Searchable Title

## Problem

What was broken and where.

## Symptoms

Observable behavior and exact errors.

## What Didn't Work

Failed approaches and why they failed.

## Solution

The verified fix, with focused code when useful.

## Why This Works

The root cause and why the fix addresses it.

## Prevention

A behavioral check, invariant, or regression scenario that prevents recurrence.

## References

0
```

### Knowledge track

```markdown
---
title: Short searchable title
category: architecture-patterns
module: src/area
tags: [architecture, boundary]
problem_type: design-decision
date: YYYY-MM-DD
---

# Short Searchable Title

## Context

What prompted the guidance.

## Guidance

The durable practice or decision.

## Why This Matters

The consequences of following or ignoring it.

## When to Apply

Concrete applicability boundaries.

## Examples

Focused examples when useful.

## References

0
```

Required frontmatter: `title`, `category`, `tags`, and `date`. `module` and `problem_type` are
recommended. Add `last_updated` only when updating an existing learning. `tags` must be a YAML
array. Quote YAML values containing `: ` or ` #`.

Every learning ends with `## References` followed by one integer. New learnings start at `0`;
creation is not a consultation reference.

## Workflow

### 1. Detect overlap

Before writing:

- List the files in the target `docs/learnings/<category>/` directory.
- Search (`rg`) category titles, tags, modules, and `docs/learnings/README.md`.
- Read the closest matches.

Classify overlap:

- **High:** same problem, root cause, and fix. Update the existing document and add
  `last_updated: <today>`.
- **Moderate:** same area, different lesson. Create a new document and add standard relative
  Markdown links in both documents.
- **Low or none:** create the new document.

Never create two documents for the same lesson.

### 2. Write or update the learning

Use the appropriate track. Include observed evidence, the verified fix or decision, its limits, and
prevention. Do not record speculation as durable guidance.

### 3. Update the index

Add or update the matching category bullet in `docs/learnings/README.md` (create the `## <category>/`
heading if missing):

```markdown
- [Title](./category/slug.md) — one-sentence retrieval summary. `#tag1 #tag2`
```

Keep the index link, title, summary, tags, and target synchronized. Remove stale index entries whose
targets no longer exist.

### 4. Surface project terms

Identify terms whose project meaning is not obvious from ordinary usage. If `docs/CONCEPTS.md`
exists, add a one-line definition; otherwise add the term under `## Pending Terms` in the learning
index. Self-explanatory UI names do not qualify.

At five pending terms, report that `docs/CONCEPTS.md` should be bootstrapped. Create that separate
glossary only with explicit user approval.

### 5. Check discoverability

Verify that the repository's `AGENTS.md` (or `CLAUDE.md`) points agents to
`docs/learnings/README.md` and names the `compound` trigger. If it does not, report the
integration gap and suggest the two lines below. Do not edit project instructions unless the user
explicitly asks.

```markdown
- Before non-trivial work, inspect `docs/learnings/README.md` for matching tags.
- After a durable non-obvious fix, workaround, or design decision, use the `compound` skill.
```

### 6. Track consultations

When an existing learning materially guides current work, increment its `## References` integer by
one. Reading for inventory, audit, or overlap detection does not count.

At three references, add or update its `## Promote Candidates` bullet in
`docs/learnings/README.md`. Promotion is still a user decision. Promotion targets:

- A short path-scoped guardrail in `.agents/rules/<topic>.md` when the lesson applies to specific
  files (preferred — it loads only when matching files are touched; see the frontmatter format in
  `compound-refresh`).
- A one-line rule in `AGENTS.md` only when it applies project-wide.

Never promote automatically.

## Completion Output

New document:

```text
Learning captured: docs/learnings/<category>/<slug>.md — <title>.
Term surfaced: <term or "none">.
References: 0.
```

Updated document:

```text
Learning updated: docs/learnings/<category>/<slug>.md — <title>.
References: <n>.
```
