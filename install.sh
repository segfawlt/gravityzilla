#!/usr/bin/env bash
# ==============================================================================
# gravityzilla: Antigravity Linux Setup & Selectable Installer
# Dual-mode (interactive TTY checklist + non-interactive CLI flags) with live
# host detection, per-skill linking, and external/latest RTK support.
# Never modifies shell rc files (~/.bashrc, ~/.zshrc, fish).
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_REAL="$(readlink -f "$SCRIPT_DIR")"
MODE="symlink"
FORCE=false
INTERACTIVE="auto" # auto | yes | no
STATUS_ONLY=false
LIST_ONLY=false
UNINSTALL=false
JSON_OUT=false
DOWNLOAD_RTK="auto" # auto | yes | no
ONLY_RAW=""
SKIP_RAW=""
SKIP_COUNT=0
BACKUP_STAMP="$(date +%Y%m%d-%H%M%S)"
ARCH="$(uname -m)"
MANIFEST_DIR="$HOME/.local/share/gravityzilla"
MANIFEST_FILE="$MANIFEST_DIR/manifest.txt"

C_RST=""
C_BOLD=""
C_DIM=""
C_RED=""
C_GREEN=""
C_YELLOW=""
C_MAGENTA=""
C_CYAN=""
C_BCYAN=""
C_BGREEN=""
C_BWHITE=""

init_colors() {
  if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" && "$JSON_OUT" != true ]]; then
    C_RST=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_DIM=$'\033[2m'
    C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'
    C_MAGENTA=$'\033[35m'
    C_CYAN=$'\033[36m'
    C_BCYAN=$'\033[1;36m'
    C_BGREEN=$'\033[1;32m'
    C_BWHITE=$'\033[1;97m'
  fi
}

ALL_COMPONENTS=(
  rules
  skills
  ship
  margin
  diagnostics
  stats
  watchdog
  memory
  rtk
  playwright
  desktop-patch
)

declare -A COMP_DESC=(
  [rules]="Global GEMINI.md rules, base mcp_config.json, config.json, settings.json"
  [skills]="Core Antigravity skills (13 skills under ~/.agents/skills/)"
  [ship]="/ship worktree workflow + git-wt-sync"
  [margin]="Right-pane Overview sidecar + margin_intent MCP"
  [diagnostics]="Instant post-edit syntax checks (agy-diagnostics)"
  [stats]="/stats telemetry, quota, & web dashboard (agy-stats)"
  [watchdog]="Loop circuit-breaker, hang recovery, & agy-statusline"
  [memory]="Cross-session memory & compound learnings (agent-memory, agy-compound)"
  [rtk]="Command output condenser + Git/Shell guard (reuses or downloads rtk)"
  [playwright]="On-demand Playwright UI audit MCP (disabled by default)"
  [desktop-patch]="Antigravity Desktop app.asar patcher (agy-desktop-patch)"
)

declare -A COMP_SELECTED=()
declare -A COMP_DETECTED=()
declare -A COMP_INSTALLED=()

RTK_STATE="MISSING"   # COMPATIBLE | INCOMPATIBLE | MISSING
RTK_PATH=""
RTK_VER=""
ASAR_PATH=""

usage() {
  cat <<'EOF'
Usage: ./install.sh [OPTIONS]

Modes:
  (Default on TTY)   Interactive checklist to toggle components & RTK download
  -y, --yes          Non-interactive install of default/detected components
  -i, --interactive  Force interactive TTY checklist (errors if not a TTY)
  --list             Show component inventory, host detection, and install state
  --status           Check deployed components for drift/missing targets
  --uninstall        Remove gravityzilla symlinks/copies (preserves local configs)

Selection & Flags (agent / automation friendly):
  -y, --yes, --non-interactive
                     Skip prompts and install non-interactively
  --only <csv>       Comma-separated components to act on (implies -y unless -i)
  --skip <csv>       Comma-separated components to exclude (implies -y unless -i)
  --symlink          (Default) Symlink repo files/dirs to target locations
  --copy             Copy files/dirs (tracked in manifest for clean uninstall)
  --download-rtk     Download latest rtk-ai/rtk if no compatible rtk is detected
  --no-download-rtk  Never download rtk; reuse external binary or skip
  --json             JSON output for --list and --status
  -f, --force        Back up and replace conflicting destination files/links
  -h, --help         Show this help message

Components:
  rules, skills, ship, margin, diagnostics, stats, watchdog,
  memory, rtk, playwright, desktop-patch
EOF
  exit 0
}

