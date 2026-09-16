export interface Bm25Options {
  k1: number;
  b: number;
  epsilon: number;
}

export const PICORER_HYBRID_BM25_OPTIONS: Readonly<Bm25Options> = {
  k1: 1.5,
  b: 0.75,
  epsilon: 0.25,
};

const NLTK_ENGLISH_STOPWORDS = new Set([
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you",
  "you're", "you've", "you'll", "you'd", "your", "yours", "yourself",
  "yourselves", "he", "him", "his", "himself", "she", "she's", "her",
  "hers", "herself", "it", "it's", "its", "itself", "they", "them",
  "their", "theirs", "themselves", "what", "which", "who", "whom",
  "this", "that", "that'll", "these", "those", "am", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "having", "do",
  "does", "did", "doing", "a", "an", "the", "and", "but", "if", "or",
  "because", "as", "until", "while", "of", "at", "by", "for", "with",
  "about", "against", "between", "into", "through", "during", "before",
  "after", "above", "below", "to", "from", "up", "down", "in", "out",
  "on", "off", "over", "under", "again", "further", "then", "once",
  "here", "there", "when", "where", "why", "how", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "s", "t",
  "can", "will", "just", "don", "don't", "should", "should've", "now",
  "d", "ll", "m", "o", "re", "ve", "y", "ain", "aren", "aren't",
  "couldn", "couldn't", "didn", "didn't", "doesn", "doesn't", "hadn",
  "hadn't", "hasn", "hasn't", "haven", "haven't", "isn", "isn't", "ma",
  "mightn", "mightn't", "mustn", "mustn't", "needn", "needn't", "shan",
  "shan't", "shouldn", "shouldn't", "wasn", "wasn't", "weren", "weren't",
  "won", "won't", "wouldn", "wouldn't",
]);

/** Tokenizes candidate text for Picorer hybrid BM25 after \W+ cleanup. */
export function tokenizeForPicorerHybrid(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0 && !NLTK_ENGLISH_STOPWORDS.has(token));
}

export function bm25Scores(
  query: string,
  documents: readonly string[],
  options: Readonly<Bm25Options> = PICORER_HYBRID_BM25_OPTIONS,
): number[] {
  if (documents.length === 0) return [];
  const tokenizedDocuments = documents.map(tokenizeForPicorerHybrid);
  if (!tokenizedDocuments.some((tokens) => tokens.length > 0)) {
    return documents.map(() => 0);
  }

  const documentFrequency = new Map<string, number>();
  const termFrequencies = tokenizedDocuments.map((tokens) => {
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    return frequencies;
  });

  const corpusSize = documents.length;
  const idf = new Map<string, number>();
  let idfSum = 0;
  const negativeTerms: string[] = [];
  for (const [term, frequency] of documentFrequency) {
    const value = Math.log(
      corpusSize - frequency + 0.5,
    ) - Math.log(frequency + 0.5);
    idf.set(term, value);
    idfSum += value;
    if (value < 0) negativeTerms.push(term);
  }
  const averageIdf = idfSum / idf.size;
  const epsilonFloor = options.epsilon * averageIdf;
  for (const term of negativeTerms) idf.set(term, epsilonFloor);

  const documentLengths = tokenizedDocuments.map((tokens) => tokens.length);
  const averageDocumentLength =
    documentLengths.reduce((sum, length) => sum + length, 0) / corpusSize;
  const queryTokens = tokenizeForPicorerHybrid(query);

  return termFrequencies.map((frequencies, documentIndex) => {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (frequency === 0) continue;
      const tokenIdf = idf.get(token) ?? 0;
      const normalizedLength =
        averageDocumentLength === 0
          ? 0
          : documentLengths[documentIndex]! / averageDocumentLength;
      score +=
        tokenIdf *
        ((frequency * (options.k1 + 1)) /
          (frequency + options.k1 * (1 - options.b + options.b * normalizedLength)));
    }
    return score;
  });
}

/** Returns one RRF score per zero-based document index. */
export function reciprocalRankFusion(
  rankings: readonly (readonly number[])[],
  k = 60,
  documentCount?: number,
): number[] {
  if (!Number.isSafeInteger(k) || k < 0) {
    throw new Error("RRF k must be a non-negative integer");
  }
  let inferredCount = 0;
  for (const ranking of rankings) {
    const seen = new Set<number>();
    for (const documentIndex of ranking) {
      if (!Number.isSafeInteger(documentIndex) || documentIndex < 0) {
        throw new Error("RRF document indexes must be non-negative integers");
      }
      if (seen.has(documentIndex)) {
        throw new Error(`RRF ranking contains duplicate document index: ${documentIndex}`);
      }
      seen.add(documentIndex);
      inferredCount = Math.max(inferredCount, documentIndex + 1);
    }
  }
  const count = documentCount ?? inferredCount;
  if (!Number.isSafeInteger(count) || count < inferredCount) {
    throw new Error("RRF documentCount cannot exclude ranked documents");
  }

  const scores = Array.from({ length: count }, () => 0);
  for (const ranking of rankings) {
    ranking.forEach((documentIndex, index) => {
      scores[documentIndex]! += 1 / (k + index + 1);
    });
  }
  return scores;
}
