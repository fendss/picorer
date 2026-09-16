import {
  temporalAnnotation,
  type SearchCoverageProgress,
} from "../../../retrieval/index.js";
import type { MemoryCandidate } from "../../model/evidence.js";
import type { MemoryEvidence } from "../../model/source-evidence.js";
import type { MemoryLedger } from "../../model/ledger.js";
import {
  compactPreview,
  queryCenteredEpisodicPreview,
} from "../../../util.js";

export interface MemoryObservation {
  recordWorkingMemory(value: string): void;
  recordSearch(input: {
    findingCount: number;
    findings?: readonly MemoryCandidate[];
    /** Same-search reservoir entries shown only as compact, readable C refs. */
    directoryFindings?: readonly MemoryCandidate[];
    coverageProgress?: SearchCoverageProgress;
    operatorEvidence?: string;
    planTrace?: string;
    countsAgainstSearchBudget?: boolean;
    pagination?: {
      mode?: "initial" | "continuation";
      page: number;
      depth: number;
      hasMore: boolean;
      directoryCandidateCount?: number;
      presentationOnly?: boolean;
    };
  }): void;
  render(): string;
}

interface CreateMemoryObservationOptions {
  ledger: MemoryLedger;
  question?: string;
  questionDate?: string;
  maxSearchCalls?: number;
  compact?: boolean;
}

const MAX_ACTIVE_UNREAD_FINDINGS = 20;
const MAX_DIRECTORY_FINDINGS = 80;
const DIRECTORY_PREVIEW_BUDGET = 6_000;

function renderCoverageProgress(progress: SearchCoverageProgress): string[] {
  const noNewPaths = progress.queries
    .filter((query) => query.newCandidateCount === 0)
    .map((query) =>
      `${JSON.stringify(query.query)}${query.repeated ? " (repeated)" : ""}`
    );
  const status = progress.status === "new-sessions"
    ? `${String(progress.newSessionCount)} new conversation(s) reached.`
    : progress.status === "known-session-depth"
      ? "New candidates came only from conversations already seen."
      : `No new candidate on these query paths for ` +
        `${String(progress.consecutiveNoNewCandidateCalls)} consecutive call(s).`;
  return [
    "Latest retrieval frontier",
    `- ${String(progress.returnedCandidateCount)} candidates from ` +
      `${String(progress.returnedSessionCount)} conversations: ` +
      `${String(progress.newCandidateCount)} candidates and ` +
      `${String(progress.newSessionCount)} conversations new.`,
    `- ${status}`,
    ...(progress.reachedRequestedLimit
      ? [
          `- The bounded result filled its limit of ${String(progress.requestedLimit)}; ` +
            "additional matches may exist.",
        ]
      : []),
    ...(noNewPaths.length === 0
      ? []
      : [
          `- Query paths yielding no new candidates: ${noNewPaths.join(" | ")}.`,
        ]),
    "- This is local progress for the queries used, never proof that all " +
      "relevant memory has been found.",
  ];
}

function relativeTime(
  timestamp: string | undefined,
  questionDate: string | undefined,
): string {
  const annotation = temporalAnnotation(timestamp, questionDate);
  return annotation === undefined ? "" : ` (${annotation})`;
}

