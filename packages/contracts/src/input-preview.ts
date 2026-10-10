export interface RetrievalSummary {
  /** full: every source text fits and is sent unchanged; excerpt: budget-driven local retrieval. */
  mode: 'full' | 'excerpt';
  sourceCount: number;
  originalChars: number;
  selectedChars: number;
  originalTurns: number;
  selectedTurns: number;
}

/** Read-only host preflight. Never includes source text, prompts, answer keys or credentials. */
export interface TaskInputPreview {
  kind: 'extract' | 'grade';
  revision: number;
  canSubmit: boolean;
  reason: string | null;
  model: { providerId: string; modelId: string } | null;
  documentCount: number;
  originalChars: number;
  sentChars: number | null;
  maxChars: number;
  contextWindow: number | null;
  estimatedInputTokens: number | null;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  remainingInputTokens: number | null;
  truncated: boolean;
  retrieval?: RetrievalSummary;
  fields: { path: string; label: string; originalChars: number; sentChars: number; truncated: boolean }[];
}
