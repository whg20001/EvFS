import { expect, test } from 'vitest';
import type { LearningSession, Recitation } from '@sanxing/contracts';
import { recitationDrafts } from './recitation-drafts';

const recitation = (id: string, changes: Partial<Recitation> = {}): Recitation => ({
  id, learningDate: '2026-10-26', version: 1, topic: '', learned: '', unclear: '', application: '', documentIds: [],
  createdAt: '2026-10-26T10:00:00.000Z', updatedAt: '2026-10-26T10:00:00.000Z', ...changes,
});
const session = (recitationId: string, status: LearningSession['status']): LearningSession => ({
  id: `session-${recitationId}`, recitationId, snapshot: { topic: '', learned: '已提交', unclear: '', application: '' },
  status, documentIds: [], scopeVersion: 1, version: 1, candidates: [], turns: [], quizId: null, activeRunId: null,
  completionReason: null, createdAt: '2026-10-27T10:00:00.000Z', completedAt: null,
});

test('keeps unfinished writing and attachment-only records across dates, without creating blank drafts', () => {
  const recitations = [
    recitation('blank'), recitation('whitespace', { learned: ' \n', topic: ' ' }),
    recitation('old', { learningDate: '2025-01-01', learned: '前一天没来得及发出' }),
    recitation('topic', { topic: '主题也应保留' }), recitation('unclear', { unclear: '待解问题' }),
    recitation('application', { application: '待补的实践思路' }), recitation('attachment', { documentIds: ['document'] }),
  ];
  expect(recitationDrafts({ recitations, sessions: [] }).map(item => item.id).sort()).toEqual(['application', 'attachment', 'old', 'topic', 'unclear']);
});

test('removes submitted recitations from the draft box while retaining active and completed learning history', () => {
  const recitations = ['draft', 'confirming', 'asking', 'completed'].map(id => recitation(id, { learned: '已保存的复述' }));
  const sessions = [session('confirming', 'CONFIRMING'), session('asking', 'CLARIFYING'), session('completed', 'COMPLETED')];
  expect(recitationDrafts({ recitations, sessions }).map(item => item.id)).toEqual(['draft']);
  expect(recitations).toHaveLength(4); expect(sessions).toHaveLength(3);
});

test('orders by latest edit without mutating the source, and reads only the supplied account/mode state', () => {
  const old = recitation('old', { learned: '旧草稿' });
  const updated = recitation('updated', { learned: '刚编辑过的旧草稿', updatedAt: '2026-10-28T10:00:00.000Z' });
  const current = recitation('current', { learningDate: '2026-10-27', learned: '当天草稿' });
  const recitations = [old, updated, current];
  expect(recitationDrafts({ recitations, sessions: [] }).map(item => item.id)).toEqual(['updated', 'current', 'old']);
  expect(recitations).toEqual([old, updated, current]);
  expect(recitationDrafts({ recitations: [], sessions: [] })).toEqual([]);
});
