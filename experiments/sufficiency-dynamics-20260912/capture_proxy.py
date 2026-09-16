#!/usr/bin/env python3
"""Transparent OpenAI-compatible request/response capture proxy.

The proxy intentionally leaves request bodies byte-for-byte unchanged.  It stores
one directory per HTTP request and never persists inbound authorization headers.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import signal
import ssl
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode(
        "utf-8"
    )


class CaptureState:
    def __init__(
        self,
        capture_root: Path,
        upstream_host: str,
        upstream_port: int,
        ca_bundle: Path,
        timeout_seconds: float,
    ) -> None:
        self.capture_root = capture_root
        self.upstream_host = upstream_host
        self.upstream_port = upstream_port
        self.timeout_seconds = timeout_seconds
        self.started_at = time.time()
        self.lock = threading.Lock()
        self.started = 0
        self.completed = 0
        self.failed = 0
        self.in_flight = 0
        self.tls_context = ssl.create_default_context(cafile=str(ca_bundle))

    def begin(self) -> None:
        with self.lock:
            self.started += 1
            self.in_flight += 1

    def end(self, failed: bool) -> None:
        with self.lock:
            self.in_flight -= 1
            self.completed += 1
            if failed:
                self.failed += 1

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "status": "ok",
                "started_at_unix": self.started_at,
                "upstream": f"https://{self.upstream_host}:{self.upstream_port}",
                "capture_root": str(self.capture_root),
                "requests": {
                    "started": self.started,
                    "completed": self.completed,
                    "failed": self.failed,
                    "in_flight": self.in_flight,
                },
            }


STATE: CaptureState


class Server(ThreadingHTTPServer):
    request_queue_size = 512
    daemon_threads = True
    block_on_close = False

    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        tls_context: ssl.SSLContext,
    ) -> None:
        self.tls_context = tls_context
        super().__init__(server_address, handler)

    def process_request_thread(
        self, request: Any, client_address: tuple[str, int]
    ) -> None:
        tls_request = None
        try:
            tls_request = self.tls_context.wrap_socket(request, server_side=True)
            self.finish_request(tls_request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(tls_request if tls_request is not None else request)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path == "/__capture_status":
            body = json_bytes(STATE.snapshot())
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.forward()

    def do_POST(self) -> None:
        self.forward()

    def forward(self) -> None:
        request_started_unix = time.time()
        request_started_monotonic = time.monotonic()
        request_id = f"{time.time_ns()}-{uuid.uuid4().hex}"
        capture_dir = STATE.capture_root / request_id
        length = int(self.headers.get("Content-Length", "0"))
        request_body = self.rfile.read(length) if length else b""
        write_atomic(capture_dir / "request.body", request_body)

        initial_meta: dict[str, Any] = {
            "schema_version": 1,
            "request_id": request_id,
            "request_started_at_unix": request_started_unix,
            "method": self.command,
            "path": self.path,
            "request_content_type": self.headers.get("Content-Type"),
            "request_content_length": len(request_body),
            "request_sha256": sha256(request_body),
            "authorization_persisted": False,
            "capture_state": "in_flight",
        }
        write_atomic(capture_dir / "meta.json", json_bytes(initial_meta))

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "host"
        }
        headers["Host"] = f"{STATE.upstream_host}:{STATE.upstream_port}"
        connection = http.client.HTTPSConnection(
            STATE.upstream_host,
            STATE.upstream_port,
            timeout=STATE.timeout_seconds,
            context=STATE.tls_context,
        )
        STATE.begin()
        failed = False
        try:
            connection.request(self.command, self.path, body=request_body, headers=headers)
            response = connection.getresponse()
            response_body = response.read()
            response_headers = response.getheaders()
            write_atomic(capture_dir / "response.body", response_body)

            self.send_response(response.status, response.reason)
            for key, value in response_headers:
                if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "content-length":
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)

            safe_response_headers = {
                key.lower(): value
                for key, value in response_headers
                if key.lower()
                in {
                    "content-type",
                    "date",
                    "server",
                    "x-qwen-upstream",
                    "x-request-id",
                }
            }
            final_meta = {
                **initial_meta,
                "capture_state": "complete",
                "request_completed_at_unix": time.time(),
                "duration_seconds": round(
                    time.monotonic() - request_started_monotonic, 6
                ),
                "response_status": response.status,
                "response_reason": response.reason,
                "response_headers": safe_response_headers,
                "response_content_length": len(response_body),
                "response_sha256": sha256(response_body),
            }
            write_atomic(capture_dir / "meta.json", json_bytes(final_meta))
        except Exception as error:
            failed = True
            error_body = repr(error).encode("utf-8", "replace")
            write_atomic(capture_dir / "response.body", error_body)
            final_meta = {
                **initial_meta,
                "capture_state": "failed",
                "request_completed_at_unix": time.time(),
                "duration_seconds": round(
                    time.monotonic() - request_started_monotonic, 6
                ),
                "error_type": type(error).__name__,
                "error": repr(error),
                "response_content_length": len(error_body),
                "response_sha256": sha256(error_body),
            }
            write_atomic(capture_dir / "meta.json", json_bytes(final_meta))
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(error_body)))
            self.end_headers()
            self.wfile.write(error_body)
        finally:
            STATE.end(failed)
            connection.close()

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--upstream-host", default="127.0.0.1")
    parser.add_argument("--upstream-port", type=int, required=True)
    parser.add_argument("--ca-bundle", type=Path, required=True)
    parser.add_argument("--server-cert", type=Path, required=True)
    parser.add_argument("--server-key", type=Path, required=True)
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=1260)
    return parser.parse_args()


def main() -> None:
    global STATE
    args = parse_args()
    args.capture_root.mkdir(parents=True, exist_ok=True)
    STATE = CaptureState(
        capture_root=args.capture_root.resolve(),
        upstream_host=args.upstream_host,
        upstream_port=args.upstream_port,
        ca_bundle=args.ca_bundle.resolve(),
        timeout_seconds=args.timeout_seconds,
    )
    server_tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_tls_context.load_cert_chain(
        certfile=str(args.server_cert.resolve()),
        keyfile=str(args.server_key.resolve()),
    )
    server = Server((args.host, args.port), Handler, server_tls_context)

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
