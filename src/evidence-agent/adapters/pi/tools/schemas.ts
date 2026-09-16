import { Type } from "@earendil-works/pi-ai";

const WorkingMemory = Type.String({
  minLength: 1,
  maxLength: 1600,
  description:
    "Replace the persistent working note with concise plain-text Established " +
    "facts and Missing facts. The harness owns source handles, read receipts, " +
    "and exact evidence. Do not include IDs, candidate lists, search history, " +
    "or reasoning. Omit when unchanged.",
});

const SearchOperatorId = (description: string) => Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9._-]{0,63}$",
  description,
});

const SearchQueries = (description: string) => Type.Array(
  Type.String({ minLength: 1 }),
  {
    minItems: 1,
    maxItems: 16,
    description,
  },
);

export const CompactSearchMoreParameters = Type.Object({}, {
  additionalProperties: false,
  description: "Show the next page from the latest search without running a new retrieval.",
});

const SearchOrder = Type.Union([
  Type.Literal("relevance"),
  Type.Literal("chronological"),
  Type.Literal("reverse-chronological"),
]);

export function createSearchParameters(operatorIds: readonly string[]) {
  if (operatorIds.length === 0) {
    throw new Error("Search tool requires at least one registered operator");
  }
  return Type.Object({
    workingMemory: Type.Optional(WorkingMemory),
    operator: Type.Optional(SearchOperatorId(
      `Agent-selected operator ID. Pass a catalog id exactly; do not append @version. Initially available IDs: ${operatorIds.join(", ")}. ` +
        "A successfully defined run-local operator is also valid. Defaults to the registry default.",
    )),
    queries: SearchQueries(
      "One to twelve complementary semantic access paths or independent evidence needs. " +
        "Each query must add a distinct evidence-frame signal; do not pad the batch with paraphrases. " +
        "Never submit more than 16 queries in one search call; sixteen is a hard ceiling, not a target.",
    ),
    branches: Type.Optional(Type.Array(Type.Object({
      operator: SearchOperatorId(
        `Additional primitive or run-local retrieval path. Available IDs start with: ${operatorIds.join(", ")}.`,
      ),
      queries: SearchQueries(
        "Focused queries for this additional retrieval path.",
      ),
    }), {
      minItems: 1,
      maxItems: 3,
      description:
        "Optional additional retrieval paths executed in this same search call. " +
        "Omit for an ordinary single-retriever search.",
    })),
    combine: Type.Optional(Type.Union([
      Type.Literal("rrf"),
      Type.Literal("union"),
      Type.Literal("intersection"),
    ], {
      description:
        "How to combine the primary path with branches. Defaults to rrf. " +
        "Use union for breadth and intersection only for evidence that must match every path. " +
        "It has no effect when branches are omitted.",
    })),
    order: Type.Optional(SearchOrder),
    maxPerSession: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 100,
      description:
        "Optional session-diversity cap applied after fusion and pushed into retrieval. " +
        "Use a small value when independent conversations must contribute.",
    })),
    limit: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 20,
      description:
        "Visible candidate page size, at most 20. Normally omit it and use the " +
        "harness default; this does not change the hidden physical reservoir. " +
        "search_more reveals later bounded pages.",
    })),
  }, { additionalProperties: false });
}

export type SearchParametersSchema = ReturnType<typeof createSearchParameters>;

export const SearchMoreParameters = Type.Object({
  workingMemory: Type.Optional(WorkingMemory),
}, {
  description:
    "Reveal the next bounded page from the most recent search without changing " +
    "its operator or queries. Use only when its evidence remains incomplete.",
});

const StepId = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9._-]{0,63}$",
});

const StepInput = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9._-]{0,63}$",
  description: "ID of an earlier step in this plan.",
});