is_valid_component() {
  local needle="$1"
  local c
  for c in "${ALL_COMPONENTS[@]}"; do
    [[ "$c" == "$needle" ]] && return 0
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--interactive)
      INTERACTIVE="yes"
      shift
      ;;
    -y|--yes|--non-interactive)
      INTERACTIVE="no"
      shift
      ;;
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
    --list)
      LIST_ONLY=true
      shift
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    --json)
      JSON_OUT=true
      shift
      ;;
    --download-rtk)
      DOWNLOAD_RTK="yes"
      shift
      ;;
    --no-download-rtk)
      DOWNLOAD_RTK="no"
      shift
      ;;
    --only)
      [[ $# -ge 2 ]] || { echo "Error: --only requires a comma-separated list" >&2; exit 1; }
      ONLY_RAW="$2"
      shift 2
      ;;
    --only=*)
      ONLY_RAW="${1#--only=}"
      shift
      ;;
    --skip)
      [[ $# -ge 2 ]] || { echo "Error: --skip requires a comma-separated list" >&2; exit 1; }
      SKIP_RAW="$2"
      shift 2
      ;;
    --skip=*)
      SKIP_RAW="${1#--skip=}"
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

# ------------------------------------------------------------------------------
# Host Detection (RTK, Antigravity Desktop, Runtimes, Tools)
# ------------------------------------------------------------------------------

detect_asar_path() {
  local cand
  for cand in \
    "/opt/Antigravity/resources/app.asar" \
    "/usr/lib/antigravity/resources/app.asar" \
    "/usr/share/antigravity/resources/app.asar" \
    "$HOME/.local/share/Antigravity/resources/app.asar"; do
    if [[ -f "$cand" ]]; then
      ASAR_PATH="$cand"
      return 0
    fi
  done
  ASAR_PATH=""
  return 1
}

detect_rtk() {
  RTK_STATE="MISSING"
  RTK_PATH=""
  RTK_VER=""

  local -a candidates=()
  [[ -n "${RTK_BIN:-}" ]] && candidates+=("$RTK_BIN")

  local p_entry
  while IFS= read -r p_entry; do
    [[ -n "$p_entry" ]] && candidates+=("$p_entry")
  done < <(type -ap rtk 2>/dev/null || true)

  candidates+=(
    "$HOME/.cargo/bin/rtk"
    "/opt/homebrew/bin/rtk"
    "/home/linuxbrew/.linuxbrew/bin/rtk"
    "/usr/local/bin/rtk"
    "$HOME/.local/share/mise/shims/rtk"
    "$HOME/.asdf/shims/rtk"
    "$HOME/.nix-profile/bin/rtk"
    "$HOME/.local/bin/rtk"
  )

  local seen=""
  local cand real_cand ver
  local first_incompat_path="" first_incompat_ver=""

  for cand in "${candidates[@]}"; do
    [[ -n "$cand" && -x "$cand" && -f "$cand" ]] || continue
    real_cand="$(readlink -f "$cand" 2>/dev/null || echo "$cand")"
    [[ "$seen" == *"|$real_cand|"* ]] && continue
    seen="${seen}|${real_cand}|"

    ver="$("$cand" --version 2>/dev/null | head -n1 | tr -d '\r' || true)"
    if "$cand" hook antigravity --help >/dev/null 2>&1; then
      RTK_STATE="COMPATIBLE"
      RTK_PATH="$cand"
      RTK_VER="${ver:-rtk}"
      return 0
    elif [[ -z "$first_incompat_path" ]]; then
      first_incompat_path="$cand"
      first_incompat_ver="${ver:-unknown}"
    fi
  done

  if [[ -n "$first_incompat_path" ]]; then
    RTK_STATE="INCOMPATIBLE"
    RTK_PATH="$first_incompat_path"
    RTK_VER="$first_incompat_ver"
  fi
  return 0
}

core_skills_list() {
  local d name
  for d in "$SCRIPT_DIR/.agents/skills/"*; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    [[ "$name" == "ship" || "$name" == "stats" ]] && continue
    echo "$name"
  done
}

is_link_or_copy_present() {
  local dest="$1"
  [[ -e "$dest" || -L "$dest" ]]
}

probe_all_components() {
  detect_asar_path || true
  detect_rtk

  local py_ver="missing"
  if command -v python3 >/dev/null 2>&1; then
    py_ver="$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "unknown")"
  fi

  local node_ver="missing"
  if command -v node >/dev/null 2>&1; then
    node_ver="$(node -v 2>/dev/null || echo "unknown")"
  fi

  local agy_ver="missing"
  if command -v agy >/dev/null 2>&1; then
    agy_ver="$(agy --version 2>/dev/null | head -n1 || echo "installed")"
  fi

  local git_ver="missing"
  if command -v git >/dev/null 2>&1; then
    git_ver="$(git --version 2>/dev/null | awk '{print $3}' || echo "installed")"
  fi

  # 1. rules
  COMP_DETECTED[rules]="agy: $agy_ver"
  if [[ -e "$HOME/.gemini/config/GEMINI.md" || -L "$HOME/.gemini/config/GEMINI.md" ]] \
     && [[ -f "$HOME/.gemini/antigravity-cli/settings.json" ]]; then
    COMP_INSTALLED[rules]="installed"
  else
    COMP_INSTALLED[rules]="not installed"
  fi

  # 2. skills
  local core_total=0 core_present=0 sname
  while IFS= read -r sname; do
    core_total=$((core_total + 1))
    if is_link_or_copy_present "$HOME/.agents/skills/$sname"; then
      core_present=$((core_present + 1))
    fi
  done < <(core_skills_list)
  COMP_DETECTED[skills]="$core_total core skills"
  if [[ "$core_total" -gt 0 && "$core_present" -eq "$core_total" ]]; then
    COMP_INSTALLED[skills]="installed"
  elif [[ "$core_present" -gt 0 ]]; then
    COMP_INSTALLED[skills]="partial ($core_present/$core_total)"
  else
    COMP_INSTALLED[skills]="not installed"
  fi

  # 3. ship
  COMP_DETECTED[ship]="git: $git_ver"
  if is_link_or_copy_present "$HOME/.local/bin/git-wt-sync" && is_link_or_copy_present "$HOME/.agents/skills/ship"; then
    COMP_INSTALLED[ship]="installed"
  else
    COMP_INSTALLED[ship]="not installed"
  fi

  # 4. margin
  local sq="no sqlite3"
  command -v sqlite3 >/dev/null 2>&1 && sq="sqlite3 ok"
  COMP_DETECTED[margin]="node: $node_ver, $sq"
  if is_link_or_copy_present "$HOME/.gemini/config/plugins/margin"; then
    COMP_INSTALLED[margin]="installed"
  else
    COMP_INSTALLED[margin]="not installed"
  fi

  # 5. diagnostics
  local diag_tools=()
  for t in bun ruff shellcheck gofmt; do
    command -v "$t" >/dev/null 2>&1 && diag_tools+=("$t")
  done
  local diag_extra="no optional linters"
  [[ ${#diag_tools[@]} -gt 0 ]] && diag_extra="linters: ${diag_tools[*]}"
  COMP_DETECTED[diagnostics]="python: $py_ver, $diag_extra"
  if is_link_or_copy_present "$HOME/.local/bin/agy-diagnostics" && is_link_or_copy_present "$HOME/.gemini/config/plugins/diagnostics"; then
    COMP_INSTALLED[diagnostics]="installed"
  else
    COMP_INSTALLED[diagnostics]="not installed"
  fi

  # 6. stats
  local stats_cfg="fresh"
  [[ -f "$HOME/.config/agy-stats/config.json" ]] && stats_cfg="existing config"
  COMP_DETECTED[stats]="python: $py_ver, $stats_cfg"
  if is_link_or_copy_present "$HOME/.local/bin/agy-stats" && is_link_or_copy_present "$HOME/.gemini/config/plugins/stats"; then
    COMP_INSTALLED[stats]="installed"
  else
    COMP_INSTALLED[stats]="not installed"
  fi

  # 7. watchdog
  local ns="no notify-send"
  command -v notify-send >/dev/null 2>&1 && ns="notify-send ok"
  COMP_DETECTED[watchdog]="python: $py_ver, agy: $agy_ver, $ns"
  if is_link_or_copy_present "$HOME/.local/bin/agy-watch" && is_link_or_copy_present "$HOME/.local/bin/agy-statusline" && is_link_or_copy_present "$HOME/.gemini/config/plugins/watchdog"; then
    COMP_INSTALLED[watchdog]="installed"
  else
    COMP_INSTALLED[watchdog]="not installed"
  fi

  # 8. memory
  COMP_DETECTED[memory]="python: $py_ver, $sq, agy: $agy_ver"
  if is_link_or_copy_present "$HOME/.local/bin/agent-memory" && is_link_or_copy_present "$HOME/.local/bin/agy-compound" && is_link_or_copy_present "$HOME/.gemini/config/plugins/memory"; then
    COMP_INSTALLED[memory]="installed"
  else
    COMP_INSTALLED[memory]="not installed"
  fi

  # 9. rtk
  if [[ "$RTK_STATE" == "COMPATIBLE" ]]; then
    COMP_DETECTED[rtk]="$RTK_PATH ($RTK_VER, hook OK)"
  elif [[ "$RTK_STATE" == "INCOMPATIBLE" ]]; then
    COMP_DETECTED[rtk]="incompatible at $RTK_PATH ($RTK_VER); latest rtk-ai/rtk needed"
  else
    COMP_DETECTED[rtk]="missing (can download latest rtk-ai/rtk)"
  fi
  if is_link_or_copy_present "$HOME/.gemini/config/plugins/rtk"; then
    COMP_INSTALLED[rtk]="installed"
  else
    COMP_INSTALLED[rtk]="not installed"
  fi

  # 10. playwright
  local npx_st="no npx" chr_st="no browser"
  command -v npx >/dev/null 2>&1 && npx_st="npx ok"
  for b in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$b" >/dev/null 2>&1; then
      chr_st="$b"
      break
    fi
  done
  COMP_DETECTED[playwright]="$npx_st, $chr_st (disabled by default)"
  if is_link_or_copy_present "$HOME/.gemini/config/plugins/playwright"; then
    COMP_INSTALLED[playwright]="installed"
  else
    COMP_INSTALLED[playwright]="not installed"
  fi

  # 11. desktop-patch
  if [[ -n "$ASAR_PATH" ]]; then
    COMP_DETECTED[desktop-patch]="node: $node_ver, app.asar: $ASAR_PATH"
  else
    COMP_DETECTED[desktop-patch]="node: $node_ver, Desktop app.asar not detected"
  fi
  if is_link_or_copy_present "$HOME/.local/bin/agy-desktop-patch"; then
    COMP_INSTALLED[desktop-patch]="installed"
  else
    COMP_INSTALLED[desktop-patch]="not installed"
  fi
}

resolve_selection() {
  local c
  if [[ -n "$ONLY_RAW" ]]; then
    for c in "${ALL_COMPONENTS[@]}"; do COMP_SELECTED[$c]=false; done
    IFS=',' read -ra items <<< "$ONLY_RAW"
    for c in "${items[@]}"; do
      c="${c// /}"
      [[ -z "$c" ]] && continue
      if ! is_valid_component "$c"; then
        echo "Error: Unknown component in --only: '$c'" >&2
        echo "Valid components: ${ALL_COMPONENTS[*]}" >&2
        exit 1
      fi
      COMP_SELECTED[$c]=true
    done
  else
    for c in "${ALL_COMPONENTS[@]}"; do
      if [[ "$c" == "desktop-patch" && -z "$ASAR_PATH" && "${COMP_INSTALLED[desktop-patch]}" != "installed" ]]; then
        COMP_SELECTED[$c]=false
      else
        COMP_SELECTED[$c]=true
      fi
    done
  fi

  if [[ -n "$SKIP_RAW" ]]; then
    IFS=',' read -ra items <<< "$SKIP_RAW"
    for c in "${items[@]}"; do
      c="${c// /}"
      [[ -z "$c" ]] && continue
      if ! is_valid_component "$c"; then
        echo "Error: Unknown component in --skip: '$c'" >&2
        echo "Valid components: ${ALL_COMPONENTS[*]}" >&2
        exit 1
      fi
      COMP_SELECTED[$c]=false
    done
  fi
}

# ------------------------------------------------------------------------------
# Interactive Checklist UI (TTY)
# ------------------------------------------------------------------------------

run_interactive_menu() {
  if [[ ! -t 0 || ! -t 1 ]]; then
    echo "Error: --interactive requires an interactive terminal (TTY)." >&2
    exit 1
  fi

  local idx=0
  local total="${#ALL_COMPONENTS[@]}"
  local key rest c mark state_tag state_disp state_col det det_col row_ptr name_col focused_comp

  restore_cursor() {
    printf '\033[?25h'
  }
  trap 'restore_cursor; echo ""; trap - INT TERM; exit 130' INT TERM
  printf '\033[?25l'

  while true; do
    printf '\033[2J\033[H'
    printf '%b◆%b  %bgravityzilla%b %b— component installer (mode: %b%s%b)%b\n' \
      "$C_BCYAN" "$C_RST" "$C_BOLD" "$C_RST" "$C_DIM" "$C_CYAN" "$MODE" "$C_DIM" "$C_RST"
    printf '%b│%b  %b↑/↓ or j/k: move  •  Space/1-9: toggle  •  a: all  •  n: none  •  Enter: apply  •  q: quit%b\n' \
      "$C_DIM" "$C_RST" "$C_DIM" "$C_RST"
    printf '%b│%b\n' "$C_DIM" "$C_RST"

    for ((i = 0; i < total; i++)); do
      c="${ALL_COMPONENTS[$i]}"
      if [[ "${COMP_SELECTED[$c]}" == true ]]; then
        mark="${C_GREEN}●${C_RST}"
      else
        mark="${C_DIM}○${C_RST}"
      fi

      state_tag="${COMP_INSTALLED[$c]}"
      if [[ "$state_tag" == "installed" ]]; then
        state_disp="installed"
        state_col="$C_GREEN"
      elif [[ "$state_tag" == partial* ]]; then
        state_disp="$state_tag"
        state_col="$C_YELLOW"
      else
        state_disp="new"
        state_col="$C_DIM"
      fi

      det="${COMP_DETECTED[$c]}"
      if [[ "$det" == *missing* || "$det" == *MISSING* ]]; then
        det_col="$C_YELLOW"
      else
        det_col="$C_CYAN"
      fi

      if [[ "$i" -eq "$idx" ]]; then
        row_ptr="${C_BCYAN}❯${C_RST}"
        name_col="$C_BWHITE"
      else
        row_ptr=" "
        if [[ "${COMP_SELECTED[$c]}" == true ]]; then
          name_col="$C_RST"
        else
          name_col="$C_DIM"
        fi
      fi

      printf '%b│%b %b %b%2d.%b %b %b%-14s%b %b%-14s%b %bdetected: %s%b\n' \
        "$C_DIM" "$C_RST" "$row_ptr" "$C_DIM" "$((i + 1))" "$C_RST" \
        "$mark" "$name_col" "$c" "$C_RST" "$state_col" "$state_disp" "$C_RST" \
        "$det_col" "$det" "$C_RST"
    done

    focused_comp="${ALL_COMPONENTS[$idx]}"
    local sel_names=()
    for c in "${ALL_COMPONENTS[@]}"; do
      [[ "${COMP_SELECTED[$c]}" == true ]] && sel_names+=("$c")
    done

    printf '%b│%b\n' "$C_DIM" "$C_RST"
    printf '%b├%b  %b%s:%b %s\n' "$C_DIM" "$C_RST" "$C_BOLD" "$focused_comp" "$C_RST" "${COMP_DESC[$focused_comp]}"
    printf '%b└%b  %bSelected (%d/%d):%b %s\n' \
      "$C_DIM" "$C_RST" "$C_GREEN" "${#sel_names[@]}" "$total" "$C_RST" "${sel_names[*]:-(none)}"

    IFS= read -rsn1 key || true
    if [[ "$key" == $'\x1b' ]]; then
      IFS= read -rsn2 -t 0.1 rest || true
      case "$rest" in
        "[A") idx=$(( (idx - 1 + total) % total )) ;;
        "[B") idx=$(( (idx + 1) % total )) ;;
      esac
    elif [[ "$key" == "" ]]; then
      break
    elif [[ "$key" == " " ]]; then
      c="${ALL_COMPONENTS[$idx]}"
      if [[ "${COMP_SELECTED[$c]}" == true ]]; then COMP_SELECTED[$c]=false; else COMP_SELECTED[$c]=true; fi
    elif [[ "$key" == "k" ]]; then
      idx=$(( (idx - 1 + total) % total ))
    elif [[ "$key" == "j" ]]; then
      idx=$(( (idx + 1) % total ))
    elif [[ "$key" == "a" || "$key" == "A" ]]; then
      for c in "${ALL_COMPONENTS[@]}"; do COMP_SELECTED[$c]=true; done
    elif [[ "$key" == "n" || "$key" == "N" ]]; then
      for c in "${ALL_COMPONENTS[@]}"; do COMP_SELECTED[$c]=false; done
    elif [[ "$key" == "q" || "$key" == "Q" ]]; then
      restore_cursor
      trap - INT TERM
      printf '\n%bCancelled.%b\n' "$C_YELLOW" "$C_RST"
      exit 0
    elif [[ "$key" =~ ^[1-9]$ ]]; then
      local num=$((key - 1))
      if [[ "$num" -lt "$total" ]]; then
        idx="$num"
        c="${ALL_COMPONENTS[$idx]}"
        if [[ "${COMP_SELECTED[$c]}" == true ]]; then COMP_SELECTED[$c]=false; else COMP_SELECTED[$c]=true; fi
      fi
    fi
  done

  restore_cursor
  trap - INT TERM
  echo ""
  if [[ "${COMP_SELECTED[rtk]}" == true && "$RTK_STATE" != "COMPATIBLE" && "$DOWNLOAD_RTK" == "auto" ]]; then
    local ans=""
    printf '%b◆%b RTK (%b%s%b). Download newest %brtk-ai/rtk%b release to %b~/.local/bin/rtk%b? [Y/n] ' \
      "$C_CYAN" "$C_RST" "$C_YELLOW" "$RTK_STATE" "$C_RST" "$C_BOLD" "$C_RST" "$C_CYAN" "$C_RST"
    read -r ans
    case "${ans:-y}" in
      [Yy]*) DOWNLOAD_RTK="yes" ;;
      *)     DOWNLOAD_RTK="no" ;;
    esac
  fi
}

