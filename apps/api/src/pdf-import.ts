import { Worker } from 'node:worker_threads';
import { LIMITS, pdfImportErrorMessage, type PdfFailureDetails, type PdfImport } from '@sanxing/contracts';
import { DomainError } from '@sanxing/learning-domain';

export interface ParsedPdf { text: string; import: PdfImport }
/** One bounded parser per app; parsing never holds a database transaction or blocks the API event loop. */
export function createPdfImporter() {
  let active: Worker | null = null;
  return {
    close: async () => { await active?.terminate(); },
    parse: async (bytes: Uint8Array): Promise<ParsedPdf> => {
      if (active) throw new DomainError('PDF_IMPORT_BUSY', '正在解析另一份 PDF，请稍后重试。', 409);
      if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new DomainError('PDF_INVALID', pdfImportErrorMessage('PDF_INVALID'));
      const worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), { workerData: { bytes, maxPages: LIMITS.pdfPages, maxChars: LIMITS.pdfTextChars },
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true });
      active = worker;
      // Parser diagnostics may quote source text; do not forward them to app logs.
      worker.stdout.resume(); worker.stderr.resume();
      try {
        return await new Promise<ParsedPdf>((resolve, reject) => {
          const fail = (code: string, details?: PdfFailureDetails) => reject(new DomainError(code, pdfImportErrorMessage(code, details)));
          const timer = setTimeout(() => fail('PDF_TIMEOUT'), LIMITS.pdfParseTimeoutMs);
          worker.once('message', (result: ParsedPdf | { error: string; details?: PdfFailureDetails }) => { clearTimeout(timer); if ('error' in result) fail(result.error, result.details); else resolve(result); });
          worker.once('error', () => { clearTimeout(timer); fail('PDF_INVALID'); });
          worker.once('exit', () => { clearTimeout(timer); fail('PDF_INVALID'); });
        });
      } finally { await worker.terminate(); if (active === worker) active = null; }
    },
  };
}
