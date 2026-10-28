import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { unsafeEnvironmentKeys } from '@sanxing/ai-access/providers';
import type { AiTask, LearningProgressEvent } from '@sanxing/contracts';
import { createLearningEngine } from './index.ts';

// Real pinned Pi Models + Codex SSE adapter; only HTTP is replaced, no real credentials or network.
const task: AiTask = { kind: 'extract', recitation: { learned: '队列', topic: '', unclear: '', application: '' }, sources: [{ id: 's1', name: 'Source', text: '队列' }] };
const output = { kind: 'extract', candidates: [{ title: '队列', description: '先入先出😀', sourceIds: ['s1'] }] };
const item = { type: 'message', id: 'm1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify(output) }] };
const completed = { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } };
const partial = [
  { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'm1', part: { type: 'output_text', text: '' } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'm1', delta: JSON.stringify(output) },
  { type: 'response.output_item.done', output_index: 0, item },
];
const fetch = vi.fn<typeof globalThis.fetch>();
beforeEach(() => {
  for (const name of unsafeEnvironmentKeys()) vi.stubEnv(name, '');
  fetch.mockReset(); fetch.mockRejectedValue(new Error('Unexpected HTTP request'));
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function engine() {
  const credentials = new InMemoryCredentialStore();
  const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.synthetic`;
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access: token, refresh: 'synthetic-refresh', expires: Date.now() + 3600_000 }));
  return createLearningEngine({ mode: 'live', provider: 'openai-codex', model: 'gpt-6.1-sol', authMethod: 'oauth', allowUnboundedOAuthOutput: true }, { credentials });
}
function sse(events: unknown[], newline = '\n', split = false) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join(''));
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
it.each(['\n', '\r\n', '\r'])('accepts SSE line endings %j across byte boundaries without losing UTF-8 or usage', async newline => {
  fetch.mockResolvedValueOnce(sse([...partial, completed], newline, true));
  const subject = await engine(); const onUsage = vi.fn(async () => {});
  const result = await subject.execute(task, { signal: new AbortController().signal, onUsage });
  expect(result).toMatchObject({ output, usage: { inputTokens: 20, outputTokens: 10 } });
  expect(onUsage).toHaveBeenCalledExactlyOnceWith(result.usage); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  ['ENOTFOUND', 'MODEL_DNS_ERROR'], ['UND_ERR_SOCKET', 'MODEL_CONNECTION_RESET'],
  ['ETIMEDOUT', 'MODEL_CONNECTION_TIMEOUT'], ['CERT_HAS_EXPIRED', 'MODEL_TLS_ERROR'], ['unknown', 'MODEL_NETWORK_ERROR'],
])('preserves transport classification %s through Pi flattening without retry or raw error text', async (cause, code) => {
  fetch.mockRejectedValueOnce(new TypeError('PRIVATE_ERROR_URL_AND_TOKEN', { cause: Object.assign(new Error('PRIVATE_CAUSE'), { code: cause }) }));
  const subject = await engine(); const onUsage = vi.fn(async () => {});
  const result = subject.execute(task, { signal: new AbortController().signal, onUsage });
  await expect(result).rejects.toMatchObject({ code, usage: null });
  await expect(result).rejects.not.toThrow('PRIVATE_'); expect(onUsage).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  ['rate_limit_exceeded', 'MODEL_RATE_LIMITED'], ['insufficient_quota', 'MODEL_QUOTA_EXCEEDED'],
  ['server_error', 'MODEL_PROVIDER_ERROR'], ['PRIVATE_UNRECOGNIZED_CODE', 'MODEL_PROVIDER_ERROR'],
])('classifies in-stream %s errors without exposing the provider body', async (errorCode, code) => {
  fetch.mockResolvedValueOnce(sse([...partial, { type: 'response.failed', response: { status: 'failed', error: { code: errorCode, message: 'PRIVATE_PROVIDER_BODY' } } }]));
  const subject = await engine(); const events: LearningProgressEvent[] = [];
  const result = subject.execute(task, { signal: new AbortController().signal, onProgress: event => events.push(event) });
  await expect(result).rejects.toMatchObject({ code }); await expect(result).rejects.not.toThrow('PRIVATE_');
  expect(events).not.toContain('generated'); expect(events).not.toContain('validated'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects a complete-looking JSON answer if the stream closes before the response terminal event', async () => {
  fetch.mockResolvedValueOnce(sse(partial)); const subject = await engine(); const events: LearningProgressEvent[] = [];
  await expect(subject.execute(task, { signal: new AbortController().signal, onProgress: event => events.push(event) })).rejects.toMatchObject({ code: 'MODEL_STREAM_INTERRUPTED', usage: null });
  expect(events).not.toContain('generated'); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['max_output_tokens', 'content_filter'])('keeps the incomplete reason %s and any reported usage', async reason => {
  fetch.mockResolvedValueOnce(sse([{ ...completed, type: 'response.incomplete', response: { ...completed.response, status: 'incomplete', incomplete_details: { reason } } }]));
  const subject = await engine();
  await expect(subject.execute(task, { signal: new AbortController().signal })).rejects.toMatchObject({ code: reason === 'max_output_tokens' ? 'OUTPUT_LIMIT' : 'MODEL_RESPONSE_INCOMPLETE', usage: { inputTokens: 20, outputTokens: 10 } });
});
it.each(['in_progress', 'queued', 'unknown', undefined])('rejects SDK completion with a nonterminal status %s', async status => {
  fetch.mockResolvedValueOnce(sse([{ ...completed, response: { ...completed.response, status } }]));
  const subject = await engine();
  await expect(subject.execute(task, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INCOMPLETE' });
});
it('preserves an actual HTTP rejection and identifies malformed stream JSON', async () => {
  const subject = await engine();
  fetch.mockResolvedValueOnce(new Response('PRIVATE_HTTP_BODY', { status: 503 }));
  await expect(subject.execute(task, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_HTTP_503' });
  fetch.mockResolvedValueOnce(new Response('data: {not-json PRIVATE_BODY}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await expect(subject.execute(task, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_ERROR' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('delivers CRLF content before EOF and cancels the original body without another request', async () => {
  const cancel = vi.fn(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
  const subject = await engine(); const abort = new AbortController(); const events: LearningProgressEvent[] = [];
  const result = subject.execute(task, { signal: abort.signal, onProgress: event => events.push(event) });
  void result.catch(() => {});
  try {
    controller.enqueue(new TextEncoder().encode(partial.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')));
    await vi.waitFor(() => expect(events).toContain('text'));
    expect(events).not.toContain('generated'); abort.abort();
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { abort.abort(); await result.catch(() => {}); }
});

it('bounds a completed response tail that never reaches EOF and still releases the source', async () => {
  const cancel = vi.fn();
  fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode([...partial, completed].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
  }, cancel }), { headers: { 'content-type': 'text/event-stream' } }));
  const subject = await engine(); const start = performance.now();
  try {
    await expect(subject.execute(task, { signal: new AbortController().signal })).resolves.toMatchObject({ output });
    expect(performance.now() - start).toBeLessThan(1500);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1)); expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await subject.close?.(); }
});

it('limits trailing bytes after completion and never interprets or retains them as another answer', async () => {
  const cancel = vi.fn(); let pulls = 0;
  fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (++pulls === 1) controller.enqueue(new TextEncoder().encode([...partial, completed].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
    else controller.enqueue(new Uint8Array(32 * 1024).fill(32));
  }, cancel }), { headers: { 'content-type': 'text/event-stream' } }));
  const subject = await engine();
  try {
    await expect(subject.execute(task, { signal: new AbortController().signal })).resolves.toMatchObject({ output });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1)); expect(pulls).toBeLessThan(10); expect(fetch).toHaveBeenCalledTimes(1);
  } finally { await subject.close?.(); }
});

it('lets user cancellation interrupt the completed-tail drain without accepting a late result', async () => {
  const cancel = vi.fn(); const abort = new AbortController();
  fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode([...partial, completed].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
  }, cancel }), { headers: { 'content-type': 'text/event-stream' } }));
  const subject = await engine(); const progress: LearningProgressEvent[] = [];
  const result = subject.execute(task, { signal: abort.signal, onProgress: value => progress.push(value) }); void result.catch(() => {});
  try {
    await vi.waitFor(() => expect(progress).toContain('text'));
    abort.abort(); await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1)); expect(progress).not.toContain('validated'); expect(fetch).toHaveBeenCalledTimes(1);
  } finally { abort.abort(); await subject.close?.(); }
});
