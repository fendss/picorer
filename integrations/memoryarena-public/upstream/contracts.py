from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


OFFICIAL_REPOSITORY = "https://github.com/ZexueHe/MemoryArena.git"
OFFICIAL_CODE_REVISION = "6cd9de14b71915e39ac742a20dc33785e14b6aab"
PUBLIC_DATASET = "ZexueHe/memoryarena"
PUBLIC_DATA_REVISION = "da1a37c8b19280e18627ca01cf368195a5e1d92e"
EXPECTED_TASK_TOTAL = 701
EXPECTED_SUBTASK_TOTAL = 4_850
RELEASE_ID = (
    "memoryarena-public@"
    f"{OFFICIAL_CODE_REVISION}+data.{PUBLIC_DATA_REVISION}"
)

EXPECTED_SUITE_COUNTS: Mapping[str, int] = {
    "bundled_shopping": 150,
    "progressive_search": 221,
    "group_travel_planner": 270,
    "formal_reasoning_math": 40,
    "formal_reasoning_phys": 20,
}

EXPECTED_SUITE_SUBTASK_COUNTS: Mapping[str, int] = {
    "bundled_shopping": 900,
    "progressive_search": 1_641,
    "group_travel_planner": 1_869,
    "formal_reasoning_math": 354,
    "formal_reasoning_phys": 86,
}


class UpstreamContractError(RuntimeError):
    """The pinned upstream/data/runtime seam cannot be proven faithful."""


class ManifestMaterializationError(UpstreamContractError):
    """Hydrated records cannot produce the exact public task manifest."""


class UpstreamExecutionError(UpstreamContractError):
    """An official task group cannot be invoked or validated faithfully."""


class EvaluatorMaterializationError(UpstreamContractError):
    """Accepted artifacts cannot form a complete official evaluator input."""


@dataclass(frozen=True)
class SuiteContract:
    name: str
    record_kind: str
    data_relative_path: str
    data_sha256: str
    data_git_oid: str
    expected_ids: tuple[int, ...]
    effective_config_name: str
    official_runner: str

    @property
    def expected_count(self) -> int:
        return len(self.expected_ids)

    def data_path(self, data_root: Path) -> Path:
        return data_root / self.data_relative_path


SUITE_CONTRACTS: Mapping[str, SuiteContract] = {
    "bundled_shopping": SuiteContract(
        name="bundled_shopping",
        record_kind="shopping",
        data_relative_path="bundled_shopping/data.jsonl",
        data_sha256="4411a2da528a33dc6aca519b49cc225895363f18b2d19b191fddb501200134ef",
        data_git_oid="5fc6b362fc68cc0724e8d3b5147f550408d2aba8",
        expected_ids=tuple(range(0, 150)),
        effective_config_name="bundled_shopping.json",
        official_runner="run_shopping.py",
    ),
    "progressive_search": SuiteContract(
        name="progressive_search",
        record_kind="search",
        data_relative_path="progressive_search/data.jsonl",
        data_sha256="b445ee36fa3ccb9ad08eae9e7adda86bbc64f14f1e2a0682a8b2085cdb8e4c0e",
        data_git_oid="625bba3fbc13273f2c181f1589ef957d64dc827f",
        expected_ids=tuple(range(0, 221)),
        effective_config_name="progressive_search.json",
        official_runner="run_search.py",
    ),
    "group_travel_planner": SuiteContract(
        name="group_travel_planner",
        record_kind="travel",
        data_relative_path="group_travel_planner/data.jsonl",
        data_sha256="2f955d444f6f3ad3c5da2064359ab19f8fc1f90621ff9d00723a450a009c3732",
        data_git_oid="e3953b64b9559f6343f0e55170238a6260e5e4ff",
        expected_ids=tuple(range(1, 271)),
        effective_config_name="group_travel_planner.json",
        official_runner="run_travel.py",
    ),
    "formal_reasoning_math": SuiteContract(
        name="formal_reasoning_math",
        record_kind="formal",
        data_relative_path="formal_reasoning_math/data.jsonl",
        data_sha256="ff5b0ad575847c7476a02d1e35661592a833bd0cff384cb54bc6f35b46de7803",
        data_git_oid="17c7889589c7820b4e51c953a26fc7f7b5690db8",
        expected_ids=tuple(range(0, 40)),
        effective_config_name="formal_reasoning_math.json",
        official_runner="run_math.py",
    ),
    "formal_reasoning_phys": SuiteContract(
        name="formal_reasoning_phys",
        record_kind="formal",
        data_relative_path="formal_reasoning_phys/data.jsonl",
        data_sha256="580862006af2ff2bfc8c5d2d2b9a60bf33a46cbb64f27d60a2bfe039aec61cf6",
        data_git_oid="d8bee38750da6699e136a11f33c69eaa673b964c",
        expected_ids=tuple(range(0, 20)),
        effective_config_name="formal_reasoning_phys.json",
        official_runner="run_math.py",
    ),
}


