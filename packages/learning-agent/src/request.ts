import { readFileSync } from 'node:fs';
import { createLearningRequests } from './request-core.ts';
export { LearningEngineError, INPUT_SAFETY_MARGIN_TOKENS, CONNECTION_TEST_OUTPUT_TOKENS } from './request-core.ts';
export type { LearningRequestOptions, PreparedLearningRequest } from './request-core.ts';
export const learningPrompts = Object.fromEntries(['common', 'scope', 'extract', 'followup', 'quiz', 'grade', 'connection_test'].map(name => [name, readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8')]));
export const { describeLearningPrompt, assertLearningPrompt, prepareLearningRequest, inspectLearningRequest, checkLearningRequest, fitsLearningRequest } = createLearningRequests(learningPrompts);
