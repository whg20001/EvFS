/** Reviewed lexical aliases only. Changing this table changes local-bm25-terms-v1, not AI source authorization. */
export const SEARCH_TERMS = [
  ['fifo', 'first in first out', '先进先出'],
  ['lifo', 'last in first out', '后进先出'],
  ['dp', 'dynamic programming', '动态规划'],
  ['bfs', 'breadth first search', '广度优先搜索'],
  ['dfs', 'depth first search', '深度优先搜索'],
  ['binary search', '二分查找', '折半查找'],
  ['memoization', '记忆化', '记忆化搜索'],
  ['cache', '缓存'],
  ['hash table', '哈希表', '散列表'],
  ['standard deviation', '标准差'],
] as const;
export function expandSearchTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  const matches = (term: string) => /[a-z]/.test(term)
    ? new RegExp(`(?:^|[^a-z0-9])${term}(?=$|[^a-z0-9])`).test(normalized)
    : normalized.includes(term);
  return [...new Set(SEARCH_TERMS.filter(group => group.some(matches)).flatMap(group => [...group]).filter(term => !matches(term)))];
}