AUXILIARY_REVISIONS = {
    "shopping_product_db": "46120a5c931d04a47bd791965d757207b7372b62",
    "websearch_embeddings": "40b2422e641b46b903312c2e5b0c4ef9380f5352",
    "browsecomp_plus": "144cff8e35b5eaef7e526346aa60774a9deb941f",
    "browsecomp_plus_corpus": "b27b02bc3e45511b8b82a13e6f90ce761df726f6",
}


# The search task decomposition file is a normal Git blob at the pinned
# websearch-embeddings commit.  Its runner ids are intentionally unrelated to
# the 0..220 row ordinals in ZexueHe/memoryarena.
SEARCH_TASK_DATA_SHA256 = (
    "6f6b1f6c40ae37196e23fe4053747568ed2031bffd3da3733748f99c6631b46f"
)
SEARCH_TASK_DATA_GIT_OID = "a0db15e9178f9362380ac423b180ca6545bef11e"
SEARCH_RUNNER_IDS_ORDERED_SHA256 = (
    "1d1ff11bfc03020da90f194eeac7833eeb4b466341f509b776368f04a8cde2ce"
)
HF_SOURCE_MANIFEST_SHA256 = (
    "5587f92d38eca1a1ecd166e1a27e2c53773f82cfc77a1f270b48340b0785c115"
)

BROWSECOMP_PLUS_QRELS_REPOSITORY = (
    "https://github.com/texttron/BrowseComp-Plus.git"
)
BROWSECOMP_PLUS_QRELS_REVISION = "046949032b0328319cc9a02663a759ec601d9402"
BROWSECOMP_PLUS_QRELS_SOURCE_PATH = "topics-qrels/qrel_evidence.txt"
BROWSECOMP_PLUS_QRELS_SHA256 = (
    "a6f594975be57339de9e4e9f67f13c044f647feda77c0b84c45a1581e3041bd1"
)
BROWSECOMP_PLUS_QRELS_GIT_OID = "d99a06aeb30dcf0dd9c41003c2bca8d775e4519c"
BROWSECOMP_PLUS_QRELS_LINE_COUNT = 5_064
BROWSECOMP_PLUS_QRELS_QUERY_ID_COUNT = 830
BROWSECOMP_PLUS_QRELS_LOCKED_ROW_COUNT = 1_357


DEFAULT_LOCAL_ASSETS = {
    "shopping_product_db": {
        "path": "data/shopping",
        "kind": "tree",
        "revision": AUXILIARY_REVISIONS["shopping_product_db"],
        "source_snapshot": "shopping_product_db",
    },
    "search_task_data": {
        "path": "env/env_systems/web_search_env/data/browsecomp_all_jsons.jsonl",
        "kind": "file",
        "revision": AUXILIARY_REVISIONS["websearch_embeddings"],
        "source_repo": "joanna690/websearch-embeddings",
        "source_path": "browsecomp_all_jsons.jsonl",
        "source_revision": AUXILIARY_REVISIONS["websearch_embeddings"],
        "sha256": SEARCH_TASK_DATA_SHA256,
        "git_oid": SEARCH_TASK_DATA_GIT_OID,
        "source_snapshot": "websearch_embeddings",
    },
    "search_ground_truth": {
        "path": "env/env_systems/web_search_env/data/browsecomp_plus_decrypted.jsonl",
        "kind": "file",
        "revision": AUXILIARY_REVISIONS["browsecomp_plus"],
        "source_snapshot": "browsecomp_plus",
    },
    "search_embeddings": {
        "path": "env/env_systems/web_search_env/embeddings",
        "kind": "tree",
        "revision": AUXILIARY_REVISIONS["websearch_embeddings"],
        "source_snapshot": "websearch_embeddings",
    },
    "search_corpus": {
        "path": "env/env_systems/web_search_env/data/corpus.jsonl",
        "kind": "file",
        "revision": AUXILIARY_REVISIONS["browsecomp_plus_corpus"],
        "source_snapshot": "browsecomp_plus_corpus",
    },
    "search_qrels": {
        "path": "env/env_systems/web_search_env/data/qrel_evidence.txt",
        "kind": "file",
        "revision": BROWSECOMP_PLUS_QRELS_REVISION,
        "source_repo": BROWSECOMP_PLUS_QRELS_REPOSITORY,
        "source_path": BROWSECOMP_PLUS_QRELS_SOURCE_PATH,
        "source_revision": BROWSECOMP_PLUS_QRELS_REVISION,
        "sha256": BROWSECOMP_PLUS_QRELS_SHA256,
        "git_oid": BROWSECOMP_PLUS_QRELS_GIT_OID,
    },
    "travel_flights_csv": {
        "path": "env/env_systems/travel_planner_env/database/flights/clean_Flights_2022.csv",
        "kind": "file",
        "revision": None,
        "provenance": "officially-documented-unversioned-external-asset",
    },
}
