export interface S50ModelConfiguration {
  id: string;
  thinkingLevel?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface S50YamlConfiguration {
  configPath: string;
  paths: {
    root: string;
    dataDir?: string;
    outputDir: string;
    evaluatorSource: string;
    embeddingEnv?: string;
  };
  source: { commit: string; fingerprint: string };
  credentials: {
    generation: { apiKey: string; baseUrl: string };
    judge: { apiKey: string; baseUrl: string };
  };
  models: {
    retrieval: S50ModelConfiguration;
    answer: S50ModelConfiguration;
    judge: S50ModelConfiguration;
  };
  run: {
    label: string;
    slots: number;
    maxSearchCalls: number;
    expectedQuestions: number;
    healthRetrySeconds: number;
  };
}

export function loadS50Yaml(configPath: string): S50YamlConfiguration;

export function environmentForS50(
  config: S50YamlConfiguration,
  inherited?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function validateS50Inputs(config: S50YamlConfiguration): void;
