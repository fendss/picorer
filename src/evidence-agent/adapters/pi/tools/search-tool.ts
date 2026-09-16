import {
  createSearchMemory,
  searchQueryFingerprint,
  renderSearchOperatorCatalog,
  retrievalHitIdentity,
  type EvidenceOperatorResult,
  type RetrievalHit,
  type SearchCoverageProgress,
  type SearchMemoryResult,
  type SearchOperatorCompositionTrace,
} from "../../../../retrieval/index.js";
import type { MemoryCandidate } from "../../../model/evidence.js";
import type { MemoryLedger } from "../../../model/ledger.js";
import type { CreatePicorerToolsOptions, PicorerTools, SearchToolDetails } from "./contracts.js";
import { renderCandidates, renderEvidenceOperator } from "./render-tool-result.js";
import {
  CompactSearchMoreParameters,
  createSearchParameters,
  SearchMoreParameters,
} from "./schemas.js";
import { candidateToolDetails } from "./candidate-details.js";
import { candidatePreview } from "../../../model/source-preview-spans.js";

function renderPlanTrace(trace: SearchOperatorCompositionTrace | undefined): string | undefined {
  if (trace === undefined) return undefined;
  return trace.steps.map((step) => {
    const operation = step.kind === "search"
      ? `Search ${String(step.operator)} for ${step.queries?.map((query) => JSON.stringify(query)).join(" | ") ?? "the current query"}` +
        `${step.roles === undefined ? "" : ` from ${step.roles.join("/")} sources`}` +
        `${step.maxPerSession === undefined ? "" : `, at most ${String(step.maxPerSession)} candidate(s) per session`}`
      : step.kind === "combine"
        ? `Fuse with ${String(step.method)}`
        : step.kind === "filter"
          ? `Keep ${step.roles?.join("/") ?? "selected"} sources`
          : step.kind === "sort"
            ? `Order ${String(step.order)}`
            : step.kind === "diversify"
              ? `Diversify across sessions, at most ${String(step.maxPerGroup)} each`
              : step.kind === "dedupe"
                ? "Remove duplicate content"
                : step.kind === "limit"
                  ? `Keep top ${String(step.limit)}`
                  : `Annotate ${String(step.annotation)}`;
    return `- ${operation} → ${String(step.candidateCount)} candidates`;
  }).join("\n");
}

function hitQueryFingerprints(hit: RetrievalHit): Set<string> {
  return new Set((hit.matchedQueries ?? [hit.query]).map(searchQueryFingerprint));
}

