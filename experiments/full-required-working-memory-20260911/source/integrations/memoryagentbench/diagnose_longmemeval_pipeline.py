from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


def _walk_gold(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        if value.get("has_answer") is True and isinstance(value.get("content"), str):
            yield value["content"]
        for nested in value.values():
            yield from _walk_gold(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_gold(nested)


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _scope_from_audit(audit: dict[str, Any]) -> str | None:
    retrieval = audit.get("retrieval") or {}
    for evidence in retrieval.get("evidence") or []:
        if isinstance(evidence.get("scopeId"), str):
            return evidence["scopeId"]
    for trace in retrieval.get("trace") or []:
        details = trace.get("details") or {}
        for candidate in details.get("candidates") or []:
            if isinstance(candidate.get("scopeId"), str):
                return candidate["scopeId"]
    return None


def _candidate_ids(audit: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    for trace in (audit.get("retrieval") or {}).get("trace") or []:
        details = trace.get("details") or {}
        for candidate in details.get("candidates") or []:
            memory_id = candidate.get("memoryId")
            if isinstance(memory_id, str):
                result.add(memory_id)
    return result


def _covers(groups: list[set[str]], observed: set[str]) -> tuple[bool, bool]:
    if not groups:
        return False, False
    matches = [bool(group & observed) for group in groups]
    return any(matches), all(matches)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--judge", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    import pyarrow.parquet as parquet

    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    judged = json.loads(args.judge.read_text(encoding="utf-8"))
    artifact_rows = {
        row["benchmark_query_id"]: row for row in artifact["data"]
    }
    judge_rows = {
        row["benchmark_query_id"]: row for row in judged["data"]
    }
    query_to_id = {row["query"]: query_id for query_id, row in artifact_rows.items()}
    user_to_context = {
        user_id: int(context_id)
        for context_id, user_id in artifact["context_ingestion_users"].items()
    }

    audits: dict[str, dict[str, Any]] = {}
    context_scopes: dict[int, str] = {}
    with args.audit.open("r", encoding="utf-8") as handle:
        for line in handle:
            audit = json.loads(line)
            query_id = query_to_id.get(audit.get("question"))
            if query_id is None:
                continue
            audits[query_id] = audit
            context_id = user_to_context.get(audit.get("userId"))
            scope_id = _scope_from_audit(audit)
            if context_id is not None and scope_id is not None:
                prior = context_scopes.setdefault(context_id, scope_id)
                if prior != scope_id:
                    raise RuntimeError(f"context {context_id} has multiple scopes")

    missing_audits = sorted(set(artifact_rows) - set(audits))
    unexplained_missing = [
        query_id
        for query_id in missing_audits
        if not isinstance(artifact_rows[query_id].get("failure"), dict)
    ]
    if unexplained_missing:
        raise RuntimeError(
            f"missing audits for {len(unexplained_missing)} successful queries: "
            f"{unexplained_missing[:5]}"
        )
    if len(context_scopes) != len(user_to_context):
        raise RuntimeError(f"resolved {len(context_scopes)} context scopes")

    connection = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)
    memories_by_scope: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for memory_id, scope_id, content in connection.execute(
        "SELECT memory_id, scope_id, content FROM memories"
    ):
        memories_by_scope[scope_id].append((memory_id, content, _normalize(content)))

    raw_rows = [
        row
        for row in parquet.read_table(args.dataset).to_pylist()
        if isinstance(row.get("metadata"), dict)
        and row["metadata"].get("source") == "longmemeval_s*"
    ]
    if len(raw_rows) != len(context_scopes):
        raise RuntimeError(f"expected {len(context_scopes)} dataset contexts, got {len(raw_rows)}")

    gold_groups: dict[str, list[set[str]]] = {}
    unresolved_gold: dict[str, list[str]] = {}
    for context_id, raw in enumerate(raw_rows):
        metadata = raw["metadata"]
        haystacks = metadata.get("haystack_sessions") or []
        qa_pair_ids = metadata.get("qa_pair_ids") or []
        scope_memories = memories_by_scope[context_scopes[context_id]]
        for index, qa_pair_id in enumerate(qa_pair_ids):
            query_id = f"context-{context_id}/{qa_pair_id}"
            gold_contents = list(dict.fromkeys(_walk_gold(haystacks[index])))
            groups: list[set[str]] = []
            unresolved: list[str] = []
            for content in gold_contents:
                exact = {
                    memory_id
                    for memory_id, memory, _ in scope_memories
                    if content in memory
                }
                matches = exact or {
                    memory_id
                    for memory_id, _, normalized in scope_memories
                    if _normalize(content) in normalized
                }
                if matches:
                    groups.append(matches)
                else:
                    unresolved.append(content)
            gold_groups[query_id] = groups
            if unresolved:
                unresolved_gold[query_id] = unresolved

    rows: list[dict[str, Any]] = []
    stages = Counter()
    stages_by_type: dict[str, Counter[str]] = defaultdict(Counter)
    for query_id, row in artifact_rows.items():
        audit = audits.get(query_id)
        if audit is None:
            correct = bool(judge_rows[query_id]["label"])
            stage = "retrieval_method_failure"
            stages[stage] += 1
            stages_by_type[row["question_type"]][stage] += 1
            rows.append({
                "benchmark_query_id": query_id,
                "question_type": row["question_type"],
                "correct": correct,
                "stage": stage,
                "gold_source_groups": [],
                "candidate_gold_any": False,
                "candidate_gold_all": False,
                "selected_gold_any": False,
                "selected_gold_all": False,
                "candidate_count": 0,
                "selected_count": 0,
                "search_calls": 0,
                "failure": row["failure"],
            })
            continue
        candidates = _candidate_ids(audit)
        selected = set(audit.get("selectedMemoryIds") or [])
        groups = gold_groups.get(query_id, [])
        candidate_any, candidate_all = _covers(groups, candidates)
        selected_any, selected_all = _covers(groups, selected)
        correct = bool(judge_rows[query_id]["label"])
        if query_id in unresolved_gold or not groups:
            stage = "unresolved_gold_mapping"
        elif not candidate_any:
            stage = "no_gold_candidate"
        elif not candidate_all:
            stage = "partial_gold_candidates"
        elif not selected_all:
            stage = "candidate_not_committed"
        elif not correct:
            stage = "gold_committed_answer_wrong"
        else:
            stage = "gold_committed_answer_correct"
        stages[stage] += 1
        stages_by_type[row["question_type"]][stage] += 1
        rows.append({
            "benchmark_query_id": query_id,
            "question_type": row["question_type"],
            "correct": correct,
            "stage": stage,
            "gold_source_groups": [sorted(group) for group in groups],
            "candidate_gold_any": candidate_any,
            "candidate_gold_all": candidate_all,
            "selected_gold_any": selected_any,
            "selected_gold_all": selected_all,
            "candidate_count": len(candidates),
            "selected_count": len(selected),
            "search_calls": row["operator_experiment"]["searchCalls"],
        })

    output = {
        "schema_version": 1,
        "artifact": str(args.artifact),
        "judge": str(args.judge),
        "rows": rows,
        "summary": {
            "queries": len(rows),
            "correct": sum(row["correct"] for row in rows),
            "stages": dict(stages),
            "stages_by_question_type": {
                key: dict(value) for key, value in sorted(stages_by_type.items())
            },
            "unresolved_gold_queries": len(unresolved_gold),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps(output["summary"], indent=2))


if __name__ == "__main__":
    main()
