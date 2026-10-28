import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { modelAiTaskSchema, storedAiTaskSchema } from '@sanxing/contracts';
import { taskContractCases } from '../../../tests/fixtures/task-contract.ts';
import { evaluationCases } from '../evaluations/cases.ts';
import { describeLearningPrompt, inspectLearningRequest } from './request.ts';

// Captured before consolidation, including the original system/output schemas.
// An intentional prompt change needs its own version/compatibility decision.
const baseline = JSON.parse(readFileSync(new URL('../../../tests/fixtures/task-prompt-baseline.json', import.meta.url), 'utf8')) as Record<string, {
  version: string; hash: string; inputBytes: number; userChars: number;
}>;
it.each([...taskContractCases, ...evaluationCases])('keeps $id prompts byte-identical through storage and SDK validation', ({ id, task }) => {
  const stored = storedAiTaskSchema.parse(JSON.parse(JSON.stringify(task)));
  const model = modelAiTaskSchema.parse(stored);
  for (const input of [task, stored, model]) {
    const request = inspectLearningRequest(input, { maxOutputTokens: 4096 });
    expect({ ...describeLearningPrompt(input), inputBytes: request.estimatedInputTokens, userChars: request.prompt.length }).toEqual(baseline[id]);
  }
});