function coverageProgress(input: {
  call: number;
  hits: readonly RetrievalHit[];
  executedQueries: readonly string[];
  repeatedQueries: readonly string[];
  previousCandidates: readonly MemoryCandidate[];
  requestedLimit: number;
  consecutiveNoNewCandidateCalls: number;
  consecutiveNoNewSessionCalls: number;
}): SearchCoverageProgress {
  const uniqueHits = [...new Map(input.hits.map((hit) => [
    retrievalHitIdentity(hit),
    hit,
  ])).values()];
  const previousCandidateIds = new Set(
    input.previousCandidates.map((candidate) => candidate.candidateId),
  );
  const previousSessionIds = new Set(
    input.previousCandidates.map((candidate) => candidate.sessionId),
  );
  const returnedSessionIds = new Set(
    uniqueHits.map((hit) => hit.record.sessionId),
  );
  const newCandidateIds = new Set(
    uniqueHits
      .filter((hit) => !previousCandidateIds.has(retrievalHitIdentity(hit)))
      .map(retrievalHitIdentity),
  );
  const newSessionIds = new Set(
    [...returnedSessionIds].filter((sessionId) =>
      !previousSessionIds.has(sessionId)
    ),
  );
  const repeatedQueryValues = new Set(input.repeatedQueries);
  const queryMatches = new Map(
    uniqueHits.map((hit) => [retrievalHitIdentity(hit), hitQueryFingerprints(hit)]),
  );
  const queries = input.executedQueries.map((query) => {
    const fingerprint = searchQueryFingerprint(query);
    const matching = uniqueHits.filter((hit) =>
      queryMatches.get(retrievalHitIdentity(hit))!.has(fingerprint)
    );
    return {
      query,
      repeated: repeatedQueryValues.has(query),
      returnedCandidateCount: matching.length,
      returnedSessionCount: new Set(
        matching.map((hit) => hit.record.sessionId),
      ).size,
      newCandidateCount: matching.filter((hit) =>
        newCandidateIds.has(retrievalHitIdentity(hit))
      ).length,
      newSessionCount: new Set(
        matching
          .map((hit) => hit.record.sessionId)
          .filter((sessionId) => newSessionIds.has(sessionId)),
      ).size,
    };
  });
  const newCandidateCount = newCandidateIds.size;
  const newSessionCount = newSessionIds.size;
  return {
    call: input.call,
    status: newSessionCount > 0
      ? "new-sessions"
      : newCandidateCount > 0
        ? "known-session-depth"
        : "no-new-candidates",
    requestedLimit: input.requestedLimit,
    reachedRequestedLimit: uniqueHits.length >= input.requestedLimit,
    returnedCandidateCount: uniqueHits.length,
    returnedSessionCount: returnedSessionIds.size,
    newCandidateCount,
    repeatedCandidateCount: uniqueHits.length - newCandidateCount,
    newSessionCount,
    repeatedSessionCount: returnedSessionIds.size - newSessionCount,
    newQueryCount: queries.filter((query) => !query.repeated).length,
    repeatedQueryCount: queries.filter((query) => query.repeated).length,
    consecutiveNoNewCandidateCalls: input.consecutiveNoNewCandidateCalls,
    consecutiveNoNewSessionCalls: input.consecutiveNoNewSessionCalls,
    queries,
  };
}

function renderCoverageProgress(progress: SearchCoverageProgress): string {
  const frontier = progress.status === "new-sessions"
    ? `The frontier reached ${String(progress.newSessionCount)} new conversation(s).`
    : progress.status === "known-session-depth"
      ? "The frontier found new candidates only inside previously seen conversations."
      : `These query paths returned no new candidate ` +
        `(${String(progress.consecutiveNoNewCandidateCalls)} consecutive call(s)); ` +
        "this is local query saturation, not proof that all relevant memory was found.";
  const queryRows = progress.queries.map((query) =>
    `- ${JSON.stringify(query.query)}: ${String(query.returnedCandidateCount)} candidate(s) ` +
      `from ${String(query.returnedSessionCount)} conversation(s), ` +
      `${String(query.newCandidateCount)} candidate(s) new` +
      `${query.repeated ? "; query repeated" : ""}`
  );
  return [
    "Coverage frontier (bounded navigation results, not corpus completeness):",
    `- Returned ${String(progress.returnedCandidateCount)} candidate(s) from ` +
      `${String(progress.returnedSessionCount)} conversation(s); ` +
      `${String(progress.newCandidateCount)} candidate(s) and ` +
      `${String(progress.newSessionCount)} conversation(s) are new.`,
    `- ${frontier}`,
    ...(progress.reachedRequestedLimit
      ? [
          `- The result reached the requested limit of ${String(progress.requestedLimit)}; ` +
            "additional matches may exist.",
        ]
      : []),
    ...queryRows,
  ].join("\n");
}

const CONTINUATION_DEPTHS = [20, 40, 80] as const;
const CONTINUATION_PAGE_SIZE = 20;
const SEARCH_RESERVOIR_LIMIT = 80;

interface SearchContinuation {
  bufferedHits: RetrievalHit[];
  depth: number;
  maxDepth: number;
  nextDepth?: number;
  page: number;
  lastExecution: SearchMemoryResult;
}

function nextContinuationDepth(
  depth: number,
  maxDepth: number,
): number | undefined {
  const boundary = CONTINUATION_DEPTHS.find((candidate) =>
    candidate > depth && candidate <= maxDepth
  );
  if (boundary !== undefined) return boundary;
  return depth < maxDepth ? maxDepth : undefined;
}