# ------------------------------------------------------------------------------
# --list (Inventory & Host Detection)
# ------------------------------------------------------------------------------

run_list() {
  if [[ "$JSON_OUT" == true ]]; then
    python3 - "${ALL_COMPONENTS[@]}" <<'PY'
import json, os, sys
comps = sys.argv[1:]
# Reconstruct from env exported below
data = {
    "rtk": {
        "state": os.environ.get("GZ_RTK_STATE", ""),
        "path": os.environ.get("GZ_RTK_PATH", ""),
        "version": os.environ.get("GZ_RTK_VER", ""),
    },
    "components": [],
}
for c in comps:
    k = c.replace("-", "_")
    data["components"].append({
        "name": c,
        "selected": os.environ.get(f"GZ_SEL_{k}") == "true",
        "installed": os.environ.get(f"GZ_INST_{k}", ""),
        "detected": os.environ.get(f"GZ_DET_{k}", ""),
        "description": os.environ.get(f"GZ_DESC_{k}", ""),
    })
print(json.dumps(data, indent=2))
PY
    return 0
  fi

  printf '%b==> gravityzilla components (host detection trace):%b\n' "$C_BCYAN" "$C_RST"
  local c flag flag_col inst_tag inst_col det_tag det_col
  for c in "${ALL_COMPONENTS[@]}"; do
    if [[ "${COMP_SELECTED[$c]}" == true ]]; then
      flag="on "
      flag_col="$C_GREEN"
    else
      flag="off"
      flag_col="$C_DIM"
    fi
    inst_tag="${COMP_INSTALLED[$c]}"
    if [[ "$inst_tag" == "installed" ]]; then
      inst_col="$C_GREEN"
    elif [[ "$inst_tag" == partial* ]]; then
      inst_col="$C_YELLOW"
    else
      inst_col="$C_DIM"
    fi
    det_tag="${COMP_DETECTED[$c]}"
    if [[ "$det_tag" == *missing* || "$det_tag" == *MISSING* ]]; then
      det_col="$C_YELLOW"
    else
      det_col="$C_CYAN"
    fi
    printf '  %b%-14s%b [%b%s%b] %b%-16s%b %b(detected: %s)%b\n' \
      "$C_BOLD" "$c" "$C_RST" "$flag_col" "$flag" "$C_RST" "$inst_col" "$inst_tag" "$C_RST" "$det_col" "$det_tag" "$C_RST"
  done
}

# ------------------------------------------------------------------------------
# Manifest & File Helpers (--copy tracking, backup, drift checks)
# ------------------------------------------------------------------------------

record_manifest() {
  local path="$1"
  mkdir -p "$MANIFEST_DIR"
  touch "$MANIFEST_FILE"
  if ! grep -qxF "$path" "$MANIFEST_FILE" 2>/dev/null; then
    printf '%s\n' "$path" >> "$MANIFEST_FILE"
  fi
}

remove_from_manifest() {
  local path="$1"
  [[ -f "$MANIFEST_FILE" ]] || return 0
  local tmp="${MANIFEST_FILE}.tmp.$$"
  grep -vxF "$path" "$MANIFEST_FILE" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$MANIFEST_FILE"
}

