# Playwright Browser & UI Audit Plugin (`playwright`)

Packages `@playwright/mcp` and `/ui-flaw-scan` into an on-demand plugin so backend/CLI sessions do not boot Chromium MCP or carry 25 `browser_*` tool schemas.

## Customizing Browser Mode

By default `mcp_config.json` launches `npx -y @playwright/mcp`. To connect to an existing Chrome/Chromium profile or use a custom browser binary, add `--extension`, `--executable-path=<path>`, or `--user-data-dir=<path>` locally.

## Toggle Commands

```bash
# Enable before a frontend / UI testing session:
agy plugin enable playwright

# Disable again when done:
agy plugin disable playwright
```
(Or toggle interactively via `/plugin` inside `agy`.)
