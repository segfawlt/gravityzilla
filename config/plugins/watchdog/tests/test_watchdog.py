#!/usr/bin/env python3
"""
Integration & unit test suite for `agy-watch` and `agy-statusline` watchdog segment.

Drives the real `~/.local/bin/agy-watch` and `~/.local/bin/agy-statusline`
executables inside isolated `AGY_WATCHDOG_HOME` and `AGY_CLI_DATA_DIR` temp
directories without mutating live `~/.agents/` or `~/.gemini/` state.
"""

from __future__ import annotations

import fcntl
import importlib.machinery
import importlib.util
import json
import os
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any

WATCH_BIN = Path(os.environ.get("AGY_WATCH_BIN") or "/home/domixi/.local/bin/agy-watch")
STATUSLINE_BIN = Path(os.environ.get("AGY_STATUSLINE_BIN") or "/home/domixi/.local/bin/agy-statusline")


class WatchdogTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_obj = tempfile.TemporaryDirectory(prefix="agy_watch_test_")
        self.tmp = Path(self.tmp_obj.name)
        self.wd_home = self.tmp / "watchdog"
        self.cli_dir = self.tmp / "cli_data"
        self.wd_home.mkdir(parents=True, exist_ok=True)
        (self.cli_dir / "conversations").mkdir(parents=True, exist_ok=True)
        (self.cli_dir / "presence").mkdir(parents=True, exist_ok=True)

        self.env = os.environ.copy()
        self.env.pop("AGY_HOOK_INTERNAL", None)
        self.env["AGY_WATCHDOG_HOME"] = str(self.wd_home)
        self.env["AGY_CLI_DATA_DIR"] = str(self.cli_dir)
        self.env["AGY_WATCHDOG_POLL_S"] = "0.1"
        self.env["AGY_WATCHDOG_IDLE_TICKS"] = "2"

        # Pre-hold watcher.lock for hook unit tests so daemon-loop isn't spawned
        # into temp directories that tearDown deletes immediately.
        self._lock_fh = (self.wd_home / "watcher.lock").open("a+", encoding="utf-8")
        fcntl.flock(self._lock_fh.fileno(), fcntl.LOCK_EX)

    def tearDown(self) -> None:
        if self._lock_fh is not None:
            try:
                fcntl.flock(self._lock_fh.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                self._lock_fh.close()
            except Exception:
                pass
        self.tmp_obj.cleanup()

    def _release_watcher_lock(self) -> None:
        if self._lock_fh is not None:
            fcntl.flock(self._lock_fh.fileno(), fcntl.LOCK_UN)
            self._lock_fh.close()
            self._lock_fh = None

    def _run_watch(
        self,
        subcmd: str,
        payload: dict[str, Any] | None = None,
        extra_env: dict[str, str] | None = None,
        extra_args: list[str] | None = None,
    ) -> tuple[int, str, float]:
        env = self.env.copy()
        if extra_env:
            env.update(extra_env)
        stdin_str = json.dumps(payload) if payload is not None else None
        cmd = [str(WATCH_BIN), subcmd, *(extra_args or [])]
        t0 = time.monotonic()
        proc = subprocess.run(
            cmd,
            input=stdin_str,
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        elapsed = time.monotonic() - t0
        return proc.returncode, proc.stdout.strip(), elapsed

    def _create_conv_db(self, cid: str, rows: list[tuple[int, int, int]]) -> Path:
        db_path = self.cli_dir / "conversations" / f"{cid}.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0)"
        )
        conn.execute("CREATE INDEX idx_steps_status ON steps(status)")
        conn.executemany("INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)", rows)
        conn.commit()
        conn.close()
        return db_path

    def _setup_bg_transcript(
        self,
        cid: str,
        step_idx: int,
        task_desc: str,
        tool_name: str = "run_command",
        is_daemon: bool = False,
        log_text: str = "",
    ) -> Path:
        brain_logs = self.cli_dir / "brain" / cid / ".system_generated" / "logs"
        tasks_dir = self.cli_dir / "brain" / cid / ".system_generated" / "tasks"
        brain_logs.mkdir(parents=True, exist_ok=True)
        tasks_dir.mkdir(parents=True, exist_ok=True)

        planner = {
            "step_index": step_idx - 1,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "tool_calls": [
                {
                    "name": tool_name,
                    "args": {"CommandLine": task_desc, "IsDaemon": is_daemon} if tool_name == "run_command" else {},
                }
            ],
        }
        running = {
            "step_index": step_idx,
            "source": "MODEL",
            "type": "GENERIC",
            "status": "RUNNING",
            "content": (
                f"Created At: 2026-11-15T04:00:00+07:00\n"
                f"Tool is running as a background task with task id: {cid}/task-{step_idx}\n"
                f"Task Description: {task_desc}\n"
            ),
        }
        tpath = brain_logs / "transcript_full.jsonl"
        tpath.write_text(json.dumps(planner) + "\n" + json.dumps(running) + "\n", encoding="utf-8")

        log_path = tasks_dir / f"task-{step_idx}.log"
        log_path.write_text(log_text, encoding="utf-8")
        return log_path

    def test_1_monotonic_timing_and_internal_bypass(self) -> None:
        cid = "cid-timing-0001"
        rc, out, _ = self._run_watch(
            "pre-invocation-hook",
            {"conversationId": cid, "lastUserInput": "Run timing test", "cwd": str(self.tmp)},
        )
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {})

        rc, out, _ = self._run_watch(
            "pre-tool-hook",
            {
                "conversationId": cid,
                "stepIdx": 2,
                "cwd": str(self.tmp),
                "toolCall": {"id": "t1", "name": "run_command", "args": {"CommandLine": "ls -la"}},
            },
        )
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["decision"], "allow")

        time.sleep(0.06)

        rc, out, _ = self._run_watch(
            "post-tool-hook",
            {
                "conversationId": cid,
                "stepIdx": 2,
                "cwd": str(self.tmp),
                "toolCall": {"id": "t1", "name": "run_command", "args": {"CommandLine": "rtk ls -la"}},
            },
        )
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {})

        events = [
            json.loads(line)
            for line in (self.wd_home / "events.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        names = [e["event"] for e in events]
        self.assertEqual(names, ["model_start", "model_done", "tool_start", "tool_done"])
        tool_done = events[-1]
        self.assertEqual(tool_done["tool_id"], "t1")
        self.assertEqual(tool_done["status"], "ok")
        self.assertGreaterEqual(tool_done["duration_ms"], 45)

        # AGY_HOOK_INTERNAL=1 must bypass immediately without modifying state
        rc, out, _ = self._run_watch(
            "pre-tool-hook",
            {"conversationId": cid, "toolCall": {"id": "tint", "name": "run_command", "args": {"CommandLine": "pwd"}}},
            extra_env={"AGY_HOOK_INTERNAL": "1"},
        )
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["decision"], "allow")

    def test_2_identical_call_loop_gate_and_exemptions(self) -> None:
        cid = "cid-loop-0002"
        self._run_watch("pre-invocation-hook", {"conversationId": cid, "lastUserInput": "Check loop gate"})

        # 3 identical read-only commands (including rtk prefix variants) -> 3rd denied
        cmds = [
            ("ls -la", 1000, "List A"),
            ("rtk ls -la", 5000, "List B"),
            ("rtk bypass ls -la", 2000, "List C"),
        ]
        decisions = []
        for idx, (cmd, wait_ms, summary) in enumerate(cmds, 1):
            rc, out, _ = self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid,
                    "stepIdx": idx * 2,
                    "cwd": str(self.tmp),
                    "toolCall": {
                        "id": f"call-{idx}",
                        "name": "run_command",
                        "args": {"CommandLine": cmd, "WaitMsBeforeAsync": wait_ms, "toolSummary": summary},
                    },
                },
            )
            self.assertEqual(rc, 0)
            resp = json.loads(out)
            decisions.append(resp)
            if resp["decision"] == "allow":
                self._run_watch(
                    "post-tool-hook",
                    {
                        "conversationId": cid,
                        "stepIdx": idx * 2,
                        "cwd": str(self.tmp),
                        "toolCall": {"id": f"call-{idx}", "name": "run_command", "args": {"CommandLine": cmd}},
                    },
                )

        self.assertEqual(decisions[0]["decision"], "allow")
        self.assertEqual(decisions[1]["decision"], "allow")
        self.assertEqual(decisions[2]["decision"], "deny")
        self.assertIn("[Watchdog]", decisions[2]["reason"])

        # Advancing StartLine in read_file must NOT be blocked
        for idx, start_line in enumerate((1, 101, 201), 1):
            rc, out, _ = self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid,
                    "stepIdx": 20 + idx,
                    "cwd": str(self.tmp),
                    "toolCall": {
                        "id": f"rf-{idx}",
                        "name": "read_file",
                        "args": {"Path": "/tmp/big.py", "StartLine": start_line, "EndLine": start_line + 99},
                    },
                },
            )
            self.assertEqual(rc, 0)
            self.assertEqual(json.loads(out)["decision"], "allow")

        # manage_task status polling is exempt
        for idx in range(3):
            rc, out, _ = self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid,
                    "stepIdx": 30 + idx,
                    "toolCall": {"id": f"mt-{idx}", "name": "manage_task", "args": {"Action": "status", "TaskId": "x"}},
                },
            )
            self.assertEqual(rc, 0)
            self.assertEqual(json.loads(out)["decision"], "allow")

        # Non-mutating test runner commands (not in READONLY_CMD_VERBS) must ALSO trip 3x loop block,
        # while an intervening mutating command (`mkdir -p`) advances mutation_seq and resets the streak.
        cid_test = "cid-loop-testcmd"
        self._run_watch("pre-invocation-hook", {"conversationId": cid_test, "lastUserInput": "Run pytest"})
        test_cmd = "pytest -q tests/test_sample.py"
        pytest_decisions = []
        for idx in range(1, 4):
            rc, out, _ = self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid_test,
                    "stepIdx": idx * 2,
                    "cwd": str(self.tmp),
                    "toolCall": {"id": f"py-{idx}", "name": "run_command", "args": {"CommandLine": test_cmd}},
                },
            )
            self.assertEqual(rc, 0)
            resp = json.loads(out)
            pytest_decisions.append(resp["decision"])
            if resp["decision"] == "allow":
                self._run_watch(
                    "post-tool-hook",
                    {
                        "conversationId": cid_test,
                        "stepIdx": idx * 2,
                        "cwd": str(self.tmp),
                        "toolCall": {"id": f"py-{idx}", "name": "run_command", "args": {"CommandLine": test_cmd}},
                    },
                )
        self.assertEqual(pytest_decisions, ["allow", "allow", "deny"])

        # Intervening mutating shell command advances mutation_seq
        self._run_watch(
            "pre-tool-hook",
            {
                "conversationId": cid_test,
                "stepIdx": 10,
                "cwd": str(self.tmp),
                "toolCall": {"id": "mk-1", "name": "run_command", "args": {"CommandLine": "mkdir -p build"}},
            },
        )
        self._run_watch(
            "post-tool-hook",
            {
                "conversationId": cid_test,
                "stepIdx": 10,
                "cwd": str(self.tmp),
                "toolCall": {"id": "mk-1", "name": "run_command", "args": {"CommandLine": "mkdir -p build"}},
            },
        )
        rc, out, _ = self._run_watch(
            "pre-tool-hook",
            {
                "conversationId": cid_test,
                "stepIdx": 12,
                "cwd": str(self.tmp),
                "toolCall": {"id": "py-4", "name": "run_command", "args": {"CommandLine": test_cmd}},
            },
        )
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["decision"], "allow")

    def test_3_error_thrash_and_abab_hash_flip(self) -> None:
        cid = "cid-thrash-0003"
        self._run_watch("pre-invocation-hook", {"conversationId": cid, "lastUserInput": "Fix broken build"})

        # 3 consecutive errors with varying line numbers/timestamps
        for idx, err_msg in enumerate(
            [
                "exit status 1 at 2026-11-15T04:00:01Z line 12 (id 0x1a2b)",
                "exit status 1 at 2026-11-15T04:00:02Z line 45 (id 0x9c8d)",
                "exit status 1 at 2026-11-15T04:00:03Z line 99 (id 0xbeef)",
            ],
            1,
        ):
            self._run_watch(
                "pre-tool-hook",
                {"conversationId": cid, "stepIdx": idx, "toolCall": {"id": f"e-{idx}", "name": "run_command", "args": {"CommandLine": f"cmd{idx}"}}},
            )
            self._run_watch(
                "post-tool-hook",
                {
                    "conversationId": cid,
                    "stepIdx": idx,
                    "error": err_msg,
                    "toolCall": {"id": f"e-{idx}", "name": "run_command", "args": {"CommandLine": f"cmd{idx}"}},
                },
            )

        rc, out, _ = self._run_watch("pre-invocation-hook", {"conversationId": cid, "lastUserInput": "Fix broken build"})
        self.assertEqual(rc, 0)
        parsed = json.loads(out)
        self.assertIn("injectSteps", parsed)
        sys_msg = parsed["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertIn("Thrash Circuit-Breaker", sys_msg)

        # ABAB_HASH_FLIP detection on edit_file
        target_file = self.tmp / "sample.py"
        for idx, content in enumerate(("x = 1\n", "x = 2\n", "x = 1\n"), 1):
            target_file.write_text(content, encoding="utf-8")
            self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid,
                    "stepIdx": 50 + idx,
                    "cwd": str(self.tmp),
                    "toolCall": {"id": f"ed-{idx}", "name": "edit_file", "args": {"Path": str(target_file)}},
                },
            )
            self._run_watch(
                "post-tool-hook",
                {
                    "conversationId": cid,
                    "stepIdx": 50 + idx,
                    "cwd": str(self.tmp),
                    "toolCall": {"id": f"ed-{idx}", "name": "edit_file", "args": {"Path": str(target_file)}},
                },
            )

        rc, out, _ = self._run_watch("pre-invocation-hook", {"conversationId": cid, "lastUserInput": "Fix broken build"})
        self.assertEqual(rc, 0)
        parsed = json.loads(out)
        self.assertIn("injectSteps", parsed)
        self.assertIn("ABAB_HASH_FLIP", parsed["injectSteps"][0]["systemMessage"]["systemMessage"])

        # Sub-check: run_command non-zero exits via transcript.jsonl when PostToolUse receives error=""
        cid_sh = "cid-thrash-shell"
        logs_dir = self.cli_dir / "brain" / cid_sh / ".system_generated" / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        tpath = logs_dir / "transcript.jsonl"
        self._run_watch(
            "pre-invocation-hook",
            {"conversationId": cid_sh, "lastUserInput": "Fix pytest fail", "transcriptPath": str(tpath)},
        )
        for idx, line_num in enumerate((10, 20, 30), 1):
            step_idx = idx * 2
            self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid_sh,
                    "stepIdx": step_idx,
                    "toolCall": {"id": f"sh-{idx}", "name": "run_command", "args": {"CommandLine": f"sh -c test_{idx}"}},
                },
            )
            with tpath.open("a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(
                        {
                            "step_index": step_idx,
                            "type": "GENERIC",
                            "status": "DONE",
                            "content": f"Command exited with code 1.\n\nCommand output:\nAssertionError: line {line_num}\n",
                        }
                    )
                    + "\n"
                )
            self._run_watch(
                "post-tool-hook",
                {
                    "conversationId": cid_sh,
                    "stepIdx": step_idx,
                    "error": "",
                    "toolCall": {"id": f"sh-{idx}", "name": "run_command", "args": {"CommandLine": f"sh -c test_{idx}"}},
                },
            )

        rc, out, _ = self._run_watch(
            "pre-invocation-hook",
            {"conversationId": cid_sh, "lastUserInput": "Fix pytest fail", "transcriptPath": str(tpath)},
        )
        self.assertEqual(rc, 0)
        parsed_sh = json.loads(out)
        self.assertIn("injectSteps", parsed_sh)
        self.assertIn("Thrash Circuit-Breaker", parsed_sh["injectSteps"][0]["systemMessage"]["systemMessage"])

    def test_4_stop_hook_stdin_bounce_active_progress_and_timer_exempt(self) -> None:
        (self.wd_home / "state.json").write_text(
            json.dumps({"enabled": True, "stdin_prompt_s": 1, "stop_idle_bounce_s": 3}),
            encoding="utf-8",
        )

        # 4a: Hung stdin prompt bounces once, second call stops immediately
        cid = "cid-stop-0004"
        self._create_conv_db(cid, [(9, 15, 3), (10, 132, 2)])
        self._setup_bg_transcript(cid, 10, "deploy.sh", log_text="Uploading...\nOverwrite existing config? [y/N] ")

        rc, out, elapsed = self._run_watch(
            "stop-hook",
            {"conversationId": cid, "terminationReason": "NO_TOOL_CALL", "fullyIdle": False, "continuationActive": False},
        )
        self.assertEqual(rc, 0)
        self.assertLess(elapsed, 2.5)
        resp = json.loads(out)
        self.assertEqual(resp["decision"], "continue")
        self.assertIn("manage_task", resp["reason"])

        # Second call for same task must NOT bounce again
        rc, out, elapsed2 = self._run_watch(
            "stop-hook",
            {"conversationId": cid, "terminationReason": "NO_TOOL_CALL", "fullyIdle": False, "continuationActive": False},
        )
        self.assertEqual(rc, 0)
        self.assertLess(elapsed2, 0.5)
        self.assertEqual(json.loads(out)["decision"], "stop")

        # 4b: Timer: schedule must return stop immediately
        cid_timer = "cid-timer-0004"
        self._create_conv_db(cid_timer, [(19, 15, 3), (20, 132, 2)])
        self._setup_bg_transcript(cid_timer, 20, "Timer: 5m, Prompt: check subagent", tool_name="schedule")
        rc, out, elapsed_t = self._run_watch(
            "stop-hook",
            {"conversationId": cid_timer, "terminationReason": "NO_TOOL_CALL", "fullyIdle": False, "continuationActive": False},
        )
        self.assertEqual(rc, 0)
        self.assertLess(elapsed_t, 0.5)
        self.assertEqual(json.loads(out)["decision"], "stop")

        # 4c: Active log growth fast-exits stop-hook with stop
        cid_prog = "cid-prog-0004"
        self._create_conv_db(cid_prog, [(9, 15, 3), (10, 132, 2)])
        log_path = self._setup_bg_transcript(cid_prog, 10, "cargo build", log_text="Compiling crate a...\n")

        def _append_later() -> None:
            time.sleep(0.35)
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write("Compiling crate b...\n")

        t = threading.Thread(target=_append_later, daemon=True)
        t.start()
        rc, out, elapsed_p = self._run_watch(
            "stop-hook",
            {"conversationId": cid_prog, "terminationReason": "NO_TOOL_CALL", "fullyIdle": False, "continuationActive": False},
        )
        t.join(timeout=2)
        self.assertEqual(rc, 0)
        self.assertLess(elapsed_p, 2.0)
        self.assertEqual(json.loads(out)["decision"], "stop")

    def test_5_daemon_loop_waiting_exempt_and_orphan_presence_cleanup(self) -> None:
        self._release_watcher_lock()

        # 5a: WAITING (status=9) must NOT emit stall alerts while presence lock is held
        cid_wait = "cid-wait-0005"
        self._create_conv_db(cid_wait, [(4, 15, 3), (5, 132, 9)])
        (self.wd_home / "state.json").write_text(
            json.dumps({"enabled": True, "tool_warn_s": 0.1}),
            encoding="utf-8",
        )
        sess_dir = self.wd_home / "sessions"
        sess_dir.mkdir(parents=True, exist_ok=True)
        (sess_dir / f"{cid_wait}.json").write_text(
            json.dumps(
                {
                    "cid": cid_wait,
                    "phase": "tool",
                    "inflight_tools": {
                        "w1": {
                            "started_mono_ns": 1,
                            "started_epoch": time.time() - 200,
                            "step_idx": 5,
                            "name": "run_command",
                        }
                    },
                    "last_alert": None,
                }
            ),
            encoding="utf-8",
        )
        plock = self.cli_dir / "presence" / f"{cid_wait}.lock"
        with plock.open("w+", encoding="utf-8") as pfh:
            fcntl.flock(pfh.fileno(), fcntl.LOCK_EX)
            proc = subprocess.run(
                [str(WATCH_BIN), "daemon-loop"],
                capture_output=True,
                text=True,
                env=self.env,
                timeout=5,
            )
            fcntl.flock(pfh.fileno(), fcntl.LOCK_UN)

        self.assertEqual(proc.returncode, 0)
        wait_sess = json.loads((sess_dir / f"{cid_wait}.json").read_text(encoding="utf-8"))
        self.assertIsNone(wait_sess.get("last_alert"))

        # 5b: Unlocked presence/<cid>.lock transitions open session to idle and daemon exits 0
        cid_orphan = "cid-orphan-0005"
        (self.cli_dir / "presence" / f"{cid_orphan}.lock").write_text("", encoding="utf-8")
        (sess_dir / f"{cid_orphan}.json").write_text(
            json.dumps(
                {
                    "cid": cid_orphan,
                    "phase": "tool",
                    "inflight_tools": {"t1": {"started_mono_ns": 1, "started_epoch": time.time(), "name": "run_command"}},
                }
            ),
            encoding="utf-8",
        )
        proc2 = subprocess.run(
            [str(WATCH_BIN), "daemon-loop"],
            capture_output=True,
            text=True,
            env=self.env,
            timeout=5,
        )
        self.assertEqual(proc2.returncode, 0)
        orphan_sess = json.loads((sess_dir / f"{cid_orphan}.json").read_text(encoding="utf-8"))
        self.assertEqual(orphan_sess["phase"], "idle")
        self.assertEqual(orphan_sess["inflight_tools"], {})

        events = [
            json.loads(line)
            for line in (self.wd_home / "events.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertTrue(any(e["cid"] == cid_orphan and e["event"] == "session_closed" for e in events))

    def test_6_statusline_renders_healthy_and_stall_fast(self) -> None:
        cid = "cid-hud-0006"
        (self.wd_home / "state.json").write_text(json.dumps({"enabled": True}), encoding="utf-8")

        # Healthy state
        t0 = time.monotonic()
        p_ok = subprocess.run(
            [str(STATUSLINE_BIN)],
            input=json.dumps({"conversationId": cid, "cwd": "/tmp"}),
            capture_output=True,
            text=True,
            env=self.env,
            timeout=2,
        )
        dt_ms = (time.monotonic() - t0) * 1000
        self.assertEqual(p_ok.returncode, 0)
        self.assertIn("watch: ✓", p_ok.stdout)
        self.assertLess(dt_ms, 200)

        # Stall alert state
        sess_dir = self.wd_home / "sessions"
        sess_dir.mkdir(parents=True, exist_ok=True)
        (sess_dir / f"{cid}.json").write_text(
            json.dumps({"cid": cid, "last_alert": {"kind": "stall", "detail": "task-10 65s", "ts": time.time()}}),
            encoding="utf-8",
        )
        p_stall = subprocess.run(
            [str(STATUSLINE_BIN)],
            input=json.dumps({"conversationId": cid, "cwd": "/tmp"}),
            capture_output=True,
            text=True,
            env=self.env,
            timeout=2,
        )
        self.assertEqual(p_stall.returncode, 0)
        self.assertIn("watch: ⚠ task-10 65s", p_stall.stdout)

    def test_7_proc_stat_child_detection_and_surgical_kill(self) -> None:
        loader = importlib.machinery.SourceFileLoader("agy_watch_mod", str(WATCH_BIN))
        spec = importlib.util.spec_from_loader("agy_watch_mod", loader)
        self.assertIsNotNone(spec)
        mod = importlib.util.module_from_spec(spec)
        assert spec is not None and spec.loader is not None
        spec.loader.exec_module(mod)

        for new_session in (True, False):
            with self.subTest(start_new_session=new_session):
                proc = subprocess.Popen(
                    ["bash", "-c", "sleep 30; true"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=new_session,
                )
                try:
                    match: tuple[int, int, str] | None = None
                    deadline = time.monotonic() + 2.0
                    while time.monotonic() < deadline:
                        _ticks, shells = mod.sample_agy_child_shells(os.getpid())
                        for cpid, cpgrp, ccomm in shells:
                            if cpid == proc.pid:
                                if new_session or mod._collect_descendants(cpid, os.getpid()):
                                    match = (cpid, cpgrp, ccomm)
                                    break
                        if match is not None:
                            break
                        time.sleep(0.05)

                    self.assertIsNotNone(match, f"Expected child bash {proc.pid} in sample_agy_child_shells")
                    assert match is not None
                    child_pid, child_pgrp, child_comm = match
                    self.assertEqual(child_pid, proc.pid)
                    self.assertEqual(child_comm, "bash")
                    if new_session:
                        self.assertEqual(child_pgrp, proc.pid)
                    else:
                        self.assertEqual(child_pgrp, os.getpgrp())

                    killed = mod.kill_child_shell_safely(os.getpid(), child_pid, child_pgrp)
                    self.assertTrue(killed)
                    rc = proc.wait(timeout=3)
                    self.assertNotEqual(rc, 0)
                    # Note: if start_new_session=False triggered kill of parent bash, rc is -SIGTERM;
                    # verify parent test runner itself is still alive and child exited.
                    self.assertIn(rc, (-signal.SIGTERM, 143))
                finally:
                    if proc.poll() is None:
                        if new_session:
                            try:
                                os.killpg(proc.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                        else:
                            proc.kill()
                        proc.wait(timeout=2)

        # Sub-test: GNU bash -c single-command optimization execs `sleep` directly (comm != "bash")
        with self.subTest(bash_exec_single_cmd=True):
            proc = subprocess.Popen(
                ["bash", "-c", "sleep 30"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            try:
                match = None
                deadline = time.monotonic() + 2.0
                while time.monotonic() < deadline:
                    _ticks, shells = mod.sample_agy_child_shells(os.getpid())
                    for cpid, cpgrp, ccomm in shells:
                        if cpid == proc.pid and ccomm == "sleep":
                            match = (cpid, cpgrp, ccomm)
                            break
                    if match is not None:
                        break
                    time.sleep(0.05)

                self.assertIsNotNone(match, f"Expected exec'd sleep {proc.pid} in sample_agy_child_shells")
                assert match is not None
                child_pid, child_pgrp, child_comm = match
                self.assertEqual(child_comm, "sleep")
                self.assertEqual(child_pgrp, proc.pid)
                self.assertTrue(mod.kill_child_shell_safely(os.getpid(), child_pid, child_pgrp))
                rc = proc.wait(timeout=3)
                self.assertIn(rc, (-signal.SIGTERM, 143))
            finally:
                if proc.poll() is None:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=2)

    def test_8_ps_snapshot_and_stream_handles(self) -> None:
        import selectors

        cid_main = "cid-main-0008"
        cid_sub = "cid-sub-0008"
        plock = self.cli_dir / "presence" / f"{cid_main}.lock"

        with plock.open("w+", encoding="utf-8") as pfh:
            fcntl.flock(pfh.fileno(), fcntl.LOCK_EX)

            # 1. Start main turn with cwd, modelName, and tagged prompt
            self._run_watch(
                "pre-invocation-hook",
                {
                    "conversationId": cid_main,
                    "cwd": "/tmp/gravity-demo",
                    "modelName": "gemini-pro",
                    "lastUserInput": "<ADDITIONAL_METADATA>\ntime: now\n</ADDITIONAL_METADATA>\n<USER_REQUEST>\nBuild stream handle\n</USER_REQUEST>",
                },
            )
            self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid_main,
                    "stepIdx": 2,
                    "cwd": "/tmp/gravity-demo",
                    "toolCall": {
                        "id": "call-env",
                        "name": "run_command",
                        "args": {"CommandLine": "API_KEY=secret123 pytest -q", "toolSummary": "Run unit suite"},
                    },
                },
            )
            self._run_watch(
                "post-tool-hook",
                {
                    "conversationId": cid_main,
                    "stepIdx": 2,
                    "cwd": "/tmp/gravity-demo",
                    "toolCall": {
                        "id": "call-env",
                        "name": "run_command",
                        "args": {"CommandLine": "API_KEY=secret123 pytest -q", "toolSummary": "Run unit suite"},
                    },
                },
            )

            # Assert inline env secret was redacted in events.jsonl and session last_step
            ev_text = (self.wd_home / "events.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("secret123", ev_text)
            self.assertIn("API_KEY=***", ev_text)
            main_sess = json.loads((self.wd_home / "sessions" / f"{cid_main}.json").read_text(encoding="utf-8"))
            self.assertIn("API_KEY=***", (main_sess.get("last_step") or {}).get("target", ""))
            self.assertNotIn("secret123", json.dumps(main_sess))

            # 2. Simulate invoke_subagent parent->child linking and child active tool
            logs_dir = self.cli_dir / "brain" / cid_main / ".system_generated" / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            tpath = logs_dir / "transcript.jsonl"
            tpath.write_text(
                json.dumps(
                    {
                        "step_index": 5,
                        "type": "GENERIC",
                        "status": "DONE",
                        "content": 'Created the following subagent:\n{"conversationId": "cid-sub-0008"}',
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid_main,
                    "stepIdx": 5,
                    "cwd": "/tmp/gravity-demo",
                    "toolCall": {
                        "id": "call-sub",
                        "name": "invoke_subagent",
                        "args": {"Role": "Log Worker", "TypeName": "self"},
                    },
                },
            )
            self._run_watch(
                "post-tool-hook",
                {
                    "conversationId": cid_main,
                    "stepIdx": 5,
                    "cwd": "/tmp/gravity-demo",
                    "transcriptPath": str(tpath),
                    "toolCall": {
                        "id": "call-sub",
                        "name": "invoke_subagent",
                        "args": {"Role": "Log Worker", "TypeName": "self"},
                    },
                },
            )
            self._run_watch(
                "pre-invocation-hook",
                {"conversationId": cid_sub, "cwd": "/tmp/gravity-demo", "lastUserInput": "Subtask"},
            )
            self._run_watch(
                "pre-tool-hook",
                {
                    "conversationId": cid_sub,
                    "stepIdx": 2,
                    "cwd": "/tmp/gravity-demo",
                    "toolCall": {
                        "id": "sub-ed",
                        "name": "edit_file",
                        "args": {"Path": "/tmp/gravity-demo/src/app.py"},
                    },
                },
            )

            # 3. Verify `agy-watch ps --json` structure and hierarchy
            rc, ps_json_out, _ = self._run_watch("ps", extra_args=["--json"])
            self.assertEqual(rc, 0)
            ps_data = json.loads(ps_json_out)
            sessions = ps_data["sessions"]
            by_cid = {s["cid"]: s for s in sessions}
            self.assertIn(cid_main, by_cid)
            self.assertIn(cid_sub, by_cid)
            self.assertEqual(by_cid[cid_main]["kind"], "main")
            self.assertTrue(by_cid[cid_main]["live"])
            self.assertEqual(by_cid[cid_main]["project"], "gravity-demo")
            self.assertEqual(by_cid[cid_main]["prompt_preview"], "Build stream handle")
            self.assertEqual(by_cid[cid_sub]["kind"], "subagent")
            self.assertEqual(by_cid[cid_sub]["parent_cid"], cid_main)
            self.assertEqual(by_cid[cid_sub]["role"], "Log Worker")
            self.assertEqual(by_cid[cid_sub]["state"], "tool")
            self.assertEqual(by_cid[cid_sub]["inflight"][0]["target"], "src/app.py")

            # 4. Verify WAITING APPROVAL state from SQLite status=9
            db_path = self._create_conv_db(cid_main, [(6, 15, 3), (7, 132, 9)])
            rc, ps_wait_json, _ = self._run_watch("ps", extra_args=["--json"])
            self.assertEqual(rc, 0)
            wait_map = {s["cid"]: s for s in json.loads(ps_wait_json)["sessions"]}
            self.assertEqual(wait_map[cid_main]["state"], "waiting_approval")

            rc, ps_human, _ = self._run_watch("ps")
            self.assertEqual(rc, 0)
            self.assertIn("WAITING APPROVAL", ps_human)
            self.assertIn("gravity-demo", ps_human)
            self.assertIn("Log Worker", ps_human)

            # 5. Verify `agy-watch stream --no-follow` (human + NDJSON)
            rc, st_human, _ = self._run_watch("stream", extra_args=["--no-follow", "-n", "20"])
            self.assertEqual(rc, 0)
            self.assertIn("gravity-demo", st_human)
            self.assertIn("src/app.py", st_human)

            rc, st_ndjson, _ = self._run_watch("stream", extra_args=["--no-follow", "--json", "-n", "20"])
            self.assertEqual(rc, 0)
            parsed_lines = [json.loads(ln) for ln in st_ndjson.splitlines() if ln.strip()]
            self.assertGreaterEqual(len(parsed_lines), 4)
            self.assertTrue(any(d.get("kind") == "event" and d.get("project") == "gravity-demo" for d in parsed_lines))
            self.assertTrue(any(d.get("target") == "src/app.py" for d in parsed_lines))

            # 6. Verify live `agy-watch stream` following both events and running bg task log lines
            conn = sqlite3.connect(str(db_path))
            conn.execute("UPDATE steps SET status = 2 WHERE idx = 7")
            conn.execute("INSERT INTO steps (idx, step_type, status) VALUES (10, 132, 2)")
            conn.commit()
            conn.close()
            log_path = self._setup_bg_transcript(cid_main, 10, "cargo build", log_text="Initial warmup line\n")

            proc = subprocess.Popen(
                [str(WATCH_BIN), "stream", "--json", "-n", "0", "--interval", "0.05"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=self.env,
            )
            try:
                time.sleep(0.2)
                self._run_watch(
                    "pre-invocation-hook",
                    {"conversationId": cid_main, "cwd": "/tmp/gravity-demo", "lastUserInput": "Build stream handle"},
                )
                with log_path.open("a", encoding="utf-8") as lfh:
                    lfh.write("Compiling widget v0.1.0\n")

                assert proc.stdout is not None
                sel = selectors.DefaultSelector()
                sel.register(proc.stdout, selectors.EVENT_READ)
                seen_event = False
                seen_task = False
                deadline = time.monotonic() + 4.0
                while time.monotonic() < deadline and not (seen_event and seen_task):
                    events = sel.select(timeout=max(0.05, deadline - time.monotonic()))
                    if not events:
                        continue
                    line = proc.stdout.readline()
                    if not line:
                        break
                    rec = json.loads(line)
                    if rec.get("kind") == "event" and rec.get("cid") == cid_main:
                        seen_event = True
                    if rec.get("kind") == "task_output" and "Compiling widget" in str(rec.get("line") or ""):
                        seen_task = True
                sel.close()

                self.assertTrue(seen_event, "Expected live streamed event record from agy-watch stream")
                self.assertTrue(seen_task, "Expected live streamed task_output record from agy-watch stream")
                proc.send_signal(signal.SIGINT)
                rc = proc.wait(timeout=3)
                self.assertEqual(rc, 0)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=2)
                if proc.stdout is not None:
                    proc.stdout.close()
                if proc.stderr is not None:
                    proc.stderr.close()


if __name__ == "__main__":
    unittest.main()
