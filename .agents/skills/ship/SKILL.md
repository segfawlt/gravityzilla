---
name: ship
description: >-
  Audit, sync, merge, verify, prune, and push parallel Git worktrees into main.
  Use when the user invokes /ship or asks to wrap up, merge all finished
  worktrees into main, reconcile parallel agent branches, clean up worktrees,
  or ship to the remote repository. Detects uncommitted work, stuck Git states,
  detached HEADs, squash-equivalents, cross-worktree semantic overlaps ("ghost
  conflicts"), lockfile conflicts, and cascade conflicts via git wt-sync; pushes
  to remote by default unless the user asks for local-only / no-push sync or no
  remote exists.
---

# Ship: End-to-End Worktree Reconciliation, Verification & Push (`/ship`)

Execute this runbook autonomously from start to finish whenever the user runs `/ship`, says **"everything is finished"**, **"merge all worktrees"**, or asks to clean up worktrees and push.

- **Default (`/ship`):** Reconcile all worktrees into `main`, verify `main`, prune merged trees/branches, and push `main` to remote.
- **Local-only mode:** When the user asks to sync/merge worktrees *without* pushing (e.g., *"merge worktrees locally"*, *"sync worktrees, don't push"*, `/ship --local`) — or when no Git remote is configured — run Steps 1–5 + restore any pre-merge stash, and skip remote push in Step 6.

> **Hard Safety & Non-Destructive Invariants:**
> 1. **Never `git push` broken code:** Full verification (`typecheck`, `lint`, `test` / `build`) MUST pass on `main` before pruning or pushing.
> 2. **Never `git push --force` to `main`/`master`.**
> 3. **Never discard unverified user work** (`git reset --hard`, `git checkout -- .`, `git clean -fd`) without explicit confirmation:
>    - Legitimate finished feature edits: stage selectively and commit.
>    - Unfinished local WIP or collision blocks: stash safely (`git stash push -u -m "ship: pre-merge main WIP"`).
>    - Build artifacts or secrets (`.env*`, `*.log`, `node_modules/`, `dist/`, nested `.worktrees/`): warn and exclude from commits.
> 4. **Primary Worktree Integration:** Always perform merges from the **primary worktree** checked out on `main`. Never check out `main` inside a secondary worktree.

---

## Step 1: Run Zero-Mutation Audit (`git-wt-sync`)

Run the diagnostic script from anywhere in the repository:

```bash
~/.agents/skills/ship/scripts/git-wt-sync
```

*(Also available as `git wt-sync` when `~/.local/bin` is on `PATH`.)*

The script is **100% read-only** in audit mode (zero temporary objects written to `.git/objects`). Interpret its badges systematically:

1. **Header Placement Alerts**:
   - `🚨 TARGET BRANCH MISPLACED`: Target branch (`main`) is checked out in a secondary worktree rather than the primary worktree.
   - `⚠️ PRIMARY WORKTREE ON '<other>'`: Primary worktree is checked out on a feature branch instead of `main`.
   - `Stashes found`: Existing stashes that may hold unfinished work.
2. **Worktree Status Badges & Operations**:
   - `[👻 MISSING DIR]`: Worktree directory deleted on disk without `git worktree remove`; unmerged commits on its branch are still audited.
   - `[🔒 LOCKED: <reason>]`: Pinned worktree; `--prune-merged` skips deleting it.
   - `🚨 IN-PROGRESS REBASE / MERGE / CHERRY-PICK`: Pending Git operation with unresolved state.
   - `🔒 INDEX LOCKED`: Stale `index.lock` file.
   - `🚨 NESTED WORKTREE NOT GITIGNORED`: Secondary worktree inside another worktree's tree without ignore entry.
3. **Commit & Working Tree States**:
   - `⚠️ N uncommitted file(s)`: Breakdown of unmerged, staged, unstaged, and untracked files.
   - `⚠️ Suspicious untracked`: Flags `.env*`, `*.log`, `node_modules/`, `build/`, etc.
   - `🚨 LEFTOVER CONFLICT MARKERS`: Committed or staged `<<<<<<<` markers.
4. **Merge Readiness**:
   - `✅ Already merged / identical`: 0 commits ahead, 0 dirty files — ready to prune.
   - `✅ Already integrated (squash/patch-equivalent, 0 net diff)`: Squash-merged into `main`; safe to prune with `git branch -D`.
   - `✅ Clean merge into main`: Clean 3-way merge, no file overlap.
   - `👀 SEMANTIC OVERLAP`: Clean text merge, but touches files overlapping other worktrees or commits on `main`.
   - `⚠️ BLOCKED BY DIRTY 'main'` / `❌ CONFLICTS WITH UNCOMMITTED WORK IN 'main'`: Collides with uncommitted files in `main`.
   - `⚠️ LOCKFILE-ONLY CONFLICT`: Conflicted files are exclusively lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `Cargo.lock`, `uv.lock`, etc.).
   - `💥 CASCADE CONFLICT`: Merges cleanly alone against `main`, but conflicts once preceding peer branches merge.
   - `📌 Unmerged local branches (no active worktree)`: Local branches ahead of `main` with no active checkout.

