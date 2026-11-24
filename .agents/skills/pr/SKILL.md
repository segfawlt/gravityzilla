---
name: pr
description: Use before opening or editing a pull request (gh pr create / gh pr edit) or preparing a branch for review — runs pre-PR convention/verification checks, reorganizes logical commits, and formats the PR description template.
---

# Pull Request & Pre-Push Discipline

Run every check below before opening, editing, or pushing a pull request.

## 1. Pre-PR Verification Checklist

- **Sibling Convention Check (New Files):** For every newly created file, read at least one existing sibling of the same kind and confirm imports, module structure, test style, and docstring conventions match.
- **No Unanchored New Patterns:** For any new marker, convention, or config key you added, run `git grep` on the base branch. If it has zero hits and wasn't explicitly requested, reconsider introducing a second convention.
- **Evidence Behind Convention Claims:** Never claim "follows repo convention" without naming the concrete sibling file that proves it.
- **Run Documented Commands Verbatim:** Execute every command shown in the PR description, docstrings, or updated docs as written. If any fails for an unrelated reason, fix or file it instead of footnoting a skip.
- **Blast Radius & Post-Deploy Steps:** Identify any config/env/schema/migration step required for existing deployments (`**Action required:**`), and explicitly note side effects, ordering constraints, or unexercised paths (`**Not covered:**`).
- **User-Facing Doc Sync:** If a CLI flag, setting, hook contract, or UI behavior changed, verify the corresponding `README.md` / `docs/` entry matches.

## 2. Commit Hygiene Before First Push

- **Reorganize WIP Automation Commits:** If local work accumulated checkpoint commits (`wip:`, repeated fixups) inside an isolated branch or worktree, show the proposed clean logical commit plan, regroup via `git reset --soft <base>` + `git add <paths>`, and confirm `git diff <old-head> HEAD` is empty before pushing.
- **Never Push Unverified State:** Run the full relevant test, typecheck, and lint checks *after* your final edit or commit reorganization.
- **Conventional Commit Format:**
  - Subject: `<type>(<scope>)?: <imperative subject <= 50 chars>` (`feat`, `fix`, `refactor`, `chore`, `docs`, `test`).
  - Body (plain text, no `**` markdown, no file lists — `git show --stat` shows files):
    ```text
    Why: <1 line — trigger or root cause>
    Impact: <who/what changes for callers/users; omit if none>
    Verify: <exact command(s) run>
    Refs: <#issue / SHA; Depends on: <PR> when ordering matters>
    ```

## 3. PR Description Template

Markdown renders in GitHub PRs — bold section labels and keep each `Changes:` bullet to one logical line (`path` only when not obvious):

```markdown
**Why:** <1 line — trigger or root cause>

**Changes:**
- <logical change, 1 line>

**Impact:**
- <affected callers, config, data, or behavior>

**Action required:** <post-deploy migration/config step; omit if none>

**Not covered:** <out-of-scope findings or side effects; omit if none>

**Test plan:**
- [x] <exact verification command run and observed pass>
- [ ] <remaining manual/CI check if applicable>
```
