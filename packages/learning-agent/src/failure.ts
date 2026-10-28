import type { AssistantMessage, CredentialStore, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { RunErrorCode } from '@sanxing/contracts';
import { normalizeCodexSse } from './codex-sse.ts';
import { transportError } from './transport-error.ts';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;

const transportCodes: Record<string, RunErrorCode> = {
  ENOTFOUND: 'MODEL_DNS_ERROR', EAI_AGAIN: 'MODEL_DNS_ERROR',
  ECONNRESET: 'MODEL_CONNECTION_RESET', EPIPE: 'MODEL_CONNECTION_RESET', UND_ERR_SOCKET: 'MODEL_CONNECTION_RESET',
  ETIMEDOUT: 'MODEL_CONNECTION_TIMEOUT', UND_ERR_CONNECT_TIMEOUT: 'MODEL_CONNECTION_TIMEOUT',
  UND_ERR_HEADERS_TIMEOUT: 'MODEL_CONNECTION_TIMEOUT', UND_ERR_BODY_TIMEOUT: 'MODEL_CONNECTION_TIMEOUT',
  CERT_HAS_EXPIRED: 'MODEL_TLS_ERROR', DEPTH_ZERO_SELF_SIGNED_CERT: 'MODEL_TLS_ERROR',
  SELF_SIGNED_CERT_IN_CHAIN: 'MODEL_TLS_ERROR', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'MODEL_TLS_ERROR',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'MODEL_TLS_ERROR', ERR_TLS_CERT_ALTNAME_INVALID: 'MODEL_TLS_ERROR',
};
/** Inspect bounded cause chains, never messages, URLs, bodies, headers or stacks. */
export function transportFailure(error: unknown): RunErrorCode {
  const { errorCode } = transportError(error);
  return errorCode ? transportCodes[errorCode] ?? 'MODEL_NETWORK_ERROR' : 'MODEL_NETWORK_ERROR';
}
const providerCodes: Record<string, RunErrorCode> = {
  rate_limit_exceeded: 'MODEL_RATE_LIMITED', rate_limit_error: 'MODEL_RATE_LIMITED',
  insufficient_quota: 'MODEL_QUOTA_EXCEEDED', usage_limit_reached: 'MODEL_QUOTA_EXCEEDED',
  subscription_sharing_usage_limit_exceeded: 'MODEL_QUOTA_EXCEEDED',
  subscription_sharing_usage_unavailable: 'MODEL_QUOTA_EXCEEDED',
  invalid_api_key: 'MODEL_NOT_AUTHORIZED', authentication_error: 'MODEL_NOT_AUTHORIZED',
};
function providerFailure(value: unknown): RunErrorCode {
  const error = object(value); const code = error?.code ?? error?.type;
  return typeof code === 'string' && Object.hasOwn(providerCodes, code) ? providerCodes[code]! : 'MODEL_PROVIDER_ERROR';
}

/** Request-local observations survive Pi flattening exceptions into assistant errorMessage. */
export class RequestFailureObserver {
  private failure?: RunErrorCode;
  private httpFailure?: RunErrorCode;
  private responsesStarted = false;
  private completed = false;
  constructor(private readonly active: () => boolean, private readonly codexSse = false,
    private readonly send: typeof globalThis.fetch = (...args) => globalThis.fetch(...args), private readonly signal?: AbortSignal) {}

  readonly fetch: NonNullable<SimpleStreamOptions['fetch']> = async (input, init) => {
    try {
      const response = await this.send(input, init);
      this.response(response.status); // Some SDKs throw on non-2xx before invoking onResponse.
      return this.codexSse ? normalizeCodexSse(response, { completed: () => this.completed && this.active(), signal: this.signal ?? init?.signal ?? undefined }) : response;
    }
    catch (error) { if (this.active() && !init?.signal?.aborted) this.failure ??= transportFailure(error); throw error; }
  };
  response(status: number) {
    if (this.active() && Number.isInteger(status) && status >= 400 && status <= 599) this.httpFailure = `MODEL_HTTP_${status}`;
  }
  event(value: unknown) {
    if (!this.active()) return;
    const event = object(value); const type = event?.type;
    if (typeof type !== 'string') return;
    if (type.startsWith('response.')) this.responsesStarted = true;
    const response = object(event?.response);
    if (type === 'error' || type === 'response.failed') {
      this.failure ??= providerFailure(type === 'error' ? object(event?.error) ?? event : response?.error);
    } else if (['response.completed', 'response.done', 'response.incomplete'].includes(type)) {
      if (type !== 'response.incomplete' && response?.status === 'completed') this.completed = true;
      else this.failure ??= object(response?.incomplete_details)?.reason === 'max_output_tokens' ? 'OUTPUT_LIMIT'
        : response?.status === 'failed' ? providerFailure(response.error) : 'MODEL_RESPONSE_INCOMPLETE';
    }
  }
  credentials(store: CredentialStore): CredentialStore {
    const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); }
      catch (error) { if (this.active()) this.failure ??= 'MODEL_AUTH_FAILED'; throw error; }
    };
    return { read: (...args) => observe(() => store.read(...args)), modify: (...args) => observe(() => store.modify(...args)),
      list: (...args) => store.list(...args), delete: (...args) => store.delete(...args) };
  }
  code(message?: Pick<AssistantMessage, 'stopReason' | 'errorMessage'>): RunErrorCode | undefined {
    if (this.httpFailure) return this.httpFailure;
    if (this.failure) return this.failure;
    if (message?.stopReason === 'length') return 'OUTPUT_LIMIT';
    // Fixed prefixes in the pinned Pi adapter; never persist their untrusted suffixes.
    if (message?.errorMessage?.startsWith('Invalid Codex SSE JSON:')) return 'MODEL_PROTOCOL_ERROR';
    if (this.responsesStarted && !this.completed) return 'MODEL_STREAM_INTERRUPTED';
    if (message?.errorMessage === 'OpenAI Responses stream ended before a terminal response event') return 'MODEL_STREAM_INTERRUPTED';
    return undefined;
  }
}
