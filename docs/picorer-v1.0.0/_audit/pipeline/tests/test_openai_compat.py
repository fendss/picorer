from __future__ import annotations

from question_pipeline.openai_compat import CompletionClient


class Response:
    status_code = 200
    ok = True
    text = ""

    def json(self):
        return {
            "model": "gpt-4o-2024-05-13",
            "choices": [{"message": {"content": "judge output"}}],
            "usage": {"total_tokens": 12},
        }


class Session:
    def __init__(self):
        self.call = None

    def post(self, *args, **kwargs):
        self.call = (args, kwargs)
        return Response()


def test_official_infbench_request_parameters(monkeypatch):
    model = {
        "id": "gpt-4o-2024-05-13",
        "base_url": "https://api.invalid/v1",
        "thinking_level": "off",
        "temperature": 0.1,
        "top_p": 0.9,
        "seed": 42,
        "timeout_seconds": 600,
    }
    monkeypatch.setattr(
        "question_pipeline.openai_compat.resolve_model",
        lambda _payload, _name: model,
    )
    session = Session()
    client = CompletionClient()
    client._session = lambda: session
    completion = client.complete(
        {}, "judge", [{"role": "user", "content": "prompt"}], 4096
    )
    _args, kwargs = session.call
    assert kwargs["json"] == {
        "model": "gpt-4o-2024-05-13",
        "messages": [{"role": "user", "content": "prompt"}],
        "max_tokens": 4096,
        "temperature": 0.1,
        "top_p": 0.9,
        "seed": 42,
    }
    assert completion.text == "judge output"
    assert completion.usage == {"total_tokens": 12}
