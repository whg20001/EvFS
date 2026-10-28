import type { AiModelConfiguration } from './ai-access.ts';
import type { Mode } from './index.ts';

export type AccountIdentity = { id: string; username: string; role?: 'user' | 'admin' };
export type AuthStatus = { authenticated: boolean; mode: Mode; storage?: 'browser' | 'server'; user?: AccountIdentity | null; registrationEnabled?: boolean; csrfToken?: string; expiresAt?: number };
export type LocalLearningConfig = {
  mode: Mode; timezone: string; maxUploadBytes: number; maxDocuments: number; maxFollowups: number; quizCount: number;
  schedulingEnabled: boolean; maxCallsPerSession: number; dailyBudgetUsd: number | null; requestReservationUsd: number;
  runTimeoutMs: number; quizTimeoutMs?: number; firstResponseTimeoutMs?: number; streamIdleTimeoutMs?: number;
};
export type LocalBootstrap = { user: AccountIdentity; config: LocalLearningConfig; csrfToken: string; expiresAt: number;
  configuration: AiModelConfiguration; maxOutputTokens: number; prompts: Record<string, string> };
