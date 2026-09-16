from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mab_adapter.contracts import ContractError  # noqa: E402
from mab_adapter.longmemeval import structured_longmemeval_appends  # noqa: E402


class LongMemEvalVisibleContextTests(unittest.TestCase):
    def test_preserves_public_session_turn_roles_and_times(self):
        context = repr(
            [
                "Chat Time: 2025/01/02 (Thu) 03:04",
                [
                    {"role": "user", "content": "First question"},
                    {"role": "assistant", "content": "First answer"},
                ],
                "Chat Time: 2025/02/03 (Mon) 14:15",
                [{"role": "user", "content": "Later fact"}],
            ]
        )

        appends = structured_longmemeval_appends(context)

        self.assertIsNotNone(appends)
        assert appends is not None
        self.assertEqual(len(appends), 2)
        self.assertEqual(
            appends[0].messages,
            (
                {
                    "role": "user",
                    "content": "First question",
                    "timestamp": "2025-01-02T03:04:00",
                },
                {
                    "role": "assistant",
                    "content": "First answer",
                    "timestamp": "2025-01-02T03:04:00",
                },
            ),
        )
        self.assertIn('"chat_time":"Chat Time: 2025/01/02', appends[0].chunk)
        self.assertEqual(
            structured_longmemeval_appends(context),
            appends,
            "the public context must produce deterministic append identities",
        )

    def test_leaves_non_longmemeval_prose_to_generic_chunking(self):
        self.assertIsNone(structured_longmemeval_appends("ordinary benchmark prose"))

    def test_rejects_malformed_visible_longmemeval_context(self):
        with self.assertRaisesRegex(ContractError, "must alternate"):
            structured_longmemeval_appends("['Chat Time: 2025/01/02 (Thu) 03:04']")


if __name__ == "__main__":
    unittest.main()
