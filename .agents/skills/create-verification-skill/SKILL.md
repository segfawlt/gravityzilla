---
name: create-verification-skill
description: >-
  Generate a project-local `verify-<app>` skill that drives the real app the way
  a user does (launch, health check, drive, capture evidence, clean up) for any
  language, framework, or surface. Use for /create-verification-skill, "make a
  verification skill for this repo", or when a project has no scripted way to
  prove UI, CLI, or service behavior.
---

# Create a Verification Skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as a project-local skill at `<repo>/.agents/skills/verify-<app>/`, which Antigravity loads for any session in that workspace.

Write the output for the next agent, not a human: it will be read cold, mid-task, by an agent that has never seen the app.

## 1. Interview the repo, not the user

Answer these from the codebase; ask the user only what you cannot observe:

- **Surface:** What does a user actually touch — web UI, CLI/TUI, desktop app, HTTP API, library? Pick the primary surface and note the rest.
- **Run:** How does the app start locally? Prefer the repo's documented dev command (package scripts, Makefile, README). Note ports, required env var *names* (never values), seed data, and auth.
- **Drive:** How can an agent interact programmatically? Existing harnesses first — Playwright/Cypress specs, test helpers, curl-able endpoints, a debug port. Only then a generic recipe:
  - Web/Electron: a small script using the repo's own Playwright dependency (or `npx playwright`). The `playwright` MCP plugin is off by default; do not make the generated skill depend on it.
  - CLI/TUI: direct invocation with exit codes and captured stdout/stderr; `tmux` (`send-keys` / `capture-pane`) for interactive TUIs.
  - Services: `curl` with status codes and response bodies.
- **Observe:** What evidence can be captured — screenshots, ARIA snapshots, terminal transcripts, response bodies, logs, exit codes, files, DB rows?
- **Isolate:** Can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill — refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout doesn't build or start as-is, fix that first (within the autonomy boundary in `GEMINI.md`) or report it precisely. A skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup, the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

## 2. Generate the skill

Write `<repo>/.agents/skills/verify-<app>/SKILL.md` with YAML frontmatter — `name: verify-<app>` and a `description` naming the app, the surface, and when to use it (without frontmatter the skill never registers). Include these sections, each grounded in what the interview found — no placeholders:

- **Launch:** The exact command, and how to tell it's *usable* (a log line, a 200 from a real route, a prompt) — not merely that a process answers. Must reach a usable state from an empty data dir, including migrations and seed data. In Antigravity, start long-running servers with `run_command` `IsDaemon: true` and record the task ID for teardown. For a short-lived CLI, launch means build or install once, then run each drive in isolation.
- **Doctor:** One read-only check answering "is this instance worth driving?" — process up, expected version/build, port owned by this run, auth valid. Run it first whenever anything looks off.
- **Drive:** The harness recipe with real selectors and commands from this repo, not examples. Prefer stable handles (ARIA roles/names, `data-*` attributes, prompt strings, route paths) over coordinates and tab order. Wait on observable state, never fixed sleeps.
- **Evidence:** What to capture and where. Default location `<artifactDir>/scratch/verify-<app>/<run-id>/` unless the repo already has an artifacts convention. Proof standards:
  - Exercise the real user path, not internal setters or test-only endpoints.
  - Capture the action *and* the resulting state, not just the final screen.
  - Verify side effects (files written, rows inserted, requests sent) alongside what's visible.
  - Mock only where a production boundary already isolates the external system.
  - When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name.
- **Cleanup:** Tear down only what this run started — kill by recorded task/PID, never by process name. Cleanup removes instances and scratch state, never the evidence.
- **Helpers:** Any script the skill ships lives in `verify-<app>/scripts/`, is executable, and its invocation is shown in the skill body. A helper the reader has to reverse-engineer is not a helper.

## 3. Seed the feature map

Create `verify-<app>/features/README.md` (index + baseline preconditions: URL/port, disposable data dir per run, seed records) plus one file per user-facing feature — start with the top 3–5 from routes, commands, menus, or docs. Each feature file uses these four H2s:

```markdown
# <Feature name>

One sentence: what the user can do and what distinguishes success from failure.

## Sub-features
- `search-match` returns title and body matches without changing data.
- `search-empty` shows the empty state for a query with no matches.

## How to get to it (user POV)
- Click `Search` in the toolbar, or press `/` outside an editable field.

## Driving it with <harness>
Preconditions: instance healthy per Doctor; seed note `Quarterly plan` exists.
- **Title match.** <exact command>. Results contain `Quarterly plan`, not `Grocery list`.
- **Proof.** <exact capture command> → `<evidence dir>/search/results.png`.

## Gotchas
- Results debounce; wait for the results list or empty status, not a fixed sleep.
```

If seed data lacks a precondition a journey needs, the journey reports failure and the reason goes in `Gotchas`. Never weaken a journey to make it pass. The map is the repo's maintained verification source: a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill before handing it over

Run its own instructions end to end once: launch → doctor → drive **one** mapped feature → capture evidence → clean up. After cleanup, confirm the evidence still exists at the named location — a cleanup that eats the proof fails this step. Fix what fails, and run cleanup after every failed iteration so broken attempts don't strand processes or ports.

A generated skill that was never executed is a draft, not a deliverable. If you proved it in a stand-in for the real target (a container instead of a fresh machine, a local stack instead of a remote one), list every setup step the stand-in did that the target will not; those stay unverified.

Once proven, commit the skill directory per the green-milestone rule.

## 5. Keep it honest

Add this maintenance note to the generated skill's body:

- When a feature's UI, command, or route changes, update its feature file in the same change.
- When a verify run fails because the recipe is stale (not because the app is broken), fix the recipe first, then re-run.
- Add a feature file the first time a new user-facing feature needs verification.

## Output

Report the surface chosen, the files created, the feature map entries, and the proof run: commands, evidence paths, and the cleanup result. List anything left unverified.

<!-- Adapted from pstack's create-verification-skill (MIT, © 2026 Lauren Tan): https://github.com/cursor/plugins/tree/main/pstack -->
