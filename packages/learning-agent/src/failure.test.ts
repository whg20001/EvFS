import { afterEach, expect, it, vi } from 'vitest';
import { RequestFailureObserver, transportFailure } from './failure.ts';
import { normalizeCodexSse } from './codex-sse.ts';
afterEach(() => vi.unstubAllGlobals());

it('bounds cause traversal, handles AggregateError, and never trusts arbitrary strings or prototype keys', () => {
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  expect(transportFailure(cycle)).toBe('MODEL_NETWORK_ERROR');
  expect(transportFailure(new AggregateError([new Error('private'), { code: 'ECONNRESET' }]))).toBe('MODEL_CONNECTION_RESET');
  for (const error of [{ code: '__proto__' }, { message: 'ENOTFOUND private-host' }, 'CERT_HAS_EXPIRED']) expect(transportFailure(error)).toBe('MODEL_NETWORK_ERROR');
});
it('isolates concurrent observations and discards diagnostics after cancellation or closure', async () => {
  let active = true; const first = new RequestFailureObserver(() => active); const second = new RequestFailureObserver(() => true);
  first.event({ type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'private' } } });
  expect(first.code()).toBe('MODEL_QUOTA_EXCEEDED'); expect(second.code()).toBeUndefined();
  active = false; first.response(401); expect(first.code()).toBe('MODEL_QUOTA_EXCEEDED');
  const signal = AbortSignal.abort(); vi.stubGlobal('fetch', vi.fn().mockRejectedValue({ code: 'ENOTFOUND' }));
  await expect(second.fetch('https://synthetic.invalid', { signal })).rejects.toEqual({ code: 'ENOTFOUND' });
  expect(second.code()).toBeUndefined();
});
it('leaves non-SSE responses and HTTP errors unchanged', () => {
  for (const response of [new Response('{}', { headers: { 'content-type': 'application/json' } }), new Response('private', { status: 401 })]) expect(normalizeCodexSse(response)).toBe(response);
});
