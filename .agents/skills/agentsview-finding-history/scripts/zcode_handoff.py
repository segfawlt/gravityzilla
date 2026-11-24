#!/usr/bin/env python3
"""Deterministic CLI helper for listing and inspecting AgentsView/ZCode sessions."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

AGENTSVIEW_BIN = (
    os.environ.get("AGENTSVIEW_BIN")
    or shutil.which("agentsview")
    or str(Path.home() / ".local" / "bin" / "agentsview")
)
ERROR_MARKERS = (
    "file has not been read yet",
    "error:",
    "fatal:",
    "failed",
    "enoent",
    "permission denied",
    "command failed",
    "exit code",
    "traceback",
    "no such file",
    "is not unique",
    "old_string not found",
)


def run_cmd(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    """Run a subprocess command and capture UTF-8 text output."""
    return subprocess.run(cmd, capture_output=True, text=True)


def _require_agentsview() -> str:
    """Return an executable agentsview path or raise a clear error."""
    if AGENTSVIEW_BIN and (Path(AGENTSVIEW_BIN).is_file() or shutil.which(AGENTSVIEW_BIN)):
        return AGENTSVIEW_BIN
    raise RuntimeError(
        "agentsview binary not found; install agentsview in PATH or set AGENTSVIEW_BIN"
    )


def run_agentsview_json(args: list[str]) -> dict[str, Any]:
    """Invoke agentsview with --json and parse the stdout payload."""
    cmd = [_require_agentsview(), *args, "--json"]
    proc = run_cmd(cmd)
    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise RuntimeError(f"Command failed ({' '.join(cmd)}): {err}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Invalid JSON from {' '.join(cmd)}: {exc}\nRaw: {proc.stdout[:300]}"
        ) from exc


def maybe_sync(enabled: bool) -> None:
    """Refresh the local AgentsView archive when --sync is requested."""
    if not enabled:
        return
    proc = run_cmd([_require_agentsview(), "source", "sync"])
    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip()
        print(f"[warn] agentsview source sync failed: {err}", file=sys.stderr)


def truncate(text: str, limit: int) -> str:
    """Collapse excessive whitespace edges and bound text length."""
    cleaned = text.strip()
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[:limit].rstrip()}… [truncated {len(cleaned) - limit} chars]"


def single_line(text: str, limit: int = 160) -> str:
    """Collapse newlines into spaces and bound length to one line."""
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return f"{compact[:limit].rstrip()}…"


def summarize_tool_target(tool_name: str, raw_input: str) -> str:
    """Extract the primary target or action from a tool call's input JSON."""
    if not raw_input:
        return ""
    try:
        data = json.loads(raw_input)
    except json.JSONDecodeError:
        return single_line(raw_input, 120)

    if not isinstance(data, dict):
        return single_line(str(data), 120)

    if "file_path" in data:
        return str(data["file_path"])
    if "path" in data and "pattern" in data:
        return f"{data['pattern']} in {data['path']}"
    if "path" in data:
        return str(data["path"])
    if "command" in data:
        desc = f" ({data['description']})" if data.get("description") else ""
        return f"`{single_line(str(data['command']), 140)}`{desc}"
    if "pattern" in data:
        return f"pattern={data['pattern']}"
    if "todos" in data and isinstance(data["todos"], list):
        return f"{len(data['todos'])} todo item(s)"
    if "prompt" in data:
        return single_line(str(data["prompt"]), 120)
    if "query" in data:
        return str(data["query"])

    keys = ", ".join(f"{k}={single_line(str(v), 40)}" for k, v in list(data.items())[:3])
    return keys


def summarize_tool_result(tc: dict[str, Any]) -> str:
    """Classify tool output as OK, ERR, or omitted without dumping noise."""
    content = (tc.get("result_content") or "").strip()
    length = int(tc.get("result_content_length") or 0)
    if not content:
        if length > 0:
            return f"OK (output omitted, {length} chars)"
        return "no output"

    lowered = content.lower()
    is_err = any(marker in lowered for marker in ERROR_MARKERS)
    prefix = "ERR" if is_err else "OK"
    return f"{prefix}: {single_line(content, 180)}"


