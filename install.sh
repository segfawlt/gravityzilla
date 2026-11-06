#!/usr/bin/env bash
# ==============================================================================
# Antigravity Standalone Linux Setup & Installer
# Packages all global rules, plugins, skills, configs, and helper binaries.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="symlink"
FORCE=false

usage() {
  cat <<EOF
Usage: ./install.sh [OPTIONS]

Options:
  --symlink        (Default) Symlink configs and scripts to target locations.
                   Edits in this repository immediately reflect live.
  --copy           Copy configs and scripts directly instead of symlinking.
  -f, --force      Overwrite existing destination files/symlinks without prompting.
  -h, --help       Show this help message.

Targets configured:
  ~/.local/bin/              Helper scripts and tools (agy-advisor, agy-stats, rtk, etc.)
  ~/.gemini/config/          Global instructions, plugins, skills, custom agents
  ~/.gemini/antigravity-cli/ settings.json with path templating
  ~/.config/agy-stats/       Stats preferences
  ~/.config/rtk/             RTK token condenser configs
  ~/.agents/                 Subagent memory and runtime directories
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
mkdir -p "$HOME/.agents/advisor"
mkdir -p "$HOME/.agents/diagnostics"
mkdir -p "$HOME/.agents/ledger"

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
  deploy_file "$cfg_item" "$HOME/.gemini/config/$item_name"
done

# Ensure discovery symlinks
ln -sfn "$HOME/.gemini/config" "$HOME/.gemini/antigravity"
ln -sfn "$HOME/.gemini/config/skills" "$HOME/.gemini/antigravity-cli/skills"

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
for py_bin in agy-advisor agy-diagnostics agy-ledger agy-stats agy-statusline agent-memory; do
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
