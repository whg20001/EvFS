import { z } from 'zod';

/** Only safe, bounded codes cross the persistence/API boundary, never provider text. */
export const runErrorCodeSchema = z.union([
  z.enum(['MODEL_FAILED', 'MODEL_NOT_AUTHORIZED', 'MODEL_NOT_CONFIGURED', 'UNSAFE_ENVIRONMENT',
    'MODEL_NETWORK_ERROR', 'MODEL_DNS_ERROR', 'MODEL_CONNECTION_RESET', 'MODEL_CONNECTION_TIMEOUT', 'MODEL_TLS_ERROR',
    'MODEL_STREAM_INTERRUPTED', 'MODEL_PROTOCOL_ERROR', 'MODEL_PROVIDER_ERROR', 'MODEL_RESPONSE_INCOMPLETE',
    'MODEL_RATE_LIMITED', 'MODEL_QUOTA_EXCEEDED', 'MODEL_AUTH_FAILED',
    'INVALID_CONFIG', 'INVALID_TASK', 'INVALID_OUTPUT', 'MODEL_INPUT_TOO_LARGE', 'OUTPUT_LIMIT',
    'REQUEST_LIMIT', 'TIMEOUT', 'FIRST_RESPONSE_TIMEOUT', 'STREAM_IDLE_TIMEOUT', 'CANCELLED', 'SERVICE_RESTARTED', 'PROMPT_CHANGED', 'STALE_RUN',
    'BUDGET_EXCEEDED', 'BUDGET_UNVERIFIABLE']),
  z.templateLiteral(['MODEL_HTTP_', z.number()]).refine(value => /^MODEL_HTTP_[45]\d{2}$/.test(value)),
]);
export type RunErrorCode = z.infer<typeof runErrorCodeSchema>;
export const promptHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface PromptBinding { version: string; hash?: string }

/** Events contain no provider text, prompts, credentials, answers or reasoning content. */
export type LearningProgressEvent = 'request' | 'response' | 'text' | 'thinking' | 'generated' | 'validated';
const milliseconds = z.number().int().nonnegative().safe();
export const connectionPolicySchema = z.enum(['pooled', 'fresh']);
export type ConnectionPolicy = z.infer<typeof connectionPolicySchema>;
export const transportErrorCodeSchema = z.enum(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNREFUSED',
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID']);
/** No exception text, URLs, addresses, headers, credentials or provider content. */
export const runTransportSchema = z.strictObject({
  policy: connectionPolicySchema,
  phase: z.enum(['dispatching', 'awaiting_headers', 'streaming', 'complete']),
  requestCount: milliseconds,
  reusedSocket: z.boolean().nullable(),
  // Socket-counter deltas since the latest HTTP request was assigned its socket.
  bytesWritten: milliseconds.nullable(), bytesRead: milliseconds.nullable(),
  errorCode: transportErrorCodeSchema.optional(),
  syscall: z.enum(['connect', 'read', 'write', 'getaddrinfo']).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
export type RunTransport = z.infer<typeof runTransportSchema>;
export const runProgressSchema = z.strictObject({
  phase: z.enum(['preparing', 'waiting', 'generating', 'validating', 'saving']),
  elapsedMs: milliseconds, queuedMs: milliseconds, totalTimeoutMs: milliseconds.positive(),
  requestStartedMs: milliseconds.optional(), firstResponseMs: milliseconds.optional(),
  firstTextMs: milliseconds.optional(), lastContentMs: milliseconds.optional(),
  generationCompletedMs: milliseconds.optional(), saveStartedMs: milliseconds.optional(), completedMs: milliseconds.optional(),
}).refine(value => [value.requestStartedMs, value.firstResponseMs, value.firstTextMs, value.lastContentMs,
  value.generationCompletedMs, value.saveStartedMs, value.completedMs].every(time => time === undefined || time <= value.elapsedMs));
export type RunProgress = z.infer<typeof runProgressSchema>;
export type RunProgressMap = Record<string, RunProgress>;

/** Request description only; never includes input text, headers or credentials. */
export const runRequestSchema = z.strictObject({
  provider: z.string().min(1).max(200), model: z.string().min(1).max(200),
  authMethod: z.enum(['mock', 'api_key', 'oauth']), cacheRetention: z.enum(['none', 'short']),
  inputChars: milliseconds, inputBytes: milliseconds, estimatedInputTokens: milliseconds.nullable(),
  contextWindow: milliseconds.positive().nullable(), maxOutputTokens: milliseconds.positive(),
  timeoutMs: milliseconds.positive(), firstResponseTimeoutMs: milliseconds.positive(), streamIdleTimeoutMs: milliseconds.positive(),
});
export type RunRequest = z.infer<typeof runRequestSchema>;

/** Shared by the durable worker and standalone evaluation runner. */
export function updateRunProgress(value: RunProgress, event: LearningProgressEvent, elapsedMs: number): void {
  const elapsed = Math.max(value.elapsedMs, Math.floor(elapsedMs));
  value.elapsedMs = elapsed;
  if (event === 'request') { value.requestStartedMs ??= elapsed; value.phase = 'waiting'; }
  if (event === 'response') value.firstResponseMs ??= elapsed;
  if (event === 'text' || event === 'thinking') {
    value.phase = 'generating'; value.firstResponseMs ??= elapsed; value.lastContentMs = elapsed;
    if (event === 'text') value.firstTextMs ??= elapsed;
  }
  if (event === 'generated') { value.generationCompletedMs ??= elapsed; value.phase = 'validating'; }
  if (event === 'validated') { value.saveStartedMs ??= elapsed; value.phase = 'saving'; }
}

/** Explicit legacy run limits remain valid; hosts may opt into a separate quiz budget. */
export function taskTimeoutMs(kind: string, config: { runTimeoutMs: number; quizTimeoutMs?: number }): number {
  return kind === 'connection_test' ? Math.min(config.runTimeoutMs, 30_000)
    : kind === 'quiz' ? config.quizTimeoutMs ?? config.runTimeoutMs : config.runTimeoutMs;
}
