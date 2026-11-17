#!/usr/bin/env bash
# ==============================================================================
# gravityzilla: Antigravity Standalone Linux Setup & Installer
# Packages all global rules, plugins, skills, configs, and helper binaries.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="symlink"
FORCE=false
STATUS_ONLY=false

usage() {
  cat <<EOF
Usage: ./install.sh [OPTIONS]

Options:
  --symlink        (Default) Symlink configs and scripts to target locations.
                   Edits in this repository immediately reflect live.
  --copy           Copy configs and scripts directly instead of symlinking.
  --status         Check symlinks/copies for drift or missing targets without mutating.
  -f, --force      Overwrite existing destination files/symlinks without prompting.
  -h, --help       Show this help message.

Targets configured:
  ~/.local/bin/              Helper scripts and tools (agy-stats, agy-watch, agy-compound, rtk, etc.)
  ~/.agents/skills/          Agent skills (repo .agents/skills, linked into Antigravity)
  ~/.gemini/config/          Global instructions, plugins, MCP configs
  ~/.gemini/antigravity-cli/ settings.json with path templating
  ~/.config/agy-stats/       Stats preferences
  ~/.config/rtk/             RTK token condenser configs
  ~/.agents/                 Subagent memory, watchdog, and runtime directories
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --symlink)
      MODE="symlink"
      shift
      ;;
    --copy)
      MODE="copy"
      shift
      ;;
    --status)
      STATUS_ONLY=true
      shift
      ;;
    -f|--force)
      FORCE=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
done

check_entry() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [[ ! -e "$dest" && ! -L "$dest" ]]; then
    echo "  [MISSING] $label"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    return
  fi

  if [[ -L "$dest" ]]; then
    if [[ ! -e "$dest" ]]; then
      echo "  [DRIFT]   $label (broken symlink -> $(readlink "$dest"))"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
      return
    fi
    local src_real dest_real
    src_real="$(readlink -f "$src")"
    dest_real="$(readlink -f "$dest")"
    if [[ "$src_real" == "$dest_real" ]]; then
      echo "  [OK]      $label"
    else
      echo "  [DRIFT]   $label (points to $(readlink "$dest"), expected $src)"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
    fi
  elif [[ -f "$src" && -f "$dest" ]]; then
    if cmp -s "$src" "$dest"; then
      echo "  [OK]      $label (copy)"
    else
      echo "  [DRIFT]   $label (regular file differs from $src)"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
    fi
  elif [[ -d "$src" && -d "$dest" ]]; then
    if diff -rq "$src" "$dest" >/dev/null 2>&1; then
      echo "  [OK]      $label (dir copy)"
    else
      echo "  [DRIFT]   $label (directory differs from $src)"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
    fi
  else
    echo "  [DRIFT]   $label (type mismatch)"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  fi
}

run_status() {
  local DRIFT_COUNT=0
  echo "==> Checking gravityzilla symlink/install status..."

  echo "-- Binaries (~/.local/bin/):"
  for bin_file in "$SCRIPT_DIR/bin/"*; do
    [[ -f "$bin_file" ]] || continue
    local filename
    filename="$(basename "$bin_file")"
    check_entry "$bin_file" "$HOME/.local/bin/$filename" "~/.local/bin/$filename"
  done

  echo "-- Antigravity Config (~/.gemini/config/):"
  for cfg_item in "$SCRIPT_DIR/config/"*; do
    [[ -e "$cfg_item" ]] || continue
    local item_name
    item_name="$(basename "$cfg_item")"
    if [[ "$item_name" == "config.json" && -f "$HOME/.gemini/config/config.json" && ! -L "$HOME/.gemini/config/config.json" ]]; then
      echo "  [OK]      ~/.gemini/config/config.json (local runtime state)"
      continue
    fi
    check_entry "$cfg_item" "$HOME/.gemini/config/$item_name" "~/.gemini/config/$item_name"
  done

  echo "-- Discovery Links & Settings:"
  check_entry "$SCRIPT_DIR/.agents/skills" "$HOME/.agents/skills" "~/.agents/skills"
  check_entry "$HOME/.agents/skills" "$HOME/.gemini/config/skills" "~/.gemini/config/skills"
  check_entry "$HOME/.agents/skills" "$HOME/.gemini/antigravity-cli/skills" "~/.gemini/antigravity-cli/skills"

  local settings_dest="$HOME/.gemini/antigravity-cli/settings.json"
  if [[ -f "$settings_dest" ]]; then
    echo "  [OK]      ~/.gemini/antigravity-cli/settings.json"
  else
    echo "  [MISSING] ~/.gemini/antigravity-cli/settings.json"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  fi

  echo ""
  if [[ "$DRIFT_COUNT" -eq 0 ]]; then
    echo "Status: CLEAN (0 drift/missing items)"
    return 0
  else
    echo "Status: $DRIFT_COUNT issue(s) found (run ./install.sh to reconcile)"
    return 1
  fi
}

