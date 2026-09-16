from __future__ import annotations

import json

from question_pipeline.mab_export import export as export_mab
from question_pipeline.omni_export import export as export_omni
from question_pipeline.state import PipelineState


def _write(path, output):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"output": output}))
    return str(path)


def _seed(state, question_id, stage, path, output, status="completed"):
    state.seed_stage(
        question_id,
        stage,
        status,
        _write(path, output),
        f"digest-{question_id}-{stage}",
        1.0,
    )


def test_mixed_state_exports_each_adapter_only(tmp_path):
    state = PipelineState(tmp_path / "state.sqlite")
    state.initialize([
        {
            "id": "mab:1",
            "benchmark": "AgentMemoryBench sample",
            "adapter": "question_pipeline.adapters.memoryagentbench:MemoryAgentBenchAdapter",
            "payload": {
                "task_id": "sample",
                "context_id": 0,
                "benchmark_query_id": "context-0/q0",
                "qa_pair_id": "q0",
                "question_id": "q0",
                "question_type": "fact",
                "answers": ["answer"],
                "data_dir": str(tmp_path),
            },
        },
        {
            "id": "omni:1",
            "benchmark": "BEAM 100K",
            "adapter": "question_pipeline.adapters.omnimemeval:OmniMemEvalAdapter",
            "payload": {
                "suite": "beam",
                "scale": "100k",
                "user_id": "user-1",
            },
        },
    ])
    _seed(state, "mab:1", "retrieval", tmp_path / "mab-r.json", {"formatted_query": "q"})
    _seed(state, "mab:1", "answer", tmp_path / "mab-a.json", {"prediction": "answer"})
    _seed(state, "mab:1", "evaluation", tmp_path / "mab-e.json", {"metrics": {"acc": 1}})
    _seed(state, "omni:1", "retrieval", tmp_path / "omni-r.json", {"search_record": {"key": "k"}})
    _seed(state, "omni:1", "answer", tmp_path / "omni-a.json", {"response_record": {"key": "k"}})

    assert export_mab(state.path, tmp_path / "mab-export") == {"sample": 1}
    mab_output = json.loads(
        (tmp_path / "mab-export" / "sample-static.json").read_text()
    )
    assert mab_output["evaluated_queries"] == 1
    assert mab_output["evaluation_statuses"] == {"completed": 1}
    assert export_omni(state.path, tmp_path / "omni-export") == {
        "beam_search": 1,
        "beam_answer": 1,
        "locomo_search": 0,
        "locomo_answer": 0,
    }
