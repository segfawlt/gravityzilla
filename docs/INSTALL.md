# Installation & Reference

`install.sh` (Linux) and `install.ps1` (Windows portable subset) deploy selectable `gravityzilla` components non-destructively, with live host detection and **zero** shell rc edits (`~/.bashrc`, `~/.zshrc`, `fish`, `$PROFILE` untouched).

---

## Modes & Flags (`install.sh`)

| Flag | Mode / Effect |
| :--- | :--- |
| `./install.sh` | Interactive TTY checklist when run in a terminal (auto non-interactive in pipes/agents) |
| `-y`, `--yes`, `--non-interactive` | Skip prompts and install default/detected components non-interactively |
| `-i`, `--interactive` | Force interactive TTY checklist showing installed state & `(detected: ...)` probes |
| `--only <csv>` | Act only on listed components (`rules,margin,diagnostics,...`; implies `-y` unless `-i`) |
| `--skip <csv>` | Exclude listed components from default selection (implies `-y` unless `-i`) |
| `--list` | Print component inventory, selection state, and host probes (`--json` supported) |
| `--status` | Audit deployed links/copies for drift (`--json` supported) |
| `--symlink` | (Default) Symlink repo files so `git pull` updates live |
| `--copy` | Copy files instead of symlinking (tracked in `~/.local/share/gravityzilla/manifest.txt`) |
| `--download-rtk` | Force-allow downloading newest `rtk-ai/rtk` when missing/incompatible |
| `--no-download-rtk` | Never download `rtk`; reuse external binary or run safety-gate-only |
| `--uninstall` | Remove managed symlinks, wrappers, and `--copy` manifest files (keeps local configs/data) |
| `-f`, `--force` | Back up (`*.bak.<timestamp>`) and replace conflicting targets |

---

## Toggleable Components

| Component | Installs | Linux | Windows |
| :--- | :--- | :--- | :--- |
| `rules` | `GEMINI.md`, `mcp_config.json`, `config.json`, `settings.json` | Yes | Yes |
| `skills` | 13 core `.agents/skills/*` (per-skill link/copy; keeps user skills intact) | Yes | Yes |
| `ship` | `ship` skill + `~/.local/bin/git-wt-sync` | Yes | No |
| `margin` | Right-pane Overview sidecar + `margin_intent` MCP | Yes | Yes |
| `diagnostics` | `diagnostics` plugin + `agy-diagnostics` | Yes | Yes |
| `stats` | `stats` plugin + `/stats` skill + `agy-stats` + `config.json` | Yes | Yes |
| `watchdog` | `watchdog` plugin + `agy-watch` + `agy-statusline` + `statusLine` in `settings.json` | Yes | No |
| `memory` | `memory` plugin + `agent-memory` + `agy-compound` | Yes | No |
| `rtk` | `rtk` plugin + `config.toml`/`filters.toml` + external/latest `rtk` | Yes | No |
| `playwright` | `playwright` plugin (disabled by default in `config.json`) | Yes | Yes |
| `desktop-patch` | `agy-desktop-patch` (`app.asar` patcher; auto-selected only if `app.asar` detected) | Yes | No |

---

## Target Paths

| Target Path | Deployment | Notes |
| :--- | :--- | :--- |
| `~/.local/bin/` | Symlink or copy | Helper CLIs (`agy-watch`, `agy-diagnostics`, `agy-stats`, etc.) |
| `~/.local/share/gravityzilla/` | Copy (`--copy` mode) | `manifest.txt` + staged `desktop-patch/patch.mjs` & `lib/` |
| `~/.agents/skills/<skill>` | Per-skill link or copy | Preserves user-local skills inside `~/.agents/skills/` |
| `~/.gemini/config/GEMINI.md` | Symlink or copy | Global rules |
| `~/.gemini/config/mcp_config.json` | Symlink or copy | Default MCP servers (`drawio`) |
| `~/.gemini/config/config.json` | Copied once | Local mutable plugin toggle state |
| `~/.gemini/config/plugins/<name>` | Per-plugin link or copy | Preserves Marketplace plugins |
| `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills` | Symlink to `~/.agents/skills` | Antigravity skill discovery |
| `~/.gemini/antigravity-cli/settings.json` | Generated once | Templated with `$HOME`; `statusLine` included only if `watchdog` is selected |
| `~/.config/agy-stats/config.json` | Copied once | `keys/` is never deployed |
| `~/.config/rtk/{config.toml,filters.toml}` | Copied once | Preserves existing configs from other harnesses |
| `~/.agents/{memories,compound,diagnostics,watchdog}/` | Local runtime dirs | Never removed by `--uninstall` |