*(If `Total trees == 1`, ensure primary is on `main`, clear any stuck Git state, selectively commit finished task files on `main`, check `📌 Unmerged local branches`, and proceed directly to Step 5).*

---

## Step 2: Stabilize Stuck States, Nested Worktrees, & Branch Placement

1. **Abort half-finished operations & clear stale locks**:
   ```bash
   git -C "<wt_path>" rebase --abort   # or git merge --abort / git cherry-pick --abort
   rm -f "$(git -C "<wt_path>" rev-parse --path-format=absolute --git-path index.lock)"
   ```
2. **Ignore nested worktrees** (when `🚨 NESTED WORKTREE NOT GITIGNORED: .worktrees/<name>` appears):
   ```bash
   echo ".worktrees/" >> "$(git rev-parse --git-common-dir)/info/exclude"
   ```
3. **Fix target branch placement**:
   - Primary worktree on `feat/x` (`main` not checked out elsewhere): commit or stash work on `feat/x`, then `git checkout main`.
   - `main` checked out in secondary worktree `<sec_wt>`: inside `<sec_wt>`, run `git -C "<sec_wt>" checkout -b "wt/<topic>"` (or `checkout --detach` if clean with 0 commits ahead), then `git checkout main` in the primary worktree.

---

## Step 3: Triage Dirty Work in `main` AND Secondary Worktrees

### A. Triage Dirty Files in `main`
Git `merge` refuses to run when incoming branches touch dirty or untracked files in `main`:
1. **Finished code on `main`**: selectively stage (`git add <files>`) and commit (`git commit -m "chore: commit finished edits on main"`).
2. **Unfinished local WIP on `main`**: `git stash push -u -m "ship: pre-merge main WIP"`.
3. **Byte-identical untracked duplicates**: if an untracked file on `main` matches an incoming branch file byte-for-byte, `rm "<untracked_file>"` so `git merge` can track it.

### B. Triage Secondary Worktrees (Including Detached `HEAD`)
1. **Detached `HEAD` with work**: attach a branch first so commits cannot be orphaned:
   ```bash
   git -C "<wt_path>" checkout -b "wt/<descriptive-name>"
   ```
2. **Commit finished secondary work** (inspecting `status --short` and `diff`, excluding `.env*`, `*.log`, `node_modules/`, and build outputs):
   ```bash
   git -C "<wt_path>" add -u -- .
   git -C "<wt_path>" add <new_source_files>
   git -C "<wt_path>" commit -m "<descriptive conventional message>"
   git -C "<wt_path>" diff --check HEAD~1 HEAD
   ```

---

## Step 4: Ordered Merge, Semantic Overlaps, & Conflict Resolution

Re-run `~/.agents/skills/ship/scripts/git-wt-sync` for a fresh merge plan, then merge from the **primary worktree** on `main`:

