from __future__ import annotations

from dataclasses import dataclass

import redis


@dataclass(frozen=True)
class RedisTransport:
    url: str
    namespace: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "client", redis.Redis.from_url(self.url, decode_responses=True))

    def stream(self, stage: str) -> str:
        return f"{self.namespace}:{stage}"

    def group(self, stage: str) -> str:
        return f"{self.namespace}:{stage}:workers"

    def ensure_group(self, stage: str) -> None:
        try:
            self.client.xgroup_create(self.stream(stage), self.group(stage), id="0", mkstream=True)
        except redis.ResponseError as error:
            if "BUSYGROUP" not in str(error):
                raise

    def enqueue(self, question_id: str, stage: str) -> str:
        return self.client.xadd(self.stream(stage), {"question_id": question_id})

    def read(self, stage: str, worker: str, count: int, block_ms: int = 1000):
        return self.client.xreadgroup(
            self.group(stage), worker, {self.stream(stage): ">"},
            count=count, block=block_ms,
        )

    def acknowledge(self, stage: str, message_id: str) -> None:
        self.client.xack(self.stream(stage), self.group(stage), message_id)

