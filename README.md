# gravityzilla

Antigravity setup with taste

## What is included

1. **Global Rules & Directives (`config/GEMINI.md`)**:
   - Universal pair-programming contract, verification gates, and Git hygiene.
2. **Plugins (`config/plugins/`)**:
   - `diagnostics`: Instant post-edit syntax checks.
   - `gemini-api`: Gemini API, Live API, Omni Flash, Genie 4, and CLI skills + docs MCP server.
   - `margin`: Right-pane **Overview** sidecar & MCP App (`margin_intent`, Session/Topic, Plan, Result, Used, Context, Watchdog).
   - `memory`: Cross-session memory integration (`agent-memory` + `agy-compound` stop gate).
   - `playwright`: On-demand UI testing / MCP automation plugin (disabled by default in `config/config.json`).
   - `rtk`: Command output compressor and token condenser.
   - `stats`: Quota, token usage, and analytics dashboard.
   - `watchdog`: Zero-token execution tracking, loop circuit-breaker, hang recovery, and `agy-statusline` telemetry.
3. **Agent Skills (`.agents/skills/`)** — the standard cross-tool skills path. `install.sh` links this folder to `~/.agents/skills` (read natively by agent tools like ZCode) and into `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills` for Antigravity:
   - `agentsview-finding-history`, `audit`, `avoid-ai-design`, `blast-radius`, `claude-headless`, `compound`, `compound-refresh`, `correct`, `create-verification-skill`, `hallmark`, `pr`, `review`, `ship`, `stats`, `systematic-debugging`, `taste-skill`, `ui-demo-prototype`.
   - `blast-radius`, `correct`, and `create-verification-skill` are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT, © 2026 Lauren Tan).
4. **Helper Binaries & Scripts (`bin/`)**:
   - `agent-memory`, `agy-compound`, `agy-desktop-patch`, `agy-diagnostics`, `agy-stats`, `agy-statusline`, `agy-watch`, `git-wt-sync`, `rtk`.
5. **Antigravity Desktop ASAR Patcher (`desktop-patch/`)**:
   - Unified, reversible `app.asar` patcher (`agy-desktop-patch`) bundling `top-bar` (hide hub top menu bar), `overview` (auto-pin/open Margin Overview), and `model-search` (model picker search + hide toggles in Settings).
6. **Tool Configs (`config-extra/`)**:
   - `agy-stats/config.json`, `rtk/config.toml`, `rtk/filters.toml`. (Any private signing keys under `config-extra/agy-stats/keys/` are ignored and never deployed.)
7. **Settings Template (`templates/settings.json.template`)**:
   - Generates `~/.gemini/antigravity-cli/settings.json` with user-agnostic `$HOME` paths and safe default permissions (`trustedWorkspaces: []`, no auto-proceed override).

## Symlink Topology & Troubleshooting

By default, `./install.sh` (`--symlink`) wires live links from your home directories into this repository so edits and `git pull` updates take effect immediately, while preserving existing user files unless `--force` is passed (which creates `.bak.<timestamp>` backups):

- **Direct binary symlinks (`~/.local/bin/*` -> `<repo>/bin/*`):** `agent-memory`, `agy-compound`, `agy-diagnostics`, `agy-statusline`, `agy-watch`, `rtk` (`x86_64` only; skipped with a warning on other architectures).
- **Chained plugin/skill binary symlinks:** `~/.local/bin/agy-desktop-patch` -> `<repo>/bin/agy-desktop-patch` -> `../desktop-patch/patch.mjs`, `~/.local/bin/agy-stats` -> `<repo>/bin/agy-stats` -> `../config/plugins/stats/bin/agy-stats`, and `~/.local/bin/git-wt-sync` -> `<repo>/bin/git-wt-sync` -> `../.agents/skills/ship/scripts/git-wt-sync`. In `--copy` mode, `agy-desktop-patch` installs `patch.mjs` + `lib/` into `~/.local/share/gravityzilla/desktop-patch/` with a wrapper script in `~/.local/bin/`.
- **Skills linking without clobbering:** `<repo>/.agents/skills` <- `~/.agents/skills` <- (`~/.gemini/config/skills` & `~/.gemini/antigravity-cli/skills`). If any target is already a real directory, `install.sh` links individual skills inside it rather than nesting a symlink.
- **Per-plugin links & copied mutable configs (`~/.gemini/config/`):** `~/.gemini/config/{GEMINI.md,mcp_config.json}` and individual plugins (`~/.gemini/config/plugins/<name>` -> `<repo>/config/plugins/<name>`) are linked into the repo so existing Marketplace plugins remain untouched. Mutable state files (`~/.gemini/config/config.json`, `~/.gemini/antigravity-cli/settings.json`, `~/.config/agy-stats/config.json`, `~/.config/rtk/{config.toml,filters.toml}`) are copied once so runtime updates never dirty git.

