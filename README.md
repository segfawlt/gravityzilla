# Antigravity Setup

Portable, standalone configuration and tool suite for Antigravity on Linux.

## What is included

1. **Global Rules & Directives (`config/GEMINI.md`)**:
   - Universal pair-programming contract, verification gates, and Git hygiene.
2. **Plugins (`config/plugins/`)**:
   - `advisor`: Persistent Advisor subagent system.
   - `diagnostics`: Instant post-edit syntax checks.
   - `ledger`: Multi-session same-file edit collision ledger.
   - `memory`: Cross-session memory integration.
   - `playwright`: UI testing / MCP automation plugin.
   - `rtk`: Command output compressor and token condenser.
   - `stats`: Quota, token usage, and analytics dashboard.
3. **Skills (`config/skills/`)**:
   - `audit`, `compound`, `compound-refresh`, `ship`, `systematic-debugging`, `taste-skill`, `ui-demo-prototype`, `worktree-sync`.
4. **Custom Subagents (`config/agents/`)**:
   - `advisor-core.md`.
5. **Helper Binaries & Scripts (`bin/`)**:
   - `agent-memory`, `agy-advisor`, `agy-diagnostics`, `agy-ledger`, `agy-stats`, `agy-statusline`, `git-wt-sync`, `rtk`.
6. **Tool Configs (`config-extra/`)**:
   - `agy-stats/config.json`, `rtk/config.toml`, `rtk/filters.toml`.
7. **Settings Template (`templates/settings.json.template`)**:
   - Generates `~/.gemini/antigravity-cli/settings.json` with user-agnostic `$HOME` paths.

## Quick Start on a New Linux Machine

```bash
# 1. Clone your repo
git clone <your-repo-url> ~/Projects/antigravity-setup
cd ~/Projects/antigravity-setup

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
