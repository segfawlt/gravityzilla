---
title: Node.js ES Modules realpath symlink resolution defeats string equality main-module guards
category: integration-issues
module: config/plugins/margin/mcp/server.mjs
tags: [node, esm, symlinks, mcp, plugins, stdio, language-server]
problem_type: integration-issue
date: 2026-11-19
---

# Node.js ES Modules `realpath` Resolution Defeats String-Equality Main-Module Guards

## Problem

When writing standalone ES module (ESM) scripts or stdio MCP servers in Node.js (such as `mcp/server.mjs`), developers commonly guard execution with:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  // start stdio server
}
```

In Antigravity, user plugin directories are often symlinked (for example `~/.gemini/config/plugins -> ~/Projects/gravityzilla/config/plugins`). When the Antigravity Language Server spawns a plugin MCP server defined in `mcp_config.json`, it invokes `node ${PLUGIN_ROOT}/mcp/server.mjs` using the uncanonicalized symlink path:
`node /home/domixi/.gemini/config/plugins/margin/mcp/server.mjs`.

## Symptoms

- The MCP server process starts and immediately exits with code 0 without errors or stderr output.
- The Antigravity Language Server fails MCP server initialization:
  `{"status":"MCP_SERVER_STATUS_ERROR","error":"connection closed: calling \"initialize\": client is closing: EOF"}`.
- All MCP tools and UI entrypoints (`aux_pane`, `global`) defined by the server are dropped by the host.
- In Antigravity Desktop, the expected side pane tab (e.g. "Overview") fails to appear in the tab bar or the "+" menu.
- Running the script manually in terminal tests often masked the issue if the tester `cd`'d into the physical repository or executed `node <realpath>`.

## Root Cause

Node.js ES module loader always canonicalizes module specifiers:
- `import.meta.url` evaluates to the fully resolved realpath: `file:///home/domixi/Projects/gravityzilla/config/plugins/margin/mcp/server.mjs`.
- `process.argv[1]` retains the exact string passed on the command line: `/home/domixi/.gemini/config/plugins/margin/mcp/server.mjs`.
- `import.meta.url === file://${process.argv[1]}` evaluates to `false`.

The file believes it was imported as a module by another script rather than executed as the main script, so it skips attaching stdin listeners and exits cleanly.

## Solution

Resolve `process.argv[1]` through `realpathSync` before comparing against `fileURLToPath(import.meta.url)`:

```js
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    ...
  });
}
```

## Why This Works

`realpathSync(process.argv[1])` dereferences directory and file symlinks to the canonical filesystem path, ensuring identity parity with Node's canonicalized `import.meta.url` regardless of how the host spawns the executable.
