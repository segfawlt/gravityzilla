#!/usr/bin/env python3
"""Unit tests for ephemeral worker cleanup and untitled session title resolution."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[4]
AGENT_MEMORY_PATH = REPO_ROOT / "bin" / "agent-memory"
AGY_COMPOUND_PATH = REPO_ROOT / "bin" / "agy-compound"
AGY_STATS_PATH = REPO_ROOT / "config" / "plugins" / "stats" / "bin" / "agy-stats"


def _load_script_module(name: str, path: Path) -> Any:
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


agent_memory = _load_script_module("agent_memory_mod", AGENT_MEMORY_PATH)
agy_compound = _load_script_module("agy_compound_mod", AGY_COMPOUND_PATH)
agy_stats = _load_script_module("agy_stats_mod", AGY_STATS_PATH)


def _create_conv_db(path: Path, step0_payload: bytes | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)"
        )
        if step0_payload is not None:
            conn.execute("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 14, 3, ?)", (step0_payload,))
        conn.commit()


def _create_summaries_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE conversation_summaries (
                conversation_id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                preview TEXT NOT NULL DEFAULT '',
                step_count INTEGER NOT NULL DEFAULT 0,
                last_modified_time TEXT NOT NULL DEFAULT '',
                workspace_uris TEXT NOT NULL DEFAULT '',
                agent_name TEXT NOT NULL DEFAULT '',
                parent_conversation_id TEXT NOT NULL DEFAULT '',
                killed INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute(
            "CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, title, user_body)"
        )
        conn.execute(
            "CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)"
        )
        conn.commit()


def _insert_summary_row(
    sum_db: Path,
    cid: str,
    title: str = "",
    preview: str = "",
    step_count: int = 3,
    parent: str = "",
) -> None:
    with sqlite3.connect(sum_db) as conn:
        conn.execute(
            "INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, parent_conversation_id) VALUES (?, ?, ?, ?, ?)",
            (cid, title, preview, step_count, parent),
        )
        conn.execute(
            "INSERT INTO conversations_fts (conversation_id, title, user_body) VALUES (?, ?, ?)",
            (cid, title, preview),
        )
        if parent:
            conn.execute(
                "INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)",
                (cid, parent),
            )
        conn.commit()


def _seed_session_artifacts(
    prod_dir: Path,
    cid: str,
    *,
    with_transcript: bool = False,
    transcript_line: str = "",
    with_wal: bool = False,
    with_pb: bool = False,
    with_lock: bool = False,
    step0_payload: bytes | None = None,
    summary_title: str = "",
    summary_preview: str = "",
    step_count: int = 3,
    parent: str = "",
) -> None:
    if with_transcript:
        tpath = prod_dir / "brain" / cid / ".system_generated" / "logs" / "transcript.jsonl"
        tpath.parent.mkdir(parents=True, exist_ok=True)
        tpath.write_text(transcript_line + "\n", encoding="utf-8")
    cdir = prod_dir / "conversations"
    _create_conv_db(cdir / f"{cid}.db", step0_payload=step0_payload)
    if with_wal:
        (cdir / f"{cid}.db-wal").write_bytes(b"wal")
        (cdir / f"{cid}.db-shm").write_bytes(b"shm")
    if with_pb:
        (cdir / f"{cid}.pb").write_bytes(b"pb")
    if with_lock:
        pdir = prod_dir / "presence"
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / f"{cid}.lock").write_text("1234", encoding="utf-8")
    _insert_summary_row(
        prod_dir / "conversation_summaries.db",
        cid,
        title=summary_title,
        preview=summary_preview,
        step_count=step_count,
        parent=parent,
    )


class WorkerCleanupTests(unittest.TestCase):
    def _run_purge_scenario(self, mod: Any) -> None:
        products = ("antigravity-cli", "antigravity")
        user_old = "11111111-1111-1111-1111-111111111111"
        user_concurrent = "22222222-2222-2222-2222-222222222222"
        worker_a = "33333333-3333-3333-3333-333333333333"
        worker_timeout = "44444444-4444-4444-4444-444444444444"

        with tempfile.TemporaryDirectory(prefix="agy_mem_cleanup_") as tmp:
            root = Path(tmp)
            cli_dir = root / "antigravity-cli"
            desk_dir = root / "antigravity"
            for d in (cli_dir, desk_dir):
                _create_summaries_db(d / "conversation_summaries.db")

            _seed_session_artifacts(
                cli_dir,
                user_old,
                with_transcript=True,
                transcript_line='{"type":"USER_INPUT","content":"hello"}',
                step0_payload=b"hello",
                summary_title="Old User Chat",
                summary_preview="hello",
            )

            existing_brains, existing_convs = mod._snapshot_agy_state(gemini_root=root, products=products)

            _seed_session_artifacts(
                cli_dir,
                user_concurrent,
                with_transcript=True,
                transcript_line='{"type":"USER_INPUT","content":"concurrent chat"}',
                with_wal=True,
                with_lock=True,
                step0_payload=b"concurrent chat",
                summary_title="Concurrent Chat",
                summary_preview="concurrent chat",
            )
            _seed_session_artifacts(
                cli_dir,
                worker_a,
                with_transcript=True,
                transcript_line='{"type":"USER_INPUT","content":"[AGY_INTERNAL_WORKER]\\nPrompt"}',
                with_wal=True,
                with_pb=True,
                with_lock=True,
                step0_payload=b"[AGY_INTERNAL_WORKER]\nPrompt",
                summary_preview="[AGY_INTERNAL_WORKER]",
                parent=user_old,
            )
            # Timed-out worker: no transcript, no ephemeral_cid returned, only SQLite step 0 in Desktop product dir
            _seed_session_artifacts(
                desk_dir,
                worker_timeout,
                with_transcript=False,
                with_wal=True,
                with_lock=True,
                step0_payload=b"meta\x00[AGY_INTERNAL_WORKER]\nStage 2",
                summary_preview="",
            )

            discovered = mod._discover_new_worker_cids(
                existing_brains,
                existing_convs,
                ephemeral_cid="",
                gemini_root=root,
                products=products,
            )
            self.assertEqual(discovered, {worker_a, worker_timeout})

            purged_count = mod.purge_ephemeral_conversations(discovered, gemini_root=root, products=products)
            self.assertEqual(purged_count, 2)

            for wcid, pdir in ((worker_a, cli_dir), (worker_timeout, desk_dir)):
                self.assertFalse((pdir / "brain" / wcid).exists())
                for ext in (".db", ".db-wal", ".db-shm", ".pb"):
                    self.assertFalse((pdir / "conversations" / f"{wcid}{ext}").exists())
                self.assertFalse((pdir / "presence" / f"{wcid}.lock").exists())
                with sqlite3.connect(pdir / "conversation_summaries.db") as conn:
                    self.assertEqual(
                        conn.execute("SELECT count(*) FROM conversation_summaries WHERE conversation_id = ?", (wcid,)).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        conn.execute("SELECT count(*) FROM conversations_fts WHERE conversation_id = ?", (wcid,)).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        conn.execute("SELECT count(*) FROM conversation_parents WHERE conversation_id = ?", (wcid,)).fetchone()[0],
                        0,
                    )

            for ucid in (user_old, user_concurrent):
                self.assertTrue((cli_dir / "brain" / ucid).is_dir())
                self.assertTrue((cli_dir / "conversations" / f"{ucid}.db").is_file())
                with sqlite3.connect(cli_dir / "conversation_summaries.db") as conn:
                    self.assertEqual(
                        conn.execute("SELECT count(*) FROM conversation_summaries WHERE conversation_id = ?", (ucid,)).fetchone()[0],
                        1,
                    )

    def test_agent_memory_and_compound_purge_all_artifacts(self) -> None:
        self._run_purge_scenario(agent_memory)
        self._run_purge_scenario(agy_compound)

    def test_scan_leaked_workers_and_zero_step_stubs(self) -> None:
        products = ("antigravity-cli", "antigravity")
        leaked_summary_only = "55555555-5555-5555-5555-555555555555"
        leaked_db_only = "66666666-6666-6666-6666-666666666666"
        zero_stub = "77777777-7777-7777-7777-777777777777"
        normal_user = "88888888-8888-8888-8888-888888888888"

        with tempfile.TemporaryDirectory(prefix="agy_scan_test_") as tmp:
            root = Path(tmp)
            cli_dir = root / "antigravity-cli"
            _create_summaries_db(cli_dir / "conversation_summaries.db")

            _seed_session_artifacts(
                cli_dir,
                leaked_summary_only,
                step0_payload=None,
                summary_preview="[AGY_INTERNAL_WORKER] stage1",
                step_count=3,
            )
            _seed_session_artifacts(
                cli_dir,
                leaked_db_only,
                step0_payload=b"[AGY_INTERNAL_WORKER]\nPrompt",
                summary_preview="",
                step_count=3,
            )
            _seed_session_artifacts(
                cli_dir,
                zero_stub,
                step0_payload=None,
                summary_preview="",
                step_count=0,
            )
            _seed_session_artifacts(
                cli_dir,
                normal_user,
                step0_payload=b"regular user prompt",
                summary_title="Normal Chat",
                summary_preview="regular user prompt",
                step_count=4,
            )

            leaked, zero_count = agent_memory._scan_leaked_worker_conversations(gemini_root=root, products=products)
            self.assertEqual(leaked, {leaked_summary_only, leaked_db_only})
            self.assertEqual(zero_count, 1)
            # Scan must be strictly read-only and keep the 0-step stub untouched
            self.assertTrue((cli_dir / "conversations" / f"{zero_stub}.db").is_file())

    def test_agy_stats_resolve_session_display_title(self) -> None:
        parent_cid = "99999999-9999-9999-9999-999999999999"
        conv_meta = {
            parent_cid: {"title": "SmartKey Project Autocorrect Bug"},
        }

        # 1. Swarm/subagent child with titled parent
        self.assertEqual(
            agy_stats._resolve_session_display_title(
                "d3463b17-69a5-4a42-9e9e-234a801ef2a8",
                {"title": "", "parent": parent_cid, "preview": ""},
                "monitor",
                None,
                conv_meta,
            ),
            "SmartKey Project Autocorrect Bug › monitor",
        )

        # 2. Subagent child with missing/untitled parent
        self.assertEqual(
            agy_stats._resolve_session_display_title(
                "1f07fa55-aaaa-bbbb-cccc-dddddddddddd",
                {"title": "", "parent": "00000000-0000-0000-0000-000000000000", "preview": ""},
                "research",
                None,
                conv_meta,
            ),
            "research (1f07fa55)",
        )

        # 3. Top-level untitled session with plain preview
        self.assertEqual(
            agy_stats._resolve_session_display_title(
                "462a145c-d0d9-4a4b-bd5b-833344ca6e26",
                {"title": "", "parent": "", "preview": "reply with OK only"},
                "Lead",
                None,
                conv_meta,
            ),
            "reply with OK only",
        )

        # 4. Internal worker fallback
        self.assertEqual(
            agy_stats._resolve_session_display_title(
                "8b11f14f-e7ab-4581-b1a4-c5d4440f488e",
                {"title": "", "parent": "", "preview": "[AGY_INTERNAL_WORKER]"},
                "Lead",
                None,
                conv_meta,
                is_internal_worker=True,
            ),
            "Internal Worker (8b11f14f)",
        )

        # 5. Bare /resume stub falls back to Untitled Session
        self.assertEqual(
            agy_stats._resolve_session_display_title(
                "e2cad943-d846-4fb1-af84-b4f68026d44d",
                {"title": "", "parent": "", "preview": "/resume"},
                "Lead",
                None,
                conv_meta,
            ),
            "Untitled Session",
        )


if __name__ == "__main__":
    unittest.main()
