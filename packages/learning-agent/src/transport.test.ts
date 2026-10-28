import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { setImmediate as nextTick } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { runTransportSchema, type RunTransport, type ConnectionPolicy } from '@sanxing/contracts';
import { LearningTransport, RequestTransport } from './transport.ts';
import { transportError } from './transport-error.ts';

const servers: Server[] = []; const owners: LearningTransport[] = []; const requests: RequestTransport[] = [];
afterEach(async () => {
  for (const request of requests.splice(0)) request.close();
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.unstubAllGlobals();
});
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
function owner() { const value = new LearningTransport(); owners.push(value); return value; }
function request(pool: LearningTransport, policy: ConnectionPolicy = 'pooled', active = () => true) {
  const snapshots: RunTransport[] = [];
  const value = new RequestTransport(pool, policy, active, v => snapshots.push(runTransportSchema.parse(v)));
  requests.push(value); return { value, snapshots, last: () => snapshots.at(-1)! };
}

it.each(['pooled', 'fresh'] as const)('%s has the expected real socket reuse and releases per-request observers', async policy => {
  const { server, url } = await serve((_req, res) => res.end('ok'));
  let connections = 0; server.on('connection', () => connections++);
  const pool = owner(); const observations: RunTransport[] = [];
  for (let i = 0; i < 3; i++) {
    const subject = request(pool, policy);
    const response = await subject.value.fetch(url, { method: 'POST', body: 'synthetic' });
    expect(await response.text()).toBe('ok'); await nextTick(); subject.value.close(); observations.push(subject.last());
  }
  expect(connections).toBe(policy === 'pooled' ? 1 : 3);
  expect(observations.map(v => v.reusedSocket)).toEqual(policy === 'pooled' ? [false, true, true] : [false, false, false]);
  for (const value of observations) expect(value).toMatchObject({ policy, phase: 'complete', requestCount: 1, httpStatus: 200,
    bytesRead: expect.any(Number), bytesWritten: expect.any(Number) });
  const frozen = structuredClone(observations); await pool.close(); expect(observations).toEqual(frozen);
  expect(channel('undici:request:create').hasSubscribers).toBe(false);
});

it.each(['pooled', 'fresh'] as const)('captures early close on %s and keeps the actual code, without retry', async policy => {
  let calls = 0;
  const { url } = await serve((req, res) => { if (++calls === 1) res.end('warm'); else req.socket.destroy(); });
  const pool = owner(); const warm = request(pool, policy);
  await (await warm.value.fetch(url, { method: 'POST', body: 'warm' })).text(); warm.value.close(); await nextTick();
  const failed = request(pool, policy);
  await expect(failed.value.fetch(url, { method: 'POST', body: 'synthetic' })).rejects.toThrow();
  failed.value.close();
  expect(failed.last()).toMatchObject({ policy, phase: 'awaiting_headers', reusedSocket: policy === 'pooled', requestCount: 1, errorCode: 'UND_ERR_SOCKET' });
  expect(failed.last().httpStatus).toBeUndefined(); expect(failed.last().bytesWritten).toBeGreaterThan(0);
  expect(calls).toBe(2);
});

it('captures body interruption separately from a failure before headers', async () => {
  const { url } = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: partial\n\n'); setTimeout(() => res.destroy(), 30); });
  const subject = request(owner()); const response = await subject.value.fetch(url, { method: 'POST' });
  await expect(response.text()).rejects.toThrow(); subject.value.close();
  expect(subject.last()).toMatchObject({ phase: 'streaming', httpStatus: 200, errorCode: 'UND_ERR_SOCKET', reusedSocket: false });
});

it('isolates parallel requests from each other and unrelated HTTP, with safe unknown values', async () => {
  const { url } = await serve((req, res) => { if (req.url === '/fail') req.socket.destroy(); else res.end('ok'); });
  const pool = owner(); const success = request(pool); const failed = request(pool);
  const results = await Promise.allSettled([
    success.value.fetch(`${url}/ok`).then(response => response.text()),
    failed.value.fetch(`${url}/fail`, { method: 'POST' }),
    fetch(`${url}/unrelated`).then(response => response.text()),
  ]);
  expect(results.map(v => v.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  success.value.close(); failed.value.close();
  expect(success.last()).toMatchObject({ phase: 'complete', requestCount: 1 }); expect(success.last().errorCode).toBeUndefined();
  expect(failed.last()).toMatchObject({ errorCode: 'UND_ERR_SOCKET', requestCount: 1 });
});

it('does not retain subscribers or accept late events after abort and owner shutdown', async () => {
  const { server, url } = await serve((_req, res) => { res.writeHead(200); res.write('partial'); });
  const pool = owner(); const abort = new AbortController(); const subject = request(pool, 'fresh', () => !abort.signal.aborted);
  const response = await subject.value.fetch(url, { signal: abort.signal, method: 'POST' });
  const reading = response.text(); void reading.catch(() => {});
  abort.abort(); subject.value.close(); const snapshots = structuredClone(subject.snapshots);
  await expect(reading).rejects.toThrow(); await pool.close();
  expect(subject.snapshots).toEqual(snapshots); expect(subject.last().errorCode).toBeUndefined();
  expect(channel('undici:request:create').hasSubscribers).toBe(false);
  await vi.waitFor(async () => expect(await new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)))).toBe(0));
});

it('keeps only allowlisted codes/operations and never infers reuse when no socket was observed', async () => {
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  expect(transportError(cycle)).toEqual({});
  expect(transportError(new AggregateError([{ code: '__proto__' }, { code: 'ECONNRESET', syscall: 'read', message: 'PRIVATE', address: 'PRIVATE' }]))).toEqual({ errorCode: 'ECONNRESET', syscall: 'read' });
  expect(transportError({ code: 'EPIPE', syscall: 'PRIVATE' })).toEqual({ errorCode: 'EPIPE' });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('PRIVATE', { cause: { code: 'ECONNREFUSED', syscall: 'connect', address: 'PRIVATE' } })));
  const subject = request(owner()); await expect(subject.value.fetch('https://synthetic.invalid')).rejects.toThrow(); subject.value.close();
  expect(subject.last()).toEqual({ policy: 'pooled', phase: 'dispatching', requestCount: 0, reusedSocket: null, bytesRead: null, bytesWritten: null, errorCode: 'ECONNREFUSED', syscall: 'connect' });
  expect(JSON.stringify(subject.snapshots)).not.toContain('PRIVATE');
});

it('ignores diagnostic consumer exceptions', async () => {
  const { url } = await serve((_req, res) => res.end('ok'));
  const subject = new RequestTransport(owner(), 'pooled', () => true, () => { throw new Error('consumer failed'); }); requests.push(subject);
  expect(await (await subject.fetch(url)).text()).toBe('ok'); subject.close();
});