function pageOperatorResult(
  result: EvidenceOperatorResult | undefined,
  hits: readonly RetrievalHit[],
  reservoirHits: readonly RetrievalHit[],
  ledger: MemoryLedger,
): EvidenceOperatorResult | undefined {
  if (result === undefined) return undefined;
  const pageIdentities = new Set(hits.map(retrievalHitIdentity));
  const reservoirIdentities = new Set(reservoirHits.map(retrievalHitIdentity));
  const fullReservoirVisible =
    pageIdentities.size === reservoirIdentities.size &&
    [...reservoirIdentities].every((identity) => pageIdentities.has(identity));
  const pageCandidateRefs = new Set(hits.flatMap((hit) => {
    const reference = ledger.candidateRef(retrievalHitIdentity(hit));
    return reference === undefined ? [] : [reference];
  }));
  // Use the same quote-to-C binding as the renderer. Parent-level candidates
  // may legitimately bind any row from that parent; passage rows are retained
  // only when the exact C ref selected by provenance is on this page.
  const rows = result.rows.filter((row) => {
    const reference = ledger.candidateRefForQuote(row.memoryId, row.quote);
    return reference !== undefined && pageCandidateRefs.has(reference);
  });
  const hidesOperatorEvidence =
    !fullReservoirVisible ||
    result.coverage.truncated ||
    rows.length < result.rows.length;
  const { derived: _fullResultDerived, ...pageSafeResult } = result;
  return {
    ...pageSafeResult,
    rows,
    ...(hidesOperatorEvidence || result.derived === undefined
      ? {}
      : { derived: result.derived }),
    coverage: {
      candidateCount: new Set(rows.map((row) => row.memoryId)).size,
      distinctSessions: new Set(rows.map((row) => row.sessionId)).size,
      truncated: hidesOperatorEvidence,
    },
  };
}