check_entry() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [[ ! -e "$dest" && ! -L "$dest" ]]; then
    printf '  %b[MISSING]%b %s\n' "$C_RED" "$C_RST" "$label"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    return 1
  fi

  if [[ -L "$dest" ]]; then
    if [[ ! -e "$dest" ]]; then
      printf '  %b[DRIFT]%b   %s (broken symlink -> %s)\n' "$C_YELLOW" "$C_RST" "$label" "$(readlink "$dest")"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
      return 1
    fi
    local src_real dest_real
    src_real="$(readlink -f "$src")"
    dest_real="$(readlink -f "$dest")"
    if [[ "$src_real" == "$dest_real" ]]; then
      printf '  %b[OK]%b      %s\n' "$C_GREEN" "$C_RST" "$label"
      return 0
    else
      printf '  %b[DRIFT]%b   %s (points to %s, expected %s)\n' "$C_YELLOW" "$C_RST" "$label" "$(readlink "$dest")" "$src"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
      return 1
    fi
  elif [[ -f "$src" && -f "$dest" ]]; then
    if cmp -s "$src" "$dest"; then
      printf '  %b[OK]%b      %s (copy)\n' "$C_GREEN" "$C_RST" "$label"
      return 0
    else
      printf '  %b[DRIFT]%b   %s (regular file differs from %s)\n' "$C_YELLOW" "$C_RST" "$label" "$src"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
      return 1
    fi
  elif [[ -d "$src" && -d "$dest" ]]; then
    if diff -rq -x '__pycache__' -x '.playwright-mcp' -x '*.pyc' "$src" "$dest" >/dev/null 2>&1; then
      printf '  %b[OK]%b      %s (dir copy)\n' "$C_GREEN" "$C_RST" "$label"
      return 0
    else
      printf '  %b[DRIFT]%b   %s (directory differs from %s)\n' "$C_YELLOW" "$C_RST" "$label" "$src"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
      return 1
    fi
  else
    printf '  %b[DRIFT]%b   %s (type mismatch)\n' "$C_YELLOW" "$C_RST" "$label"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    return 1
  fi
}

check_local_config() {
  local dest="$1"
  local label="$2"
  if [[ -f "$dest" || -L "$dest" ]]; then
    if [[ -L "$dest" ]]; then
      printf '  %b[DRIFT]%b   %s (symlinked; should be a local copy so runtime edits don'\''t dirty git)\n' "$C_YELLOW" "$C_RST" "$label"
      DRIFT_COUNT=$((DRIFT_COUNT + 1))
    else
      printf '  %b[OK]%b      %s (local config)\n' "$C_GREEN" "$C_RST" "$label"
    fi
  else
    printf '  %b[MISSING]%b %s\n' "$C_RED" "$C_RST" "$label"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  fi
}

check_skill_entry() {
  local src_dir="$1"
  local dest_dir="$2"
  local label="$3"
  check_entry "$src_dir" "$dest_dir" "$label" >/dev/null 2>&1 && {
    echo "  [OK]      $label"
    return 0
  }
  check_entry "$src_dir" "$dest_dir" "$label" || true
  return 1
}

# ------------------------------------------------------------------------------
# --status (Drift Check with Traceability & Optional JSON)
# ------------------------------------------------------------------------------

run_status() {
  if [[ "$JSON_OUT" == true ]]; then
    local status_text=""
    status_text="$(run_status_human)" || true
    python3 - "$status_text" <<'PY'
import json, os, re, sys
text = sys.argv[1]
m = re.search(r"^Status:\s+(\d+)\s+issue\(s\)", text, re.M)
drift = int(m.group(1)) if m else (0 if re.search(r"^Status:\s+CLEAN\b", text, re.M) else 1)
print(json.dumps({
    "clean": drift == 0,
    "driftCount": drift,
    "rtk": {
        "state": os.environ.get("GZ_RTK_STATE", ""),
        "path": os.environ.get("GZ_RTK_PATH", ""),
        "version": os.environ.get("GZ_RTK_VER", ""),
    },
    "output": text,
}, indent=2))
PY
    grep -q "^Status: CLEAN" <<< "$status_text"
    return $?
  fi

  run_status_human
}

run_status_human() {
  DRIFT_COUNT=0
  local any_installed=false
  local c
  for c in "${ALL_COMPONENTS[@]}"; do
    [[ "${COMP_INSTALLED[$c]}" != "not installed" ]] && any_installed=true && break
  done

  should_check_comp() {
    local name="$1"
    if [[ -n "$ONLY_RAW" || -n "$SKIP_RAW" ]]; then
      [[ "${COMP_SELECTED[$name]}" == true ]]
      return $?
    fi
    if [[ "$any_installed" == false ]]; then
      [[ "${COMP_SELECTED[$name]}" == true ]]
      return $?
    fi
    [[ "${COMP_INSTALLED[$name]}" != "not installed" ]]
  }

  echo "==> Checking gravityzilla status (host detection + drift)..."

  if should_check_comp rules; then
    echo "-- [rules] (detected: ${COMP_DETECTED[rules]}):"
    check_entry "$SCRIPT_DIR/config/GEMINI.md" "$HOME/.gemini/config/GEMINI.md" "~/.gemini/config/GEMINI.md" || true
    check_entry "$SCRIPT_DIR/config/mcp_config.json" "$HOME/.gemini/config/mcp_config.json" "~/.gemini/config/mcp_config.json" || true
    check_local_config "$HOME/.gemini/config/config.json" "~/.gemini/config/config.json"
    check_local_config "$HOME/.gemini/antigravity-cli/settings.json" "~/.gemini/antigravity-cli/settings.json"
  fi

  if should_check_comp skills; then
    echo "-- [skills] (detected: ${COMP_DETECTED[skills]}):"
    local sname
    while IFS= read -r sname; do
      check_entry "$SCRIPT_DIR/.agents/skills/$sname" "$HOME/.agents/skills/$sname" "~/.agents/skills/$sname" || true
    done < <(core_skills_list)
    if [[ -L "$HOME/.gemini/config/skills" ]]; then
      check_entry "$HOME/.agents/skills" "$HOME/.gemini/config/skills" "~/.gemini/config/skills" || true
    fi
    if [[ -L "$HOME/.gemini/antigravity-cli/skills" ]]; then
      check_entry "$HOME/.agents/skills" "$HOME/.gemini/antigravity-cli/skills" "~/.gemini/antigravity-cli/skills" || true
    fi
  fi

  if should_check_comp ship; then
    echo "-- [ship] (detected: ${COMP_DETECTED[ship]}):"
    check_entry "$SCRIPT_DIR/.agents/skills/ship" "$HOME/.agents/skills/ship" "~/.agents/skills/ship" || true
    check_entry "$SCRIPT_DIR/bin/git-wt-sync" "$HOME/.local/bin/git-wt-sync" "~/.local/bin/git-wt-sync" || true
  fi

  if should_check_comp margin; then
    echo "-- [margin] (detected: ${COMP_DETECTED[margin]}):"
    check_entry "$SCRIPT_DIR/config/plugins/margin" "$HOME/.gemini/config/plugins/margin" "~/.gemini/config/plugins/margin" || true
  fi

  if should_check_comp diagnostics; then
    echo "-- [diagnostics] (detected: ${COMP_DETECTED[diagnostics]}):"
    check_entry "$SCRIPT_DIR/bin/agy-diagnostics" "$HOME/.local/bin/agy-diagnostics" "~/.local/bin/agy-diagnostics" || true
    check_entry "$SCRIPT_DIR/config/plugins/diagnostics" "$HOME/.gemini/config/plugins/diagnostics" "~/.gemini/config/plugins/diagnostics" || true
  fi

  if should_check_comp stats; then
    echo "-- [stats] (detected: ${COMP_DETECTED[stats]}):"
    check_entry "$SCRIPT_DIR/bin/agy-stats" "$HOME/.local/bin/agy-stats" "~/.local/bin/agy-stats" || true
    check_entry "$SCRIPT_DIR/config/plugins/stats" "$HOME/.gemini/config/plugins/stats" "~/.gemini/config/plugins/stats" || true
    check_entry "$SCRIPT_DIR/.agents/skills/stats" "$HOME/.agents/skills/stats" "~/.agents/skills/stats" || true
    check_local_config "$HOME/.config/agy-stats/config.json" "~/.config/agy-stats/config.json"
  fi

  if should_check_comp watchdog; then
    echo "-- [watchdog] (detected: ${COMP_DETECTED[watchdog]}):"
    check_entry "$SCRIPT_DIR/bin/agy-watch" "$HOME/.local/bin/agy-watch" "~/.local/bin/agy-watch" || true
    check_entry "$SCRIPT_DIR/bin/agy-statusline" "$HOME/.local/bin/agy-statusline" "~/.local/bin/agy-statusline" || true
    check_entry "$SCRIPT_DIR/config/plugins/watchdog" "$HOME/.gemini/config/plugins/watchdog" "~/.gemini/config/plugins/watchdog" || true
  fi

  if should_check_comp memory; then
    echo "-- [memory] (detected: ${COMP_DETECTED[memory]}):"
    check_entry "$SCRIPT_DIR/bin/agent-memory" "$HOME/.local/bin/agent-memory" "~/.local/bin/agent-memory" || true
    check_entry "$SCRIPT_DIR/bin/agy-compound" "$HOME/.local/bin/agy-compound" "~/.local/bin/agy-compound" || true
    check_entry "$SCRIPT_DIR/config/plugins/memory" "$HOME/.gemini/config/plugins/memory" "~/.gemini/config/plugins/memory" || true
  fi

  if should_check_comp rtk; then
    echo "-- [rtk] (detected: ${COMP_DETECTED[rtk]}):"
    check_entry "$SCRIPT_DIR/config/plugins/rtk" "$HOME/.gemini/config/plugins/rtk" "~/.gemini/config/plugins/rtk" || true
    check_local_config "$HOME/.config/rtk/config.toml" "~/.config/rtk/config.toml"
    check_local_config "$HOME/.config/rtk/filters.toml" "~/.config/rtk/filters.toml"
  fi

  if should_check_comp playwright; then
    echo "-- [playwright] (detected: ${COMP_DETECTED[playwright]}):"
    check_entry "$SCRIPT_DIR/config/plugins/playwright" "$HOME/.gemini/config/plugins/playwright" "~/.gemini/config/plugins/playwright" || true
  fi

  if should_check_comp desktop-patch; then
    echo "-- [desktop-patch] (detected: ${COMP_DETECTED[desktop-patch]}):"
    local dp_dest="$HOME/.local/bin/agy-desktop-patch"
    local dp_share="$MANIFEST_DIR/desktop-patch"
    if [[ -f "$dp_dest" && ! -L "$dp_dest" ]] && grep -q "gravityzilla/desktop-patch/patch.mjs" "$dp_dest" 2>/dev/null; then
      if [[ -f "$dp_share/patch.mjs" && -d "$dp_share/lib" ]]; then
        echo "  [OK]      ~/.local/bin/agy-desktop-patch (copy wrapper)"
      else
        echo "  [DRIFT]   ~/.local/bin/agy-desktop-patch (missing $dp_share/patch.mjs or lib/)"
        DRIFT_COUNT=$((DRIFT_COUNT + 1))
      fi
    else
      check_entry "$SCRIPT_DIR/bin/agy-desktop-patch" "$dp_dest" "~/.local/bin/agy-desktop-patch" || true
    fi
  fi

  echo ""
  if [[ "$DRIFT_COUNT" -eq 0 ]]; then
    printf '%bStatus: CLEAN (0 drift/missing items)%b\n' "$C_BGREEN" "$C_RST"
    return 0
  else
    printf '%bStatus: %d issue(s) found (run ./install.sh to reconcile)%b\n' "$C_YELLOW" "$DRIFT_COUNT" "$C_RST"
    return 1
  fi
}

