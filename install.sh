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
UNINSTALL=false
SKIP_COUNT=0
BACKUP_STAMP="$(date +%Y%m%d-%H%M%S)"
ARCH="$(uname -m)"

usage() {
  cat <<EOF
Usage: ./install.sh [OPTIONS]

Options:
  --symlink        (Default) Symlink configs and scripts to target locations.
                   Edits in this repository immediately reflect live.
  --copy           Copy configs and scripts directly instead of symlinking.
  --status         Check symlinks/copies for drift or missing targets without mutating.
  --uninstall      Remove gravityzilla symlinks and copy wrappers while preserving local configs/data.
  -f, --force      Back up and replace existing conflicting destination files/symlinks.
  -h, --help       Show this help message.

Targets configured:
  ~/.local/bin/              Helper scripts and tools (agy-stats, agy-watch, agy-compound, agy-desktop-patch, rtk, etc.)
  ~/.agents/skills/          Agent skills (repo .agents/skills, linked into Antigravity)
  ~/.gemini/config/          Global instructions, plugins (per-plugin links), MCP configs
  ~/.gemini/antigravity-cli/ settings.json with path templating
  ~/.config/agy-stats/       Stats preferences (copied once; keys/ never deployed)
  ~/.config/rtk/             RTK token condenser configs (copied once)
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
    --uninstall)
      UNINSTALL=true
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
    if diff -rq -x '__pycache__' -x '.playwright-mcp' -x '*.pyc' "$src" "$dest" >/dev/null 2>&1; then
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

check_local_config() {
  local dest="$1"
  local label="$2"
  if [[ -f "$dest" || -L "$dest" ]]; then
    if [[ -L "$dest" ]]; then
      echo "  [DRIFT]   $label (symlinked; should be a local copy so runtime edits don't dirty git)"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
    else
      echo "  [OK]      $label (local config)"
    fi
  else
    echo "  [MISSING] $label"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  fi
}

check_skills_status() {
  local src_dir="$1"
  local dest_dir="$2"
  local label="$3"

  if [[ ! -e "$dest_dir" && ! -L "$dest_dir" ]]; then
    echo "  [MISSING] $label"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    return
  fi

  if [[ -L "$dest_dir" ]]; then
    check_entry "$src_dir" "$dest_dir" "$label"
    return
  fi

  if [[ -d "$dest_dir" ]]; then
    local nested_name
    nested_name="$(basename "$src_dir")"
    if [[ -L "$dest_dir/$nested_name" ]]; then
      echo "  [DRIFT]   $label (nested symlink $nested_name inside directory)"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
      return
    fi
    local skill_dir
    for skill_dir in "$src_dir/"*; do
      [[ -d "$skill_dir" ]] || continue
      local sname
      sname="$(basename "$skill_dir")"
      check_entry "$skill_dir" "$dest_dir/$sname" "$label/$sname"
    done
    return
  fi

  echo "  [DRIFT]   $label (not a directory or symlink)"
  DRIFT_COUNT=$((DRIFT_COUNT + 1))
}

