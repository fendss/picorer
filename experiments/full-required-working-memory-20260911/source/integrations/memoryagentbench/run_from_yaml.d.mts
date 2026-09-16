export interface MemoryAgentBenchYamlConfiguration {
  configPath: string;
  paths: {
    root: string;
    source: string;
    dataDir: string;
    outputDir: string;
    runtimeDir: string;
    nltkData: string;
    embeddingEnv: string;
    node: string;
    uv: string;
  };
  credentials: {
    generation: { apiKey: string; baseUrl: string };
  };
  models: {
    retrieval: {
      id: string;
      routeId: string;
      protocol: string;
      thinkingLevel: string;
      contextWindow: number;
      maxTokens: number;
    };
    answer: {
      id: string;
      routeId: string;
      protocol: string;
      thinkingLevel: string;
      contextWindow: number;
      maxTokens: number;
    };
  };
  service: {
    host: string;
    port: number;
    sourceIdentity: string;
    buildIdentity: string;
    retrievalProfile: "picorer-hybrid" | "picorer-hybrid-qdrant-hnsw-v1";
    qdrant: {
      url: string;
      apiKey?: string;
      collection: string;
      vectorGenerationId: string;
      requestTimeoutMs: number;
      hnswM: number;
      efConstruct: number;
      hnswEf: number;
      fullScanThresholdKb: number;
      indexingThresholdKb: number;
      syncBatchSize: number;
      syncConcurrency: number;
      verificationPollMs: number;
      verificationTimeoutMs: number;
    } | null;
    skill: "none" | "picorer-minimal" | "picorer-v0";
    interfaceMode: "full" | "compact";
    requireWorkingMemory: boolean;
    maxRunMs: number;
    maxTurns: number;
    maxToolCalls: number;
    maxConcurrentWraps: number;
  };
  run: {
    tasks: string[];
    label: string;
    modes: string[];
    maxSearchCalls: number;
    maxContexts: number | null;
    maxQueries: number | null;
    slots: number;
    contextSlots: number;
    querySlots: number;
    adaptiveQuerySlots: {
      minimum: number;
      initial: number;
      maximum: number;
      successesPerIncrease: number;
    } | null;
    retryDelaySeconds: number;
    reuseIngestionFrom: Record<string, string>;
  };
}

export interface MemoryAgentBenchRunnerInvocation {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  output: string;
}

export function loadMemoryAgentBenchYaml(
  configPath: string,
): MemoryAgentBenchYamlConfiguration;

export function serviceEnvironment(
  config: MemoryAgentBenchYamlConfiguration,
  inherited?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function runtimeIdentityForConfig(
  config: MemoryAgentBenchYamlConfiguration,
): { contract: Record<string, unknown>; sha256: string };

export function runConfigIdentity(
  config: MemoryAgentBenchYamlConfiguration,
  task: string,
  mode: string,
): string;

export function artifactStatus(
  config: MemoryAgentBenchYamlConfiguration,
  task: string,
  mode: string,
): Record<string, unknown>;

export function runnerInvocation(
  config: MemoryAgentBenchYamlConfiguration,
  mode: string,
  outputPath?: string,
  task?: string,
  resume?: boolean,
): MemoryAgentBenchRunnerInvocation;
