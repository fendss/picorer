import importlib.util
import json
from pathlib import Path
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "integrations"
    / "tau-knowledge"
    / "provider_health.py"
)
SPEC = importlib.util.spec_from_file_location("tau_provider_health", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)


class TauKnowledgeProviderHealthTests(unittest.TestCase):
    def test_waits_without_persisting_key_then_accepts_dated_alias(self):
        responses = iter(
            [
                (
                    503,
                    json.dumps({"error": {"type": "v_api_biz_error"}}).encode(),
                ),
                (200, json.dumps({"model": "gpt-5.2-2025-12-11"}).encode()),
            ]
        )
        requests = []
        sleeps = []

        def transport(request, timeout):
            requests.append((request, timeout))
            return next(responses)

        report = health.wait_for_openai_chat_model(
            endpoint="https://provider.example/v1",
            api_key="secret-test-key",
            model="gpt-5.2",
            attempts=2,
            delay=60,
            timeout=30,
            transport=transport,
            sleep=sleeps.append,
        )
        self.assertTrue(report["available"])
        self.assertEqual(report["attempt"], 2)
        self.assertEqual(report["response_model"], "gpt-5.2-2025-12-11")
        self.assertEqual(sleeps, [60])
        self.assertNotIn("secret-test-key", json.dumps(report))
        self.assertEqual(requests[0][1], 30)
        self.assertEqual(
            requests[0][0].get_header("Authorization"),
            "Bearer secret-test-key",
        )

    def test_reports_exhausted_provider_without_response_body(self):
        def unavailable(_request, _timeout):
            return 503, json.dumps(
                {"error": {"type": "v_api_biz_error", "message": "internal"}}
            ).encode()

        report = health.wait_for_openai_chat_model(
            endpoint="https://provider.example/v1",
            api_key="secret-test-key",
            model="gpt-5.2",
            attempts=1,
            delay=0,
            timeout=30,
            transport=unavailable,
        )
        self.assertFalse(report["available"])
        self.assertEqual(
            report["failures"][0]["error"],
            "provider unavailable (HTTP 503, v_api_biz_error)",
        )
        self.assertNotIn("internal", json.dumps(report))

    def test_rejects_unexpected_model_resolution(self):
        def wrong_model(_request, _timeout):
            return 200, json.dumps({"model": "gpt-4o-mini"}).encode()

        report = health.wait_for_openai_chat_model(
            endpoint="https://provider.example/v1",
            api_key="key",
            model="gpt-5.2",
            attempts=1,
            delay=0,
            timeout=30,
            transport=wrong_model,
        )
        self.assertFalse(report["available"])
        self.assertIn("unexpected model", report["failures"][0]["error"])


if __name__ == "__main__":
    unittest.main()
