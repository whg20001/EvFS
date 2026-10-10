import * as z from 'zod/mini';
import { LIMITS } from '@sanxing/contracts/limits';
import { codeExerciseSchema, codeExecutionSchema } from '@sanxing/contracts/code';
import { MESSAGE_CHARS_MAXIMUM, PROTOCOL, type RunRequest, type RunResult } from './protocol.ts';

const id = z.uuid();
export const requestSchema = z.object({ protocol: z.literal(PROTOCOL), type: z.literal('run'), id, text: z.string().check(z.maxLength(LIMITS.answerChars)), exercise: codeExerciseSchema }) satisfies z.ZodMiniType<RunRequest>;
const testResultSchema = z.object({ name: z.string().check(z.maxLength(200)), passed: z.boolean(), error: z.optional(z.string().check(z.maxLength(500))) });
const resultSchema = z.object({ execution: codeExecutionSchema, tests: z.array(testResultSchema).check(z.maxLength(LIMITS.codeTestsMaximum)) }) satisfies z.ZodMiniType<RunResult>;
export const responseSchema = z.discriminatedUnion('type', [
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('ready') }),
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('started'), id }),
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('output'), id, output: z.string().check(z.maxLength(LIMITS.codeOutputChars)) }),
  z.object({ protocol: z.literal(PROTOCOL), type: z.literal('result'), id, result: resultSchema }),
]);
export function decode<T>(schema: z.ZodMiniType<T>, value: unknown): T | null {
  if (typeof value !== 'string' || value.length > MESSAGE_CHARS_MAXIMUM) return null;
  try { const parsed = schema.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : null; } catch { return null; }
}
