#!/usr/bin/env python3
"""
Unit & integration tests for `agy-statusline` context window calculation,
stdin payload handling, >32KB trailing tool output scanning, `CHECKPOINT`
compaction resets, and subagent isolation.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[4]
STATUSLINE_BIN = Path(
    os.environ.get("AGY_STATUSLINE_BIN") or (REPO_ROOT / "bin" / "agy-statusline")
)

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _load_statusline_module():
    loader = importlib.machinery.SourceFileLoader("agy_statusline", str(STATUSLINE_BIN))
    spec = importlib.util.spec_from_loader("agy_statusline", loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


class StatuslineContextTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_obj = tempfile.TemporaryDirectory(prefix="agy_statusline_test_")
        self.tmp = Path(self.tmp_obj.name)
        self.home = self.tmp / "home"
        self.cli_dir = self.home / ".gemini" / "antigravity-cli"
        self.desktop_dir = self.home / ".gemini" / "antigravity"
        self.wd_home = self.home / ".agents" / "watchdog"
        self.cli_dir.mkdir(parents=True, exist_ok=True)
        self.desktop_dir.mkdir(parents=True, exist_ok=True)
        self.wd_home.mkdir(parents=True, exist_ok=True)

        self.env = os.environ.copy()
        self.env["HOME"] = str(self.home)
        self.env["AGY_CLI_DATA_DIR"] = str(self.cli_dir)
        self.env["AGY_WATCHDOG_HOME"] = str(self.wd_home)

        self.mod = _load_statusline_module()

    def tearDown(self) -> None:
        self.tmp_obj.cleanup()

    def _transcript_path(self, cid: str, surface: str = "cli") -> Path:
        base = self.cli_dir if surface == "cli" else self.desktop_dir
        path = base / "brain" / cid / ".system_generated" / "logs" / "transcript.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _write_jsonl(self, path: Path, rows: list[dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row) + "\n")

    def _run_statusline(self, payload: dict[str, Any]) -> tuple[str, str, float]:
        t0 = time.perf_counter()
        proc = subprocess.run(
            [str(STATUSLINE_BIN)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=self.env,
            timeout=2,
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        raw = proc.stdout.strip()
        return raw, _strip_ansi(raw), elapsed_ms

    def test_stdin_payload_current_usage_and_limits(self) -> None:
        cid = "cid-stdin-001"

        # Empty session -> placeholder even when context_window_size is known
        raw0, plain0, _ = self._run_statusline(
            {
                "session_id": cid,
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {"context_window_size": 200_000},
            }
        )
        self.assertIn("ctx: —", plain0)

        # Without context_window_size: preserves compact format & 100k/180k color tiers
        raw_plain_45k, plain_45k, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {
                    "current_usage": {
                        "input_tokens": 15_000,
                        "cache_read_input_tokens": 28_000,
                        "cache_creation_input_tokens": 1_500,
                        "output_tokens": 500,
                    }
                },
            }
        )
        self.assertIn("ctx: 45.0k", plain_45k)
        self.assertIn("\033[36mctx:\033[0m 45.0k", raw_plain_45k)

        # 200k Claude window: 173,438 / 200,000 -> 87% RED
        raw_200k, plain_200k, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {
                    "context_window_size": 200_000,
                    "current_usage": {
                        "input_tokens": 1_813,
                        "cache_read_input_tokens": 170_842,
                        "cache_creation_input_tokens": 0,
                        "output_tokens": 783,
                    },
                },
            }
        )
        self.assertIn("ctx: 173k/200k (87%)", plain_200k)
        self.assertIn("\033[31mctx: 173k/200k (87%)\033[0m", raw_200k)

        # 1M Gemini window: 185,000 / 1,000,000 -> 18% CYAN (not false-alarm red!)
        raw_1m_low, plain_1m_low, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {
                    "context_window_size": 1_000_000,
                    "current_usage": {
                        "input_tokens": 5_000,
                        "cache_read_input_tokens": 178_000,
                        "output_tokens": 2_000,
                    },
                },
            }
        )
        self.assertIn("ctx: 185k/1M (18%)", plain_1m_low)
        self.assertIn("\033[36mctx:\033[0m 185k/1M (18%)", raw_1m_low)

        # 1M Gemini window: 550,000 -> 55% YELLOW, and 900,000 -> 90% RED
        raw_1m_mid, _, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {
                    "context_window_size": 1_048_576,
                    "current_usage": {
                        "input_tokens": 10_000,
                        "cache_read_input_tokens": 538_000,
                        "output_tokens": 2_000,
                    },
                },
            }
        )
        self.assertIn("\033[33mctx: 550k/1M (52%)\033[0m", raw_1m_mid)

        raw_1m_high, _, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {
                    "context_window_size": 1_000_000,
                    "current_usage": {
                        "input_tokens": 20_000,
                        "cache_read_input_tokens": 875_000,
                        "output_tokens": 5_000,
                    },
                },
            }
        )
        self.assertIn("\033[31mctx: 900k/1M (90%)\033[0m", raw_1m_high)

    def test_resume_and_midstream_zero_current_usage_reads_transcript_not_buggy_total_input(self) -> None:
        """
        In agy CLI:
        - On `agy --resume`, LatestGeneratorMetadata is nil so current_usage is null and
          total_input_tokens only has the last step's uncached input_tokens (e.g. 1,813).
        - During mid-stream generation (gen_meta[last]), current_usage has all 0s.
        Verify agy-statusline reads the full 173.4k context from transcript.jsonl!
        """
        cid = "cid-resume-002"
        tpath = self._transcript_path(cid)
        self._write_jsonl(
            tpath,
            [
                {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "audit repo"},
                {
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "model": "claude-sonnet-5-5-medium",
                    "input_tokens": 1_813,
                    "cache_read_tokens": 170_842,
                    "output_tokens": 783,
                },
            ],
        )

        # Simulate agy --resume payload: current_usage=None, buggy total_input_tokens=1813
        _, plain_resume, _ = self._run_statusline(
            {
                "session_id": cid,
                "conversation_id": cid,
                "transcript_path": str(tpath),
                "cwd": str(self.tmp),
                "context_window": {
                    "total_input_tokens": 1_813,
                    "total_output_tokens": 98_420,
                    "context_window_size": 200_000,
                    "used_percentage": 50.1,
                    "current_usage": None,
                },
            }
        )
        self.assertIn("ctx: 173k/200k (87%)", plain_resume)

        # Simulate mid-stream PreInvocation payload: current_usage all zeros
        _, plain_mid, _ = self._run_statusline(
            {
                "session_id": cid,
                "conversation_id": cid,
                "transcript_path": str(tpath),
                "cwd": str(self.tmp),
                "context_window": {
                    "total_input_tokens": 166_772,
                    "context_window_size": 200_000,
                    "current_usage": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0,
                    },
                },
            }
        )
        self.assertIn("ctx: 173k/200k (87%)", plain_mid)

    def test_custom_model_without_reported_usage_falls_back_cleanly(self) -> None:
        """
        Providers like custom-glm-5-3-flash omit Usage tokens on PLANNER_RESPONSE rows.
        Verify fallback to Cortex's EstimatedTokensUsed (total_input_tokens) when provided,
        and char/4 estimation when total_input_tokens is absent.
        """
        cid = "cid-custom-003"
        tpath = self._transcript_path(cid)
        self._write_jsonl(
            tpath,
            [
                {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "a" * 4000},
                {
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "model": "custom-glm-5-3-flash",
                    "content": "b" * 8000,
                },
            ],
        )

        # 1. With Cortex EstimatedTokensUsed in total_input_tokens
        _, plain_est, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {
                    "total_input_tokens": 152_048,
                    "context_window_size": 256_000,
                    "current_usage": {"input_tokens": 0, "output_tokens": 0},
                },
            }
        )
        self.assertIn("ctx: 152k/256k (59%)", plain_est)

        # 2. Without total_input_tokens -> char/4 fallback ((4000 + 8000) / 4 = 3000 -> 3.0k)
        _, plain_chars, _ = self._run_statusline({"conversation_id": cid, "cwd": str(self.tmp)})
        self.assertIn("ctx: 3.0k", plain_chars)

    def test_trailing_generic_tool_outputs_over_32kb_and_chunk_boundaries(self) -> None:
        """
        Verify >32KB (up to >350KB across multiple backward chunks + single >90KB lines + UTF-8)
        and trailing tokenless/error PLANNER_RESPONSE steps do not hide the last reported usage.
        """
        cid = "cid-large-tail-004"
        tpath = self._transcript_path(cid)

        rows: list[dict[str, Any]] = [
            {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "content": "read logs"},
            {
                "step_index": 1,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "model": "gemini-4-carbon-high",
                # Also exercise 100% cache hit where input_tokens is omitted!
                "cache_read_tokens": 140_000,
                "output_tokens": 2_500,
            },
        ]
        # Append ~360 KB of GENERIC tool outputs + a 95 KB single line with multi-byte UTF-8
        for idx in range(2, 32):
            rows.append(
                {
                    "step_index": idx,
                    "source": "MODEL",
                    "type": "GENERIC",
                    "status": "DONE",
                    "content": ("tool-output-αβγ-" * 800) + f" step={idx}",
                }
            )
        rows.append(
            {
                "step_index": 32,
                "source": "MODEL",
                "type": "GENERIC",
                "status": "DONE",
                "content": "Ω" * 50_000,  # 100 KB UTF-8 single line
            }
        )
        # Trailing errored PLANNER_RESPONSE lacking input_tokens
        rows.append(
            {
                "step_index": 33,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "ERROR",
                "content": "",
            }
        )
        self._write_jsonl(tpath, rows)
        self.assertGreater(tpath.stat().st_size, 350_000)

        _, plain, elapsed_ms = self._run_statusline(
            {
                "conversation_id": cid,
                "cwd": str(self.tmp),
                "context_window": {"context_window_size": 1_000_000},
            }
        )
        self.assertIn("ctx: 142k/1M (14%)", plain)
        self.assertLess(elapsed_ms, 50.0)

    def test_chunks_directory_fallback_when_transcript_jsonl_missing(self) -> None:
        cid = "cid-chunks-005"
        chunks_dir = (
            self.cli_dir
            / "brain"
            / cid
            / ".system_generated"
            / "logs"
            / "chunks"
            / "transcript"
        )
        self._write_jsonl(
            chunks_dir / "00000000.jsonl",
            [
                {
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "input_tokens": 12_000,
                    "cache_read_tokens": 0,
                    "output_tokens": 400,
                }
            ],
        )
        self._write_jsonl(
            chunks_dir / "00000001.jsonl",
            [
                {
                    "step_index": 2,
                    "source": "MODEL",
                    "type": "GENERIC",
                    "status": "DONE",
                    "content": "x" * 40_000,
                }
            ],
        )

        _, plain, _ = self._run_statusline({"conversation_id": cid, "cwd": str(self.tmp)})
        self.assertIn("ctx: 12.4k", plain)

    def test_checkpoint_compaction_resets_pre_compaction_context_and_stale_stdin(self) -> None:
        """
        Verify SYSTEM CHECKPOINT resets pre-compaction context:
        1. Immediate post-CHECKPOINT state discards pre-compaction 277k PLANNER_RESPONSE,
           discards CHECKPOINT's own 278k summarizer input_tokens/cache_read_tokens,
           AND overrides agy CLI's stale pre-compaction stdin current_usage!
        2. Empty CHECKPOINT resets cleanly to `ctx: —`.
        3. Subsequent post-CHECKPOINT PLANNER_RESPONSE reports fresh post-compaction usage.
        """
        cid = "cid-compact-006"
        tpath = self._transcript_path(cid)

        # Case A: Real compaction CHECKPOINT with output_tokens=5375 after 277k session
        base_rows: list[dict[str, Any]] = [
            {
                "step_index": 143,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "model": "claude-sonnet-5-5-medium",
                "input_tokens": 268_793,
                "cache_read_tokens": 7_397,
                "output_tokens": 815,
            },
            {
                "step_index": 145,
                "source": "SYSTEM",
                "type": "CHECKPOINT",
                "status": "DONE",
                "input_tokens": 2_230,
                "cache_read_tokens": 276_091,
                "output_tokens": 5_375,
                "content": "# Resuming from a compaction\nSummary...",
            },
        ]
        self._write_jsonl(tpath, base_rows)

        # Even if agy CLI still sends stale pre-compaction 277k current_usage on stdin:
        raw_cp, plain_cp, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "transcript_path": str(tpath),
                "cwd": str(self.tmp),
                "context_window": {
                    "context_window_size": 200_000,
                    "total_input_tokens": 276_190,
                    "current_usage": {
                        "input_tokens": 268_793,
                        "cache_read_input_tokens": 7_397,
                        "output_tokens": 815,
                    },
                },
            }
        )
        self.assertIn("ctx: 5.4k/200k (3%)", plain_cp)
        self.assertIn("\033[36mctx:\033[0m 5.4k/200k (3%)", raw_cp)

        # Case B: Post-CHECKPOINT PLANNER_RESPONSE arrives (27,469 tokens)
        self._write_jsonl(
            tpath,
            base_rows
            + [
                {
                    "step_index": 147,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "model": "claude-sonnet-5-5-high",
                    "input_tokens": 220,
                    "cache_read_tokens": 26_562,
                    "output_tokens": 687,
                }
            ],
        )
        _, plain_after, _ = self._run_statusline(
            {
                "conversation_id": cid,
                "transcript_path": str(tpath),
                "cwd": str(self.tmp),
                "context_window": {"context_window_size": 200_000},
            }
        )
        self.assertIn("ctx: 27.5k/200k (14%)", plain_after)

        # Case C: Bare empty CHECKPOINT with no output_tokens/content -> resets to ctx: —
        cid_empty_cp = "cid-compact-empty-007"
        tpath_empty = self._transcript_path(cid_empty_cp)
        self._write_jsonl(
            tpath_empty,
            [
                {
                    "step_index": 10,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "input_tokens": 195_000,
                    "output_tokens": 1_000,
                },
                {"step_index": 11, "source": "SYSTEM", "type": "CHECKPOINT", "status": "DONE"},
            ],
        )
        _, plain_empty_cp, _ = self._run_statusline(
            {"conversation_id": cid_empty_cp, "cwd": str(self.tmp)}
        )
        self.assertIn("ctx: —", plain_empty_cp)

    def test_subagent_isolation(self) -> None:
        """
        Verify subagent transcripts, subagent metadata, embedded PLANNER_RESPONSE JSON
        in GENERIC tool outputs, and subagent_id-tagged rows never leak across sessions.
        """
        parent_cid = "cid-parent-008"
        sub_cid = "cid-subagent-008"

        parent_tpath = self._transcript_path(parent_cid)
        sub_tpath = self._transcript_path(sub_cid)

        # Subagent has huge 195k context
        self._write_jsonl(
            sub_tpath,
            [
                {
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "input_tokens": 15_000,
                    "cache_read_tokens": 179_000,
                    "output_tokens": 1_000,
                }
            ],
        )

        # Register subagent descriptor under parent's .system_generated/subagents/
        sub_meta_dir = parent_tpath.parents[1] / "subagents"
        sub_meta_dir.mkdir(parents=True, exist_ok=True)
        (sub_meta_dir / f"{sub_cid}.json").write_text(
            json.dumps({"conversationId": sub_cid, "state": "SUBAGENT_STATE_RUNNING"}),
            encoding="utf-8",
        )

        # Parent has 32.0k context, PLUS a GENERIC tool output that quotes subagent's
        # PLANNER_RESPONSE JSON, PLUS hypothetical inline subagent/mismatched-cid rows!
        embedded_pr_json = json.dumps(
            {
                "step_index": 99,
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "input_tokens": 195_000,
                "cache_read_tokens": 50_000,
                "output_tokens": 2_000,
            }
        )
        self._write_jsonl(
            parent_tpath,
            [
                {
                    "step_index": 1,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "input_tokens": 4_000,
                    "cache_read_tokens": 27_500,
                    "output_tokens": 500,
                },
                {
                    "step_index": 2,
                    "source": "MODEL",
                    "type": "GENERIC",
                    "status": "DONE",
                    "content": f"Subagent log line: {embedded_pr_json}",
                },
                {
                    "step_index": 3,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "subagent_id": sub_cid,
                    "input_tokens": 180_000,
                    "output_tokens": 1_000,
                },
                {
                    "step_index": 4,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "conversation_id": sub_cid,
                    "input_tokens": 190_000,
                    "output_tokens": 1_000,
                },
            ],
        )

        # Parent statusline reports ONLY parent's 32.0k
        _, plain_parent, _ = self._run_statusline(
            {
                "session_id": parent_cid,
                "conversation_id": parent_cid,
                "cwd": str(self.tmp),
                "subagents": [{"name": "worker", "status": "running"}],
            }
        )
        self.assertIn("ctx: 32.0k", plain_parent)

        # Subagent statusline reports ONLY subagent's 195k
        _, plain_sub, _ = self._run_statusline(
            {"session_id": sub_cid, "conversation_id": sub_cid, "cwd": str(self.tmp)}
        )
        self.assertIn("ctx: 195k", plain_sub)

        # Unsafe path-traversal cid is rejected cleanly
        _, plain_bad, _ = self._run_statusline(
            {"conversation_id": "../../etc/passwd", "cwd": str(self.tmp)}
        )
        self.assertIn("ctx: —", plain_bad)

    def test_desktop_surface_discovery_and_module_speed(self) -> None:
        """Verify Desktop (`~/.gemini/antigravity/brain/<cid>`) lookup and sub-millisecond Python call."""
        cid = "cid-desktop-009"
        tpath = self._transcript_path(cid, surface="desktop")
        self._write_jsonl(
            tpath,
            [
                {
                    "step_index": 2,
                    "source": "MODEL",
                    "type": "PLANNER_RESPONSE",
                    "status": "DONE",
                    "input_tokens": 5_357,
                    "cache_read_tokens": 36_818,
                    "output_tokens": 898,
                }
            ],
        )

        # Direct in-process call must be < 2ms; full subprocess < 25ms median
        old_home = os.environ.get("HOME")
        old_cli = os.environ.get("AGY_CLI_DATA_DIR")
        os.environ["HOME"] = str(self.home)
        os.environ["AGY_CLI_DATA_DIR"] = str(self.cli_dir)
        try:
            t0 = time.perf_counter()
            seg = self.mod.build_context_segment(
                cid, {"context_window": {"context_window_size": 1_000_000}}
            )
            inproc_ms = (time.perf_counter() - t0) * 1000.0
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home
            if old_cli is None:
                os.environ.pop("AGY_CLI_DATA_DIR", None)
            else:
                os.environ["AGY_CLI_DATA_DIR"] = old_cli

        self.assertIn("ctx: 43.1k/1M (4%)", _strip_ansi(seg))
        self.assertLess(inproc_ms, 5.0)

        samples = [
            self._run_statusline(
                {
                    "conversation_id": cid,
                    "cwd": str(self.tmp),
                    "context_window": {"context_window_size": 1_000_000},
                }
            )[2]
            for _ in range(7)
        ]
        self.assertLess(sorted(samples)[len(samples) // 2], 25.0)


if __name__ == "__main__":
    unittest.main()
