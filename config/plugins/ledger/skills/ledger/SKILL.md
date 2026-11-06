---
name: ledger
description: Inspect, toggle, or clear the Multi-Session Same-File Edit Ledger (/ledger, /ledger status, /ledger on, /ledger off, /ledger clear, /ledger logs). Triggered by /ledger or when the user asks about multi-session same-file edit collision pauses.
---

# Same-File Edit Ledger (`/ledger`)

Manage the multi-session same-file edit collision guard (`~/.local/bin/agy-ledger`), backed by `~/.agents/ledger/`.

## Subcommands

Run the matching command via `run_command` based on `$ARGUMENTS`:

- **Status** (`/ledger` or `/ledger status`):
  ```bash
  ~/.local/bin/agy-ledger status
  ```
- **Toggle ON / OFF** (`/ledger on` or `/ledger off`):
  ```bash
  ~/.local/bin/agy-ledger on
  ~/.local/bin/agy-ledger off
  ```
- **Clear active 30-min edit locks** (`/ledger clear`):
  ```bash
  ~/.local/bin/agy-ledger clear
  ```
- **View recent collision logs** (`/ledger logs`):
  ```bash
  ~/.local/bin/agy-ledger logs -n 30
  ```
