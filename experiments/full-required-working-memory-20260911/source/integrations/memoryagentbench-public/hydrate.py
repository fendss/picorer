#!/usr/bin/env python3
"""Hydrate the pinned MemoryAgentBench slices into public inputs/private gold."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import nltk
import pyarrow.parquet as pq
import tiktoken


ROOT = Path(__file__).resolve().parent
PINS_PATH = ROOT / "pins.json"


@dataclass(frozen=True)
class Slice:
    subset_id: str
    source_id: str
    parquet_id: str
    track: str
    task: str
    contexts: int
    questions_per_context: int


SLICES = (
    Slice("fact-mh-6k", "factconsolidation_mh_6k", "Conflict_Resolution", "refind-comparable", "factconsolidation", 1, 100),
    Slice("fact-sh-6k", "factconsolidation_sh_6k", "Conflict_Resolution", "refind-comparable", "factconsolidation", 1, 100),
    Slice("ruler-qa1", "ruler_qa1_197K", "Accurate_Retrieval", "refind-comparable", "ruler_qa", 1, 100),
    Slice("eventqa-64k", "eventqa_65536", "Accurate_Retrieval", "refind-comparable", "eventqa", 5, 100),
    Slice("longmemeval-s", "longmemeval_s*", "Accurate_Retrieval", "refind-comparable", "longmemeval", 5, 60),
    Slice("banking77", "icl_banking77_5900shot_balance", "Test_Time_Learning", "ttl-extension", "in_context_learning", 1, 100),
    Slice("clinc150", "icl_clinic150_7050shot_balance", "Test_Time_Learning", "ttl-extension", "in_context_learning", 1, 100),
    Slice("nlu", "icl_nlu_8296shot_balance", "Test_Time_Learning", "ttl-extension", "in_context_learning", 1, 100),
    Slice("trec-coarse", "icl_trec_coarse_6600shot_balance", "Test_Time_Learning", "ttl-extension", "in_context_learning", 1, 100),
    Slice("trec-fine", "icl_trec_fine_6400shot_balance", "Test_Time_Learning", "ttl-extension", "in_context_learning", 1, 100),
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def write_atomic(path: Path, value: bytes, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]], mode: int = 0o644) -> None:
    write_atomic(path, b"".join(json_bytes(row) for row in rows), mode)


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    os.close(fd)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "picorer-memoryagentbench/1"})
        with urllib.request.urlopen(request) as response, open(temporary, "wb") as handle:
            shutil.copyfileobj(response, handle)
        os.replace(temporary, target)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def verified_download(url: str, target: Path, expected_sha256: str) -> None:
    if not target.exists():
        download(url, target)
    actual = sha256_file(target)
    if actual != expected_sha256:
        raise RuntimeError(f"SHA-256 mismatch for {target}: expected {expected_sha256}, got {actual}")


def ensure_punkt(cache: Path, pins: dict[str, Any]) -> Path:
    nltk_root = cache / "nltk_data"
    marker = nltk_root / "tokenizers" / "punkt_tab" / "english" / "ortho_context.tab"
    if not marker.exists():
        archive = cache / "punkt_tab.zip"
        chunking = pins["chunking"]
        verified_download(chunking["nltkPunktTabUrl"], archive, chunking["nltkPunktTabSha256"])
        extract_root = cache / ".punkt-extract"
        shutil.rmtree(extract_root, ignore_errors=True)
        extract_root.mkdir(parents=True)
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                resolved = (extract_root / member.filename).resolve()
                if extract_root.resolve() not in resolved.parents and resolved != extract_root.resolve():
                    raise RuntimeError("Unsafe path in punkt_tab archive")
            bundle.extractall(extract_root)
        destination = nltk_root / "tokenizers" / "punkt_tab"
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(extract_root / "punkt_tab", destination)
        shutil.rmtree(extract_root, ignore_errors=True)
    nltk.data.path.insert(0, str(nltk_root))
    return nltk_root


def chunk_text(text: str, model: str, limit: int) -> list[str]:
    encoding = tiktoken.encoding_for_model(model)
    chunks: list[str] = []
    current: list[str] = []
    token_count = 0
    for sentence in nltk.sent_tokenize(text):
        sentence_count = len(encoding.encode(sentence, allowed_special={"<|endoftext|>"}))
        if current and token_count + sentence_count > limit:
            chunks.append(" ".join(current))
            current = [sentence]
            token_count = sentence_count
        else:
            current.append(sentence)
            token_count += sentence_count
    if current:
        chunks.append(" ".join(current))
    if not chunks:
        raise RuntimeError("Context produced no chunks")
    return chunks


def source_id(row: dict[str, Any]) -> str:
    identifiers = (row.get("metadata") or {}).get("qa_pair_ids") or []
    if not identifiers:
        raise RuntimeError("Dataset row has no qa_pair_ids")
    return str(identifiers[0]).rsplit("_no", 1)[0]


def normalized_answers(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if not isinstance(value, list) or not value:
        raise RuntimeError("Expected a non-empty answer list")
    flattened: list[str] = []
    for item in value:
        if isinstance(item, list):
            flattened.extend(str(child) for child in item)
        else:
            flattened.append(str(item))
    return flattened


def hydrate(output: Path, cache: Path) -> dict[str, Any]:
    pins = json.loads(PINS_PATH.read_text(encoding="utf-8"))
    ensure_punkt(cache, pins)
    dataset = pins["dataset"]
    parquet_paths: dict[str, Path] = {}
    for parquet_id, spec in dataset["files"].items():
        target = cache / Path(spec["path"]).name
        url = f"https://huggingface.co/datasets/{dataset['repository']}/resolve/{dataset['revision']}/{spec['path']}"
        verified_download(url, target, spec["sha256"])
        parquet_paths[parquet_id] = target

    public_root = output / "public"
    private_root = output / "private"
    if public_root.exists():
        shutil.rmtree(public_root)
    if private_root.exists():
        shutil.rmtree(private_root)

    loaded = {key: pq.read_table(path).to_pylist() for key, path in parquet_paths.items()}
    chunking = pins["chunking"]
    generated: list[Path] = []
    subset_summaries: list[dict[str, Any]] = []
    for selected in SLICES:
        rows = [row for row in loaded[selected.parquet_id] if source_id(row) == selected.source_id]
        if len(rows) != selected.contexts:
            raise RuntimeError(f"{selected.subset_id}: expected {selected.contexts} contexts, found {len(rows)}")
        questions_out: list[dict[str, Any]] = []
        gold_out: list[dict[str, Any]] = []
        chunk_count = 0
        for context_index, row in enumerate(rows):
            context_id = f"{selected.subset_id}/c{context_index:03d}"
            scope_id = f"mab/{context_id}"
            chunks = chunk_text(str(row["context"]), chunking["model"], int(chunking["tokens"]))
            memory_rows = []
            for chunk_index, content in enumerate(chunks):
                memory_rows.append({
                    "scopeId": scope_id,
                    "sessionId": f"chunk-{chunk_index:04d}",
                    "turns": [{
                        "role": "other",
                        "content": content,
                        "metadata": {
                            "benchmark": "MemoryAgentBench",
                            "subset": selected.subset_id,
                            "sourceId": selected.source_id,
                            "contextIndex": context_index,
                            "chunkIndex": chunk_index,
                        },
                    }],
                })
            context_path = public_root / "contexts" / selected.subset_id / f"c{context_index:03d}.jsonl"
            write_jsonl(context_path, memory_rows)
            generated.append(context_path)
            chunk_count += len(chunks)

            questions = row["questions"]
            answers = row["answers"]
            upstream_ids = (row.get("metadata") or {}).get("qa_pair_ids") or []
            if not (len(questions) == len(answers) == len(upstream_ids) == selected.questions_per_context):
                raise RuntimeError(f"{context_id}: unexpected question/answer/id counts")
            for sequence, (question, answer, upstream_id) in enumerate(zip(questions, answers, upstream_ids, strict=True)):
                question_id = f"{context_id}/q{sequence:03d}"
                questions_out.append({
                    "questionId": question_id,
                    "scopeId": scope_id,
                    "contextId": context_id,
                    "sequence": sequence,
                    "question": str(question),
                    "task": selected.task,
                    "track": selected.track,
                    "upstreamQaId": str(upstream_id),
                })
                gold_out.append({
                    "questionId": question_id,
                    "answers": normalized_answers(answer),
                })

        question_path = public_root / "questions" / f"{selected.subset_id}.jsonl"
        gold_path = private_root / "gold" / f"{selected.subset_id}.jsonl"
        write_jsonl(question_path, questions_out)
        write_jsonl(gold_path, gold_out, 0o600)
        generated.extend((question_path, gold_path))
        subset_summaries.append({
            "subset": selected.subset_id,
            "sourceId": selected.source_id,
            "track": selected.track,
            "task": selected.task,
            "contexts": len(rows),
            "questions": len(questions_out),
            "chunks": chunk_count,
        })

    manifest = {
        "schemaVersion": 1,
        "benchmark": "MemoryAgentBench",
        "pins": pins,
        "subsets": subset_summaries,
        "totals": {
            "contexts": sum(item["contexts"] for item in subset_summaries),
            "questions": sum(item["questions"] for item in subset_summaries),
            "chunks": sum(item["chunks"] for item in subset_summaries),
        },
        "artifacts": [
            {
                "path": str(path.relative_to(output)),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
                "private": private_root in path.parents,
            }
            for path in sorted(generated)
        ],
    }
    manifest_path = output / "manifest.json"
    write_atomic(manifest_path, json_bytes(manifest))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    manifest = hydrate(args.output.resolve(), args.cache.resolve())
    print(json.dumps(manifest["totals"], sort_keys=True))


if __name__ == "__main__":
    main()