---

## RTK Auto-Detection & Latest Download

When `rtk` is enabled, `install.sh` and `rtk-safe-hook.py` probe for an existing binary in order:

1. `$RTK_BIN`
2. `PATH`
3. `~/.cargo/bin/rtk`
4. `/opt/homebrew/bin/rtk` and `/home/linuxbrew/.linuxbrew/bin/rtk`
5. `/usr/local/bin/rtk`
6. `~/.local/share/mise/shims/rtk`, `~/.asdf/shims/rtk`, `~/.nix-profile/bin/rtk`
7. `~/.local/bin/rtk`

Each candidate is verified with `<bin> hook antigravity --help`:

- **Compatible external `rtk` found:** Reused in place; existing `~/.config/rtk/` configs stay untouched.
- **Missing or incompatible:** In non-interactive mode (unless `--no-download-rtk`), downloads the latest SHA-256-verified Linux release (`x86_64` or `aarch64`) from `rtk-ai/rtk` into `~/.local/bin/rtk`. In `--interactive`, prompts `[Y/n]` first.
- **Offline / skipped fallback:** `rtk-safe-hook.py` continues enforcing the Git/Shell safety guard and strips `rtk bypass` prefixes cleanly without compressing output.

> **Do not run `cargo install rtk`:** crates.io `rtk` is an unrelated crate (*Rust Type Kit*). To build from source, use `cargo install --git https://github.com/rtk-ai/rtk --branch master rtk` or install via `brew install rtk-ai/tap/rtk`.

---

## Desktop Patches (`agy-desktop-patch`)

Close Antigravity Desktop before applying or restoring `app.asar` patches (`agy-desktop-patch` auto-elevates with `sudo` when writing system paths):

| Command | Action |
| :--- | :--- |
| `~/.local/bin/agy-desktop-patch status` | Inspect `app.asar` and show installed patch state |
| `~/.local/bin/agy-desktop-patch check` | Dry-run patches and verify temp ASAR round-trip |
| `~/.local/bin/agy-desktop-patch apply` | Back up `app.asar` and apply `top-bar`, `overview`, `model-search` |
| `~/.local/bin/agy-desktop-patch apply --only overview` | Apply one patch (`top-bar`, `overview`, or `model-search`) |
| `~/.local/bin/agy-desktop-patch restore` | Restore exact pre-patch `app.asar` backup |

---

## Windows Portable Subset (`install.ps1`)

Works on Windows PowerShell 5.1 and PowerShell 7+ without Administrator rights:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

| Flag | Effect |
| :--- | :--- |
| `.\install.ps1` | Interactive checklist in interactive consoles (auto non-interactive when redirected) |
| `-Yes` | Run non-interactively without prompting |
| `-Interactive` | Force interactive checklist to toggle portable components |
| `-Only <list>` / `-Skip <list>` | Select or exclude from `rules, skills, margin, diagnostics, stats, playwright` (implies `-Yes` unless `-Interactive`) |
| `-List` / `-Status` | Inventory or drift audit (`-Json` supported) |
| `-Junction` | Use NTFS directory junctions for skills and non-rewritten plugins (`margin`, `playwright`) |
| `-Uninstall` / `-Force` | Remove managed files/junctions (optionally scoped by `-Only`) or back up & overwrite |

---

## Host Requirements & Optional Tools

| Tool | Used by | Purpose |
| :--- | :--- | :--- |
| `python3` (`>= 3.11`) | `agy-diagnostics`, `agy-watch`, `agy-stats`, `agent-memory`, `agy-compound` | Core hooks & TOML diagnostics (`tomllib` degrades on `< 3.11`) |
| `node` (`>= 22.13`) | `margin`, `agy-desktop-patch`, UI skills | Overview sidecar, MCP server, `node:sqlite`, ASAR patching |
| `git`, `curl`, `agy` | Installer, `ship`, `agy-watch`, `agent-memory`, `agy-compound` | Git guards, RTK download, background workers |
| `sqlite3` | `margin` (`agy-worker.mjs`) | Cleans ephemeral worker DB rows |
| `npx` | `drawio`, `playwright`, `create-verification-skill` | Launches MCP / Playwright packages |
| `bun`, `ruff`, `shellcheck`, `gofmt`, `PyYAML` | `agy-diagnostics` | Fast TS/JS/JSONC/YAML/Lint checks |
| `chromium` / `google-chrome` | `playwright`, `taste-skill`, `hallmark`, `ui-demo-prototype` | Headless screenshots & CDP checks |