run_status() {
  local DRIFT_COUNT=0
  echo "==> Checking gravityzilla symlink/install status..."

  echo "-- Binaries (~/.local/bin/):"
  for bin_file in "$SCRIPT_DIR/bin/"*; do
    [[ -f "$bin_file" ]] || continue
    local filename
    filename="$(basename "$bin_file")"
    if [[ "$filename" == "rtk" && "$ARCH" != "x86_64" ]]; then
      echo "  [SKIP]    ~/.local/bin/rtk (prebuilt binary is x86_64 only; host is $ARCH)"
      continue
    fi
    if [[ "$filename" == "agy-desktop-patch" ]]; then
      local dp_dest="$HOME/.local/bin/agy-desktop-patch"
      local dp_share="$HOME/.local/share/gravityzilla/desktop-patch"
      if [[ -f "$dp_dest" && ! -L "$dp_dest" ]] && grep -q "gravityzilla/desktop-patch/patch.mjs" "$dp_dest" 2>/dev/null; then
        if [[ -f "$dp_share/patch.mjs" && -d "$dp_share/lib" ]]; then
          echo "  [OK]      ~/.local/bin/agy-desktop-patch (copy wrapper)"
        else
          echo "  [DRIFT]   ~/.local/bin/agy-desktop-patch (missing $dp_share/patch.mjs or lib/)"
          DRIFT_COUNT=$((DRIFT_COUNT + 1))
        fi
        continue
      fi
    fi
    check_entry "$bin_file" "$HOME/.local/bin/$filename" "~/.local/bin/$filename"
  done

  echo "-- Antigravity Config (~/.gemini/config/):"
  for cfg_item in "$SCRIPT_DIR/config/"*; do
    [[ -e "$cfg_item" ]] || continue
    local item_name
    item_name="$(basename "$cfg_item")"
    if [[ "$item_name" == "config.json" ]]; then
      check_local_config "$HOME/.gemini/config/config.json" "~/.gemini/config/config.json"
      continue
    fi
    if [[ "$item_name" == "plugins" ]]; then
      if [[ -L "$HOME/.gemini/config/plugins" ]]; then
        check_entry "$cfg_item" "$HOME/.gemini/config/plugins" "~/.gemini/config/plugins"
      elif [[ -d "$HOME/.gemini/config/plugins" ]]; then
        for plugin_dir in "$cfg_item/"*; do
          [[ -d "$plugin_dir" ]] || continue
          local pname
          pname="$(basename "$plugin_dir")"
          check_entry "$plugin_dir" "$HOME/.gemini/config/plugins/$pname" "~/.gemini/config/plugins/$pname"
        done
      else
        echo "  [MISSING] ~/.gemini/config/plugins"
        DRIFT_COUNT=$((DRIFT_COUNT + 1))
      fi
      continue
    fi
    check_entry "$cfg_item" "$HOME/.gemini/config/$item_name" "~/.gemini/config/$item_name"
  done

  echo "-- Extra Configs (~/.config/):"
  check_local_config "$HOME/.config/agy-stats/config.json" "~/.config/agy-stats/config.json"
  check_local_config "$HOME/.config/rtk/config.toml" "~/.config/rtk/config.toml"
  check_local_config "$HOME/.config/rtk/filters.toml" "~/.config/rtk/filters.toml"

  echo "-- Discovery Links & Settings:"
  check_skills_status "$SCRIPT_DIR/.agents/skills" "$HOME/.agents/skills" "~/.agents/skills"
  check_skills_status "$HOME/.agents/skills" "$HOME/.gemini/config/skills" "~/.gemini/config/skills"
  check_skills_status "$HOME/.agents/skills" "$HOME/.gemini/antigravity-cli/skills" "~/.gemini/antigravity-cli/skills"

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

remove_symlink_if_under() {
  local dest="$1"
  local prefix="$2"
  [[ -L "$dest" ]] || return 0
  local target
  target="$(readlink -f "$dest" 2>/dev/null || readlink "$dest")"
  if [[ "$target" == "$prefix"* ]]; then
    rm -f "$dest"
    echo "  [REMOVED] $dest"
  fi
}

run_uninstall() {
  local repo_real
  repo_real="$(readlink -f "$SCRIPT_DIR")"
  local agents_skills_real
  agents_skills_real="$(readlink -f "$HOME/.agents/skills" 2>/dev/null || echo "$HOME/.agents/skills")"

  echo "==> Uninstalling gravityzilla symlinks and copy wrappers..."

  if [[ -d "$HOME/.local/bin" ]]; then
    for entry in "$HOME/.local/bin/"*; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      remove_symlink_if_under "$entry" "$repo_real"
    done
    local dp_dest="$HOME/.local/bin/agy-desktop-patch"
    if [[ -f "$dp_dest" && ! -L "$dp_dest" ]] && grep -q "gravityzilla/desktop-patch/patch.mjs" "$dp_dest" 2>/dev/null; then
      rm -f "$dp_dest"
      echo "  [REMOVED] $dp_dest"
    fi
  fi

  if [[ -d "$HOME/.local/share/gravityzilla/desktop-patch" ]]; then
    rm -rf "$HOME/.local/share/gravityzilla/desktop-patch"
    rmdir "$HOME/.local/share/gravityzilla" 2>/dev/null || true
    echo "  [REMOVED] $HOME/.local/share/gravityzilla/desktop-patch"
  fi

  # Remove Gemini skill discovery links before ~/.agents/skills so readlink resolves cleanly.
  for sdest in "$HOME/.gemini/config/skills" "$HOME/.gemini/antigravity-cli/skills"; do
    if [[ -L "$sdest" ]]; then
      local starget
      starget="$(readlink -f "$sdest" 2>/dev/null || readlink "$sdest")"
      if [[ "$starget" == "$repo_real"* || "$starget" == "$agents_skills_real"* ]]; then
        rm -f "$sdest"
        echo "  [REMOVED] $sdest"
      fi
    elif [[ -d "$sdest" ]]; then
      for entry in "$sdest/"*; do
        [[ -L "$entry" ]] || continue
        local etarget
        etarget="$(readlink -f "$entry" 2>/dev/null || readlink "$entry")"
        if [[ "$etarget" == "$repo_real"* || "$etarget" == "$agents_skills_real"* ]]; then
          rm -f "$entry"
          echo "  [REMOVED] $entry"
        fi
      done
    fi
  done

  if [[ -L "$HOME/.agents/skills" ]]; then
    remove_symlink_if_under "$HOME/.agents/skills" "$repo_real"
  elif [[ -d "$HOME/.agents/skills" ]]; then
    for entry in "$HOME/.agents/skills/"*; do
      [[ -L "$entry" ]] || continue
      remove_symlink_if_under "$entry" "$repo_real"
    done
  fi

  if [[ -L "$HOME/.gemini/config/plugins" ]]; then
    remove_symlink_if_under "$HOME/.gemini/config/plugins" "$repo_real"
  elif [[ -d "$HOME/.gemini/config/plugins" ]]; then
    for entry in "$HOME/.gemini/config/plugins/"*; do
      [[ -L "$entry" ]] || continue
      remove_symlink_if_under "$entry" "$repo_real"
    done
  fi

  if [[ -d "$HOME/.gemini/config" ]]; then
    for entry in "$HOME/.gemini/config/"*; do
      [[ -L "$entry" ]] || continue
      remove_symlink_if_under "$entry" "$repo_real"
    done
  fi

  echo ""
  echo "==> Uninstall complete."
  echo "    Preserved local configs & runtime data (~/.gemini/config/config.json, settings.json, ~/.config/agy-stats/, ~/.config/rtk/, ~/.agents/memories/)."
}

if [[ "$STATUS_ONLY" == true ]]; then
  run_status
  exit $?
fi

if [[ "$UNINSTALL" == true ]]; then
  run_uninstall
  exit 0
fi

echo "==> Starting Antigravity Linux setup (Mode: $MODE, Force: $FORCE)..."

# 1. Prerequisite checks
echo "==> Verifying system requirements..."
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: This installer targets Linux only (detected: $(uname -s))." >&2
  exit 1
fi

if [[ "$ARCH" != "x86_64" ]]; then
  echo "Warning: Host architecture is $ARCH. Prebuilt bin/rtk is x86_64-only and will be skipped."
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required but not installed." >&2
  exit 1
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")

if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 11 ]]; }; then
  echo "Warning: Python $PY_VER detected (< 3.11). TOML diagnostics in agy-diagnostics will be skipped."
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Warning: node not found. Margin plugin, agy-desktop-patch, and UI skills require Node.js >= 22.13."
else
  NODE_VER=$(node -v 2>/dev/null || echo "v0.0.0")
  NODE_MAJ=$(node -e "const v=process.versions.node.split('.').map(Number); console.log(v[0])" 2>/dev/null || echo 0)
  NODE_MIN=$(node -e "const v=process.versions.node.split('.').map(Number); console.log(v[1])" 2>/dev/null || echo 0)
  if [[ "$NODE_MAJ" -lt 22 ]] || { [[ "$NODE_MAJ" -eq 22 ]] && [[ "$NODE_MIN" -lt 13 ]]; }; then
    echo "Warning: Node.js $NODE_VER detected (< v22.13). Margin node:sqlite memory queries will degrade gracefully; taste-skill CDP requires Node >= 22."
  fi
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
    if [[ "$MODE" == "symlink" && -L "$dest" && "$(readlink "$dest")" == "$src" ]]; then
      return 0
    fi
    if [[ "$MODE" == "copy" && -f "$src" && -f "$dest" && ! -L "$dest" ]] && cmp -s "$src" "$dest"; then
      if [[ "$is_executable" == "true" ]]; then
        chmod +x "$dest"
      fi
      return 0
    fi
    if [[ "$FORCE" == false ]]; then
      echo "  [SKIP] $dest already exists (preserving; re-run with --force to back up and replace)"
      SKIP_COUNT=$((SKIP_COUNT + 1))
      return 0
    fi
    if [[ -L "$dest" ]]; then
      rm -f "$dest"
    else
      mv "$dest" "${dest}.bak.${BACKUP_STAMP}"
      echo "  [BACKUP] $dest -> ${dest}.bak.${BACKUP_STAMP}"
    fi
  fi

  if [[ "$MODE" == "symlink" ]]; then
    ln -s "$src" "$dest"
  else
    if [[ -d "$src" ]]; then
      cp -a "$src" "$dest"
      find "$dest" -type d \( -name '__pycache__' -o -name '.playwright-mcp' \) -exec rm -rf {} + 2>/dev/null || true
    else
      cp -p "$src" "$dest"
    fi
    if [[ "$is_executable" == "true" ]]; then
      chmod +x "$dest"
    fi
  fi
}

