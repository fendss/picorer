from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


OFFICIAL_REVISION = "6cd9de14b71915e39ac742a20dc33785e14b6aab"
OFFICIAL_CLIENT_SHA256 = (
    "9efc1c037c9b94d4b17e5d69c4ed80bd5ad7c7f982688b56903b7e0116d62bff"
)
OFFICIAL_CLIENT_SOURCE = b'''import requests
from typing import Optional


class MemoryClient:
    """Thin client for the MemActBench memory API."""

    def __init__(
        self,
        user_id: str,
        memory_system_name: str = "mirix",
        base_url: str = "http://0.0.0.0:8000",
        session: Optional[requests.Session] = None,
        timeout: int = 300,
    ):
        self.user_id = str(user_id)
        self.memory_system_name = memory_system_name
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout
        self._post(
            "/memory/initialize",
            {"user_id": self.user_id, "memory_system_name": self.memory_system_name},
        )

    def wrap_user_prompt(self, question: str) -> str:
        """Request a prompt wrapped with memory context."""
        data = self._post(
            "/memory/wrap_user_prompt",
            {
                "user_id": self.user_id,
                "memory_system_name": self.memory_system_name,
                "question": question,
            },
        )
        return data["prompt"]

    def add(self, chunk: str) -> dict:
        """Add a chunk to the user's memory."""
        return self._post(
            "/memory/add",
            {"user_id": self.user_id, "memory_system_name": self.memory_system_name, "chunk": chunk},
        )

    def _post(self, path: str, payload: dict) -> dict:
        response = self.session.post(
            f"{self.base_url}{path}", json=payload, timeout=self.timeout
        )
        response.raise_for_status()
        return response.json()
'''


class _Response:
    def __init__(self, status: int, body: bytes):
        self.status_code = status
        self._body = body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}: {self._body.decode('utf-8')}")

    def json(self) -> dict:
        value = json.loads(self._body)
        if not isinstance(value, dict):
            raise TypeError("Memory API response must be a JSON object")
        return value


class StdlibSession:
    """The requests.Session surface used by the unmodified official client."""

    def __init__(self):
        # Local compatibility tests must not inherit macOS/system HTTP proxies.
        self._opener = build_opener(ProxyHandler({}))

    def post(self, url: str, *, json: dict, timeout: int) -> _Response:
        request = Request(
            url,
            data=(__import__("json").dumps(json).encode("utf-8")),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                return _Response(response.status, response.read())
        except HTTPError as error:
            return _Response(error.code, error.read())


def load_official_memory_client():
    digest = hashlib.sha256(OFFICIAL_CLIENT_SOURCE).hexdigest()
    if digest != OFFICIAL_CLIENT_SHA256:
        raise AssertionError(
            f"Official memory/client.py fixture drifted at {OFFICIAL_REVISION}: {digest}"
        )
    temporary = tempfile.TemporaryDirectory()
    source_path = Path(temporary.name) / "client.py"
    source_path.write_bytes(OFFICIAL_CLIENT_SOURCE)

    requests_stub = types.ModuleType("requests")
    requests_stub.Session = StdlibSession
    previous = sys.modules.get("requests")
    sys.modules["requests"] = requests_stub
    try:
        spec = importlib.util.spec_from_file_location(
            "memoryarena_official_memory_client", source_path
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("Cannot load official MemoryArena memory client")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        if previous is None:
            sys.modules.pop("requests", None)
        else:
            sys.modules["requests"] = previous
        temporary.cleanup()
    return module.MemoryClient


def exercise_server(base_url: str) -> dict:
    memory_client = load_official_memory_client()
    client = memory_client(
        "official-client-e2e",
        memory_system_name="picorer",
        base_url=base_url,
        session=StdlibSession(),
        timeout=10,
    )
    empty = client.wrap_user_prompt("Empty?")
    first_add = client.add("first raw chunk")
    after_first = client.wrap_user_prompt("What is first?")
    second_add = client.add("second <raw> chunk")
    after_second = client.wrap_user_prompt("What changed?")
    return {
        "empty": empty,
        "first_add": first_add,
        "after_first": after_first,
        "second_add": second_add,
        "after_second": after_second,
    }


class _FixtureHandler(BaseHTTPRequestHandler):
    chunks: list[str] = []
    requests: list[tuple[str, dict]] = []

    def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length))
        type(self).requests.append((self.path, payload))
        user_id = payload["user_id"]
        if self.path == "/memory/initialize":
            type(self).chunks = []
            body = {
                "status": "ok",
                "user_id": user_id,
                "memory_system_name": payload["memory_system_name"],
            }
        elif self.path == "/memory/add":
            type(self).chunks.append(payload["chunk"])
            body = {"status": "ok", "user_id": user_id, "response": None}
        elif self.path == "/memory/wrap_user_prompt":
            rendered = "None" if not type(self).chunks else "\n".join(
                f"<memory>{chunk}</memory>" for chunk in type(self).chunks
            )
            body = {
                "status": "ok",
                "user_id": user_id,
                "prompt": (
                    f"<memory_context>\n{rendered}\n</memory_context>\n"
                    f"User: {payload['question']}"
                ),
            }
        else:
            self.send_error(404)
            return
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format: str, *_args) -> None:
        return


class OfficialClientCompatibilityTests(unittest.TestCase):
    def test_pinned_unmodified_client_runs_full_memory_lifecycle(self):
        _FixtureHandler.chunks = []
        _FixtureHandler.requests = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _FixtureHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        host, port = server.server_address
        result = exercise_server(f"http://{host}:{port}")

        self.assertEqual(
            result["empty"],
            "<memory_context>\nNone\n</memory_context>\nUser: Empty?",
        )
        self.assertEqual(result["first_add"]["response"], None)
        self.assertEqual(result["second_add"]["response"], None)
        self.assertEqual(
            [path for path, _payload in _FixtureHandler.requests],
            [
                "/memory/initialize",
                "/memory/wrap_user_prompt",
                "/memory/add",
                "/memory/wrap_user_prompt",
                "/memory/add",
                "/memory/wrap_user_prompt",
            ],
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exercise-server")
    args, remaining = parser.parse_known_args()
    if args.exercise_server:
        print(json.dumps(exercise_server(args.exercise_server), sort_keys=True))
        return 0
    unittest.main(argv=[sys.argv[0], *remaining])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
