from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

import bootstrap  # noqa: E402


def run_git(cwd: Path, *args: str) -> str:
    process = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return process.stdout.strip()


class BootstrapGitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        run_git(self.source, "init", "--quiet")
        run_git(self.source, "config", "user.name", "Offline Test")
        run_git(self.source, "config", "user.email", "offline@example.invalid")
        (self.source / "README.md").write_text("pinned upstream\n", encoding="utf-8")
        run_git(self.source, "add", "README.md")
        run_git(self.source, "commit", "--quiet", "-m", "fixture")
        self.revision = run_git(self.source, "rev-parse", "HEAD")

    def test_local_clone_is_exact_detached_and_clean(self):
        checkout = self.root / "checkout"
        result = bootstrap.checkout_upstream(
            checkout,
            repository=str(self.source),
            revision=self.revision,
        )
        self.assertEqual(result["revision"], self.revision)
        self.assertTrue(result["detached"])
        self.assertTrue(result["clean"])
        self.assertEqual(run_git(checkout, "rev-parse", "HEAD"), self.revision)
        symbolic = subprocess.run(
            ["git", "symbolic-ref", "-q", "HEAD"],
            cwd=str(checkout),
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertNotEqual(symbolic.returncode, 0)

        offline_result = bootstrap.checkout_upstream(
            checkout,
            repository=str(self.source),
            revision=self.revision,
            offline=True,
        )
        self.assertEqual(offline_result["revision"], self.revision)

    def test_remote_sha_and_dirty_state_are_verified(self):
        checkout = self.root / "checkout"
        bootstrap.checkout_upstream(
            checkout,
            repository=str(self.source),
            revision=self.revision,
        )
        with self.assertRaises(bootstrap.GitVerificationError):
            bootstrap.verify_checkout(
                checkout,
                repository=str(self.root / "different-origin"),
                revision=self.revision,
            )
        with self.assertRaises(bootstrap.GitVerificationError):
            bootstrap.verify_checkout(
                checkout,
                repository=str(self.source),
                revision="0" * 40,
            )

        marker = checkout / "untracked.txt"
        marker.write_text("do not erase\n", encoding="utf-8")
        with self.assertRaises(bootstrap.GitVerificationError):
            bootstrap.checkout_upstream(
                checkout,
                repository=str(self.source),
                revision=self.revision,
                offline=True,
            )
        self.assertEqual(marker.read_text(encoding="utf-8"), "do not erase\n")
        self.assertEqual(run_git(checkout, "rev-parse", "HEAD"), self.revision)

    def test_offline_missing_checkout_fails_without_creating_it(self):
        checkout = self.root / "missing"
        with self.assertRaises(bootstrap.GitVerificationError):
            bootstrap.checkout_upstream(
                checkout,
                repository=str(self.source),
                revision=self.revision,
                offline=True,
            )
        self.assertFalse(checkout.exists())

    def test_checkout_cannot_be_vendored_in_project(self):
        target = INTEGRATION_ROOT / "vendor/upstream"
        with self.assertRaises(bootstrap.GitVerificationError):
            bootstrap.checkout_upstream(
                target,
                repository=str(self.source),
                revision=self.revision,
                offline=True,
            )
        self.assertFalse(target.exists())

    def test_cli_requires_explicit_data_revision(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                bootstrap._build_parser().parse_args(
                    [
                        "--checkout-dir",
                        os.fspath(self.root / "checkout"),
                        "--run-dir",
                        os.fspath(self.root / "run"),
                    ]
                )

    def test_cli_documents_suite_scoped_infrastructure_endpoint(self):
        help_text = bootstrap._build_parser().format_help()
        self.assertIn("SUITE:DOTTED_PATH=URL", help_text)
        self.assertIn("one explicit suite", help_text)


if __name__ == "__main__":
    unittest.main()