deploy_template() {
  local src="$1"
  local dest="$2"
  local label="${3:-$dest}"

  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ "$FORCE" == false ]]; then
      echo "    Preserving existing $label (use --force to back up and overwrite)."
      return 0
    fi
    if [[ -L "$dest" ]]; then
      rm -f "$dest"
    else
      mv "$dest" "${dest}.bak.${BACKUP_STAMP}"
      echo "  [BACKUP] $dest -> ${dest}.bak.${BACKUP_STAMP}"
    fi
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

deploy_desktop_patch_copy() {
  local share_dir="$HOME/.local/share/gravityzilla/desktop-patch"
  local dest_bin="$HOME/.local/bin/agy-desktop-patch"

  if [[ -e "$dest_bin" || -L "$dest_bin" ]]; then
    local is_our_wrapper=false
    if [[ -f "$dest_bin" && ! -L "$dest_bin" ]] && grep -q "gravityzilla/desktop-patch/patch.mjs" "$dest_bin" 2>/dev/null; then
      is_our_wrapper=true
    fi
    if [[ "$is_our_wrapper" == false ]]; then
      if [[ "$FORCE" == false ]]; then
        echo "  [SKIP] $dest_bin already exists (preserving; re-run with --force to back up and replace)"
        SKIP_COUNT=$((SKIP_COUNT + 1))
        return 0
      fi
      if [[ -L "$dest_bin" ]]; then
        rm -f "$dest_bin"
      else
        mv "$dest_bin" "${dest_bin}.bak.${BACKUP_STAMP}"
        echo "  [BACKUP] $dest_bin -> ${dest_bin}.bak.${BACKUP_STAMP}"
      fi
    fi
  fi

  mkdir -p "$share_dir"
  cp -p "$SCRIPT_DIR/desktop-patch/patch.mjs" "$share_dir/patch.mjs"
  rm -rf "$share_dir/lib"
  cp -a "$SCRIPT_DIR/desktop-patch/lib" "$share_dir/lib"

  cat > "$dest_bin" <<EOF
#!/usr/bin/env bash
exec node "$share_dir/patch.mjs" "\$@"
EOF
  chmod +x "$dest_bin"
}

