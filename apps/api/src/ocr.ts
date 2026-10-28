import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LIMITS, imageMediaType, isImageFilename, imageOcrPreviewSchema, type ImageOcrPreview } from '@sanxing/contracts';
import { DomainError } from '@sanxing/learning-domain';
import type { ApiConfig } from './config.ts';

export type OcrRecognizer = (bytes: Uint8Array, mediaType: string, signal: AbortSignal) => Promise<ImageOcrPreview>;
const confidence = z.number().min(0).max(1).nullable();
const bbcResponse = z.object({
  text: z.string().max(LIMITS.ocrTextChars), ocr: z.object({ model_id: z.string().min(1).max(200), engine_version: z.string().max(100).nullable() }),
  source: z.object({ content_sha256: z.string().regex(/^[a-f0-9]{64}$/), media_type: z.enum(['image/png', 'image/jpeg', 'image/webp']) }),
  document: z.object({ pages: z.array(z.object({ width_px: z.number().int().positive(), height_px: z.number().int().positive(),
    blocks: z.array(z.object({ lines: z.array(z.object({ words: z.array(z.object({ confidence })) })) })).default([]) })).length(1) }),
  quality: z.array(z.object({ markers: z.array(z.string().max(100)).max(20) })).max(1).default([]),
});

/** Existing BBC_OCR synchronous API: no jobs, persisted uploads, learning-model calls, or logging of source text. */
export function createOcrRecognizer(config: ApiConfig): OcrRecognizer {
  return async (bytes, mediaType, signal) => {
    if (!config.ocrServiceUrl) throw new DomainError('OCR_NOT_CONFIGURED', '图片识别服务尚未启用，请联系管理员。', 503);
    const form = new FormData(); form.set('image', new Blob([Uint8Array.from(bytes)], { type: mediaType }), mediaType === 'image/png' ? 'image.png' : mediaType === 'image/jpeg' ? 'image.jpg' : 'image.webp');
    const response = await fetch(new URL('/v1/recognize', config.ocrServiceUrl), { method: 'POST', body: form, redirect: 'error', signal,
      ...(config.ocrServiceToken ? { headers: { Authorization: `Bearer ${config.ocrServiceToken}` } } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 413) throw new DomainError('IMAGE_TOO_LARGE', '图片的文件大小或像素数超过识别服务上限，请缩小后重试。', 413);
      if ([415, 422].includes(response.status)) throw new DomainError('IMAGE_INVALID', '图片无法识别，请重新导出为 PNG、JPEG 或 WebP 后重试。', 400);
      throw new DomainError('OCR_UNAVAILABLE', '图片识别服务暂不可用，请稍后重试。', 503);
    }
    if (!response.body) throw new DomainError('OCR_INVALID_RESPONSE', '未收到有效的识别结果，请重试。', 502);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8 * 1024 * 1024) throw new DomainError('OCR_RESULT_TOO_LARGE', '识别结果过大，请裁剪图片后重试。', 502); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); }
    let payload: z.infer<typeof bbcResponse>;
    try { payload = bbcResponse.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new DomainError('OCR_INVALID_RESPONSE', '识别结果格式无效，请稍后重试。', 502); }
    if (payload.source.content_sha256 !== createHash('sha256').update(bytes).digest('hex') || payload.source.media_type !== mediaType) throw new DomainError('OCR_SOURCE_MISMATCH', '识别结果与本次图片不匹配，请重试。', 502);
    const page = payload.document.pages[0]!;
    if (page.width_px * page.height_px > LIMITS.imagePixels) throw new DomainError('IMAGE_TOO_LARGE', '图片像素超过 4000 万，请缩小后重试。', 413);
    const scores = page.blocks.flatMap(block => block.lines.flatMap(line => line.words.map(word => word.confidence))).filter((score): score is number => score !== null);
    const mean = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
    const markers = new Set(payload.quality.flatMap(page => page.markers)); const warnings: string[] = [];
    if (markers.has('blur_above_threshold')) warnings.push('图片可能较模糊，请仔细核对识别文字。');
    if (markers.has('skew_above_threshold')) warnings.push('图片倾斜较明显，请核对文字的顺序和分行。');
    if (mean !== null && mean < 0.85) warnings.push('部分文字的识别置信度较低，请对照原图校正。');
    return imageOcrPreviewSchema.parse({ text: payload.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(), import: {
      format: 'image', parser: 'bbc-ocr', mediaType: payload.source.media_type, width: page.width_px, height: page.height_px,
      modelId: payload.ocr.model_id, engineVersion: payload.ocr.engine_version, confidence: mean, warnings,
    } });
  };
}