if [[ "$STATUS_ONLY" == true ]]; then
  run_status
  exit $?
fi

echo "==> Starting Antigravity Linux setup (Mode: $MODE, Force: $FORCE)..."

# 1. Prerequisite checks
echo "==> Verifying system requirements..."
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: This installer currently targets Linux only." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required but not installed." >&2
  exit 1
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")

if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 11 ]]; }; then
  echo "Warning: Python version $PY_VER detected. Some plugins (e.g. using tomllib) require Python >= 3.11."
fi

# 2. Prepare directories
echo "==> Preparing target directories..."
mkdir -p "$HOME/.local/bin"
mkdir -p "$HOME/.gemini/config"
mkdir -p "$HOME/.gemini/antigravity-cli"
mkdir -p "$HOME/.config/agy-stats"
mkdir -p "$HOME/.config/rtk"
mkdir -p "$HOME/.agents/memories"
mkdir -p "$HOME/.agents/compound"
mkdir -p "$HOME/.agents/diagnostics"
mkdir -p "$HOME/.agents/watchdog"

# Cleanup obsolete components (e.g. ledger, advisor)
rm -rf "$HOME/.gemini/config/plugins/ledger" "$HOME/.local/bin/agy-ledger" "$HOME/.agents/ledger" \
       "$HOME/.gemini/config/plugins/advisor" "$HOME/.gemini/config/agents/advisor-core.md" \
       "$HOME/.local/bin/agy-advisor" "$HOME/.agents/advisor"
if [[ -L "$HOME/.gemini/config/agents" && ! -e "$HOME/.gemini/config/agents" ]]; then
  rm -f "$HOME/.gemini/config/agents"
fi

deploy_file() {
  local src="$1"
  local dest="$2"
  local is_executable="${3:-false}"

  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ "$FORCE" == false ]]; then
      # If identical symlink or identical file, skip silently
      if [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]]; then
        return 0
      fi
    fi
    rm -rf "$dest"
  fi

  if [[ "$MODE" == "symlink" ]]; then
    ln -s "$src" "$dest"
  else
    if [[ -d "$src" ]]; then
      cp -a "$src" "$dest"
    else
      cp -p "$src" "$dest"
    fi
  fi

  if [[ "$is_executable" == "true" ]]; then
    chmod +x "$dest"
  fi
}

# 3. Install binaries & helper scripts
echo "==> Deploying helper binaries into ~/.local/bin/..."
for bin_file in "$SCRIPT_DIR/bin/"*; do
  [[ -f "$bin_file" ]] || continue
  filename="$(basename "$bin_file")"
  deploy_file "$bin_file" "$HOME/.local/bin/$filename" "true"
done

# 4. Deploy ~/.gemini/config/ items
echo "==> Deploying Antigravity configuration into ~/.gemini/config/..."
for cfg_item in "$SCRIPT_DIR/config/"*; do
  [[ -e "$cfg_item" ]] || continue
  item_name="$(basename "$cfg_item")"
  if [[ "$item_name" == "config.json" && -f "$HOME/.gemini/config/config.json" && ! -L "$HOME/.gemini/config/config.json" && "$FORCE" == false ]]; then
    echo "    Preserving local ~/.gemini/config/config.json (use --force to reset)."
    continue
  fi
  deploy_file "$cfg_item" "$HOME/.gemini/config/$item_name"
done