deploy_skills_link() {
  local src_dir="$1"
  local dest_dir="$2"

  if [[ ! -e "$dest_dir" && ! -L "$dest_dir" ]]; then
    ln -s "$src_dir" "$dest_dir"
    return 0
  fi

  if [[ -L "$dest_dir" ]]; then
    local src_real dest_real
    src_real="$(readlink -f "$src_dir" 2>/dev/null || echo "$src_dir")"
    dest_real="$(readlink -f "$dest_dir" 2>/dev/null || echo "")"
    if [[ "$src_real" == "$dest_real" ]]; then
      return 0
    fi
    if [[ "$FORCE" == false ]]; then
      echo "  [SKIP] $dest_dir already points to $(readlink "$dest_dir") (preserving; use --force to replace)"
      SKIP_COUNT=$((SKIP_COUNT + 1))
      return 0
    fi
    ln -sfn "$src_dir" "$dest_dir"
    return 0
  fi

  if [[ -d "$dest_dir" ]]; then
    local skill_dir
    for skill_dir in "$src_dir/"*; do
      [[ -d "$skill_dir" ]] || continue
      deploy_file "$skill_dir" "$dest_dir/$(basename "$skill_dir")"
    done
    return 0
  fi

  if [[ "$FORCE" == false ]]; then
    echo "  [SKIP] $dest_dir exists and is not a directory (preserving; use --force to back up and replace)"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    return 0
  fi
  mv "$dest_dir" "${dest_dir}.bak.${BACKUP_STAMP}"
  echo "  [BACKUP] $dest_dir -> ${dest_dir}.bak.${BACKUP_STAMP}"
  ln -s "$src_dir" "$dest_dir"
}