export function registerOcrRoutes(app: FastifyInstance, options: { config: ApiConfig; owner: (request: FastifyRequest) => string; recognizer?: OcrRecognizer }) {
  const { config } = options; const recognize = options.recognizer ?? createOcrRecognizer(config);
  const active = new Map<string, AbortController>(); const attempts = new Map<string, { count: number; expires: number }>();
  app.get('/api/ocr/status', () => ({ enabled: !!options.recognizer || !!config.ocrServiceUrl, provider: 'BBC_OCR', maxBytes: LIMITS.imageUploadBytes, maxPixels: LIMITS.imagePixels, formats: ['PNG', 'JPEG', 'WebP'] }));
  app.post('/api/ocr/recognize', async (request, reply) => {
    if (!options.recognizer && !config.ocrServiceUrl) throw new DomainError('OCR_NOT_CONFIGURED', '图片识别服务尚未启用，请联系管理员。', 503);
    const owner = options.owner(request); const now = Date.now();
    for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
    const attempt = attempts.get(owner) ?? { count: 0, expires: now + 15 * 60000 };
    if (attempt.count >= 30) throw new DomainError('OCR_RATE_LIMIT', '图片识别过于频繁，请稍后重试。', 429);
    if (active.has(owner) || active.size >= 2) throw new DomainError('OCR_BUSY', '图片识别正在处理中，请稍后重试。', 429);
    attempts.set(owner, { ...attempt, count: attempt.count + 1 });
    if (attempts.size > 5000) attempts.delete(attempts.keys().next().value!);
    const controller = new AbortController(); active.set(owner, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.ocrTimeoutMs)]);
    const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', disconnected); request.raw.once('aborted', disconnected);
    try {
      if (!request.isMultipart()) throw new DomainError('IMAGE_REQUIRED', '请通过文件上传提交 PNG、JPEG 或 WebP 图片。', 400);
      const file = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: LIMITS.imageUploadBytes } });
      if (!file || file.fieldname !== 'file' || !isImageFilename(file.filename)) throw new DomainError('IMAGE_REQUIRED', '请选择 PNG、JPEG 或 WebP 图片。', 400);
      const bytes = await file.toBuffer();
      if (file.file.truncated || bytes.byteLength > LIMITS.imageUploadBytes) throw new DomainError('IMAGE_TOO_LARGE', '图片不能超过 10 MB。', 413);
      const mediaType = imageMediaType(bytes); if (!mediaType) throw new DomainError('IMAGE_INVALID', '文件内容不是有效的 PNG、JPEG 或 WebP 图片。', 400);
      const result = await recognize(bytes, mediaType, signal); signal.throwIfAborted();
      return imageOcrPreviewSchema.parse(result);
    } catch (error) {
      if (signal.aborted) throw new DomainError('OCR_TIMEOUT', controller.signal.aborted ? '已停止等待识别结果。' : '图片识别超时，请裁剪图片后重试。', 504);
      if (error instanceof DomainError) throw error;
      if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) throw new DomainError('IMAGE_TOO_LARGE', '图片不能超过 10 MB。', 413);
      throw new DomainError('OCR_UNAVAILABLE', '图片识别服务暂不可用，请稍后重试。', 503);
    } finally { active.delete(owner); reply.raw.off('close', disconnected); request.raw.off('aborted', disconnected); }
  });
  app.addHook('onClose', async () => { for (const controller of active.values()) controller.abort(); active.clear(); attempts.clear(); });
}
