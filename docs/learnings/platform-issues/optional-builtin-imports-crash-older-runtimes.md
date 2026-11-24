---
title: Static Top-Level Built-In Imports Crash Plugins on Older LTS Runtimes
category: platform-issues
module: config/plugins/margin/lib/memory.mjs
tags: [node, node-sqlite, python, tomllib, lts, graceful-degradation, margin, diagnostics]
problem_type: platform-issue
date: 2026-11-25
---

# Static Top-Level Built-In Imports Crash Plugins on Older LTS Runtimes

## Problem

Plugins and hooks imported optional newer standard-library modules (`node:sqlite` in [memory.mjs](file:///home/domixi/Projects/gravityzilla/config/plugins/margin/lib/memory.mjs) and `tomllib` in [agy-diagnostics](file:///home/domixi/Projects/gravityzilla/bin/agy-diagnostics)) unconditionally at module load time.

## Symptoms

- Importing `node:sqlite` statically (`import { DatabaseSync } from 'node:sqlite'`) requires unflagged Node `>= 22.13` (it fails with `ERR_UNKNOWN_BUILTIN_MODULE` on Node 18, 20, and 22.0–22.12). Because `margin/lib/overview.mjs` imports `memory.mjs`, both the Margin MCP server and Overview sidecar fail to boot on standard Linux LTS Node packages.
- Importing `tomllib` unconditionally crashes `agy-diagnostics` for every language (`python`, `json`, `ts-js`, etc.) when invoked on Python `<= 3.10`, even though `install.sh` only warned about Python `< 3.11`.

## Solution

Guard optional newer runtime built-ins at import time and degrade only the affected sub-feature:

- In [memory.mjs](file:///home/domixi/Projects/gravityzilla/config/plugins/margin/lib/memory.mjs), load `DatabaseSync` via top-level `await import('node:sqlite')` wrapped in `try/catch`, and return an empty rollout list in `readExtractedMemories` when `DatabaseSync` is `null`.
- In [agy-diagnostics](file:///home/domixi/Projects/gravityzilla/bin/agy-diagnostics), wrap `import tomllib` in `try/except ImportError`, return `None` in `check_toml`, and report `"unavailable (requires Python >= 3.11)"` in `detect_host_engines`.
- Emit explicit version warnings for Python `< 3.11` and Node `< 22.13` in [install.sh](file:///home/domixi/Projects/gravityzilla/install.sh) and document the requirements in [README.md](file:///home/domixi/Projects/gravityzilla/README.md).

## Why This Works

Deferring or catching optional built-in imports isolates version-specific features (`memory.db` rollout excerpts in Margin and `.toml` parsing in `agy-diagnostics`) so the rest of the plugin boots and serves core functionality on older LTS runtimes.

## Prevention

Whenever a core plugin or hook imports a built-in module introduced after Python 3.10 or Node 20 LTS, wrap the import in a fallback guard unless the entire tool strictly requires that runtime, and check version minimums in `install.sh`.

## References

0