# 3. Install binaries & helper scripts
echo "==> Deploying helper binaries into ~/.local/bin/..."
for bin_file in "$SCRIPT_DIR/bin/"*; do
  [[ -f "$bin_file" ]] || continue
  filename="$(basename "$bin_file")"
  if [[ "$filename" == "rtk" && "$ARCH" != "x86_64" ]]; then
    echo "  [WARN] Skipping prebuilt x86_64 bin/rtk on $ARCH (install rtk via cargo or GitHub releases)"
    continue
  fi
  if [[ "$filename" == "agy-desktop-patch" && "$MODE" == "copy" ]]; then
    deploy_desktop_patch_copy
    continue
  fi
  deploy_file "$bin_file" "$HOME/.local/bin/$filename" "true"
done

# 4. Deploy ~/.gemini/config/ items (per-plugin links + copied mutable config.json)
echo "==> Deploying Antigravity configuration into ~/.gemini/config/..."
for cfg_item in "$SCRIPT_DIR/config/"*; do
  [[ -e "$cfg_item" ]] || continue
  item_name="$(basename "$cfg_item")"
  if [[ "$item_name" == "config.json" ]]; then
    deploy_template "$cfg_item" "$HOME/.gemini/config/config.json" "~/.gemini/config/config.json"
    continue
  fi
  if [[ "$item_name" == "plugins" ]]; then
    if [[ -L "$HOME/.gemini/config/plugins" ]]; then
      if [[ "$(readlink -f "$HOME/.gemini/config/plugins" 2>/dev/null || true)" == "$(readlink -f "$SCRIPT_DIR/config/plugins" 2>/dev/null || true)" ]]; then
        rm -f "$HOME/.gemini/config/plugins"
      fi
    fi
    if [[ ! -d "$HOME/.gemini/config/plugins" && ! -L "$HOME/.gemini/config/plugins" ]]; then
      mkdir -p "$HOME/.gemini/config/plugins"
    fi
    if [[ -d "$HOME/.gemini/config/plugins" ]]; then
      for plugin_dir in "$cfg_item/"*; do
        [[ -d "$plugin_dir" ]] || continue
        deploy_file "$plugin_dir" "$HOME/.gemini/config/plugins/$(basename "$plugin_dir")"
      done
    else
      echo "  [SKIP] ~/.gemini/config/plugins is not a directory (preserving)"
      SKIP_COUNT=$((SKIP_COUNT + 1))
    fi
    continue
  fi
  deploy_file "$cfg_item" "$HOME/.gemini/config/$item_name"
done

# Ensure discovery links without clobbering or nesting inside existing real directories.
deploy_skills_link "$SCRIPT_DIR/.agents/skills" "$HOME/.agents/skills"
deploy_skills_link "$HOME/.agents/skills" "$HOME/.gemini/config/skills"
deploy_skills_link "$HOME/.agents/skills" "$HOME/.gemini/antigravity-cli/skills"

# Remove legacy ~/.gemini/antigravity -> ~/.gemini/config symlink so Antigravity Desktop
# can manage ~/.gemini/antigravity/ as its own runtime data directory.
if [[ -L "$HOME/.gemini/antigravity" ]]; then
  if [[ "$(readlink -f "$HOME/.gemini/antigravity" 2>/dev/null || true)" == "$(readlink -f "$HOME/.gemini/config" 2>/dev/null || true)" ]]; then
    rm -f "$HOME/.gemini/antigravity"
  fi
fi

# 5. Deploy mutable config-extra templates (explicit files only; keys/ is never deployed)
echo "==> Deploying extra configs into ~/.config/..."
if [[ -f "$SCRIPT_DIR/config-extra/agy-stats/config.json" ]]; then
  deploy_template "$SCRIPT_DIR/config-extra/agy-stats/config.json" "$HOME/.config/agy-stats/config.json" "~/.config/agy-stats/config.json"
