import { createServer } from 'node:http';
import { setImmediate as nextTick } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { unsafeEnvironmentKeys } from '@sanxing/ai-access/providers';
import type { AiTask, RunTransport } from '@sanxing/contracts';
import { createLearningEngine, LearningTransport } from './index.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['pooled', 'fresh'] as const)('uses %s through the real Codex adapter, across engine instances, without retry', async policy => {
  for (const name of unsafeEnvironmentKeys()) vi.stubEnv(name, '');
  const task: AiTask = { kind: 'extract', recitation: { topic: '', learned: 'FIFO', unclear: '', application: '' }, sources: [{ id: 's1', name: 'source', text: 'FIFO' }] };
  const output = { kind: 'extract', candidates: [{ title: 'FIFO', description: 'First in, first out', sourceIds: ['s1'] }] };
  const event = { type: 'response.completed', response: { id: 'r1', status: 'completed',
    output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 20, output_tokens: 10 } } };
  const item = event.response.output[0]!;
  const events = [
    { type: 'response.created', response: { id: 'r1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'm1', part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'm1', delta: JSON.stringify(output) },
    { type: 'response.output_item.done', output_index: 0, item }, event,
  ];
  let calls = 0; let connections = 0;
  const server = createServer((req, res) => {
    if (++calls === 3) { req.socket.destroy(); return; }
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
    setTimeout(() => res.end(), 40); // Model terminal event precedes HTTP EOF, as in live observations.
  });
  server.on('connection', () => connections++);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
  const realFetch = globalThis.fetch;
  // Only the destination changes: actual HTTP sockets, pinned adapter, streaming and cancellation.
  vi.stubGlobal('fetch', vi.fn((_url, init) => realFetch(`http://127.0.0.1:${address.port}`, init)));
  const credentials = new InMemoryCredentialStore();
  const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url')}.synthetic`;
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access, refresh: 'synthetic', expires: Date.now() + 3600_000 }));
  const transport = new LearningTransport(); const observed: RunTransport[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const engine = createLearningEngine({ mode: 'live', provider: 'openai-codex', model: 'gpt-6.1-sol', authMethod: 'oauth', allowUnboundedOAuthOutput: true }, { credentials, transport });
      let diagnostic: RunTransport | undefined;
      const result = engine.execute(task, { signal: new AbortController().signal, connectionPolicy: policy, onTransport: value => { diagnostic = value; } });
      if (i < 2) await expect(result).resolves.toMatchObject({ output });
      else await expect(result).rejects.toMatchObject({ code: 'MODEL_CONNECTION_RESET', usage: null });
      expect(diagnostic).toBeDefined(); observed.push(diagnostic!);
      await engine.close?.(); await nextTick(); // Shared host pool survives an engine's lifetime.
    }
    expect(calls).toBe(3); expect(fetch).toHaveBeenCalledTimes(3);
    expect(connections).toBe(policy === 'pooled' ? 1 : 3);
    expect(observed.map(value => value.reusedSocket)).toEqual(policy === 'pooled' ? [false, true, true] : [false, false, false]);
    expect(observed[2]).toMatchObject({ phase: 'awaiting_headers', errorCode: 'UND_ERR_SOCKET', requestCount: 1, policy });
    expect(JSON.stringify(observed)).not.toContain(access);
  } finally { await transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
