from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest

from test_http_runner import HttpRunnerTests, MockHandler
from mab_adapter.clients import ChatClient, JsonHttpClient, MemoryClient
from mab_adapter.config import task_config
from mab_adapter.contracts import Context, Query
from mab_adapter.runner import RunSettings, execute_run


class SplitStageTests(unittest.TestCase):
    setUp = HttpRunnerTests.setUp
    tearDown = HttpRunnerTests.tearDown
    def test_retrieval_and_answer_are_resumable_separate_stages(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query(
                    question="Where is Normandy?",
                    answers=("France",),
                    qa_pair_id="qa-1",
                    question_id=None,
                    question_type=None,
                ),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        memory = MemoryClient(http)
        chat = ChatClient(http, "mock-model")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            retrieval = execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(output_path=output, query_slots=2, stage="retrieval"),
                chunker=lambda text, _size: [text],
            )
            self.assertEqual(retrieval["completed_queries"], 0)
            self.assertEqual(len(retrieval["pending_by_query"]), 1)
            self.assertNotIn("/chat/completions", MockHandler.paths)

            paths_after_retrieval = list(MockHandler.paths)
            answer = execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(
                    output_path=output,
                    query_slots=2,
                    stage="answer",
                    resume=True,
                ),
                chunker=lambda text, _size: [text],
            )
            persisted = json.loads(output.read_text())

        self.assertEqual(answer["completed_queries"], 1)
        self.assertEqual(persisted["pending_by_query"], {})
        self.assertEqual(MockHandler.paths[:len(paths_after_retrieval)], paths_after_retrieval)
        self.assertEqual(MockHandler.paths[len(paths_after_retrieval):], ["/chat/completions"])