### Drift Check & Uninstall

- Run `./install.sh --status` to audit every link and copy for drift without modifying files.
- Run `./install.sh --uninstall` to remove gravityzilla symlinks and copy wrappers while keeping your local configs (`config.json`, `settings.json`, `~/.config/agy-stats/`, `~/.config/rtk/`, `~/.agents/memories/`).

### Customization Notes

- **`config/GEMINI.md`** includes opinionated global directives (such as the `ultracave` terse voice and swarm model tiers like `gemini-4-carbon-high`). Edit it to fit your preferred style or model lineup.
- **`templates/settings.json.template`** keeps `trustedWorkspaces: []` and leaves `model` and `toolPermission` unset by default; configure those per your preference in `~/.gemini/antigravity-cli/settings.json`.

### Known Pitfalls

- **Untracked `~/.local/bin/` executables:** `./install.sh --status` iterates `<repo>/bin/*`, not `~/.local/bin/`. If a helper binary is created directly in `~/.local/bin/` instead of `<repo>/bin/`, `--status` will not detect it until moved into `bin/` and linked.
- **Shell redirect regex false-positives in Stop hooks:** In `agy-compound`'s `is_mutating_command` check, placeholder strings containing angle brackets (such as `-c <inline>`) or unstripped `->` arrows inside quoted `python3 -c` snippets can false-trigger the `[12]?>>?` shell redirect matcher when chained (e.g., `| head`). Replacement tokens must avoid `<` / `>`, and quoted strings must be stripped before testing redirect operators.

## Quick Start on a New Linux Machine

```bash
# 1. Clone the repo
git clone https://github.com/segfawlt/gravityzilla.git ~/gravityzilla
cd ~/gravityzilla

# 2. Run the installer (defaults to symlinks; preserves existing files unless --force is passed)
./install.sh

# Or install as direct copies:
# ./install.sh --copy

# Remove gravityzilla symlinks later without touching local configs/memories:
# ./install.sh --uninstall
```

## Windows Support (Portable Subset)

Use [`install.ps1`](./install.ps1) in PowerShell (works on Windows PowerShell 5.1 and PowerShell 7+, no Admin required):

```powershell
# Copy portable subset (rewrites Windows Python hook commands cleanly)
powershell -ExecutionPolicy Bypass -File .\install.ps1

# Or use NTFS directory junctions for skills and non-rewritten plugins
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Junction

# Audit installed files/junctions for drift, or uninstall
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Status
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

| Category | Included on Windows | Skipped (Linux-only / Patching) |
| --- | --- | --- |
| **Rules & Config** | `config/GEMINI.md`, `config.json`, `mcp_config.json`, `settings.windows.json.template` | `agy-statusline` |
| **Plugins** | `gemini-api`, `playwright`, `margin` (open Overview tab manually), `stats`, `diagnostics` | `watchdog`, `memory` (`agent-memory`, `agy-compound`), `rtk` |
| **Skills & Patching** | 16 portable skills under `.agents/skills/` | `ship` (`git-wt-sync` bash), `desktop-patch` (`app.asar` patcher) |

## Requirements

- **OS / Arch:** Linux (`x86_64` for bundled `bin/rtk`; other Linux architectures skip `rtk` and can install it via `cargo` or upstream releases), or Windows 10/11 (portable subset via `install.ps1`)
- **Python:** >= 3.11 (earlier Python 3 degrades TOML diagnostics in `agy-diagnostics`)
- **Node.js:** >= 22.13 (for Margin `node:sqlite` rollout queries, `agy-desktop-patch`, and `taste-skill` CDP; Margin degrades `memory.db` reads gracefully on older Node)
- **Core CLI tools:** `git`, `curl`, `agy` CLI in `~/.local/bin` or `$PATH`

### Optional Dependencies (Per Plugin / Skill)

| Tool / Env Var | Used By | Purpose |
| --- | --- | --- |
| `sqlite3` | `margin` (`agy-worker.mjs`) | Cleans up ephemeral `"Untitled Session"` summaries |
| `npx` | `drawio`, `playwright`, `create-verification-skill` | Launches MCP / Playwright packages |
| `bun`, `ruff`, `shellcheck`, `gofmt`, `PyYAML` | `agy-diagnostics` | Fast TS/TSX/JSONC/YAML/Lint syntax checks |
| `chromium` / `google-chrome` | `playwright`, `taste-skill`, `hallmark`, `ui-demo-prototype` | Headless browser screenshots & CDP inspection |
| `ffmpeg` / `ffprobe`, `GEMINI_API_KEY` | `gemini-api` (`gemini-omni-flash-api`) | Video inspection & Gemini API workflows |
| `claude`, `agentsview`, `gh`, `tmux`, `TOGETHER_API_KEY` | Optional skills | `claude-headless`, `agentsview-finding-history`, `pr`, `create-verification-skill`, `hallmark` imagegen |
