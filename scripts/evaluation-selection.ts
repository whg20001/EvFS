import { evaluationCases } from '@sanxing/learning-agent/evaluations';

/** Explicit subsets create a new evaluation batch; they never replay a previous run ID. */
export function selectEvaluationCases(options: { cases?: string; offset?: string; limit?: string }) {
  if (options.cases !== undefined) {
    if (options.offset !== undefined || options.limit !== undefined) throw new Error('Use --cases or --offset/--limit, not both');
    const ids = options.cases.split(',').map(id => id.trim());
    if (ids.length > evaluationCases.length || new Set(ids).size !== ids.length) throw new Error('Case IDs must be unique and remain within the frozen suite');
    return ids.map(id => {
      const item = evaluationCases.find(item => item.id === id);
      if (!item) throw new Error('Unknown evaluation case ID');
      return item;
    });
  }
  const offset = Number(options.offset ?? 0); const limit = Number(options.limit ?? 30);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || offset + limit > evaluationCases.length) throw new Error('offset + limit must remain within the 30 frozen cases');
  return evaluationCases.slice(offset, offset + limit);
}
