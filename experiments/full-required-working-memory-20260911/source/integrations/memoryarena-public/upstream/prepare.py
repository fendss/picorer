from __future__ import annotations

import argparse
import subprocess
from pathlib import Path
from typing import Sequence
from urllib.parse import urlparse, urlsplit, urlunsplit

from runtime.artifacts import (
    file_sha256,
    locked_manifest_document,
    read_json,
    validate_locked_manifest,
    write_json_atomic,
)
from runtime.usage import load_price_table

from .contracts import (
    OFFICIAL_CODE_REVISION,
    PUBLIC_DATA_REVISION,
    RELEASE_ID,
    SUITE_CONTRACTS,
    UpstreamContractError,
)
from .manifest import validate_official_locked_task_manifest


def _git(root: Path, *args: str) -> str:
    process = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if process.returncode != 0:
        raise UpstreamContractError(
            f"cannot identify clean Picorer source ({' '.join(args)}): "
            f"{process.stderr.strip()[:1000]}"
        )
    return process.stdout.strip()


def picorer_source_identity(root: Path) -> dict[str, object]:
    source = root.resolve()
    if Path(_git(source, "rev-parse", "--show-toplevel")).resolve() != source:
        raise UpstreamContractError("--picorer-root must be the Picorer Git worktree root")
    revision = _git(source, "rev-parse", "HEAD")
    if len(revision) != 40 or any(character not in "0123456789abcdef" for character in revision):
        raise UpstreamContractError("Picorer HEAD is not a full lowercase Git commit")
    if _git(source, "status", "--porcelain=v1", "--untracked-files=all"):
        raise UpstreamContractError(
            "Picorer source must be fully clean, including untracked files, before a production run"
        )
    remote = _git(source, "remote", "get-url", "origin")
    if not remote:
        raise UpstreamContractError("Picorer source has no origin remote")
    parsed_remote = urlsplit(remote)
    if parsed_remote.scheme in {"http", "https"}:
        if parsed_remote.username or parsed_remote.password:
            raise UpstreamContractError("Picorer origin URL must not contain credentials")
        if parsed_remote.query or parsed_remote.fragment:
            raise UpstreamContractError("Picorer origin URL must not contain query/fragment data")
        remote = urlunsplit(
            (
                parsed_remote.scheme.lower(),
                parsed_remote.netloc.lower(),
                parsed_remote.path,
                "",
                "",
            )
        )
    return {
        "repository": remote,
        "revision": revision,
        "clean_worktree": True,
    }


def effective_config_identity(config_dir: Path) -> dict[str, dict[str, str]]:
    identity: dict[str, dict[str, str]] = {}
    for suite, contract in sorted(SUITE_CONTRACTS.items()):
        config_path = config_dir / contract.effective_config_name
        provenance_path = config_dir / f"{suite}.manifest.json"
        provenance = read_json(provenance_path)
        config_sha256 = file_sha256(config_path)
        if (
            provenance.get("suite") != suite
            or provenance.get("code_revision") != OFFICIAL_CODE_REVISION
            or provenance.get("data_revision") != PUBLIC_DATA_REVISION
            or provenance.get("effective_config_sha256") != config_sha256
            or provenance.get("official_config_unchanged") is not True
            or provenance.get("evaluator_policy") != "official_only"
        ):
            raise UpstreamContractError(
                f"effective config provenance mismatch: {suite}"
            )
        identity[suite] = {
            "effective_config_sha256": config_sha256,
            "provenance_sha256": file_sha256(provenance_path),
        }
    return identity


def prepare_source_run_manifest(
    *,
    run_id: str,
    task_manifest_path: Path,
    provider_proxy_url: str,
    retrieval_model: str,
    embedding_model: str,
    picorer_root: Path,
    config_dir: Path,
    price_table_path: Path | None = None,
) -> dict:
    if not run_id or not retrieval_model or not embedding_model:
        raise UpstreamContractError("run id and Picorer model identities must be non-empty")
    parsed = urlparse(provider_proxy_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise UpstreamContractError("provider proxy must be a credential-free HTTP(S) URL")
    task_manifest = validate_locked_manifest(read_json(task_manifest_path))
    validate_official_locked_task_manifest(task_manifest)
    price_table = load_price_table(price_table_path) if price_table_path else None
    return locked_manifest_document({
        "schema_version": 1,
        "benchmark_name": "MemoryArena Public",
        "run_id": run_id,
        "release_id": RELEASE_ID,
        "official_code_revision": OFFICIAL_CODE_REVISION,
        "official_data_revision": PUBLIC_DATA_REVISION,
        "task_manifest_sha256": task_manifest["manifest_sha256"],
        "price_table_sha256": price_table.sha256 if price_table else None,
        "models": {
            "picorer_retrieval": retrieval_model,
            "embedding_model": embedding_model,
        },
        "picorer_source": picorer_source_identity(picorer_root),
        "effective_configs": effective_config_identity(config_dir),
        "infrastructure": {
            "provider_proxy_url": provider_proxy_url.rstrip("/"),
        },
        "usage_coverage_policy": "observable-only-with-explicit-unknown-gaps",
    })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a locked MemoryArena source run manifest")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--task-manifest", type=Path, required=True)
    parser.add_argument("--provider-proxy-url", required=True)
    parser.add_argument("--retrieval-model", required=True)
    parser.add_argument("--embedding-model", required=True)
    parser.add_argument("--picorer-root", type=Path, required=True)
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--price-table", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        document = prepare_source_run_manifest(
            run_id=args.run_id,
            task_manifest_path=args.task_manifest.resolve(),
            provider_proxy_url=args.provider_proxy_url,
            retrieval_model=args.retrieval_model,
            embedding_model=args.embedding_model,
            picorer_root=args.picorer_root.resolve(),
            config_dir=args.config_dir.resolve(),
            price_table_path=args.price_table.resolve() if args.price_table else None,
        )
        write_json_atomic(args.output.resolve(), document)
    except (OSError, ValueError, UpstreamContractError) as error:
        print(f"MemoryArena run-manifest preparation error: {error}")
        return 2
    print(document["manifest_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
