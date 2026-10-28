import type { z } from 'zod';
import type { learningPreferencesSchema } from './index.ts';

export type LearningPreferences = z.infer<typeof learningPreferencesSchema>;
export interface LearningPreferencesView extends Required<LearningPreferences> {
  revision: number;
  source: 'saved' | 'environment';
}
export interface LibraryHit {
  kind: 'document' | 'knowledge';
  id: string;
  title: string;
  excerpt: string;
  score: number;
  startLine: number;
  endLine: number;
  contentVersion: number | null;
  field?: 'content' | 'understanding';
  pages?: number[];
}
export interface LibrarySearchResult {
  hits: LibraryHit[];
  strategy: 'local-bm25-v1' | 'local-bm25-terms-v1';
  total: number;
  offset: number;
  nextOffset: number | null;
  revision: number;
  expandedTerms: string[];
  /** Empty/stopword-only queries do not silently return the entire library. */
  query: string;
}