1. **Skip `✅ Already merged` and `✅ Squash/patch-equivalent` branches** (pruned in Step 5).
2. **Merge clean independent branches first**:
   ```bash
   git merge --no-ff "<branch>" -m "Merge branch '<branch>'"
   ```
3. **Merge `👀 SEMANTIC OVERLAP` branches second**:
   ```bash
   git merge --no-ff "<branch>" -m "Merge branch '<branch>'"
   ```
   Immediately inspect the overlapping functions/imports/types flagged by `git wt-sync` and run a fast verification check (`pnpm typecheck`, `cargo check`, `pytest`, etc.) before merging the next branch.
4. **Resolve conflicts by rebasing inside `<wt_path>`** (`git -C "<wt_path>" rebase main`) so `main` stays green:
   - **Lockfile-only (`⚠️ LOCKFILE-ONLY CONFLICT`)**: never hand-edit lockfiles. Keep dependency additions from both manifests, run `git -C "<wt_path>" checkout --ours <lockfile>`, regenerate via package manager (`pnpm install` / `npm install` / `cargo generate-lockfile` / `uv lock` / `go mod tidy`), then `git -C "<wt_path>" add <lockfile> <manifest> && git -C "<wt_path>" rebase --continue`.
   - **Additive / signature adaptations**: inspect `git -C "<wt_path>" log -p main..HEAD`, adapt calls/imports/schemas to `main`'s updated contracts, verify tests in `<wt_path>`, and continue rebase.
   - **Contradictory product intent**: do not guess — ask the user concisely which behavior wins (or provide a rebase handoff prompt if another session owns `<wt_path>`).
   - Once rebased, re-run `~/.agents/skills/ship/scripts/git-wt-sync` and `git merge --no-ff "<branch>" -m "Merge branch '<branch>'"` on `main`.

---

## Step 5: Full Verification Gate & Prune Merged Worktrees

1. **Run full verification on `main`** (detect from `package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, or `AGENTS.md`):
   - Typecheck & lint (`pnpm typecheck && pnpm lint`, `cargo check`, `ruff check` / `mypy`).
   - Test & build (`pnpm test`, `npm test`, `cargo test`, `pytest`, `go test ./...`).
   - If integration regressions surface, fix and commit cleanly on `main` and re-verify until green. Stop and ask if product intent is ambiguous.
2. **Review orphan local branches**: if `git wt-sync` reported `📌 Unmerged local branches (no active worktree)` not belonging to the finished cohort, confirm with the user before merging or deleting them.
3. **Prune merged secondary worktrees & local branches**:
   ```bash
   ~/.agents/skills/ship/scripts/git-wt-sync --prune-merged
   ```
4. **Sanity check `main`**: run `git status --short` and `git diff --check` to confirm `main` is clean and conflict-marker-free.

---

## Step 6: Sync with Remote, Push `main`, & Restore Stash

1. **Check local-only / remote status**:
   - If the user asked for local-only sync (*"don't push"*, *"local only"*) **or** `git remote -v` returns nothing, skip Step 6.2 and go to Step 6.3.
2. **Fetch & push safely**:
   - Check upstream tracking branch: `git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null`.
   - If upstream exists (e.g., `origin/main`):
     1. `git fetch origin`
     2. Check `git rev-list --count HEAD..@{u}`. If `> 0`, run `git pull --rebase` (resolve trivial lockfile/additive conflicts if needed and re-run Step 5 verification; stop and ask on non-trivial conflicts).
     3. `git push`
   - If `origin` exists without upstream tracking on `main`: `git push -u origin main`.
3. **Restore pre-merge WIP stash (if created in Step 3)**:
   ```bash
   git stash pop
   ```

---

## Step 7: Report Concise Ship Summary

Report briefly:
- Branches/worktrees integrated (and any uncommitted work committed or stashed).
- Verification commands run and passed (`Observed`).
- Secondary worktrees and branches pruned.
- Remote push status (`origin/main` commit range pushed, or `local-only — push skipped`).