def format_message(msg: dict[str, Any], text_limit: int = 800) -> list[str]:
    """Render one transcript message and its structured tool calls."""
    ordinal = msg.get("ordinal", "?")
    role = str(msg.get("role", "?")).upper()
    ts = msg.get("timestamp", "")
    model = msg.get("model", "")
    header_meta = " ".join(part for part in (ts, model) if part)
    lines = [f"[ord {ordinal}] {role}" + (f" ({header_meta})" if header_meta else "")]

    content = (msg.get("content") or "").strip()
    if content:
        for line in truncate(content, text_limit).splitlines():
            lines.append(f"  {line}")

    for tc in msg.get("tool_calls") or []:
        tname = tc.get("tool_name") or "Tool"
        target = summarize_tool_target(tname, tc.get("input_json") or "")
        outcome = summarize_tool_result(tc)
        target_part = f" {target}" if target else ""
        lines.append(f"  -> {tname}{target_part} | {outcome}")

    return lines


def check_git_state(cwd: str | None) -> list[str]:
    """Inspect real working-tree status and diff stats for session cwd."""
    if not cwd:
        return ["  (no cwd recorded on session)"]
    cwd_path = Path(cwd)
    if not cwd_path.is_dir():
        return [f"  (cwd missing on disk: {cwd})"]

    probe = run_cmd(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"])
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        return [f"  (cwd is not a git repository: {cwd})"]

    lines: list[str] = []
    branch = run_cmd(["git", "-C", cwd, "branch", "--show-current"])
    branch_name = branch.stdout.strip() or "(detached HEAD)"
    head = run_cmd(["git", "-C", cwd, "log", "-1", "--oneline"])
    lines.append(f"  Branch : {branch_name} | HEAD: {head.stdout.strip()}")

    status = run_cmd(["git", "-C", cwd, "status", "--short"])
    status_lines = [ln for ln in status.stdout.splitlines() if ln.strip()]
    if not status_lines:
        lines.append("  Status : clean working tree")
    else:
        lines.append(f"  Status : {len(status_lines)} changed path(s)")
        for ln in status_lines[:25]:
            lines.append(f"    {ln}")
        if len(status_lines) > 25:
            lines.append(f"    ... (+{len(status_lines) - 25} more)")

    diff_stat = run_cmd(["git", "-C", cwd, "diff", "--stat"])
    diff_lines = [ln for ln in diff_stat.stdout.splitlines() if ln.strip()]
    if diff_lines:
        lines.append("  Unstaged diff --stat:")
        for ln in diff_lines[:20]:
            lines.append(f"    {ln}")

    cached_stat = run_cmd(["git", "-C", cwd, "diff", "--cached", "--stat"])
    cached_lines = [ln for ln in cached_stat.stdout.splitlines() if ln.strip()]
    if cached_lines:
        lines.append("  Staged diff --stat:")
        for ln in cached_lines[:20]:
            lines.append(f"    {ln}")

    return lines


def cmd_list(args: argparse.Namespace) -> int:
    """List matching sessions with compact handoff-relevant metadata."""
    maybe_sync(args.sync)
    cli_args = [
        "session",
        "list",
        "--agent",
        args.agent,
        "--limit",
        str(args.limit),
    ]
    if args.project:
        cli_args.extend(["--project", args.project])
    if args.include_one_shot:
        cli_args.append("--include-one-shot")
    if args.include_children:
        cli_args.append("--include-children")

    payload = run_agentsview_json(cli_args)
    sessions = payload.get("sessions") or []
    total = payload.get("total", len(sessions))
    print(f"Found {len(sessions)} session(s) shown (total matching: {total}, agent={args.agent})")
    for s in sessions:
        sid = s.get("id", "?")
        proj = s.get("project") or "-"
        outcome = s.get("outcome") or "-"
        ended_role = s.get("ended_with_role") or "-"
        msgs = s.get("message_count", 0)
        ended_at = s.get("ended_at") or "-"
        cwd = s.get("cwd") or "-"
        title = single_line(s.get("display_name") or s.get("first_message") or "", 90)
        print(
            f"- {sid}\n"
            f"  project={proj} | outcome={outcome} (ended_with={ended_role}) | "
            f"msgs={msgs} | ended={ended_at}\n"
            f"  cwd={cwd}\n"
            f"  prompt={title}"
        )
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    """Inspect session metadata, initial prompt, tail transcript, and live git state."""
    maybe_sync(args.sync)
    meta = run_agentsview_json(["session", "get", args.session_id])
    head = run_agentsview_json(
        [
            "session",
            "messages",
            args.session_id,
            "--from",
            "0",
            "--limit",
            "4",
            "--role",
            "user,assistant",
        ]
    )
    tail = run_agentsview_json(
        [
            "session",
            "messages",
            args.session_id,
            "--direction",
            "desc",
            "--limit",
            str(args.tail),
            "--role",
            "user,assistant",
        ]
    )

    print("=== Session Metadata ===")
    print(f"ID        : {meta.get('id', args.session_id)}")
    print(f"Project   : {meta.get('project') or '-'} | Agent: {meta.get('agent') or '-'}")
    print(f"CWD       : {meta.get('cwd') or '-'}")
    print(f"Window    : {meta.get('started_at') or '-'} -> {meta.get('ended_at') or '-'}")
    print(
        f"Messages  : {meta.get('message_count', 0)} total "
        f"({meta.get('user_message_count', 0)} user)"
    )
    print(
        f"Outcome   : {meta.get('outcome') or '-'} "
        f"(confidence={meta.get('outcome_confidence') or '-'}, "
        f"ended_with={meta.get('ended_with_role') or '-'})"
    )
    if meta.get("web_url"):
        print(f"Web URL   : {meta['web_url']}")

    head_msgs = head.get("messages") or []
    initial_ords: set[int] = set()
    print("\n=== Initial Prompt(s) ===")
    shown_initial = False
    for m in head_msgs:
        content = (m.get("content") or "").strip()
        if m.get("role") == "user" and not content.startswith("# Environment\n"):
            initial_ords.add(m.get("ordinal", -1))
            print("\n".join(format_message(m, text_limit=1200)))
            shown_initial = True
            break
    if not shown_initial and head_msgs:
        initial_ords.add(head_msgs[0].get("ordinal", -1))
        print("\n".join(format_message(head_msgs[0], text_limit=1200)))

    tail_msgs = list(reversed(tail.get("messages") or []))
    print(f"\n=== Tail Messages (last {len(tail_msgs)}) ===")
    for m in tail_msgs:
        if m.get("ordinal") in initial_ords and len(tail_msgs) > 1:
            continue
        print("\n".join(format_message(m, text_limit=800)))

    print("\n=== Live Disk & Git State ===")
    for line in check_git_state(meta.get("cwd")):
        print(line)

    return 0


def build_parser() -> argparse.ArgumentParser:
    """Construct CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="Inspect AgentsView / ZCode sessions and verify repo state."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List recent sessions")
    p_list.add_argument("--project", help="Filter by project name")
    p_list.add_argument("--agent", default="zcode", help="Agent filter (default: zcode)")
    p_list.add_argument("--limit", type=int, default=10, help="Max sessions (default: 10)")
    p_list.add_argument("--sync", action="store_true", help="Run agentsview source sync first")
    p_list.add_argument("--include-one-shot", action="store_true", help="Include one-shot runs")
    p_list.add_argument("--include-children", action="store_true", help="Include subagent runs")

    p_inspect = sub.add_parser("inspect", help="Inspect one session and its live git cwd")
    p_inspect.add_argument("session_id", help="Session ID (e.g. zcode:sess_...)")
    p_inspect.add_argument("--tail", type=int, default=15, help="Tail messages count (default: 15)")
    p_inspect.add_argument("--sync", action="store_true", help="Run agentsview source sync first")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "list":
            return cmd_list(args)
        if args.command == "inspect":
            return cmd_inspect(args)
        parser.error(f"Unknown command: {args.command}")
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
