from __future__ import annotations

import sys
import tempfile
import unittest
import contextlib
import io
from pathlib import Path
from unittest import mock


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from upstream.contracts import UpstreamContractError  # noqa: E402
from upstream.hydrate import (  # noqa: E402
    _install_file,
    _verify_qrels_checkout,
    _write_jsonl,
    build_parser,
)


class UpstreamHydrateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_install_is_idempotent_but_never_overwrites_different_bytes(self):
        source = self.root / "source"
        target = self.root / "target" / "asset"
        source.write_bytes(b"pinned")
        first = _install_file(source, target)
        second = _install_file(source, target)
        self.assertEqual(first, second)
        source.write_bytes(b"changed")
        with self.assertRaisesRegex(UpstreamContractError, "overwrite"):
            _install_file(source, target)

    def test_derived_jsonl_is_deterministic_and_strict_json(self):
        target = self.root / "derived.jsonl"
        self.assertEqual(_write_jsonl(target, [{"b": 2, "a": "值"}]), 1)
        self.assertEqual(target.read_text(encoding="utf-8"), '{"b":2,"a":"值"}\n')

    def test_cli_requires_every_pinned_snapshot_and_unversioned_travel_input(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                build_parser().parse_args([])

    def test_qrel_hydration_source_requires_exact_git_identity(self):
        checkout = self.root / "qrels"
        source = checkout / "topics-qrels" / "qrel_evidence.txt"
        source.parent.mkdir(parents=True)
        source.write_text("1 Q0 2 1\n", encoding="utf-8")

        def fake_git(_root, *args):
            if args == ("rev-parse", "--show-toplevel"):
                return str(checkout)
            if args == ("rev-parse", "HEAD"):
                return "046949032b0328319cc9a02663a759ec601d9402"
            if args == ("remote", "get-url", "origin"):
                return "https://github.com/texttron/BrowseComp-Plus.git"
            if args == ("status", "--porcelain=v1", "--untracked-files=no"):
                return ""
            if args == (
                "rev-parse",
                "046949032b0328319cc9a02663a759ec601d9402:topics-qrels/qrel_evidence.txt",
            ):
                return "d99a06aeb30dcf0dd9c41003c2bca8d775e4519c"
            raise AssertionError(args)

        with (
            mock.patch("upstream.hydrate._git", side_effect=fake_git),
            mock.patch("upstream.hydrate.validate_search_qrels") as validate,
        ):
            self.assertEqual(_verify_qrels_checkout(checkout), source.resolve())
            validate.assert_called_once_with(source.resolve())

        def wrong_revision(_root, *args):
            if args == ("rev-parse", "--show-toplevel"):
                return str(checkout)
            if args == ("rev-parse", "HEAD"):
                return "0" * 40
            raise AssertionError(args)

        with mock.patch("upstream.hydrate._git", side_effect=wrong_revision):
            with self.assertRaisesRegex(UpstreamContractError, "revision"):
                _verify_qrels_checkout(checkout)


if __name__ == "__main__":
    unittest.main()
