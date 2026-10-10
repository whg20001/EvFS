import * as z from 'zod/mini';
import { LIMITS } from './limits.ts';

export const CODE_LANGUAGES = ['python', 'javascript', 'typescript'] as const;
export const codeLanguageSchema = z.enum(CODE_LANGUAGES);
export type CodeLanguage = z.infer<typeof codeLanguageSchema>;
export const DEFAULT_CODE_LANGUAGES: readonly CodeLanguage[] = ['python'];
/** Shared with the frame; Mini uses the same Zod checks without the fluent API bundle. */
export const codeExerciseSchema = z.object({
  language: codeLanguageSchema, starter: z.string().check(z.minLength(1), z.maxLength(LIMITS.codeStarterChars)),
  tests: z.array(z.object({ name: z.string().check(z.minLength(1), z.maxLength(200)), code: z.string().check(z.minLength(1), z.maxLength(LIMITS.codeTestChars)) })).check(z.minLength(1), z.maxLength(LIMITS.codeTestsMaximum)),
});
export type CodeExercise = z.infer<typeof codeExerciseSchema>;
/** Browser-reported evidence is never verified by the server. */
export const codeExecutionSchema = z.object({
  ranAt: z.iso.datetime(),
  status: z.enum(['passed', 'failed', 'error', 'timeout']), passed: z.int().check(z.minimum(0), z.maximum(LIMITS.codeTestsMaximum)),
  total: z.int().check(z.minimum(1), z.maximum(LIMITS.codeTestsMaximum)), output: z.string().check(z.maxLength(LIMITS.codeOutputChars)), durationMs: z.int().check(z.minimum(0), z.maximum(LIMITS.codeDurationMsMaximum)),
}).check(z.refine(run => run.passed <= run.total && (run.status !== 'passed' || run.passed === run.total) && (run.status !== 'failed' || run.passed < run.total), { message: '运行状态与测试通过数不一致' }));
export type CodeExecution = z.infer<typeof codeExecutionSchema>;