function roleLabel(role: string): string {
  return role.length === 0
    ? "Source"
    : `${role[0]!.toUpperCase()}${role.slice(1)}`;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function sourceLine(
  source: MemoryCandidate | MemoryEvidence,
  action: string,
  questionDate: string | undefined,
): string {
  const timestamp = source.timestamp === undefined
    ? ""
    : ` · ${source.timestamp}${relativeTime(source.timestamp, questionDate)}`;
  return `- ${roleLabel(source.role)}${timestamp} · ${action}`;
}

function conversationHeading(
  sources: readonly (MemoryCandidate | MemoryEvidence)[],
): string {
  const timestamp = sources.find((source) => source.timestamp !== undefined)
    ?.timestamp;
  return timestamp === undefined
    ? "From one conversation:"
    : `From the conversation around ${timestamp}:`;
}

/**
 * Preserve the supplied order: the current operator order for latest results,
 * and stable discovery order for older findings. A conversation heading is
 * repeated when results return to an earlier session instead of moving that
 * session's rows ahead of stronger candidates from other sessions.
 */
function renderInLedgerOrder<T extends MemoryCandidate | MemoryEvidence>(
  sources: readonly T[],
  renderSource: (source: T) => string,
): string[] {
  const rendered: string[] = [];
  let previousSessionId: string | undefined;
  for (const source of sources) {
    if (source.sessionId !== previousSessionId) {
      rendered.push(conversationHeading([source]));
      previousSessionId = source.sessionId;
    }
    rendered.push(renderSource(source));
  }
  return rendered;
}

function searchQueries(candidate: MemoryCandidate): string[] {
  return [...new Set(
    candidate.discoveries
      .filter((discovery) => discovery.tool === "search")
      .flatMap((discovery) => {
        const query = discovery.query?.trim();
        return query ? [query] : [];
      }),
  )].slice(-2);
}

function renderInspectReceipts(
  candidates: readonly MemoryCandidate[],
  ledger: MemoryLedger,
  questionDate: string | undefined,
): string[] {
  const seenMemoryIds = new Set<string>();
  const inspected = candidates.filter((candidate) => {
    if (!candidate.inspected || seenMemoryIds.has(candidate.memoryId)) return false;
    seenMemoryIds.add(candidate.memoryId);
    return true;
  });
  if (inspected.length === 0) return ["- Nothing inspected yet."];
  return renderInLedgerOrder(
    inspected,
    (candidate) => {
      return sourceLine(
        candidate,
        `evidence ${String(ledger.evidenceRef(candidate.memoryId) ?? "unavailable")}` +
          ` · inspected from ${String(ledger.candidateRef(candidate.candidateId) ?? "unavailable")}`,
        questionDate,
      );
    },
  );
}

function renderUnreadFindings(
  candidates: readonly MemoryCandidate[],
  ledger: MemoryLedger,
  questionDate: string | undefined,
  previewLength?: number,
): string[] {
  const unread = candidates.filter((candidate) => !candidate.inspected);
  if (unread.length === 0) return ["- Nothing waiting to be inspected."];
  return renderInLedgerOrder(
    unread,
    (candidate) => {
      // Search adapters already return a bounded, query-centered preview.
      // Do not head-truncate it a second time: that can remove the actual
      // matched phrase or answer-bearing entity near the tail. When the older
      // directory needs a smaller entry, center it again on its discovery
      // queries; semantic-only candidates naturally fall back to head + tail.
      const preview = previewLength === undefined
        ? candidate.passage?.content ?? compactPreview(candidate.preview, 360)
        : queryCenteredEpisodicPreview(
            candidate.passage?.content ?? candidate.preview,
            searchQueries(candidate).join(" "),
            previewLength,
          );
      return [
        sourceLine(
          candidate,
          `read ${String(ledger.candidateRef(candidate.candidateId) ?? "unavailable")}`,
          questionDate,
        ),
        indent(preview),
      ].join("\n");
    },
  );
}

function renderCompactDirectory(
  candidates: readonly MemoryCandidate[],
  ledger: MemoryLedger,
  questionDate: string | undefined,
  previewLength: number,
): string[] {
  const unread = candidates.filter((candidate) => !candidate.inspected);
  if (unread.length === 0) return ["- Nothing waiting to be inspected."];
  return unread.map((candidate) => {
    const timestamp = candidate.timestamp === undefined
      ? ""
      : ` · ${candidate.timestamp}${relativeTime(candidate.timestamp, questionDate)}`;
    const preview = queryCenteredEpisodicPreview(
      candidate.passage?.content ?? candidate.preview,
      searchQueries(candidate).join(" "),
      previewLength,
    ).replace(/\s+/gu, " ").trim();
    return [
      `- read ${String(ledger.candidateRef(candidate.candidateId) ?? "unavailable")} ` +
        `· ${roleLabel(candidate.role)}${timestamp}`,
      `  ${preview}`,
    ].join("\n");
  });
}

/**
 * Maintains one model-facing memory snapshot for a run.
 *
 * The ledger remains the structured source of truth. This view deliberately
 * exposes only state useful for reasoning or taking the next legal action.
 * Exact inspect payloads are emitted once and remain in the private ledger.
 * Snapshots never replay raw inspected content: they retain model-authored
 * working state, short E-handle receipts, actionable candidate previews, and
 * search budget. Finish alone chooses which E handles become answer evidence.
 */
export function createMemoryObservation(
  options: CreateMemoryObservationOptions,
): MemoryObservation {
  let searchesCompleted = 0;
  let latestFindingCount: number | undefined;
  let latestFindings: MemoryCandidate[] = [];
  let latestDirectoryFindings: MemoryCandidate[] = [];
  let latestOperatorEvidence: string | undefined;
  let latestPlanTrace: string | undefined;
  let latestCoverageProgress: SearchCoverageProgress | undefined;
  let latestPagination: {
    mode?: "initial" | "continuation";
    page: number;
    depth: number;
    hasMore: boolean;
    directoryCandidateCount?: number;
    presentationOnly?: boolean;
  } | undefined;
  let workingMemory: string | undefined;

  return {
    recordWorkingMemory(value): void {
      const normalized = value.trim();
      if (!normalized) {
        throw new Error("workingMemory must not be empty");
      }
      if (normalized.length > 1600) {
        throw new Error("workingMemory must not exceed 1600 characters");
      }
      workingMemory = normalized;
    },

    recordSearch(input): void {
      if (input.countsAgainstSearchBudget !== false) searchesCompleted += 1;
      latestFindingCount = input.findingCount;
      latestFindings = (input.findings ?? []).map((candidate) => ({
        ...candidate,
        discoveries: candidate.discoveries.map((discovery) => ({
          ...discovery,
        })),
      }));
      latestDirectoryFindings = (input.directoryFindings ?? []).map(
        (candidate) => ({
          ...candidate,
          discoveries: candidate.discoveries.map((discovery) => ({
            ...discovery,
          })),
        }),
      );
      latestCoverageProgress = input.coverageProgress === undefined
        ? undefined
        : {
            ...input.coverageProgress,
            queries: input.coverageProgress.queries.map((query) => ({ ...query })),
          };
      const rendered = input.operatorEvidence?.trim();
      latestOperatorEvidence = rendered || undefined;
      const planTrace = input.planTrace?.trim();
      latestPlanTrace = planTrace || undefined;
      latestPagination = input.pagination === undefined
        ? undefined
        : { ...input.pagination };
    },

    render(): string {
      const candidates = options.ledger.candidates;
      const unread = candidates.filter((candidate) =>
        !candidate.inspected
      );
      const currentById = new Map(candidates.map((candidate) => [
        candidate.candidateId,
        candidate,
      ]));
      const latestCurrent = latestFindings.flatMap((finding) => {
        const current = currentById.get(finding.candidateId);
        return current === undefined
          ? []
          : [{ ...current, preview: finding.preview }];
      });
      const latestUnread = latestCurrent.filter((candidate) => !candidate.inspected);
      const activeUnread = latestUnread.slice(0, MAX_ACTIVE_UNREAD_FINDINGS);
      const activeIds = new Set(
        activeUnread.map((candidate) => candidate.candidateId),
      );
      const latestDirectoryCurrent = latestDirectoryFindings.flatMap((finding) => {
        const current = currentById.get(finding.candidateId);
        return current === undefined
          ? []
          : [{ ...current, preview: finding.preview }];
      }).filter((candidate) =>
        !candidate.inspected && !activeIds.has(candidate.candidateId)
      );
      const latestDirectoryIds = new Set(
        latestDirectoryCurrent.map((candidate) => candidate.candidateId),
      );
      const earlierUnread = unread.filter((candidate) =>
        !activeIds.has(candidate.candidateId) &&
        !latestDirectoryIds.has(candidate.candidateId)
      );
      const visibleLatestDirectory = latestDirectoryCurrent.slice(
        0,
        MAX_DIRECTORY_FINDINGS,
      );
      const earlierDirectoryCapacity = Math.max(
        0,
        MAX_DIRECTORY_FINDINGS - visibleLatestDirectory.length,
      );
      const visibleEarlierDirectory = earlierUnread.slice(
        0,
        earlierDirectoryCapacity,
      );
      const omittedDirectoryCount = Math.max(
        0,
        latestDirectoryCurrent.length + earlierUnread.length -
          visibleLatestDirectory.length - visibleEarlierDirectory.length,
      );
      const unreadConversations = new Set(
        unread.map((candidate) => candidate.sessionId),
      ).size;
      const findingLabel = unread.length === 1 ? "finding" : "findings";
      const conversationLabel = unreadConversations === 1
        ? "conversation"
        : "conversations";
      const remaining = options.maxSearchCalls === undefined
        ? undefined
        : Math.max(0, options.maxSearchCalls - searchesCompleted);
      const searchStatus = remaining === undefined
        ? `Searches completed: ${String(searchesCompleted)}`
        : `Searches remaining: ${String(remaining)}`;
      const latestSearch = latestFindingCount === undefined
        ? []
        : latestPagination?.presentationOnly === true
        ? [
            `Expanded ${String(latestFindingCount)} directory candidate(s) ` +
              "into full passage findings without another retrieval.",
            `${String(latestPagination.directoryCandidateCount ?? 0)} candidate(s) ` +
              "remain in the compact directory for this search.",
          ]
        : [
            `Latest search returned ${String(latestFindingCount)} full finding(s) ` +
              `plus ${String(latestPagination?.directoryCandidateCount ?? 0)} ` +
              "compact, directly readable directory candidate(s).",
            ...(latestPagination === undefined
              ? []
              : [
                  `Result page ${String(latestPagination.page)} reaches ranked ` +
                    `depth ${String(latestPagination.depth)}.`,
                  ...(latestPagination.hasMore
                    ? [
                        "The directory entries already have readable C refs; " +
                          "search_more only expands the next page into full passages.",
                      ]
                    : ["No further ranked page is available for this search."]),
                ]),
          ];
      const nextAction = latestPagination?.hasMore === true
        ? "Next: read any promising C ref directly. Use search_more only when " +
          "a compact snippet is insufficient and a full ranked page would help; " +
          "it does not retrieve new candidates. Finish only when the selected " +
          "read sources support the requested answer."
        : remaining === 0
        ? "Next: read any still-relevant finding from either directory, then " +
          "finish with an honest status and grounded summary."
        : "Next: read a direct finding, or search for a specifically missing " +
          "aspect. Every source read will enter the final source package.";
      const visibleDirectoryCount =
        visibleLatestDirectory.length + visibleEarlierDirectory.length;
      const navigationPreviewLength = visibleDirectoryCount === 0
        ? 128
        : Math.max(
            48,
            Math.min(
              128,
              Math.floor(DIRECTORY_PREVIEW_BUDGET / visibleDirectoryCount),
            ),
          );

      if (options.compact) {
        return [
          "<MEMORY>",
          `Working memory: ${workingMemory ?? "No established facts yet."}`,
          searchStatus,
          ...(latestFindingCount === undefined
            ? []
            : [
                "Current search results",
                ...renderUnreadFindings(
                  activeUnread,
                  options.ledger,
                  options.questionDate,
                  280,
                ),
                ...(latestPagination?.hasMore
                  ? ["More results are available through search_more."]
                  : []),
              ]),
          `Exact sources already read: ${String(options.ledger.inspectedEvidence.length)}.`,
          "Read promising candidates. Use source-supported facts for the next query; decide from the acquired evidence whether to search again or finish.",
          "</MEMORY>",
        ].join("\n");
      }

      return [
        "<MEMORY>",
        "Need",
        ...(options.question === undefined
          ? []
          : ["Caller question", options.question, ""]),
        "Model working state (confirmed facts and unresolved needs)",
        workingMemory ?? "No model-authored working state yet.",
        "",
        searchStatus,
        ...latestSearch,
        "",
        "Inspected evidence ledger",
        "Exact payloads are retained privately and not repeated in this observation. " +
          "Every exact source returned by read is committed when finish succeeds.",
        ...renderInspectReceipts(
          candidates,
          options.ledger,
          options.questionDate,
        ),
        "",
        "Uninspected candidates",
        ...(unread.length === 0
          ? ["- No uninspected candidates."]
          : [
              `Uninspected ${findingLabel}: ${String(unread.length)} across ` +
                `${String(unreadConversations)} separate ${conversationLabel}.`,
            ]),
        "",
        "Latest uninspected findings",
        ...(activeUnread.length === 0
          ? ["- No uninspected finding from the latest search."]
          : [
              `Active findings from the most recent search (top ${String(MAX_ACTIVE_UNREAD_FINDINGS)} maximum):`,
              ...renderUnreadFindings(
                activeUnread,
                options.ledger,
                options.questionDate,
              ),
            ]),
        "",
        "Additional candidates from the same search",
        ...(visibleLatestDirectory.length === 0
          ? ["- No additional same-search directory candidates."]
          : [
              "Compact query-centered snippets; every stable C ref is directly " +
                "readable without search_more.",
              ...renderCompactDirectory(
                visibleLatestDirectory,
                options.ledger,
                options.questionDate,
                navigationPreviewLength,
              ),
            ]),
        "",
        "Earlier uninspected directory",
        ...(visibleEarlierDirectory.length === 0
          ? ["- No earlier uninspected findings."]
          : [
              "These stable candidate references remain directly readable; " +
                "a new search is not required to recover them.",
              ...renderCompactDirectory(
                visibleEarlierDirectory,
                options.ledger,
                options.questionDate,
                navigationPreviewLength,
              ),
            ]),
        ...(omittedDirectoryCount === 0
          ? []
          : [
              `- ${String(omittedDirectoryCount)} older directory candidate(s) ` +
                "are omitted from this bounded snapshot; previously issued C refs remain valid.",
            ]),
        ...(latestOperatorEvidence === undefined
          ? []
          : ["", "Latest search calculation", latestOperatorEvidence]),
        ...(latestPlanTrace === undefined
          ? []
          : ["", "Latest search plan", latestPlanTrace]),
        ...(latestCoverageProgress === undefined
          ? []
          : ["", ...renderCoverageProgress(latestCoverageProgress)]),
        "",
        nextAction,
        "</MEMORY>",
      ].join("\n");
    },
  };
}
