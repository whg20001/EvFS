import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { emptyData, openRepository } from '@sanxing/database';
import { LIMITS, type PublicDocument, type PublicState } from '@sanxing/contracts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { syntheticPdf, syntheticChinesePdf } from '../../../tests/fixtures/pdf.ts';
import { createPdfImporter } from '../src/pdf-import.ts';

const config = readConfig({ OWNER_PASSWORD: 'pdf-test-password', SESSION_SECRET: 'pdf-test-secret-'.repeat(5), AI_MODE: 'mock' });
let repository: Awaited<ReturnType<typeof openRepository>>;
let instance: Awaited<ReturnType<typeof createApp>>;
let headers: Record<string, string>; let recitationId: string; let serial = 0;
const execute = vi.fn(async () => { throw new Error('Import and search must not call a model'); });
beforeAll(async () => { repository = await openRepository(':memory:', 'mock'); instance = await createApp({ repository, config, engine: { mode: 'mock', execute }, startWorker: false }); });
beforeEach(async () => {
  await repository.replace(emptyData('mock')); execute.mockClear();
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin };
  recitationId = (await instance.app.inject({ method: 'POST', url: '/api/recitations', headers: { ...headers, 'idempotency-key': `pdf-create-${++serial}` }, payload: {} })).json().id;
});
afterAll(async () => { await instance?.app.close(); await repository?.close(); });
async function upload(bytes: Buffer, key = `pdf-upload-${++serial}`, requestHeaders = headers) {
  const boundary = 'sanxing-pdf-boundary';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return instance.app.inject({ method: 'POST', url: `/api/documents?recitationId=${recitationId}`, headers: { ...requestHeaders, 'idempotency-key': key, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
}
it('imports PDF pages, retains original bytes through export/restore, and only sends explicitly attached text', async () => {
  const bytes = syntheticPdf(['FIFO means first in first out.', 'Binary search halves the range.']);
  const response = await upload(bytes, 'pdf-repeat-key'); expect(response.statusCode, response.body).toBe(201); const id = response.json().id;
  expect((await upload(bytes, 'pdf-repeat-key')).json()).toEqual(response.json());
  const data = await repository.read(); const document = data.documents[id]!;
  expect(Object.keys(data.documents)).toHaveLength(1); expect(document.import?.format === 'pdf' ? document.import.pages : undefined).toEqual([{ page: 1, startLine: 1, endLine: 2, hasText: true }, { page: 2, startLine: 3, endLine: 4, hasText: true }]);
  expect(Buffer.from(document.originalBase64, 'base64')).toEqual(bytes);
  await repository.replace(JSON.parse(JSON.stringify(data))); expect((await repository.read()).documents[id]).toEqual(document);
  const publicState = (await instance.app.inject({ url: '/api/state', headers })).json<PublicState>();
  expect(publicState.documents[0]).not.toHaveProperty('text'); expect(publicState.documents[0]).not.toHaveProperty('originalBase64');
  const detail = (await instance.app.inject({ url: `/api/documents/${id}`, headers })).json<PublicDocument>(); expect(detail.import).toEqual(document.import);
  const download = await instance.app.inject({ url: `/api/documents/${id}/original`, headers }); expect(download.rawPayload).toEqual(bytes); expect(download.headers['content-disposition']).toContain('attachment');
  expect((await instance.app.inject({ url: `/api/documents/${id}/original` })).statusCode).toBe(401);
  const search = await instance.app.inject({ method: 'POST', url: '/api/library/search', headers, payload: { query: 'binary' } }); expect(search.json().hits[0].pages).toContain(2);
  const fresh = await instance.service.command('new-draft', 'pdf-other-draft', {}, data => instance.service.createRecitation(data, { learningDate: '2020-01-01' }));
  const task = instance.service.previewRecitationTask(await repository.read(), fresh.id!, { topic: '', learned: '独立复述', unclear: '', application: '' });
  expect(JSON.stringify(task)).not.toContain('FIFO'); expect(execute).not.toHaveBeenCalled();
});
it.each([
  ['PDF_INVALID', () => Buffer.from('%PDF-invalid')],
  ['PDF_OCR_REQUIRED', () => syntheticPdf([''])],
  ['PDF_PAGE_LIMIT', () => syntheticPdf(Array.from({ length: LIMITS.pdfPages + 1 }, () => 'sample'))],
  ['PDF_TEXT_LIMIT', () => syntheticPdf(['oversized '.repeat(30_000)], 10_000_000)],
])('rejects %s without any partial document or receipt', async (code, bytes) => {
  const before = await repository.read(); const response = await upload(bytes());
  expect(response.statusCode, response.body).toBe(400); expect(response.json().error.code).toBe(code); expect(await repository.read()).toEqual(before); expect(execute).not.toHaveBeenCalled();
  if (code === 'PDF_PAGE_LIMIT') expect(response.json().error.message).toContain(`此 PDF 共 ${LIMITS.pdfPages + 1} 页`);
  if (code === 'PDF_TEXT_LIMIT') { expect(response.json().error.message).toContain('解析到第 1 页'); expect(response.json().error.message).toContain('200,000 字符'); }
});
it('enforces raw upload size and authentication before parsing', async () => {
  const before = await repository.read();
  expect((await upload(Buffer.alloc(LIMITS.pdfUploadBytes + 1))).statusCode).toBe(413);
  expect((await upload(syntheticPdf(['text']), undefined, {})).statusCode).toBe(401);
  expect((await upload(syntheticPdf(['text']), undefined, { cookie: headers.cookie! })).statusCode).toBe(403);
  expect(await repository.read()).toEqual(before);
});
it('imports PDFs larger than the note and image limits while keeping the original bytes', async () => {
  const bytes = syntheticPdf(['Large binary attachment, short searchable text.'], 612, 12_000_000);
  expect(bytes.length).toBeGreaterThan(LIMITS.imageUploadBytes);
  const response = await upload(bytes); expect(response.statusCode, response.body).toBe(201);
  const document = (await repository.read()).documents[response.json().id]!;
  expect(document.text).toContain('short searchable text'); expect(Buffer.from(document.originalBase64, 'base64').equals(bytes)).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
it('labels pages without extractable text and bounds concurrent parsers', async () => {
  const importer = createPdfImporter();
  try {
    const pending = importer.parse(syntheticPdf(['Readable text', '']));
    await expect(importer.parse(syntheticPdf(['another']))).rejects.toMatchObject({ code: 'PDF_IMPORT_BUSY' });
    const result = await pending; expect(result.import.pages[1]!.hasText).toBe(false); expect(result.text).toContain('可能为空白或需要 OCR');
  } finally { await importer.close(); }
});

it('extracts Chinese Unicode from CID text without depending on installed system fonts', async () => {
  const response = await upload(syntheticChinesePdf()); expect(response.statusCode, response.body).toBe(201);
  const document = (await repository.read()).documents[response.json().id]!;
  expect(document.text).toContain('中文资料'); expect(document.import?.format === 'pdf' && document.import.pages[0]?.hasText).toBe(true);
});
