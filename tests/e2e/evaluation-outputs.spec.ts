import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { expect, test } from '@playwright/test';
import type { AiResponse } from '@sanxing/contracts';
import type { CodeRunner } from '../../apps/web/src/lib/code-runner.ts';

test('frozen GPT code questions: references pass, starters and known wrong answers do not', async ({ page }) => {
  // Replays only recorded synthetic code in the existing browser sandbox. No model calls.
  const report = JSON.parse(await readFile(new URL('../../docs/evaluations/results/gpt-6.1-sol-2026-10-21-unattempted.json', import.meta.url), 'utf8')) as { results: { response: AiResponse | null }[] };
  const questions = report.results.flatMap(row => row.response?.output.kind === 'quiz' ? row.response.output.questions.filter(question => question.kind === 'code') : []);
  expect(questions).toHaveLength(2);
  const bundled = await build({ stdin: { contents: "import { CodeRunner } from './apps/web/src/lib/code-runner'; window.recordedEvaluationRunner = new CodeRunner();", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.goto('/login'); await page.addScriptTag({ content: bundled.outputFiles![0]!.text });
  for (const question of questions) {
    const spec = question.code!;
    const reference = question.referenceAnswer.split(spec.language === 'python' ? '\n\n要点' : '\nSet')[0]!;
    const wrong = spec.language === 'python' ? 'def mean(values):\n    return values[len(values) // 2] if values else 0' : 'function uniqueInOrder(values) { return [...new Set(values)].sort((a, b) => a - b); }';
    const execute = (text: string) => page.evaluate(({ text, spec }) => (window as unknown as { recordedEvaluationRunner: CodeRunner }).recordedEvaluationRunner.run(text, spec), { text, spec });
    expect((await execute(reference))?.execution).toMatchObject({ status: 'passed', passed: spec.tests.length });
    expect((await execute(spec.starter))?.execution.passed).toBe(0);
    expect((await execute(wrong))?.execution.status).not.toBe('passed');
  }
});