# ------------------------------------------------------------------------------
# --uninstall (Removes Symlinks, Wrappers, & Manifest Copies)
# ------------------------------------------------------------------------------

remove_target_if_managed() {
  local dest="$1"
  [[ -e "$dest" || -L "$dest" ]] || return 0

  if [[ -L "$dest" ]]; then
    local target
    target="$(readlink -f "$dest" 2>/dev/null || readlink "$dest")"
    if [[ "$target" == "$REPO_REAL"* || "$target" == "$HOME/.agents/skills"* ]]; then
      rm -f "$dest"
      remove_from_manifest "$dest"
      echo "  [REMOVED] $dest"
    fi
    return 0
  fi

  if [[ -f "$MANIFEST_FILE" ]] && grep -qxF "$dest" "$MANIFEST_FILE" 2>/dev/null; then
    rm -rf "$dest"
    remove_from_manifest "$dest"
    echo "  [REMOVED] $dest"
  fi
}

run_uninstall() {
  local -A rm_comp=()
  local c
  if [[ -n "$ONLY_RAW" ]]; then
    for c in "${ALL_COMPONENTS[@]}"; do rm_comp[$c]=false; done
    IFS=',' read -ra items <<< "$ONLY_RAW"
    for c in "${items[@]}"; do
      c="${c// /}"
      [[ -z "$c" ]] && continue
      is_valid_component "$c" || { echo "Error: Unknown component in --only: '$c'" >&2; exit 1; }
      rm_comp[$c]=true
    done
  else
    for c in "${ALL_COMPONENTS[@]}"; do rm_comp[$c]=true; done
  fi

  echo "==> Uninstalling gravityzilla managed links and copies..."

  # Remove Gemini skill discovery links before ~/.agents/skills so readlink resolves cleanly.
  if [[ -z "$ONLY_RAW" ]]; then
    for sdest in "$HOME/.gemini/config/skills" "$HOME/.gemini/antigravity-cli/skills"; do
      if [[ -L "$sdest" ]]; then
        remove_target_if_managed "$sdest"
      elif [[ -d "$sdest" ]]; then
        for entry in "$sdest/"*; do
          [[ -e "$entry" || -L "$entry" ]] || continue
          remove_target_if_managed "$entry"
        done
      fi
    done
  fi

  if [[ "${rm_comp[rules]}" == true ]]; then
    remove_target_if_managed "$HOME/.gemini/config/GEMINI.md"
    remove_target_if_managed "$HOME/.gemini/config/mcp_config.json"
  fi

  if [[ "${rm_comp[skills]}" == true ]]; then
    if [[ -L "$HOME/.agents/skills" ]]; then
      remove_target_if_managed "$HOME/.agents/skills"
    else
      local sname
      while IFS= read -r sname; do
        remove_target_if_managed "$HOME/.agents/skills/$sname"
        remove_target_if_managed "$HOME/.gemini/config/skills/$sname"
        remove_target_if_managed "$HOME/.gemini/antigravity-cli/skills/$sname"
      done < <(core_skills_list)
    fi
  fi

  if [[ "${rm_comp[ship]}" == true ]]; then
    remove_target_if_managed "$HOME/.local/bin/git-wt-sync"
    remove_target_if_managed "$HOME/.agents/skills/ship"
    remove_target_if_managed "$HOME/.gemini/config/skills/ship"
    remove_target_if_managed "$HOME/.gemini/antigravity-cli/skills/ship"
  fi

  if [[ "${rm_comp[margin]}" == true ]]; then
    remove_target_if_managed "$HOME/.gemini/config/plugins/margin"
  fi

  if [[ "${rm_comp[diagnostics]}" == true ]]; then
    remove_target_if_managed "$HOME/.local/bin/agy-diagnostics"
    remove_target_if_managed "$HOME/.gemini/config/plugins/diagnostics"
  fi

  if [[ "${rm_comp[stats]}" == true ]]; then
    remove_target_if_managed "$HOME/.local/bin/agy-stats"
    remove_target_if_managed "$HOME/.gemini/config/plugins/stats"
    remove_target_if_managed "$HOME/.agents/skills/stats"
    remove_target_if_managed "$HOME/.gemini/config/skills/stats"
    remove_target_if_managed "$HOME/.gemini/antigravity-cli/skills/stats"
  fi

  if [[ "${rm_comp[watchdog]}" == true ]]; then
    remove_target_if_managed "$HOME/.local/bin/agy-watch"
    remove_target_if_managed "$HOME/.local/bin/agy-statusline"
    remove_target_if_managed "$HOME/.gemini/config/plugins/watchdog"
  fi

  if [[ "${rm_comp[memory]}" == true ]]; then
    remove_target_if_managed "$HOME/.local/bin/agent-memory"
    remove_target_if_managed "$HOME/.local/bin/agy-compound"
    remove_target_if_managed "$HOME/.gemini/config/plugins/memory"
  fi

  if [[ "${rm_comp[rtk]}" == true ]]; then
    remove_target_if_managed "$HOME/.gemini/config/plugins/rtk"
  fi

  if [[ "${rm_comp[playwright]}" == true ]]; then
    remove_target_if_managed "$HOME/.gemini/config/plugins/playwright"
  fi

  if [[ "${rm_comp[desktop-patch]}" == true ]]; then
    local dp_dest="$HOME/.local/bin/agy-desktop-patch"
    if [[ -L "$dp_dest" ]]; then
      remove_target_if_managed "$dp_dest"
    elif [[ -f "$dp_dest" ]] && grep -q "gravityzilla/desktop-patch/patch.mjs" "$dp_dest" 2>/dev/null; then
      rm -f "$dp_dest"
      remove_from_manifest "$dp_dest"
      echo "  [REMOVED] $dp_dest"
    fi
    if [[ -d "$MANIFEST_DIR/desktop-patch" ]]; then
      rm -rf "$MANIFEST_DIR/desktop-patch"
      echo "  [REMOVED] $MANIFEST_DIR/desktop-patch"
    fi
  fi

  if [[ -z "$ONLY_RAW" && -L "$HOME/.gemini/config/plugins" ]]; then
    remove_target_if_managed "$HOME/.gemini/config/plugins"
  fi

  if [[ -f "$MANIFEST_FILE" && ! -s "$MANIFEST_FILE" ]]; then
    rm -f "$MANIFEST_FILE"
    rmdir "$MANIFEST_DIR" 2>/dev/null || true
  fi

  echo ""
  echo "==> Uninstall complete."
  echo "    Preserved local configs, local skills, external rtk, & runtime data (~/.gemini/config/config.json, settings.json, ~/.config/agy-stats/, ~/.config/rtk/, ~/.agents/memories/)."
}

