# gravityzilla

Antigravity setup with taste

## What is included

1. **Global Rules & Directives (`config/GEMINI.md`)**:
   - Universal pair-programming contract, verification gates, and Git hygiene.
2. **Plugins (`config/plugins/`)**:
   - `diagnostics`: Instant post-edit syntax checks.
   - `memory`: Cross-session memory integration (`agent-memory` + `agy-compound` stop gate).
   - `playwright`: UI testing / MCP automation plugin.
   - `rtk`: Command output compressor and token condenser.
   - `stats`: Quota, token usage, and analytics dashboard.
   - `watchdog`: Zero-token execution tracking, loop circuit-breaker, hang recovery, and `agy-statusline` telemetry.
3. **Agent Skills (`.agents/skills/`)** — the standard cross-tool skills path. `install.sh` links this folder to `~/.agents/skills` (read natively by agent tools like ZCode) and into `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills` for Antigravity:
   - `audit`, `avoid-ai-design`, `blast-radius`, `compound`, `compound-refresh`, `correct`, `create-verification-skill`, `hallmark`, `ship`, `stats`, `systematic-debugging`, `taste-skill`, `ui-demo-prototype`.
   - `blast-radius`, `correct`, and `create-verification-skill` are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT, © 2026 Lauren Tan).
4. **Helper Binaries & Scripts (`bin/`)**:
   - `agent-memory`, `agy-compound`, `agy-diagnostics`, `agy-stats`, `agy-statusline`, `agy-watch`, `git-wt-sync`, `rtk`.
5. **Tool Configs (`config-extra/`)**:
   - `agy-stats/config.json`, `rtk/config.toml`, `rtk/filters.toml`.
6. **Settings Template (`templates/settings.json.template`)**:
   - Generates `~/.gemini/antigravity-cli/settings.json` with user-agnostic `$HOME` paths.

## Symlink Topology & Troubleshooting

By default, `./install.sh` (`--symlink`) wires live links from your home directories into this repository so edits and `git pull` updates take effect immediately:

- **Direct binary symlinks (`~/.local/bin/*` -> `<repo>/bin/*`):** `agent-memory`, `agy-compound`, `agy-diagnostics`, `agy-statusline`, `agy-watch`, `rtk`.
- **Chained plugin/skill binary symlinks:** `~/.local/bin/agy-stats` -> `<repo>/bin/agy-stats` -> `../config/plugins/stats/bin/agy-stats` and `~/.local/bin/git-wt-sync` -> `<repo>/bin/git-wt-sync` -> `../.agents/skills/ship/scripts/git-wt-sync` (keeps a single source of truth inside each plugin/skill).
- **Two-hop skills symlink chain:** `<repo>/.agents/skills` <- `~/.agents/skills` <- (`~/.gemini/config/skills` & `~/.gemini/antigravity-cli/skills`), so both standard `.agents/skills` tools and Antigravity resolve the same skill definitions.
- **Shared global config (`~/.gemini/config/`):** `~/.gemini/config/{GEMINI.md,plugins,mcp_config.json}` point into `<repo>/config/`, and are read by both Antigravity CLI and Antigravity Desktop. (`~/.gemini/config/config.json` and `~/.gemini/antigravity-cli/settings.json` remain regular local files to preserve machine state unless `--force` is passed.)

### Drift Check & Known Pitfalls

Run `./install.sh --status` to audit every link and copy for drift without modifying files.

- **Untracked `~/.local/bin/` executables:** `./install.sh --status` iterates `<repo>/bin/*`, not `~/.local/bin/`. If a helper binary is created directly in `~/.local/bin/` (as `agy-compound` originally was) instead of `<repo>/bin/`, `--status` will not detect it or flag missing repo tracking until the file is moved into `bin/` and symlinked back.
- **Shell redirect regex false-positives in Stop hooks:** In `agy-compound`'s `is_mutating_command` check, placeholder strings containing angle brackets (such as `-c <inline>`) or unstripped `->` arrows inside quoted `python3 -c` snippets can false-trigger the `[12]?>>?` shell redirect matcher when chained (e.g., `| head`). Replacement tokens must avoid `<` / `>`, and quoted strings must be stripped before testing redirect operators.

## Quick Start on a New Linux Machine

```bash
# 1. Clone your repo
git clone https://github.com/segfawlt/gravityzilla.git ~/gravityzilla
cd ~/gravityzilla

# 2. Run the installer (defaults to symlinks so git pull updates immediately)
./install.sh

# Or install as direct copies:
# ./install.sh --copy
```

## Requirements
- Linux (x86_64)
- Python >= 3.11
- `git`, `curl`
- `agy` CLI binary in `~/.local/bin` or your `$PATH`