const DefineOperatorStep = Type.Union([
  Type.Object({
    id: StepId,
    kind: Type.Literal("search"),
    operator: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9._-]{0,63}$",
      description: "Primitive retriever ID from the initial catalog.",
    }),
    queries: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 12,
      description: "Optional step-specific queries; otherwise the later search call supplies them.",
    })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  Type.Object({
    id: StepId,
    kind: Type.Literal("combine"),
    inputs: Type.Array(StepInput, { minItems: 2, maxItems: 4 }),
    method: Type.Union([
      Type.Literal("union"),
      Type.Literal("rrf"),
      Type.Literal("intersection"),
    ]),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  Type.Object({
    id: StepId,
    kind: Type.Literal("sort"),
    input: StepInput,
    order: SearchOrder,
  }),
  Type.Object({
    id: StepId,
    kind: Type.Literal("diversify"),
    input: StepInput,
    maxPerGroup: Type.Integer({ minimum: 1, maximum: 100 }),
  }),
  Type.Object({
    id: StepId,
    kind: Type.Literal("dedupe"),
    input: StepInput,
  }),
  Type.Object({
    id: StepId,
    kind: Type.Literal("limit"),
    input: StepInput,
    limit: Type.Integer({ minimum: 1, maximum: 100 }),
  }),
  Type.Object({
    id: StepId,
    kind: Type.Literal("annotate"),
    input: StepInput,
    method: Type.Union([Type.Literal("temporal"), Type.Literal("numeric")]),
  }),
], {
  description:
    "One ordered plan step. A step may reference only earlier step IDs.",
});

export const DefineOperatorParameters = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[a-z][a-z0-9._-]{0,63}$",
    description: "Short run-local plan ID used by a later search call.",
  }),
  summary: Type.String({ minLength: 1, maxLength: 240 }),
  steps: Type.Array(DefineOperatorStep, { minItems: 1, maxItems: 12 }),
}, {
  description:
    "Define an ordered run-local retrieval plan. The last step is automatically the output; " +
    "diversify always groups by session and dedupe always compares content.",
});

const CandidateReference = Type.String({
  pattern: "^C[1-9][0-9]*$",
  description:
    "Opaque candidate handle returned by search, such as C1. It is not a class label, rank, or memory ID.",
});

export const ReadParameters = Type.Object({
  workingMemory: Type.Optional(WorkingMemory),
  candidateRefs: Type.Array(CandidateReference, {
    minItems: 1,
    maxItems: 100,
    description:
      "Stable candidate handles returned by search or bash_ro. Copy them exactly; the harness resolves them to internal source IDs.",
  }),
  contextBefore: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description:
      "Neighboring turns from the same session before each hit. Defaults to 1; pass 0 only when the hit is self-contained.",
  })),
  contextAfter: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 10,
    description:
      "Neighboring turns from the same session after each hit. Defaults to 1; pass 0 only when the hit is self-contained.",
  })),
}, {
  description:
    "Read immutable candidate memories into the final exact-source package with a bounded local session window. " +
    "One neighboring turn on each side is included by default to preserve " +
    "referents and local event state. Oversized memories are returned as " +
    "exact, query-focused excerpts bound to the full source hash. Every source " +
    "returned by read is automatically committed when finish succeeds.",
});

export const CompactReadParameters = Type.Object({
  candidateRefs: Type.Array(CandidateReference, {
    minItems: 1,
    maxItems: 6,
    description: "Candidate handles from the currently visible search page.",
  }),
}, {
  additionalProperties: false,
  description:
    "Read a small set of promising candidates. Exact sources and provenance are retained by the harness.",
});

export const FinishParameters = Type.Object({
  status: Type.Union([
    Type.Literal("sufficient"),
    Type.Literal("insufficient"),
  ], {
    description:
      "Use sufficient when you consider the exact sources read so far adequate " +
      "for answering; otherwise use insufficient.",
  }),
  evidenceSummary: Type.Optional(Type.Union([Type.String({
    maxLength: 2000,
  }), Type.Null()], {
    description:
      "Optional audit note. Omission, null and blank text mean no summary. Normally omit it; workingMemory already retains " +
      "retrieval progress. This note is not source evidence and is not required " +
      "by the answer handoff.",
  })),
}, {
  description:
    "Stop retrieval with a status and an optional audit note. Use as the only tool call in an " +
    "assistant turn, after observing the latest search or read result in an " +
    "earlier turn. The harness automatically commits every exact source " +
    "returned by read and generates citations, hashes, provenance, and package formatting.",
});

export const CompactFinishParameters = Type.Object({
  status: Type.Union([
    Type.Literal("sufficient"),
    Type.Literal("insufficient"),
  ], {
    description:
      "Use sufficient when you consider the exact sources already read adequate for answering; otherwise use insufficient.",
  }),
}, {
  additionalProperties: false,
  description: "Stop retrieval and let the harness commit all exact sources read so far.",
});

export const BashRoParameters = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 4096 }),
});
