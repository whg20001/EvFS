/** Shared product limits. Character limits count JS UTF-16 code units, not tokens. */
export const LIMITS = Object.freeze({
  recitationFieldChars: 20_000,
  topicChars: 80,
  answerChars: 12_000,
  modelInputChars: 48_000,
  uploadBytes: 131_072,
  uploadBytesMaximum: 1_048_576,
  documents: 5,
  documentsMaximum: 10,
  relatedKnowledgeMaximum: 3,
  modelSourcesMaximum: 14,
  retrievalChunkChars: 900,
  /** Fixed per-scope room for turns/count/recall, so follow-ups and the quiz share identical sources. */
  modelDynamicReserveChars: 8_000,
  libraryQueryChars: 2_000,
  followups: 3,
  followupsMaximum: 5,
  quizQuestions: 3,
  quizQuestionsMaximum: 5,
  codeStarterChars: 8_000,
  codeTestChars: 2_000,
  codeTestsMaximum: 6,
  codeOutputChars: 4_000,
  codeDurationMsMaximum: 600_000,
  transientReceiptTtlMs: 24 * 60 * 60 * 1000,
  transientReceiptMaximum: 2_000,
});
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
