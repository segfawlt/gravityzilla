---
name: compound-refresh
description: Audit and maintain the current repository's versioned docs/learnings/ tree and path-scoped .agents/rules/ for stale guidance, broken references, duplicates, obsolete lessons, index drift, and promotion candidates. Use when the user asks to audit, refresh, or clean up project learnings, or after a major relevant refactor.
---

# Compound Refresh

Keep `docs/learnings/` (and promoted `.agents/rules/*.md` guardrails) accurate, searchable, and
aligned with current code. This workflow maintains version-controlled team knowledge; it does not
mirror lessons into auto memory (`~/.agents/memories/`) or managed skills.

## Scope

Use the scope named by the user. Without a scope hint, audit all of `docs/learnings/` plus
`.agents/rules/`.

For 20 or more learning files, triage first:

1. Read every frontmatter block and group by category or module.
2. Check whether primary referenced files and symbols still exist.
3. Start with the cluster containing the most broken or stale references.

For smaller corpora, review every learning in one pass.

## Interaction

Default to action for unambiguous Keep, Update, and broken-index repairs. Ask the user (via
`ask_question` or plain text) only when Delete, Replace, Consolidate, or Promote has materially
different valid outcomes the user must choose. Batch related questions in one call and provide a
recommendation.

If running headlessly, complete every non-destructive repair and report unresolved decisions; do not
fail the audit merely because the session is non-interactive.

## Outcomes

| Outcome         | Condition                                                                         | Action                                                                                    |
| --------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Keep**        | Guidance remains correct and useful                                               | No learning edit; report it as reviewed                                                   |
| **Update**      | Core lesson is correct but paths, names, links, or examples drifted               | Edit in place and set `last_updated: <today>`                                             |
| **Consolidate** | Two correct learnings substantially overlap                                       | Merge unique content into one canonical document, then remove the duplicate with approval |
| **Replace**     | Core guidance is misleading and current architecture requires different guidance  | Write a verified successor through `compound`, then remove the old document with approval |
| **Delete**      | Implementation and problem domain are gone and no meaningful inbound link remains | Remove with approval; Git history preserves it                                            |

If the Solution, Guidance, or Why section requires substantive rewriting, classify it as Replace,
not Update.

## Audit Procedure

### 1. Validate structure

List files, search (`rg`), and read focused sections to verify:

- Every learning has `title`, `category`, `tags`, and `date` frontmatter.
- `tags` is a YAML array.
- Every document ends with `## References` and one integer.
- Category directories and slugs match the `compound` conventions.
- `last_updated` appears only on documents changed after creation.

### 2. Validate the index

For every `docs/learnings/README.md` entry:

- Confirm its relative Markdown link resolves.
- Confirm title, category, summary, and tags still describe the target.
- Remove entries whose target no longer exists.

Add missing entries for valid learning files. Replace non-portable wiki links such as `[[slug]]` with
relative Markdown links so repository renderers and file tools expose navigable targets.

### 3. Validate guidance against code

Check the learning's primary files, symbols, behavior, and examples against current implementation.
Do not treat a renamed file as deleted guidance: search for moved symbols before classifying drift.

Keep evidence separate from inference. A passing historical test alone does not prove current
architecture still follows the documented pattern.

### 4. Detect overlap

Search titles, tags, modules, root causes, and recommendations across the corpus.

- Same problem, root cause, and fix: Consolidate.
- Same area but different constraint or failure mode: keep both and add reciprocal relative links.
- Shared background only: Keep; do not merge distinct lessons into a generic document.

### 5. Guard destructive outcomes

Before recommending Delete, verify all three:

1. The implementation is gone or fully superseded.
2. The problem domain is no longer active.
3. Inbound links are absent or only decorative.

If any check fails, prefer Update, Replace, or Consolidate.

### 6. Check terms and promotions

Inspect `## Pending Terms` in the index. At five terms, recommend bootstrapping `docs/CONCEPTS.md`;
create it only with explicit user approval.

Verify every `## Promote Candidates` entry against its learning's reference count. Three or more
references makes a candidate, not an automatic project rule. Promotion always requires an explicit
user decision. When approved, prefer a path-scoped guardrail over growing `AGENTS.md`:

```markdown
---
trigger: glob
globs: apps/server/src/hono/**/*.ts, apps/server/src/bot/**/*.ts
description: One-line summary of the guardrail
---

- DO ... (link: docs/learnings/<category>/<slug>.md)
- DO NOT ...
```

Save it as `.agents/rules/<topic>.md`. Keep each rule file to roughly 5–20 lines of imperative
DO / DO NOT bullets that link back to the full learning. The shared memory hook injects a rule once
per session the first time the agent reads or edits a file matching `globs` (comma-separated or a
YAML list, relative to the repository root; `**` matches across directories). Mark the source
learning's title with `[PROMOTED]`.

### 7. Validate path-scoped rules

For every `.agents/rules/*.md` file with `trigger: glob`:

- Confirm `globs` still match at least one existing file (`rg --files -g '<glob>'`).
- Confirm linked learnings still exist and the guardrail still matches current code.
- Flag rules longer than ~25 lines; move detail back into the linked learning.

### 8. Check AGENTS integration

Verify that `AGENTS.md` (or `CLAUDE.md`) points agents to `docs/learnings/README.md` before relevant
non-trivial work and names the `compound` trigger. If either is absent, report the gap rather than
editing persistent project instructions implicitly.

## Completion

Report:

- Keep, Update, Consolidate, Replace, and Delete classifications.
- Files changed and destructive decisions deferred.
- Broken links, missing index entries, metadata errors, and dead rule globs repaired.
- Pending terms and promotion candidates.
- Whether `AGENTS.md` discovery and trigger integration are sufficient.
