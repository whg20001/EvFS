import { z } from 'zod';
import { LIMITS } from './limits.ts';

export function isImageFilename(name: string): boolean { return /\.(png|jpe?g|webp)$/i.test(name); }
export function imageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
const ocrMetadataSchema = z.strictObject({
  format: z.literal('image'), parser: z.literal('bbc-ocr'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive().max(LIMITS.imagePixels), height: z.number().int().positive().max(LIMITS.imagePixels),
  modelId: z.string().min(1).max(200), engineVersion: z.string().max(100).nullable(),
  confidence: z.number().min(0).max(1).nullable(), warnings: z.array(z.string().min(1).max(200)).max(20),
});
export const imageImportSchema = ocrMetadataSchema.extend({ reviewed: z.literal(true), edited: z.boolean() }).strict().refine(value => value.width * value.height <= LIMITS.imagePixels);
export type ImageImport = z.infer<typeof imageImportSchema>;
export const imageOcrPreviewSchema = z.strictObject({ text: z.string().max(LIMITS.ocrTextChars), import: ocrMetadataSchema }).refine(value => value.import.width * value.import.height <= LIMITS.imagePixels);
export type ImageOcrPreview = z.infer<typeof imageOcrPreviewSchema>;
export const imageImportInputSchema = z.strictObject({ text: z.string().max(LIMITS.ocrTextChars), import: imageImportSchema });
export type ParsedImage = z.infer<typeof imageImportInputSchema>;
