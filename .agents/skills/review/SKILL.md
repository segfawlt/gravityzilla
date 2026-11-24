---
name: review
description: Request or perform a structured branch/diff code review (with Complexity & YAGNI analysis) before PR/merge, or rigorously evaluate incoming code review feedback against codebase reality before implementing.
---

# Code Review & Review Reception

Use **Mode 1** when reviewing your branch or a diff before merging/opening a PR. Use **Mode 2** when evaluating feedback from human reviewers, CI bots, or other agents.

## Mode 1: Reviewing a Branch or Diff (Pre-PR / Pre-Merge)

### 1. Compute Exact Scope
- Inspect the branch diff (`git diff <merge-base>...HEAD` plus any uncommitted working tree changes).
- Read surrounding context and callers for touched modules — never judge a hunk in isolation.

### 2. Dispatch Strategy
- **Small diff (1–3 files, local scope):** Review inline with full file reads.
- **Multi-file or cross-cutting branch:** Dispatch a fresh subagent (`TypeName: "self"` or `"research"`, `Model: "pro"`) with a self-contained brief: exact commit range (`BASE_SHA..HEAD_SHA`), requirements/spec, and list of touched files — never your whole conversation history.

### 3. Review Output Format

1. **Findings Table** (ordered Critical → Important → Minor; cite `file:line` for every claim):
   ```markdown
   ### Findings

   | **#** | **severity** | **where** | **issue** | **fix** |
   |---|---|---|---|---|
   | **1** | Critical | `path/file.ts:42` | concrete defect or broken invariant | specific minimal fix |
   ```
2. **Complexity & YAGNI Lens** (flag genuine over-engineering only, one line each with tags):
   - Tags: `delete:` (dead/unused code), `stdlib:` (reimplemented standard lib), `native:` (reimplemented framework/OS primitive), `yagni:` (speculative abstraction), `shrink:` (collapsible duplication).
   - End with `net: -<N> lines possible` or `Lean already.`
3. **Assessment:** One line — `Ready to merge`, `Ready after fixes 1..K`, or `Needs rework`.

## Mode 2: Receiving Code Review Feedback

Technical correctness over social comfort. Verify every suggestion against codebase reality before editing.

1. **Read & Clarify First:**
   - Never use performative openers (`"You're absolutely right!"`, `"Great point!"`).
   - If any item in a multi-item review (`"Fix 1–6"`) is ambiguous, stop and ask before editing interrelated items.
2. **Verify Against Code & Git History:**
   - Check whether the suggestion breaks existing callers, invariants, or platform constraints.
   - Check `git log -S` / `git blame` / comments before changing seemingly odd code — it may handle an explicit edge case.
3. **YAGNI Check on "Implement Properly" Requests:**
   - If a reviewer asks to generalize or harden an unused endpoint/helper, `rg` the codebase for callers first. If unused, propose deleting it instead of adding dead complexity.
4. **Push Back or Apply in Order:**
   - If a suggestion is wrong for this codebase, push back with concrete `file:line` or test evidence.
   - Otherwise apply fixes sequentially (**Critical/Security → Simple fixes → Complex logic**), running verification after each logical fix.
