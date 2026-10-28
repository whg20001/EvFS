import type { AiTask, GeneratedQuestion, SkillSnapshot } from '@sanxing/contracts';

// Synthetic inputs fixed before the task-schema refactor. No personal data or credentials.
export const contractSkill: SkillSnapshot = { id: '00000000-0000-4000-8000-000000000001', version: 2,
  name: 'boundary-examples', description: '使用边界例子帮助学习', instructions: '用一个简短反例检查适用条件，保持题目与评分标准。' };
const sources = [{ id: 's1', name: '笔记', text: '缓存空结果能减少对不存在键的重复查询；需要设置 TTL，并在新增数据后失效。' }];
const point = { id: 'k1', title: '空值缓存', description: sources[0]!.text, sourceIds: ['s1'], knowledgeVersion: 1 };
const related = [{ id: 'k2', title: '缓存过期', description: '超过 TTL 后重新查询。', knowledgeVersion: 1 }];
const turns = [{ id: 'turn1', question: '什么时候需要失效？', answer: '新增数据后', feedback: '还需要有限 TTL。', assisted: false, scopeVersion: 2 },
  { id: 'turn2', question: 'TTL 有什么作用？', answer: null, feedback: null, assisted: false, scopeVersion: 2 }];
const question: GeneratedQuestion & { knowledgeVersion: number | null } = { kind: 'code', knowledgeId: 'k1', knowledgeVersion: 1,
  prompt: '实现判断缓存是否到期的函数。', options: [], correctIndex: null, referenceAnswer: 'function expired(now, due) { return now >= due; }',
  rubric: [{ id: 'r1', description: '正确判断边界', maxScore: 2 }], sourceIds: ['s1'], relatedKnowledgeIds: ['k2'],
  code: { language: 'javascript', starter: 'function expired(now, due) { /* TODO */ }', tests: [{ name: '到期边界', code: 'assertEqual(expired(10, 10), true);' }] } };
const recitation = { learned: '空值缓存减少重复请求😀', unclear: 'TTL 怎样选', application: '保护数据库', topic: '缓存' };
export const taskContractCases: { id: string; task: AiTask }[] = [
  { id: 'connection', task: { kind: 'connection_test', selection: { providerId: 'openai', modelId: 'synthetic-model', authMethod: 'api_key', allowUnboundedOutput: false } } },
  { id: 'extract-legacy', task: { kind: 'extract', recitation, sources } },
  { id: 'extract-skills', task: { kind: 'extract', recitation, sources, skills: [contractSkill] } },
  { id: 'followup-empty-skills', task: { kind: 'followup', points: [{ ...point, knowledgeVersion: null }], sources, turns, related, skills: [] } },
  { id: 'followup-skills', task: { kind: 'followup', points: [point], sources, turns, related, skills: [contractSkill] } },
  { id: 'quiz-context', task: { kind: 'quiz', points: [point], sources, count: 2, recall: '刚才的独立回忆', turns, related,
    weaknesses: [{ question: '旧题', weakAreas: ['遗漏 TTL'], score: 1, maxScore: 2, dimension: 'delayed' }], code: { languages: ['javascript', 'python'] }, skills: [contractSkill] } },
  { id: 'grade-code', task: { kind: 'grade', question, answer: question.referenceAnswer, execution: { ranAt: '2026-10-23T00:00:00.000Z', status: 'passed', passed: 1, total: 1, output: 'ok', durationMs: 5 }, skills: [contractSkill] } },
  { id: 'grade-legacy', task: { kind: 'grade', question: { ...question, knowledgeVersion: null }, answer: '旧答案' } },
];
