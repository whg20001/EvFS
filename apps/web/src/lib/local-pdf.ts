import { LIMITS, pdfImportErrorMessage, type PdfFailureDetails, type PdfImport } from '@sanxing/contracts';
import { DomainError } from '@sanxing/learning-domain';

export async function parseLocalPdf(bytes: Uint8Array, onProgress?: (completed: number, total: number) => void): Promise<{ text: string; import: PdfImport }> {
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new DomainError('PDF_INVALID', '无法读取此 PDF。');
  const { getDocument, GlobalWorkerOptions, version } = await import('pdfjs-dist');
  GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  const maxPages = LIMITS.pdfPages, maxChars = LIMITS.pdfTextChars;
  let task: ReturnType<typeof getDocument> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const parse = async () => {
    task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true,
      useWorkerFetch: true, useSystemFonts: false, useWasm: false, enableXfa: false,
      cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/' });
    const document = await task.promise;
    if (document.numPages > maxPages) throw { code: 'PDF_PAGE_LIMIT', details: { pages: document.numPages } };
    onProgress?.(0, document.numPages);
    const pages = []; const parts = []; let chars = 0; let line = 1; let anyText = false; let items = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const reader = page.streamTextContent().getReader();
      let text = ''; let y: number | undefined;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (!('str' in item)) continue;
          if (++items > maxChars * 2) throw { code: 'PDF_TEXT_COMPLEXITY', details: { page: number } };
          if (y !== undefined && Math.abs(item.transform[5] - y) > 2 && text && !text.endsWith('\n')) text += '\n';
          text += item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') + (item.hasEOL ? '\n' : ' ');
          y = item.transform[5];
          if (chars + text.length > maxChars) throw { code: 'PDF_TEXT_LIMIT', details: { page: number, characters: chars + text.length } };
        }
      }
      text = text.replace(/\r\n?/g, '\n').split('\n').map(row => row.trimEnd()).join('\n').trim();
      const hasText = /[\p{L}\p{N}]/u.test(text); anyText ||= hasText;
      const block = `[PDF 第 ${number} 页]\n${text || '[本页未提取到文本，可能为空白或需要 OCR]'}\n`;
      chars += block.length; if (chars > maxChars) throw { code: 'PDF_TEXT_LIMIT', details: { page: number, characters: chars } };
      const lines = block.split('\n').length - 1;
      pages.push({ page: number, startLine: line, endLine: line + lines - 1, hasText });
      line += lines; parts.push(block); page.cleanup(); onProgress?.(number, document.numPages);
    }
    if (!anyText) throw { code: 'PDF_OCR_REQUIRED' };
    return { text: parts.join('').trimEnd(), import: { format: 'pdf' as const, parser: `pdfjs-dist@${version}`, pages } };
  };
  try { return await Promise.race([parse(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('PDF_TIMEOUT')), LIMITS.pdfParseTimeoutMs); })]); }
  catch (error) {
    const raw = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : '';
    const code = typeof raw === 'string' && /^PDF_(PAGE_LIMIT|TEXT_LIMIT|TEXT_COMPLEXITY|OCR_REQUIRED|TIMEOUT)$/.test(raw) ? raw : error instanceof Error && error.name === 'PasswordException' ? 'PDF_PASSWORD_REQUIRED' : 'PDF_INVALID';
    const details = error && typeof error === 'object' && 'details' in error ? error.details as PdfFailureDetails : undefined;
    throw new DomainError(code, pdfImportErrorMessage(code, details));
  } finally { clearTimeout(timeout); await task?.destroy(); }
}
