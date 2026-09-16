from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import ArtifactStore  # noqa: E402
from upstream.judge_proxy import JudgeCacheProxy  # noqa: E402


class _Provider(BaseHTTPRequestHandler):
    responses: list[tuple[int, dict]] = []
    paths: list[str] = []

    def log_message(self, format, *args):
        return

    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).paths.append(self.path)
        status, value = type(self).responses.pop(0)
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _post(base: str, body: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


class UpstreamJudgeProxyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = ArtifactStore(self.root / "run", "run-1")
        _Provider.responses = []
        _Provider.paths = []
        self.provider = ThreadingHTTPServer(("127.0.0.1", 0), _Provider)
        thread = threading.Thread(target=self.provider.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.provider.server_close)
        self.addCleanup(self.provider.shutdown)
        self.origin = f"http://127.0.0.1:{self.provider.server_address[1]}"
        self.request = {
            "model": "judge-model",
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "Product name:\nfixture marker"},
            ],
            "temperature": 0,
        }

    def _proxy(self, name: str, base: str | None = None) -> JudgeCacheProxy:
        return JudgeCacheProxy(
            upstream_base_url=base or self.origin,
            api_key="test-key",
            store=self.store,
            adapter_version="test-adapter",
            audit_path=self.root / f"{name}.json",
            attribution_markers={
                "/v1/chat/completions": [
                    ("Product name:\nfixture marker", "bundled_shopping/000")
                ]
            },
        )

    def test_all_2xx_responses_replay_as_an_ordered_sequence(self):
        invalid = {
            "id": "r1", "model": "judge-model",
            "choices": [{"message": {"content": "not valid JSON"}}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2},
        }
        valid = {
            "id": "r2", "model": "judge-model",
            "choices": [{"message": {"content": '{"matches":[]}'}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3},
        }
        _Provider.responses = [(200, invalid), (200, valid)]
        first = self._proxy("first").start()
        try:
            self.assertEqual(_post(first.url, self.request)[1], invalid)
            self.assertEqual(_post(first.url, self.request)[1], valid)
        finally:
            first.close()
        second = self._proxy("second", self.origin + "/v1").start()
        try:
            self.assertEqual(_post(second.url, self.request)[1], invalid)
            self.assertEqual(_post(second.url, self.request)[1], valid)
        finally:
            second.close()
        self.assertEqual(_Provider.paths, ["/v1/chat/completions"] * 2)
        usage_lines = (self.store.usage_dir / "events.jsonl").read_text().splitlines()
        self.assertEqual(len(usage_lines), 2)
        self.assertTrue(all(json.loads(line)["task_key"] == "bundled_shopping/000" for line in usage_lines))

    def test_failed_provider_usage_is_retry_overhead_and_not_cached(self):
        failure = {
            "id": "failed", "model": "judge-model",
            "error": {"message": "limited"},
            "usage": {"prompt_tokens": 2, "completion_tokens": 0},
        }
        success = {
            "id": "ok", "model": "judge-model",
            "choices": [{"message": {"content": '{"matches":[]}'}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1},
        }
        _Provider.responses = [(429, failure), (200, success)]
        proxy = self._proxy("failure").start()
        try:
            self.assertEqual(_post(proxy.url, self.request)[0], 429)
            self.assertEqual(_post(proxy.url, self.request)[0], 200)
        finally:
            proxy.close()
        usage = [json.loads(line) for line in (self.store.usage_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual(
            [event["disposition_hint"] for event in usage],
            ["retry_overhead", "accepted_evaluation"],
        )


if __name__ == "__main__":
    unittest.main()
