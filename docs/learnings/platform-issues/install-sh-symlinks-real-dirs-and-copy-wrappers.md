---
title: Installer ln -sfn Nests Inside Real Directories and --copy Breaks Chained JS Entrypoints
category: platform-issues
module: install.sh
tags: [install, symlinks, ln-sfn, plugins, copy-mode, esm, desktop-patch, bash]
problem_type: platform-issue
date: 2026-11-25
---

# Installer `ln -sfn` Nests Inside Real Directories and `--copy` Breaks Chained JS Entrypoints

## Problem

Deploying `gravityzilla` on a clean or partially configured Linux machine via `install.sh` hit four structural installer bugs:

1. `ln -sfn "$SRC/.agents/skills" "$HOME/.agents/skills"` nests a `skills` symlink *inside* `$HOME/.agents/skills/` whenever the target is already a real directory instead of a symlink.
2. Symlinking `~/.gemini/config/plugins` as a single directory causes Marketplace plugin installs to write into the git repository and clobbers a user's existing plugins.
3. Chained binary symlinks like `bin/agy-desktop-patch -> ../desktop-patch/patch.mjs` break under `--copy`, because `cp -p` dereferences the symlink and copies `patch.mjs` alone into `~/.local/bin/` without `../desktop-patch/lib/*.mjs`.
4. Unconditional `rm -rf "$dest"` without checking `--force` silently deletes existing user configs (`GEMINI.md`, `mcp_config.json`, `~/.local/bin/*`), while wildcarding `config-extra/agy-stats/*` deploys private `keys/` files.

## Symptoms

- Running `install.sh` when `~/.agents/skills` already exists as a directory produces `~/.agents/skills/skills -> <repo>/.agents/skills`, breaking skill discovery and `--status`.
- Running `~/.local/bin/agy-desktop-patch` after `./install.sh --copy` fails with `ERR_MODULE_NOT_FOUND` for `./lib/asar.mjs`.
- Installing a Marketplace plugin in Antigravity creates untracked plugin directories inside `<repo>/config/plugins/`.

## Solution

Refactor [install.sh](../../../install.sh) around four invariants:

1. **Detect real directories before `ln -sfn`:** In `deploy_skills_link`, if `$dest_dir` is a real directory (`-d` and `! -L`), iterate each child skill and call `deploy_file` per subdirectory instead of calling `ln -sfn`.
2. **Link per plugin and copy mutable configs:** Ensure `~/.gemini/config/plugins` is a real directory (migrating any legacy whole-dir symlink) and link/copy each plugin individually; copy mutable state files (`config/config.json`, `config-extra/agy-stats/config.json`, `config-extra/rtk/{config,filters}.toml`) explicitly via `deploy_template` so runtime writes never dirty git and `keys/` is never deployed.
3. **Stage multi-file JS tools in `--copy` mode:** `deploy_desktop_patch_copy` copies `desktop-patch/patch.mjs` and `desktop-patch/lib/` into `~/.local/share/gravityzilla/desktop-patch/` and writes an executable `exec node` wrapper at `~/.local/bin/agy-desktop-patch`.
4. **Preserve on conflict by default:** When `--force` is false, skip existing non-matching destinations (`SKIP_COUNT`); when `--force` is true, move existing regular files/dirs to `${dest}.bak.${BACKUP_STAMP}` before replacing.

## Why This Works

- On POSIX systems, `ln -sfn` only treats `-n` (`--no-dereference`) as "replace the symlink itself" when the destination is a symlink, never when it is a real directory.
- Copying `patch.mjs` plus its relative `lib/` directory into a shared `~/.local/share/gravityzilla/desktop-patch/` tree keeps ESM relative imports (`./lib/*.mjs`) intact without polluting `~/.local/bin/` with non-executable `.mjs` subdirectories.

## Prevention

Keep `install.sh` E2E verification running against isolated temp `HOME` directories covering:

- Fresh `--symlink` install (`plugins/` is a real dir, mutable configs are regular files, `keys/` is absent).
- Pre-populated real `~/.agents/skills/` and `~/.gemini/config/plugins/user-plugin/` with conflicting `GEMINI.md` (preserved without `--force`, `.bak.*` created with `--force`, no nested `skills/skills` symlink).
- `--copy` mode executing `~/.local/bin/agy-desktop-patch --help` and passing `./install.sh --status`.

## References

0
