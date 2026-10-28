import { afterEach, expect, it } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAiAccessController } from '@sanxing/ai-access';
import { openAccounts } from '../src/accounts.ts';
import { createGatewayApp } from '../src/gateway-app.ts';
import { readConfig } from '../src/config.ts';
import { createOcrRecognizer, type OcrRecognizer } from '../src/ocr.ts';
import { LIMITS, type ImageOcrPreview } from '@sanxing/contracts';
import { openRepository } from '@sanxing/database';
import { createApp } from '../src/app.ts';

const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
const bytes = await readFile(new URL('../../../tests/fixtures/ocr-note.png', import.meta.url));
const preview: ImageOcrPreview = { text: 'PRIVATE_OCR_TEXT Learning through recall.', import: { format: 'image', parser: 'bbc-ocr', mediaType: 'image/png', width: 900, height: 240, modelId: 'test-ocr', engineVersion: 'test', confidence: 0.8, warnings: [] } };
function multipart(data = bytes, name = 'note.png') {
  const boundary = 'ocr-test-boundary';
  return { payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
async function fixture(options: { recognizer?: OcrRecognizer; url?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-ocr-')); const accounts = await openAccounts(directory);
  const config = readConfig({ AI_MODE: 'mock', SESSION_SECRET: 'ocr-test-session-secret-'.repeat(4), ...(options.url ? { OCR_SERVICE_URL: options.url, OCR_SERVICE_TOKEN: 'UPSTREAM_PRIVATE_TOKEN' } : {}) });
  const { app } = await createGatewayApp({ config, accounts, ocrRecognizer: options.recognizer, accessFactory: async () => createAiAccessController({ credentials: new InMemoryCredentialStore(), deviceId: randomUUID() }) });
  resources.push(async () => { await app.close(); await accounts.close(); await rm(directory, { recursive: true, force: true }); });
  const register = async (username: string) => {
    const result = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'ocr-test-user-password' } }); expect(result.statusCode).toBe(200);
    return { cookie: String(result.headers['set-cookie']).split(';')[0]!, origin: config.appOrigin, 'x-csrf-token': result.json().csrfToken as string };
  };
  const headers = await register('alice');
  const upload = (data = bytes, name = 'note.png', auth = headers) => { const form = multipart(data, name); return app.inject({ method: 'POST', url: '/api/ocr/recognize', payload: form.payload, headers: { ...auth, ...form.headers } }); };
  return { app, accounts, config, headers, upload, register };
}
it('keeps OCR authenticated, origin/CSRF protected and separate from a cloud learning repository', async () => {
  let calls = 0; const f = await fixture({ recognizer: async () => { calls++; return preview; } });
  expect((await f.app.inject({ url: '/api/ocr/status' })).statusCode).toBe(401);
  expect((await f.app.inject({ url: '/api/ocr/status', headers: f.headers })).json()).toMatchObject({ enabled: true, provider: 'BBC_OCR' });
  expect((await f.upload(bytes, 'note.png', { ...f.headers, 'x-csrf-token': '' })).statusCode).toBe(403);
  expect((await f.upload(bytes, 'note.png', { ...f.headers, origin: 'https://evil.invalid' })).statusCode).toBe(403);
  const result = await f.upload(); expect(result.statusCode, result.body).toBe(200); expect(result.json()).toEqual(preview); expect(calls).toBe(1);
  expect((await f.app.inject({ url: '/api/documents', headers: f.headers })).statusCode).toBe(404);
  expect(JSON.stringify(await f.accounts.inspect())).not.toContain('PRIVATE_OCR_TEXT');
});
it('rejects missing configuration, misleading file names, invalid bytes and oversized images without OCR', async () => {
  const disabled = await fixture(); expect((await disabled.upload()).statusCode).toBe(503);
  let calls = 0; const f = await fixture({ recognizer: async () => { calls++; return preview; } });
  for (const [data, name] of [[Buffer.from('not an image'), 'fake.png'], [bytes, 'image.svg']] as const) expect((await f.upload(data, name)).statusCode).toBe(400);
  const large = await f.upload(Buffer.alloc(LIMITS.imageUploadBytes + 1)); expect(large.statusCode).toBe(413); expect(calls).toBe(0);
});
it('limits concurrent OCR per account and across accounts', async () => {
  let release!: () => void; let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ recognizer: async () => { started(); await waiting; return preview; } });
  const first = f.upload().then(result => result); await begun;
  try { expect((await f.upload()).statusCode).toBe(429); }
  finally { release(); }
  expect((await first).statusCode).toBe(200);
});
it('uses the existing BBC wire contract, binds the result to the uploaded bytes and never returns upstream secrets/errors', async () => {
  let status = 200; let mismatch = false; let auth: string | undefined; let upstreamCalls = 0;
  const server = createServer(async (request, response) => {
    auth = request.headers.authorization; upstreamCalls++;
    for await (const _chunk of request) { /* Drain without logging image content. */ }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { text: preview.text, ocr: { model_id: 'pp-ocrv6-small', engine_version: '3.7.0' }, source: { content_sha256: mismatch ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), media_type: 'image/png' },
      document: { pages: [{ width_px: 900, height_px: 240, blocks: [{ lines: [{ words: [{ confidence: 0.8 }] }] }] }] }, quality: [{ markers: ['blur_above_threshold'] }] } : { error: { message: 'PRIVATE_UPSTREAM_TRACE UPSTREAM_PRIVATE_TOKEN' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  resources.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
  const f = await fixture({ url: `http://127.0.0.1:${address.port}` });
  const response = await f.upload(); expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ text: preview.text, import: { modelId: 'pp-ocrv6-small', confidence: 0.8 } }); expect(response.json().import.warnings).toHaveLength(2);
  expect(auth).toBe('Bearer UPSTREAM_PRIVATE_TOKEN'); expect(response.body).not.toContain('UPSTREAM_PRIVATE_TOKEN'); expect(upstreamCalls).toBe(1);
  mismatch = true; expect((await f.upload()).json().error.code).toBe('OCR_SOURCE_MISMATCH');
  status = 503; const failure = await f.upload(); expect(failure.statusCode).toBe(503); expect(failure.body).not.toMatch(/PRIVATE_UPSTREAM_TRACE|UPSTREAM_PRIVATE_TOKEN/);
});

it('accepts reviewed OCR imports in legacy storage and preserves their original bytes without re-running OCR or learning', async () => {
  const repository = await openRepository(':memory:', 'mock');
  const config = readConfig({ OWNER_PASSWORD: 'ocr-legacy-test-password', SESSION_SECRET: 'ocr-legacy-session-secret-'.repeat(4), AI_MODE: 'mock', APP_STORAGE_MODE: 'server' });
  const { app } = await createApp({ repository, config, engine: { mode: 'mock', execute: async () => { throw new Error('Image import must not run a learning task'); } }, startWorker: false });
  resources.push(async () => { await app.close(); await repository.close(); });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: config.appOrigin, 'x-csrf-token': login.json().csrfToken as string };
  const draft = await app.inject({ method: 'POST', url: '/api/recitations', headers: { ...headers, 'idempotency-key': 'ocr-legacy-draft' }, payload: {} });
  const metadata = { text: '用户校对后的文字。', import: { ...preview.import, reviewed: true, edited: true } };
  const upload = (value: string, key: string) => {
    const boundary = 'ocr-test-boundary'; const file = multipart();
    const field = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="ocr"\r\n\r\n${value}\r\n`);
    return app.inject({ method: 'POST', url: `/api/documents?recitationId=${draft.json().id}`, headers: { ...headers, ...file.headers, 'idempotency-key': key }, payload: Buffer.concat([field, file.payload]) });
  };
  expect((await upload('{invalid json', 'ocr-invalid-json')).statusCode).toBe(400);
  expect((await upload(JSON.stringify({ ...metadata, import: { ...metadata.import, reviewed: false } }), 'ocr-unreviewed')).statusCode).toBe(400);
  expect(Object.keys((await repository.read()).documents)).toHaveLength(0);
  const added = await upload(JSON.stringify(metadata), 'ocr-legacy-reviewed'); expect(added.statusCode, added.body).toBe(201);
  expect((await upload(JSON.stringify(metadata), 'ocr-legacy-reviewed')).json()).toEqual(added.json());
  const document = (await repository.read()).documents[added.json().id]!;
  expect(document.text).toBe(metadata.text); expect(document.import).toEqual(metadata.import);
  expect((await app.inject({ url: `/api/documents/${document.id}/original`, headers })).rawPayload).toEqual(bytes);
  expect((await upload(JSON.stringify({ ...metadata, text: '不同的校对文字' }), 'ocr-legacy-reviewed')).statusCode).toBe(409);
});
