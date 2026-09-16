from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from upstream.contracts import SUITE_CONTRACTS, UpstreamContractError  # noqa: E402
from upstream.prepare import effective_config_identity, picorer_source_identity  # noqa: E402


class UpstreamPrepareTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "picorer"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(
            ["git", "-C", str(self.root), "config", "user.email", "fixture@example.test"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(self.root), "config", "user.name", "Fixture"],
            check=True,
        )
        (self.root / "source.ts").write_text("export {};\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", "source.ts"], check=True)
        subprocess.run(
            ["git", "-C", str(self.root), "commit", "-q", "-m", "fixture"],
            check=True,
        )
        subprocess.run(
            [
                "git", "-C", str(self.root), "remote", "add", "origin",
                "https://example.test/picorer.git",
            ],
            check=True,
        )

    def test_clean_full_git_identity_is_locked(self):
        identity = picorer_source_identity(self.root)
        self.assertEqual(identity["repository"], "https://example.test/picorer.git")
        self.assertRegex(str(identity["revision"]), r"^[0-9a-f]{40}$")
        self.assertIs(identity["clean_worktree"], True)

    def test_dirty_or_untracked_source_is_rejected(self):
        (self.root / "untracked.ts").write_text("export {};\n", encoding="utf-8")
        with self.assertRaisesRegex(UpstreamContractError, "fully clean"):
            picorer_source_identity(self.root)

    def test_credential_bearing_origin_is_rejected(self):
        subprocess.run(
            [
                "git", "-C", str(self.root), "remote", "set-url", "origin",
                "https://token@example.test/picorer.git",
            ],
            check=True,
        )
        with self.assertRaisesRegex(UpstreamContractError, "credentials"):
            picorer_source_identity(self.root)

    def test_effective_configs_are_bound_by_content(self):
        config_dir = self.root.parent / "effective-configs"
        config_dir.mkdir()
        for suite, contract in SUITE_CONTRACTS.items():
            config_path = config_dir / contract.effective_config_name
            config_path.write_text(json.dumps({"suite": suite}), encoding="utf-8")
            config_hash = hashlib.sha256(config_path.read_bytes()).hexdigest()
            (config_dir / f"{suite}.manifest.json").write_text(
                json.dumps(
                    {
                        "suite": suite,
                        "code_revision": "6cd9de14b71915e39ac742a20dc33785e14b6aab",
                        "data_revision": "da1a37c8b19280e18627ca01cf368195a5e1d92e",
                        "effective_config_sha256": config_hash,
                        "official_config_unchanged": True,
                        "evaluator_policy": "official_only",
                    }
                ),
                encoding="utf-8",
            )

        identity = effective_config_identity(config_dir)
        self.assertEqual(set(identity), set(SUITE_CONTRACTS))
        target = config_dir / SUITE_CONTRACTS["formal_reasoning_math"].effective_config_name
        target.write_text(json.dumps({"agent": {"model_name": "changed"}}), encoding="utf-8")
        with self.assertRaisesRegex(UpstreamContractError, "provenance mismatch"):
            effective_config_identity(config_dir)


if __name__ == "__main__":
    unittest.main()
