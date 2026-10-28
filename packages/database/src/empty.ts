import type { AppData, Mode } from '@sanxing/contracts';

export function emptyData(mode: Mode): AppData {
  if (mode !== 'mock' && mode !== 'live') throw new Error('Invalid database mode');
  return { schemaVersion: 1, ownerId: 'local', mode, revision: 0, aiModel: null,
    recitations: {}, documents: {}, sessions: {}, knowledge: {}, quizzes: {}, cards: {},
    reviewSessions: {}, reviewEvents: {}, evidence: {}, runs: {}, receipts: {} };
}
