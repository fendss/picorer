export interface JudgeArtifactIdentity {
  mode: string;
  model: string;
  sourcePath: string;
  sourceArtifactSha256: string;
}

export function judgeArtifactIdentityMatches(
  prior: unknown,
  expected: JudgeArtifactIdentity,
): boolean;

export function judgeRowMatchesPrediction(
  priorRow: unknown,
  sourceRow: { output: string },
  prompt: string,
): boolean;

export function originalLongMemEvalQuestion(formattedQuery: string): string;

export function officialAnswerText(answer: unknown): string;

export function officialLongMemEvalPrompt(
  questionType: string,
  question: string,
  answer: string,
  response: string,
  abstention?: boolean,
): string;

export function summary(rows: Array<Record<string, unknown>>): Record<string, unknown>;

export function judge(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<{
  label: boolean;
  response: string;
  responseModel: string;
  attempts: number;
}>;
