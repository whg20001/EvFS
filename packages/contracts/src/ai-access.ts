import { z } from 'zod';
import type { Mode, RunStatus, Usage, RunErrorCode } from './index.ts';

/** Browser-safe views only. OAuth credentials and submitted codes never belong here. */
export type OAuthSessionStatus = 'starting' | 'waiting' | 'working' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export interface OAuthSessionView {
  id: string; providerId: string; status: OAuthSessionStatus;
  url: string | null; instructions: string | null;
  input: { id: string; type: 'text' | 'secret' | 'select' | 'manual_code'; label: string; placeholder: string; allowEmpty: boolean; options?: { id: string; label: string; description?: string }[] } | null;
  error: string | null; expiresAt: string;
}
export interface AiProviderView {
  id: string; name: string; connected: boolean; expiresAt: string | null;
  oauthAvailable: boolean; session: OAuthSessionView | null; notice?: string;
}
export interface AiAccessOverview {
  mode: Mode; providers: AiProviderView[];
  notice: string;
}
export const aiModelSelectionSchema = z.strictObject({
  providerId: z.string().min(1).max(100), modelId: z.string().min(1).max(200),
  authMethod: z.enum(['oauth', 'api_key', 'platform']), allowUnboundedOutput: z.boolean(),
});
export type AiModelSelection = z.infer<typeof aiModelSelectionSchema>;
export interface AiModelProvider {
  platformAvailable?: boolean;
  id: string; name: string; oauthConnected: boolean; apiKeyAvailable: boolean;
  requiresOAuthOutputAcknowledgement: boolean;
  models: { id: string; name: string; contextWindow?: number; maxTokens?: number }[];
}
export interface AiModelConfiguration {
  platform?: import('./admin.ts').PlatformAiPublic;
  mode: Mode; revision: number; selection: AiModelSelection | null;
  source: 'saved' | 'environment' | 'none'; ready: boolean; problem: string | null;
  budget: { enabled: boolean; dailyUsd: number | null; reservationUsd: number | null };
  providers: AiModelProvider[];
}
export interface AiConnectionTestView {
  id: string; providerId: string; modelId: string; mode: Mode; status: RunStatus;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  durationMs: number | null; usage: Usage | null; error: string | null; errorCode?: RunErrorCode;
}
export interface TokenUsageTotals {
  /** Input already includes cache read/write tokens; do not add cache again. */
  inputTokens: number; outputTokens: number; totalTokens: number;
  attempts: number; knownUsageAttempts: number; unknownUsageAttempts: number;
}
export interface TokenUsageDay extends TokenUsageTotals { date: string; level: 0 | 1 | 2 | 3 | 4 }
export interface TokenUsageHeatmap {
  mode: Mode; timezone: string; year: number; availableYears: number[];
  totals: TokenUsageTotals; days: TokenUsageDay[];
  /** Already included in inputTokens. Old runs may not have cache-specific counters. */
  cache?: { readTokens: number; writeTokens: number; unknownAttempts: number };
}
