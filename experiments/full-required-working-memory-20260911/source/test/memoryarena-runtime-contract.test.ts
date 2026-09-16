import { describe, expect, it, vi } from "vitest";
import type { PiModelRuntime } from "../src/platform/pi/load-model-runtime.js";
import {
  MemoryArenaPublicApiService,
  MemoryArenaPublicApplication,
  type MemoryArenaPublicBackend,
} from "../src/entrypoints/memoryarena-public-api/application.js";
import {
  createMemoryArenaRuntimeIdentity,
  memoryArenaRuntimeContractHash,
} from "../src/entrypoints/memoryarena-public-api/runtime-contract.js";

describe("MemoryArena retrieval runtime identity", () => {
  it("returns a hashed retrieval contract separately from persistence identity", () => {
    const runtime = {
      providerId: "provider",
      modelId: "route-model",
      thinkingLevel: "medium",
      transport: "non-stream",
    } as unknown as PiModelRuntime;
    const identity = createMemoryArenaRuntimeIdentity({
      sourceIdentity: "source-v1",
      buildIdentity: "build-v1",
      skill: "picorer-v0",
      interfaceMode: "compact",
      modelRuntime: runtime,
      logicalModelId: "logical-model",
      protocol: "openai-reasoning-completions",
      baseUrl: "https://provider.example/v1/",
      maxRunMs: 300_000,
      maxTurns: 64,
      maxToolCalls: 80,
      maxSearchCalls: 4,
      requestTimeoutMs: 120_000,
      requestMaxRetries: 1,
      requestMaxRetryDelayMs: 5_000,
      maxConcurrentWraps: 16,
      memoryIndex: {
        retrievalProfile: "picorer-hybrid-qdrant-hnsw-v1",
        vectorGenerationId: "event30-v1",
        vectorCollection: "event30",
      },
    });
    const service = new MemoryArenaPublicApiService(
      new MemoryArenaPublicApplication({
        initialize: vi.fn(),
        add: vi.fn(),
        wrap: vi.fn(),
      } as unknown as MemoryArenaPublicBackend),
      identity,
      "persistent-store-1",
    );

    expect(identity.sha256).toBe(memoryArenaRuntimeContractHash(identity.contract));
    expect(service.runtime()).toMatchObject({
      status: "ok",
      runtime_identity_sha256: identity.sha256,
      persistence_identity: "persistent-store-1",
      runtime_contract: {
        source_identity: "source-v1",
        build_identity: "build-v1",
        skill: { id: "picorer-v0" },
        agent_interface: "compact",
        retrieval: {
          logical_model_id: "logical-model",
          route_model_id: "route-model",
        },
        limits: { max_search_calls: 4 },
        memory_index: {
          retrievalProfile: "picorer-hybrid-qdrant-hnsw-v1",
          vectorGenerationId: "event30-v1",
          vectorCollection: "event30",
        },
      },
    });
  });
});
