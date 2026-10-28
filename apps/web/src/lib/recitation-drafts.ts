import type { PublicState, Recitation } from '@sanxing/contracts';

/** Submitting creates a session; saved content without a session stays a draft across dates. */
export function recitationDrafts(data: Pick<PublicState, 'recitations' | 'sessions'>): Recitation[] {
  const submitted = new Set(data.sessions.map(session => session.recitationId));
  return data.recitations.filter(recitation => !submitted.has(recitation.id) && (
    recitation.documentIds.length > 0 || [recitation.topic, recitation.learned, recitation.unclear, recitation.application].some(text => text.trim())
  )).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.learningDate.localeCompare(a.learningDate) || a.id.localeCompare(b.id));
}
