import { isImageFilename } from './image.ts';
import { LIMITS } from './limits.ts';
const formats = { md: 'markdown', markdown: 'markdown', txt: 'text' } as const;
function extensionFormat(name: string) {
  const extension = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(formats, extension) ? formats[extension as keyof typeof formats] : undefined;
}
/** Uploads require an explicit supported suffix; old extensionless documents remain readable. */
export function isDocumentFilename(name: string): boolean { return extensionFormat(name) !== undefined; }
export function isPdfFilename(name: string): boolean { return /\.pdf$/i.test(name); }
export function isUploadFilename(name: string): boolean { return isDocumentFilename(name) || isPdfFilename(name) || isImageFilename(name); }
/** Binary attachments have their own caps; the configurable note limit applies only to text. */
export function documentUploadLimit(name: string, maxTextBytes: number): number {
  return isPdfFilename(name) ? LIMITS.pdfUploadBytes : isImageFilename(name) ? LIMITS.imageUploadBytes : maxTextBytes;
}
export type PdfFailureDetails = { pages?: number; page?: number; characters?: number };
/** Both import paths explain content limits independently of the original file's byte limit. */
export function pdfImportErrorMessage(code: string, details: PdfFailureDetails = {}): string {
  const limit = LIMITS.pdfTextChars.toLocaleString('zh-CN');
  const atPage = details.page ? `解析到第 ${details.page} 页时，` : '';
  const messages: Record<string, string> = {
    PDF_PAGE_LIMIT: `${details.pages ? `此 PDF 共 ${details.pages} 页，` : 'PDF 页数'}超过单次导入上限 ${LIMITS.pdfPages} 页。请按页拆分后导入；20 MB 是文件大小上限，不是页数上限。`,
    PDF_TEXT_LIMIT: `${atPage}提取文字${details.characters ? `已达到 ${details.characters.toLocaleString('zh-CN')} 字符，` : ''}超过单次导入上限 ${limit} 字符（含空白和页标记）。请按章节拆分后导入；20 MB 是文件大小上限。`,
    PDF_TEXT_COMPLEXITY: `${atPage}PDF 的文字结构过于复杂，请按章节拆分或导出为 TXT 后导入。`,
    PDF_OCR_REQUIRED: '没有提取到可用文字。扫描型 PDF 请先导出为图片，再使用图片识别导入。',
    PDF_PASSWORD_REQUIRED: 'PDF 已加密，请先在本地解密，再上传。',
    PDF_TIMEOUT: 'PDF 解析超时，请拆分文件或导出为 TXT 后上传。',
    PDF_INVALID: '无法读取此 PDF，请检查文件是否完整，或导出为 TXT 后上传。',
  };
  return messages[code] ?? messages.PDF_INVALID!;
}
export interface PdfImport {
  format: 'pdf';
  parser: string;
  pages: { page: number; startLine: number; endLine: number; hasText: boolean }[];
}
export type DocumentImport = PdfImport | import('./image.ts').ImageImport;
export function documentFormat(name: string): 'markdown' | 'text' { return extensionFormat(name) ?? (name.includes('.') ? 'text' : 'markdown'); }
