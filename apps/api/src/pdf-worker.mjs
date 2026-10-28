import { parentPort, workerData } from 'node:worker_threads';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs';

// All input is local bytes; built-in fonts/CMaps are read from the installed package.
// PDF actions, JavaScript, attachments, images and links are never executed or rendered.
globalThis.fetch = async () => { throw new Error('Network access is disabled during PDF import'); };
const root = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const { bytes, maxPages, maxChars } = workerData;
let task;
try {
  task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true,
    useWorkerFetch: false, useSystemFonts: false, useWasm: false, enableXfa: false,
    cMapUrl: join(root, 'cmaps') + sep, cMapPacked: true, standardFontDataUrl: join(root, 'standard_fonts') + sep });
  const document = await task.promise;
  if (document.numPages > maxPages) throw { code: 'PDF_PAGE_LIMIT', details: { pages: document.numPages } };
  const pages = []; const parts = []; let chars = 0; let line = 1; let anyText = false; let items = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const reader = page.streamTextContent().getReader();
    let text = ''; let y;
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
    line += lines; parts.push(block); page.cleanup();
  }
  if (!anyText) throw { code: 'PDF_OCR_REQUIRED' };
  parentPort.postMessage({ text: parts.join('').trimEnd(), import: { format: 'pdf', parser: `pdfjs-dist@${version}`, pages } });
} catch (error) {
  parentPort.postMessage({ error: error?.code?.startsWith('PDF_') ? error.code : error?.name === 'PasswordException' ? 'PDF_PASSWORD_REQUIRED' : 'PDF_INVALID',
    ...(['PDF_PAGE_LIMIT', 'PDF_TEXT_LIMIT', 'PDF_TEXT_COMPLEXITY'].includes(error?.code) ? { details: error.details } : {}) });
} finally { await task?.destroy(); }