---

## For AI Agents & Manual Installation

### Agent Automation Flow (Recommended)

In non-TTY agent shells, `./install.sh` and `.\install.ps1` run non-interactively by default and emit machine-readable JSON on `--list` / `--status`:

```bash
# 1. Inspect host probes, RTK state, and existing install drift risk
./install.sh --list --json

# 2. Deploy chosen components non-interactively (no shell rc edits, skips existing conflicts unless --force)
./install.sh --yes --only rules,skills,margin,diagnostics,stats,memory,rtk

# 3. Verify zero drift and inspect detected RTK binary
./install.sh --status --json
```

Useful agent flags: `--copy` (tracked copies via `~/.local/share/gravityzilla/manifest.txt`), `--download-rtk` / `--no-download-rtk`, `--skip <csv>`, `--force` (backs up conflicts to `*.bak.<timestamp>`). Never run `./install.sh -i` inside a non-TTY subprocess.

---

### Manual Linux Installation (Zero Installer)

Use these exact commands when installing step-by-step without `install.sh` (set `REPO="$HOME/gravityzilla"`):

```bash
REPO="$HOME/gravityzilla"
mkdir -p ~/.local/bin ~/.gemini/config/plugins ~/.gemini/antigravity-cli \
         ~/.agents/skills ~/.agents/diagnostics ~/.agents/memories ~/.agents/compound \
         ~/.config/agy-stats ~/.config/rtk

# 1. Rules & non-destructive local templates
ln -sfn "$REPO/config/GEMINI.md" ~/.gemini/config/GEMINI.md
ln -sfn "$REPO/config/mcp_config.json" ~/.gemini/config/mcp_config.json
[ -e ~/.gemini/config/config.json ] || cp "$REPO/config/config.json" ~/.gemini/config/config.json

# Generate ~/.gemini/antigravity-cli/settings.json with $HOME expanded
# (pass false as argv[3] to omit statusLine if skipping watchdog)
python3 - "$REPO/templates/settings.json.template" ~/.gemini/antigravity-cli/settings.json true <<'PY'
import json, os, pathlib, sys
src, dest, with_sl = sys.argv[1], sys.argv[2], sys.argv[3] == "true"
if not os.path.exists(dest):
    data = json.loads(pathlib.Path(src).read_text().replace("{{HOME}}", os.environ["HOME"]))
    if not with_sl:
        data.pop("statusLine", None)
    pathlib.Path(dest).write_text(json.dumps(data, indent=2) + "\n")
PY

# 2. Core skills (per-skill symlinks preserve local-only skills inside ~/.agents/skills/)
for s in "$REPO/.agents/skills/"*; do
  name="$(basename "$s")"
  [ "$name" = "ship" ] || [ "$name" = "stats" ] && continue
  ln -sfn "$s" ~/.agents/skills/"$name"
done
[ -e ~/.gemini/config/skills ] || ln -s ~/.agents/skills ~/.gemini/config/skills
[ -e ~/.gemini/antigravity-cli/skills ] || ln -s ~/.agents/skills ~/.gemini/antigravity-cli/skills

# 3. Plugins & helper CLIs (omit any component you do not want)
# ship:
ln -sfn "$REPO/bin/git-wt-sync" ~/.local/bin/git-wt-sync
ln -sfn "$REPO/.agents/skills/ship" ~/.agents/skills/ship
# margin:
ln -sfn "$REPO/config/plugins/margin" ~/.gemini/config/plugins/margin
# diagnostics:
ln -sfn "$REPO/bin/agy-diagnostics" ~/.local/bin/agy-diagnostics
ln -sfn "$REPO/config/plugins/diagnostics" ~/.gemini/config/plugins/diagnostics
# stats:
ln -sfn "$REPO/bin/agy-stats" ~/.local/bin/agy-stats
ln -sfn "$REPO/config/plugins/stats" ~/.gemini/config/plugins/stats
ln -sfn "$REPO/.agents/skills/stats" ~/.agents/skills/stats
[ -e ~/.config/agy-stats/config.json ] || cp "$REPO/config-extra/agy-stats/config.json" ~/.config/agy-stats/config.json
# watchdog:
ln -sfn "$REPO/bin/agy-watch" ~/.local/bin/agy-watch
ln -sfn "$REPO/bin/agy-statusline" ~/.local/bin/agy-statusline
ln -sfn "$REPO/config/plugins/watchdog" ~/.gemini/config/plugins/watchdog
# memory:
ln -sfn "$REPO/bin/agent-memory" ~/.local/bin/agent-memory
ln -sfn "$REPO/bin/agy-compound" ~/.local/bin/agy-compound
ln -sfn "$REPO/config/plugins/memory" ~/.gemini/config/plugins/memory
# rtk plugin + templates:
ln -sfn "$REPO/config/plugins/rtk" ~/.gemini/config/plugins/rtk
[ -e ~/.config/rtk/config.toml ] || cp "$REPO/config-extra/rtk/config.toml" ~/.config/rtk/config.toml
[ -e ~/.config/rtk/filters.toml ] || cp "$REPO/config-extra/rtk/filters.toml" ~/.config/rtk/filters.toml
# playwright (optional, disabled by default in config.json):
ln -sfn "$REPO/config/plugins/playwright" ~/.gemini/config/plugins/playwright
# desktop-patch (optional):
ln -sfn "$REPO/bin/agy-desktop-patch" ~/.local/bin/agy-desktop-patch
```

