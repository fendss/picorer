from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import (  # noqa: E402
    canonical_sha256,
    file_sha256,
    locked_manifest_document,
)
from upstream.assets import (  # noqa: E402
    build_local_asset_lock,
    load_hf_source_manifests,
    validate_search_qrels,
    validate_search_task_assets,
    verify_local_asset_lock,
    verify_hf_source_snapshot,
)
from upstream.contracts import (  # noqa: E402
    HF_SOURCE_MANIFEST_SHA256,
    ManifestMaterializationError,
    UpstreamContractError,
)


def _blob_oid(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode("ascii") + data).hexdigest()


class UpstreamAssetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_checked_in_hf_tree_descriptor_is_locked_and_complete(self):
        manifest = load_hf_source_manifests()
        self.assertEqual(
            file_sha256(INTEGRATION_ROOT / "upstream/hf_source_manifests.json"),
            HF_SOURCE_MANIFEST_SHA256,
        )
        counts = {
            name: source["file_count"]
            for name, source in manifest["repositories"].items()
        }
        self.assertEqual(counts, {
            "browsecomp_plus": 8,
            "browsecomp_plus_corpus": 9,
            "shopping_product_db": 135,
            "websearch_embeddings": 12,
        })

    def test_snapshot_verification_uses_git_and_lfs_content_identity(self):
        normal = b"normal git bytes\n"
        large = b"lfs payload"
        (self.root / "normal.txt").write_bytes(normal)
        (self.root / "large.bin").write_bytes(large)
        files = [
            {"path": "large.bin", "size": len(large), "git_oid": "a" * 40,
             "lfs_sha256": hashlib.sha256(large).hexdigest()},
            {"path": "normal.txt", "size": len(normal), "git_oid": _blob_oid(normal)},
        ]
        source = {
            "repositories": {
                "fixture": {
                    "repo_id": "test/fixture",
                    "revision": "b" * 40,
                    "tree_sha256": canonical_sha256(files),
                    "files": files,
                }
            }
        }
        proof = verify_hf_source_snapshot(
            "fixture", self.root, source_manifests=source
        )
        self.assertEqual(proof["verified_file_count"], 2)
        (self.root / "large.bin").write_bytes(b"lfs payloae")
        with self.assertRaises(UpstreamContractError):
            verify_hf_source_snapshot("fixture", self.root, source_manifests=source)

    def test_production_lock_refuses_revision_strings_without_snapshots(self):
        with self.assertRaisesRegex(
            ManifestMaterializationError, "four pinned HF source snapshots"
        ):
            build_local_asset_lock(
                self.root,
                progressive_records=[],
                require_default_assets=True,
                source_snapshots=None,
            )

    def test_search_ground_truth_joins_on_query_not_agent_answer(self):
        task = self.root / "task.jsonl"
        ground = self.root / "ground.jsonl"
        task.write_text(
            json.dumps({"id": 42, "question": ["sub", "final"], "answer": ["x", "gold"]}) + "\n",
            encoding="utf-8",
        )
        ground.write_text(
            json.dumps({"query_id": 42, "query": "\t final  ", "answer": "wrong"})
            + "\n"
            + json.dumps({"query_id": 99, "query": "unselected", "answer": "other"})
            + "\n",
            encoding="utf-8",
        )
        records = [{"id": 0, "questions": ["sub", "final"], "answers": ["x", "gold"]}]
        with mock.patch("upstream.assets.SEARCH_TASK_DATA_SHA256", file_sha256(task)):
            self.assertEqual(
                validate_search_task_assets(
                    records, task_data_path=task, ground_truth_path=ground
                ),
                {0: "42"},
            )
            ground.write_text(
                json.dumps({"query_id": 42, "query": "wrong", "answer": "gold"})
                + "\n"
                + json.dumps({"query_id": 99, "query": "unselected", "answer": "other"})
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ManifestMaterializationError, "query differs"):
                validate_search_task_assets(
                    records, task_data_path=task, ground_truth_path=ground
                )

    def test_search_qrel_bytes_blob_and_locked_query_coverage_are_required(self):
        qrels = self.root / "qrel_evidence.txt"
        qrels.write_text(
            "1 Q0 10 1\n1 Q0 11 1\n2 Q0 20 1\n",
            encoding="utf-8",
        )
        with mock.patch.multiple(
            "upstream.assets",
            BROWSECOMP_PLUS_QRELS_SHA256=file_sha256(qrels),
            BROWSECOMP_PLUS_QRELS_GIT_OID=_blob_oid(qrels.read_bytes()),
            BROWSECOMP_PLUS_QRELS_LINE_COUNT=3,
            BROWSECOMP_PLUS_QRELS_QUERY_ID_COUNT=2,
            BROWSECOMP_PLUS_QRELS_LOCKED_ROW_COUNT=2,
        ):
            proof = validate_search_qrels(qrels, expected_query_ids={"1"})
            self.assertEqual(proof["locked_query_row_count"], 2)
            with self.assertRaisesRegex(UpstreamContractError, "cover"):
                validate_search_qrels(qrels, expected_query_ids={"3"})
            qrels.write_text(
                "1 Q0 10 1\n1 Q0 11 0\n2 Q0 20 1\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(UpstreamContractError, "Git blob"):
                validate_search_qrels(qrels, expected_query_ids={"1"})

    def test_official_asset_lock_rejects_qrel_source_substitution(self):
        qrels = self.root / "qrel_evidence.txt"
        qrels.write_text("1 Q0 10 1\n", encoding="utf-8")
        digest = file_sha256(qrels)
        oid = _blob_oid(qrels.read_bytes())
        spec = {
            "path": qrels.name,
            "kind": "file",
            "revision": "b" * 40,
            "source_repo": "https://example.test/pinned.git",
            "source_path": "qrels.txt",
            "source_revision": "b" * 40,
            "sha256": digest,
            "git_oid": oid,
        }
        entry = {
            **spec,
            "size": qrels.stat().st_size,
            "source_repo": "https://example.test/substituted.git",
            "coverage": {
                "line_count": 1,
                "query_id_count": 1,
                "locked_query_id_count": 1,
                "locked_query_row_count": 1,
            },
        }
        document = locked_manifest_document(
            {
                "schema_version": 1,
                "kind": "memoryarena-public-local-assets",
                "code_revision": "6cd9de14b71915e39ac742a20dc33785e14b6aab",
                "data_revision": "da1a37c8b19280e18627ca01cf368195a5e1d92e",
                "hf_source_manifest_sha256": HF_SOURCE_MANIFEST_SHA256,
                "assets": {"search_qrels": entry},
            }
        )
        with (
            mock.patch("upstream.assets.DEFAULT_LOCAL_ASSETS", {"search_qrels": spec}),
            mock.patch(
                "upstream.assets.load_hf_source_manifests",
                return_value={"repositories": {}},
            ),
            mock.patch("upstream.assets._locked_search_runner_ids", return_value=("1",)),
            mock.patch.multiple(
                "upstream.assets",
                BROWSECOMP_PLUS_QRELS_SHA256=digest,
                BROWSECOMP_PLUS_QRELS_GIT_OID=oid,
                BROWSECOMP_PLUS_QRELS_LINE_COUNT=1,
                BROWSECOMP_PLUS_QRELS_QUERY_ID_COUNT=1,
                BROWSECOMP_PLUS_QRELS_LOCKED_ROW_COUNT=1,
            ),
        ):
            with self.assertRaisesRegex(UpstreamContractError, "source mismatch"):
                verify_local_asset_lock(document, checkout=self.root)


if __name__ == "__main__":
    unittest.main()
