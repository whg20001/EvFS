import { LIMITS } from '@sanxing/contracts/limits';
import type { CodeExercise, CodeExecution } from '@sanxing/contracts';

export const PROTOCOL = 'sanxing-code-v1';
export const MESSAGE_CHARS_MAXIMUM = 65_536;
export const RUN_TIMEOUT_MS = 10_000;
export const LOAD_TIMEOUT_MS = 90_000;
export const HARD_TIMEOUT_MS = LOAD_TIMEOUT_MS + RUN_TIMEOUT_MS + 5_000;
export type RunRequest = { protocol: typeof PROTOCOL; type: 'run'; id: string; text: string; exercise: CodeExercise };
export type RunResult = { execution: CodeExecution; tests: { name: string; passed: boolean; error?: string }[] };

export function runResult(request: RunRequest, status: CodeExecution['status'], output: string, durationMs: number, tests: RunResult['tests'] = []): RunResult {
  return { execution: { ranAt: new Date().toISOString(), status, passed: tests.filter(test => test.passed).length, total: request.exercise.tests.length, output: output.slice(0, LIMITS.codeOutputChars), durationMs: Math.min(LIMITS.codeDurationMsMaximum, Math.max(0, Math.round(durationMs))) }, tests };
}
export function failedResult(request: RunRequest, status: 'error' | 'timeout', output: string, durationMs: number): RunResult {
  return runResult(request, status, output, durationMs);
}
