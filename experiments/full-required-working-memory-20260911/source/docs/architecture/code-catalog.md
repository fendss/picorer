# Code Catalog

This file is generated from the TypeScript AST. It is the function-level directory for the project and must not be edited manually.

Run `npm run docs:catalog` after adding, removing, renaming, or moving source symbols.

## `src/agent-runtime/index.ts`

_No top-level functions, classes, or class methods._
## `src/agent-runtime/interactive-memory-agent.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `activeSkillPrompt(skill: InteractiveMemorySkill): string` | Implements the active skill prompt operation. | function | internal | [line 133](../../src/agent-runtime/interactive-memory-agent.ts#L133) |
| `interactiveMemorySystemPrompt(options: { domainPolicy: string; operatorRegistry: SearchOperatorCatalog; skill: InteractiveMemorySkill; }): string` | Implements the interactive memory system prompt operation. | function | exported | [line 140](../../src/agent-runtime/interactive-memory-agent.ts#L140) |
| `toolNames(context: BeforeToolCallContext): string[]` | Converts ol names. | function | internal | [line 156](../../src/agent-runtime/interactive-memory-agent.ts#L156) |
| `externalTool(definition: ExternalToolDefinition, capture: (call: ExternalToolCall) => void): AgentTool` | Implements the external tool operation. | function | internal | [line 165](../../src/agent-runtime/interactive-memory-agent.ts#L165) |
| `assertExternalDefinitions(definitions: readonly ExternalToolDefinition[]): void` | Validates external definitions and throws when invalid. | function | internal | [line 197](../../src/agent-runtime/interactive-memory-agent.ts#L197) |
| `InteractiveMemoryAgentSession` | Stateful Pi Agent session for live environments. | class | exported | [line 229](../../src/agent-runtime/interactive-memory-agent.ts#L229) |
| `InteractiveMemoryAgentSession.constructor(private readonly options: InteractiveMemoryAgentOptions)` | Creates a interactive memory agent session instance. | method | public | [line 249](../../src/agent-runtime/interactive-memory-agent.ts#L249) |
| `InteractiveMemoryAgentSession.toolResultMessages(results: readonly ExternalToolResult[]): ToolResultMessage[]` | Converts ol result messages. | method | private | [line 401](../../src/agent-runtime/interactive-memory-agent.ts#L401) |
| `InteractiveMemoryAgentSession.turn(input: InteractiveAgentInput): Promise<InteractiveAgentOutput>` | Implements the turn operation. | method | public | [line 427](../../src/agent-runtime/interactive-memory-agent.ts#L427) |
## `src/benchmark/adapters/pi/answer.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `answerSystemPrompt(prompt: BenchmarkAnswerPrompt, executionChecklist?: string): string` | Runs benchmark-owned answer synthesis after Picorer has finished retrieval. | function | internal | [line 21](../../src/benchmark/adapters/pi/answer.ts#L21) |
| `runBenchmarkAnswer(options: { modelRuntime: PiModelRuntime; prompt: BenchmarkAnswerPrompt; maxRunMs?: number; executionChecklist?: string; }): Promise<BenchmarkAnswerResult>` | Runs benchmark answer. | function | exported | [line 30](../../src/benchmark/adapters/pi/answer.ts#L30) |
## `src/benchmark/amabench/answer-contract.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `renderEvidence(memory: PicorerResult["evidence"][number]): string` | Renders evidence. | function | internal | [line 31](../../src/benchmark/amabench/answer-contract.ts#L31) |
| `buildAmaBenchAnswerPrompt(context: AmaBenchAnswerContext): BenchmarkAnswerPrompt` | Converts Picorer output to the benchmark-owned answer prompt. | function | exported | [line 41](../../src/benchmark/amabench/answer-contract.ts#L41) |
## `src/benchmark/amabench/dataset-adapter.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `objectAt(value: unknown, path: string): JsonObject` | Implements the object at operation. | function | internal | [line 90](../../src/benchmark/amabench/dataset-adapter.ts#L90) |
| `arrayAt(value: unknown, path: string): unknown[]` | Implements the array at operation. | function | internal | [line 97](../../src/benchmark/amabench/dataset-adapter.ts#L97) |
| `sourceTextAt(value: unknown, path: string): string` | Implements the source text at operation. | function | internal | [line 104](../../src/benchmark/amabench/dataset-adapter.ts#L104) |
| `nullableSourceTextAt(value: unknown, path: string): string \| null` | Implements the nullable source text at operation. | function | internal | [line 111](../../src/benchmark/amabench/dataset-adapter.ts#L111) |
| `nonNegativeIntegerAt(value: unknown, path: string): number` | Implements the non negative integer at operation. | function | internal | [line 122](../../src/benchmark/amabench/dataset-adapter.ts#L122) |
| `booleanAt(value: unknown, path: string): boolean` | Implements the boolean at operation. | function | internal | [line 129](../../src/benchmark/amabench/dataset-adapter.ts#L129) |
| `memberAt(value: unknown, allowed: ReadonlySet<string>, path: string): T` | Implements the member at operation. | function | internal | [line 136](../../src/benchmark/amabench/dataset-adapter.ts#L136) |
| `questionUuidAt(value: unknown, path: string): string` | Implements the question uuid at operation. | function | internal | [line 148](../../src/benchmark/amabench/dataset-adapter.ts#L148) |
| `amaBenchScopeId(episodeId: number): string` | Implements the ama bench scope id operation. | function | exported | [line 156](../../src/benchmark/amabench/dataset-adapter.ts#L156) |
| `amaBenchSessionId(scopeId: string): string` | Implements the ama bench session id operation. | function | exported | [line 161](../../src/benchmark/amabench/dataset-adapter.ts#L161) |
| `amaBenchMemoryId(scopeId: string, sourceCoordinate: "task" \| `step:${number}`): string` | Implements the ama bench memory id operation. | function | exported | [line 166](../../src/benchmark/amabench/dataset-adapter.ts#L166) |
| `renderAmaBenchStep(options: { turnIndex: number; action: string \| null; observation: string \| null; }): string` | Mirrors the official runner's trajectory text without normalizing payloads. | function | exported | [line 176](../../src/benchmark/amabench/dataset-adapter.ts#L176) |
| `adaptAmaBenchV4(raw: unknown): AmaBenchAdapterResult` | Trusted input firewall for AMA-Bench v4. | function | exported | [line 199](../../src/benchmark/amabench/dataset-adapter.ts#L199) |
| `parseAmaBenchV4Jsonl(serialized: string): unknown[]` | Parses ama bench v4 jsonl. | function | exported | [line 361](../../src/benchmark/amabench/dataset-adapter.ts#L361) |
| `loadPinnedAmaBenchV4File(path: string): Promise<AmaBenchAdapterResult>` | Loads only the byte-exact official v4 test artifact. | function | exported | [line 383](../../src/benchmark/amabench/dataset-adapter.ts#L383) |
## `src/benchmark/amabench/evaluation-contract.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `assertSameIdentity(query: AmaBenchPrivateQuery, label: AmaBenchPrivateLabel, prediction: AmaBenchQuestionPrediction): void` | Validates same identity and throws when invalid. | function | internal | [line 38](../../src/benchmark/amabench/evaluation-contract.ts#L38) |
| `buildAmaBenchEvaluatorInput(query: AmaBenchPrivateQuery, label: AmaBenchPrivateLabel, prediction: AmaBenchQuestionPrediction): AmaBenchEvaluatorInput` | Joins labels only at the evaluator boundary, after a prediction is frozen. | function | exported | [line 70](../../src/benchmark/amabench/evaluation-contract.ts#L70) |
| `buildAmaBenchEpisodeSubmissions(predictions: readonly AmaBenchQuestionPrediction[]): AmaBenchEpisodeSubmission[]` | Builds ama bench episode submissions. | function | exported | [line 92](../../src/benchmark/amabench/evaluation-contract.ts#L92) |
## `src/benchmark/amabench/index.ts`

_No top-level functions, classes, or class methods._
## `src/benchmark/amabench/judge.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `buildAmaBenchJudgePrompt(input: AmaBenchEvaluatorInput): string` | Exact prompt shape used by the pinned upstream v4 Python evaluator. | function | exported | [line 66](../../src/benchmark/amabench/judge.ts#L66) |
| `normalizeAmaBenchJudgeText(text: string): string` | Python-compatible normalization from the official fallback evaluator. | function | exported | [line 94](../../src/benchmark/amabench/judge.ts#L94) |
| `tokenCounts(tokens: readonly string[]): Map<string, number>` | Converts ken counts. | function | internal | [line 103](../../src/benchmark/amabench/judge.ts#L103) |
| `amaBenchTokenF1(predicted: string, golden: string): number` | Multiset token F1 used when upstream cannot parse a binary judge answer. | function | exported | [line 110](../../src/benchmark/amabench/judge.ts#L110) |
| `parseAmaBenchJudgeAnswer(judgeAnswer: string, predictedAnswer: string, goldenAnswer: string): AmaBenchParsedJudgeAnswer` | Removes closed think blocks, then follows upstream's "last complete word" rule. | function | exported | [line 137](../../src/benchmark/amabench/judge.ts#L137) |
| `judgeAmaBenchQuestion(options: { input: AmaBenchEvaluatorInput; modelRuntime: PiModelRuntime; maxRunMs?: number; }): Promise<AmaBenchJudgeResult>` | Implements the judge ama bench question operation. | function | exported | [line 173](../../src/benchmark/amabench/judge.ts#L173) |
| `bucket(results: readonly AmaBenchJudgeResult[]): AmaBenchJudgeBucket` | Implements the bucket operation. | function | internal | [line 214](../../src/benchmark/amabench/judge.ts#L214) |
| `groupBy(results: readonly AmaBenchJudgeResult[], keyFor: (result: AmaBenchJudgeResult) => K): Partial<Record<K, AmaBenchJudgeBucket>>` | Implements the group by operation. | function | internal | [line 225](../../src/benchmark/amabench/judge.ts#L225) |
| `aggregateAmaBenchJudgeResults(results: readonly AmaBenchJudgeResult[]): AmaBenchJudgeAggregate` | Implements the aggregate ama bench judge results operation. | function | exported | [line 246](../../src/benchmark/amabench/judge.ts#L246) |
## `src/benchmark/composition/ingest-evidence-benchmark.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `ingestEvidenceBenchmark(options: IngestEvidenceBenchmarkOptions): Promise<IngestMemoryWorkspaceResult>` | Applies the private-label firewall before delegating to generic ingest. | function | exported | [line 25](../../src/benchmark/composition/ingest-evidence-benchmark.ts#L25) |
## `src/benchmark/data-paths.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `evidenceBenchmarkDataPaths(dataDir: string): EvidenceBenchmarkDataPaths` | Filesystem layout shared by evidence-based benchmark adapters. | function | exported | [line 12](../../src/benchmark/data-paths.ts#L12) |
## `src/benchmark/index.ts`

_No top-level functions, classes, or class methods._
## `src/benchmark/label-firewall.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `normalizedKey(key: string): string` | Normalizes d key. | function | internal | [line 21](../../src/benchmark/label-firewall.ts#L21) |
| `assertNoPrivateLabels(value: unknown, path: string): void` | Validates no private labels and throws when invalid. | function | internal | [line 25](../../src/benchmark/label-firewall.ts#L25) |
| `assertBenchmarkLabelFirewall(sessions: readonly MemorySessionInput[]): void` | Benchmark ingress firewall. | function | exported | [line 45](../../src/benchmark/label-firewall.ts#L45) |
## `src/benchmark/longmemeval/data-paths.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `dataPaths(dataDir: string): LongMemEvalDataPaths` | Derives all persistent LongMemEval paths from one data directory. | function | exported | [line 9](../../src/benchmark/longmemeval/data-paths.ts#L9) |
## `src/benchmark/longmemeval/dataset-adapter.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `renderAnswerMemory(memory: PicorerResult["evidence"][number]): string` | Renders answer memory. | function | internal | [line 53](../../src/benchmark/longmemeval/dataset-adapter.ts#L53) |
| `buildLongMemEvalAnswerPrompt(question: string, retrieval: PicorerResult): BenchmarkAnswerPrompt` | Builds long mem eval answer prompt. | function | exported | [line 60](../../src/benchmark/longmemeval/dataset-adapter.ts#L60) |
| `objectAt(value: unknown, path: string): JsonObject` | Implements the object at operation. | function | internal | [line 104](../../src/benchmark/longmemeval/dataset-adapter.ts#L104) |
| `arrayAt(value: unknown, path: string): unknown[]` | Implements the array at operation. | function | internal | [line 111](../../src/benchmark/longmemeval/dataset-adapter.ts#L111) |
| `identifierAt(value: unknown, path: string): string` | Implements the identifier at operation. | function | internal | [line 118](../../src/benchmark/longmemeval/dataset-adapter.ts#L118) |
| `sourceTextAt(value: unknown, path: string): string` | Implements the source text at operation. | function | internal | [line 125](../../src/benchmark/longmemeval/dataset-adapter.ts#L125) |
| `rawStringAt(value: unknown, path: string): string` | Implements the raw string at operation. | function | internal | [line 132](../../src/benchmark/longmemeval/dataset-adapter.ts#L132) |
| `optionalSourceText(value: unknown, path: string): string \| undefined` | Implements the optional source text operation. | function | internal | [line 139](../../src/benchmark/longmemeval/dataset-adapter.ts#L139) |
| `timestampParts(raw: string, path: string): { year: number; month: number; day: number; hour: number; minute: number; }` | Implements the timestamp parts operation. | function | internal | [line 146](../../src/benchmark/longmemeval/dataset-adapter.ts#L146) |
| `twoDigits(value: number): string` | Implements the two digits operation. | function | internal | [line 178](../../src/benchmark/longmemeval/dataset-adapter.ts#L178) |
| `normalizeLongMemEvalTimestamp(raw: string, path = "timestamp"): string` | LongMemEval timestamps carry no timezone. | function | exported | [line 186](../../src/benchmark/longmemeval/dataset-adapter.ts#L186) |
| `longMemEvalScopeId(questionId: string): string` | Implements the long mem eval scope id operation. | function | exported | [line 194](../../src/benchmark/longmemeval/dataset-adapter.ts#L194) |
| `longMemEvalSessionId(scopeId: string, sourceSessionId: string): string` | Implements the long mem eval session id operation. | function | exported | [line 199](../../src/benchmark/longmemeval/dataset-adapter.ts#L199) |
| `longMemEvalMemoryId(scopeId: string, sourceDiaId: string): string` | Implements the long mem eval memory id operation. | function | exported | [line 208](../../src/benchmark/longmemeval/dataset-adapter.ts#L208) |
| `roleFor(speaker: string, speakerA: string, speakerB: string): MemoryRole` | Implements the role for operation. | function | internal | [line 217](../../src/benchmark/longmemeval/dataset-adapter.ts#L217) |
| `numericSessionIndex(key: string): number` | Implements the numeric session index operation. | function | internal | [line 237](../../src/benchmark/longmemeval/dataset-adapter.ts#L237) |
| `adaptLongMemEvalS(raw: unknown): LongMemEvalAdapterResult` | Trusted benchmark boundary. | function | exported | [line 248](../../src/benchmark/longmemeval/dataset-adapter.ts#L248) |
| `loadLongMemEvalS(path: string): Promise<LongMemEvalAdapterResult>` | Loads long mem eval s. | function | exported | [line 406](../../src/benchmark/longmemeval/dataset-adapter.ts#L406) |
## `src/benchmark/memoryagentbench/answer-contract.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `renderEvidence(memory: PicorerResult["evidence"][number]): string` | Renders evidence. | function | internal | [line 36](../../src/benchmark/memoryagentbench/answer-contract.ts#L36) |
| `buildMemoryAgentBenchAnswerPrompt(question: MemoryAgentBenchQuestion, retrieval: PicorerResult): BenchmarkAnswerPrompt` | Keeps MemoryAgentBench's task instruction intact while replacing the benchmark's hidden archival-memory implementation with Picorer's exact read package. | function | exported | [line 57](../../src/benchmark/memoryagentbench/answer-contract.ts#L57) |
## `src/benchmark/memoryagentbench/dataset.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `objectAt(value: unknown, path: string): Record<string, unknown>` | Implements the object at operation. | function | internal | [line 25](../../src/benchmark/memoryagentbench/dataset.ts#L25) |
| `stringAt(object: Record<string, unknown>, key: string, path: string): string` | Implements the string at operation. | function | internal | [line 32](../../src/benchmark/memoryagentbench/dataset.ts#L32) |
| `integerAt(object: Record<string, unknown>, key: string, path: string): number` | Implements the integer at operation. | function | internal | [line 44](../../src/benchmark/memoryagentbench/dataset.ts#L44) |
| `jsonLines(source: string, path: string): unknown[]` | Implements the json lines operation. | function | internal | [line 56](../../src/benchmark/memoryagentbench/dataset.ts#L56) |
| `readMemoryAgentBenchQuestions(inputRoot: string, subset: string): Promise<MemoryAgentBenchQuestion[]>` | Reads memory agent bench questions. | function | exported | [line 66](../../src/benchmark/memoryagentbench/dataset.ts#L66) |
| `readMemoryAgentBenchSessions(inputRoot: string, subset: string, contextId: string): Promise<MemorySessionInput[]>` | Reads memory agent bench sessions. | function | exported | [line 109](../../src/benchmark/memoryagentbench/dataset.ts#L109) |
## `src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `chunkHash(chunk: string): string` | Implements the chunk hash operation. | function | internal | [line 22](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L22) |
| `nonNegativeInteger(value: unknown, path: string): number` | Implements the non negative integer operation. | function | internal | [line 26](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L26) |
| `stringValue(value: unknown, path: string): string` | Implements the string value operation. | function | internal | [line 37](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L37) |
| `cloneState(state: MemoryArenaGenerationState): MemoryArenaGenerationState` | Implements the clone state operation. | function | internal | [line 42](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L42) |
| `cloneUsers(users: Map<string, MemoryArenaGenerationState>): Map<string, MemoryArenaGenerationState>` | Implements the clone users operation. | function | internal | [line 51](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L51) |
| `parseState(value: unknown): Map<string, MemoryArenaGenerationState>` | Parses state. | function | internal | [line 59](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L59) |
| `FileMemoryArenaGenerationStore` | Durable active-generation sidecar. | class | exported | [line 124](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L124) |
| `FileMemoryArenaGenerationStore.constructor(readonly path: string)` | Creates a file memory arena generation store instance. | method | public | [line 128](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L128) |
| `FileMemoryArenaGenerationStore.initialize(userId: string, memorySystemName: string): Promise<MemoryArenaGenerationState>` | Implements the initialize operation. | method | public | [line 130](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L130) |
| `FileMemoryArenaGenerationStore.get(userId: string): Promise<MemoryArenaGenerationState \| undefined>` | Implements the get operation. | method | public | [line 154](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L154) |
| `FileMemoryArenaGenerationStore.reserveAppend(options: { userId: string; generation: number; chunk: string; }): Promise<number>` | Implements the reserve append operation. | method | public | [line 161](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L161) |
| `FileMemoryArenaGenerationStore.completeAppend(options: { userId: string; generation: number; ordinal: number; chunk: string; }): Promise<MemoryArenaGenerationState>` | Implements the complete append operation. | method | public | [line 190](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L190) |
| `FileMemoryArenaGenerationStore.active(users: Map<string, MemoryArenaGenerationState>, userId: string, generation: number): MemoryArenaGenerationState` | Implements the active operation. | method | private | [line 218](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L218) |
| `FileMemoryArenaGenerationStore.load(): Promise<Map<string, MemoryArenaGenerationState>>` | Loads the requested resource. | method | private | [line 237](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L237) |
| `FileMemoryArenaGenerationStore.persist(users: Map<string, MemoryArenaGenerationState>): Promise<void>` | Implements the persist operation. | method | private | [line 251](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L251) |
| `FileMemoryArenaGenerationStore.locked(operation: () => Promise<T>): Promise<T>` | Implements the locked operation. | method | private | [line 270](../../src/benchmark/memoryarena-public/adapters/filesystem-generation-store.ts#L270) |
## `src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `embeddingMetrics(metrics: MemoryArenaEmbeddingMetrics): Record<string, number>` | Implements the embedding metrics operation. | function | internal | [line 19](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L19) |
| `embeddingAudit(audit: MemoryArenaOperationEmbeddingAudit): Record<string, unknown>` | Implements the embedding audit operation. | function | internal | [line 30](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L30) |
| `artifactUnavailable(cause: unknown): MemoryArenaPublicError` | Implements the artifact unavailable operation. | function | internal | [line 39](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L39) |
| `JsonlMemoryArenaOperationAuditSink` | Durable, privacy-safe lifecycle log for the official initialize/add/wrap API. | class | exported | [line 55](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L55) |
| `JsonlMemoryArenaOperationAuditSink.constructor(readonly path: string)` | Creates a jsonl memory arena operation audit sink instance. | method | public | [line 59](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L59) |
| `JsonlMemoryArenaOperationAuditSink.begin(record: MemoryArenaOperationAuditStart): Promise<MemoryArenaOperationAuditSpan>` | Implements the begin operation. | method | public | [line 61](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L61) |
| `JsonlMemoryArenaOperationAuditSink.flush(): Promise<void>` | Implements the flush operation. | method | public | [line 151](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L151) |
| `JsonlMemoryArenaOperationAuditSink.append(record: Record<string, unknown>): Promise<void>` | Implements the append operation. | method | private | [line 155](../../src/benchmark/memoryarena-public/adapters/jsonl-operation-audit-sink.ts#L155) |
## `src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `JsonlMemoryArenaWrapAuditSink` | Implements jsonl memory arena wrap audit sink. | class | exported | [line 10](../../src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts#L10) |
| `JsonlMemoryArenaWrapAuditSink.constructor(readonly path: string)` | Creates a jsonl memory arena wrap audit sink instance. | method | public | [line 13](../../src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts#L13) |
| `JsonlMemoryArenaWrapAuditSink.record(record: MemoryArenaWrapAuditRecord): Promise<void>` | Implements the record operation. | method | public | [line 15](../../src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts#L15) |
| `JsonlMemoryArenaWrapAuditSink.flush(): Promise<void>` | Implements the flush operation. | method | public | [line 43](../../src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts#L43) |
| `NoopMemoryArenaWrapAuditSink` | Implements noop memory arena wrap audit sink. | class | exported | [line 48](../../src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts#L48) |
| `NoopMemoryArenaWrapAuditSink.record(_record: MemoryArenaWrapAuditRecord): Promise<void>` | Implements the record operation. | method | public | [line 49](../../src/benchmark/memoryarena-public/adapters/jsonl-wrap-audit-sink.ts#L49) |
## `src/benchmark/memoryarena-public/adapters/measured-embedder.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `zeroAccumulator(): OperationAccumulator` | Implements the zero accumulator operation. | function | internal | [line 30](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L30) |
| `embeddingAudit(accumulator: OperationAccumulator): MemoryArenaOperationEmbeddingAudit` | Implements the embedding audit operation. | function | internal | [line 40](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L40) |
| `attachEmbeddingDiagnostics(error: unknown, embedding: MemoryArenaOperationEmbeddingAudit): Error` | Implements the attach embedding diagnostics operation. | function | internal | [line 54](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L54) |
| `MemoryArenaMeasuredEmbedder` | Routes exact provider-attempt metrics through async context to the add/wrap operation that initiated each call. | class | exported | [line 81](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L81) |
| `MemoryArenaMeasuredEmbedder.constructor(private readonly delegate: MemoryArenaAttemptMeteredEmbedder)` | Creates a memory arena measured embedder instance. | method | public | [line 91](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L91) |
| `MemoryArenaMeasuredEmbedder.measureOperation(operation: () => Promise<T>): Promise<{ result: T; embedding: MemoryArenaOperationEmbeddingAudit; }>` | Implements the measure operation operation. | method | public | [line 99](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L99) |
| `MemoryArenaMeasuredEmbedder.embedDocuments(texts: readonly string[], options: EmbeddingRequestOptions = {}): Promise<number[][]>` | Implements the embed documents operation. | method | public | [line 117](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L117) |
| `MemoryArenaMeasuredEmbedder.embedQueries(texts: readonly string[], options: EmbeddingRequestOptions = {}): Promise<number[][]>` | Implements the embed queries operation. | method | public | [line 124](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L124) |
| `MemoryArenaMeasuredEmbedder.snapshotMetrics(): EmbeddingMetrics` | Implements the snapshot metrics operation. | method | public | [line 131](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L131) |
| `MemoryArenaMeasuredEmbedder.measuredCall(operation: () => Promise<T>): Promise<T>` | Implements the measured call operation. | method | private | [line 135](../../src/benchmark/memoryarena-public/adapters/measured-embedder.ts#L135) |
## `src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `memoryArenaPublicScopeId(userId: string, generation: number): string` | Implements the memory arena public scope id operation. | function | exported | [line 51](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L51) |
| `appendRequestIdentity(options: { userId: string; generation: number; ordinal: number; chunk: string; messages?: readonly MemoryArenaAppendMessage[]; }): { requestId: string; requestHash: string; sourceSessionId: string }` | Implements the append request identity operation. | function | internal | [line 58](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L58) |
| `memoryArenaRetryableUpstreamError(error: unknown): boolean` | Implements the memory arena retryable upstream error operation. | function | exported | [line 81](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L81) |
| `memoryArenaUpstreamAuthStatus(error: unknown): 401 \| 403 \| undefined` | Implements the memory arena upstream auth status operation. | function | exported | [line 88](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L88) |
| `mapUpstreamError(error: unknown, operation: string): never` | Implements the map upstream error operation. | function | internal | [line 105](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L105) |
| `errorRecord(error: unknown): Record<string, unknown> \| undefined` | Implements the error record operation. | function | internal | [line 141](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L141) |
| `memoryArenaPicorerRunFailure(error: unknown): MemoryArenaPublicError \| undefined` | Converts Picorer method/provider failures into a stable, content-free API policy. | function | exported | [line 148](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L148) |
| `PicorerMemoryArenaAdapter` | Maps the official memory backend lifecycle onto immutable Picorer source chunks. | class | exported | [line 216](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L216) |
| `PicorerMemoryArenaAdapter.constructor(private readonly options: PicorerMemoryArenaAdapterOptions)` | Creates a Picorer MemoryArena adapter instance. | method | public | [line 220](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L220) |
| `PicorerMemoryArenaAdapter.appendOriginalChunk(options: { userId: string; generation: number; ordinal: number; chunk: string; messages?: readonly MemoryArenaAppendMessage[]; }): Promise<void>` | Implements the append original chunk operation. | method | public | [line 224](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L224) |
| `PicorerMemoryArenaAdapter.readOriginalChunks(options: { userId: string; generation: number; memoryIds: readonly string[]; }): Promise<MemoryArenaOriginalChunk[]>` | Reads original chunks. | method | public | [line 269](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L269) |
| `PicorerMemoryArenaAdapter.retrieve(options: { userId: string; generation: number; question: string; operatorExperiment?: MemoryArenaOperatorExperimentInput; }): Promise<MemoryArenaRetrievalResult>` | Implements the retrieve operation. | method | public | [line 280](../../src/benchmark/memoryarena-public/adapters/picorer-memory-runtime.ts#L280) |
## `src/benchmark/memoryarena-public/composition/create-runtime.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `loadOrCreatePersistenceIdentity(path: string): Promise<string>` | Loads or create persistence identity. | function | internal | [line 86](../../src/benchmark/memoryarena-public/composition/create-runtime.ts#L86) |
| `exists(path: string): Promise<boolean>` | Implements the exists operation. | function | internal | [line 126](../../src/benchmark/memoryarena-public/composition/create-runtime.ts#L126) |
| `fileErrorCode(error: unknown): string \| undefined` | Implements the file error code operation. | function | internal | [line 141](../../src/benchmark/memoryarena-public/composition/create-runtime.ts#L141) |
| `processIsAlive(pid: number): boolean` | Implements the process is alive operation. | function | internal | [line 147](../../src/benchmark/memoryarena-public/composition/create-runtime.ts#L147) |
| `acquireMemoryArenaPublicDataDirectoryLease(dataDir: string): Promise<MemoryArenaPublicDataDirectoryLease>` | Prevents independent server processes from corrupting one generation sidecar. | function | exported | [line 157](../../src/benchmark/memoryarena-public/composition/create-runtime.ts#L157) |
| `createMemoryArenaPublicRuntime(options: CreateMemoryArenaPublicRuntimeOptions): Promise<MemoryArenaPublicRuntime>` | Wires the official HTTP memory contract to Picorer without benchmark policy. | function | exported | [line 225](../../src/benchmark/memoryarena-public/composition/create-runtime.ts#L225) |
## `src/benchmark/memoryarena-public/index.ts`

_No top-level functions, classes, or class methods._
## `src/benchmark/memoryarena-public/model/failure-diagnostics.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `recordValue(value: unknown): Record<string, unknown> \| undefined` | Implements the record value operation. | function | internal | [line 3](../../src/benchmark/memoryarena-public/model/failure-diagnostics.ts#L3) |
| `finiteNumber(record: Record<string, unknown>, key: string): number \| undefined` | Implements the finite number operation. | function | internal | [line 9](../../src/benchmark/memoryarena-public/model/failure-diagnostics.ts#L9) |
| `safeCount(record: Record<string, unknown>, key: string): number \| undefined` | Implements the safe count operation. | function | internal | [line 19](../../src/benchmark/memoryarena-public/model/failure-diagnostics.ts#L19) |
| `safeProviderFailureKind(value: unknown): MemoryArenaOperationFailedRetrieval["providerFailureKind"]` | Implements the safe provider failure kind operation. | function | internal | [line 41](../../src/benchmark/memoryarena-public/model/failure-diagnostics.ts#L41) |
| `safeProviderResponseModel(value: unknown): string \| undefined` | Implements the safe provider response model operation. | function | internal | [line 49](../../src/benchmark/memoryarena-public/model/failure-diagnostics.ts#L49) |
| `modelUsage(value: unknown): MemoryArenaOperationFailedRetrieval["usage"] \| undefined` | Implements the model usage operation. | function | internal | [line 56](../../src/benchmark/memoryarena-public/model/failure-diagnostics.ts#L56) |
| `memoryArenaPicorerFailureDiagnostics(error: unknown): MemoryArenaOperationFailedRetrieval \| undefined` | Extracts only bounded, content-free execution metadata from a PicorerRunError and its cause chain. | function | exported | [line 104](../../src/benchmark/memoryarena-public/model/failure-diagnostics.ts#L104) |
## `src/benchmark/memoryarena-public/model/memory-backend.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `MemoryArenaPublicError` | Implements memory arena public error. | class | exported | [line 220](../../src/benchmark/memoryarena-public/model/memory-backend.ts#L220) |
| `MemoryArenaPublicError.constructor(options: { code: MemoryArenaErrorCode; message: string; httpStatus: number; retryable?: boolean; cause?: unknown; diagnostics?: MemoryArenaOperationErrorDiagnostics; })` | Creates a memory arena public error instance. | method | public | [line 226](../../src/benchmark/memoryarena-public/model/memory-backend.ts#L226) |
| `MemoryArenaOperationDiagnosticError` | Preserves operation diagnostics without changing an internal error into HTTP policy. | class | exported | [line 246](../../src/benchmark/memoryarena-public/model/memory-backend.ts#L246) |
| `MemoryArenaOperationDiagnosticError.constructor(options: { message: string; cause: unknown; diagnostics: MemoryArenaOperationErrorDiagnostics; })` | Creates a memory arena operation diagnostic error instance. | method | public | [line 249](../../src/benchmark/memoryarena-public/model/memory-backend.ts#L249) |
| `userNotInitialized(): MemoryArenaPublicError` | Implements the user not initialized operation. | function | exported | [line 260](../../src/benchmark/memoryarena-public/model/memory-backend.ts#L260) |
| `memorySystemMismatch(): MemoryArenaPublicError` | Implements the memory system mismatch operation. | function | exported | [line 268](../../src/benchmark/memoryarena-public/model/memory-backend.ts#L268) |
| `unsupportedMemorySystem(name: string): MemoryArenaPublicError` | Implements the unsupported memory system operation. | function | exported | [line 276](../../src/benchmark/memoryarena-public/model/memory-backend.ts#L276) |
## `src/benchmark/memoryarena-public/ports/memory-backend.ts`

_No top-level functions, classes, or class methods._
## `src/benchmark/memoryarena-public/use-cases/memory-backend.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `sha256(value: string): string` | Implements the sha256 operation. | function | internal | [line 30](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L30) |
| `operationFailure(error: unknown): MemoryArenaOperationAuditFailure` | Implements the operation failure operation. | function | internal | [line 34](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L34) |
| `operationEmbeddingDiagnostics(error: unknown): MemoryArenaOperationEmbeddingAudit \| undefined` | Implements the operation embedding diagnostics operation. | function | internal | [line 55](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L55) |
| `operationAuditUnavailable(error: unknown, embedding?: MemoryArenaOperationEmbeddingAudit): MemoryArenaPublicError` | Implements the operation audit unavailable operation. | function | internal | [line 76](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L76) |
| `cloneRetrieval(retrieval: MemoryArenaRetrievalResult): MemoryArenaRetrievalResult` | Implements the clone retrieval operation. | function | internal | [line 97](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L97) |
| `sourceIntegrityError(message: string): MemoryArenaPublicError` | Implements the source integrity error operation. | function | internal | [line 138](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L138) |
| `validateCommittedEvidence(retrieval: MemoryArenaRetrievalResult): MemoryArenaCommittedEvidence[]` | Validates committed evidence. | function | internal | [line 146](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L146) |
| `renderMemoryArenaPublicPrompt(question: string, chunks: readonly string[]): string` | Renders memory arena public prompt. | function | exported | [line 229](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L229) |
| `renderCommittedMemory(source: MemoryArenaCommittedEvidence): string` | Renders committed memory. | function | internal | [line 243](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L243) |
| `renderMemoryArenaEvidenceSources(question: string, retrieval: MemoryArenaRetrievalResult, contentByMemoryId?: ReadonlyMap<string, string>): string` | Renders memory arena evidence sources. | function | internal | [line 262](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L262) |
| `renderMemoryArenaEvidencePrompt(question: string, retrieval: MemoryArenaRetrievalResult, originalContentByMemoryId?: ReadonlyMap<string, string>): string` | Evidence-aware answer handoff used by agentic-memory harnesses. | function | exported | [line 292](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L292) |
| `MemoryArenaPublicMemoryBackend` | Implements memory arena public memory backend. | class | exported | [line 321](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L321) |
| `MemoryArenaPublicMemoryBackend.constructor(private readonly dependencies: MemoryArenaPublicBackendDependencies)` | Creates a memory arena public memory backend instance. | method | public | [line 322](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L322) |
| `MemoryArenaPublicMemoryBackend.initialize(input: MemoryArenaInitializeInput): Promise<MemoryArenaInitializeResult>` | Implements the initialize operation. | method | public | [line 328](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L328) |
| `MemoryArenaPublicMemoryBackend.add(input: MemoryArenaAddInput): Promise<MemoryArenaAddResult>` | Implements the add operation. | method | public | [line 352](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L352) |
| `MemoryArenaPublicMemoryBackend.wrap(input: MemoryArenaWrapInput): Promise<MemoryArenaWrapResult>` | Implements the wrap operation. | method | public | [line 392](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L392) |
| `MemoryArenaPublicMemoryBackend.audited(start: MemoryArenaOperationAuditStart, operation: () => Promise<{ result: T; audit: MemoryArenaOperationAuditSuccess; }>): Promise<T>` | Implements the audited operation. | method | private | [line 533](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L533) |
| `MemoryArenaPublicMemoryBackend.assertSupportedSystem(memorySystemName: string): void` | Validates supported system and throws when invalid. | method | private | [line 586](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L586) |
| `MemoryArenaPublicMemoryBackend.activeState(input: MemoryArenaInitializeInput): Promise<MemoryArenaGenerationState>` | Implements the active state operation. | method | private | [line 592](../../src/benchmark/memoryarena-public/use-cases/memory-backend.ts#L592) |
## `src/benchmark/model/answer.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `BenchmarkAnswerError` | A failed answer still owns its provider usage and exact prompt identity. | class | exported | [line 35](../../src/benchmark/model/answer.ts#L35) |
| `BenchmarkAnswerError.constructor(message: string, readonly diagnostics: BenchmarkAnswerFailureDiagnostics)` | Creates a benchmark answer error instance. | method | public | [line 36](../../src/benchmark/model/answer.ts#L36) |
| `returnedModelMatches(requested: string, returned: string): boolean` | Checks whether the provider's response model matches the requested model. | function | exported | [line 49](../../src/benchmark/model/answer.ts#L49) |
## `src/benchmark/model/benchmark-query.ts`

_No top-level functions, classes, or class methods._
## `src/benchmark/model/benchmark-run.ts`

_No top-level functions, classes, or class methods._
## `src/benchmark/model/evidence-benchmark-run.ts`

_No top-level functions, classes, or class methods._
## `src/benchmark/tau-knowledge/data-paths.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `tauKnowledgeDataPaths(root: string): TauKnowledgeDataPaths` | Implements the tau knowledge data paths operation. | function | exported | [line 10](../../src/benchmark/tau-knowledge/data-paths.ts#L10) |
## `src/benchmark/tau-knowledge/dataset-adapter.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `objectAt(value: unknown, path: string): JsonObject` | Implements the object at operation. | function | internal | [line 47](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L47) |
| `sourceTextAt(value: unknown, path: string): string` | Implements the source text at operation. | function | internal | [line 54](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L54) |
| `safeDocumentId(value: unknown, path: string): string` | Implements the safe document id operation. | function | internal | [line 61](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L61) |
| `parseTauKnowledgeDocument(value: unknown, path = "document"): TauKnowledgeDocument` | Parses tau knowledge document. | function | exported | [line 69](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L69) |
| `adaptTauKnowledgeDocuments(documents: readonly TauKnowledgeDocument[]): MemorySessionInput[]` | Trusted ingest firewall. | function | exported | [line 85](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L85) |
| `portableRelative(root: string, path: string): string` | Implements the portable relative operation. | function | internal | [line 115](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L115) |
| `hashTauKnowledgeFiles(domainRoot: string, paths: readonly string[]): Promise<string>` | Hashes path and bytes in lexical path order; filenames are part of identity. | function | exported | [line 120](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L120) |
| `jsonFiles(directory: string, pattern: RegExp): Promise<string[]>` | Implements the json files operation. | function | internal | [line 134](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L134) |
| `loadPinnedTauKnowledgeCheckout(tauRoot: string): Promise<TauKnowledgeDataset>` | Loads pinned tau knowledge checkout. | function | exported | [line 141](../../src/benchmark/tau-knowledge/dataset-adapter.ts#L141) |
## `src/benchmark/tau-knowledge/index.ts`

_No top-level functions, classes, or class methods._
## `src/cli.ts`

_No top-level functions, classes, or class methods._
## `src/composition/create-read-only-navigation.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createReadOnlyScopeNavigation(scopeRoot: string, scopeId: string): ReadOnlyNavigationBinding` | Creates read only scope navigation. | function | exported | [line 6](../../src/composition/create-read-only-navigation.ts#L6) |
## `src/composition/create-retrieval-context.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createRetrievalContext(rawStore: MemoryStore, profile: RetrievalProfile, embedder?: Embedder, environment: NodeJS.ProcessEnv = process.env): RetrievalContext` | Creates retrieval context. | function | exported | [line 25](../../src/composition/create-retrieval-context.ts#L25) |
## `src/composition/create-search-operator-registry.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createSearchOperatorRegistry(store: SearchOperatorStore, additionalOperators: readonly SearchOperator[] = []): SearchOperatorRegistry` | Registers built-in and additional operators, then freezes the catalog. | function | exported | [line 9](../../src/composition/create-search-operator-registry.ts#L9) |
| `createSelectedSearchOperatorRegistry(store: SearchOperatorStore, builtInOperatorIds: readonly string[], additionalOperators: readonly SearchOperator[] = []): SearchOperatorRegistry` | Registers an explicit allowlist of built-in and additional operators for one run. | function | exported | [line 28](../../src/composition/create-search-operator-registry.ts#L28) |
## `src/composition/ingest-memory-workspace.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `ingestMemoryWorkspace(options: IngestMemoryWorkspaceOptions): Promise<IngestMemoryWorkspaceResult>` | Wires immutable session ingest to SQLite and optional embeddings. | function | exported | [line 41](../../src/composition/ingest-memory-workspace.ts#L41) |
## `src/composition/load-search-operator-plugins.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `pluginModule(value: unknown, path: string): SearchOperatorPluginModule` | Implements the plugin module operation. | function | internal | [line 20](../../src/composition/load-search-operator-plugins.ts#L20) |
| `loadSearchOperatorPlugins(paths: readonly string[], store: SearchOperatorStore): Promise<LoadedSearchOperatorPlugins>` | Loads trusted local modules once at composition time and fingerprints them. | function | exported | [line 34](../../src/composition/load-search-operator-plugins.ts#L34) |
## `src/composition/qdrant-retrieval.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `environmentInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number` | Implements the environment integer operation. | function | internal | [line 14](../../src/composition/qdrant-retrieval.ts#L14) |
| `qdrantVectorSearchConfiguration(config: QdrantRetrievalConfiguration): VectorSearchConfiguration` | Projects result-affecting Qdrant settings into the runtime identity. | function | exported | [line 42](../../src/composition/qdrant-retrieval.ts#L42) |
| `qdrantRetrievalConfiguration(embedder: Embedder, environment: NodeJS.ProcessEnv = process.env): QdrantRetrievalConfiguration` | Resolves one pinned Qdrant generation without leaking environment into domains. | function | exported | [line 58](../../src/composition/qdrant-retrieval.ts#L58) |
| `createQdrantDenseRetriever(store: MemoryStore, embedder: Embedder, environment: NodeJS.ProcessEnv = process.env): QdrantDenseRetriever` | Creates qdrant dense retriever. | function | exported | [line 135](../../src/composition/qdrant-retrieval.ts#L135) |
| `publishQdrantGeneration(store: MemoryStore, embedder: Embedder, scopeIds: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<VectorIndexGenerationStatus>` | Enqueues existing SQLite embeddings and atomically publishes a generation. | function | exported | [line 151](../../src/composition/qdrant-retrieval.ts#L151) |
## `src/composition/run-question.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `runQuestion(paths: PicorerWorkspacePaths, retrievalProfile: RetrievalProfile, scopeId: string, question: string, questionDate: string \| undefined, modelOptions: LoadPiModelRuntimeOptions, skill: PicorerSkill = "picorer-v0"): Promise<PicorerResult>` | Runs question. | function | exported | [line 20](../../src/composition/run-question.ts#L20) |
## `src/composition/scoped-qdrant-retrieval.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `corpusFingerprint(records: readonly MemoryRecord[]): string` | Implements the corpus fingerprint operation. | function | internal | [line 14](../../src/composition/scoped-qdrant-retrieval.ts#L14) |
| `scopedQdrantGenerationId(baseGenerationId: string, scopeId: string, records: readonly MemoryRecord[]): string` | Implements the scoped qdrant generation id operation. | function | exported | [line 20](../../src/composition/scoped-qdrant-retrieval.ts#L20) |
| `ScopedQdrantRetrieval` | Publishes and reuses the immutable Qdrant generation for a scope version. | class | exported | [line 39](../../src/composition/scoped-qdrant-retrieval.ts#L39) |
| `ScopedQdrantRetrieval.constructor(private readonly store: MemoryStore, private readonly embedder: Embedder, private readonly environment: NodeJS.ProcessEnv = process.env)` | Creates a scoped qdrant retrieval instance. | method | public | [line 43](../../src/composition/scoped-qdrant-retrieval.ts#L43) |
| `ScopedQdrantRetrieval.generationEnvironment(scopeId: string): { environment: NodeJS.ProcessEnv; generationId: string; }` | Implements the generation environment operation. | method | private | [line 54](../../src/composition/scoped-qdrant-retrieval.ts#L54) |
| `ScopedQdrantRetrieval.context(scopeId: string): Promise<RetrievalContext>` | Implements the context operation. | method | public | [line 73](../../src/composition/scoped-qdrant-retrieval.ts#L73) |
## `src/entrypoints/cli/commands/benchmark-evidence.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `datasetRetrievalProfile(manifest: DatasetManifest): RetrievalProfile` | Implements the dataset retrieval profile operation. | function | internal | [line 88](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L88) |
| `benchmarkFor(parsed: ParsedCommand): EvidenceBenchmarkId` | Implements the benchmark for operation. | function | internal | [line 109](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L109) |
| `selectQueries(queries: readonly RunnableQuery[], requestedIds: ReadonlySet<string>): RunnableQuery[]` | Implements the select queries operation. | function | internal | [line 117](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L117) |
| `recordPath(directory: string, caseId: string): string` | Implements the record path operation. | function | internal | [line 135](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L135) |
| `directoryHasRecords(directory: string): Promise<boolean>` | Implements the directory has records operation. | function | internal | [line 139](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L139) |
| `loadSuccessRecordIds(directory: string, benchmark: EvidenceBenchmarkId, queries: readonly RunnableQuery[]): Promise<Set<string>>` | Loads success record ids. | function | internal | [line 150](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L150) |
| `materializeArtifacts(options: { outputDir: string; benchmark: EvidenceBenchmarkId; queries: readonly RunnableQuery[]; }): Promise<{ succeeded: number; failed: number }>` | Materializes artifacts. | function | internal | [line 172](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L172) |
| `predictionFor(options: { benchmark: EvidenceBenchmarkId; query: RunnableQuery; retrieval: PicorerResult; answer: Awaited<ReturnType<typeof runBenchmarkAnswer>>; }): EvidenceBenchmarkPrediction` | Implements the prediction for operation. | function | internal | [line 232](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L232) |
| `answerPromptFor(_benchmark: EvidenceBenchmarkId, query: RunnableQuery, retrieval: PicorerResult)` | Implements the answer prompt for operation. | function | internal | [line 258](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L258) |
| `modelFlagsForRun(): string[]` | Implements the model flags for run operation. | function | internal | [line 266](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L266) |
| `benchmarkEvidence(parsed: ParsedCommand): Promise<void>` | Implements the benchmark evidence operation. | function | exported | [line 275](../../src/entrypoints/cli/commands/benchmark-evidence.ts#L275) |
## `src/entrypoints/cli/commands/benchmark-longmemeval.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `successRecordPath(recordsDir: string, questionId: string): string` | Implements the success record path operation. | function | internal | [line 70](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L70) |
| `failureRecordPath(failuresDir: string, questionId: string): string` | Implements the failure record path operation. | function | internal | [line 74](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L74) |
| `completedQuestionIds(path: string): Promise<Set<string>>` | Implements the completed question ids operation. | function | internal | [line 78](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L78) |
| `predictionFor(retrieval: PicorerResult, answer: BenchmarkAnswerResult, questionId: string): BenchmarkPrediction` | Implements the prediction for operation. | function | internal | [line 96](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L96) |
| `loadSuccessRecords(recordsDir: string, questions: readonly LongMemEvalPrivateQuestion[]): Promise<Map<string, BenchmarkSuccessRecord>>` | Loads success records. | function | internal | [line 124](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L124) |
| `readJsonlMap(path: string): Promise<Map<string, unknown>>` | Reads jsonl map. | function | internal | [line 145](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L145) |
| `materializeBenchmarkArtifacts(outputDir: string, selected: readonly LongMemEvalPrivateQuestion[]): Promise<{ succeeded: number; failed: number }>` | Materializes benchmark artifacts. | function | internal | [line 165](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L165) |
| `systemicRuntimeFailure(message: string): boolean` | Implements the systemic runtime failure operation. | function | internal | [line 236](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L236) |
| `benchmarkLongMemEval(parsed: ParsedCommand): Promise<void>` | Implements the benchmark long mem eval operation. | function | exported | [line 242](../../src/entrypoints/cli/commands/benchmark-longmemeval.ts#L242) |
## `src/entrypoints/cli/commands/benchmark-memoryagentbench.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `evolutionMode(parsed: ParsedCommand): MemoryAgentBenchEvolutionMode` | Implements the evolution mode operation. | function | internal | [line 76](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L76) |
| `optionalQuestionLimit(parsed: ParsedCommand): number \| undefined` | Implements the optional question limit operation. | function | internal | [line 84](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L84) |
| `zeroTemperature(runtime: PiModelRuntime): PiModelRuntime` | Implements the zero temperature operation. | function | internal | [line 94](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L94) |
| `groupByContext(questions: readonly MemoryAgentBenchQuestion[]): Map<string, MemoryAgentBenchQuestion[]>` | Implements the group by context operation. | function | internal | [line 102](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L102) |
| `checkpointPath(output: string, questionId: string): string` | Implements the checkpoint path operation. | function | internal | [line 117](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L117) |
| `completedPath(output: string, questionId: string): string` | Implements the completed path operation. | function | internal | [line 121](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L121) |
| `evolutionPath(output: string, contextId: string): string` | Implements the evolution path operation. | function | internal | [line 125](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L125) |
| `writePredictions(output: string, questions: readonly MemoryAgentBenchQuestion[]): Promise<number>` | Writes predictions. | function | internal | [line 129](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L129) |
| `ensureManifest(path: string, expected: unknown): Promise<void>` | Implements the ensure manifest operation. | function | internal | [line 158](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L158) |
| `benchmarkMemoryAgentBench(parsed: ParsedCommand): Promise<void>` | Implements the benchmark memory agent bench operation. | function | exported | [line 166](../../src/entrypoints/cli/commands/benchmark-memoryagentbench.ts#L166) |
## `src/entrypoints/cli/commands/evaluate-benchmark.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `benchmarkFor(parsed: ParsedCommand): EvidenceBenchmarkId` | Implements the benchmark for operation. | function | internal | [line 47](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L47) |
| `judgeFlags(): string[]` | Implements the judge flags operation. | function | internal | [line 55](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L55) |
| `readPredictions(path: string, benchmark: EvidenceBenchmarkId): Promise<EvidenceBenchmarkPrediction[]>` | Reads predictions. | function | internal | [line 62](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L62) |
| `indexedByQuestionId(values: readonly T[], label: string): Map<string, T>` | Indexes ed by question id. | function | internal | [line 102](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L102) |
| `validatePredictionScope(prediction: EvidenceBenchmarkPrediction, expectedScopeId: string): void` | Validates prediction scope. | function | internal | [line 147](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L147) |
| `pathExists(path: string): Promise<boolean>` | Implements the path exists operation. | function | internal | [line 159](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L159) |
| `directoryHasRecords(path: string): Promise<boolean>` | Implements the directory has records operation. | function | internal | [line 171](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L171) |
| `assertPredictionModelMatchesRun(prediction: EvidenceBenchmarkPrediction, sourceRun: SourceRunManifest): void` | Validates prediction model matches run and throws when invalid. | function | internal | [line 182](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L182) |
| `evaluationProvenance(options: { benchmark: EvidenceBenchmarkId; dataPaths: ReturnType<typeof evidenceBenchmarkDataPaths>; predictionsPath: string; predictions: readonly EvidenceBenchmarkPrediction[]; selectedQueries: readonly unknown[]; selectedLabels: readonly unknown[]; }): Promise<EvaluationProvenance>` | Implements the evaluation provenance operation. | function | internal | [line 205](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L205) |
| `judgeRecordPath(directory: string, questionId: string): string` | Implements the judge record path operation. | function | internal | [line 269](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L269) |
| `evaluateBenchmark(parsed: ParsedCommand): Promise<void>` | Implements the evaluate benchmark operation. | function | exported | [line 273](../../src/entrypoints/cli/commands/evaluate-benchmark.ts#L273) |
## `src/entrypoints/cli/commands/ingest-benchmark.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `benchmarkFor(parsed: ParsedCommand): EvidenceBenchmarkId` | Implements the benchmark for operation. | function | internal | [line 47](../../src/entrypoints/cli/commands/ingest-benchmark.ts#L47) |
| `selectCases(values: readonly T[], requestedIds: ReadonlySet<string>): T[]` | Implements the select cases operation. | function | internal | [line 55](../../src/entrypoints/cli/commands/ingest-benchmark.ts#L55) |
| `loadAmaSelection(parsed: ParsedCommand, requestedIds: ReadonlySet<string>): Promise<AdaptedSelection>` | Loads ama selection. | function | internal | [line 71](../../src/entrypoints/cli/commands/ingest-benchmark.ts#L71) |
| `writeDatasetManifest(options: { path: string; identity: DatasetIdentity; dataPaths: EvidenceBenchmarkDataPaths; retrieval: unknown; }): Promise<number>` | Writes dataset manifest. | function | internal | [line 97](../../src/entrypoints/cli/commands/ingest-benchmark.ts#L97) |
| `assertDatasetIdentity(path: string, identity: DatasetIdentity): Promise<StoredDatasetManifest \| undefined>` | Validates dataset identity and throws when invalid. | function | internal | [line 115](../../src/entrypoints/cli/commands/ingest-benchmark.ts#L115) |
| `withDataDirectoryLock(databasePath: string, action: () => Promise<T>): Promise<T>` | Implements the with data directory lock operation. | function | internal | [line 130](../../src/entrypoints/cli/commands/ingest-benchmark.ts#L130) |
| `ingestBenchmark(parsed: ParsedCommand): Promise<void>` | Implements the ingest benchmark operation. | function | exported | [line 152](../../src/entrypoints/cli/commands/ingest-benchmark.ts#L152) |
## `src/entrypoints/cli/commands/ingest-longmemeval.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `ingestLongMemEval(parsed: ParsedCommand): Promise<void>` | Implements the ingest long mem eval operation. | function | exported | [line 31](../../src/entrypoints/cli/commands/ingest-longmemeval.ts#L31) |
## `src/entrypoints/cli/commands/ingest-tau-knowledge.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `withDataDirectoryLock(root: string, action: () => Promise<T>): Promise<T>` | Implements the with data directory lock operation. | function | internal | [line 33](../../src/entrypoints/cli/commands/ingest-tau-knowledge.ts#L33) |
| `ingestTauKnowledge(parsed: ParsedCommand): Promise<void>` | Implements the ingest tau knowledge operation. | function | exported | [line 54](../../src/entrypoints/cli/commands/ingest-tau-knowledge.ts#L54) |
## `src/entrypoints/cli/commands/longmemeval-suite.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `sleep(milliseconds: number): Promise<void>` | Implements the sleep operation. | function | internal | [line 40](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L40) |
| `jsonRecordCount(directory: string): Promise<number>` | Implements the json record count operation. | function | internal | [line 46](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L46) |
| `runLoggedChild(options: { file: string; args: string[]; environment: NodeJS.ProcessEnv; logPath: string; mirrorStderr?: boolean; }): Promise<number>` | Runs logged child. | function | internal | [line 62](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L62) |
| `unresolvedFailureMessages(outputDir: string): Promise<string[]>` | Implements the unresolved failure messages operation. | function | internal | [line 102](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L102) |
| `auditLongMemEvalSuite(outputDir: string, expected: number): Promise<Record<string, unknown>>` | Implements the audit long mem eval suite operation. | function | internal | [line 125](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L125) |
| `baselineScores(parsed: ParsedCommand): Array<{ name: string; accuracy: number; }>` | Implements the baseline scores operation. | function | internal | [line 215](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L215) |
| `packageEvaluationArtifacts(outputDir: string, archivePath: string): Promise<void>` | Packages evaluation artifacts. | function | internal | [line 233](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L233) |
| `roleFlag(parsed: ParsedCommand, role: SuiteModelRole, name: string): string \| undefined` | Implements the role flag operation. | function | internal | [line 308](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L308) |
| `requiredRoleFlag(parsed: ParsedCommand, role: SuiteModelRole, name: string): string` | Implements the required role flag operation. | function | internal | [line 316](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L316) |
| `modelRoleConfiguration(parsed: ParsedCommand, role: SuiteModelRole): SuiteModelRoleConfiguration` | Implements the model role configuration operation. | function | internal | [line 330](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L330) |
| `suiteModelConfigurationFor(parsed: ParsedCommand): SuiteModelConfiguration` | Implements the suite model configuration for operation. | function | exported | [line 359](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L359) |
| `suiteRoleRuntimeArguments(role: SuiteModelRole, configuration: SuiteModelRoleConfiguration, apiKeyEnvironment: string, baseUrlEnvironment: string): string[]` | Implements the suite role runtime arguments operation. | function | internal | [line 368](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L368) |
| `suiteBenchmarkEnvironment(options: { retrievalSource: NodeJS.ProcessEnv; answerSource: NodeJS.ProcessEnv; models: SuiteModelConfiguration; }): NodeJS.ProcessEnv` | Implements the suite benchmark environment operation. | function | exported | [line 407](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L407) |
| `longMemEvalSuite(parsed: ParsedCommand): Promise<void>` | Implements the long mem eval suite operation. | function | exported | [line 444](../../src/entrypoints/cli/commands/longmemeval-suite.ts#L444) |
## `src/entrypoints/cli/commands/package-benchmark.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `jsonlRecordCount(serialized: string): number` | Implements the jsonl record count operation. | function | internal | [line 14](../../src/entrypoints/cli/commands/package-benchmark.ts#L14) |
| `packageBenchmark(parsed: ParsedCommand): Promise<void>` | Packages benchmark. | function | exported | [line 18](../../src/entrypoints/cli/commands/package-benchmark.ts#L18) |
## `src/entrypoints/cli/commands/prepare-longmemeval-eval.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `prepareLongMemEvalEvaluation(parsed: ParsedCommand): Promise<void>` | Prepares long mem eval evaluation. | function | exported | [line 9](../../src/entrypoints/cli/commands/prepare-longmemeval-eval.ts#L9) |
## `src/entrypoints/cli/commands/run-longmemeval.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `runLongMemEval(parsed: ParsedCommand): Promise<void>` | Runs long mem eval. | function | exported | [line 21](../../src/entrypoints/cli/commands/run-longmemeval.ts#L21) |
## `src/entrypoints/cli/commands/run-memory.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `runGeneric(parsed: ParsedCommand): Promise<void>` | Runs generic. | function | exported | [line 14](../../src/entrypoints/cli/commands/run-memory.ts#L14) |
## `src/entrypoints/cli/evidence-benchmark-runtime.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `benchmarkModelOptionsFor(parsed: ParsedCommand, role: BenchmarkModelRole): LoadPiModelRuntimeOptions` | Resolves one role's model flags with field-wise unprefixed fallbacks. | function | exported | [line 46](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L46) |
| `benchmarkRuntimeIdentity(runtime: PiModelRuntime): BenchmarkRuntimeIdentity` | Implements the benchmark runtime identity operation. | function | exported | [line 69](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L69) |
| `benchmarkSystemicRuntimeFailure(message: string): boolean` | Stops queue refill for explicit provider-wide failures without matching IDs. | function | exported | [line 87](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L87) |
| `compareText(left: string, right: string): number` | Compares text. | function | internal | [line 93](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L93) |
| `canonicalJson(value: unknown, path = "$", ancestors = new Set<object>()): string` | Checks whether onical json. | function | internal | [line 99](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L99) |
| `benchmarkQuerySetHash(queries: readonly unknown[]): string` | Hashes the complete selected query records without depending on input order. | function | exported | [line 154](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L154) |
| `benchmarkSelectedCorpusHash(sanitizedRoot: string, selections: readonly BenchmarkScopeSelection[]): Promise<string>` | Hashes only the sanitized memory files selected by the current query set. | function | exported | [line 168](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L168) |
| `benchmarkSourceRevision(): BenchmarkSourceRevision` | Implements the benchmark source revision operation. | function | exported | [line 199](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L199) |
| `errorCode(error: unknown): string \| undefined` | Implements the error code operation. | function | internal | [line 292](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L292) |
| `validateManifest(value: unknown): BenchmarkRunManifest` | Validates manifest. | function | internal | [line 299](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L299) |
| `createManifestIfAbsent(path: string, manifest: BenchmarkRunManifest): Promise<boolean>` | Creates manifest if absent. | function | internal | [line 325](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L325) |
| `ensureBenchmarkRunManifest(path: string, config: Readonly<Record<string, unknown>>): Promise<BenchmarkRunManifest>` | Creates a run manifest once, or validates an existing resumable run. | function | exported | [line 361](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L361) |
| `withoutTopLevelKeys(config: Readonly<Record<string, unknown>>, omitted: ReadonlySet<string>): Record<string, unknown>` | Implements the without top level keys operation. | function | internal | [line 411](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L411) |
| `migrateBenchmarkRunInfrastructure(path: string, config: Readonly<Record<string, unknown>>, allowedConfigChanges: readonly string[]): Promise<BenchmarkRunManifest>` | Transparently migrates an existing run across infrastructure-only changes. | function | exported | [line 428](../../src/entrypoints/cli/evidence-benchmark-runtime.ts#L428) |
## `src/entrypoints/cli/main.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `printHelp(): void` | Implements the print help operation. | function | internal | [line 16](../../src/entrypoints/cli/main.ts#L16) |
| `main(): Promise<void>` | Implements the main operation. | function | internal | [line 35](../../src/entrypoints/cli/main.ts#L35) |
## `src/entrypoints/cli/parse-command.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `parseCommand(argv: string[]): ParsedCommand` | Parses command. | function | exported | [line 26](../../src/entrypoints/cli/parse-command.ts#L26) |
| `requiredFlag(parsed: ParsedCommand, name: string): string` | Implements the required flag operation. | function | exported | [line 48](../../src/entrypoints/cli/parse-command.ts#L48) |
| `optionalFlag(parsed: ParsedCommand, name: string): string \| undefined` | Implements the optional flag operation. | function | exported | [line 56](../../src/entrypoints/cli/parse-command.ts#L56) |
| `positiveIntegerFlag(parsed: ParsedCommand, name: string, fallback: number, maximum: number): number` | Implements the positive integer flag operation. | function | exported | [line 68](../../src/entrypoints/cli/parse-command.ts#L68) |
| `positiveNumberFlag(parsed: ParsedCommand, name: string, fallback: number, maximum: number): number` | Implements the positive number flag operation. | function | exported | [line 83](../../src/entrypoints/cli/parse-command.ts#L83) |
| `modelOptionsFor(parsed: ParsedCommand): LoadPiModelRuntimeOptions` | Implements the model options for operation. | function | exported | [line 98](../../src/entrypoints/cli/parse-command.ts#L98) |
| `skillFor(parsed: ParsedCommand): PicorerSkill` | Implements the skill for operation. | function | exported | [line 177](../../src/entrypoints/cli/parse-command.ts#L177) |
| `assertOnlyFlags(parsed: ParsedCommand, allowed: readonly string[]): void` | Validates only flags and throws when invalid. | function | exported | [line 189](../../src/entrypoints/cli/parse-command.ts#L189) |
| `retrievalProfileFor(parsed: ParsedCommand): RetrievalProfile` | Implements the retrieval profile for operation. | function | exported | [line 199](../../src/entrypoints/cli/parse-command.ts#L199) |
## `src/entrypoints/cli/private-records.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `readQuestionRecords(path: string): Promise<T[]>` | Reads question records. | function | exported | [line 6](../../src/entrypoints/cli/private-records.ts#L6) |
| `mergeQuestionRecords(path: string, records: readonly T[]): Promise<void>` | Merges question records. | function | exported | [line 12](../../src/entrypoints/cli/private-records.ts#L12) |
| `readScopeRecords(path: string): Promise<T[]>` | Reads scope records. | function | exported | [line 22](../../src/entrypoints/cli/private-records.ts#L22) |
| `mergeScopeRecords(path: string, records: readonly T[]): Promise<void>` | Merges scope records. | function | exported | [line 28](../../src/entrypoints/cli/private-records.ts#L28) |
## `src/entrypoints/cli/workflow-files.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `writeAtomicText(path: string, serialized: string): Promise<void>` | Writes a file through a permission-restricted temporary file and atomic rename. | function | exported | [line 15](../../src/entrypoints/cli/workflow-files.ts#L15) |
| `writeAtomicJson(path: string, value: unknown): Promise<void>` | Serializes a value as formatted JSON and writes it atomically. | function | exported | [line 29](../../src/entrypoints/cli/workflow-files.ts#L29) |
| `createAtomicTextFile(path: string): Promise<AtomicTextFile>` | Opens a restricted temporary file for bounded-memory artifact materialization. | function | exported | [line 43](../../src/entrypoints/cli/workflow-files.ts#L43) |
| `readJsonFileIfPresent(path: string): Promise<T \| undefined>` | Reads a JSON file, returning undefined only when the file is absent. | function | exported | [line 85](../../src/entrypoints/cli/workflow-files.ts#L85) |
| `executeArchiveCommand(file: string, args: string[]): Promise<void>` | Executes a command used to create an archive and normalizes its error. | function | exported | [line 99](../../src/entrypoints/cli/workflow-files.ts#L99) |
## `src/entrypoints/ldbd-api/contracts.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `LdbdContractError` | Implements ldbd contract error. | class | exported | [line 21](../../src/entrypoints/ldbd-api/contracts.ts#L21) |
| `LdbdContractError.constructor(message: string)` | Creates a ldbd contract error instance. | method | public | [line 22](../../src/entrypoints/ldbd-api/contracts.ts#L22) |
| `objectValue(value: unknown, label: string): Record<string, unknown>` | Implements the object value operation. | function | internal | [line 28](../../src/entrypoints/ldbd-api/contracts.ts#L28) |
| `exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void` | Implements the exact fields operation. | function | internal | [line 35](../../src/entrypoints/ldbd-api/contracts.ts#L35) |
| `identifier(value: unknown, label: string): string` | Implements the identifier operation. | function | internal | [line 47](../../src/entrypoints/ldbd-api/contracts.ts#L47) |
| `text(value: unknown, label: string, maximum: number): string` | Implements the text operation. | function | internal | [line 55](../../src/entrypoints/ldbd-api/contracts.ts#L55) |
| `parseAddRequest(value: unknown): LdbdAddRequest` | Validates one synchronous LDBD Add request and keeps only the memory contract fields. | function | exported | [line 65](../../src/entrypoints/ldbd-api/contracts.ts#L65) |
| `parseSearchRequest(value: unknown): LdbdSearchRequest` | Validates one LDBD Search request with a bounded top-k and optional choices. | function | exported | [line 100](../../src/entrypoints/ldbd-api/contracts.ts#L100) |
| `renderRetrievalQuestion(request: LdbdSearchRequest): string` | Adds benchmark options to the retrieval question without persisting them as memory. | function | exported | [line 128](../../src/entrypoints/ldbd-api/contracts.ts#L128) |
## `src/entrypoints/ldbd-api/main.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `requiredEnvironment(name: string): string` | Implements the required environment operation. | function | internal | [line 20](../../src/entrypoints/ldbd-api/main.ts#L20) |
| `integerEnvironment(name: string, fallback: number): number` | Implements the integer environment operation. | function | internal | [line 26](../../src/entrypoints/ldbd-api/main.ts#L26) |
| `tokenDigest(value: string): Buffer` | Converts ken digest. | function | internal | [line 36](../../src/entrypoints/ldbd-api/main.ts#L36) |
| `authorized(request: IncomingMessage, expectedToken: string \| undefined): boolean` | Implements the authorized operation. | function | internal | [line 40](../../src/entrypoints/ldbd-api/main.ts#L40) |
| `jsonBody(request: IncomingMessage): Promise<unknown>` | Implements the json body operation. | function | internal | [line 49](../../src/entrypoints/ldbd-api/main.ts#L49) |
| `respond(response: ServerResponse, status: number, body: unknown): void` | Implements the respond operation. | function | internal | [line 66](../../src/entrypoints/ldbd-api/main.ts#L66) |
| `shutdown(): void` | Implements the shutdown operation. | function | internal | [line 135](../../src/entrypoints/ldbd-api/main.ts#L135) |
## `src/entrypoints/ldbd-api/picorer-runtime.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `KeyedSerialExecutor` | Implements keyed serial executor. | class | internal | [line 28](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L28) |
| `KeyedSerialExecutor.run(key: string, operation: () => Promise<T>): Promise<T>` | Runs the operation. | method | public | [line 31](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L31) |
| `requestHash(request: LdbdAddRequest): string` | Implements the request hash operation. | function | internal | [line 47](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L47) |
| `timestamp(value: number \| undefined): string \| undefined` | Implements the timestamp operation. | function | internal | [line 51](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L51) |
| `PicorerLdbdApplication` | Implements the Picorer LDBD application. | class | exported | [line 60](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L60) |
| `PicorerLdbdApplication.constructor(private readonly store: MemoryStore & OnlineMemoryStore, private readonly embedder: Embedder, private readonly modelRuntime: PiModelRuntime, options: { retrievalProfile?: RetrievalProfile; environment?: NodeJS.ProcessEnv; } = {})` | Creates a Picorer LDBD application instance. | method | public | [line 66](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L66) |
| `PicorerLdbdApplication.add(request: LdbdAddRequest): Promise<"inserted" \| "unchanged">` | Implements the add operation. | method | public | [line 82](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L82) |
| `PicorerLdbdApplication.search(request: LdbdSearchRequest, signal?: AbortSignal): Promise<LdbdSearchItem[]>` | Performs a search. | method | public | [line 122](../../src/entrypoints/ldbd-api/picorer-runtime.ts#L122) |
## `src/entrypoints/ldbd-api/service.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `LdbdConflictError` | Implements ldbd conflict error. | class | exported | [line 21](../../src/entrypoints/ldbd-api/service.ts#L21) |
| `LdbdConflictError.constructor(message: string)` | Creates a ldbd conflict error instance. | method | public | [line 22](../../src/entrypoints/ldbd-api/service.ts#L22) |
| `LdbdUnavailableError` | Implements ldbd unavailable error. | class | exported | [line 28](../../src/entrypoints/ldbd-api/service.ts#L28) |
| `LdbdUnavailableError.constructor(message: string)` | Creates a ldbd unavailable error instance. | method | public | [line 29](../../src/entrypoints/ldbd-api/service.ts#L29) |
| `onlineScopeId(userId: string): string` | Implements the online scope id operation. | function | exported | [line 35](../../src/entrypoints/ldbd-api/service.ts#L35) |
| `LdbdApiService` | Implements ldbd api service. | class | exported | [line 39](../../src/entrypoints/ldbd-api/service.ts#L39) |
| `LdbdApiService.constructor(private readonly application: LdbdMemoryApplication)` | Creates a ldbd api service instance. | method | public | [line 40](../../src/entrypoints/ldbd-api/service.ts#L40) |
| `LdbdApiService.add(value: unknown): Promise<Record<string, unknown>>` | Handles the synchronous LDBD Add operation. | method | public | [line 42](../../src/entrypoints/ldbd-api/service.ts#L42) |
| `LdbdApiService.search(value: unknown, signal?: AbortSignal): Promise<{ data: LdbdSearchItem[] }>` | Handles the LDBD Search operation through the injected search engine. | method | public | [line 54](../../src/entrypoints/ldbd-api/service.ts#L54) |
## `src/entrypoints/memoryarena-public-api/application.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `KeyedReadWriteExecutor` | A fair keyed read/write lock: mutations are exclusive, wraps are shared. | class | internal | [line 40](../../src/entrypoints/memoryarena-public-api/application.ts#L40) |
| `KeyedReadWriteExecutor.runRead(key: string, operation: () => Promise<T>): Promise<T>` | Runs read. | method | public | [line 43](../../src/entrypoints/memoryarena-public-api/application.ts#L43) |
| `KeyedReadWriteExecutor.runWrite(key: string, operation: () => Promise<T>): Promise<T>` | Runs write. | method | public | [line 47](../../src/entrypoints/memoryarena-public-api/application.ts#L47) |
| `KeyedReadWriteExecutor.run(key: string, mode: LockMode, operation: () => Promise<T>): Promise<T>` | Runs the operation. | method | private | [line 51](../../src/entrypoints/memoryarena-public-api/application.ts#L51) |
| `KeyedReadWriteExecutor.acquire(key: string, mode: LockMode): Promise<void>` | Implements the acquire operation. | method | private | [line 64](../../src/entrypoints/memoryarena-public-api/application.ts#L64) |
| `KeyedReadWriteExecutor.release(key: string, mode: LockMode): void` | Implements the release operation. | method | private | [line 77](../../src/entrypoints/memoryarena-public-api/application.ts#L77) |
| `KeyedReadWriteExecutor.drain(state: KeyedLockState): void` | Implements the drain operation. | method | private | [line 92](../../src/entrypoints/memoryarena-public-api/application.ts#L92) |
| `WrapAdmissionController` | Bounds expensive retrieval agents without limiting cheap HTTP connections. | class | internal | [line 116](../../src/entrypoints/memoryarena-public-api/application.ts#L116) |
| `WrapAdmissionController.constructor(private readonly maximumConcurrent: number)` | Creates a wrap admission controller instance. | method | public | [line 122](../../src/entrypoints/memoryarena-public-api/application.ts#L122) |
| `WrapAdmissionController.run(operation: () => Promise<T>): Promise<T>` | Runs the operation. | method | public | [line 128](../../src/entrypoints/memoryarena-public-api/application.ts#L128) |
| `WrapAdmissionController.snapshot(): MemoryArenaAdmissionSnapshot` | Implements the snapshot operation. | method | public | [line 139](../../src/entrypoints/memoryarena-public-api/application.ts#L139) |
| `WrapAdmissionController.acquire(): Promise<void>` | Implements the acquire operation. | method | private | [line 149](../../src/entrypoints/memoryarena-public-api/application.ts#L149) |
| `WrapAdmissionController.release(): void` | Implements the release operation. | method | private | [line 157](../../src/entrypoints/memoryarena-public-api/application.ts#L157) |
| `WrapRequestCoalescer` | Shares an exact in-flight/recent wrap across HTTP transport retries. | class | internal | [line 174](../../src/entrypoints/memoryarena-public-api/application.ts#L174) |
| `WrapRequestCoalescer.constructor(private readonly successTtlMs: number, private readonly maximumEntries: number)` | Creates a wrap request coalescer instance. | method | public | [line 178](../../src/entrypoints/memoryarena-public-api/application.ts#L178) |
| `WrapRequestCoalescer.run(key: string, userId: string, operation: () => Promise<T>): Promise<T>` | Runs the operation. | method | public | [line 183](../../src/entrypoints/memoryarena-public-api/application.ts#L183) |
| `WrapRequestCoalescer.invalidateUser(userId: string): void` | Implements the invalidate user operation. | method | public | [line 210](../../src/entrypoints/memoryarena-public-api/application.ts#L210) |
| `WrapRequestCoalescer.snapshot(): { entries: number; inFlight: number; coalesced: number }` | Implements the snapshot operation. | method | public | [line 216](../../src/entrypoints/memoryarena-public-api/application.ts#L216) |
| `WrapRequestCoalescer.prune(): void` | Implements the prune operation. | method | private | [line 225](../../src/entrypoints/memoryarena-public-api/application.ts#L225) |
| `MemoryArenaPublicApplication` | Keeps lifecycle writes exclusive while parallelizing read-only retrievals. | class | exported | [line 246](../../src/entrypoints/memoryarena-public-api/application.ts#L246) |
| `MemoryArenaPublicApplication.constructor(private readonly backend: MemoryArenaPublicBackend, options: MemoryArenaPublicApplicationOptions = {})` | Creates a memory arena public application instance. | method | public | [line 251](../../src/entrypoints/memoryarena-public-api/application.ts#L251) |
| `MemoryArenaPublicApplication.initialize(input: MemoryArenaInitializeInput): Promise<MemoryArenaInitializeResult>` | Implements the initialize operation. | method | public | [line 264](../../src/entrypoints/memoryarena-public-api/application.ts#L264) |
| `MemoryArenaPublicApplication.add(input: MemoryArenaAddInput): Promise<MemoryArenaAddResult>` | Implements the add operation. | method | public | [line 275](../../src/entrypoints/memoryarena-public-api/application.ts#L275) |
| `MemoryArenaPublicApplication.wrap(input: MemoryArenaWrapInput): Promise<MemoryArenaWrapResult>` | Implements the wrap operation. | method | public | [line 282](../../src/entrypoints/memoryarena-public-api/application.ts#L282) |
| `MemoryArenaPublicApplication.health(): Record<string, unknown>` | Implements the health operation. | method | public | [line 290](../../src/entrypoints/memoryarena-public-api/application.ts#L290) |
| `MemoryArenaPublicApiService` | Implements memory arena public api service. | class | exported | [line 299](../../src/entrypoints/memoryarena-public-api/application.ts#L299) |
| `MemoryArenaPublicApiService.constructor(private readonly application: MemoryArenaPublicApplication, private readonly runtimeIdentity?: MemoryArenaRuntimeIdentity, private readonly persistenceIdentity?: string)` | Creates a memory arena public api service instance. | method | public | [line 300](../../src/entrypoints/memoryarena-public-api/application.ts#L300) |
| `MemoryArenaPublicApiService.initialize(value: unknown): Promise<Record<string, unknown>>` | Implements the initialize operation. | method | public | [line 306](../../src/entrypoints/memoryarena-public-api/application.ts#L306) |
| `MemoryArenaPublicApiService.add(value: unknown): Promise<Record<string, unknown>>` | Implements the add operation. | method | public | [line 316](../../src/entrypoints/memoryarena-public-api/application.ts#L316) |
| `MemoryArenaPublicApiService.wrap(value: unknown): Promise<Record<string, unknown>>` | Implements the wrap operation. | method | public | [line 326](../../src/entrypoints/memoryarena-public-api/application.ts#L326) |
| `MemoryArenaPublicApiService.health(): Record<string, unknown>` | Implements the health operation. | method | public | [line 354](../../src/entrypoints/memoryarena-public-api/application.ts#L354) |
| `MemoryArenaPublicApiService.runtime(): Record<string, unknown>` | Runs time. | method | public | [line 358](../../src/entrypoints/memoryarena-public-api/application.ts#L358) |
## `src/entrypoints/memoryarena-public-api/contracts.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `objectValue(value: unknown, label: string): Record<string, unknown>` | Implements the object value operation. | function | internal | [line 8](../../src/entrypoints/memoryarena-public-api/contracts.ts#L8) |
| `contractError(message: string): MemoryArenaPublicError` | Implements the contract error operation. | function | internal | [line 15](../../src/entrypoints/memoryarena-public-api/contracts.ts#L15) |
| `exactFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void` | Implements the exact fields operation. | function | internal | [line 23](../../src/entrypoints/memoryarena-public-api/contracts.ts#L23) |
| `stringField(record: Record<string, unknown>, field: string, label: string): string` | Implements the string field operation. | function | internal | [line 37](../../src/entrypoints/memoryarena-public-api/contracts.ts#L37) |
| `addMessagesField(value: unknown): MemoryArenaAddInput["messages"]` | Implements the add messages field operation. | function | internal | [line 49](../../src/entrypoints/memoryarena-public-api/contracts.ts#L49) |
| `positiveIntegerField(record: Record<string, unknown>, field: string, label: string, maximum: number): number` | Implements the positive integer field operation. | function | internal | [line 75](../../src/entrypoints/memoryarena-public-api/contracts.ts#L75) |
| `parseMemoryArenaInitializeRequest(value: unknown): MemoryArenaInitializeInput` | Parses memory arena initialize request. | function | exported | [line 94](../../src/entrypoints/memoryarena-public-api/contracts.ts#L94) |
| `parseMemoryArenaAddRequest(value: unknown): MemoryArenaAddInput` | Parses memory arena add request. | function | exported | [line 109](../../src/entrypoints/memoryarena-public-api/contracts.ts#L109) |
| `parseMemoryArenaWrapRequest(value: unknown): MemoryArenaWrapInput` | Parses memory arena wrap request. | function | exported | [line 125](../../src/entrypoints/memoryarena-public-api/contracts.ts#L125) |
## `src/entrypoints/memoryarena-public-api/http-errors.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `memoryArenaHttpError(error: unknown): MemoryArenaHttpError` | Produces the stable public error envelope without exposing exception text. | function | exported | [line 21](../../src/entrypoints/memoryarena-public-api/http-errors.ts#L21) |
## `src/entrypoints/memoryarena-public-api/main.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `requiredEnvironment(name: string): string` | Implements the required environment operation. | function | internal | [line 28](../../src/entrypoints/memoryarena-public-api/main.ts#L28) |
| `integerEnvironment(name: string, fallback: number, maximum: number): number` | Implements the integer environment operation. | function | internal | [line 34](../../src/entrypoints/memoryarena-public-api/main.ts#L34) |
| `thinkingLevelEnvironment(): NonNullable< LoadPiModelRuntimeOptions["thinkingLevel"] >` | Implements the thinking level environment operation. | function | internal | [line 48](../../src/entrypoints/memoryarena-public-api/main.ts#L48) |
| `skillEnvironment(): PicorerSkill` | Implements the skill environment operation. | function | internal | [line 66](../../src/entrypoints/memoryarena-public-api/main.ts#L66) |
| `interfaceModeEnvironment(skill: PicorerSkill): PicorerInterfaceMode` | Implements the interface mode environment operation. | function | internal | [line 74](../../src/entrypoints/memoryarena-public-api/main.ts#L74) |
| `jsonBody(request: IncomingMessage): Promise<unknown>` | Implements the json body operation. | function | internal | [line 83](../../src/entrypoints/memoryarena-public-api/main.ts#L83) |
| `respond(response: ServerResponse, status: number, body: unknown, retryable = false, errorCode?: string): void` | Implements the respond operation. | function | internal | [line 116](../../src/entrypoints/memoryarena-public-api/main.ts#L116) |
| `main(): Promise<void>` | Implements the main operation. | function | internal | [line 139](../../src/entrypoints/memoryarena-public-api/main.ts#L139) |
## `src/entrypoints/memoryarena-public-api/runtime-contract.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `nonEmpty(value: string, label: string): string` | Implements the non empty operation. | function | internal | [line 55](../../src/entrypoints/memoryarena-public-api/runtime-contract.ts#L55) |
| `canonical(value: unknown): string` | Checks whether onical. | function | internal | [line 61](../../src/entrypoints/memoryarena-public-api/runtime-contract.ts#L61) |
| `memoryArenaRuntimeContractHash(contract: MemoryArenaRuntimeContract): string` | Implements the memory arena runtime contract hash operation. | function | exported | [line 72](../../src/entrypoints/memoryarena-public-api/runtime-contract.ts#L72) |
| `skillHash(skill: PicorerSkill): string` | Implements the skill hash operation. | function | exported | [line 78](../../src/entrypoints/memoryarena-public-api/runtime-contract.ts#L78) |
| `createMemoryArenaRuntimeIdentity(options: { sourceIdentity: string; buildIdentity: string; skill: PicorerSkill; interfaceMode: PicorerInterfaceMode; modelRuntime: PiModelRuntime; logicalModelId: string; protocol: string; baseUrl: string; maxRunMs: number; maxTurns: number; maxToolCalls: number; maxSearchCalls: number; requestTimeoutMs: number; requestMaxRetries: number; requestMaxRetryDelayMs: number; maxConcurrentWraps: number; memoryIndex?: RetrievalMetadata; }): MemoryArenaRuntimeIdentity` | Creates memory arena runtime identity. | function | exported | [line 84](../../src/entrypoints/memoryarena-public-api/runtime-contract.ts#L84) |
## `src/entrypoints/tau-knowledge-bridge/main.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `objectAt(value: unknown, path: string): Record<string, unknown>` | Implements the object at operation. | function | internal | [line 62](../../src/entrypoints/tau-knowledge-bridge/main.ts#L62) |
| `initializeRequest(value: unknown): InitializeRequest` | Implements the initialize request operation. | function | internal | [line 69](../../src/entrypoints/tau-knowledge-bridge/main.ts#L69) |
| `agentInput(value: unknown): InteractiveAgentInput` | Implements the agent input operation. | function | internal | [line 115](../../src/entrypoints/tau-knowledge-bridge/main.ts#L115) |
| `skillForBridge(raw: string \| undefined): InteractiveMemorySkill` | Implements the skill for bridge operation. | function | internal | [line 148](../../src/entrypoints/tau-knowledge-bridge/main.ts#L148) |
| `output(value: unknown): void` | Implements the output operation. | function | internal | [line 156](../../src/entrypoints/tau-knowledge-bridge/main.ts#L156) |
| `main(): Promise<void>` | Implements the main operation. | function | internal | [line 160](../../src/entrypoints/tau-knowledge-bridge/main.ts#L160) |
## `src/evidence-agent/adapters/docker/read-only-shell.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `buildBashRoDockerArgs(scopePath: string, command: string, image = DEFAULT_IMAGE, containerUser = "0:0"): string[]` | Builds bash ro docker args. | function | exported | [line 21](../../src/evidence-agent/adapters/docker/read-only-shell.ts#L21) |
| `ReadOnlyBash` | Runs a shell inside a disposable, networkless container with exactly one sanitized memory scope mounted read-only. | class | exported | [line 62](../../src/evidence-agent/adapters/docker/read-only-shell.ts#L62) |
| `ReadOnlyBash.constructor(options: BashRoOptions = {})` | Creates a read only bash instance. | method | public | [line 69](../../src/evidence-agent/adapters/docker/read-only-shell.ts#L69) |
| `ReadOnlyBash.run(scopePath: string, command: string, signal?: AbortSignal): Promise<BashRoResult>` | Runs the operation. | method | public | [line 82](../../src/evidence-agent/adapters/docker/read-only-shell.ts#L82) |
## `src/evidence-agent/adapters/pi/assistant-messages.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `lastAssistantMessage(messages: readonly unknown[]): AssistantMessage \| undefined` | Implements the last assistant message operation. | function | exported | [line 5](../../src/evidence-agent/adapters/pi/assistant-messages.ts#L5) |
| `assistantMessageText(message: AssistantMessage \| undefined, maxChars?: number): string` | Implements the assistant message text operation. | function | exported | [line 22](../../src/evidence-agent/adapters/pi/assistant-messages.ts#L22) |
| `responseModelMatches(requested: string, actual: string): boolean` | Implements the response model matches operation. | function | internal | [line 39](../../src/evidence-agent/adapters/pi/assistant-messages.ts#L39) |
| `validateResponseModels(messages: readonly unknown[], requestedModel: string): string[]` | Validates response models. | function | exported | [line 43](../../src/evidence-agent/adapters/pi/assistant-messages.ts#L43) |
| `aggregateAssistantUsage(messages: readonly unknown[]): ModelUsage` | Implements the aggregate assistant usage operation. | function | exported | [line 68](../../src/evidence-agent/adapters/pi/assistant-messages.ts#L68) |
## `src/evidence-agent/adapters/pi/ephemeral-context.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `isToolResult(message: AgentMessage): message is ToolResultMessage` | Checks whether tool result. | function | internal | [line 21](../../src/evidence-agent/adapters/pi/ephemeral-context.ts#L21) |
| `trailingToolResultStart(messages: readonly AgentMessage[]): number` | Implements the trailing tool result start operation. | function | internal | [line 25](../../src/evidence-agent/adapters/pi/ephemeral-context.ts#L25) |
| `createEphemeralMemoryContext(): EphemeralMemoryContext` | Keeps the current tool batch visible once, then expires navigation payloads. | function | exported | [line 37](../../src/evidence-agent/adapters/pi/ephemeral-context.ts#L37) |
## `src/evidence-agent/adapters/pi/memory-observation.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `renderCoverageProgress(progress: SearchCoverageProgress): string[]` | Renders coverage progress. | function | internal | [line 48](../../src/evidence-agent/adapters/pi/memory-observation.ts#L48) |
| `relativeTime(timestamp: string \| undefined, questionDate: string \| undefined): string` | Implements the relative time operation. | function | internal | [line 83](../../src/evidence-agent/adapters/pi/memory-observation.ts#L83) |
| `roleLabel(role: string): string` | Implements the role label operation. | function | internal | [line 91](../../src/evidence-agent/adapters/pi/memory-observation.ts#L91) |
| `indent(text: string): string` | Implements the indent operation. | function | internal | [line 97](../../src/evidence-agent/adapters/pi/memory-observation.ts#L97) |
| `sourceLine(source: MemoryCandidate \| MemoryEvidence, action: string, questionDate: string \| undefined): string` | Implements the source line operation. | function | internal | [line 101](../../src/evidence-agent/adapters/pi/memory-observation.ts#L101) |
| `conversationHeading(sources: readonly (MemoryCandidate \| MemoryEvidence)[]): string` | Implements the conversation heading operation. | function | internal | [line 112](../../src/evidence-agent/adapters/pi/memory-observation.ts#L112) |
| `renderInLedgerOrder(sources: readonly T[], renderSource: (source: T) => string): string[]` | Preserve the supplied order: the current operator order for latest results, and stable discovery order for older findings. | function | internal | [line 128](../../src/evidence-agent/adapters/pi/memory-observation.ts#L128) |
| `searchQueries(candidate: MemoryCandidate): string[]` | Searches queries. | function | internal | [line 144](../../src/evidence-agent/adapters/pi/memory-observation.ts#L144) |
| `renderInspectReceipts(candidates: readonly MemoryCandidate[], ledger: MemoryLedger, questionDate: string \| undefined): string[]` | Renders inspect receipts. | function | internal | [line 155](../../src/evidence-agent/adapters/pi/memory-observation.ts#L155) |
| `renderUnreadFindings(candidates: readonly MemoryCandidate[], ledger: MemoryLedger, questionDate: string \| undefined, previewLength?: number): string[]` | Renders unread findings. | function | internal | [line 180](../../src/evidence-agent/adapters/pi/memory-observation.ts#L180) |
| `renderCompactDirectory(candidates: readonly MemoryCandidate[], ledger: MemoryLedger, questionDate: string \| undefined, previewLength: number): string[]` | Renders compact directory. | function | internal | [line 215](../../src/evidence-agent/adapters/pi/memory-observation.ts#L215) |
| `createMemoryObservation(options: CreateMemoryObservationOptions): MemoryObservation` | Maintains one model-facing memory snapshot for a run. | function | exported | [line 250](../../src/evidence-agent/adapters/pi/memory-observation.ts#L250) |
## `src/evidence-agent/adapters/pi/read-receipts.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `renderReadReceipts(ledger: MemoryLedger): string` | Bounded excerpts of actual reads, independent of model-authored progress. | function | exported | [line 5](../../src/evidence-agent/adapters/pi/read-receipts.ts#L5) |
## `src/evidence-agent/adapters/pi/retrieval-prompt.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `activeSkillPrompt(skill: Exclude<PicorerSkill, "none">): string` | Implements the active skill prompt operation. | function | internal | [line 56](../../src/evidence-agent/adapters/pi/retrieval-prompt.ts#L56) |
| `picorerSystemPrompt(skill: PicorerSkill = "picorer-v0", basePrompt?: string, operatorCatalog: readonly SearchOperatorCatalogEntry[] = []): string` | Implements the Picorer system prompt operation. | function | exported | [line 64](../../src/evidence-agent/adapters/pi/retrieval-prompt.ts#L64) |
## `src/evidence-agent/adapters/pi/rewrite-working-memory-context.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createRewriteWorkingMemoryContext(ledger: MemoryLedger, maxSearchCalls?: number, compact = false)` | Notes are optional annotations. | function | exported | [line 50](../../src/evidence-agent/adapters/pi/rewrite-working-memory-context.ts#L50) |
## `src/evidence-agent/adapters/pi/run-agent.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `PicorerRunError` | Implements the Picorer run error. | class | exported | [line 118](../../src/evidence-agent/adapters/pi/run-agent.ts#L118) |
| `PicorerRunError.constructor(message: string, diagnostics: PicorerFailureDiagnostics, code: PicorerFailureCode = "runtime_error")` | Creates a Picorer run error instance. | method | public | [line 122](../../src/evidence-agent/adapters/pi/run-agent.ts#L122) |
| `providerFailureKind(message: string): PicorerProviderFailureKind` | Implements the provider failure kind operation. | function | internal | [line 136](../../src/evidence-agent/adapters/pi/run-agent.ts#L136) |
| `providerResponseModel(message: string): string \| undefined` | Implements the provider response model operation. | function | internal | [line 156](../../src/evidence-agent/adapters/pi/run-agent.ts#L156) |
| `questionPrompt(question: string, questionDate?: string, compact = false): string` | Builds the user prompt from the question and optional question date. | function | internal | [line 162](../../src/evidence-agent/adapters/pi/run-agent.ts#L162) |
| `runPicorer(options: RunPicorerOptions): Promise<PicorerResult>` | Runs one bounded evidence-agent session and returns its provenance-backed result. | function | exported | [line 204](../../src/evidence-agent/adapters/pi/run-agent.ts#L204) |
## `src/evidence-agent/adapters/pi/tools.ts`

_No top-level functions, classes, or class methods._
## `src/evidence-agent/adapters/pi/tools/bash-tool.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createBashRoTool(options: CreatePicorerToolsOptions & { bashRo: NonNullable<CreatePicorerToolsOptions["bashRo"]>; }): AgentTool<typeof BashRoParameters, BashRoToolDetails>` | Creates bash ro tool. | function | exported | [line 8](../../src/evidence-agent/adapters/pi/tools/bash-tool.ts#L8) |
## `src/evidence-agent/adapters/pi/tools/candidate-details.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `candidateToolDetails(candidates: readonly MemoryCandidate[]): CandidateToolDetails[]` | Keeps exact text in preview once, while retaining passage provenance. | function | exported | [line 5](../../src/evidence-agent/adapters/pi/tools/candidate-details.ts#L5) |
## `src/evidence-agent/adapters/pi/tools/candidate-refs.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `uniqueCandidateRefs(refs: readonly string[]): string[]` | Implements the unique candidate refs operation. | function | exported | [line 1](../../src/evidence-agent/adapters/pi/tools/candidate-refs.ts#L1) |
## `src/evidence-agent/adapters/pi/tools/contracts.ts`

_No top-level functions, classes, or class methods._
## `src/evidence-agent/adapters/pi/tools/create-tools.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createPicorerTools(options: CreatePicorerToolsOptions): PicorerTools` | Creates Picorer tools. | function | exported | [line 9](../../src/evidence-agent/adapters/pi/tools/create-tools.ts#L9) |
## `src/evidence-agent/adapters/pi/tools/define-operator-tool.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createDefineOperatorTool(options: CreatePicorerToolsOptions & { operatorDefinitions: NonNullable<CreatePicorerToolsOptions["operatorDefinitions"]>; }): NonNullable<PicorerTools["defineOperator"]>` | Creates the compact Agent tool that assembles existing operators into one run-local operator. | function | exported | [line 7](../../src/evidence-agent/adapters/pi/tools/define-operator-tool.ts#L7) |
## `src/evidence-agent/adapters/pi/tools/finish-tool.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createFinishTool(options: CreatePicorerToolsOptions): PicorerTools["finish"]` | Creates finish tool. | function | exported | [line 6](../../src/evidence-agent/adapters/pi/tools/finish-tool.ts#L6) |
## `src/evidence-agent/adapters/pi/tools/read-tool.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createReadTool(options: CreatePicorerToolsOptions): PicorerTools["read"]` | Creates read tool. | function | exported | [line 17](../../src/evidence-agent/adapters/pi/tools/read-tool.ts#L17) |
## `src/evidence-agent/adapters/pi/tools/render-tool-result.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `temporalSuffix(timestamp: string \| undefined, questionDate: string \| undefined): string` | Implements the temporal suffix operation. | function | internal | [line 9](../../src/evidence-agent/adapters/pi/tools/render-tool-result.ts#L9) |
| `renderEvidenceOperator(result: EvidenceOperatorResult \| undefined, ledger: MemoryLedger): string` | Renders evidence operator. | function | exported | [line 17](../../src/evidence-agent/adapters/pi/tools/render-tool-result.ts#L17) |
| `renderCandidates(candidates: readonly MemoryCandidate[], ledger: MemoryLedger, questionDate?: string): string` | Renders candidates. | function | exported | [line 69](../../src/evidence-agent/adapters/pi/tools/render-tool-result.ts#L69) |
| `renderInspectedEvidence(memories: readonly MemoryEvidence[], ledger: MemoryLedger, questionDate?: string, candidateIds: readonly string[] = []): string` | Renders inspected evidence. | function | exported | [line 91](../../src/evidence-agent/adapters/pi/tools/render-tool-result.ts#L91) |
## `src/evidence-agent/adapters/pi/tools/schemas.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `SearchOperatorId(description: string)` | Implements the search operator id operation. | function | internal | [line 13](../../src/evidence-agent/adapters/pi/tools/schemas.ts#L13) |
| `SearchQueries(description: string)` | Implements the search queries operation. | function | internal | [line 20](../../src/evidence-agent/adapters/pi/tools/schemas.ts#L20) |
| `createSearchParameters(operatorIds: readonly string[])` | Creates search parameters. | function | exported | [line 40](../../src/evidence-agent/adapters/pi/tools/schemas.ts#L40) |
## `src/evidence-agent/adapters/pi/tools/search-tool.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `renderPlanTrace(trace: SearchOperatorCompositionTrace \| undefined): string \| undefined` | Renders plan trace. | function | internal | [line 24](../../src/evidence-agent/adapters/pi/tools/search-tool.ts#L24) |
| `hitQueryFingerprints(hit: RetrievalHit): Set<string>` | Implements the hit query fingerprints operation. | function | internal | [line 48](../../src/evidence-agent/adapters/pi/tools/search-tool.ts#L48) |
| `coverageProgress(input: { call: number; hits: readonly RetrievalHit[]; executedQueries: readonly string[]; repeatedQueries: readonly string[]; previousCandidates: readonly MemoryCandidate[]; requestedLimit: number; consecutiveNoNewCandidateCalls: number; consecutiveNoNewSessionCalls: number; }): SearchCoverageProgress` | Implements the coverage progress operation. | function | internal | [line 52](../../src/evidence-agent/adapters/pi/tools/search-tool.ts#L52) |
| `renderCoverageProgress(progress: SearchCoverageProgress): string` | Renders coverage progress. | function | internal | [line 136](../../src/evidence-agent/adapters/pi/tools/search-tool.ts#L136) |
| `nextContinuationDepth(depth: number, maxDepth: number): number \| undefined` | Implements the next continuation depth operation. | function | internal | [line 180](../../src/evidence-agent/adapters/pi/tools/search-tool.ts#L180) |
| `pageOperatorResult(result: EvidenceOperatorResult \| undefined, hits: readonly RetrievalHit[], reservoirHits: readonly RetrievalHit[], ledger: MemoryLedger): EvidenceOperatorResult \| undefined` | Implements the page operator result operation. | function | internal | [line 191](../../src/evidence-agent/adapters/pi/tools/search-tool.ts#L191) |
| `createSearchTools(options: CreatePicorerToolsOptions): Pick<PicorerTools, "search" \| "searchMore">` | Creates search tools. | function | exported | [line 233](../../src/evidence-agent/adapters/pi/tools/search-tool.ts#L233) |
## `src/evidence-agent/adapters/pi/tools/tool-protocol.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `validateFinishToolBatch(toolNames: readonly string[], finishToolName = "finish"): string \| undefined` | Validates finish tool batch. | function | exported | [line 7](../../src/evidence-agent/adapters/pi/tools/tool-protocol.ts#L7) |
| `createFinishOnlyBeforeToolCall(finishToolName = "finish"): ( context: BeforeToolCallContext, signal?: AbortSignal, ) => Promise<BeforeToolCallResult \| undefined>` | Creates finish only before tool call. | function | exported | [line 18](../../src/evidence-agent/adapters/pi/tools/tool-protocol.ts#L18) |
| `createToolProtocolBeforeToolCall(): ( context: BeforeToolCallContext, signal?: AbortSignal, ) => Promise<BeforeToolCallResult \| undefined>` | Creates tool protocol before tool call. | function | exported | [line 45](../../src/evidence-agent/adapters/pi/tools/tool-protocol.ts#L45) |
## `src/evidence-agent/adapters/pi/work-progress-contract.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `normalized(s: string)` | Normalizes d. | function | internal | [line 23](../../src/evidence-agent/adapters/pi/work-progress-contract.ts#L23) |
| `contains(body: string, quote: string)` | Implements the contains operation. | function | internal | [line 24](../../src/evidence-agent/adapters/pi/work-progress-contract.ts#L24) |
| `createWorkProgress(ledger: MemoryLedger)` | Creates work progress. | function | exported | [line 25](../../src/evidence-agent/adapters/pi/work-progress-contract.ts#L25) |
## `src/evidence-agent/adapters/pi/working-memory-context.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createWorkingMemoryContext(ledger: MemoryLedger, maxSearchCalls?: number, mode: "entries" \| "progress" \| "rewrite" = "entries", compact = false)` | Creates working memory context. | function | exported | [line 44](../../src/evidence-agent/adapters/pi/working-memory-context.ts#L44) |
## `src/evidence-agent/adapters/pi/working-memory-observation.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `createWorkingMemoryObservation(ledger: MemoryLedger, maxSearchCalls?: number, options: WorkingMemoryObservationOptions = {})` | Navigation deltas only. | function | exported | [line 19](../../src/evidence-agent/adapters/pi/working-memory-observation.ts#L19) |
## `src/evidence-agent/index.ts`

_No top-level functions, classes, or class methods._
## `src/evidence-agent/model/evidence.ts`

_No top-level functions, classes, or class methods._
## `src/evidence-agent/model/ledger.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `cloneCandidate(candidate: MemoryCandidate): MemoryCandidate` | Implements the clone candidate operation. | function | internal | [line 24](../../src/evidence-agent/model/ledger.ts#L24) |
| `cloneEvidence(evidence: MemoryEvidence): MemoryEvidence` | Implements the clone evidence operation. | function | internal | [line 43](../../src/evidence-agent/model/ledger.ts#L43) |
| `cloneSelection(selection: PicorerSelection): PicorerSelection` | Implements the clone selection operation. | function | internal | [line 47](../../src/evidence-agent/model/ledger.ts#L47) |
| `MemoryLedger` | Per-question, in-memory provenance ledger. | class | exported | [line 73](../../src/evidence-agent/model/ledger.ts#L73) |
| `MemoryLedger.constructor(scopeId: string)` | Creates a memory ledger instance. | method | public | [line 89](../../src/evidence-agent/model/ledger.ts#L89) |
| `MemoryLedger.nextStep(): number` | Implements the next step operation. | method | public | [line 97](../../src/evidence-agent/model/ledger.ts#L97) |
| `MemoryLedger.hasInspected(memoryId: string): boolean` | Checks whether inspected. | method | public | [line 127](../../src/evidence-agent/model/ledger.ts#L127) |
| `MemoryLedger.candidateRef(candidateOrMemoryId: string): string \| undefined` | Checks whether didate ref. | method | public | [line 131](../../src/evidence-agent/model/ledger.ts#L131) |
| `MemoryLedger.candidateRefForQuote(memoryId: string, quote: string): string \| undefined` | Checks whether didate ref for quote. | method | public | [line 141](../../src/evidence-agent/model/ledger.ts#L141) |
| `MemoryLedger.evidenceRef(memoryId: string): string \| undefined` | Implements the evidence ref operation. | method | public | [line 157](../../src/evidence-agent/model/ledger.ts#L157) |
| `MemoryLedger.resolveCandidateRefs(refs: readonly string[]): string[]` | Resolves candidate refs. | method | public | [line 161](../../src/evidence-agent/model/ledger.ts#L161) |
| `MemoryLedger.resolveCandidates(refs: readonly string[]): MemoryCandidate[]` | Resolves candidates. | method | public | [line 165](../../src/evidence-agent/model/ledger.ts#L165) |
| `MemoryLedger.selectCandidates(candidateOrMemoryIds: readonly string[]): MemoryCandidate[]` | Implements the select candidates operation. | method | public | [line 181](../../src/evidence-agent/model/ledger.ts#L181) |
| `MemoryLedger.selectMemoryCandidates(memoryIds: readonly string[]): MemoryCandidate[]` | Returns every passage/legacy candidate belonging to the given parents. | method | public | [line 201](../../src/evidence-agent/model/ledger.ts#L201) |
| `MemoryLedger.sourceSpansFor(record: MemoryRecord): SourceSpan[]` | Source-bound search fragments survive later searches and preview changes. | method | public | [line 213](../../src/evidence-agent/model/ledger.ts#L213) |
| `MemoryLedger.recordSearchHits(hits: readonly RetrievalHit[], step = this.nextStep()): MemoryCandidate[]` | Registers retrieval hits as candidates while preserving first-seen provenance. | method | public | [line 224](../../src/evidence-agent/model/ledger.ts#L224) |
| `MemoryLedger.recordInspect(evidenceRecords: readonly MemoryEvidence[], step = this.nextStep(), inspectedCandidateIds: readonly string[] = []): MemoryEvidence[]` | Records bounded exact source excerpts returned by inspect. | method | public | [line 281](../../src/evidence-agent/model/ledger.ts#L281) |
| `MemoryLedger.recordBashDiscoveries(records: readonly MemoryRecord[], command: string, step = this.nextStep()): MemoryCandidate[]` | Implements the record bash discoveries operation. | method | public | [line 362](../../src/evidence-agent/model/ledger.ts#L362) |
| `MemoryLedger.finish(input: PicorerSelection): PicorerSelection` | Validates and stores the agent's final evidence selection. | method | public | [line 380](../../src/evidence-agent/model/ledger.ts#L380) |
| `MemoryLedger.assertInvariants(): void` | Verifies candidate, evidence, citation, and scope provenance invariants. | method | public | [line 476](../../src/evidence-agent/model/ledger.ts#L476) |
| `MemoryLedger.assertScope(record: Pick<MemoryRecord, "scopeId" \| "memoryId">): void` | Validates scope and throws when invalid. | method | private | [line 501](../../src/evidence-agent/model/ledger.ts#L501) |
| `MemoryLedger.upsertCandidate(candidateId: string, record: Pick< MemoryRecord, "memoryId" \| "scopeId" \| "sessionId" \| "turnIndex" \| "role" \| "timestamp" >, preview: string, discovery: MemoryCandidate["discoveries"][number], passage?: MemoryPassage): void` | Implements the upsert candidate operation. | method | private | [line 509](../../src/evidence-agent/model/ledger.ts#L509) |
## `src/evidence-agent/model/operator-evolution.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `integerOption(value: number \| undefined, fallback: number, label: string, minimum: number, maximum: number): number` | Implements the integer option operation. | function | internal | [line 67](../../src/evidence-agent/model/operator-evolution.ts#L67) |
| `definitionHash(definition: SearchOperatorDefinition): string` | Implements the definition hash operation. | function | internal | [line 83](../../src/evidence-agent/model/operator-evolution.ts#L83) |
| `isRecord(value: unknown): value is Record<string, unknown>` | Checks whether record. | function | internal | [line 87](../../src/evidence-agent/model/operator-evolution.ts#L87) |
| `searchUse(trace: ToolTraceEntry): SearchUse \| undefined` | Searches use. | function | internal | [line 91](../../src/evidence-agent/model/operator-evolution.ts#L91) |
| `isQueryAgnostic(definition: SearchOperatorDefinition): boolean` | Checks whether query agnostic. | function | internal | [line 126](../../src/evidence-agent/model/operator-evolution.ts#L126) |
| `cloneEntry(entry: OperatorEvolutionEntrySnapshot): OperatorEvolutionEntrySnapshot` | Implements the clone entry operation. | function | internal | [line 132](../../src/evidence-agent/model/operator-evolution.ts#L132) |
| `normalizedQuestionId(questionId: string): string` | Normalizes d question id. | function | internal | [line 142](../../src/evidence-agent/model/operator-evolution.ts#L142) |
| `OperatorEvolutionCatalog` | Carries reusable declarative retrieval plans across an incremental question stream. | class | exported | [line 153](../../src/evidence-agent/model/operator-evolution.ts#L153) |
| `OperatorEvolutionCatalog.constructor(options: OperatorEvolutionOptions = {})` | Creates a operator evolution catalog instance. | method | public | [line 162](../../src/evidence-agent/model/operator-evolution.ts#L162) |
| `OperatorEvolutionCatalog.restore(snapshot: OperatorEvolutionSnapshot): OperatorEvolutionCatalog` | Implements the restore operation. | method | public | [line 180](../../src/evidence-agent/model/operator-evolution.ts#L180) |
| `OperatorEvolutionCatalog.maxDefinitionsForRun(): number` | Implements the max definitions for run operation. | method | public | [line 218](../../src/evidence-agent/model/operator-evolution.ts#L218) |
| `OperatorEvolutionCatalog.definitionsForNextQuestion(): SearchOperatorDefinition[]` | Implements the definitions for next question operation. | method | public | [line 222](../../src/evidence-agent/model/operator-evolution.ts#L222) |
| `OperatorEvolutionCatalog.observe(questionId: string, result: PicorerResult): OperatorEvolutionObservation` | Implements the observe operation. | method | public | [line 246](../../src/evidence-agent/model/operator-evolution.ts#L246) |
| `OperatorEvolutionCatalog.snapshot(): OperatorEvolutionSnapshot` | Implements the snapshot operation. | method | public | [line 375](../../src/evidence-agent/model/operator-evolution.ts#L375) |
## `src/evidence-agent/model/rewrite-working-memory.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `RewriteWorkingMemory` | One replaceable note; prior revisions are audit data, never model context. | class | exported | [line 11](../../src/evidence-agent/model/rewrite-working-memory.ts#L11) |
| `RewriteWorkingMemory.constructor(private readonly validateReferences: (text: string) => void)` | Creates a rewrite working memory instance. | method | public | [line 14](../../src/evidence-agent/model/rewrite-working-memory.ts#L14) |
| `RewriteWorkingMemory.apply(value: unknown, toolCallId: string)` | Implements the apply operation. | method | public | [line 18](../../src/evidence-agent/model/rewrite-working-memory.ts#L18) |
| `RewriteWorkingMemory.render(): string` | Implements the render operation. | method | public | [line 35](../../src/evidence-agent/model/rewrite-working-memory.ts#L35) |
| `RewriteWorkingMemory.snapshot(): RewriteMemorySnapshot` | Implements the snapshot operation. | method | public | [line 40](../../src/evidence-agent/model/rewrite-working-memory.ts#L40) |
## `src/evidence-agent/model/source-evidence.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown>` | Implements the clone metadata operation. | function | internal | [line 55](../../src/evidence-agent/model/source-evidence.ts#L55) |
| `asciiLower(value: string): string` | Implements the ascii lower operation. | function | internal | [line 59](../../src/evidence-agent/model/source-evidence.ts#L59) |
| `focusTerms(focus: readonly string[]): string[]` | Implements the focus terms operation. | function | internal | [line 63](../../src/evidence-agent/model/source-evidence.ts#L63) |
| `mergeSpans(spans: readonly SourceSpan[]): SourceSpan[]` | Merges spans. | function | exported | [line 72](../../src/evidence-agent/model/source-evidence.ts#L72) |
| `focusedSpans(content: string, focus: readonly string[], budget: number, required: readonly SourceSpan[] = []): Array<{ start: number; end: number }>` | Implements the focused spans operation. | function | internal | [line 88](../../src/evidence-agent/model/source-evidence.ts#L88) |
| `renderEvidenceExcerpts(options: { sourceContentLength: number; excerpts: readonly EvidenceExcerpt[]; }): string` | Renders evidence excerpts. | function | exported | [line 176](../../src/evidence-agent/model/source-evidence.ts#L176) |
| `mergeEvidenceExcerpts(memoryId: string, sourceContentLength: number, excerpts: readonly EvidenceExcerpt[]): EvidenceExcerpt[]` | Merges evidence excerpts. | function | internal | [line 191](../../src/evidence-agent/model/source-evidence.ts#L191) |
| `mergeMemoryEvidence(existing: MemoryEvidence, incoming: MemoryEvidence): MemoryEvidence` | Accumulates independently inspected exact projections of one immutable source. | function | exported | [line 245](../../src/evidence-agent/model/source-evidence.ts#L245) |
| `projectMemoryEvidenceWithinBudget(record: MemoryRecord, focus: readonly string[], budget: number, required: readonly SourceSpan[] = []): MemoryEvidence` | Implements the project memory evidence within budget operation. | function | internal | [line 284](../../src/evidence-agent/model/source-evidence.ts#L284) |
| `projectMemoryEvidence(record: MemoryRecord, focus: readonly string[], maximumChars: number): MemoryEvidence` | Implements the project memory evidence operation. | function | exported | [line 316](../../src/evidence-agent/model/source-evidence.ts#L316) |
| `projectPassageEvidence(record: MemoryRecord, passage: MemoryPassage): MemoryEvidence` | Projects exactly the passage the Agent selected, bound to its parent hash. | function | exported | [line 329](../../src/evidence-agent/model/source-evidence.ts#L329) |
| `projectMemoryEvidenceBatch(records: readonly MemoryRecord[], focusFor: (record: MemoryRecord) => readonly string[], maximumChars = MAX_READ_RESULT_CHARS, requiredSpansFor: (record: MemoryRecord) => readonly SourceSpan[] = () => []): MemoryEvidence[]` | Implements the project memory evidence batch operation. | function | exported | [line 360](../../src/evidence-agent/model/source-evidence.ts#L360) |
## `src/evidence-agent/model/source-preview-spans.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `isSentenceBoundary(content: string, index: number): boolean` | Checks whether sentence boundary. | function | internal | [line 7](../../src/evidence-agent/model/source-preview-spans.ts#L7) |
| `completeNearbySentence(content: string, span: SourceSpan): SourceSpan` | A query-centred preview may stop in the middle of the matched sentence. | function | internal | [line 17](../../src/evidence-agent/model/source-preview-spans.ts#L17) |
| `candidatePreview(hit: RetrievalHit): string` | Legacy adapters may return unbounded previews; store and display the same view. | function | exported | [line 41](../../src/evidence-agent/model/source-preview-spans.ts#L41) |
| `sourcePreviewSpans(content: string, preview: string): SourceSpan[]` | Recover only verbatim source fragments; whitespace compaction is reversible. | function | exported | [line 49](../../src/evidence-agent/model/source-preview-spans.ts#L49) |
## `src/evidence-agent/model/work-progress.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `object(value: unknown): Record<string, unknown>` | Implements the object operation. | function | internal | [line 24](../../src/evidence-agent/model/work-progress.ts#L24) |
| `text(value: unknown, name: string, empty = false): string` | Implements the text operation. | function | internal | [line 28](../../src/evidence-agent/model/work-progress.ts#L28) |
| `array(value: unknown, parse: (v: unknown) => T): T[]` | Implements the array operation. | function | internal | [line 34](../../src/evidence-agent/model/work-progress.ts#L34) |
| `WorkProgress` | Current decisions, not a log of searches. | class | exported | [line 40](../../src/evidence-agent/model/work-progress.ts#L40) |
| `WorkProgress.constructor(private readonly sources: WorkSources)` | Creates a work progress instance. | method | public | [line 45](../../src/evidence-agent/model/work-progress.ts#L45) |
| `WorkProgress.apply(delta: unknown, toolCallId: string): WorkCommit` | Implements the apply operation. | method | public | [line 48](../../src/evidence-agent/model/work-progress.ts#L48) |
| `WorkProgress.basis(item: WorkItem): string` | Implements the basis operation. | method | private | [line 131](../../src/evidence-agent/model/work-progress.ts#L131) |
| `WorkProgress.gaps(): string[]` | Implements the gaps operation. | method | public | [line 138](../../src/evidence-agent/model/work-progress.ts#L138) |
| `WorkProgress.assertFinish(status: unknown): void` | Validates finish and throws when invalid. | method | public | [line 149](../../src/evidence-agent/model/work-progress.ts#L149) |
| `WorkProgress.render(): string` | Implements the render operation. | method | public | [line 154](../../src/evidence-agent/model/work-progress.ts#L154) |
| `WorkProgress.snapshot(): WorkProgressSnapshot` | Implements the snapshot operation. | method | public | [line 160](../../src/evidence-agent/model/work-progress.ts#L160) |
## `src/evidence-agent/model/working-memory.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `fields(value: unknown): Record<string, unknown>` | Implements the fields operation. | function | internal | [line 21](../../src/evidence-agent/model/working-memory.ts#L21) |
| `nonempty(value: unknown, name: string): string` | Implements the nonempty operation. | function | internal | [line 36](../../src/evidence-agent/model/working-memory.ts#L36) |
| `IncrementalWorkingMemory` | Task-local entries. | class | exported | [line 44](../../src/evidence-agent/model/working-memory.ts#L44) |
| `IncrementalWorkingMemory.constructor(private readonly validateReferences: (text: string) => void)` | Creates a incremental working memory instance. | method | public | [line 50](../../src/evidence-agent/model/working-memory.ts#L50) |
| `IncrementalWorkingMemory.apply(delta: unknown, toolCallId: string): WorkingMemoryCommit` | Implements the apply operation. | method | public | [line 54](../../src/evidence-agent/model/working-memory.ts#L54) |
| `IncrementalWorkingMemory.render(): string` | Implements the render operation. | method | public | [line 105](../../src/evidence-agent/model/working-memory.ts#L105) |
| `IncrementalWorkingMemory.snapshot(): WorkingMemorySnapshot` | Implements the snapshot operation. | method | public | [line 111](../../src/evidence-agent/model/working-memory.ts#L111) |
## `src/evidence-agent/ports/read-only-navigation.ts`

_No top-level functions, classes, or class methods._
## `src/memory/index.ts`

_No top-level functions, classes, or class methods._
## `src/memory/ingest-memory-sessions.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `assertSafeJson(value: unknown, path: string): void` | Validates safe json and throws when invalid. | function | internal | [line 31](../../src/memory/ingest-memory-sessions.ts#L31) |
| `cloneMetadata(value: Record<string, unknown> \| undefined, path: string): Record<string, unknown> \| undefined` | Implements the clone metadata operation. | function | internal | [line 58](../../src/memory/ingest-memory-sessions.ts#L58) |
| `validateTimestamp(value: string \| undefined, path: string): string \| undefined` | Validates timestamp. | function | internal | [line 70](../../src/memory/ingest-memory-sessions.ts#L70) |
| `recordsForScope(scopeId: string, sessions: readonly MemorySessionInput[]): MemoryRecord[]` | Implements the records for scope operation. | function | internal | [line 82](../../src/memory/ingest-memory-sessions.ts#L82) |
| `ingestMemorySessions(store: MemoryIngestStore, sessions: readonly MemorySessionInput[], options: IngestOptions = {}): Promise<IngestScopeResult[]>` | Deterministic, no-LLM ingest boundary. | function | exported | [line 167](../../src/memory/ingest-memory-sessions.ts#L167) |
## `src/memory/model/memory.ts`

_No top-level functions, classes, or class methods._
## `src/memory/ports/memory-ingest-store.ts`

_No top-level functions, classes, or class methods._
## `src/memoryarena-public-api.ts`

_No top-level functions, classes, or class methods._
## `src/platform/concurrency/async-pool.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `runAsyncPool(items: readonly T[], slots: number, worker: (item: T, context: AsyncPoolContext) => Promise<R>): Promise<R[]>` | Refills free slots; on failure, stops dispatch and settles active work before rejecting. | function | exported | [line 7](../../src/platform/concurrency/async-pool.ts#L7) |
## `src/platform/concurrency/request-gate.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `AsyncRequestGate` | Implements async request gate. | class | exported | [line 1](../../src/platform/concurrency/request-gate.ts#L1) |
| `AsyncRequestGate.constructor(maximumConcurrent: number, requestsPerSecond: number)` | Creates a async request gate instance. | method | public | [line 8](../../src/platform/concurrency/request-gate.ts#L8) |
| `AsyncRequestGate.run(operation: () => Promise<T>): Promise<T>` | Runs the operation. | method | public | [line 19](../../src/platform/concurrency/request-gate.ts#L19) |
| `AsyncRequestGate.acquire(): Promise<void>` | Implements the acquire operation. | method | private | [line 29](../../src/platform/concurrency/request-gate.ts#L29) |
| `AsyncRequestGate.release(): void` | Implements the release operation. | method | private | [line 37](../../src/platform/concurrency/request-gate.ts#L37) |
| `AsyncRequestGate.pace(): Promise<void>` | Implements the pace operation. | method | private | [line 46](../../src/platform/concurrency/request-gate.ts#L46) |
## `src/platform/filesystem/export-memory-scope.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `verifyExistingExport(directory: string, stagingPath: string, paths: Iterable<string>): Promise<void>` | Reuse only an exact, regular-file export of this immutable source snapshot. | function | internal | [line 7](../../src/platform/filesystem/export-memory-scope.ts#L7) |
| `exportMemoryScope(scopeId: string, records: readonly MemoryRecord[], exportRoot: string): Promise<ScopeExport>` | Atomically publishes the unchanged source files used by read-only navigation. | function | exported | [line 35](../../src/platform/filesystem/export-memory-scope.ts#L35) |
## `src/platform/filesystem/jsonl-writer.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `JsonlWriter` | Serializes large JSONL appends so concurrent workers cannot interleave lines. | class | exported | [line 4](../../src/platform/filesystem/jsonl-writer.ts#L4) |
| `JsonlWriter.append(path: string, value: unknown): Promise<void>` | Implements the append operation. | method | public | [line 7](../../src/platform/filesystem/jsonl-writer.ts#L7) |
| `JsonlWriter.flush(): Promise<void>` | Implements the flush operation. | method | public | [line 16](../../src/platform/filesystem/jsonl-writer.ts#L16) |
## `src/platform/filesystem/private-jsonl.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `readPrivateJsonl(path: string): Promise<T[]>` | Reads private jsonl. | function | exported | [line 9](../../src/platform/filesystem/private-jsonl.ts#L9) |
| `mergePrivateJsonl(path: string, incoming: readonly T[], identity: PrivateJsonlIdentity<T>): Promise<void>` | Merges private jsonl. | function | exported | [line 25](../../src/platform/filesystem/private-jsonl.ts#L25) |
## `src/platform/http/runtime-fetch.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `fetchWithHttpTimeout(input: string \| URL, init: RequestInit, timeoutMs?: number): Promise<Response>` | Implements the fetch with http timeout operation. | function | exported | [line 8](../../src/platform/http/runtime-fetch.ts#L8) |
| `transportErrorMessage(error: unknown): string` | Implements the transport error message operation. | function | exported | [line 26](../../src/platform/http/runtime-fetch.ts#L26) |
## `src/platform/pi/load-model-runtime.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `asObject(value: unknown, label: string): JsonObject` | Implements the as object operation. | function | internal | [line 76](../../src/platform/pi/load-model-runtime.ts#L76) |
| `asNonEmptyString(value: unknown, label: string): string` | Implements the as non empty string operation. | function | internal | [line 83](../../src/platform/pi/load-model-runtime.ts#L83) |
| `optionalBoolean(value: unknown, fallback: boolean, label: string): boolean` | Implements the optional boolean operation. | function | internal | [line 90](../../src/platform/pi/load-model-runtime.ts#L90) |
| `optionalPositiveInteger(value: unknown, fallback: number, label: string): number` | Implements the optional positive integer operation. | function | internal | [line 102](../../src/platform/pi/load-model-runtime.ts#L102) |
| `optionalCost(value: unknown, label: string): typeof DEFAULT_COST` | Implements the optional cost operation. | function | internal | [line 118](../../src/platform/pi/load-model-runtime.ts#L118) |
| `optionalInput(value: unknown, label: string): ("text" \| "image")[]` | Implements the optional input operation. | function | internal | [line 132](../../src/platform/pi/load-model-runtime.ts#L132) |
| `mergedCompat(providerValue: unknown, modelValue: unknown): JsonObject \| undefined` | Merges d compat. | function | internal | [line 144](../../src/platform/pi/load-model-runtime.ts#L144) |
| `optionalCompletionsCompat(raw: JsonObject \| undefined): OpenAICompletionsCompat \| undefined` | Implements the optional completions compat operation. | function | internal | [line 159](../../src/platform/pi/load-model-runtime.ts#L159) |
| `optionalResponsesCompat(raw: JsonObject \| undefined): OpenAIResponsesCompat \| undefined` | Implements the optional responses compat operation. | function | internal | [line 238](../../src/platform/pi/load-model-runtime.ts#L238) |
| `supportedApi(value: unknown, label: string): PiModelApi` | Implements the supported api operation. | function | internal | [line 276](../../src/platform/pi/load-model-runtime.ts#L276) |
| `validateBaseUrl(value: unknown): string` | Validates base url. | function | internal | [line 286](../../src/platform/pi/load-model-runtime.ts#L286) |
| `parseJsonFile(path: string, label: string): Promise<JsonObject>` | Parses json file. | function | internal | [line 306](../../src/platform/pi/load-model-runtime.ts#L306) |
| `trustedCommand(apiKeyConfig: unknown): string` | Implements the trusted command operation. | function | internal | [line 326](../../src/platform/pi/load-model-runtime.ts#L326) |
| `executeTrustedApiKeyCommand(command: string): Promise<string>` | Executes trusted api key command. | function | internal | [line 343](../../src/platform/pi/load-model-runtime.ts#L343) |
| `thinkingLevelFor(value: unknown, label: string): ThinkingLevel` | Implements the thinking level for operation. | function | internal | [line 370](../../src/platform/pi/load-model-runtime.ts#L370) |
| `validatedApiKeyEnvironmentName(value: unknown): string` | Validates d api key environment name. | function | internal | [line 380](../../src/platform/pi/load-model-runtime.ts#L380) |
| `environmentApiKeyResolver(providerId: string, environmentName: string): PiModelRuntime["getApiKey"]` | Implements the environment api key resolver operation. | function | internal | [line 388](../../src/platform/pi/load-model-runtime.ts#L388) |
| `streamFunctionFor(api: PiModelApi, transport: PiModelTransport): StreamFn` | Implements the stream function for operation. | function | internal | [line 402](../../src/platform/pi/load-model-runtime.ts#L402) |
| `loadAdaptedPiModelRuntime(options: LoadPiModelRuntimeOptions): PiModelRuntime` | Loads adapted pi model runtime. | function | internal | [line 418](../../src/platform/pi/load-model-runtime.ts#L418) |
| `loadPiModelRuntime(options: LoadPiModelRuntimeOptions = {}): Promise<PiModelRuntime>` | Loads pi model runtime. | function | exported | [line 493](../../src/platform/pi/load-model-runtime.ts#L493) |
## `src/platform/pi/model-runtime-adapter.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `PiModelRuntimeAdapterRegistry` | Implements pi model runtime adapter registry. | class | exported | [line 32](../../src/platform/pi/model-runtime-adapter.ts#L32) |
| `PiModelRuntimeAdapterRegistry.constructor(adapters: readonly PiModelRuntimeAdapter[] = [])` | Creates a pi model runtime adapter registry instance. | method | public | [line 35](../../src/platform/pi/model-runtime-adapter.ts#L35) |
| `PiModelRuntimeAdapterRegistry.register(adapter: PiModelRuntimeAdapter): void` | Implements the register operation. | method | public | [line 39](../../src/platform/pi/model-runtime-adapter.ts#L39) |
| `PiModelRuntimeAdapterRegistry.resolve(id: string): PiModelRuntimeAdapter` | Implements the resolve operation. | method | public | [line 48](../../src/platform/pi/model-runtime-adapter.ts#L48) |
| `PiModelRuntimeAdapterRegistry.list(): readonly PiModelRuntimeAdapter[]` | Implements the list operation. | method | public | [line 56](../../src/platform/pi/model-runtime-adapter.ts#L56) |
| `openAiCompletionsAdapter(): PiModelRuntimeAdapter` | Implements the open ai completions adapter operation. | function | internal | [line 68](../../src/platform/pi/model-runtime-adapter.ts#L68) |
| `openAiReasoningCompletionsAdapter(): PiModelRuntimeAdapter` | Implements the open ai reasoning completions adapter operation. | function | internal | [line 94](../../src/platform/pi/model-runtime-adapter.ts#L94) |
| `openAiResponsesAdapter(): PiModelRuntimeAdapter` | Implements the open ai responses adapter operation. | function | internal | [line 127](../../src/platform/pi/model-runtime-adapter.ts#L127) |
| `qwenCompletionsAdapter(): PiModelRuntimeAdapter` | Implements the qwen completions adapter operation. | function | internal | [line 152](../../src/platform/pi/model-runtime-adapter.ts#L152) |
| `createDefaultPiModelRuntimeAdapterRegistry(): PiModelRuntimeAdapterRegistry` | Creates default pi model runtime adapter registry. | function | exported | [line 187](../../src/platform/pi/model-runtime-adapter.ts#L187) |
## `src/platform/pi/openai-non-stream-transport.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `resolvedMessageCompat(model: Model<"openai-completions">): MessageCompat` | Resolves the OpenAI message-conversion compatibility settings for a model. | function | internal | [line 62](../../src/platform/pi/openai-non-stream-transport.ts#L62) |
| `requestHeaders(model: Model<"openai-completions">, options: SimpleStreamOptions \| undefined): Headers` | Builds authenticated JSON request headers without persisting the API key. | function | internal | [line 96](../../src/platform/pi/openai-non-stream-transport.ts#L96) |
| `serializedTools(context: Context, compat: MessageCompat): JsonObject[] \| undefined` | Serializes Pi function tools for an OpenAI-compatible request. | function | internal | [line 116](../../src/platform/pi/openai-non-stream-transport.ts#L116) |
| `buildPayload(model: Model<"openai-completions">, context: Context, options: SimpleStreamOptions \| undefined): JsonObject` | Builds a non-streaming Chat Completions request from Pi model context. | function | internal | [line 139](../../src/platform/pi/openai-non-stream-transport.ts#L139) |
| `asObject(value: unknown, label: string): JsonObject` | Validates that an untrusted protocol value is a JSON object. | function | internal | [line 170](../../src/platform/pi/openai-non-stream-transport.ts#L170) |
| `nonNegativeInteger(value: unknown): number` | Normalizes an untrusted usage counter to a non-negative integer. | function | internal | [line 177](../../src/platform/pi/openai-non-stream-transport.ts#L177) |
| `responseUsage(model: Model<"openai-completions">, raw: ChatCompletionResponse["usage"]): Usage` | Maps provider token usage and model rates to Pi usage metadata. | function | internal | [line 185](../../src/platform/pi/openai-non-stream-transport.ts#L185) |
| `responseText(content: unknown): string` | Extracts text from an OpenAI-compatible assistant response. | function | internal | [line 218](../../src/platform/pi/openai-non-stream-transport.ts#L218) |
| `responseThinking(message: NonNullable<ChatCompletionChoice["message"]>): \| { thinking: string; signature: string } \| undefined` | Extracts optional reasoning text and its provider field name. | function | internal | [line 237](../../src/platform/pi/openai-non-stream-transport.ts#L237) |
| `responseToolCalls(value: unknown): ToolCall[]` | Validates and maps complete provider tool calls to Pi tool-call blocks. | function | internal | [line 253](../../src/platform/pi/openai-non-stream-transport.ts#L253) |
| `finishReason(value: unknown, hasToolCalls: boolean): { stopReason: StopReason; errorMessage?: string }` | Maps an OpenAI finish reason to the Pi stop-reason contract. | function | internal | [line 293](../../src/platform/pi/openai-non-stream-transport.ts#L293) |
| `errorMessageFromBody(text: string): string` | Extracts a bounded provider error message from an HTTP response body. | function | internal | [line 314](../../src/platform/pi/openai-non-stream-transport.ts#L314) |
| `transientHttpStatus(status: number): boolean` | Implements the transient http status operation. | function | internal | [line 329](../../src/platform/pi/openai-non-stream-transport.ts#L329) |
| `configuredMaximumRetries(options: SimpleStreamOptions \| undefined): number` | Implements the configured maximum retries operation. | function | internal | [line 333](../../src/platform/pi/openai-non-stream-transport.ts#L333) |
| `configuredMaximumRetryDelayMs(options: SimpleStreamOptions \| undefined): number` | Implements the configured maximum retry delay ms operation. | function | internal | [line 341](../../src/platform/pi/openai-non-stream-transport.ts#L341) |
| `retryDelayMs(response: Response, retryIndex: number, maximumDelayMs: number): number` | Implements the retry delay ms operation. | function | internal | [line 351](../../src/platform/pi/openai-non-stream-transport.ts#L351) |
| `attemptAbortContext(parent: AbortSignal \| undefined, timeoutMs: number \| undefined): AttemptAbortContext` | Implements the attempt abort context operation. | function | internal | [line 390](../../src/platform/pi/openai-non-stream-transport.ts#L390) |
| `waitForRetry(delayMs: number, signal: AbortSignal \| undefined): Promise<void>` | Implements the wait for retry operation. | function | internal | [line 423](../../src/platform/pi/openai-non-stream-transport.ts#L423) |
| `emitCompletedMessage(stream: ReturnType<typeof createAssistantMessageEventStream>, message: AssistantMessage): void` | Emits one complete assistant response through the Pi event protocol. | function | internal | [line 443](../../src/platform/pi/openai-non-stream-transport.ts#L443) |
| `openAINonStreamingStreamFn(genericModel, context, options)` | Executes one non-streaming Chat Completions request and exposes it as a Pi event stream. | function | exported | [line 516](../../src/platform/pi/openai-non-stream-transport.ts#L516) |
## `src/platform/security/protected-environment.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `sourceFiles(paths: readonly string[], environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>` | Implements the source files operation. | function | internal | [line 4](../../src/platform/security/protected-environment.ts#L4) |
| `loadProtectedEnvironment(paths: readonly string[], baseEnvironment: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv>` | Loads protected environment. | function | exported | [line 41](../../src/platform/security/protected-environment.ts#L41) |
| `requireEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): string` | Implements the require environment variable operation. | function | exported | [line 61](../../src/platform/security/protected-environment.ts#L61) |
## `src/platform/sqlite/float32-vector.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `encodeFloat32Vector(vector: readonly number[], dimensions: number): Buffer` | Implements the encode float32 vector operation. | function | exported | [line 1](../../src/platform/sqlite/float32-vector.ts#L1) |
| `decodeFloat32Vector(value: Uint8Array, dimensions: number): Float32Array` | Implements the decode float32 vector operation. | function | exported | [line 20](../../src/platform/sqlite/float32-vector.ts#L20) |
| `equalBytes(left: Uint8Array, right: Uint8Array): boolean` | Implements the equal bytes operation. | function | exported | [line 45](../../src/platform/sqlite/float32-vector.ts#L45) |
## `src/platform/sqlite/memory-row.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `memoryRowToRecord(row: MemoryRow): MemoryRecord` | Implements the memory row to record operation. | function | exported | [line 15](../../src/platform/sqlite/memory-row.ts#L15) |
## `src/platform/sqlite/picorer-store.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `compareRecords(a: MemoryRecord, b: MemoryRecord): number` | Compares records. | function | internal | [line 87](../../src/platform/sqlite/picorer-store.ts#L87) |
| `recordFingerprint(record: MemoryRecord): string` | Implements the record fingerprint operation. | function | internal | [line 98](../../src/platform/sqlite/picorer-store.ts#L98) |
| `validateEmbeddingProfile(profile: EmbeddingProfile): void` | Validates embedding profile. | function | internal | [line 112](../../src/platform/sqlite/picorer-store.ts#L112) |
| `MemoryStore` | Implements memory store. | class | exported | [line 120](../../src/platform/sqlite/picorer-store.ts#L120) |
| `MemoryStore.constructor(databasePath: string)` | Creates a memory store instance. | method | public | [line 136](../../src/platform/sqlite/picorer-store.ts#L136) |
| `MemoryStore.close(): void` | Closes owned resources. | method | public | [line 212](../../src/platform/sqlite/picorer-store.ts#L212) |
| `MemoryStore.ingestScope(scopeId: string, records: MemoryRecord[]): ScopeIngestStatus` | Atomically persists one immutable memory scope and reports whether it was inserted or reused. | method | public | [line 223](../../src/platform/sqlite/picorer-store.ts#L223) |
| `MemoryStore.appendMemoryRequest(request: AppendMemoryRequest): AppendMemoryResult` | Appends immutable source messages while the online scope is ingesting. | method | public | [line 294](../../src/platform/sqlite/picorer-store.ts#L294) |
| `MemoryStore.hasPendingAppendRequests(scopeId: string): boolean` | Checks whether pending append requests. | method | public | [line 436](../../src/platform/sqlite/picorer-store.ts#L436) |
| `MemoryStore.markAppendRequestComplete(requestId: string, requestHash: string): void` | Implements the mark append request complete operation. | method | public | [line 443](../../src/platform/sqlite/picorer-store.ts#L443) |
| `MemoryStore.getOnlineScopeState(scopeId: string): OnlineScopeState \| undefined` | Returns online scope state. | method | public | [line 453](../../src/platform/sqlite/picorer-store.ts#L453) |
| `MemoryStore.sealOnlineScope(scopeId: string): OnlineScopeState` | Implements the seal online scope operation. | method | public | [line 460](../../src/platform/sqlite/picorer-store.ts#L460) |
| `MemoryStore.recordsInTurnRange(scopeId: string, sessionId: string, startTurnIndex: number, count: number): MemoryRecord[]` | Implements the records in turn range operation. | method | private | [line 495](../../src/platform/sqlite/picorer-store.ts#L495) |
| `MemoryStore.ensureEvidenceFactIndex(scopeId: string): EvidenceFactIndexStatus` | Builds or validates the deterministic sidecar index for one scope. | method | public | [line 521](../../src/platform/sqlite/picorer-store.ts#L521) |
| `MemoryStore.expandEvidenceOperator(scopeId: string, request: SearchRequest, context: EvidenceOperatorSearchContext, seedHits: readonly StoreSearchHit[]): StoreSearchHit[]` | Expands hybrid/FTS seeds through the versioned database fact index. | method | public | [line 526](../../src/platform/sqlite/picorer-store.ts#L526) |
| `MemoryStore.searchLexical(scopeId: string, request: SearchRequest): StoreSearchHit[]` | Searches lexical. | method | public | [line 535](../../src/platform/sqlite/picorer-store.ts#L535) |
| `MemoryStore.search(scopeId: string, request: SearchRequest): StoreSearchHit[]` | Executes filtered FTS5 search and returns finalized retrieval hits. | method | public | [line 539](../../src/platform/sqlite/picorer-store.ts#L539) |
| `MemoryStore.read(scopeId: string, memoryIds: string[], contextBefore = 0, contextAfter = 0): MemoryRecord[]` | Reads exact memories by ID within one scope. | method | public | [line 543](../../src/platform/sqlite/picorer-store.ts#L543) |
| `MemoryStore.getRecords(scopeId: string, memoryIds: string[]): MemoryRecord[]` | Returns records. | method | public | [line 588](../../src/platform/sqlite/picorer-store.ts#L588) |
| `MemoryStore.listScopeRecords(scopeId: string): MemoryRecord[]` | Implements the list scope records operation. | method | public | [line 605](../../src/platform/sqlite/picorer-store.ts#L605) |
| `MemoryStore.listScopeIds(): string[]` | Lists immutable memory scope IDs in stable order for whole-corpus derived-index publication. | method | public | [line 619](../../src/platform/sqlite/picorer-store.ts#L619) |
| `MemoryStore.assertEmbeddingProfileConsistent(profile: EmbeddingProfile): void` | Validates embedding profile consistent and throws when invalid. | method | private | [line 626](../../src/platform/sqlite/picorer-store.ts#L626) |
| `MemoryStore.getEmbeddingIndexStatus(scopeId: string, profile: EmbeddingProfile): EmbeddingIndexStatus` | Returns embedding index status. | method | public | [line 652](../../src/platform/sqlite/picorer-store.ts#L652) |
| `MemoryStore.listMissingEmbeddingRecords(scopeId: string, profile: EmbeddingProfile): MemoryRecord[]` | Implements the list missing embedding records operation. | method | public | [line 707](../../src/platform/sqlite/picorer-store.ts#L707) |
| `MemoryStore.storeEmbeddingBatch(records: readonly MemoryRecord[], profile: EmbeddingProfile, vectors: readonly (readonly number[])[]): StoreEmbeddingBatchResult` | Implements the store embedding batch operation. | method | public | [line 726](../../src/platform/sqlite/picorer-store.ts#L726) |
| `MemoryStore.beginVectorIndexGeneration(config: VectorIndexGenerationConfig): VectorIndexGenerationStatus` | Implements the begin vector index generation operation. | method | public | [line 813](../../src/platform/sqlite/picorer-store.ts#L813) |
| `MemoryStore.enqueueStoredScopeEmbeddingsForVectorGeneration(generationId: string, scopeId: string, profile: EmbeddingProfile): number` | Implements the enqueue stored scope embeddings for vector generation operation. | method | public | [line 819](../../src/platform/sqlite/picorer-store.ts#L819) |
| `MemoryStore.getVectorIndexGeneration(generationId: string): VectorIndexGenerationStatus` | Returns vector index generation. | method | public | [line 831](../../src/platform/sqlite/picorer-store.ts#L831) |
| `MemoryStore.sealVectorIndexGeneration(generationId: string): VectorIndexGenerationStatus` | Implements the seal vector index generation operation. | method | public | [line 837](../../src/platform/sqlite/picorer-store.ts#L837) |
| `MemoryStore.claimVectorSyncBatch(generationId: string, limit: number, leaseMs: number, nowMs = Date.now()): VectorSyncClaim[]` | Implements the claim vector sync batch operation. | method | public | [line 843](../../src/platform/sqlite/picorer-store.ts#L843) |
| `MemoryStore.completeVectorSyncBatch(generationId: string, sequenceIds: readonly number[]): void` | Implements the complete vector sync batch operation. | method | public | [line 857](../../src/platform/sqlite/picorer-store.ts#L857) |
| `MemoryStore.releaseVectorSyncBatch(generationId: string, sequenceIds: readonly number[], error: unknown): void` | Implements the release vector sync batch operation. | method | public | [line 864](../../src/platform/sqlite/picorer-store.ts#L864) |
| `MemoryStore.beginVectorIndexVerification(generationId: string): VectorIndexGenerationStatus` | Implements the begin vector index verification operation. | method | public | [line 872](../../src/platform/sqlite/picorer-store.ts#L872) |
| `MemoryStore.markVectorIndexGenerationReady(generationId: string, observedVectorCount: number): VectorIndexGenerationStatus` | Implements the mark vector index generation ready operation. | method | public | [line 878](../../src/platform/sqlite/picorer-store.ts#L878) |
| `MemoryStore.failVectorIndexGeneration(generationId: string, error: unknown): void` | Implements the fail vector index generation operation. | method | public | [line 888](../../src/platform/sqlite/picorer-store.ts#L888) |
| `MemoryStore.assertVectorIndexGenerationReady(generationId: string): VectorIndexGenerationStatus` | Validates vector index generation ready and throws when invalid. | method | public | [line 892](../../src/platform/sqlite/picorer-store.ts#L892) |
| `MemoryStore.listVectorGenerationScopeCounts(generationId: string): Array<{ scopeId: string; count: number }>` | Implements the list vector generation scope counts operation. | method | public | [line 898](../../src/platform/sqlite/picorer-store.ts#L898) |
| `MemoryStore.getVectorGenerationScopeCount(generationId: string, scopeId: string): number` | Returns one generation's durable vector count for a scope-level fail-closed retrieval check. | method | public | [line 904](../../src/platform/sqlite/picorer-store.ts#L904) |
| `MemoryStore.listStoredEmbeddings(scopeId: string, profile: EmbeddingProfile, request: Omit<SearchRequest, "queries" \| "limit"> = {}): StoredEmbeddingRecord[]` | Implements the list stored embeddings operation. | method | public | [line 914](../../src/platform/sqlite/picorer-store.ts#L914) |
| `MemoryStore.findMentionedMemoryIds(scopeId: string, text: string): string[]` | Implements the find mentioned memory ids operation. | method | public | [line 967](../../src/platform/sqlite/picorer-store.ts#L967) |
| `MemoryStore.exportScope(scopeId: string, exportRoot: string): Promise<ScopeExport>` | Writes a sanitized, permission-restricted filesystem export of one scope. | method | public | [line 973](../../src/platform/sqlite/picorer-store.ts#L973) |
| `MemoryStore.create(databasePath: string): Promise<MemoryStore>` | Implements the create operation. | method | public | [line 977](../../src/platform/sqlite/picorer-store.ts#L977) |
## `src/platform/sqlite/vector-index-state-store.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `requiredIdentity(value: string, label: string): string` | Implements the required identity operation. | function | internal | [line 49](../../src/platform/sqlite/vector-index-state-store.ts#L49) |
| `boundedError(error: unknown): string` | Implements the bounded error operation. | function | internal | [line 55](../../src/platform/sqlite/vector-index-state-store.ts#L55) |
| `assertEmbeddingProfile(profile: EmbeddingProfile): void` | Validates embedding profile and throws when invalid. | function | internal | [line 59](../../src/platform/sqlite/vector-index-state-store.ts#L59) |
| `SqliteVectorIndexStateStore` | SQLite outbox and state machine for immutable external vector generations. | class | exported | [line 68](../../src/platform/sqlite/vector-index-state-store.ts#L68) |
| `SqliteVectorIndexStateStore.constructor(private readonly db: DatabaseSync, private readonly embeddingStatus: ( scopeId: string, profile: EmbeddingProfile, ) => EmbeddingIndexStatus)` | Creates a sqlite vector index state store instance. | method | public | [line 69](../../src/platform/sqlite/vector-index-state-store.ts#L69) |
| `SqliteVectorIndexStateStore.beginVectorIndexGeneration(config: VectorIndexGenerationConfig): VectorIndexGenerationStatus` | Implements the begin vector index generation operation. | method | public | [line 117](../../src/platform/sqlite/vector-index-state-store.ts#L117) |
| `SqliteVectorIndexStateStore.enqueueStoredScopeEmbeddingsForVectorGeneration(generationId: string, scopeId: string, profile: EmbeddingProfile): number` | Implements the enqueue stored scope embeddings for vector generation operation. | method | public | [line 155](../../src/platform/sqlite/vector-index-state-store.ts#L155) |
| `SqliteVectorIndexStateStore.getVectorIndexGeneration(generationId: string): VectorIndexGenerationStatus` | Returns vector index generation. | method | public | [line 211](../../src/platform/sqlite/vector-index-state-store.ts#L211) |
| `SqliteVectorIndexStateStore.sealVectorIndexGeneration(generationId: string): VectorIndexGenerationStatus` | Implements the seal vector index generation operation. | method | public | [line 246](../../src/platform/sqlite/vector-index-state-store.ts#L246) |
| `SqliteVectorIndexStateStore.claimVectorSyncBatch(generationId: string, limit: number, leaseMs: number, nowMs = Date.now()): VectorSyncClaim[]` | Implements the claim vector sync batch operation. | method | public | [line 293](../../src/platform/sqlite/vector-index-state-store.ts#L293) |
| `SqliteVectorIndexStateStore.completeVectorSyncBatch(generationId: string, sequenceIds: readonly number[]): void` | Implements the complete vector sync batch operation. | method | public | [line 369](../../src/platform/sqlite/vector-index-state-store.ts#L369) |
| `SqliteVectorIndexStateStore.releaseVectorSyncBatch(generationId: string, sequenceIds: readonly number[], error: unknown): void` | Implements the release vector sync batch operation. | method | public | [line 376](../../src/platform/sqlite/vector-index-state-store.ts#L376) |
| `SqliteVectorIndexStateStore.beginVectorIndexVerification(generationId: string): VectorIndexGenerationStatus` | Implements the begin vector index verification operation. | method | public | [line 389](../../src/platform/sqlite/vector-index-state-store.ts#L389) |
| `SqliteVectorIndexStateStore.markVectorIndexGenerationReady(generationId: string, observedVectorCount: number): VectorIndexGenerationStatus` | Implements the mark vector index generation ready operation. | method | public | [line 413](../../src/platform/sqlite/vector-index-state-store.ts#L413) |
| `SqliteVectorIndexStateStore.failVectorIndexGeneration(generationId: string, error: unknown): void` | Implements the fail vector index generation operation. | method | public | [line 436](../../src/platform/sqlite/vector-index-state-store.ts#L436) |
| `SqliteVectorIndexStateStore.assertVectorIndexGenerationReady(generationId: string): VectorIndexGenerationStatus` | Validates vector index generation ready and throws when invalid. | method | public | [line 445](../../src/platform/sqlite/vector-index-state-store.ts#L445) |
| `SqliteVectorIndexStateStore.listVectorGenerationScopeCounts(generationId: string): Array<{ scopeId: string; count: number }>` | Implements the list vector generation scope counts operation. | method | public | [line 455](../../src/platform/sqlite/vector-index-state-store.ts#L455) |
| `SqliteVectorIndexStateStore.getVectorGenerationScopeCount(generationId: string, scopeId: string): number` | Returns vector generation scope count. | method | public | [line 466](../../src/platform/sqlite/vector-index-state-store.ts#L466) |
| `SqliteVectorIndexStateStore.generationRow(generationId: string): VectorGenerationRow \| undefined` | Implements the generation row operation. | method | private | [line 478](../../src/platform/sqlite/vector-index-state-store.ts#L478) |
| `SqliteVectorIndexStateStore.generationFingerprint(generationId: string): string` | Implements the generation fingerprint operation. | method | private | [line 490](../../src/platform/sqlite/vector-index-state-store.ts#L490) |
| `SqliteVectorIndexStateStore.updateVectorSyncBatch(generationId: string, sequenceIds: readonly number[], state: "pending" \| "synced", lastError?: string): void` | Implements the update vector sync batch operation. | method | private | [line 527](../../src/platform/sqlite/vector-index-state-store.ts#L527) |
## `src/retrieval/adapters/fallback-dense-retriever.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `FallbackDenseRetriever` | Falls back only when the primary dense implementation is unavailable. | class | exported | [line 10](../../src/retrieval/adapters/fallback-dense-retriever.ts#L10) |
| `FallbackDenseRetriever.constructor(private readonly primary: DenseRetriever, private readonly fallback: DenseRetriever)` | Creates a fallback dense retriever instance. | method | public | [line 17](../../src/retrieval/adapters/fallback-dense-retriever.ts#L17) |
| `FallbackDenseRetriever.snapshotFallbackCount(): number` | Implements the snapshot fallback count operation. | method | public | [line 39](../../src/retrieval/adapters/fallback-dense-retriever.ts#L39) |
| `FallbackDenseRetriever.search(request: DenseSearchBatchRequest): Promise<DenseSearchHit[][]>` | Performs a search. | method | public | [line 43](../../src/retrieval/adapters/fallback-dense-retriever.ts#L43) |
## `src/retrieval/adapters/openai/openai-compatible-embedder.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `EmbeddingHttpError` | Implements embedding http error. | class | internal | [line 42](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L42) |
| `EmbeddingHttpError.constructor(status: number, dimensionsUnsupported = false, retryAfterMs?: number)` | Creates a embedding http error instance. | method | public | [line 47](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L47) |
| `EmbeddingResponseError` | Implements embedding response error. | class | internal | [line 60](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L60) |
| `EmbeddingResponseError.constructor(message: string)` | Creates a embedding response error instance. | method | public | [line 61](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L61) |
| `EmbeddingTimeoutError` | Implements embedding timeout error. | class | internal | [line 67](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L67) |
| `EmbeddingTimeoutError.constructor()` | Creates a embedding timeout error instance. | method | public | [line 68](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L68) |
| `positiveInteger(value: number, label: string): number` | Implements the positive integer operation. | function | internal | [line 74](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L74) |
| `nonNegativeInteger(value: number, label: string): number` | Implements the non negative integer operation. | function | internal | [line 81](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L81) |
| `endpointFor(baseUrl: string): string` | Implements the endpoint for operation. | function | internal | [line 88](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L88) |
| `cleanEmbeddingText(text: string): string` | Implements the clean embedding text operation. | function | exported | [line 107](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L107) |
| `chunkTextBalanced(text: string, maxLength: number): string[]` | Balances chunks by Unicode code point, following Picorer's Unicode code-point contract. | function | exported | [line 113](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L113) |
| `validateVector(vector: unknown, dimensions: number): number[]` | Validates vector. | function | internal | [line 126](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L126) |
| `averageVectors(vectors: readonly number[][], dimensions: number): number[]` | Implements the average vectors operation. | function | internal | [line 142](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L142) |
| `parsePositiveInteger(value: string \| undefined, fallback: number, variable: string): number` | Parses positive integer. | function | internal | [line 159](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L159) |
| `parseNonNegativeInteger(value: string \| undefined, fallback: number, variable: string): number` | Parses non negative integer. | function | internal | [line 169](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L169) |
| `retryAfterMilliseconds(value: string \| null): number \| undefined` | Implements the retry after milliseconds operation. | function | internal | [line 178](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L178) |
| `retryableEmbeddingError(error: unknown): boolean` | Implements the retryable embedding error operation. | function | internal | [line 189](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L189) |
| `safeEmbeddingError(error: unknown, attempts?: number): Error` | Implements the safe embedding error operation. | function | internal | [line 197](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L197) |
| `wait(delayMs: number, signal?: AbortSignal): Promise<void>` | Implements the wait operation. | function | internal | [line 211](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L211) |
| `clusterChunks(chunks: readonly string[], batchSize: number): string[][]` | Implements the cluster chunks operation. | function | internal | [line 228](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L228) |
| `OpenAICompatibleEmbedder` | Implements open ai compatible embedder. | class | exported | [line 251](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L251) |
| `OpenAICompatibleEmbedder.constructor(options: OpenAICompatibleEmbedderOptions)` | Creates a open ai compatible embedder instance. | method | public | [line 274](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L274) |
| `OpenAICompatibleEmbedder.fromEnvironment(environment: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch, requestGate?: AsyncRequestGate): OpenAICompatibleEmbedder` | Implements the from environment operation. | method | public | [line 316](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L316) |
| `OpenAICompatibleEmbedder.embedDocuments(texts: readonly string[], options: EmbeddingRequestOptions = {}): Promise<number[][]>` | Implements the embed documents operation. | method | public | [line 373](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L373) |
| `OpenAICompatibleEmbedder.embedQueries(texts: readonly string[], options: EmbeddingRequestOptions = {}): Promise<number[][]>` | Implements the embed queries operation. | method | public | [line 380](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L380) |
| `OpenAICompatibleEmbedder.snapshotMetrics(): EmbeddingMetrics` | Implements the snapshot metrics operation. | method | public | [line 387](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L387) |
| `OpenAICompatibleEmbedder.captureEmbeddingAttempts(observer: (metrics: EmbeddingMetrics) => void, operation: () => Promise<T>): Promise<T>` | Observes exact metrics for each provider request started by `operation`. | method | public | [line 401](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L401) |
| `OpenAICompatibleEmbedder.embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>` | Implements the embed operation. | method | private | [line 412](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L412) |
| `OpenAICompatibleEmbedder.embedCluster(inputs: readonly string[], signal?: AbortSignal): Promise<number[][]>` | Implements the embed cluster operation. | method | private | [line 440](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L440) |
| `OpenAICompatibleEmbedder.requestThroughGate(inputs: readonly string[], includeDimensions: boolean, signal?: AbortSignal): Promise<number[][]>` | Implements the request through gate operation. | method | private | [line 447](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L447) |
| `OpenAICompatibleEmbedder.embedClusterWithRetries(inputs: readonly string[], signal?: AbortSignal): Promise<number[][]>` | Implements the embed cluster with retries operation. | method | private | [line 457](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L457) |
| `OpenAICompatibleEmbedder.request(inputs: readonly string[], includeDimensions: boolean, signal?: AbortSignal): Promise<number[][]>` | Implements the request operation. | method | private | [line 510](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L510) |
| `OpenAICompatibleEmbedder.parseResponse(payload: unknown, inputCount: number): number[][]` | Parses response. | method | private | [line 593](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L593) |
| `OpenAICompatibleEmbedder.parseInputTokens(payload: unknown): number \| undefined` | Parses input tokens. | method | private | [line 645](../../src/retrieval/adapters/openai/openai-compatible-embedder.ts#L645) |
## `src/retrieval/adapters/operators/builtins.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `makeSearchRequest(input: SearchOperatorInput, order: SearchOrder = "relevance"): SearchRequest` | Implements the make search request operation. | function | internal | [line 19](../../src/retrieval/adapters/operators/builtins.ts#L19) |
| `mergeHits(preferred: readonly RetrievalHit[], fallback: readonly RetrievalHit[], limit: number): RetrievalHit[]` | Merges hits. | function | internal | [line 34](../../src/retrieval/adapters/operators/builtins.ts#L34) |
| `hybridOperator(store: SearchOperatorStore): SearchOperator` | Implements the hybrid operator operation. | function | internal | [line 51](../../src/retrieval/adapters/operators/builtins.ts#L51) |
| `lexicalOperator(store: SearchOperatorStore): SearchOperator` | Implements the lexical operator operation. | function | internal | [line 71](../../src/retrieval/adapters/operators/builtins.ts#L71) |
| `chronologicalOperator(store: SearchOperatorStore): SearchOperator` | Implements the chronological operator operation. | function | internal | [line 93](../../src/retrieval/adapters/operators/builtins.ts#L93) |
| `evidenceIndexOperator(store: SearchOperatorStore, operator: "temporal" \| "numeric"): SearchOperator` | Implements the evidence index operator operation. | function | internal | [line 113](../../src/retrieval/adapters/operators/builtins.ts#L113) |
| `builtInSearchOperators(store: SearchOperatorStore): SearchOperator[]` | Creates the built-in search-operator implementations over one injected store. | function | exported | [line 178](../../src/retrieval/adapters/operators/builtins.ts#L178) |
## `src/retrieval/adapters/qdrant/client.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `QdrantHttpError` | Implements qdrant http error. | class | exported | [line 88](../../src/retrieval/adapters/qdrant/client.ts#L88) |
| `QdrantHttpError.constructor(readonly status: number, message: string)` | Creates a qdrant http error instance. | method | public | [line 89](../../src/retrieval/adapters/qdrant/client.ts#L89) |
| `positiveInteger(value: number, label: string): number` | Implements the positive integer operation. | function | internal | [line 95](../../src/retrieval/adapters/qdrant/client.ts#L95) |
| `nonNegativeInteger(value: number, label: string): number` | Implements the non negative integer operation. | function | internal | [line 102](../../src/retrieval/adapters/qdrant/client.ts#L102) |
| `nonEmpty(value: string, label: string): string` | Implements the non empty operation. | function | internal | [line 109](../../src/retrieval/adapters/qdrant/client.ts#L109) |
| `objectValue(value: unknown, label: string): Record<string, unknown>` | Implements the object value operation. | function | internal | [line 114](../../src/retrieval/adapters/qdrant/client.ts#L114) |
| `memoryRole(value: unknown, label: string): MemoryRole` | Implements the memory role operation. | function | internal | [line 121](../../src/retrieval/adapters/qdrant/client.ts#L121) |
| `dateTimeMilliseconds(value: string, label: string): number` | Implements the date time milliseconds operation. | function | internal | [line 128](../../src/retrieval/adapters/qdrant/client.ts#L128) |
| `dateTime(value: string, label: string): string` | Implements the date time operation. | function | internal | [line 136](../../src/retrieval/adapters/qdrant/client.ts#L136) |
| `collectionName(value: string): string` | Collects ion name. | function | internal | [line 141](../../src/retrieval/adapters/qdrant/client.ts#L141) |
| `baseUrl(value: string): string` | Implements the base url operation. | function | internal | [line 148](../../src/retrieval/adapters/qdrant/client.ts#L148) |
| `finiteVector(vector: readonly number[], dimensions?: number): number[]` | Implements the finite vector operation. | function | internal | [line 165](../../src/retrieval/adapters/qdrant/client.ts#L165) |
| `responseSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal` | Implements the response signal operation. | function | internal | [line 175](../../src/retrieval/adapters/qdrant/client.ts#L175) |
| `responseMessage(status: number, body: string): string` | Implements the response message operation. | function | internal | [line 180](../../src/retrieval/adapters/qdrant/client.ts#L180) |
| `optimizerStatus(value: unknown): string` | Implements the optimizer status operation. | function | internal | [line 187](../../src/retrieval/adapters/qdrant/client.ts#L187) |
| `parseCollectionInfo(value: unknown): QdrantCollectionInfo` | Parses collection info. | function | internal | [line 195](../../src/retrieval/adapters/qdrant/client.ts#L195) |
| `QdrantClient` | Minimal HTTP adapter; Qdrant is never trusted as the source of memory text. | class | exported | [line 238](../../src/retrieval/adapters/qdrant/client.ts#L238) |
| `QdrantClient.constructor(options: QdrantClientOptions)` | Creates a qdrant client instance. | method | public | [line 244](../../src/retrieval/adapters/qdrant/client.ts#L244) |
| `QdrantClient.request(method: string, path: string, options: { body?: unknown; signal?: AbortSignal; acceptedStatuses?: readonly number[]; } = {}): Promise<{ status: number; value: unknown }>` | Implements the request operation. | method | private | [line 251](../../src/retrieval/adapters/qdrant/client.ts#L251) |
| `QdrantClient.getCollection(name: string, signal?: AbortSignal): Promise<QdrantCollectionInfo \| undefined>` | Returns collection. | method | public | [line 282](../../src/retrieval/adapters/qdrant/client.ts#L282) |
| `QdrantClient.ensurePayloadIndex(collection: string, fieldName: string, fieldSchema: Record<string, unknown>, signal?: AbortSignal): Promise<void>` | Implements the ensure payload index operation. | method | private | [line 297](../../src/retrieval/adapters/qdrant/client.ts#L297) |
| `QdrantClient.ensureCollection(spec: QdrantCollectionSpec, signal?: AbortSignal): Promise<void>` | Implements the ensure collection operation. | method | public | [line 313](../../src/retrieval/adapters/qdrant/client.ts#L313) |
| `QdrantClient.upsert(collection: string, dimensions: number, points: readonly QdrantVectorPoint[], signal?: AbortSignal): Promise<void>` | Implements the upsert operation. | method | public | [line 374](../../src/retrieval/adapters/qdrant/client.ts#L374) |
| `QdrantClient.count(request: QdrantCountRequest): Promise<number>` | Implements the count operation. | method | public | [line 413](../../src/retrieval/adapters/qdrant/client.ts#L413) |
| `QdrantClient.search(request: QdrantSearchRequest): Promise<QdrantSearchHit[]>` | Performs a search. | method | public | [line 437](../../src/retrieval/adapters/qdrant/client.ts#L437) |
## `src/retrieval/adapters/qdrant/dense-retriever.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `qdrantSearchFailure(error: unknown, callerAborted: boolean): unknown` | Implements the qdrant search failure operation. | function | internal | [line 56](../../src/retrieval/adapters/qdrant/dense-retriever.ts#L56) |
| `QdrantDenseRetriever` | Filtered HNSW whose IDs and immutable provenance are revalidated in SQLite. | class | exported | [line 89](../../src/retrieval/adapters/qdrant/dense-retriever.ts#L89) |
| `QdrantDenseRetriever.constructor(private readonly options: QdrantDenseRetrieverOptions)` | Creates a qdrant dense retriever instance. | method | public | [line 96](../../src/retrieval/adapters/qdrant/dense-retriever.ts#L96) |
| `QdrantDenseRetriever.hydrate(scopeId: string, hits: readonly QdrantSearchHit[], limit: number): Promise<DenseSearchHit[]>` | Implements the hydrate operation. | method | private | [line 117](../../src/retrieval/adapters/qdrant/dense-retriever.ts#L117) |
| `QdrantDenseRetriever.search(request: DenseSearchBatchRequest): Promise<DenseSearchHit[][]>` | Performs a search. | method | public | [line 167](../../src/retrieval/adapters/qdrant/dense-retriever.ts#L167) |
## `src/retrieval/adapters/qdrant/vector-synchronizer.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `boundedInteger(value: number, label: string, maximum: number): number` | Implements the bounded integer operation. | function | internal | [line 42](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L42) |
| `deterministicQdrantPointId(generationId: string, scopeId: string, memoryId: string, profileId: string): string` | Implements the deterministic qdrant point id operation. | function | exported | [line 49](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L49) |
| `pointFromClaim(claim: VectorSyncClaim): QdrantVectorPoint` | Implements the point from claim operation. | function | internal | [line 81](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L81) |
| `permanentFailure(error: unknown): boolean` | Implements the permanent failure operation. | function | internal | [line 101](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L101) |
| `qdrantCollectionIndexReady(info: Pick< QdrantCollectionInfo, \| "status" \| "optimizerStatus" \| "pointsCount" \| "indexedVectorsCount" \| "segmentsCount" >, dimensions: number, indexingThresholdKb: number): boolean` | Implements the qdrant collection index ready operation. | function | exported | [line 109](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L109) |
| `wait(delayMs: number, signal?: AbortSignal): Promise<void>` | Implements the wait operation. | function | internal | [line 129](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L129) |
| `QdrantVectorSynchronizer` | Publishes an immutable, resumable Qdrant generation from SQLite outbox rows. | class | exported | [line 147](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L147) |
| `QdrantVectorSynchronizer.constructor(private readonly options: QdrantVectorSynchronizerOptions)` | Creates a qdrant vector synchronizer instance. | method | public | [line 154](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L154) |
| `QdrantVectorSynchronizer.initialize(signal?: AbortSignal): Promise<VectorIndexGenerationStatus>` | Implements the initialize operation. | method | public | [line 166](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L166) |
| `QdrantVectorSynchronizer.worker(signal: AbortSignal \| undefined, shouldStop: () => boolean, onFailure: (error: unknown) => void): Promise<number>` | Implements the worker operation. | method | private | [line 185](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L185) |
| `QdrantVectorSynchronizer.synchronizeAvailable(signal?: AbortSignal): Promise<number>` | Implements the synchronize available operation. | method | public | [line 217](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L217) |
| `QdrantVectorSynchronizer.waitForIndex(signal?: AbortSignal): Promise<void>` | Implements the wait for index operation. | method | private | [line 237](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L237) |
| `QdrantVectorSynchronizer.verifyCounts(status: VectorIndexGenerationStatus, signal?: AbortSignal): Promise<number>` | Implements the verify counts operation. | method | private | [line 261](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L261) |
| `QdrantVectorSynchronizer.finalize(signal?: AbortSignal): Promise<VectorIndexGenerationStatus>` | Implements the finalize operation. | method | public | [line 289](../../src/retrieval/adapters/qdrant/vector-synchronizer.ts#L289) |
## `src/retrieval/adapters/sqlite/database-evidence-operators.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `sessionQueryPaths(seeds: readonly DatabaseOperatorSeed[]): Map<string, Set<string>>` | Implements the session query paths operation. | function | internal | [line 40](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L40) |
| `compareRecords(left: MemoryRecord, right: MemoryRecord): number` | Compares records. | function | internal | [line 67](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L67) |
| `operatorTokens(queries: readonly string[]): string[]` | Implements the operator tokens operation. | function | internal | [line 77](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L77) |
| `DatabaseEvidenceOperators` | Owns all deterministic, database-backed evidence indexing and expansion. | class | exported | [line 92](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L92) |
| `DatabaseEvidenceOperators.constructor(db: DatabaseSync)` | Creates a database evidence operators instance. | method | public | [line 96](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L96) |
| `DatabaseEvidenceOperators.ensureScope(scopeId: string): EvidenceFactIndexStatus` | Lazily materializes facts for one scope and is idempotent. | method | public | [line 102](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L102) |
| `DatabaseEvidenceOperators.expand(scopeId: string, request: SearchRequest, context: EvidenceOperatorSearchContext, seedHits: readonly DatabaseOperatorSeed[]): DatabaseOperatorHit[]` | Implements the expand operation. | method | public | [line 106](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L106) |
| `DatabaseEvidenceOperators.matchesRequestFilters(record: MemoryRecord, request: SearchRequest): boolean` | Implements the matches request filters operation. | method | private | [line 119](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L119) |
| `DatabaseEvidenceOperators.hit(record: MemoryRecord, query: string, matchedQueries: readonly string[], retriever: DatabaseOperatorHit["retriever"], rank: number): DatabaseOperatorHit` | Implements the hit operation. | method | private | [line 139](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L139) |
| `DatabaseEvidenceOperators.expandTimeline(scopeId: string, request: SearchRequest, context: EvidenceOperatorSearchContext, seedHits: readonly DatabaseOperatorSeed[]): DatabaseOperatorHit[]` | Implements the expand timeline operation. | method | private | [line 157](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L157) |
| `DatabaseEvidenceOperators.expandAggregate(scopeId: string, request: SearchRequest, context: EvidenceOperatorSearchContext, seedHits: readonly DatabaseOperatorSeed[]): DatabaseOperatorHit[]` | Implements the expand aggregate operation. | method | private | [line 276](../../src/retrieval/adapters/sqlite/database-evidence-operators.ts#L276) |
## `src/retrieval/adapters/sqlite/evidence-fact-index.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `EvidenceFactIndex` | Versioned, deterministic sidecar index for immutable raw memories. | class | exported | [line 23](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L23) |
| `EvidenceFactIndex.constructor(db: DatabaseSync)` | Creates a evidence fact index instance. | method | public | [line 26](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L26) |
| `EvidenceFactIndex.ensureScope(scopeId: string): EvidenceFactIndexStatus` | Implements the ensure scope operation. | method | public | [line 31](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L31) |
| `EvidenceFactIndex.initializeSchema(): void` | Implements the initialize schema operation. | method | private | [line 38](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L38) |
| `EvidenceFactIndex.assertContentHashes(scopeId: string): void` | Validates content hashes and throws when invalid. | method | private | [line 83](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L83) |
| `EvidenceFactIndex.listUnindexedRows(scopeId: string): MemoryRow[]` | Implements the list unindexed rows operation. | method | private | [line 97](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L97) |
| `EvidenceFactIndex.indexRows(rows: readonly MemoryRow[]): void` | Indexes rows. | method | private | [line 111](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L111) |
| `EvidenceFactIndex.indexRecord(row: MemoryRow, insertNumeric: ReturnType<DatabaseSync["prepare"]>, insertTemporal: ReturnType<DatabaseSync["prepare"]>, markIndexed: ReturnType<DatabaseSync["prepare"]>): void` | Indexes record. | method | private | [line 140](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L140) |
| `EvidenceFactIndex.status(scopeId: string): EvidenceFactIndexStatus` | Implements the status operation. | method | private | [line 200](../../src/retrieval/adapters/sqlite/evidence-fact-index.ts#L200) |
## `src/retrieval/adapters/sqlite/exact-dense-retriever.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number` | Implements the cosine similarity operation. | function | internal | [line 8](../../src/retrieval/adapters/sqlite/exact-dense-retriever.ts#L8) |
| `SqliteExactDenseRetriever` | Exact SQLite implementation retained as the regression oracle. | class | exported | [line 33](../../src/retrieval/adapters/sqlite/exact-dense-retriever.ts#L33) |
| `SqliteExactDenseRetriever.constructor(private readonly store: EmbeddingIndexStore)` | Creates a sqlite exact dense retriever instance. | method | public | [line 36](../../src/retrieval/adapters/sqlite/exact-dense-retriever.ts#L36) |
| `SqliteExactDenseRetriever.search(request: DenseSearchBatchRequest): Promise<DenseSearchHit[][]>` | Performs a search. | method | public | [line 38](../../src/retrieval/adapters/sqlite/exact-dense-retriever.ts#L38) |
## `src/retrieval/adapters/sqlite/lexical-retriever.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `quoteFtsToken(token: string): string` | Implements the quote fts token operation. | function | internal | [line 23](../../src/retrieval/adapters/sqlite/lexical-retriever.ts#L23) |
| `rawFtsTokens(text: string): string[]` | Implements the raw fts tokens operation. | function | internal | [line 27](../../src/retrieval/adapters/sqlite/lexical-retriever.ts#L27) |
| `ftsQueryPlans(text: string): FtsQueryPlan[]` | Builds strict-to-broad FTS plans from query text alone. | function | internal | [line 37](../../src/retrieval/adapters/sqlite/lexical-retriever.ts#L37) |
| `SqliteLexicalRetriever` | SQLite FTS adapter; query planning and ranking stay inside retrieval. | class | exported | [line 70](../../src/retrieval/adapters/sqlite/lexical-retriever.ts#L70) |
| `SqliteLexicalRetriever.constructor(private readonly db: DatabaseSync)` | Creates a sqlite lexical retriever instance. | method | public | [line 71](../../src/retrieval/adapters/sqlite/lexical-retriever.ts#L71) |
| `SqliteLexicalRetriever.search(scopeId: string, request: SearchRequest): RetrievalHit[]` | Performs a search. | method | public | [line 73](../../src/retrieval/adapters/sqlite/lexical-retriever.ts#L73) |
## `src/retrieval/finalize-search-hits.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `finalizeSearchHits(relevanceOrderedHits: readonly T[], request: SearchRequest, limit: number): T[]` | Finalizes search hits. | function | exported | [line 5](../../src/retrieval/finalize-search-hits.ts#L5) |
| `selectSessionBreadth(relevanceOrderedHits: readonly T[], maxPerSession: number, limit: number): T[]` | Breadth-first admission only when the caller explicitly asks for a session cap. | function | internal | [line 28](../../src/retrieval/finalize-search-hits.ts#L28) |
## `src/retrieval/index-scope-embeddings.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `embeddingProfile(embedder: Embedder): EmbeddingProfile` | Implements the embedding profile operation. | function | exported | [line 15](../../src/retrieval/index-scope-embeddings.ts#L15) |
| `embeddingInput(role: string, content: string): string` | Implements the embedding input operation. | function | exported | [line 23](../../src/retrieval/index-scope-embeddings.ts#L23) |
| `indexScopeEmbeddings(store: EmbeddingIndexStore, scopeId: string, embedder: Embedder, signal?: AbortSignal): Promise<EmbeddingIndexResult>` | Indexes scope embeddings. | function | exported | [line 27](../../src/retrieval/index-scope-embeddings.ts#L27) |
## `src/retrieval/index.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/model/embedder.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/model/embedding.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/model/hit-provenance.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `unionBy(left: readonly T[] \| undefined, right: readonly T[] \| undefined, key: (value: T) => string): T[] \| undefined` | Implements the union by operation. | function | internal | [line 3](../../src/retrieval/model/hit-provenance.ts#L3) |
| `mergeHitProvenance(left: RetrievalHit, right: RetrievalHit): RetrievalHit` | Keep all source coordinates when different discovery routes meet. | function | exported | [line 10](../../src/retrieval/model/hit-provenance.ts#L10) |
## `src/retrieval/model/operator.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/model/passage.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `passageId(record: Pick<MemoryRecord, "memoryId" \| "contentHash">, start: number, end: number): string` | Implements the passage id operation. | function | internal | [line 28](../../src/retrieval/model/passage.ts#L28) |
| `splitLongSpan(content: string, span: Span): Span[]` | Implements the split long span operation. | function | internal | [line 42](../../src/retrieval/model/passage.ts#L42) |
| `sentenceSpans(content: string): Span[]` | Finds deterministic sentence/paragraph boundaries while preserving UTF-16 offsets into the exact source. | function | internal | [line 67](../../src/retrieval/model/passage.ts#L67) |
| `memoryPassages(record: MemoryRecord): MemoryPassage[]` | Builds a small, deterministic passage view without mutating parent memory. | function | exported | [line 84](../../src/retrieval/model/passage.ts#L84) |
| `normalizedSourceText(value: string): string` | Normalizes d source text. | function | internal | [line 121](../../src/retrieval/model/passage.ts#L121) |
| `sourceQuoteMatchScore(content: string, quote: string): number` | Larger means the exact passage is a better home for an operator quote. | function | exported | [line 126](../../src/retrieval/model/passage.ts#L126) |
| `passageScore(passage: MemoryPassage, query: string): number` | Implements the passage score operation. | function | internal | [line 145](../../src/retrieval/model/passage.ts#L145) |
| `sourceSpanMatchScore(passage: MemoryPassage, span: { start: number; end: number }): number` | Implements the source span match score operation. | function | internal | [line 167](../../src/retrieval/model/passage.ts#L167) |
| `rankMemoryPassages(record: MemoryRecord, queries: readonly string[], sourceQuotes: readonly string[] = [], sourceSpans: readonly { start: number; end: number }[] = []): MemoryPassage[]` | Implements the rank memory passages operation. | function | exported | [line 181](../../src/retrieval/model/passage.ts#L181) |
| `retrievalHitIdentity(hit: RetrievalHit): string` | Implements the retrieval hit identity operation. | function | exported | [line 219](../../src/retrieval/model/passage.ts#L219) |
| `projectSearchHitsToPassages(hits: readonly RetrievalHit[], limit: number, sourceQuotesByMemoryId: ReadonlyMap<string, readonly string[]> = new Map(), maxPerSession?: number): RetrievalHit[]` | Converts parent-level operator output into exact passage candidates. | function | exported | [line 228](../../src/retrieval/model/passage.ts#L228) |
| `assertPassageMatchesRecord(passage: MemoryPassage, record: MemoryRecord): void` | Validates passage matches record and throws when invalid. | function | exported | [line 318](../../src/retrieval/model/passage.ts#L318) |
## `src/retrieval/model/search.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `searchQueryFingerprint(query: string): string` | Shared identity for repeated queries and per-query coverage accounting. | function | exported | [line 185](../../src/retrieval/model/search.ts#L185) |
## `src/retrieval/model/source-time.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `calendarTimestamp(year: number, month: number, day: number): number \| undefined` | Calendar validation must not silently roll February 31 into March. | function | exported | [line 6](../../src/retrieval/model/source-time.ts#L6) |
| `parseSourceTimestamp(value: string \| undefined): number \| undefined` | ISO instants and legacy source dates; timestamps without a zone use UTC. | function | exported | [line 15](../../src/retrieval/model/source-time.ts#L15) |
| `sourceCalendarTimestamp(value: string \| undefined): number \| undefined` | Relative calendar expressions refer to the date written at the source. | function | exported | [line 38](../../src/retrieval/model/source-time.ts#L38) |
| `compareMemoryChronology(left: MemoryRecord, right: MemoryRecord, direction: 1 \| -1 = 1): number` | Missing/invalid timestamps remain last in both chronological directions. | function | exported | [line 45](../../src/retrieval/model/source-time.ts#L45) |
## `src/retrieval/operators/hybrid-search.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `metadataFilterKey(filter: RetrievalMetadataFilter): string` | Implements the metadata filter key operation. | function | internal | [line 40](../../src/retrieval/operators/hybrid-search.ts#L40) |
| `mergeMetadataFilters(...groups: Array<readonly RetrievalMetadataFilter[] \| undefined>): RetrievalMetadataFilter[] \| undefined` | Merges metadata filters. | function | internal | [line 49](../../src/retrieval/operators/hybrid-search.ts#L49) |
| `reserveMetadataRoutes(rankings: readonly (readonly T[])[]): T[]` | Implements the reserve metadata routes operation. | function | internal | [line 59](../../src/retrieval/operators/hybrid-search.ts#L59) |
| `compareFinal(left: RankedHybridHit, right: RankedHybridHit): number` | Compares final. | function | internal | [line 80](../../src/retrieval/operators/hybrid-search.ts#L80) |
| `HybridRetriever` | Implements hybrid retriever. | class | exported | [line 90](../../src/retrieval/operators/hybrid-search.ts#L90) |
| `HybridRetriever.constructor(rawStore: HybridSearchStore, embedder: Embedder, denseRetriever: DenseRetriever)` | Creates a hybrid retriever instance. | method | public | [line 98](../../src/retrieval/operators/hybrid-search.ts#L98) |
| `HybridRetriever.getRetrievalMetadata(): RetrievalMetadata` | Returns retrieval metadata. | method | public | [line 108](../../src/retrieval/operators/hybrid-search.ts#L108) |
| `HybridRetriever.snapshotRetrievalMetrics(): RetrievalMetricsSnapshot` | Implements the snapshot retrieval metrics operation. | method | public | [line 126](../../src/retrieval/operators/hybrid-search.ts#L126) |
| `HybridRetriever.search(scopeId: string, request: SearchRequest, signal?: AbortSignal): Promise<RetrievalHit[]>` | Performs a search. | method | public | [line 137](../../src/retrieval/operators/hybrid-search.ts#L137) |
| `HybridRetriever.searchLexical(scopeId: string, request: SearchRequest): RetrievalHit[]` | Searches lexical. | method | public | [line 420](../../src/retrieval/operators/hybrid-search.ts#L420) |
| `HybridRetriever.expandEvidenceOperator(scopeId: string, request: SearchRequest, context: EvidenceOperatorSearchContext, seedHits: readonly RetrievalHit[]): RetrievalHit[]` | Implements the expand evidence operator operation. | method | public | [line 427](../../src/retrieval/operators/hybrid-search.ts#L427) |
| `HybridRetriever.read(scopeId: string, memoryIds: string[], contextBefore = 0, contextAfter = 0): MemoryRecord[]` | Reads the requested value. | method | public | [line 441](../../src/retrieval/operators/hybrid-search.ts#L441) |
| `HybridRetriever.getRecords(scopeId: string, memoryIds: string[]): MemoryRecord[]` | Returns records. | method | public | [line 455](../../src/retrieval/operators/hybrid-search.ts#L455) |
| `HybridRetriever.findMentionedMemoryIds(scopeId: string, text: string): string[]` | Implements the find mentioned memory ids operation. | method | public | [line 459](../../src/retrieval/operators/hybrid-search.ts#L459) |
## `src/retrieval/operators/numeric-operator.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `numericValue(raw: string): number \| undefined` | Implements the numeric value operation. | function | internal | [line 30](../../src/retrieval/operators/numeric-operator.ts#L30) |
| `extractNumericMentions(content: string): Omit<NumericFact, "valueKind">[]` | Implements the extract numeric mentions operation. | function | internal | [line 35](../../src/retrieval/operators/numeric-operator.ts#L35) |
| `classifyValue(content: string, mention: Omit<NumericFact, "valueKind">): NumericValueKind` | Implements the classify value operation. | function | internal | [line 109](../../src/retrieval/operators/numeric-operator.ts#L109) |
| `extractNumericFacts(content: string): NumericFact[]` | Implements the extract numeric facts operation. | function | exported | [line 132](../../src/retrieval/operators/numeric-operator.ts#L132) |
| `rowKey(hit: RetrievalHit, mention: NumericFact): string` | Implements the row key operation. | function | internal | [line 139](../../src/retrieval/operators/numeric-operator.ts#L139) |
| `buildAggregateOperatorResult(hits: readonly RetrievalHit[]): EvidenceOperatorResult` | Builds aggregate operator result. | function | exported | [line 143](../../src/retrieval/operators/numeric-operator.ts#L143) |
## `src/retrieval/operators/temporal-operator.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `isoDate(timestamp: number): string` | Checks whether o date. | function | internal | [line 68](../../src/retrieval/operators/temporal-operator.ts#L68) |
| `startOfDay(timestamp: number): number` | Implements the start of day operation. | function | internal | [line 72](../../src/retrieval/operators/temporal-operator.ts#L72) |
| `addCalendarUnits(timestamp: number, amount: number, unit: "day" \| "week" \| "month" \| "year"): number` | Implements the add calendar units operation. | function | internal | [line 77](../../src/retrieval/operators/temporal-operator.ts#L77) |
| `cleanQuestion(question: string): string` | Implements the clean question operation. | function | internal | [line 97](../../src/retrieval/operators/temporal-operator.ts#L97) |
| `parseAmount(value: string): number \| undefined` | Parses amount. | function | internal | [line 107](../../src/retrieval/operators/temporal-operator.ts#L107) |
| `resolveTemporalQuestion(question: string, questionDate?: string): TemporalQuestionPlan` | Resolves temporal question. | function | exported | [line 115](../../src/retrieval/operators/temporal-operator.ts#L115) |
| `relativeDate(timestamp: number, amount: number, unit: "day" \| "week" \| "month" \| "year"): string \| undefined` | Implements the relative date operation. | function | internal | [line 134](../../src/retrieval/operators/temporal-operator.ts#L134) |
| `temporalAuxiliaryRequest(request: SearchRequest, plan: TemporalQuestionPlan): SearchRequest \| undefined` | Implements the temporal auxiliary request operation. | function | exported | [line 140](../../src/retrieval/operators/temporal-operator.ts#L140) |
| `extractTemporalFacts(content: string, sourceTimestamp?: string): TemporalFact[]` | Extracts deterministic event-date facts from one immutable memory turn. | function | exported | [line 166](../../src/retrieval/operators/temporal-operator.ts#L166) |
| `buildTimelineOperatorResult(hits: readonly RetrievalHit[], question: string, questionDate?: string, auxiliaryRequest?: SearchRequest): EvidenceOperatorResult` | Builds timeline operator result. | function | exported | [line 266](../../src/retrieval/operators/temporal-operator.ts#L266) |
## `src/retrieval/ports/dense-retriever.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `DenseRetrievalError` | Typed failure boundary used by resilience policies around dense retrieval. | class | exported | [line 15](../../src/retrieval/ports/dense-retriever.ts#L15) |
| `DenseRetrievalError.constructor(readonly kind: DenseRetrievalFailureKind, message: string, options?: ErrorOptions)` | Creates a dense retrieval error instance. | method | public | [line 16](../../src/retrieval/ports/dense-retriever.ts#L16) |
## `src/retrieval/ports/hybrid-search-store.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/ports/memory-tool-store.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/ports/operator-catalog.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/ports/search-operator-plugin.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/ports/search-operator.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/ports/vector-index-state-store.ts`

_No top-level functions, classes, or class methods._
## `src/retrieval/ranking.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `tokenizeForPicorerHybrid(text: string): string[]` | Tokenizes candidate text for Picorer hybrid BM25 after \W+ cleanup. | function | exported | [line 39](../../src/retrieval/ranking.ts#L39) |
| `bm25Scores(query: string, documents: readonly string[], options: Readonly<Bm25Options> = PICORER_HYBRID_BM25_OPTIONS): number[]` | Implements the bm25 scores operation. | function | exported | [line 49](../../src/retrieval/ranking.ts#L49) |
| `reciprocalRankFusion(rankings: readonly (readonly number[])[], k = 60, documentCount?: number): number[]` | Returns one RRF score per zero-based document index. | function | exported | [line 113](../../src/retrieval/ranking.ts#L113) |
## `src/retrieval/retrieval-profile.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `parseRetrievalProfile(value: string \| undefined): RetrievalProfile` | Parses retrieval profile. | function | exported | [line 5](../../src/retrieval/retrieval-profile.ts#L5) |
## `src/retrieval/search-explicit-date-routes.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `searchExplicitDateRoutes(dense: DenseRetriever, base: DenseSearchBatchRequest, queries: readonly string[]): Map<number, DateRoute>` | Batch equal calendar windows without merging query votes or provenance. | function | exported | [line 11](../../src/retrieval/search-explicit-date-routes.ts#L11) |
## `src/retrieval/structured-query-constraints.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `normalizedCalendarDate(yearText: string, monthText: string, dayText: string): string \| undefined` | Normalizes d calendar date. | function | internal | [line 6](../../src/retrieval/structured-query-constraints.ts#L6) |
| `explicitQueryDateFilter(query: string): RetrievalMetadataFilter \| undefined` | Extracts one unambiguous, calendar-valid date already written in an Agent query. | function | exported | [line 27](../../src/retrieval/structured-query-constraints.ts#L27) |
## `src/retrieval/temporal-annotation.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `durationParts(milliseconds: number): string` | Implements the duration parts operation. | function | internal | [line 4](../../src/retrieval/temporal-annotation.ts#L4) |
| `temporalAnnotation(memoryTimestamp: string \| undefined, questionDate: string \| undefined): string \| undefined` | Implements the temporal annotation operation. | function | exported | [line 18](../../src/retrieval/temporal-annotation.ts#L18) |
## `src/retrieval/use-cases/candidate-set.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `withRanks(hits: readonly RetrievalHit[], limit: number): RetrievalHit[]` | Implements the with ranks operation. | function | exported | [line 10](../../src/retrieval/use-cases/candidate-set.ts#L10) |
| `unionCandidateSets(sets: readonly (readonly RetrievalHit[])[], limit: number): RetrievalHit[]` | Implements the union candidate sets operation. | function | exported | [line 17](../../src/retrieval/use-cases/candidate-set.ts#L17) |
| `rrfCandidateSets(sets: readonly (readonly RetrievalHit[])[], limit: number): RetrievalHit[]` | Implements the rrf candidate sets operation. | function | exported | [line 42](../../src/retrieval/use-cases/candidate-set.ts#L42) |
| `intersectCandidateSets(sets: readonly (readonly RetrievalHit[])[], limit: number): RetrievalHit[]` | Implements the intersect candidate sets operation. | function | exported | [line 75](../../src/retrieval/use-cases/candidate-set.ts#L75) |
| `sortCandidateSet(hits: readonly RetrievalHit[], order: "relevance" \| "chronological" \| "reverse-chronological"): RetrievalHit[]` | Implements the sort candidate set operation. | function | exported | [line 103](../../src/retrieval/use-cases/candidate-set.ts#L103) |
| `diversifyBySession(hits: readonly RetrievalHit[], maxPerGroup: number): RetrievalHit[]` | Implements the diversify by session operation. | function | exported | [line 116](../../src/retrieval/use-cases/candidate-set.ts#L116) |
| `dedupeByContent(hits: readonly RetrievalHit[]): RetrievalHit[]` | Implements the dedupe by content operation. | function | exported | [line 140](../../src/retrieval/use-cases/candidate-set.ts#L140) |
| `annotateCandidateSet(method: "temporal" \| "numeric", hits: readonly RetrievalHit[], question: string, questionDate: string \| undefined): EvidenceOperatorResult` | Implements the annotate candidate set operation. | function | exported | [line 154](../../src/retrieval/use-cases/candidate-set.ts#L154) |
| `retainOperatorResult(result: EvidenceOperatorResult \| undefined, hits: readonly RetrievalHit[]): { operatorResult?: EvidenceOperatorResult }` | Unary transformations retain only annotations whose sources survive. | function | exported | [line 167](../../src/retrieval/use-cases/candidate-set.ts#L167) |
## `src/retrieval/use-cases/compose-operator.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `requestFor(input: SearchOperatorInput): SearchRequest` | Implements the request for operation. | function | internal | [line 10](../../src/retrieval/use-cases/compose-operator.ts#L10) |
| `buildDeclarativeSearchOperator(catalog: SearchOperatorCatalog, source: SearchOperatorDefinition, definitionRevision: number): BuiltDeclarativeSearchOperator` | Validates a bounded operator graph and builds a candidate-only executable operator. | function | exported | [line 28](../../src/retrieval/use-cases/compose-operator.ts#L28) |
## `src/retrieval/use-cases/execute-operator.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `executeSearchOperator(registry: SearchOperatorCatalog, operatorId: string, context: SearchOperatorExecutionContext, input: SearchOperatorInput): Promise<ExecutedSearchOperator>` | Runs a registered operator and rejects candidate hits from another scope. | function | exported | [line 16](../../src/retrieval/use-cases/execute-operator.ts#L16) |
## `src/retrieval/use-cases/operator-definition.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `normalizedText(value: string, label: string, maxLength = 240): string` | Normalizes d text. | function | internal | [line 16](../../src/retrieval/use-cases/operator-definition.ts#L16) |
| `normalizedIdentifier(value: string, label: string): string` | Normalizes d identifier. | function | internal | [line 25](../../src/retrieval/use-cases/operator-definition.ts#L25) |
| `normalizedLimit(value: number \| undefined, label: string, required = false): number \| undefined` | Normalizes d limit. | function | internal | [line 35](../../src/retrieval/use-cases/operator-definition.ts#L35) |
| `normalizeDefinition(catalog: SearchOperatorCatalog, source: SearchOperatorDefinition): NormalizedDefinition` | Normalizes definition. | function | exported | [line 47](../../src/retrieval/use-cases/operator-definition.ts#L47) |
## `src/retrieval/use-cases/operator-discovery.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `intersectRoles(left: SearchOperatorInput["roles"], right: SearchOperatorInput["roles"]): SearchOperatorInput["roles"]` | Implements the intersect roles operation. | function | exported | [line 8](../../src/retrieval/use-cases/operator-discovery.ts#L8) |
| `discoveryPolicies(steps: readonly SearchOperatorDefinitionStep[], output: string): Map<string, DiscoveryPolicy>` | Push constraints only when every consumer of a shared source permits them. | function | exported | [line 18](../../src/retrieval/use-cases/operator-discovery.ts#L18) |
## `src/retrieval/use-cases/operator-registry.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `normalizedText(value: string, label: string): string` | Normalizes d text. | function | internal | [line 18](../../src/retrieval/use-cases/operator-registry.ts#L18) |
| `catalogEntry(operator: SearchOperator): SearchOperatorCatalogEntry` | Implements the catalog entry operation. | function | internal | [line 24](../../src/retrieval/use-cases/operator-registry.ts#L24) |
| `SearchOperatorRegistry` | Implements search operator registry. | class | exported | [line 39](../../src/retrieval/use-cases/operator-registry.ts#L39) |
| `SearchOperatorRegistry.constructor(defaultOperatorId = "hybrid")` | Creates a search operator registry instance. | method | public | [line 45](../../src/retrieval/use-cases/operator-registry.ts#L45) |
| `SearchOperatorRegistry.register(operator: SearchOperator): this` | Validates and registers one uniquely named search operator before freeze. | method | public | [line 52](../../src/retrieval/use-cases/operator-registry.ts#L52) |
| `SearchOperatorRegistry.freeze(): this` | Seals the catalog after verifying its default operator exists. | method | public | [line 74](../../src/retrieval/use-cases/operator-registry.ts#L74) |
| `SearchOperatorRegistry.get(operatorId: string): SearchOperator` | Resolves an allowlisted operator or reports the available catalog. | method | public | [line 84](../../src/retrieval/use-cases/operator-registry.ts#L84) |
| `SearchOperatorRegistry.list(): SearchOperatorCatalogEntry[]` | Returns a detached runtime catalog for schemas, prompts, and manifests. | method | public | [line 96](../../src/retrieval/use-cases/operator-registry.ts#L96) |
| `SearchOperatorRegistry.forkForRun(maxDefinitions = 2): RuntimeSearchOperatorCatalog` | Creates an isolated mutable overlay over the frozen base catalog. | method | public | [line 101](../../src/retrieval/use-cases/operator-registry.ts#L101) |
| `SearchOperatorRegistry.assertFrozen(): void` | Validates frozen and throws when invalid. | method | private | [line 106](../../src/retrieval/use-cases/operator-registry.ts#L106) |
| `RunSearchOperatorCatalog` | Implements run search operator catalog. | class | internal | [line 113](../../src/retrieval/use-cases/operator-registry.ts#L113) |
| `RunSearchOperatorCatalog.constructor(private readonly base: SearchOperatorRegistry, private readonly maxDefinitions: number)` | Creates a run search operator catalog instance. | method | public | [line 124](../../src/retrieval/use-cases/operator-registry.ts#L124) |
| `RunSearchOperatorCatalog.get(operatorId: string): SearchOperator` | Implements the get operation. | method | public | [line 140](../../src/retrieval/use-cases/operator-registry.ts#L140) |
| `RunSearchOperatorCatalog.list(): SearchOperatorCatalogEntry[]` | Implements the list operation. | method | public | [line 146](../../src/retrieval/use-cases/operator-registry.ts#L146) |
| `RunSearchOperatorCatalog.define(source: SearchOperatorDefinition): DefinedSearchOperator` | Validates and registers one declarative operator only within the current run. | method | public | [line 155](../../src/retrieval/use-cases/operator-registry.ts#L155) |
| `RunSearchOperatorCatalog.identity(): SearchOperatorCatalogIdentity` | Hashes the frozen base catalog and ordered run-local definitions. | method | public | [line 182](../../src/retrieval/use-cases/operator-registry.ts#L182) |
| `RunSearchOperatorCatalog.snapshots(): SearchOperatorDefinitionSnapshot[]` | Returns detached normalized definitions for audit and later promotion. | method | public | [line 196](../../src/retrieval/use-cases/operator-registry.ts#L196) |
| `RunSearchOperatorCatalog.remainingDefinitions(): number` | Reports the remaining bounded definition capacity for the current run. | method | public | [line 204](../../src/retrieval/use-cases/operator-registry.ts#L204) |
| `renderSearchOperatorCatalog(entries: readonly SearchOperatorCatalogEntry[]): string` | Renders operator capabilities into the catalog shown to the agent. | function | exported | [line 209](../../src/retrieval/use-cases/operator-registry.ts#L209) |
## `src/retrieval/use-cases/search.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `normalizeStrings(values: readonly string[], label: string): string[]` | Validates, trims, and deduplicates a list of search values. | function | internal | [line 67](../../src/retrieval/use-cases/search.ts#L67) |
| `operatorSourceQuotes(result: EvidenceOperatorResult \| undefined): Map<string, string[]>` | Implements the operator source quotes operation. | function | internal | [line 77](../../src/retrieval/use-cases/search.ts#L77) |
| `inlineSearchDefinition(params: SearchMemoryParams, primaryOperator: string): SearchOperatorDefinition \| undefined` | Implements the inline search definition operation. | function | internal | [line 89](../../src/retrieval/use-cases/search.ts#L89) |
| `assertHitsStayInScope(operator: string, scopeId: string, hits: readonly RetrievalHit[]): void` | Validates hits stay in scope and throws when invalid. | function | internal | [line 166](../../src/retrieval/use-cases/search.ts#L166) |
| `createSearchMemory(options: SearchMemoryOptions): ( params: SearchMemoryParams, signal?: AbortSignal, ) => Promise<SearchMemoryResult>` | Creates the search orchestrator for normalization, routing, coverage, expansion, and hit merging. | function | exported | [line 180](../../src/retrieval/use-cases/search.ts#L180) |
## `src/tau-knowledge-bridge.ts`

_No top-level functions, classes, or class methods._
## `src/util.ts`

| Symbol | Purpose | Kind | Visibility | Source |
|---|---|---|---|---|
| `sha256(value: string): string` | Implements the sha256 operation. | function | exported | [line 3](../../src/util.ts#L3) |
| `responseModelMatchesRequested(requested: string, actual: string): boolean` | Implements the response model matches requested operation. | function | exported | [line 7](../../src/util.ts#L7) |
| `stableMemoryId(scopeId: string, sessionId: string, turnIndex: number, sourceId?: string): string` | Implements the stable memory id operation. | function | exported | [line 28](../../src/util.ts#L28) |
| `compactPreview(text: string, maxLength = 280): string` | Implements the compact preview operation. | function | exported | [line 39](../../src/util.ts#L39) |
| `episodicPreview(text: string, maxLength = 360): string` | Keeps both setup and the sentence-final episodic fact in search previews. | function | exported | [line 47](../../src/util.ts#L47) |
| `previewQueryTermWeights(query: string): Map<string, number>` | Implements the preview query term weights operation. | function | internal | [line 57](../../src/util.ts#L57) |
| `sentenceStart(text: string, index: number): number` | Implements the sentence start operation. | function | internal | [line 74](../../src/util.ts#L74) |
| `sentenceEnd(text: string, index: number): number` | Implements the sentence end operation. | function | internal | [line 83](../../src/util.ts#L83) |
| `centeredPreviewSpan(compact: string, center: number, maxLength: number): PreviewSpan` | Implements the centered preview span operation. | function | internal | [line 98](../../src/util.ts#L98) |
| `renderPreviewSpan(compact: string, span: PreviewSpan): string` | Renders preview span. | function | internal | [line 128](../../src/util.ts#L128) |
| `queryCenteredEpisodicPreview(text: string, query: string, maxLength = 360): string` | Centers a bounded preview on the strongest cluster of query terms. | function | exported | [line 138](../../src/util.ts#L138) |
| `safePathSegment(value: string): string` | Implements the safe path segment operation. | function | exported | [line 187](../../src/util.ts#L187) |
| `newRunId(): string` | Implements the new run id operation. | function | exported | [line 196](../../src/util.ts#L196) |
| `assertNonEmpty(value: string, label: string): string` | Validates non empty and throws when invalid. | function | exported | [line 200](../../src/util.ts#L200) |
