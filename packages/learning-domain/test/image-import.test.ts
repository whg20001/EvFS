import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openRepository } from '@sanxing/database';
import type { ParsedImage } from '@sanxing/contracts';
import { LearningService, type DomainConfig } from '../src/index.ts';

const config: DomainConfig = { mode: 'mock', timezone: 'Asia/Shanghai', maxUploadBytes: 131072, maxDocuments: 5, maxFollowups: 2, quizCount: 3, schedulingEnabled: true, maxCallsPerSession: 20, dailyBudgetUsd: null, requestReservationUsd: 0, runTimeoutMs: 1000 };
const bytes = await readFile(new URL('../../../tests/fixtures/ocr-note.png', import.meta.url));
const parsed: ParsedImage = { text: '校对后的文字。\n独立回忆，检查边界。', import: { format: 'image', parser: 'bbc-ocr', mediaType: 'image/png', width: 900, height: 240, modelId: 'pp-ocrv6-small', engineVersion: 'test', confidence: 0.9, warnings: [], reviewed: true, edited: true } };
it('retains the original image and reviewed text across export/restore and uses only text in learning tasks', async () => {
  const repository = await openRepository(':memory:', 'mock'); const service = new LearningService(repository, config);
  try {
    // Images have a separate upload limit; this remains above the ordinary text/PDF cap.
    const original = Buffer.concat([bytes, Buffer.alloc(config.maxUploadBytes)]);
    const draft = await service.command('image-draft', 'image-draft-key', {}, data => service.createRecitation(data, {}));
    const input = { recitationId: draft.id!, name: 'reviewed.png', text: '' };
    const added = await service.command('image-add', 'image-import-key', input, data => service.addDocument(data, input, original, parsed));
    const data = await repository.read(); const image = data.documents[added.id!]!;
    expect(image.text).toBe(parsed.text); expect(image.import).toEqual(parsed.import); expect(Buffer.from(image.originalBase64, 'base64')).toEqual(original);
    await repository.replace(JSON.parse(JSON.stringify(data))); expect((await repository.read()).documents[image.id]).toEqual(image);
    const saved = await service.command('draft-save', 'image-recite-key', {}, data => service.saveDraft(data, draft.id!, { version: data.recitations[draft.id!]!.version, learned: '今天学习了边界条件。', unclear: '', application: '', topic: '' }));
    const submitted = await service.command('image-submit', 'image-submit-key', {}, data => service.submitRecitation(data, draft.id!, { version: saved.version }));
    const task = (await repository.read()).runs[submitted.runId!]!.task;
    expect(JSON.stringify(task)).toContain(parsed.text.replace('\n', '\\n')); expect(JSON.stringify(task)).not.toContain(image.originalBase64);
  } finally { await repository.close(); }
});
it('rejects images without reviewed OCR metadata or with mismatched media/pixel bounds without partial writes', async () => {
  const repository = await openRepository(':memory:', 'mock'); const service = new LearningService(repository, config);
  try {
    const draft = await service.command('draft', 'new-image-draft', {}, data => service.createRecitation(data, {})); const input = { recitationId: draft.id!, name: 'image.png', text: '' };
    const before = await repository.read();
    await expect(service.command('add', 'no-ocr-metadata', input, data => service.addDocument(data, input, bytes))).rejects.toMatchObject({ code: 'IMAGE_OCR_REQUIRED' });
    for (const metadata of [{ ...parsed.import, reviewed: false }, { ...parsed.import, mediaType: 'image/jpeg' }, { ...parsed.import, width: 40000, height: 40000 }]) await expect(service.command('add', 'invalid-image-key', metadata, data => service.addDocument(data, input, bytes, { ...parsed, import: metadata as ParsedImage['import'] }))).rejects.toThrow();
    expect(await repository.read()).toEqual(before);
  } finally { await repository.close(); }
});
