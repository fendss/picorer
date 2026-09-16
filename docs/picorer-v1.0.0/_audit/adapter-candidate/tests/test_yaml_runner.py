from __future__ import annotations

import json
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / "integrations" / "memoryagentbench" / "run_from_yaml.mjs"


def _config(adaptive: str) -> str:
    base = textwrap.dedent(
        """
        schema_version: 1
        paths:
          root: ./root
          source: ./source
          data_dir: ./data
          output_dir: ./output
          runtime_dir: ./runtime
          nltk_data: ./nltk
          embedding_env: ./embedding.env
        credentials:
          generation:
            api_key: test-key
            base_url: https://generation.example/v1
        models:
          retrieval:
            id: retrieval-model
            route_id: retrieval-route
            protocol: openai-reasoning-completions
          answer:
            id: answer-model
            protocol: openai-completions
            context_safety_tokens: 24576
        service:
          host: 127.0.0.1
          port: 3113
          source_identity: source-test-v1
          build_identity: build-test-v1
          skill: picorer-minimal
          max_run_ms: 240000
          max_turns: 64
          max_tool_calls: 80
          max_concurrent_wraps: 16
          request_timeout_ms: 150000
        run:
          task: longmemeval-s
          label: concurrency-test
          modes: [static]
          max_search_calls: 4
          slots: 1
          query_slots: 16
          answer_timeout_seconds: 600
          memory_timeout_seconds: 1260
          adaptive_query_slots:
        """
    )
    lane = textwrap.indent(textwrap.dedent(adaptive).strip(), "    ")
    return f"{base}{lane}\n"


def _load(path: Path) -> dict:
    script = textwrap.dedent(
        f"""
        import {{ loadMemoryAgentBenchYaml, runnerInvocation }} from {json.dumps(RUNNER.as_uri())};
        const config = loadMemoryAgentBenchYaml({json.dumps(str(path))});
        const invocation = runnerInvocation(config, "static");
        process.stdout.write(JSON.stringify({{
          adaptive: config.run.adaptiveQuerySlots,
          args: invocation.args,
        }}));
        """
    )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


class YamlStageConcurrencyTests(unittest.TestCase):
    def _write(self, directory: str, adaptive: str) -> Path:
        skill = (
            Path(directory)
            / "source"
            / ".agents"
            / "skills"
            / "picorer-retrieval-minimal"
            / "SKILL.md"
        )
        skill.parent.mkdir(parents=True)
        skill.write_text("test skill\n", encoding="utf-8")
        path = Path(directory) / "run.yaml"
        path.write_text(_config(adaptive), encoding="utf-8")
        path.chmod(0o600)
        return path

    def test_fact_mh_262k_is_accepted_by_yaml_and_forwarded_to_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._write(directory, "minimum: 1\ninitial: 1\nsuccesses_per_increase: 8")
            path.write_text(path.read_text().replace("task: longmemeval-s", "task: fact-mh-262k"))
            loaded = _load(path)
        index = loaded["args"].index("--task")
        self.assertEqual(loaded["args"][index + 1], "fact-mh-262k")

    def test_flat_policy_remains_backward_compatible(self):
        with tempfile.TemporaryDirectory() as directory:
            loaded = _load(
                self._write(
                    directory,
                    """
                    minimum: 1
                    initial: 4
                    successes_per_increase: 8
                    """,
                )
            )
        self.assertEqual(
            loaded["adaptive"],
            {
                "minimum": 1,
                "initial": 4,
                "maximum": 16,
                "successesPerIncrease": 8,
            },
        )
        timeout_index = loaded["args"].index("--memory-timeout-seconds")
        self.assertEqual(loaded["args"][timeout_index + 1], "1260")
        answer_timeout_index = loaded["args"].index("--answer-timeout-seconds")
        self.assertEqual(loaded["args"][answer_timeout_index + 1], "600")
        context_index = loaded["args"].index("--answer-context-window")
        self.assertEqual(loaded["args"][context_index + 1], "128000")
        safety_index = loaded["args"].index("--answer-context-safety-tokens")
        self.assertEqual(loaded["args"][safety_index + 1], "24576")
        self.assertIn("--adaptive-query-slots-initial", loaded["args"])
        self.assertNotIn("--adaptive-retrieval-slots-initial", loaded["args"])

    def test_nested_policy_emits_independent_stage_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            loaded = _load(
                self._write(
                    directory,
                    """
                    retrieval:
                      minimum: 1
                      initial: 3
                      maximum: 7
                      successes_per_increase: 5
                    answer:
                      minimum: 2
                      initial: 6
                      maximum: 11
                      successes_per_increase: 9
                    """,
                )
            )
        self.assertEqual(loaded["adaptive"]["retrieval"]["maximum"], 7)
        self.assertEqual(loaded["adaptive"]["answer"]["maximum"], 11)
        retrieval_initial = loaded["args"].index(
            "--adaptive-retrieval-slots-initial"
        )
        answer_initial = loaded["args"].index("--adaptive-answer-slots-initial")
        self.assertEqual(loaded["args"][retrieval_initial + 1], "3")
        self.assertEqual(loaded["args"][answer_initial + 1], "6")


if __name__ == "__main__":
    unittest.main()