# Ensure discovery symlinks
# Skills live in the repo at .agents/skills/ (standard agent-skills layout) and are
# exposed at ~/.agents/skills (read natively by agent tools) and linked into
# Antigravity's two skill locations.
ln -sfn "$SCRIPT_DIR/.agents/skills" "$HOME/.agents/skills"
ln -sfn "$HOME/.agents/skills" "$HOME/.gemini/config/skills"
ln -sfn "$HOME/.agents/skills" "$HOME/.gemini/antigravity-cli/skills"

# Remove legacy ~/.gemini/antigravity -> ~/.gemini/config symlink so Antigravity Desktop
# can manage ~/.gemini/antigravity/ as its own runtime data directory.
if [[ -L "$HOME/.gemini/antigravity" ]]; then
  if [[ "$(readlink -f "$HOME/.gemini/antigravity" 2>/dev/null || true)" == "$(readlink -f "$HOME/.gemini/config" 2>/dev/null || true)" ]]; then
    rm -f "$HOME/.gemini/antigravity"
  fi
fi

# 5. Deploy config-extra items (~/.config/agy-stats and ~/.config/rtk)
echo "==> Deploying extra configs into ~/.config/..."
if [[ -d "$SCRIPT_DIR/config-extra/agy-stats" ]]; then
  for f in "$SCRIPT_DIR/config-extra/agy-stats/"*; do
    [[ -e "$f" ]] || continue
    deploy_file "$f" "$HOME/.config/agy-stats/$(basename "$f")"
  done
fi

if [[ -d "$SCRIPT_DIR/config-extra/rtk" ]]; then
  for f in "$SCRIPT_DIR/config-extra/rtk/"*; do
    [[ -e "$f" ]] || continue
    deploy_file "$f" "$HOME/.config/rtk/$(basename "$f")"
  done
fi

# 6. Render settings.json
echo "==> Configuring ~/.gemini/antigravity-cli/settings.json..."
SETTINGS_DEST="$HOME/.gemini/antigravity-cli/settings.json"
if [[ -f "$SETTINGS_DEST" && "$FORCE" == false ]]; then
  echo "    ~/.gemini/antigravity-cli/settings.json already exists (preserving; use --force to overwrite)."
else
  sed "s|{{HOME}}|$HOME|g" "$SCRIPT_DIR/templates/settings.json.template" > "$SETTINGS_DEST"
  echo "    Generated $SETTINGS_DEST with HOME=$HOME."
fi

# 7. Verification and Diagnostics
echo "==> Verifying installation..."

# Verify python syntax for helper scripts
for py_bin in agy-compound agy-diagnostics agy-stats agy-statusline agy-watch agent-memory; do
  if [[ -f "$HOME/.local/bin/$py_bin" ]]; then
    python3 -m py_compile "$HOME/.local/bin/$py_bin" >/dev/null 2>&1 && \
      echo "    [PASS] $py_bin syntax OK" || \
      echo "    [WARN] $py_bin syntax verification warning"
  fi
done

if [[ -x "$HOME/.local/bin/rtk" ]]; then
  RTK_VER=$("$HOME/.local/bin/rtk" --version 2>/dev/null || echo "error")
  echo "    [PASS] rtk binary ($RTK_VER)"
fi

# Check PATH
case ":$PATH:" in
  *":$HOME/.local/bin:"*)
    echo "    [PASS] ~/.local/bin is in PATH"
    ;;
  *)
    echo "    [NOTICE] ~/.local/bin is NOT in your current PATH!"
    echo "    Add the following to your shell config (~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish):"
    echo '    export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac

# Check agy CLI
if command -v agy >/dev/null 2>&1; then
  AGY_VER=$(agy --version 2>/dev/null || echo "installed")
  echo "    [PASS] Antigravity CLI ($AGY_VER)"
else
  echo "    [NOTICE] 'agy' CLI executable not found in PATH."
  echo "    Install agy on this machine or copy ~/.local/bin/agy from your source machine."
fi

echo ""
echo "==> Antigravity setup completed successfully!"
echo "    Config root: ~/.gemini/config"
echo "    Binaries:    ~/.local/bin"
echo "    Mode:        $MODE"
