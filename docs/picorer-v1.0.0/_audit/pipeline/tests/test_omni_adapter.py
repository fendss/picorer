from __future__ import annotations

from question_pipeline.adapters.omnimemeval import OmniMemEvalAdapter
from question_pipeline.eval_config import bind


class Response:
    status_code = 200
    ok = True
    text = ""

    def json(self):
        return {"choices": [{"message": {"content": "answer"}}]}


class Session:
    def __init__(self):
        self.calls = []

    def post(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return Response()


def test_answer_request_uses_adapter_session(tmp_path):
    env = tmp_path / "answer.env"
    env.write_text(
        "ANSWER_BASE_URL=http://answer.invalid/v1\n"
        "ANSWER_MODEL=qwen\n"
        "ANSWER_API_KEY=test\n"
    )
    adapter = OmniMemEvalAdapter()
    adapter._answer_session = lambda: Session()
    assert adapter._answer_request({"env_file": str(env)}, "prompt") == "answer"


def test_configured_completion_uses_dataset_model_and_prompt_boundary(
    tmp_path, monkeypatch
):
    config = tmp_path / "eval.yaml"
    config.write_text(
        "schema_version: 1\n"
        "models:\n"
        "  answer: {id: qwen, base_url_env: TEST_QWEN_URL, thinking_level: low}\n"
        "  judge: {id: judge, base_url: 'http://judge.invalid/v1'}\n"
        "prompts:\n"
        "  answer: {user: '${context} ${question}'}\n"
        "  binary: {user: '${question} ${golden_answer} ${response}'}\n"
        "datasets:\n"
        "  omnimemeval/locomo:\n"
        "    answer: {model: answer, prompt: answer, max_tokens: 99}\n"
        "    judge: {method: binary, model: judge, prompt: binary}\n"
    )
    monkeypatch.setenv("TEST_QWEN_URL", "http://answer.invalid/v1")
    payload = {
        "env_file": "unused.env",
        "eval_config": bind(config, "omnimemeval/locomo"),
    }
    session = Session()
    adapter = OmniMemEvalAdapter()
    adapter._answer_session = lambda: session
    assert adapter._answer_request(payload, "configured prompt") == "answer"
    args, kwargs = session.calls[0]
    assert args[0] == "http://answer.invalid/v1/chat/completions"
    assert kwargs["json"] == {
        "model": "qwen",
        "messages": [{"role": "user", "content": "configured prompt"}],
        "reasoning_effort": "low",
        "max_completion_tokens": 99,
    }
