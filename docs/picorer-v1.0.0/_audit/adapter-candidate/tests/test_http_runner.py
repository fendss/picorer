from __future__ import annotations

import json
import hashlib
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from http.client import RemoteDisconnected
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mab_adapter.clients import (  # noqa: E402
    AnswerHandoffContract,
    ChatClient,
    EVIDENCE_AWARE_ANSWER_HANDOFF,
    JsonHttpClient,
    MemoryClient,
    MemoryWrapResult,
    RemoteError,
)
from mab_adapter.context_fit import fit_memory_prompt_to_context_window  # noqa: E402
from mab_adapter.config import task_config  # noqa: E402
from mab_adapter.contracts import Context, Query  # noqa: E402
from mab_adapter.load_control import (  # noqa: E402
    AdaptiveConcurrencyConfig,
    AdaptiveStageConcurrencyConfig,
)
from mab_adapter.runner import (  # noqa: E402
    RetryableRunUnavailable,
    RunInterrupted,
    RunSettings,
    _summarize,
    _validate_retrieval_model_consistency,
    execute_run,
)


MOCK_RUNTIME_CONTRACT = {
    "schema_version": 1,
    "source_identity": "test-source",
    "build_identity": "test-build",
    "skill": {"id": "picorer-minimal", "sha256": "a" * 64},
    "retrieval": {
        "provider_id": "mock-provider",
        "logical_model_id": "mock-retrieval",
        "route_model_id": "mock-retrieval-medium",
        "protocol": "openai-reasoning-completions",
        "thinking_level": "medium",
        "transport": "non-stream",
        "base_url": "https://mock.example/v1",
    },
    "limits": {
        "max_run_ms": 300000,
        "max_turns": 64,
        "max_tool_calls": 80,
        "max_search_calls": 4,
        "request_timeout_ms": 120000,
        "request_max_retries": 1,
        "request_max_retry_delay_ms": 5000,
        "max_concurrent_wraps": 16,
    },
    "answer_handoff": {
        "id": EVIDENCE_AWARE_ANSWER_HANDOFF.handoff_id,
        "prompt_version": EVIDENCE_AWARE_ANSWER_HANDOFF.prompt_version,
    },
}
class MockHandler(BaseHTTPRequestHandler):
    chunks: dict[str, list[str]] = {}
    paths: list[str] = []
    operator_requests: list[dict] = []
    wrap_requests: list[dict] = []
    chat_failures_remaining = 0
    chat_empty_remaining = 0
    wrap_failures_remaining = 0
    reported_search_calls = 1
    runtime_contract = MOCK_RUNTIME_CONTRACT
    persistence_identity = "mock-persistence-instance"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path != "/runtime":
            self.send_error(404)
            return
        runtime_contract = type(self).runtime_contract
        runtime_sha256 = hashlib.sha256(
            json.dumps(
                runtime_contract,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        payload = json.dumps({
            "status": "ok",
            "runtime_contract": runtime_contract,
            "runtime_identity_sha256": runtime_sha256,
            "persistence_identity": type(self).persistence_identity,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        length = int(self.headers["content-length"])
        body = json.loads(self.rfile.read(length))
        type(self).paths.append(self.path)
        if self.path == "/memory/initialize":
            type(self).chunks[body["user_id"]] = []
            response = {
                "status": "ok",
                "user_id": body["user_id"],
                "memory_system_name": body["memory_system_name"],
            }
        elif self.path == "/memory/add":
            type(self).chunks[body["user_id"]].append(body["chunk"])
            response = {"status": "ok", "user_id": body["user_id"], "response": None}
        elif self.path == "/memory/wrap_user_prompt":
            type(self).wrap_requests.append(body)
            if type(self).wrap_failures_remaining:
                type(self).wrap_failures_remaining -= 1
                payload = json.dumps(
                    {
                        "detail": "Picorer retrieval agent stopped without a valid finish result",
                        "error_code": "retrieval_agent_protocol_error",
                        "retryable": False,
                        "diagnostics": {
                            "retrieval": {
                                "runId": "safe-run-id",
                                "turns": 3,
                                "toolCalls": 2,
                            }
                        },
                    }
                ).encode("utf-8")
                self.send_response(422)
                self.send_header("content-type", "application/json")
                self.send_header(
                    "x-picorer-error-code", "retrieval_agent_protocol_error"
                )
                self.send_header("x-picorer-retryable", "false")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            memories = "\n".join(type(self).chunks[body["user_id"]])
            experiment = body["operator_experiment"]
            type(self).operator_requests.append(experiment)
            operator_result = {
                "mode": experiment["mode"],
                "questionId": experiment["question_id"],
                "maxSearchCalls": experiment["max_search_calls"],
                "retrievalStatus": "sufficient",
                "searchCalls": type(self).reported_search_calls,
                "operatorDefinitions": [],
            }
            if experiment["mode"] == "cumulative":
                previous = experiment.get("evolution_snapshot")
                previous_sequence = previous["sequence"] if previous else 0
                previous_ids = previous["seenQuestionIds"] if previous else []
                operator_result["evolutionSnapshot"] = {
                    "schemaVersion": 1,
                    "capacity": 4,
                    "explorationSlots": 1,
                    "promotionQuestions": 2,
                    "sequence": previous_sequence + 1,
                    "seenQuestionIds": previous_ids + [experiment["question_id"]],
                    "entries": [],
                }
            response = {
                "status": "ok",
                "user_id": body["user_id"],
                "prompt": f"<memory_context>{memories}</memory_context>\nUser: {body['question']}",
                "retrieval_model": {
                    "providerId": "mock-provider",
                    "modelId": "mock-retrieval-medium",
                    "responseModels": ["mock-retrieval-2026-01-01"],
                    "thinkingLevel": "medium",
                    "transport": "non-stream",
                },
                "operator_experiment": operator_result,
            }
        elif self.path == "/chat/completions":
            self.__class__.last_chat_body = body
            if type(self).chat_failures_remaining:
                type(self).chat_failures_remaining -= 1
                payload = json.dumps({"detail": "synthetic answer failure"}).encode(
                    "utf-8"
                )
                self.send_response(503)
                self.send_header("content-type", "application/json")
                self.send_header("x-picorer-retryable", "false")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if type(self).chat_empty_remaining:
                type(self).chat_empty_remaining -= 1
                response = {"choices": [{"message": {"content": ""}}]}
            else:
                response = {"choices": [{"message": {"content": "France"}}]}
        else:
            self.send_error(404)
            return
        payload = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class HttpRunnerTests(unittest.TestCase):
    def setUp(self):
        MockHandler.chunks = {}
        MockHandler.paths = []
        MockHandler.operator_requests = []
        MockHandler.wrap_requests = []
        MockHandler.chat_failures_remaining = 0
        MockHandler.chat_empty_remaining = 0
        MockHandler.wrap_failures_remaining = 0
        MockHandler.reported_search_calls = 1
        MockHandler.runtime_contract = MOCK_RUNTIME_CONTRACT
        MockHandler.persistence_identity = "mock-persistence-instance"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_complete_black_box_run(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query(
                        question="Where is Normandy?",
                        answers=("France",),
                        qa_pair_id="qa-1",
                        question_id=None,
                        question_type=None,
                    ),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        memory = MemoryClient(http)
        chat = ChatClient(http, "mock-model")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            document = execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(output_path=output),
                chunker=lambda text, _size: [text],
            )
            persisted = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(document["completed_queries"], 1)
        self.assertEqual(persisted["metrics"]["official_score"], 1.0)
        self.assertEqual(
            persisted["data"][0]["retrieval_model"]["modelId"],
            "mock-retrieval-medium",
        )
        self.assertEqual(
            persisted["retrieval_model_audit"],
            {
                "audited_queries": 1,
                "unaudited_legacy_queries": 0,
                "models": [persisted["data"][0]["retrieval_model"]],
            },
        )
        self.assertEqual(persisted["operator_experiment"]["mode"], "static")
        self.assertEqual(
            MockHandler.paths,
            [
                "/memory/initialize",
                "/memory/add",
                "/memory/wrap_user_prompt",
                "/chat/completions",
            ],
        )
        chat_prompt = MockHandler.last_chat_body["messages"][1]["content"]
        self.assertIn("Normandy is in France", chat_prompt)
        self.assertNotIn('"answer"', json.dumps(MockHandler.last_chat_body).lower())
        self.assertEqual(
            MockHandler.wrap_requests[0]["answer_handoff"],
            "evidence-aware-v1",
        )
        self.assertEqual(
            persisted["answer_handoff"],
            EVIDENCE_AWARE_ANSWER_HANDOFF.handoff_id,
        )
        self.assertEqual(
            persisted["answer_prompt_version"],
            EVIDENCE_AWARE_ANSWER_HANDOFF.prompt_version,
        )
        self.assertEqual(len(persisted["answer_system_prompt_sha256"]), 64)

    def test_reuses_audited_ingestion_without_reinitializing_or_adding(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query(
                        question="Where is Normandy?",
                        answers=("France",),
                        qa_pair_id="qa-1",
                        question_id=None,
                        question_type=None,
                    ),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        memory = MemoryClient(http)
        chat = ChatClient(http, "mock-model")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            output = Path(directory) / "reused.json"
            execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(output_path=source),
                chunker=lambda text, _size: [text],
            )
            source_document = json.loads(source.read_text(encoding="utf-8"))
            MockHandler.paths = []

            reused = execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(
                    output_path=output,
                    reuse_ingestion_from=source,
                ),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(
            reused["context_ingestion_users"],
            source_document["context_ingestion_users"],
        )
        self.assertEqual(reused["ingestion_reuse"]["source"], str(source.resolve()))
        self.assertRegex(reused["ingestion_reuse"]["sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(
            MockHandler.paths,
            ["/memory/wrap_user_prompt", "/chat/completions"],
        )

    def test_ingestion_reuse_allows_a_new_retrieval_runtime_on_the_same_store(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(output_path=source),
                chunker=lambda text, _size: [text],
            )
            MockHandler.runtime_contract = {
                **MOCK_RUNTIME_CONTRACT,
                "source_identity": "new-retrieval-source",
            }
            MockHandler.paths = []
            reused = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=Path(directory) / "reused.json",
                    reuse_ingestion_from=source,
                ),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(
            reused["retrieval_runtime_contract"]["source_identity"],
            "new-retrieval-source",
        )
        self.assertEqual(
            MockHandler.paths,
            ["/memory/wrap_user_prompt", "/chat/completions"],
        )

    def test_ingestion_reuse_rejects_a_different_persistence_instance(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(output_path=source),
                chunker=lambda text, _size: [text],
            )
            MockHandler.persistence_identity = "different-store"
            with self.assertRaisesRegex(ValueError, "memory_persistence_identity"):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "mock-model"),
                    RunSettings(
                        output_path=Path(directory) / "reused.json",
                        reuse_ingestion_from=source,
                    ),
                    chunker=lambda text, _size: [text],
                )

    def test_reuses_ingestion_through_an_artifact_chain(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query(
                        question="Where is Normandy?",
                        answers=("France",),
                        qa_pair_id="qa-1",
                        question_id=None,
                        question_type=None,
                    ),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        memory = MemoryClient(http)
        chat = ChatClient(http, "mock-model")
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original.json"
            first_reuse = Path(directory) / "first-reuse.json"
            second_reuse = Path(directory) / "second-reuse.json"
            execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(output_path=original),
                chunker=lambda text, _size: [text],
            )
            first = execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(
                    output_path=first_reuse,
                    reuse_ingestion_from=original,
                ),
                chunker=lambda text, _size: [text],
            )
            MockHandler.paths = []
            second = execute_run(
                task,
                contexts,
                memory,
                chat,
                RunSettings(
                    output_path=second_reuse,
                    reuse_ingestion_from=first_reuse,
                ),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(
            second["context_ingestion_users"],
            first["context_ingestion_users"],
        )
        self.assertEqual(
            MockHandler.paths,
            ["/memory/wrap_user_prompt", "/chat/completions"],
        )

    def test_reasoning_answer_request_uses_configured_effort(self):
        http = JsonHttpClient(self.base_url, retries=0)
        chat = ChatClient(http, "gpt-5-mini", "medium", 4096)

        self.assertEqual(chat.complete("system", "question", 50), "France")

        self.assertEqual(MockHandler.last_chat_body["reasoning_effort"], "medium")
        self.assertEqual(MockHandler.last_chat_body["max_completion_tokens"], 4096)
        self.assertNotIn("temperature", MockHandler.last_chat_body)
        self.assertNotIn("max_tokens", MockHandler.last_chat_body)

    def test_answer_context_fit_preserves_whole_memories_and_question(self):
        blocks = [
            "<memory>\n"
            f"memory_id: m-{index}\ncontent:\n{'evidence ' * 500}\n"
            "</memory>"
            for index in range(6)
        ]
        prompt = (
            '<memory_context authority="read_exact_sources">\n'
            + "\n".join(blocks)
            + "\n</memory_context>\nUser: Which fact is current?"
        )

        fitted = fit_memory_prompt_to_context_window(
            "system",
            prompt,
            model="gpt-4o-mini-2024-07-18",
            context_window=2_000,
            max_output_tokens=256,
        )

        self.assertLess(len(fitted), len(prompt))
        self.assertIn("selected memories omitted", fitted)
        self.assertTrue(fitted.endswith("User: Which fact is current?"))
        self.assertEqual(fitted.count("<memory>"), fitted.count("</memory>"))

    def test_answer_context_fit_respects_configured_safety_reserve(self):
        blocks = [
            f"<memory>\nsource {index}: {'evidence ' * 300}\n</memory>"
            for index in range(12)
        ]
        prompt = (
            '<memory_context authority="read_exact_sources">\n'
            + "\n".join(blocks)
            + "\n</memory_context>\nUser: Which fact is current?"
        )

        ordinary = fit_memory_prompt_to_context_window(
            "system",
            prompt,
            model="unknown-model",
            context_window=3_000,
            max_output_tokens=256,
            safety_tokens=128,
        )
        conservative = fit_memory_prompt_to_context_window(
            "system",
            prompt,
            model="unknown-model",
            context_window=3_000,
            max_output_tokens=256,
            safety_tokens=1_024,
        )

        self.assertLess(len(conservative), len(ordinary))
        self.assertTrue(conservative.endswith("User: Which fact is current?"))
        self.assertEqual(
            conservative.count("<memory>"),
            conservative.count("</memory>"),
        )

    def test_unstructured_answer_overflow_fails_before_http(self):
        http = MagicMock()
        chat = ChatClient(
            http,
            "gpt-4o-mini-2024-07-18",
            "off",
            256,
            1_500,
        )

        with self.assertRaises(RemoteError) as raised:
            chat.complete("system", "unstructured " * 2_000, 50)

        self.assertEqual(raised.exception.error_code, "answer_context_overflow")
        http.post.assert_not_called()

    def test_empty_answer_is_a_final_zero_without_resampling(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        MockHandler.chat_empty_remaining = 1
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            result = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=Path(directory) / "result.json",
                    query_slots=2,
                ),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(result["data"][0]["output"], "")
        self.assertEqual(
            result["data"][0]["failure"]["error_code"],
            "empty_completion",
        )
        self.assertFalse(result["data"][0]["failure"]["retryable"])
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)
        self.assertEqual(MockHandler.paths.count("/chat/completions"), 1)

    def test_rejects_retrieval_model_drift_within_one_artifact(self):
        original = {
            "providerId": "provider",
            "modelId": "gpt-5-mini-medium",
            "responseModels": ["gpt-5-mini-2025-08-07"],
            "thinkingLevel": "medium",
            "transport": "non-stream",
        }
        document = {"data": [{"retrieval_model": original}]}
        changed = {**original, "modelId": "gpt-5-mini-fast"}
        with self.assertRaisesRegex(ValueError, "changed within one benchmark artifact"):
            _validate_retrieval_model_consistency(document, changed)

    def test_response_model_aliases_are_audited_without_false_identity_drift(self):
        original = {
            "providerId": "provider",
            "modelId": "gpt-4.1-mini",
            "responseModels": ["gpt-4.1-mini-2025-04-14"],
            "thinkingLevel": "off",
            "transport": "non-stream",
        }
        alias = {**original, "responseModels": ["gpt-4.1-mini"]}
        document = {
            "data": [
                {"metrics": {}, "retrieval_model": original},
                {"metrics": {}, "retrieval_model": alias},
            ],
            "pending_by_context": {},
        }
        _validate_retrieval_model_consistency(document, alias)
        _summarize(document)
        self.assertEqual(
            document["retrieval_model_audit"]["models"],
            [{
                "providerId": "provider",
                "modelId": "gpt-4.1-mini",
                "thinkingLevel": "off",
                "transport": "non-stream",
                "responseModels": [
                    "gpt-4.1-mini",
                    "gpt-4.1-mini-2025-04-14",
                ],
            }],
        )

    def test_all_ten_tasks_complete_over_the_http_boundary(self):
        for task_id in (
            "ruler-qa1",
            "longmemeval-s",
            "trec-coarse",
            "trec-fine",
            "banking77",
            "nlu",
            "clinic150",
            "fact-sh-6k",
            "fact-mh-6k",
            "eventqa-64k",
        ):
            with self.subTest(task=task_id):
                MockHandler.chunks = {}
                MockHandler.paths = []
                task = replace(
                    task_config(task_id), expected_contexts=1, expected_questions=1
                )
                contexts = (
                    Context(
                        ordinal=0,
                        text="Normandy is in France.",
                        queries=(
                            Query(
                                question="Where is Normandy?",
                                answers=("France",),
                                qa_pair_id=f"{task_id}-qa-1",
                                question_id="question-1",
                                question_type="multi-session",
                            ),
                        ),
                    ),
                )
                http = JsonHttpClient(self.base_url, retries=0)
                with tempfile.TemporaryDirectory() as directory:
                    document = execute_run(
                        task,
                        contexts,
                        MemoryClient(http),
                        ChatClient(http, "mock-model"),
                        RunSettings(output_path=Path(directory) / f"{task_id}.json"),
                        chunker=lambda text, _size: [text],
                    )
                self.assertEqual(document["completed_queries"], 1)
                self.assertEqual(
                    MockHandler.paths,
                    [
                        "/memory/initialize",
                        "/memory/add",
                        "/memory/wrap_user_prompt",
                        "/chat/completions",
                    ],
                )

    def test_resume_uses_context_qualified_identity_and_restores_cumulative_state(self):
        task = replace(
            task_config("eventqa-64k"), expected_contexts=2, expected_questions=2
        )
        duplicate = Query(
            question="Where is Normandy?",
            answers=("France",),
            qa_pair_id="eventqa_65536_no0",
            question_id=None,
            question_type=None,
        )
        contexts = (
            Context(ordinal=0, text="Normandy is in France.", queries=(duplicate,)),
            Context(ordinal=1, text="Normandy is in France.", queries=(duplicate,)),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaises(RunInterrupted):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "mock-model"),
                    RunSettings(
                        output_path=output,
                        operator_mode="cumulative",
                        interruption_requested=lambda: (
                            MockHandler.paths.count("/chat/completions") == 1
                        ),
                    ),
                    chunker=lambda text, _size: [text],
                )
            first = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(first["completed_queries"], 1)
            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    resume=True,
                    operator_mode="cumulative",
                ),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 2)
        self.assertEqual(
            {row["benchmark_query_id"] for row in resumed["data"]},
            {
                "context-0/eventqa_65536_no0",
                "context-1/eventqa_65536_no0",
            },
        )

    def test_operator_state_is_only_reused_by_cumulative_mode(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=2)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query("Q1?", ("France",), "qa-1", None, None),
                    Query("Q2?", ("France",), "qa-2", None, None),
                ),
            ),
        )
        for mode in ("static", "ephemeral", "cumulative"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                MockHandler.operator_requests = []
                http = JsonHttpClient(self.base_url, retries=0)
                document = execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "mock-model"),
                    RunSettings(
                        output_path=Path(directory) / "result.json",
                        operator_mode=mode,
                    ),
                    chunker=lambda text, _size: [text],
                )
                first, second = MockHandler.operator_requests
                self.assertNotIn("evolution_snapshot", first)
                if mode == "cumulative":
                    self.assertEqual(second["evolution_snapshot"]["sequence"], 1)
                    self.assertEqual(
                        second["evolution_snapshot"]["seenQuestionIds"],
                        ["context-0/qa-1"],
                    )
                    self.assertEqual(
                        document["operator_evolution_states"]["0"]["sequence"], 2
                    )
                else:
                    self.assertNotIn("evolution_snapshot", second)
                    self.assertEqual(document["operator_evolution_states"], {})

    def test_resume_restores_completed_cumulative_state_within_a_context(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=2)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query("Q1?", ("France",), "qa-1", None, None),
                    Query("Q2?", ("France",), "qa-2", None, None),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaises(RunInterrupted):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "mock-model"),
                    RunSettings(
                        output_path=output,
                        operator_mode="cumulative",
                        interruption_requested=lambda: (
                            MockHandler.paths.count("/chat/completions") == 1
                        ),
                    ),
                    chunker=lambda text, _size: [text],
                )
            first = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(first["operator_evolution_states"]["0"]["sequence"], 1)
            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    resume=True,
                    operator_mode="cumulative",
                ),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 2)
        self.assertEqual(MockHandler.operator_requests[1]["evolution_snapshot"]["sequence"], 1)
        self.assertEqual(resumed["operator_evolution_states"]["0"]["sequence"], 2)
        self.assertEqual(len(resumed["context_ingestion_timestamps"]), 1)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)

    def test_resume_upgrades_legacy_partial_output_without_reingesting_context(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=2)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query("Q1?", ("France",), "qa-1", None, None),
                    Query("Q2?", ("France",), "qa-2", None, None),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaises(RunInterrupted):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "mock-model"),
                    RunSettings(
                        output_path=output,
                        interruption_requested=lambda: (
                            MockHandler.paths.count("/chat/completions") == 1
                        ),
                    ),
                    chunker=lambda text, _size: [text],
                )
            legacy = json.loads(output.read_text(encoding="utf-8"))
            legacy.pop("context_ingestion_users")
            output.write_text(json.dumps(legacy), encoding="utf-8")

            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output, resume=True),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(resumed["completed_queries"], 2)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 2)
        self.assertEqual(len(resumed["context_ingestion_users"]), 1)

    def test_answer_failure_is_scored_once_without_retry_until_success(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            MockHandler.chat_failures_remaining = 1
            failed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output, operator_mode="cumulative"),
                chunker=lambda text, _size: [text],
            )
            self.assertEqual(failed["completed_queries"], 1)
            self.assertEqual(failed["data"][0]["output"], "")
            self.assertEqual(failed["data"][0]["metrics"]["official_score"], 0.0)
            self.assertEqual(failed["data"][0]["failure"]["stage"], "answer")
            self.assertNotIn("pending", failed)
            before_resume = list(MockHandler.paths)
            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    resume=True,
                    operator_mode="cumulative",
                ),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 1)
        self.assertNotIn("pending", resumed)
        self.assertEqual(MockHandler.paths, before_resume)
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)
        self.assertEqual(MockHandler.paths.count("/chat/completions"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)

    def test_retryable_retrieval_failure_pauses_without_scoring_and_resumes(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class FlakyMemory:
            def __init__(self):
                self.http = http
                self.memory_system_name = "picorer"
                self.answer_handoff = EVIDENCE_AWARE_ANSWER_HANDOFF
                self.wrap_calls = 0

            def initialize(self, user_id):
                MemoryClient(http).initialize(user_id)

            def add(self, user_id, chunk):
                MemoryClient(http).add(user_id, chunk)

            def wrap(self, *_args, **_kwargs):
                self.wrap_calls += 1
                if self.wrap_calls == 1:
                    raise RemoteError(
                        "temporary provider outage",
                        http_status=503,
                        error_code="upstream_unavailable",
                        retryable=True,
                    )
                return MemoryWrapResult(
                    prompt="Normandy is in France.",
                    operator_experiment={
                        "mode": "static",
                        "questionId": "context-0/qa-1",
                        "maxSearchCalls": 4,
                        "metrics": {"searchCalls": 1},
                    },
                    retrieval_model={
                        "providerId": "mock-provider",
                        "modelId": "mock-retrieval-medium",
                        "responseModels": ["mock-retrieval-2026-01-01"],
                        "thinkingLevel": "medium",
                        "transport": "non-stream",
                    },
                )

        memory = FlakyMemory()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaises(RetryableRunUnavailable):
                execute_run(
                    task,
                    contexts,
                    memory,
                    ChatClient(http, "mock-model"),
                    RunSettings(output_path=output),
                    chunker=lambda text, _size: [text],
                )
            interrupted = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(interrupted["completed_queries"], 0)
            self.assertEqual(interrupted["failures"], [])
            self.assertEqual(interrupted["last_retryable_failure"]["http_status"], 503)
            resumed = execute_run(
                task,
                contexts,
                memory,
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output, resume=True),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 1)
        self.assertNotIn("last_retryable_failure", resumed)
        self.assertEqual(memory.wrap_calls, 2)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)

    @patch("mab_adapter.runner.time.sleep", return_value=None)
    @patch("mab_adapter.runner.random.uniform", return_value=0)
    def test_retries_explicit_retryable_ingestion_failure_without_reinitializing(
        self, _mocked_jitter, _mocked_sleep
    ):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class FlakyIngestionMemory:
            def __init__(self):
                self.http = http
                self.memory_system_name = "picorer"
                self.answer_handoff = EVIDENCE_AWARE_ANSWER_HANDOFF
                self.add_calls = 0

            def initialize(self, user_id):
                MemoryClient(http).initialize(user_id)

            def add(self, user_id, chunk):
                self.add_calls += 1
                if self.add_calls <= 2:
                    raise RemoteError(
                        "temporary embedding outage",
                        http_status=503,
                        error_code="upstream_unavailable",
                        retryable=True,
                    )
                MemoryClient(http).add(user_id, chunk)

            def wrap(self, *args, **kwargs):
                return MemoryClient(http).wrap(*args, **kwargs)

        memory = FlakyIngestionMemory()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            document = execute_run(
                task,
                contexts,
                memory,
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(document["completed_queries"], 1)
        self.assertEqual(memory.add_calls, 3)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)
        self.assertEqual(
            document["execution"]["infrastructure_retry_counts"]["ingestion_add"],
            2,
        )
        self.assertEqual(
            document["execution"]["infrastructure_retry_policy_history"][-1][
                "explicit_ingestion_http"
            ],
            "unbounded",
        )

    def test_retryable_answer_failure_keeps_exact_pending_retrieval(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class FlakyAnswer:
            def __init__(self):
                self.http = http
                self.model = "mock-model"
                self.calls = 0

            def complete(self, *_args):
                self.calls += 1
                if self.calls == 1:
                    raise RemoteError(
                        "temporary answer outage",
                        http_status=503,
                        error_code="upstream_unavailable",
                        retryable=True,
                    )
                return "France"

        chat = FlakyAnswer()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaises(RetryableRunUnavailable):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    chat,
                    RunSettings(output_path=output),
                    chunker=lambda text, _size: [text],
                )
            interrupted = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(interrupted["completed_queries"], 0)
            self.assertEqual(
                interrupted["pending_by_context"]["0"]["benchmark_query_id"],
                "context-0/qa-1",
            )
            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                chat,
                RunSettings(output_path=output, resume=True),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 1)
        self.assertEqual(chat.calls, 2)
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)

    def test_untyped_answer_outages_checkpoint_and_resume_the_same_pending_prompt(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        cases = (
            ("http-408", 408),
            ("http-429", 429),
            ("http-503", 503),
            ("transport", None),
        )

        for query_slots in (1, 2):
            for case, http_status in cases:
                with self.subTest(query_slots=query_slots, case=case):
                    adaptive = (
                        AdaptiveConcurrencyConfig(
                            minimum=1,
                            initial=2,
                            maximum=2,
                            successes_per_increase=100,
                        )
                        if query_slots > 1
                        else None
                    )

                    class FlakyAnswer:
                        def __init__(self):
                            self.http = http
                            self.model = "mock-model"
                            self.calls = 0
                            self.prompts: list[str] = []

                        def complete(self, _system, prompt, _max_tokens):
                            self.calls += 1
                            self.prompts.append(prompt)
                            if self.calls == 1:
                                raise RemoteError(
                                    f"untyped {case} answer outage",
                                    http_status=http_status,
                                    retryable=True,
                                    retryability_explicit=False,
                                )
                            return "France"

                    chat = FlakyAnswer()
                    wrap_calls_before = MockHandler.paths.count(
                        "/memory/wrap_user_prompt"
                    )
                    with tempfile.TemporaryDirectory() as directory:
                        output = Path(directory) / "result.json"
                        with self.assertRaises(RetryableRunUnavailable):
                            execute_run(
                                task,
                                contexts,
                                MemoryClient(http),
                                chat,
                                RunSettings(
                                    output_path=output,
                                    query_slots=query_slots,
                                    adaptive_query_slots=adaptive,
                                ),
                                chunker=lambda text, _size: [text],
                            )
                        interrupted = json.loads(output.read_text(encoding="utf-8"))
                        pending = (
                            interrupted["pending_by_query"]
                            if query_slots > 1
                            else interrupted["pending_by_context"]
                        )
                        self.assertEqual(interrupted["completed_queries"], 0)
                        self.assertEqual(interrupted["failures"], [])
                        self.assertEqual(len(pending), 1)
                        self.assertEqual(chat.calls, 1)
                        failure = interrupted["last_retryable_failure"]
                        self.assertEqual(failure["stage"], "answer")
                        self.assertFalse(failure["retryability_explicit"])
                        if http_status is None:
                            self.assertNotIn("http_status", failure)
                        else:
                            self.assertEqual(failure["http_status"], http_status)
                        policy = interrupted["execution"][
                            "infrastructure_retry_policy_history"
                        ][-1]
                        self.assertEqual(
                            policy["answer_untyped_http_statuses"],
                            [408, 429, "5xx"],
                        )
                        self.assertEqual(
                            policy["answer_untyped_transport_failure"],
                            "checkpoint-and-suite-resume",
                        )
                        self.assertEqual(
                            policy["answer_http_retry_before_checkpoint"], 0
                        )
                        self.assertEqual(
                            policy["answer_untyped_outage_load_control"],
                            "aimd-decrease-before-checkpoint",
                        )
                        if adaptive is not None:
                            lanes = interrupted["execution"][
                                "adaptive_query_concurrency"
                            ]["stages"]
                            self.assertEqual(lanes["answer"]["current_limit"], 1)
                            self.assertEqual(lanes["answer"]["retryable_failures"], 1)
                            self.assertEqual(lanes["retrieval"]["current_limit"], 2)
                            self.assertEqual(
                                lanes["retrieval"]["retryable_failures"], 0
                            )

                        resumed = execute_run(
                            task,
                            contexts,
                            MemoryClient(http),
                            chat,
                            RunSettings(
                                output_path=output,
                                query_slots=query_slots,
                                adaptive_query_slots=adaptive,
                                resume=True,
                            ),
                            chunker=lambda text, _size: [text],
                        )

                    self.assertEqual(resumed["completed_queries"], 1)
                    self.assertEqual(resumed["data"][0]["output"], "France")
                    self.assertEqual(chat.calls, 2)
                    self.assertEqual(chat.prompts[0], chat.prompts[1])
                    if adaptive is not None:
                        lanes = resumed["execution"]["adaptive_query_concurrency"][
                            "stages"
                        ]
                        self.assertEqual(lanes["answer"]["current_limit"], 1)
                        self.assertEqual(lanes["retrieval"]["current_limit"], 2)
                    self.assertEqual(
                        MockHandler.paths.count("/memory/wrap_user_prompt")
                        - wrap_calls_before,
                        1,
                    )

    def test_process_interruption_resumes_the_exact_pending_retrieval(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class InterruptedChat:
            def __init__(self):
                self.http = http
                self.model = "mock-model"

            def complete(self, *_args):
                raise RuntimeError("synthetic process interruption")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaisesRegex(RuntimeError, "process interruption"):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    InterruptedChat(),
                    RunSettings(output_path=output, operator_mode="cumulative"),
                    chunker=lambda text, _size: [text],
                )
            interrupted = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                interrupted["pending_by_context"]["0"]["benchmark_query_id"],
                "context-0/qa-1",
            )
            self.assertEqual(interrupted["operator_evolution_states"]["0"]["sequence"], 1)

            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    resume=True,
                    operator_mode="cumulative",
                ),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 1)
        self.assertEqual(resumed["data"][0]["output"], "France")
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)
        self.assertEqual(MockHandler.paths.count("/chat/completions"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)

    def test_graceful_interruption_after_ingestion_does_not_repeat_memory_writes(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaises(RunInterrupted):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "mock-model"),
                    RunSettings(
                        output_path=output,
                        interruption_requested=lambda: (
                            MockHandler.paths.count("/memory/add") == 1
                        ),
                    ),
                    chunker=lambda text, _size: [text],
                )
            interrupted = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(interrupted["data"], [])
            self.assertNotIn("pending", interrupted)
            self.assertEqual(interrupted["pending_by_context"], {})
            self.assertEqual(
                interrupted["context_ingestion_users"]["0"],
                next(iter(MockHandler.chunks)),
            )

            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output, resume=True),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 1)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)

    def test_termination_overlapping_answer_error_keeps_query_pending(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        termination_requested = False

        class InterruptedAnswer:
            def __init__(self):
                self.http = http
                self.model = "mock-model"

            def complete(self, *_args):
                nonlocal termination_requested
                termination_requested = True
                raise RemoteError("transport ended while terminating")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaises(RunInterrupted):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    InterruptedAnswer(),
                    RunSettings(
                        output_path=output,
                        operator_mode="cumulative",
                        interruption_requested=lambda: termination_requested,
                    ),
                    chunker=lambda text, _size: [text],
                )
            interrupted = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(interrupted["data"], [])
            self.assertEqual(interrupted["failures"], [])
            self.assertEqual(
                interrupted["pending_by_context"]["0"]["benchmark_query_id"],
                "context-0/qa-1",
            )

            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    resume=True,
                    operator_mode="cumulative",
                ),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(resumed["completed_queries"], 1)
        self.assertEqual(resumed["data"][0]["output"], "France")
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)

    def test_context_slots_parallelize_only_independent_contexts(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=2, expected_questions=2)
        contexts = tuple(
            Context(
                ordinal=index,
                text=f"Context {index} says France.",
                queries=(
                    Query("Where?", ("France",), f"qa-{index}", None, None),
                ),
            )
            for index in range(2)
        )
        http = JsonHttpClient(self.base_url, retries=0)
        rendezvous = threading.Barrier(2, timeout=5)

        class ConcurrentAnswer:
            def __init__(self):
                self.http = http
                self.model = "mock-model"

            def complete(self, *_args):
                rendezvous.wait()
                return "France"

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            result = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ConcurrentAnswer(),
                RunSettings(output_path=output, context_slots=2),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(result["completed_queries"], 2)
        self.assertEqual([row["context_id"] for row in result["data"]], [0, 1])
        self.assertEqual(result["execution"]["context_slots_history"], [2])

    def test_query_slots_parallelize_static_questions_within_one_context(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=2)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query("Where is Normandy?", ("France",), "qa-1", None, None),
                    Query("Which country?", ("France",), "qa-2", None, None),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class ParallelChat:
            def __init__(self):
                self.http = http
                self.model = "mock-model"
                self.barrier = threading.Barrier(2)
                self.lock = threading.Lock()
                self.active = 0
                self.maximum_active = 0

            def complete(self, *_args):
                with self.lock:
                    self.active += 1
                    self.maximum_active = max(self.maximum_active, self.active)
                self.barrier.wait(timeout=2)
                with self.lock:
                    self.active -= 1
                return "France"

        chat = ParallelChat()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            result = execute_run(
                task,
                contexts,
                MemoryClient(http),
                chat,
                RunSettings(output_path=output, query_slots=2),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(result["completed_queries"], 2)
        self.assertEqual(chat.maximum_active, 2)
        self.assertEqual(result["pending_by_query"], {})
        self.assertEqual(result["execution"]["query_slots_history"], [2])
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 2)
        self.assertEqual(result["pending_by_context"], {})

    def test_stage_adaptive_slots_share_only_the_overall_worker_cap(self):
        task = replace(
            task_config("ruler-qa1"),
            expected_contexts=1,
            expected_questions=6,
        )
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=tuple(
                    Query("Where?", ("France",), f"qa-{index}", None, None)
                    for index in range(6)
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class ProviderLoad:
            def __init__(self):
                self.lock = threading.Lock()
                self.active = 0
                self.maximum_active = 0

            def call(self):
                with self.lock:
                    self.active += 1
                    self.maximum_active = max(self.maximum_active, self.active)
                time.sleep(0.03)
                with self.lock:
                    self.active -= 1

        load = ProviderLoad()

        class ControlledMemory:
            def __init__(self):
                self.http = http
                self.memory_system_name = "picorer"
                self.answer_handoff = EVIDENCE_AWARE_ANSWER_HANDOFF

            def initialize(self, user_id):
                MemoryClient(http).initialize(user_id)

            def add(self, user_id, chunk):
                MemoryClient(http).add(user_id, chunk)

            def wrap(self, _user_id, _question, **kwargs):
                load.call()
                return MemoryWrapResult(
                    prompt="Normandy is in France.",
                    operator_experiment={
                        "mode": kwargs["operator_mode"],
                        "questionId": kwargs["question_id"],
                        "maxSearchCalls": kwargs["max_search_calls"],
                        "metrics": {"searchCalls": 1},
                    },
                    retrieval_model={
                        "providerId": "mock-provider",
                        "modelId": "mock-retrieval-medium",
                        "responseModels": ["mock-retrieval-2026-01-01"],
                        "thinkingLevel": "medium",
                        "transport": "non-stream",
                    },
                )

        class ControlledAnswer:
            def __init__(self):
                self.http = http
                self.model = "mock-model"

            def complete(self, *_args):
                load.call()
                return "France"

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            result = execute_run(
                task,
                contexts,
                ControlledMemory(),
                ControlledAnswer(),
                RunSettings(
                    output_path=output,
                    query_slots=4,
                    adaptive_query_slots=AdaptiveStageConcurrencyConfig(
                        retrieval=AdaptiveConcurrencyConfig(
                            minimum=1,
                            initial=2,
                            maximum=2,
                            successes_per_increase=100,
                        ),
                        answer=AdaptiveConcurrencyConfig(
                            minimum=1,
                            initial=3,
                            maximum=3,
                            successes_per_increase=100,
                        ),
                    ),
                ),
                chunker=lambda text, _size: [text],
            )

        adaptive = result["execution"]["adaptive_query_concurrency"]
        self.assertEqual(result["completed_queries"], 6)
        self.assertEqual(load.maximum_active, 4)
        self.assertEqual(adaptive["schema_version"], 3)
        self.assertEqual(adaptive["overall_query_slots"], 4)
        for stage, expected_limit in (("retrieval", 2), ("answer", 3)):
            self.assertEqual(
                adaptive["stages"][stage]["current_limit"], expected_limit
            )
            self.assertLessEqual(
                adaptive["stages"][stage]["peak_in_flight"], expected_limit
            )
            self.assertEqual(
                adaptive["stages"][stage]["successful_operations"], 6
            )

    @patch("mab_adapter.runner.time.sleep", return_value=None)
    @patch("mab_adapter.runner.random.uniform", return_value=0)
    def test_retryable_retrieval_failure_does_not_reduce_answer_limit(
        self, _mocked_jitter, _mocked_sleep
    ):
        task = replace(
            task_config("ruler-qa1"), expected_contexts=1, expected_questions=1
        )
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class FlakyMemory:
            def __init__(self):
                self.http = http
                self.memory_system_name = "picorer"
                self.answer_handoff = EVIDENCE_AWARE_ANSWER_HANDOFF
                self.wrap_calls = 0

            def initialize(self, user_id):
                MemoryClient(http).initialize(user_id)

            def add(self, user_id, chunk):
                MemoryClient(http).add(user_id, chunk)

            def wrap(self, *args, **kwargs):
                self.wrap_calls += 1
                if self.wrap_calls == 1:
                    raise RemoteError(
                        "temporary provider outage",
                        http_status=503,
                        error_code="upstream_unavailable",
                        retryable=True,
                    )
                return MemoryClient(http).wrap(*args, **kwargs)

        memory = FlakyMemory()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            result = execute_run(
                task,
                contexts,
                memory,
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    query_slots=2,
                    adaptive_query_slots=AdaptiveConcurrencyConfig(
                        minimum=1,
                        initial=2,
                        maximum=2,
                        successes_per_increase=100,
                    ),
                ),
                chunker=lambda text, _size: [text],
            )

        adaptive = result["execution"]["adaptive_query_concurrency"]
        self.assertEqual(result["completed_queries"], 1)
        self.assertEqual(memory.wrap_calls, 2)
        retrieval = adaptive["stages"]["retrieval"]
        answer = adaptive["stages"]["answer"]
        self.assertEqual(retrieval["current_limit"], 1)
        self.assertEqual(retrieval["retryable_failures"], 1)
        self.assertEqual(retrieval["changes"][0]["reason"], "retryable_failure")
        self.assertEqual(answer["current_limit"], 2)
        self.assertEqual(answer["retryable_failures"], 0)

    @patch("mab_adapter.runner.time.sleep", return_value=None)
    @patch("mab_adapter.runner.random.uniform", return_value=0)
    def test_answer_429_isolated_and_reuses_pending_wrap(
        self, _mocked_jitter, _mocked_sleep
    ):
        task = replace(
            task_config("ruler-qa1"), expected_contexts=1, expected_questions=1
        )
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class FlakyAnswer:
            def __init__(self):
                self.http = http
                self.model = "mock-model"
                self.calls = 0
                self.prompts: list[str] = []

            def complete(self, _system, prompt, _max_tokens):
                self.calls += 1
                self.prompts.append(prompt)
                if self.calls == 1:
                    raise RemoteError(
                        "temporary answer throttling",
                        http_status=429,
                        retryable=True,
                    )
                return "France"

        chat = FlakyAnswer()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            result = execute_run(
                task,
                contexts,
                MemoryClient(http),
                chat,
                RunSettings(
                    output_path=output,
                    query_slots=2,
                    adaptive_query_slots=AdaptiveConcurrencyConfig(
                        minimum=1,
                        initial=2,
                        maximum=2,
                        successes_per_increase=100,
                    ),
                ),
                chunker=lambda text, _size: [text],
            )

        adaptive = result["execution"]["adaptive_query_concurrency"]
        retrieval = adaptive["stages"]["retrieval"]
        answer = adaptive["stages"]["answer"]
        self.assertEqual(result["completed_queries"], 1)
        self.assertEqual(chat.calls, 2)
        self.assertEqual(chat.prompts[0], chat.prompts[1])
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)
        self.assertEqual(result["pending_by_query"], {})
        self.assertEqual(answer["current_limit"], 1)
        self.assertEqual(answer["retryable_failures"], 1)
        self.assertEqual(retrieval["current_limit"], 2)
        self.assertEqual(retrieval["retryable_failures"], 0)

    def test_resume_migrates_legacy_shared_aimd_without_rerunning_wrap(self):
        task = replace(
            task_config("ruler-qa1"), expected_contexts=1, expected_questions=1
        )
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        config = AdaptiveConcurrencyConfig(
            minimum=1,
            initial=2,
            maximum=2,
            successes_per_increase=100,
        )

        class InterruptedAnswer:
            def __init__(self):
                self.http = http
                self.model = "mock-model"

            def complete(self, *_args):
                raise RuntimeError("synthetic answer interruption")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            with self.assertRaisesRegex(RuntimeError, "answer interruption"):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    InterruptedAnswer(),
                    RunSettings(
                        output_path=output,
                        query_slots=2,
                        adaptive_query_slots=config,
                    ),
                    chunker=lambda text, _size: [text],
                )
            interrupted = json.loads(output.read_text(encoding="utf-8"))
            self.assertIn("context-0/qa-1", interrupted["pending_by_query"])
            interrupted["execution"]["adaptive_query_concurrency"] = {
                "schema_version": 2,
                "minimum": 1,
                "initial": 2,
                "maximum": 2,
                "successes_per_increase": 100,
                "current_limit": 1,
            }
            output.write_text(json.dumps(interrupted), encoding="utf-8")

            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    resume=True,
                    query_slots=2,
                    adaptive_query_slots=config,
                ),
                chunker=lambda text, _size: [text],
            )

        adaptive = resumed["execution"]["adaptive_query_concurrency"]
        self.assertEqual(adaptive["schema_version"], 3)
        self.assertEqual(adaptive["stages"]["retrieval"]["current_limit"], 2)
        self.assertEqual(adaptive["stages"]["answer"]["current_limit"], 2)
        migrations = resumed["execution"][
            "adaptive_query_concurrency_migrations"
        ]
        self.assertEqual(len(migrations), 1)
        self.assertEqual(migrations[0]["from_schema_version"], 2)
        self.assertEqual(MockHandler.paths.count("/memory/wrap_user_prompt"), 1)

    def test_resume_audits_only_the_incompatible_v3_lane_reset(self):
        task = replace(
            task_config("ruler-qa1"), expected_contexts=1, expected_questions=1
        )
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        config = AdaptiveStageConcurrencyConfig(
            retrieval=AdaptiveConcurrencyConfig(1, 2, 4, 100),
            answer=AdaptiveConcurrencyConfig(1, 2, 4, 100),
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    query_slots=4,
                    adaptive_query_slots=config,
                ),
                chunker=lambda text, _size: [text],
            )
            document = json.loads(output.read_text(encoding="utf-8"))
            stages = document["execution"]["adaptive_query_concurrency"]["stages"]
            stages["retrieval"]["maximum"] = 99
            stages["answer"]["current_limit"] = 1
            output.write_text(json.dumps(document), encoding="utf-8")
            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    resume=True,
                    query_slots=4,
                    adaptive_query_slots=config,
                ),
                chunker=lambda text, _size: [text],
            )

        adaptive = resumed["execution"]["adaptive_query_concurrency"]
        self.assertEqual(adaptive["stages"]["retrieval"]["current_limit"], 2)
        self.assertEqual(adaptive["stages"]["answer"]["current_limit"], 1)
        self.assertEqual(
            resumed["execution"]["adaptive_query_concurrency_migrations"],
            [{
                "from_schema_version": 3,
                "to_schema_version": 3,
                "stage": "retrieval",
                "reason": "incompatible-single-lane-state-reset",
            }],
        )

    def test_retrieval_failure_is_scored_once_and_the_run_continues(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=2)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query("First?", ("France",), "qa-1", None, None),
                    Query("Second?", ("France",), "qa-2", None, None),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            MockHandler.wrap_failures_remaining = 1
            document = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output),
                chunker=lambda text, _size: [text],
            )
            before_resume = list(MockHandler.paths)
            resumed = execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output, resume=True),
                chunker=lambda text, _size: [text],
            )
        self.assertEqual(document["completed_queries"], 2)
        self.assertEqual(document["data"][0]["output"], "")
        self.assertEqual(document["data"][0]["failure"]["stage"], "retrieval")
        self.assertEqual(document["data"][0]["failure"]["http_status"], 422)
        self.assertEqual(
            document["data"][0]["failure"]["error_code"],
            "retrieval_agent_protocol_error",
        )
        self.assertFalse(document["data"][0]["failure"]["retryable"])
        self.assertEqual(
            document["data"][0]["failure"]["diagnostics"]["retrieval"]["runId"],
            "safe-run-id",
        )
        self.assertEqual(document["data"][0]["metrics"]["official_score"], 0.0)
        self.assertEqual(document["data"][1]["output"], "France")
        self.assertEqual(MockHandler.paths, before_resume)
        self.assertEqual(resumed["completed_queries"], 2)

    def test_resume_never_requeues_a_non_retryable_method_timeout(self):
        task = replace(
            task_config("ruler-qa1"), expected_contexts=1, expected_questions=1
        )
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)

        class TimeoutOnceMemory:
            def __init__(self):
                self.http = http
                self.memory_system_name = "picorer"
                self.answer_handoff = EVIDENCE_AWARE_ANSWER_HANDOFF
                self.calls = 0

            def initialize(self, user_id):
                MemoryClient(http).initialize(user_id)

            def add(self, user_id, chunk):
                MemoryClient(http).add(user_id, chunk)

            def wrap(self, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise RemoteError(
                        "retrieval exceeded its run budget",
                        http_status=504,
                        error_code="retrieval_agent_timeout",
                        retryable=False,
                    )
                return MemoryClient(http).wrap(*args, **kwargs)

        memory = TimeoutOnceMemory()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            first = execute_run(
                task,
                contexts,
                memory,
                ChatClient(http, "mock-model"),
                RunSettings(output_path=output, query_slots=2),
                chunker=lambda text, _size: [text],
            )
            self.assertEqual(first["completed_queries"], 1)
            self.assertEqual(
                first["data"][0]["failure"]["error_code"],
                "retrieval_agent_timeout",
            )
            self.assertFalse(first["data"][0]["failure"]["retryable"])
            self.assertEqual(first["retryable_failures"], [])
            resumed = execute_run(
                task,
                contexts,
                memory,
                ChatClient(http, "mock-model"),
                RunSettings(
                    output_path=output,
                    query_slots=2,
                    resume=True,
                ),
                chunker=lambda text, _size: [text],
            )

        self.assertEqual(resumed["completed_queries"], 1)
        self.assertEqual(resumed["data"][0]["output"], "")
        self.assertEqual(
            resumed["data"][0]["failure"]["error_code"],
            "retrieval_agent_timeout",
        )
        self.assertEqual(memory.calls, 1)
        self.assertEqual(MockHandler.paths.count("/memory/initialize"), 1)
        self.assertEqual(MockHandler.paths.count("/memory/add"), 1)

    def test_rejects_a_server_report_that_exceeds_the_search_budget(self):
        MockHandler.reported_search_calls = 5
        client = MemoryClient(JsonHttpClient(self.base_url, retries=0))
        client.initialize("user-1")
        with self.assertRaisesRegex(RemoteError, "search-call budget"):
            client.wrap(
                "user-1",
                "question",
                question_id="context-0/qa-1",
                operator_mode="static",
                max_search_calls=4,
                evolution_snapshot=None,
            )

    def test_resume_rejects_changed_run_identity(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query(
                        question="Where is Normandy?",
                        answers=("France",),
                        qa_pair_id="qa-1",
                        question_id=None,
                        question_type=None,
                    ),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "model-a"),
                RunSettings(output_path=output),
                chunker=lambda text, _size: [text],
            )
            with self.assertRaisesRegex(ValueError, "answer_model"):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "model-b"),
                    RunSettings(output_path=output, resume=True),
                    chunker=lambda text, _size: [text],
                )

    def test_resume_rejects_a_changed_retrieval_runtime(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(Query("Where?", ("France",), "qa-1", None, None),),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "model-a"),
                RunSettings(output_path=output),
                chunker=lambda text, _size: [text],
            )
            MockHandler.runtime_contract = {
                **MOCK_RUNTIME_CONTRACT,
                "source_identity": "changed-source",
            }
            before = list(MockHandler.paths)
            with self.assertRaisesRegex(
                ValueError,
                "retrieval_runtime_contract",
            ):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "model-a"),
                    RunSettings(output_path=output, resume=True),
                    chunker=lambda text, _size: [text],
                )
            self.assertEqual(MockHandler.paths, before)

    def test_runtime_contract_requires_source_and_build_identity(self):
        client = MemoryClient(JsonHttpClient(self.base_url, retries=0))
        MockHandler.runtime_contract = {
            key: value
            for key, value in MOCK_RUNTIME_CONTRACT.items()
            if key != "source_identity"
        }

        with self.assertRaisesRegex(RemoteError, "violates the contract"):
            client.runtime_identity()

    def test_runtime_contract_accepts_disabled_retries_but_rejects_invalid_limits(self):
        client = MemoryClient(JsonHttpClient(self.base_url, retries=0))
        for field in ("request_max_retries", "request_max_retry_delay_ms"):
            for value in (0, -1, True):
                with self.subTest(field=field, value=value):
                    MockHandler.runtime_contract = {
                        **MOCK_RUNTIME_CONTRACT,
                        "limits": {**MOCK_RUNTIME_CONTRACT["limits"], field: value},
                    }
                    if value == 0:
                        contract, _, _ = client.runtime_identity()
                        self.assertEqual(contract["limits"][field], 0)
                    else:
                        with self.assertRaisesRegex(RemoteError, "violates the contract"):
                            client.runtime_identity()


    def test_resume_rejects_changed_answer_handoff_contract_before_http(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query(
                        question="Where is Normandy?",
                        answers=("France",),
                        qa_pair_id="qa-1",
                        question_id=None,
                        question_type=None,
                    ),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "model-a"),
                RunSettings(output_path=output),
                chunker=lambda text, _size: [text],
            )
            before_resume = list(MockHandler.paths)
            changed = AnswerHandoffContract(
                handoff_id=EVIDENCE_AWARE_ANSWER_HANDOFF.handoff_id,
                prompt_version="memoryarena-public-evidence-aware-test-v2",
            )
            with self.assertRaisesRegex(ValueError, "answer_prompt_version"):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http, answer_handoff=changed),
                    ChatClient(http, "model-a"),
                    RunSettings(output_path=output, resume=True),
                    chunker=lambda text, _size: [text],
                )
            changed_id = AnswerHandoffContract(
                handoff_id="evidence-aware-test-v2",
                prompt_version=EVIDENCE_AWARE_ANSWER_HANDOFF.prompt_version,
            )
            with self.assertRaisesRegex(ValueError, "answer_handoff"):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http, answer_handoff=changed_id),
                    ChatClient(http, "model-a"),
                    RunSettings(output_path=output, resume=True),
                    chunker=lambda text, _size: [text],
                )
        self.assertEqual(MockHandler.paths, before_resume)

    def test_resume_rejects_artifact_without_answer_prompt_identity(self):
        task = replace(task_config("ruler-qa1"), expected_contexts=1, expected_questions=1)
        contexts = (
            Context(
                ordinal=0,
                text="Normandy is in France.",
                queries=(
                    Query(
                        question="Where is Normandy?",
                        answers=("France",),
                        qa_pair_id="qa-1",
                        question_id=None,
                        question_type=None,
                    ),
                ),
            ),
        )
        http = JsonHttpClient(self.base_url, retries=0)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            execute_run(
                task,
                contexts,
                MemoryClient(http),
                ChatClient(http, "model-a"),
                RunSettings(output_path=output),
                chunker=lambda text, _size: [text],
            )
            document = json.loads(output.read_text(encoding="utf-8"))
            del document["answer_prompt_version"]
            output.write_text(json.dumps(document), encoding="utf-8")
            before_resume = list(MockHandler.paths)
            with self.assertRaisesRegex(ValueError, "answer_prompt_version"):
                execute_run(
                    task,
                    contexts,
                    MemoryClient(http),
                    ChatClient(http, "model-a"),
                    RunSettings(output_path=output, resume=True),
                    chunker=lambda text, _size: [text],
                )
        self.assertEqual(MockHandler.paths, before_resume)

    @patch("mab_adapter.clients.time.sleep", return_value=None)
    @patch("mab_adapter.clients.urlopen")
    def test_retries_remote_disconnect(self, mocked_urlopen, _mocked_sleep):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"status":"ok"}'
        mocked_urlopen.side_effect = [
            RemoteDisconnected("upstream closed the connection"),
            response,
        ]

        value = JsonHttpClient("https://example.invalid", retries=1).post(
            "/endpoint", {"value": 1}
        )

        self.assertEqual(value, {"status": "ok"})
        self.assertEqual(mocked_urlopen.call_count, 2)

    @patch("mab_adapter.clients.time.sleep", return_value=None)
    @patch("mab_adapter.clients.urlopen")
    def test_retries_json_http_error_without_corrupting_request_body(
        self, mocked_urlopen, _mocked_sleep
    ):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"status":"ok"}'
        mocked_urlopen.side_effect = [
            HTTPError(
                "https://example.invalid/endpoint",
                503,
                "Unavailable",
                {},
                BytesIO(b'{"detail":"try again"}'),
            ),
            response,
        ]

        value = JsonHttpClient("https://example.invalid", retries=1).post(
            "/endpoint", {"value": 1}
        )

        self.assertEqual(value, {"status": "ok"})
        self.assertEqual(mocked_urlopen.call_count, 2)
        second_request = mocked_urlopen.call_args_list[1].args[0]
        self.assertEqual(json.loads(second_request.data), {"value": 1})

    @patch("mab_adapter.clients.time.sleep", return_value=None)
    @patch("mab_adapter.clients.urlopen")
    def test_preserves_typed_non_retryable_http_failure(
        self, mocked_urlopen, _mocked_sleep
    ):
        body = {
            "detail": "Picorer retrieval agent exceeded its run time limit",
            "error_code": "retrieval_agent_timeout",
            "retryable": False,
            "diagnostics": {"retrieval": {"runId": "safe-run-id", "turns": 2}},
        }
        mocked_urlopen.side_effect = HTTPError(
            "https://example.invalid/endpoint",
            504,
            "Gateway Timeout",
            {
                "x-picorer-error-code": "retrieval_agent_timeout",
                "x-picorer-retryable": "false",
            },
            BytesIO(json.dumps(body).encode("utf-8")),
        )

        with self.assertRaises(RemoteError) as raised:
            JsonHttpClient("https://example.invalid", retries=3).post(
                "/endpoint", {"value": 1}
            )

        self.assertEqual(mocked_urlopen.call_count, 1)
        self.assertEqual(raised.exception.http_status, 504)
        self.assertEqual(raised.exception.error_code, "retrieval_agent_timeout")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(raised.exception.diagnostics, body["diagnostics"])
        self.assertIn("[retrieval_agent_timeout]", str(raised.exception))

    @patch("mab_adapter.clients.urlopen")
    def test_untyped_answer_http_outages_are_retryable_but_not_explicit(
        self, mocked_urlopen
    ):
        for status in (408, 429, 503):
            with self.subTest(status=status):
                mocked_urlopen.reset_mock()
                mocked_urlopen.side_effect = HTTPError(
                    "https://example.invalid/endpoint",
                    status,
                    "Temporary answer outage",
                    {},
                    BytesIO(b'{"detail":"try later"}'),
                )

                with self.assertRaises(RemoteError) as raised:
                    JsonHttpClient("https://example.invalid", retries=0).post(
                        "/endpoint", {"value": 1}
                    )

                self.assertEqual(mocked_urlopen.call_count, 1)
                self.assertEqual(raised.exception.http_status, status)
                self.assertTrue(raised.exception.retryable)
                self.assertFalse(raised.exception.retryability_explicit)

    @patch("mab_adapter.clients.urlopen")
    def test_untyped_answer_transport_failure_is_one_shot(self, mocked_urlopen):
        mocked_urlopen.side_effect = RemoteDisconnected(
            "upstream closed the connection"
        )

        with self.assertRaises(RemoteError) as raised:
            JsonHttpClient("https://example.invalid", retries=0).post(
                "/endpoint", {"value": 1}
            )

        self.assertEqual(mocked_urlopen.call_count, 1)
        self.assertIsNone(raised.exception.http_status)
        self.assertTrue(raised.exception.retryable)
        self.assertFalse(raised.exception.retryability_explicit)

    def test_method_clients_disable_generic_http_resampling(self):
        http = MagicMock()
        http.post.side_effect = [
            {"status": "ok", "user_id": "user-1"},
            {"choices": [{"message": {"content": "France"}}]},
        ]

        MemoryClient(http).initialize("user-1")
        prediction = ChatClient(http, "answer-model").complete(
            "system", "prompt", 128
        )

        self.assertEqual(prediction, "France")
        self.assertEqual(http.post.call_args_list[0].kwargs["retries"], 0)
        self.assertEqual(http.post.call_args_list[1].kwargs["retries"], 0)


if __name__ == "__main__":
    unittest.main()