fi
if [[ -f "$SCRIPT_DIR/config-extra/rtk/config.toml" ]]; then
  deploy_template "$SCRIPT_DIR/config-extra/rtk/config.toml" "$HOME/.config/rtk/config.toml" "~/.config/rtk/config.toml"
fi
if [[ -f "$SCRIPT_DIR/config-extra/rtk/filters.toml" ]]; then
  deploy_template "$SCRIPT_DIR/config-extra/rtk/filters.toml" "$HOME/.config/rtk/filters.toml" "~/.config/rtk/filters.toml"
fi

# 6. Render settings.json
echo "==> Configuring ~/.gemini/antigravity-cli/settings.json..."
SETTINGS_DEST="$HOME/.gemini/antigravity-cli/settings.json"
if [[ -f "$SETTINGS_DEST" && "$FORCE" == false ]]; then
  echo "    Preserving existing ~/.gemini/antigravity-cli/settings.json (use --force to back up and overwrite)."
else
  if [[ -e "$SETTINGS_DEST" || -L "$SETTINGS_DEST" ]]; then
    if [[ -L "$SETTINGS_DEST" ]]; then
      rm -f "$SETTINGS_DEST"
    else
      mv "$SETTINGS_DEST" "${SETTINGS_DEST}.bak.${BACKUP_STAMP}"
      echo "  [BACKUP] $SETTINGS_DEST -> ${SETTINGS_DEST}.bak.${BACKUP_STAMP}"
    fi
  fi
  sed "s|{{HOME}}|$HOME|g" "$SCRIPT_DIR/templates/settings.json.template" > "$SETTINGS_DEST"
  echo "    Generated $SETTINGS_DEST with HOME=$HOME."
fi

# 7. Verification and Diagnostics
echo "==> Verifying installation..."

for py_bin in agy-compound agy-diagnostics agy-stats agy-statusline agy-watch agent-memory; do
  if [[ -f "$HOME/.local/bin/$py_bin" ]]; then
    python3 -m py_compile "$HOME/.local/bin/$py_bin" >/dev/null 2>&1 && \
      echo "    [PASS] $py_bin syntax OK" || \
      echo "    [WARN] $py_bin syntax verification warning"
  fi
done

if command -v node >/dev/null 2>&1; then
  DP_SCRIPT=""
  if [[ -f "$HOME/.local/share/gravityzilla/desktop-patch/patch.mjs" ]]; then
    DP_SCRIPT="$HOME/.local/share/gravityzilla/desktop-patch/patch.mjs"
  elif [[ -f "$HOME/.local/bin/agy-desktop-patch" ]]; then
    DP_SCRIPT="$HOME/.local/bin/agy-desktop-patch"
  fi
  if [[ -n "$DP_SCRIPT" ]]; then
    node --check "$DP_SCRIPT" >/dev/null 2>&1 && \
      echo "    [PASS] agy-desktop-patch syntax OK" || \
      echo "    [WARN] agy-desktop-patch syntax verification warning"
  fi
fi

if [[ -x "$HOME/.local/bin/rtk" ]]; then
  RTK_VER=$("$HOME/.local/bin/rtk" --version 2>/dev/null || echo "error")
  echo "    [PASS] rtk binary ($RTK_VER)"
fi

for opt_cmd in git curl sqlite3 npx bun; do
  if command -v "$opt_cmd" >/dev/null 2>&1; then
    echo "    [PASS] $opt_cmd ($(command -v "$opt_cmd"))"
  else
    echo "    [OPT]  $opt_cmd not found in PATH"
  fi
done

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

if command -v agy >/dev/null 2>&1; then
  AGY_VER=$(agy --version 2>/dev/null || echo "installed")
  echo "    [PASS] Antigravity CLI ($AGY_VER)"
else
  echo "    [NOTICE] 'agy' CLI executable not found in PATH."
  echo "    Install Antigravity CLI (agy) and ensure it is in your PATH."
fi

echo ""
echo "==> Antigravity setup completed successfully!"
echo "    Config root: ~/.gemini/config"
echo "    Binaries:    ~/.local/bin"
echo "    Mode:        $MODE"
if [[ "$SKIP_COUNT" -gt 0 ]]; then
  echo "    Skipped:     $SKIP_COUNT existing file(s) preserved (re-run with --force to back up and replace)"
fi