# ------------------------------------------------------------------------------
# Deployment Primitives
# ------------------------------------------------------------------------------

deploy_entry() {
  local src="$1"
  local dest="$2"
  local is_executable="${3:-false}"

  mkdir -p "$(dirname "$dest")"
  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ "$MODE" == "symlink" && -L "$dest" ]]; then
      local src_real dest_real
      src_real="$(readlink -f "$src" 2>/dev/null || echo "$src")"
      dest_real="$(readlink -f "$dest" 2>/dev/null || echo "")"
      if [[ "$src_real" == "$dest_real" ]]; then
        return 0
      fi
    fi
    if [[ "$MODE" == "copy" && -f "$src" && -f "$dest" && ! -L "$dest" ]] && cmp -s "$src" "$dest"; then
      [[ "$is_executable" == "true" ]] && chmod +x "$dest"
      record_manifest "$dest"
      return 0
    fi
    if [[ "$MODE" == "copy" && -d "$src" && -d "$dest" && ! -L "$dest" ]] && diff -rq -x '__pycache__' -x '.playwright-mcp' -x '*.pyc' "$src" "$dest" >/dev/null 2>&1; then
      record_manifest "$dest"
      return 0
    fi
    if [[ "$FORCE" == false ]]; then
      printf '  %b[SKIP]%b    %s already exists (preserving; re-run with --force to back up and replace)\n' "$C_DIM" "$C_RST" "$dest"
      SKIP_COUNT=$((SKIP_COUNT + 1))
      return 0
    fi
    if [[ -L "$dest" ]]; then
      rm -f "$dest"
    else
      mv "$dest" "${dest}.bak.${BACKUP_STAMP}"
      printf '  %b[BACKUP]%b  %s -> %s\n' "$C_YELLOW" "$C_RST" "$dest" "${dest}.bak.${BACKUP_STAMP}"
    fi
  fi

  if [[ "$MODE" == "symlink" ]]; then
    ln -s "$src" "$dest"
    printf '  %b[LINK]%b    %s -> %s\n' "$C_GREEN" "$C_RST" "$dest" "$src"
  else
    if [[ -d "$src" ]]; then
      cp -a "$src" "$dest"
      find "$dest" -type d \( -name '__pycache__' -o -name '.playwright-mcp' \) -exec rm -rf {} + 2>/dev/null || true
      find "$dest" -type f -name '*.pyc' -delete 2>/dev/null || true
    else
      cp -p "$src" "$dest"
    fi
    [[ "$is_executable" == "true" ]] && chmod +x "$dest"
    record_manifest "$dest"
    printf '  %b[COPY]%b    %s\n' "$C_GREEN" "$C_RST" "$dest"
  fi
}

deploy_template() {
  local src="$1"
  local dest="$2"
  local label="${3:-$dest}"

  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ "$FORCE" == false ]]; then
      printf '  %b[KEEP]%b    %s (preserving existing local config)\n' "$C_CYAN" "$C_RST" "$label"
      return 0
    fi
    if [[ -L "$dest" ]]; then
      rm -f "$dest"
    else
      mv "$dest" "${dest}.bak.${BACKUP_STAMP}"
      printf '  %b[BACKUP]%b  %s -> %s\n' "$C_YELLOW" "$C_RST" "$dest" "${dest}.bak.${BACKUP_STAMP}"
    fi
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  printf '  %b[INIT]%b    %s\n' "$C_GREEN" "$C_RST" "$label"
}

deploy_desktop_patch_copy() {
  local share_dir="$MANIFEST_DIR/desktop-patch"
  local dest_bin="$HOME/.local/bin/agy-desktop-patch"

  if [[ -e "$dest_bin" || -L "$dest_bin" ]]; then
    local is_our_wrapper=false
    if [[ -f "$dest_bin" && ! -L "$dest_bin" ]] && grep -q "gravityzilla/desktop-patch/patch.mjs" "$dest_bin" 2>/dev/null; then
      is_our_wrapper=true
    fi
    if [[ "$is_our_wrapper" == false ]]; then
      if [[ "$FORCE" == false ]]; then
        echo "  [SKIP]    $dest_bin already exists (preserving; re-run with --force to back up and replace)"
        SKIP_COUNT=$((SKIP_COUNT + 1))
        return 0
      fi
      if [[ -L "$dest_bin" ]]; then
        rm -f "$dest_bin"
      else
        mv "$dest_bin" "${dest_bin}.bak.${BACKUP_STAMP}"
        echo "  [BACKUP]  $dest_bin -> ${dest_bin}.bak.${BACKUP_STAMP}"
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
  record_manifest "$dest_bin"
  echo "  [WRAP]    $dest_bin -> $share_dir/patch.mjs"
}

ensure_real_skills_dir() {
  local sdir="$HOME/.agents/skills"
  if [[ -L "$sdir" ]]; then
    local target
    target="$(readlink -f "$sdir" 2>/dev/null || echo "")"
    if [[ "$target" == "$REPO_REAL/.agents/skills" ]]; then
      rm -f "$sdir"
      mkdir -p "$sdir"
      echo "  [MIGRATE] Converted ~/.agents/skills folder symlink to per-skill directory"
    fi
  elif [[ ! -e "$sdir" ]]; then
    mkdir -p "$sdir"
  fi
}

ensure_skills_discovery_links() {
  local sname="$1"
  local src_skill="$HOME/.agents/skills/$sname"
  local link_root
  for link_root in "$HOME/.gemini/config/skills" "$HOME/.gemini/antigravity-cli/skills"; do
    if [[ -L "$link_root" ]]; then
      local rtarget
      rtarget="$(readlink -f "$link_root" 2>/dev/null || echo "")"
      [[ "$rtarget" == "$(readlink -f "$HOME/.agents/skills" 2>/dev/null || echo "$HOME/.agents/skills")" ]] && continue
    fi
    if [[ ! -e "$link_root" && ! -L "$link_root" ]]; then
      ln -s "$HOME/.agents/skills" "$link_root"
      continue
    fi
    if [[ -d "$link_root" && ! -L "$link_root" ]]; then
      if [[ ! -e "$link_root/$sname" && ! -L "$link_root/$sname" ]]; then
        ln -s "$src_skill" "$link_root/$sname"
      fi
    fi
  done
}

ensure_real_plugins_dir() {
  local pdir="$HOME/.gemini/config/plugins"
  if [[ -L "$pdir" ]]; then
    local target
    target="$(readlink -f "$pdir" 2>/dev/null || echo "")"
    if [[ "$target" == "$REPO_REAL/config/plugins" ]]; then
      rm -f "$pdir"
    fi
  fi
  mkdir -p "$pdir"
}

