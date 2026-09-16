from __future__ import annotations

import sys
import types

from question_pipeline.adapters.memoryagentbench import MemoryAgentBenchAdapter
from question_pipeline.contracts import RetryableStageError
from question_pipeline.eval_config import bind
from question_pipeline.openai_compat import Completion


class RemoteError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        http_status=None,
        error_code=None,
        retryable=None,
        retryability_explicit=None,
    ):
        super().__init__(message)
        self.http_status = http_status
        self.error_code = error_code
        self.retryable = retryable
        self.retryability_explicit = retryability_explicit


def install_remote_error(monkeypatch):
    package = types.ModuleType("mab_adapter")
    clients = types.ModuleType("mab_adapter.clients")
    clients.RemoteError = RemoteError
    package.clients = clients
    monkeypatch.setitem(sys.modules, "mab_adapter", package)
    monkeypatch.setitem(sys.modules, "mab_adapter.clients", clients)


def test_retrieval_protocol_failure_is_bounded_retry(monkeypatch):
    install_remote_error(monkeypatch)
    error = RemoteError(
        "agent stopped without finish",
        http_status=422,
        error_code="retrieval_agent_protocol_error",
        retryable=False,
        retryability_explicit=True,
    )
    translated = MemoryAgentBenchAdapter._translate(error, "retrieval")
    assert isinstance(translated, RetryableStageError)


def test_unrelated_retrieval_422_remains_nonretryable(monkeypatch):
    install_remote_error(monkeypatch)
    error = RemoteError(
        "bad request",
        http_status=422,
        error_code="invalid_request",
        retryable=False,
        retryability_explicit=True,
    )
    assert MemoryAgentBenchAdapter._translate(error, "retrieval") is error


def test_protocol_error_is_not_retried_during_answer(monkeypatch):
    install_remote_error(monkeypatch)
    error = RemoteError(
        "agent stopped without finish",
        http_status=422,
        error_code="retrieval_agent_protocol_error",
        retryable=False,
        retryability_explicit=True,
    )
    assert MemoryAgentBenchAdapter._translate(error, "answer") is error


def test_longmemeval_selects_question_type_prompt(tmp_path):
    config = tmp_path / "eval.yaml"
    config.write_text(
        "schema_version: 1\n"
        "models:\n"
        "  answer: {id: answer, base_url: 'http://answer.invalid/v1'}\n"
        "  judge: {id: judge, base_url: 'http://judge.invalid/v1'}\n"
        "prompts:\n"
        "  answer: {user: '${retrieval}'}\n"
        "  update: {user: '${question} ${golden_answer} ${response}'}\n"
        "datasets:\n"
        "  agentmemorybench/longmemeval-s:\n"
        "    answer: {model: answer, prompt: answer}\n"
        "    judge:\n"
        "      method: longmemeval\n"
        "      model: judge\n"
        "      prompt_family: {knowledge-update: update}\n"
    )

    class Chat:
        def complete(self, payload, model, messages, max_tokens):
            assert payload["question"] == "Question"
            assert model == "judge"
            assert messages == [{
                "role": "user",
                "content": "Question ['Answer'] Prediction",
            }]
            assert max_tokens == 10
            return Completion("yes", "judge", {"total_tokens": 1})

    payload = {
        "question": "Question",
        "question_id": "question-1",
        "question_type": "knowledge-update",
        "answers": ["Answer"],
        "eval_config": bind(config, "agentmemorybench/longmemeval-s"),
    }
    adapter = MemoryAgentBenchAdapter()
    adapter._judge_client = Chat()
    result = adapter._longmemeval_judge(
        payload,
        "Prediction",
        {"model": "judge", "prompt_family": {"knowledge-update": "update"}},
    )
    assert result.output["metrics"]["official_score"] == 1.0
    assert result.output["judge_prompt"] == "update"
