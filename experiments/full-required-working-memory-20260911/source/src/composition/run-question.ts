import {
  runPicorer,
  type PicorerResult,
  type PicorerSkill,
} from "../evidence-agent/index.js";
import {
  loadPiModelRuntime,
  type LoadPiModelRuntimeOptions,
} from "../platform/pi/load-model-runtime.js";
import { MemoryStore } from "../platform/sqlite/picorer-store.js";
import type { RetrievalProfile } from "../retrieval/index.js";
import { createReadOnlyScopeNavigation } from "./create-read-only-navigation.js";
import { createRetrievalContext } from "./create-retrieval-context.js";

export interface PicorerWorkspacePaths {
  database: string;
  sanitized: string;
}

export async function runQuestion(
  paths: PicorerWorkspacePaths,
  retrievalProfile: RetrievalProfile,
  scopeId: string,
  question: string,
  questionDate: string | undefined,
  modelOptions: LoadPiModelRuntimeOptions,
  skill: PicorerSkill = "picorer-v0",
): Promise<PicorerResult> {
  const rawStore = await MemoryStore.create(paths.database);
  try {
    const modelRuntime = await loadPiModelRuntime(modelOptions);
    const retrieval = createRetrievalContext(rawStore, retrievalProfile);
    return await runPicorer({
      store: retrieval.store,
      operatorRegistry: retrieval.operatorRegistry,
      modelRuntime,
      scopeId,
      question,
      ...(questionDate === undefined ? {} : { questionDate }),
      skill,
      readOnlyNavigation: createReadOnlyScopeNavigation(
        paths.sanitized,
        scopeId,
      ),
    });
  } finally {
    rawStore.close();
  }
}