download_latest_rtk() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "  [WARN]    curl not found; cannot download latest rtk-ai/rtk." >&2
    return 1
  fi

  local rtk_os="" rtk_arch="" target="" fallback_target=""
  case "$(uname -s)" in
    Linux*) rtk_os="linux" ;;
    *)
      echo "  [WARN]    Unsupported OS for automatic rtk download: $(uname -s)" >&2
      return 1
      ;;
  esac
  case "$ARCH" in
    x86_64|amd64)   rtk_arch="x86_64"; target="x86_64-unknown-linux-musl" ;;
    aarch64|arm64)  rtk_arch="aarch64"; target="aarch64-unknown-linux-musl"; fallback_target="aarch64-unknown-linux-gnu" ;;
    *)
      echo "  [WARN]    Unsupported architecture for prebuilt rtk release: $ARCH" >&2
      return 1
      ;;
  esac

  local version="${RTK_VERSION:-}"
  if [[ -z "$version" ]]; then
    version="$(curl -sI "https://github.com/rtk-ai/rtk/releases/latest" \
      | grep -i '^location:' \
      | sed -E 's|.*/tag/([^[:space:]]+).*|\1|' \
      | tr -d '\r' || true)"
  fi
  if [[ -z "$version" ]]; then
    version="$(curl -fsSL "https://api.github.com/repos/rtk-ai/rtk/releases/latest" 2>/dev/null \
      | grep '"tag_name":' \
      | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  fi
  if [[ -z "$version" ]]; then
    echo "  [WARN]    Could not resolve latest rtk-ai/rtk version (offline or rate-limited)." >&2
    return 1
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  local checksums_url="https://github.com/rtk-ai/rtk/releases/download/${version}/checksums.txt"
  local checksums_file="$tmp_dir/checksums.txt"
  if ! curl -fsSL "$checksums_url" -o "$checksums_file"; then
    echo "  [WARN]    Failed to download rtk checksums.txt (${version})." >&2
    return 1
  fi

  if [[ -n "$fallback_target" ]] && ! grep -q "[[:space:]]rtk-${target}\.tar\.gz\$" "$checksums_file"; then
    target="$fallback_target"
  fi

  local asset="rtk-${target}.tar.gz"
  local dl_url="https://github.com/rtk-ai/rtk/releases/download/${version}/${asset}"
  local archive="$tmp_dir/$asset"

  echo "  [RTK]     Downloading $asset ($version) from rtk-ai/rtk..."
  if ! curl -fsSL "$dl_url" -o "$archive"; then
    echo "  [WARN]    Failed to download $dl_url" >&2
    return 1
  fi

  local expected_sha actual_sha
  expected_sha="$(grep -E "[[:space:]]${asset}\$" "$checksums_file" | awk '{print $1}' | head -n1)"
  if [[ -z "$expected_sha" ]]; then
    echo "  [WARN]    Missing SHA-256 entry for $asset in checksums.txt; aborting." >&2
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
  else
    echo "  [WARN]    sha256sum/shasum unavailable; cannot verify rtk download." >&2
    return 1
  fi
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "  [ERROR]   SHA-256 mismatch for $asset ($actual_sha != $expected_sha)" >&2
    return 1
  fi

  tar -xzf "$archive" -C "$tmp_dir"
  if [[ ! -f "$tmp_dir/rtk" ]]; then
    echo "  [WARN]    Archive $asset did not contain expected rtk binary." >&2
    return 1
  fi

  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$tmp_dir/rtk" "$HOME/.local/bin/rtk.tmp.$$"
  mv -f "$HOME/.local/bin/rtk.tmp.$$" "$HOME/.local/bin/rtk"

  if "$HOME/.local/bin/rtk" hook antigravity --help >/dev/null 2>&1; then
    local new_ver
    new_ver="$("$HOME/.local/bin/rtk" --version 2>/dev/null | head -n1 || echo "$version")"
    echo "  [RTK]     Installed verified $new_ver -> ~/.local/bin/rtk"
    RTK_STATE="COMPATIBLE"
    RTK_PATH="$HOME/.local/bin/rtk"
    RTK_VER="$new_ver"
    return 0
  else
    echo "  [WARN]    Downloaded rtk lacks 'hook antigravity' support." >&2
    return 1
  fi
}

render_settings_json() {
  local src="$SCRIPT_DIR/templates/settings.json.template"
  local dest="$HOME/.gemini/antigravity-cli/settings.json"
  local include_statusline="${COMP_SELECTED[watchdog]}"

  if [[ -f "$dest" && "$FORCE" == false ]]; then
    echo "  [KEEP]    ~/.gemini/antigravity-cli/settings.json (preserving existing)"
    return 0
  fi
  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ -L "$dest" ]]; then
      rm -f "$dest"
    else
      mv "$dest" "${dest}.bak.${BACKUP_STAMP}"
      echo "  [BACKUP]  $dest -> ${dest}.bak.${BACKUP_STAMP}"
    fi
  fi

  mkdir -p "$(dirname "$dest")"
  python3 - "$src" "$dest" "$HOME" "$include_statusline" <<'PY'
import json, pathlib, sys
src, dest, home, with_sl = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "true"
raw = pathlib.Path(src).read_text(encoding="utf-8").replace("{{HOME}}", home)
data = json.loads(raw)
if not with_sl:
    data.pop("statusLine", None)
pathlib.Path(dest).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
  echo "  [INIT]    ~/.gemini/antigravity-cli/settings.json (HOME=$HOME, statusLine=$include_statusline)"
}

# ------------------------------------------------------------------------------
# Main Execution Flow
# ------------------------------------------------------------------------------

probe_all_components
resolve_selection
init_colors

# Export probed state for --list / --status --json
export GZ_RTK_STATE="$RTK_STATE" GZ_RTK_PATH="$RTK_PATH" GZ_RTK_VER="$RTK_VER"
for c in "${ALL_COMPONENTS[@]}"; do
  k="${c//-/_}"
  export "GZ_SEL_${k}=${COMP_SELECTED[$c]}"
  export "GZ_INST_${k}=${COMP_INSTALLED[$c]}"
  export "GZ_DET_${k}=${COMP_DETECTED[$c]}"
  export "GZ_DESC_${k}=${COMP_DESC[$c]}"
done

if [[ "$LIST_ONLY" == true ]]; then
  run_list
  exit 0
fi

if [[ "$STATUS_ONLY" == true ]]; then
  run_status
  exit $?
fi

if [[ "$UNINSTALL" == true ]]; then
  run_uninstall
  exit 0
fi

if [[ "$INTERACTIVE" == "auto" ]]; then
  if [[ -t 0 && -t 1 && -z "$ONLY_RAW" && -z "$SKIP_RAW" ]]; then
    INTERACTIVE="yes"
  else
    INTERACTIVE="no"
  fi
fi

if [[ "$INTERACTIVE" == "yes" ]]; then
  run_interactive_menu
fi

printf '%b==> Starting gravityzilla Linux setup (Mode: %s, Force: %s)...%b\n' "$C_BCYAN" "$MODE" "$FORCE" "$C_RST"

# 1. System prerequisite checks
printf '%b==> Verifying system requirements...%b\n' "$C_CYAN" "$C_RST"
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: This installer targets Linux only (detected: $(uname -s))." >&2
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
  printf '  %b[WARN]%b    Python %s (< 3.11); TOML diagnostics in agy-diagnostics will be skipped.\n' "$C_YELLOW" "$C_RST" "$PY_VER"
else
  printf '  %b[PASS]%b    Python %s\n' "$C_GREEN" "$C_RST" "$PY_VER"
fi

if ! command -v node >/dev/null 2>&1; then
  printf '  %b[WARN]%b    node not found (Margin, agy-desktop-patch, and UI skills require Node.js >= 22.13).\n' "$C_YELLOW" "$C_RST"
else
  NODE_VER=$(node -v 2>/dev/null || echo "v0.0.0")
  NODE_MAJ=$(node -e "const v=process.versions.node.split('.').map(Number); console.log(v[0])" 2>/dev/null || echo 0)
  NODE_MIN=$(node -e "const v=process.versions.node.split('.').map(Number); console.log(v[1])" 2>/dev/null || echo 0)
  if [[ "$NODE_MAJ" -lt 22 ]] || { [[ "$NODE_MAJ" -eq 22 ]] && [[ "$NODE_MIN" -lt 13 ]]; }; then
    printf '  %b[WARN]%b    Node.js %s (< v22.13); Margin memory.db queries degrade gracefully.\n' "$C_YELLOW" "$C_RST" "$NODE_VER"
  else
    printf '  %b[PASS]%b    Node.js %s\n' "$C_GREEN" "$C_RST" "$NODE_VER"
  fi
fi

# 2. Prepare base directories & clean obsolete components
mkdir -p "$HOME/.local/bin" "$HOME/.gemini/config" "$HOME/.gemini/antigravity-cli"
ensure_real_plugins_dir
ensure_real_skills_dir

# Remove obsolete legacy components
rm -rf "$HOME/.gemini/config/plugins/ledger" "$HOME/.local/bin/agy-ledger" "$HOME/.agents/ledger" \
       "$HOME/.gemini/config/plugins/advisor" "$HOME/.gemini/config/agents/advisor-core.md" \
       "$HOME/.local/bin/agy-advisor" "$HOME/.agents/advisor"
if [[ -L "$HOME/.gemini/config/agents" && ! -e "$HOME/.gemini/config/agents" ]]; then
  rm -f "$HOME/.gemini/config/agents"
fi
if [[ -L "$HOME/.gemini/antigravity" ]]; then
  if [[ "$(readlink -f "$HOME/.gemini/antigravity" 2>/dev/null || true)" == "$(readlink -f "$HOME/.gemini/config" 2>/dev/null || true)" ]]; then
    rm -f "$HOME/.gemini/antigravity"
  fi
fi

# 3. Deploy selected components with live traceability
printf '%b==> Deploying selected components...%b\n' "$C_CYAN" "$C_RST"

if [[ "${COMP_SELECTED[rules]}" == true ]]; then
  printf '%b-- [rules]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[rules]}" "$C_RST"
  deploy_entry "$SCRIPT_DIR/config/GEMINI.md" "$HOME/.gemini/config/GEMINI.md"
  deploy_entry "$SCRIPT_DIR/config/mcp_config.json" "$HOME/.gemini/config/mcp_config.json"
  deploy_template "$SCRIPT_DIR/config/config.json" "$HOME/.gemini/config/config.json" "~/.gemini/config/config.json"
  render_settings_json
fi

if [[ "${COMP_SELECTED[skills]}" == true ]]; then
  printf '%b-- [skills]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[skills]}" "$C_RST"
  while IFS= read -r sname; do
    deploy_entry "$SCRIPT_DIR/.agents/skills/$sname" "$HOME/.agents/skills/$sname"
    ensure_skills_discovery_links "$sname"
  done < <(core_skills_list)
