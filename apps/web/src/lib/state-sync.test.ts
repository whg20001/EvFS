import { expect, test } from 'vitest';
import type { PublicState, PublicStateUpdate } from '@sanxing/contracts';
import { reconcileState } from './state-sync';

function state(revision = 1): PublicState {
  return { mode: 'mock', timezone: 'UTC', revision, csrfToken: 'token',
    capabilities: { maxUploadBytes: 100, maxDocuments: 5, maxFollowups: 3, quizCount: 3, schedulingEnabled: false },
    recitations: [], documents: [{ id: 'a', recitationId: 'r', name: 'a.md', lineCount: 1, createdAt: '2026-10-24T00:00:00.000Z' }],
    sessions: [], knowledge: [], quizzes: [], cards: [], reviewSessions: [], reviewEvents: [], evidence: [], runs: [] };
}
test('unchanged snapshots preserve identity, while CSRF rotation updates the token', () => {
  const base = state();
  expect(reconcileState(base, base, { kind: 'unchanged', revision: 1, csrfToken: 'token' })).toBe(base);
  expect(reconcileState(base, base, { kind: 'unchanged', revision: 1, csrfToken: 'new' })).toEqual({ ...base, csrfToken: 'new' });
  expect(reconcileState(base, base, { kind: 'unchanged', revision: 2, csrfToken: 'new' })).toBeNull();
});
test('merges upserts/removals immutably and preserves untouched collection references', () => {
  const base = state();
  const next = reconcileState(base, base, { kind: 'delta', fromRevision: 1, revision: 2, csrfToken: 'new', changes: {
    documents: { remove: ['a'], upsert: [{ ...base.documents[0]!, id: 'b' }] },
  } })!;
  expect(next.documents.map(d => d.id)).toEqual(['b']);
  expect(base.documents.map(d => d.id)).toEqual(['a']);
  expect(next.knowledge).toBe(base.knowledge);
  expect(next.revision).toBe(2); expect(next.csrfToken).toBe('new');
});
test('requires a fresh baseline for a late delta, even when the revision matches', () => {
  const base = state();
  const delta: PublicStateUpdate = { kind: 'delta', fromRevision: 1, revision: 3, csrfToken: 'token', changes: {} };
  expect(reconcileState(state(), base, delta)).toBeNull();
  expect(reconcileState(state(2), base, delta)).toBeNull();
  expect(reconcileState(base, base, { ...delta, fromRevision: 0 })).toBeNull();
  expect(reconcileState(null, null, delta)).toBeNull();
  const current = state(3);
  expect(reconcileState(current, base, delta)).toBe(current);
});
test('accepts full snapshots and refuses late or regressive revisions', () => {
  const base = state(3); const next = state(4);
  expect(reconcileState(null, null, next)).toBe(next);
  expect(reconcileState(base, base, { kind: 'snapshot', state: next })).toBe(next);
  expect(reconcileState(base, base, state(2))).toBe(base);
  expect(reconcileState(base, base, { kind: 'delta', fromRevision: 3, revision: 2, csrfToken: 'old', changes: { documents: { remove: ['a'], upsert: [] } } })).toBe(base);
});
