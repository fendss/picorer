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

from upstream.audit_proxy import MemoryAuditProxy, validate_lifecycle  # noqa: E402
from upstream.contracts import UpstreamExecutionError  # noqa: E402


class _Gateway(BaseHTTPRequestHandler):
    requests: list[tuple[str, dict]] = []
    fail_add = False

    def log_message(self, format, *args):
        return

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        payload = json.loads(body)
        type(self).requests.append((self.path, payload))
        if type(self).fail_add and self.path == "/memory/add":
            response = b'{"detail":"rate limited"}'
            self.send_response(429)
            self.send_header("Retry-After", "7")
            self.send_header("x-picorer-retryable", "true")
        else:
            response = b'{"status":"ok"}'
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def _post(url: str, path: str, payload: dict):
    request = urllib.request.Request(
        url + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request) as response:
            return response.status, dict(response.headers)
    except urllib.error.HTTPError as error:
        error.read()
        return error.code, dict(error.headers)


class UpstreamAuditProxyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        _Gateway.requests = []
        _Gateway.fail_add = False
        self.gateway = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
        thread = threading.Thread(target=self.gateway.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.gateway.server_close)
        self.addCleanup(self.gateway.shutdown)
        host, port = self.gateway.server_address
        self.gateway_url = f"http://{host}:{port}"

    def test_exact_search_lifecycle_is_attributed_to_one_fresh_scope(self):
        scope = "run/task/attempt-1"
        with MemoryAuditProxy(
            upstream_url=self.gateway_url,
            memory_scope=scope,
            audit_path=self.root / "audit.json",
            gold_answers=["hidden"],
        ) as proxy:
            base = {"user_id": scope + "::search-1", "memory_system_name": "picorer"}
            _post(proxy.url, "/memory/initialize", base)
            _post(proxy.url, "/memory/wrap_user_prompt", {**base, "question": "q1"})
            _post(proxy.url, "/memory/add", {**base, "chunk": "observed result"})
            _post(proxy.url, "/memory/wrap_user_prompt", {**base, "question": "q2"})
            summary = validate_lifecycle(
                proxy.events, suite="progressive_search", question_count=2
            )
        self.assertEqual(summary["counts"], {
            "initialize": 1, "wrap_user_prompt": 2, "add": 1
        })
        persisted = json.loads((self.root / "audit.json").read_text(encoding="utf-8"))
        self.assertNotIn("observed result", json.dumps(persisted))

    def test_retry_headers_survive_and_error_fails_lifecycle(self):
        _Gateway.fail_add = True
        scope = "scope-a"
        with MemoryAuditProxy(
            upstream_url=self.gateway_url,
            memory_scope=scope,
            audit_path=self.root / "failed.json",
            gold_answers=[],
        ) as proxy:
            status, headers = _post(
                proxy.url,
                "/memory/add",
                {"user_id": scope + "::u", "memory_system_name": "picorer", "chunk": "x"},
            )
            self.assertEqual(status, 429)
            self.assertEqual(headers["Retry-After"], "7")
            self.assertEqual(headers["x-picorer-retryable"], "true")
            with self.assertRaises(UpstreamExecutionError):
                validate_lifecycle(proxy.events, suite="progressive_search", question_count=1)

    def test_retry_attempt_scopes_cannot_share_official_user_generation(self):
        observed = []
        for index in (1, 2):
            scope = f"run/task/attempt-{index}"
            with MemoryAuditProxy(
                upstream_url=self.gateway_url,
                memory_scope=scope,
                audit_path=self.root / f"audit-{index}.json",
                gold_answers=[],
            ) as proxy:
                _post(proxy.url, "/memory/initialize", {
                    "user_id": scope + "::deterministic-upstream-id",
                    "memory_system_name": "picorer",
                })
                observed.append(proxy.events[0].user_id)
        self.assertNotEqual(observed[0], observed[1])

    def test_unscoped_or_explicit_reference_payload_never_reaches_gateway(self):
        with MemoryAuditProxy(
            upstream_url=self.gateway_url,
            memory_scope="scope",
            audit_path=self.root / "guard.json",
            gold_answers=["answer"],
        ) as proxy:
            status, _ = _post(proxy.url, "/memory/add", {
                "user_id": "scope::u",
                "memory_system_name": "picorer",
                "chunk": 'reference answer: "answer"',
            })
            self.assertEqual(status, 422)
        self.assertEqual(_Gateway.requests, [])


if __name__ == "__main__":
    unittest.main()