fi

if [[ "${COMP_SELECTED[ship]}" == true ]]; then
  printf '%b-- [ship]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[ship]}" "$C_RST"
  deploy_entry "$SCRIPT_DIR/bin/git-wt-sync" "$HOME/.local/bin/git-wt-sync" "true"
  deploy_entry "$SCRIPT_DIR/.agents/skills/ship" "$HOME/.agents/skills/ship"
  ensure_skills_discovery_links "ship"
fi

if [[ "${COMP_SELECTED[margin]}" == true ]]; then
  printf '%b-- [margin]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[margin]}" "$C_RST"
  deploy_entry "$SCRIPT_DIR/config/plugins/margin" "$HOME/.gemini/config/plugins/margin"
fi

if [[ "${COMP_SELECTED[diagnostics]}" == true ]]; then
  printf '%b-- [diagnostics]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[diagnostics]}" "$C_RST"
  mkdir -p "$HOME/.agents/diagnostics"
  deploy_entry "$SCRIPT_DIR/bin/agy-diagnostics" "$HOME/.local/bin/agy-diagnostics" "true"
  deploy_entry "$SCRIPT_DIR/config/plugins/diagnostics" "$HOME/.gemini/config/plugins/diagnostics"
fi

if [[ "${COMP_SELECTED[stats]}" == true ]]; then
  printf '%b-- [stats]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[stats]}" "$C_RST"
  mkdir -p "$HOME/.config/agy-stats"
  deploy_entry "$SCRIPT_DIR/bin/agy-stats" "$HOME/.local/bin/agy-stats" "true"
  deploy_entry "$SCRIPT_DIR/config/plugins/stats" "$HOME/.gemini/config/plugins/stats"
  deploy_entry "$SCRIPT_DIR/.agents/skills/stats" "$HOME/.agents/skills/stats"
  ensure_skills_discovery_links "stats"
  if [[ -f "$SCRIPT_DIR/config-extra/agy-stats/config.json" ]]; then
    deploy_template "$SCRIPT_DIR/config-extra/agy-stats/config.json" "$HOME/.config/agy-stats/config.json" "~/.config/agy-stats/config.json"
  fi
fi

if [[ "${COMP_SELECTED[watchdog]}" == true ]]; then
  printf '%b-- [watchdog]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[watchdog]}" "$C_RST"
  mkdir -p "$HOME/.agents/watchdog"
  deploy_entry "$SCRIPT_DIR/bin/agy-watch" "$HOME/.local/bin/agy-watch" "true"
  deploy_entry "$SCRIPT_DIR/bin/agy-statusline" "$HOME/.local/bin/agy-statusline" "true"
  deploy_entry "$SCRIPT_DIR/config/plugins/watchdog" "$HOME/.gemini/config/plugins/watchdog"
fi

if [[ "${COMP_SELECTED[memory]}" == true ]]; then
  printf '%b-- [memory]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[memory]}" "$C_RST"
  mkdir -p "$HOME/.agents/memories" "$HOME/.agents/compound"
  deploy_entry "$SCRIPT_DIR/bin/agent-memory" "$HOME/.local/bin/agent-memory" "true"
  deploy_entry "$SCRIPT_DIR/bin/agy-compound" "$HOME/.local/bin/agy-compound" "true"
  deploy_entry "$SCRIPT_DIR/config/plugins/memory" "$HOME/.gemini/config/plugins/memory"
fi

if [[ "${COMP_SELECTED[rtk]}" == true ]]; then
  printf '%b-- [rtk]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[rtk]}" "$C_RST"
  mkdir -p "$HOME/.config/rtk"
  deploy_entry "$SCRIPT_DIR/config/plugins/rtk" "$HOME/.gemini/config/plugins/rtk"
  if [[ -f "$SCRIPT_DIR/config-extra/rtk/config.toml" ]]; then
    deploy_template "$SCRIPT_DIR/config-extra/rtk/config.toml" "$HOME/.config/rtk/config.toml" "~/.config/rtk/config.toml"
  fi
  if [[ -f "$SCRIPT_DIR/config-extra/rtk/filters.toml" ]]; then
    deploy_template "$SCRIPT_DIR/config-extra/rtk/filters.toml" "$HOME/.config/rtk/filters.toml" "~/.config/rtk/filters.toml"
  fi

  if [[ "$RTK_STATE" == "COMPATIBLE" ]]; then
    printf '  %b[RTK]%b     Reusing external %s (%s)\n' "$C_GREEN" "$C_RST" "$RTK_PATH" "$RTK_VER"
  elif [[ "$DOWNLOAD_RTK" == "yes" || ( "$DOWNLOAD_RTK" == "auto" && "$INTERACTIVE" != "yes" ) ]]; then
    download_latest_rtk || printf '  %b[NOTICE]%b  RTK hook will run in safety-gate-only mode until rtk-ai/rtk is installed (e.g. brew install rtk-ai/tap/rtk).\n' "$C_YELLOW" "$C_RST"
  else
    printf '  %b[NOTICE]%b  Skipping rtk download; safety-gate-only mode active. Install official rtk-ai/rtk via https://github.com/rtk-ai/rtk (avoid '\''cargo install rtk'\'' — wrong crate).\n' "$C_YELLOW" "$C_RST"
  fi
fi

if [[ "${COMP_SELECTED[playwright]}" == true ]]; then
  printf '%b-- [playwright]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[playwright]}" "$C_RST"
  deploy_entry "$SCRIPT_DIR/config/plugins/playwright" "$HOME/.gemini/config/plugins/playwright"
fi

if [[ "${COMP_SELECTED[desktop-patch]}" == true ]]; then
  printf '%b-- [desktop-patch]%b %b(detected: %s)%b\n' "$C_BOLD" "$C_RST" "$C_CYAN" "${COMP_DETECTED[desktop-patch]}" "$C_RST"
  if [[ "$MODE" == "copy" ]]; then
    deploy_desktop_patch_copy
  else
    deploy_entry "$SCRIPT_DIR/bin/agy-desktop-patch" "$HOME/.local/bin/agy-desktop-patch" "true"
  fi
fi

# 4. Syntax verification of deployed artifacts
printf '%b==> Verifying deployed scripts...%b\n' "$C_CYAN" "$C_RST"
for py_bin in agy-compound agy-diagnostics agy-stats agy-statusline agy-watch agent-memory; do
  if [[ -f "$HOME/.local/bin/$py_bin" ]]; then
    python3 -m py_compile "$HOME/.local/bin/$py_bin" >/dev/null 2>&1 && \
      printf '  %b[PASS]%b    %s syntax OK\n' "$C_GREEN" "$C_RST" "$py_bin" || \
      printf '  %b[WARN]%b    %s syntax warning\n' "$C_YELLOW" "$C_RST" "$py_bin"
  fi
done

if [[ -f "$HOME/.gemini/config/plugins/rtk/scripts/rtk-safe-hook.py" ]]; then
  python3 -m py_compile "$HOME/.gemini/config/plugins/rtk/scripts/rtk-safe-hook.py" >/dev/null 2>&1 && \
    printf '  %b[PASS]%b    rtk-safe-hook.py syntax OK\n' "$C_GREEN" "$C_RST" || \
    printf '  %b[WARN]%b    rtk-safe-hook.py syntax warning\n' "$C_YELLOW" "$C_RST"
fi

if command -v node >/dev/null 2>&1; then
  DP_SCRIPT=""
  if [[ -f "$MANIFEST_DIR/desktop-patch/patch.mjs" ]]; then
    DP_SCRIPT="$MANIFEST_DIR/desktop-patch/patch.mjs"
  elif [[ -f "$HOME/.local/bin/agy-desktop-patch" ]]; then
    DP_SCRIPT="$HOME/.local/bin/agy-desktop-patch"
  fi
  if [[ -n "$DP_SCRIPT" ]]; then
    node --check "$DP_SCRIPT" >/dev/null 2>&1 && \
      printf '  %b[PASS]%b    agy-desktop-patch syntax OK\n' "$C_GREEN" "$C_RST" || \
      printf '  %b[WARN]%b    agy-desktop-patch syntax warning\n' "$C_YELLOW" "$C_RST"
  fi
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) printf '  %b[PASS]%b    ~/.local/bin is in PATH\n' "$C_GREEN" "$C_RST" ;;
  *) printf '  %b[NOTICE]%b  ~/.local/bin is not in PATH (add manually to your shell if desired; installer never edits shell rc files)\n' "$C_YELLOW" "$C_RST" ;;
esac

echo ""
printf '%b==> gravityzilla setup completed (Mode: %s)%b\n' "$C_BGREEN" "$MODE" "$C_RST"
if [[ "$SKIP_COUNT" -gt 0 ]]; then
  printf '    %bPreserved %d existing target(s); re-run with --force to back up and replace.%b\n' "$C_YELLOW" "$SKIP_COUNT" "$C_RST"
fi