export function createSearchTools(
  options: CreatePicorerToolsOptions,
): Pick<PicorerTools, "search" | "searchMore"> {
  const compact = options.interfaceMode === "compact";
  let executedSearchCalls = 0;
  let executedRetrievalOperations = 0;
  let consecutiveNoNewCandidateCalls = 0;
  let consecutiveNoNewSessionCalls = 0;
  let latestPhysicalCoverageProgress: SearchCoverageProgress | undefined;
  let continuation: SearchContinuation | undefined;
  const searchMemory = createSearchMemory({
    operatorRegistry: options.operatorRegistry,
    scopeId: options.scopeId,
    // Compact search exposes source-bound passages whenever a parent has a
    // local lexical or operator signal. Semantic parent hits without such a
    // signal stay readable as parents instead of manufacturing a false span.
    passageProjection: compact,
    ...(options.question === undefined ? {} : { question: options.question }),
    ...(options.questionDate === undefined
      ? {}
      : { questionDate: options.questionDate }),
    ...(options.searchDefaults === undefined
      ? {}
      : { searchDefaults: options.searchDefaults }),
    candidateReservoirLimit: SEARCH_RESERVOIR_LIMIT,
  });
  const operatorCatalog = options.operatorRegistry.list();
  const catalogText = renderSearchOperatorCatalog(operatorCatalog);
  const commitPage = (
    execution: SearchMemoryResult,
    hits: readonly RetrievalHit[],
    input: {
      mode: "initial" | "continuation";
      page: number;
      depth: number;
      hasMore: boolean;
      visibleLimit: number;
      countsAgainstSearchBudget: boolean;
      directoryHits: readonly RetrievalHit[];
      physicalRetrievalExecuted: boolean;
    },
  ) => {
    const uniqueHits = [...new Map(hits.map((hit) => [
      retrievalHitIdentity(hit),
      hit,
    ])).values()];
    const pageIds = new Set(uniqueHits.map(retrievalHitIdentity));
    const uniqueDirectoryHits = [...new Map(input.directoryHits.map((hit) => [
      retrievalHitIdentity(hit),
      hit,
    ])).values()].filter((hit) => !pageIds.has(retrievalHitIdentity(hit)));
    const repeatedQueries = input.mode === "initial"
      ? execution.repeatedQueries
      : [];
    let progress: SearchCoverageProgress;
    if (input.physicalRetrievalExecuted) {
      executedRetrievalOperations += 1;
      const previousCandidates = options.ledger.candidates;
      const previousCandidateIds = new Set(
        previousCandidates.map((candidate) => candidate.candidateId),
      );
      const previousSessionIds = new Set(
        previousCandidates.map((candidate) => candidate.sessionId),
      );
      const retrievedHits = [...uniqueHits, ...uniqueDirectoryHits];
      const hasNewCandidate = retrievedHits.some((hit) =>
        !previousCandidateIds.has(retrievalHitIdentity(hit))
      );
      const hasNewSession = retrievedHits.some((hit) =>
        !previousSessionIds.has(hit.record.sessionId)
      );
      consecutiveNoNewCandidateCalls = hasNewCandidate
        ? 0
        : consecutiveNoNewCandidateCalls + 1;
      consecutiveNoNewSessionCalls = hasNewSession
        ? 0
        : consecutiveNoNewSessionCalls + 1;
      progress = coverageProgress({
        call: executedRetrievalOperations,
        hits: retrievedHits,
        executedQueries: execution.executedQueries,
        repeatedQueries,
        previousCandidates,
        requestedLimit: execution.reservoir?.limit ?? input.visibleLimit,
        consecutiveNoNewCandidateCalls,
        consecutiveNoNewSessionCalls,
      });
    } else {
      if (latestPhysicalCoverageProgress === undefined) {
        throw new Error("Continuation is missing its physical coverage snapshot");
      }
      // search_more is a view change over the immutable reservoir. Reusing the
      // original snapshot prevents presentation depth from masquerading as a
      // second retrieval frontier or incrementing no-new-candidate counters.
      progress = latestPhysicalCoverageProgress;
    }

    const step = input.physicalRetrievalExecuted
      ? options.ledger.nextStep()
      : undefined;
    const candidates = input.physicalRetrievalExecuted
      ? options.ledger.recordSearchHits(uniqueHits, step)
      : options.ledger.selectCandidates(uniqueHits.map(retrievalHitIdentity));
    const directoryCandidates = input.physicalRetrievalExecuted
      ? options.ledger.recordSearchHits(uniqueDirectoryHits, step)
      : options.ledger.selectCandidates(
          uniqueDirectoryHits.map(retrievalHitIdentity),
        );
    if (input.physicalRetrievalExecuted) latestPhysicalCoverageProgress = progress;
    const candidateReferences = candidates.map((candidate) => ({
      candidateRef: options.ledger.candidateRef(candidate.candidateId)!,
      memoryId: candidate.memoryId,
    }));
    const directoryCandidateReferences = directoryCandidates.map((candidate) => ({
      candidateRef: options.ledger.candidateRef(candidate.candidateId)!,
      candidateId: candidate.candidateId,
      memoryId: candidate.memoryId,
    }));
    const operatorResult = pageOperatorResult(
      execution.operatorResult,
      uniqueHits,
      execution.reservoir?.hits ?? execution.hits,
      options.ledger,
    );
    const pagination = {
      mode: input.mode,
      page: input.page,
      depth: input.depth,
      hasMore: input.hasMore,
      directoryCandidateCount: directoryCandidates.length,
      presentationOnly: !input.physicalRetrievalExecuted,
    } as const;
    const details: SearchToolDetails = {
      kind: "search",
      request: execution.request,
      executedQueries: execution.executedQueries,
      operator: execution.operator,
      operatorVersion: execution.operatorVersion,
      ...(operatorResult === undefined ? {} : { operatorResult }),
      ...(execution.composition === undefined
        ? {}
        : { composition: execution.composition }),
      candidateReferences,
      candidates: candidateToolDetails(candidates),
      ...(directoryCandidates.length === 0
        ? {}
        : {
            directoryCandidateReferences,
            directoryCandidates: candidateToolDetails(directoryCandidates),
          }),
      coverageProgress: progress,
      ...(repeatedQueries.length === 0 ? {} : { repeatedQueries }),
      ...(execution.reservoir === undefined
        ? {}
        : {
            physicalPlan: {
              candidateReservoirLimit: execution.reservoir.limit,
              candidateReservoirCount: execution.reservoir.hits.length,
              exhausted: execution.reservoir.exhausted,
            },
          }),
      pagination,
    };
    const rendered = [
      renderCoverageProgress(progress),
      renderEvidenceOperator(operatorResult, options.ledger),
      renderCandidates(candidates, options.ledger, options.questionDate),
    ].filter(Boolean).join("\n");
    const previewById = new Map(
      [...uniqueHits, ...uniqueDirectoryHits].map((hit) => [
        retrievalHitIdentity(hit),
        candidatePreview(hit),
      ]),
    );
    const latestFindings = candidates.map((candidate) => ({
      ...candidate,
      preview: previewById.get(candidate.candidateId) ?? candidate.preview,
    }));
    const directoryFindings = directoryCandidates.map((candidate) => ({
      ...candidate,
      preview: previewById.get(candidate.candidateId) ?? candidate.preview,
    }));
    const planTrace = renderPlanTrace(execution.composition);
    options.observation?.recordSearch({
      findingCount: candidates.length,
      findings: latestFindings,
      directoryFindings,
      coverageProgress: progress,
      countsAgainstSearchBudget: input.countsAgainstSearchBudget,
      pagination: {
        mode: input.mode,
        page: input.page,
        depth: input.depth,
        hasMore: input.hasMore,
        directoryCandidateCount: directoryCandidates.length,
        presentationOnly: !input.physicalRetrievalExecuted,
      },
      ...(planTrace === undefined ? {} : { planTrace }),
      ...(operatorResult === undefined
        ? {}
        : {
            operatorEvidence: renderEvidenceOperator(
              operatorResult,
              options.ledger,
            ),
          }),
    });
    return {
      content: [{
        type: "text" as const,
        text: options.observation?.render() ?? rendered,
      }],
      details,
    };
  };

  const search: PicorerTools["search"] = {
    name: "search",
    label: "Search memory",
    description: compact
      ? [
          "Search memory for the facts still missing. Start with queries and the default operator.",
          "When useful, select another catalog operator or compose independent branches in this same call, then combine, order, or diversify the results.",
          "The harness keeps the candidate view compact and manages source identity and limits. Read promising handles from the returned page.",
          catalogText,
        ].join("\n")
      : [
          "Search is simple by default: provide queries and optionally one operator. " +
          "For an inline retrieval program, add branches plus a combine method, then optionally order results or cap candidates per session. Search always spans the source roles available in the current scope; role labels are harness-owned metadata. " +
          "A common high-recall program is hybrid semantic queries plus one lexical branch, combined with union. " +
          "Use define_operator only when a named plan must be reused. The harness never accepts SQL. " +
          "Use returned opaque candidate handles such as C1 with read; search_more only expands the same physical result.",
          catalogText,
        ].join("\n"),
    parameters: createSearchParameters(
      operatorCatalog.map((entry) => entry.id),
    ) as PicorerTools["search"]["parameters"],
    async execute(_toolCallId, params, signal) {
      if (params.workingMemory !== undefined) {
        options.observation?.recordWorkingMemory(params.workingMemory);
      }
      if (
        options.maxSearchCalls !== undefined &&
        executedSearchCalls >= options.maxSearchCalls
      ) {
        throw new Error(
          `Search budget exhausted after ${String(options.maxSearchCalls)} calls. ` +
          "Use existing candidates, read only useful sources, and call finish.",
        );
      }
      const visibleLimit = Math.min(
        params.limit ?? options.searchDefaults?.limit ?? CONTINUATION_PAGE_SIZE,
        CONTINUATION_PAGE_SIZE,
      );
      executedSearchCalls += 1;
      let execution: SearchMemoryResult;
      try {
        // Project the model payload onto the public retrieval contract. This
        // remains safe even when a transport skips JSON-schema validation and
        // sends unknown fields such as the former source-role filter.
        execution = await searchMemory({
          queries: [...params.queries],
          ...(params.operator === undefined ? {} : { operator: params.operator }),
          ...(params.branches === undefined
            ? {}
            : {
                branches: params.branches.map((branch) => ({
                  operator: branch.operator,
                  queries: [...branch.queries],
                })),
              }),
          ...(params.combine === undefined ? {} : { combine: params.combine }),
          ...(params.order === undefined ? {} : { order: params.order }),
          ...(params.maxPerSession === undefined
            ? {}
            : { maxPerSession: params.maxPerSession }),
          limit: visibleLimit,
        }, signal);
      } catch (error) {
        // A failed physical search produced no navigation result and is absent
        // from observation/metrics. Roll back the reservation so every public
        // budget view describes the same successful semantic-call count.
        executedSearchCalls -= 1;
        throw error;
      }
      const pageHits = execution.hits.slice(0, CONTINUATION_PAGE_SIZE);
      const depth = Math.min(
        execution.request.limit ?? params.limit ?? CONTINUATION_PAGE_SIZE,
        CONTINUATION_PAGE_SIZE,
      );
      const exposedIds = new Set<string>(pageHits.map(retrievalHitIdentity));
      const reservoir = execution.reservoir ?? {
        hits: execution.hits,
        limit: execution.hits.length,
        exhausted: true,
      };
      const bufferedHits = [
        ...new Map(reservoir.hits.map((hit) => [
          retrievalHitIdentity(hit),
          hit,
        ])).values(),
      ].filter((hit) => !exposedIds.has(retrievalHitIdentity(hit)));
      const nextDepth = bufferedHits.length === 0
        ? undefined
        : nextContinuationDepth(depth, reservoir.limit);
      const result = commitPage(execution, pageHits, {
        mode: "initial",
        page: 1,
        depth,
        hasMore: nextDepth !== undefined,
        visibleLimit: depth,
        countsAgainstSearchBudget: true,
        directoryHits: bufferedHits,
        physicalRetrievalExecuted: true,
      });
      continuation = {
        bufferedHits,
        depth,
        maxDepth: reservoir.limit,
        ...(nextDepth === undefined ? {} : { nextDepth }),
        page: 1,
        lastExecution: execution,
      };
      return result;
    },
  };

  const searchMore: PicorerTools["searchMore"] = {
    name: "search_more",
    label: "Continue latest search",
    description: compact
      ? "Show the next page from the latest search without running a new retrieval."
      : "Expand the next compact directory page from the most recent search into " +
        "full passage findings. Every directory C ref is already directly readable. " +
        "This presentation-only action reuses the exact physical result and does " +
        "not run an operator or consume a semantic search call.",
    parameters: (compact
      ? CompactSearchMoreParameters
      : SearchMoreParameters) as PicorerTools["searchMore"]["parameters"],
    async execute(_toolCallId, params, _signal) {
      if (params.workingMemory !== undefined) {
        options.observation?.recordWorkingMemory(params.workingMemory);
      }
      if (continuation === undefined) {
        throw new Error(
          "No continuation page is available. Run a new search or use the " +
          "existing candidates.",
        );
      }
      if (continuation.bufferedHits.length === 0) {
        delete continuation.nextDepth;
        throw new Error(
          "No continuation page is available. Run a new search or use the " +
          "existing candidates.",
        );
      }
      const targetDepth = continuation.nextDepth ?? continuation.maxDepth;
      const pageCapacity = Math.max(
        1,
        Math.min(CONTINUATION_PAGE_SIZE, targetDepth - continuation.depth),
      );
      const pageHits = continuation.bufferedHits.splice(
        0,
        pageCapacity,
      );
      continuation.page += 1;
      continuation.depth = Math.min(
        continuation.maxDepth,
        continuation.depth + pageHits.length,
      );
      const nextDepth = continuation.bufferedHits.length === 0
        ? undefined
        : nextContinuationDepth(continuation.depth, continuation.maxDepth);
      if (nextDepth === undefined) delete continuation.nextDepth;
      else continuation.nextDepth = nextDepth;
      const hasMore = nextDepth !== undefined;
      return commitPage(continuation.lastExecution, pageHits, {
        mode: "continuation",
        page: continuation.page,
        depth: continuation.depth,
        hasMore,
        visibleLimit: CONTINUATION_PAGE_SIZE,
        countsAgainstSearchBudget: false,
        directoryHits: continuation.bufferedHits,
        physicalRetrievalExecuted: false,
      });
    },
  };

  return { search, searchMore };
}
