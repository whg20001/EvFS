export interface PerformanceCount { count: number; fullScore: number; score: number; maxScore: number }
export interface LearningStatistics {
  revision: number;
  fromDate: string | null;
  throughDate: string;
  timezone: string;
  simulated: boolean;
  total: number;
  categories: { independent: number; assisted: number; skipped: number; pending: number; verification: number; manual: number };
  performance: { immediate: PerformanceCount; delayed: PerformanceCount };
  /** Current assessments of submitted quizzes only; every included answer can be inspected. */
  records: { evidenceId: string; quizId: string; questionId: string; knowledgeId: string; title: string; category: keyof LearningStatistics['categories']; dimension: 'immediate' | 'delayed'; submittedAt: string; assessmentVersion: number; score: number | null; maxScore: number }[];
  losses: { knowledgeId: string; title: string; description: string; count: number; lostScore: number; evidenceIds: string[] }[];
  due: { overdue: number; days: { date: string; count: number }[]; later: number; paused: number; archived: number };
  reviews: { completed: number; scheduled: number; abandoned: number };
}