**Manual RTK binary check / install (if `rtk hook antigravity --help` is missing):**

Never run `cargo install rtk` (crates.io `rtk` is *Rust Type Kit*). Download the official SHA-256-verified binary from `rtk-ai/rtk`:

```bash
if ! command -v rtk >/dev/null 2>&1 || ! rtk hook antigravity --help >/dev/null 2>&1; then
  VER="$(curl -fsSL https://api.github.com/repos/rtk-ai/rtk/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  ASSET="rtk-$(uname -m | sed 's/amd64/x86_64/;s/arm64/aarch64/')-unknown-linux-musl.tar.gz"
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/$VER/checksums.txt" -o "$TMP/checksums.txt"
  curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/$VER/$ASSET" -o "$TMP/$ASSET"
  (cd "$TMP" && grep " $ASSET$" checksums.txt | sha256sum -c -)
  tar -xzf "$TMP/$ASSET" -C "$TMP" && install -m 0755 "$TMP/rtk" ~/.local/bin/rtk
  rm -rf "$TMP"
fi
```

**Manual verification:**

```bash
python3 -m py_compile ~/.local/bin/{agy-compound,agy-diagnostics,agy-stats,agy-statusline,agy-watch,agent-memory} ~/.gemini/config/plugins/rtk/scripts/rtk-safe-hook.py
node --check ~/.local/bin/agy-desktop-patch
"$REPO/install.sh" --status --json
```

---

### Manual Windows Installation (PowerShell)

For AI agents on Windows, prefer `.\install.ps1 -Yes -Only rules,skills,margin,diagnostics,stats` followed by `.\install.ps1 -Status -Json`. To copy core portable pieces manually:

```powershell
$Repo = "$HOME\gravityzilla"
powershell -ExecutionPolicy Bypass -File "$Repo\install.ps1" -List -Json
powershell -ExecutionPolicy Bypass -File "$Repo\install.ps1" -Yes -Only rules,skills,margin,diagnostics,stats
powershell -ExecutionPolicy Bypass -File "$Repo\install.ps1" -Status -Json
```

When copying plugins manually without `install.ps1`, copy `templates\settings.windows.json.template` to `$HOME\.gemini\antigravity-cli\settings.json`, copy `config\GEMINI.md` and `config\mcp_config.json` into `$HOME\.gemini\config\`, rewrite `"$HOME/.local/bin/agy-..."` hook commands in `stats\hooks\hooks.json` and `diagnostics\hooks\hooks.json` to invoke Python against `$HOME\.local\bin\agy-*.py`, and add `%USERPROFILE%\.local\bin\*.cmd` shims.
