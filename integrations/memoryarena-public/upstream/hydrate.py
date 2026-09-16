from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from runtime.artifacts import file_sha256, locked_manifest_document, write_json_atomic

from .assets import (
    _decrypt_browsecomp,
    _git_blob_oid,
    _iter_parquet_rows,
    _snapshot_descriptors,
    _snapshot_file,
    load_hf_source_manifests,
    validate_search_qrels,
    verify_hf_source_snapshot,
)
from .contracts import (
    BROWSECOMP_PLUS_QRELS_GIT_OID,
    BROWSECOMP_PLUS_QRELS_REPOSITORY,
    BROWSECOMP_PLUS_QRELS_REVISION,
    BROWSECOMP_PLUS_QRELS_SOURCE_PATH,
    DEFAULT_LOCAL_ASSETS,
    OFFICIAL_CODE_REVISION,
    OFFICIAL_REPOSITORY,
    PUBLIC_DATA_REVISION,
    SUITE_CONTRACTS,
    UpstreamContractError,
)


def _git(checkout: Path, *args: str) -> str:
    process = subprocess.run(
        ["git", "-C", str(checkout), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if process.returncode != 0:
        raise UpstreamContractError(
            f"cannot verify official checkout ({' '.join(args)}): "
            f"{process.stderr.strip()[:1000]}"
        )
    return process.stdout.strip()


def _canonical_remote(value: str) -> str:
    remote = value.strip().removesuffix("/").removesuffix(".git")
    if remote.startswith("git@github.com:"):
        remote = "https://github.com/" + remote.removeprefix("git@github.com:")
    return remote.casefold()


def _verify_checkout(checkout: Path) -> set[str]:
    root = checkout.resolve()
    if Path(_git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise UpstreamContractError("--checkout must be the official worktree root")
    if _git(root, "rev-parse", "HEAD") != OFFICIAL_CODE_REVISION:
        raise UpstreamContractError("official checkout is not at the pinned code revision")
    remote = _git(root, "remote", "get-url", "origin")
    if _canonical_remote(remote) != _canonical_remote(OFFICIAL_REPOSITORY):
        raise UpstreamContractError("official checkout origin mismatch")
    if _git(root, "status", "--porcelain=v1", "--untracked-files=no"):
        raise UpstreamContractError("official tracked checkout files are dirty")
    return set(_git(root, "ls-files", "-z").split("\0"))


def _verify_qrels_checkout(checkout: Path) -> Path:
    root = checkout.resolve()
    if Path(_git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise UpstreamContractError(
            "--browsecomp-plus-qrels-checkout must be the repository root"
        )
    if _git(root, "rev-parse", "HEAD") != BROWSECOMP_PLUS_QRELS_REVISION:
        raise UpstreamContractError("BrowseComp-Plus qrel checkout revision mismatch")
    if _canonical_remote(
        _git(root, "remote", "get-url", "origin")
    ) != _canonical_remote(BROWSECOMP_PLUS_QRELS_REPOSITORY):
        raise UpstreamContractError("BrowseComp-Plus qrel checkout origin mismatch")
    if _git(root, "status", "--porcelain=v1", "--untracked-files=no"):
        raise UpstreamContractError("BrowseComp-Plus qrel checkout is dirty")
    if _git(
        root,
        "rev-parse",
        f"{BROWSECOMP_PLUS_QRELS_REVISION}:{BROWSECOMP_PLUS_QRELS_SOURCE_PATH}",
    ) != BROWSECOMP_PLUS_QRELS_GIT_OID:
        raise UpstreamContractError(
            "BrowseComp-Plus revision does not bind the pinned qrel path/blob"
        )
    source = _inside(root, BROWSECOMP_PLUS_QRELS_SOURCE_PATH)
    validate_search_qrels(source)
    return source


def _inside(root: Path, relative: str) -> Path:
    target = (root.resolve() / relative).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as error:
        raise UpstreamContractError(f"hydration target escapes root: {relative}") from error
    return target


def _install_file(source: Path, target: Path) -> dict[str, Any]:
    if not source.is_file():
        raise UpstreamContractError(f"hydration source is missing: {source}")
    digest = file_sha256(source)
    size = source.stat().st_size
    if target.exists():
        if target.is_symlink() or not target.is_file():
            raise UpstreamContractError(f"hydration target is not a regular file: {target}")
        if target.stat().st_size != size or file_sha256(target) != digest:
            raise UpstreamContractError(f"refusing to overwrite different asset: {target}")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_file:
                shutil.copyfileobj(input_file, output, length=1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
    return {"path": str(target), "size": size, "sha256": digest}


def _write_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for count, row in enumerate(rows, start=1):
            handle.write(
                json.dumps(
                    dict(row),
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                + "\n"
            )
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(path, 0o600)
    return count


def hydrate_official_assets(
    *,
    checkout: Path,
    data_root: Path,
    public_data_snapshot: Path,
    shopping_product_snapshot: Path,
    websearch_embeddings_snapshot: Path,
    browsecomp_plus_snapshot: Path,
    browsecomp_plus_corpus_snapshot: Path,
    browsecomp_plus_qrels_checkout: Path,
    travel_flights_csv: Path,
) -> dict[str, Any]:
    root = checkout.resolve()
    resolved_data_root = data_root.resolve()
    try:
        resolved_data_root.relative_to(root)
    except ValueError:
        pass
    else:
        raise UpstreamContractError("--data-root must be outside the official checkout")
    tracked = _verify_checkout(root)
    manifests = load_hf_source_manifests()
    snapshots = {
        "shopping_product_db": shopping_product_snapshot.resolve(),
        "websearch_embeddings": websearch_embeddings_snapshot.resolve(),
        "browsecomp_plus": browsecomp_plus_snapshot.resolve(),
        "browsecomp_plus_corpus": browsecomp_plus_corpus_snapshot.resolve(),
    }
    proofs = {
        name: verify_hf_source_snapshot(
            name, snapshot, source_manifests=manifests
        )
        for name, snapshot in snapshots.items()
    }
    if not travel_flights_csv.resolve().is_file():
        raise UpstreamContractError("--travel-flights-csv must be an existing regular file")
    qrel_source = _verify_qrels_checkout(browsecomp_plus_qrels_checkout)

    public_installed: list[dict[str, Any]] = []
    for suite, contract in SUITE_CONTRACTS.items():
        relative = contract.data_relative_path
        source = _snapshot_file(public_data_snapshot.resolve(), relative, relative)
        if file_sha256(source) != contract.data_sha256 or _git_blob_oid(source) != contract.data_git_oid:
            raise UpstreamContractError(f"pinned public JSONL identity mismatch: {suite}")
        public_installed.append(
            _install_file(source, _inside(resolved_data_root, relative))
        )

    shopping_descriptors = _snapshot_descriptors(manifests, "shopping_product_db")
    install_pairs: list[tuple[Path, Path]] = []
    shopping_target = _inside(root, str(DEFAULT_LOCAL_ASSETS["shopping_product_db"]["path"]))
    for relative in sorted(shopping_descriptors):
        if relative == ".gitattributes":
            continue
        install_pairs.append(
            (
                _snapshot_file(snapshots["shopping_product_db"], relative, relative),
                _inside(shopping_target, relative),
            )
        )

    embedding_descriptors = _snapshot_descriptors(manifests, "websearch_embeddings")
    embedding_paths = sorted(
        relative
        for relative in embedding_descriptors
        if relative == "query.pkl"
        or relative.endswith(".index")
        or relative.endswith("_id_map.json")
    )
    embedding_target = _inside(root, str(DEFAULT_LOCAL_ASSETS["search_embeddings"]["path"]))
    for relative in embedding_paths:
        install_pairs.append(
            (
                _snapshot_file(snapshots["websearch_embeddings"], relative, relative),
                _inside(embedding_target, relative),
            )
        )
    install_pairs.append(
        (
            _snapshot_file(
                snapshots["websearch_embeddings"],
                "browsecomp_all_jsons.jsonl",
                "browsecomp_all_jsons.jsonl",
            ),
            _inside(root, str(DEFAULT_LOCAL_ASSETS["search_task_data"]["path"])),
        )
    )

    with tempfile.TemporaryDirectory(prefix="memoryarena-hydrate-") as temporary_name:
        temporary = Path(temporary_name)
        browsecomp_paths = sorted(
            relative
            for relative in _snapshot_descriptors(manifests, "browsecomp_plus")
            if relative.endswith(".parquet")
        )
        ground = temporary / "browsecomp_plus_decrypted.jsonl"
        ground_count = _write_jsonl(
            ground,
            (
                _decrypt_browsecomp(row)
                for row in _iter_parquet_rows(
                    [
                        _snapshot_file(snapshots["browsecomp_plus"], relative, relative)
                        for relative in browsecomp_paths
                    ]
                )
            ),
        )
        corpus_paths = sorted(
            relative
            for relative in _snapshot_descriptors(manifests, "browsecomp_plus_corpus")
            if relative.endswith(".parquet")
        )
        corpus = temporary / "corpus.jsonl"
        corpus_count = _write_jsonl(
            corpus,
            _iter_parquet_rows(
                [
                    _snapshot_file(
                        snapshots["browsecomp_plus_corpus"], relative, relative
                    )
                    for relative in corpus_paths
                ]
            ),
        )
        install_pairs.extend(
            [
                (
                    ground,
                    _inside(root, str(DEFAULT_LOCAL_ASSETS["search_ground_truth"]["path"])),
                ),
                (
                    corpus,
                    _inside(root, str(DEFAULT_LOCAL_ASSETS["search_corpus"]["path"])),
                ),
                (
                    qrel_source,
                    _inside(root, str(DEFAULT_LOCAL_ASSETS["search_qrels"]["path"])),
                ),
                (
                    travel_flights_csv.resolve(),
                    _inside(root, str(DEFAULT_LOCAL_ASSETS["travel_flights_csv"]["path"])),
                ),
            ]
        )
        target_relatives = {
            target.relative_to(root).as_posix()
            for _, target in install_pairs
            if target.is_relative_to(root)
        }
        collision = sorted(target_relatives & tracked)
        if collision:
            raise UpstreamContractError(
                f"hydration would overwrite tracked official file: {collision[0]}"
            )
        installed = [_install_file(source, target) for source, target in install_pairs]

    if _git(root, "status", "--porcelain=v1", "--untracked-files=no"):
        raise UpstreamContractError("hydration changed a tracked official checkout file")
    return locked_manifest_document(
        {
            "schema_version": 1,
            "kind": "memoryarena-public-hydration-report",
            "code_revision": OFFICIAL_CODE_REVISION,
            "data_revision": PUBLIC_DATA_REVISION,
            "source_snapshots": proofs,
            "pinned_git_sources": {
                "search_qrels": {
                    "repository": BROWSECOMP_PLUS_QRELS_REPOSITORY,
                    "revision": BROWSECOMP_PLUS_QRELS_REVISION,
                    "source_path": BROWSECOMP_PLUS_QRELS_SOURCE_PATH,
                    "source_sha256": file_sha256(qrel_source),
                    "source_git_oid": _git_blob_oid(qrel_source),
                }
            },
            "public_data_files": public_installed,
            "installed_files": installed,
            "derived": {
                "search_ground_truth_rows": ground_count,
                "search_corpus_rows": corpus_count,
                "method": "pinned-parquet ordered JSONL; official XOR/canary decrypt",
            },
            "unversioned_travel_flights": {
                "source": str(travel_flights_csv.resolve()),
                "sha256": file_sha256(travel_flights_csv.resolve()),
            },
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install and derive exact pinned MemoryArena public/auxiliary assets"
    )
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--public-data-snapshot", type=Path, required=True)
    parser.add_argument("--shopping-product-snapshot", type=Path, required=True)
    parser.add_argument("--websearch-embeddings-snapshot", type=Path, required=True)
    parser.add_argument("--browsecomp-plus-snapshot", type=Path, required=True)
    parser.add_argument("--browsecomp-plus-corpus-snapshot", type=Path, required=True)
    parser.add_argument("--browsecomp-plus-qrels-checkout", type=Path, required=True)
    parser.add_argument("--travel-flights-csv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report = hydrate_official_assets(
            checkout=args.checkout,
            data_root=args.data_root,
            public_data_snapshot=args.public_data_snapshot,
            shopping_product_snapshot=args.shopping_product_snapshot,
            websearch_embeddings_snapshot=args.websearch_embeddings_snapshot,
            browsecomp_plus_snapshot=args.browsecomp_plus_snapshot,
            browsecomp_plus_corpus_snapshot=args.browsecomp_plus_corpus_snapshot,
            browsecomp_plus_qrels_checkout=args.browsecomp_plus_qrels_checkout,
            travel_flights_csv=args.travel_flights_csv,
        )
        write_json_atomic(args.output.resolve(), report)
    except (OSError, ValueError, UpstreamContractError) as error:
        print(f"MemoryArena hydration error: {error}")
        return 2
    print(report["manifest_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
