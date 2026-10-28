import { z } from 'zod';

export const accountRoleSchema = z.enum(['user', 'admin']);
export const accountStatusSchema = z.enum(['active', 'disabled']);
export const activityModuleSchema = z.enum(['home', 'recite', 'recitation', 'drafts', 'review', 'knowledge', 'history', 'library', 'ai-access', 'local-data', 'week', 'weak', 'session', 'quiz', 'admin', 'other']);
export type ActivityModule = z.infer<typeof activityModuleSchema>;
export const managedUserSchema = z.strictObject({
  role: accountRoleSchema, status: accountStatusSchema, platformAccess: z.boolean(), dailyLimit: z.number().int().min(1).max(10000).nullable(),
  expectedVersion: z.number().int().nonnegative(), newPassword: z.string().min(12).max(128).optional(),
});
export type ManagedUserUpdate = z.infer<typeof managedUserSchema>;
export type AdminUser = {
  id: string; username: string; role: 'user' | 'admin'; status: 'active' | 'disabled'; version: number;
  createdAt: string; lastLoginAt: string | null; lastActiveAt: string | null; lastModule: string | null;
  dailyLimit: number | null; platformAccess: boolean; callsToday: number; online: boolean;
};
export type AdminUsers = { items: AdminUser[]; total: number; page: number; pageSize: number };
export type AdminActivity = { id: string; username: string; type: string; module: string | null; createdAt: string };
export type AdminCall = { username: string; source: 'personal' | 'platform'; status: string; provider: string; model: string; createdAt: string;
  durationMs: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
export type AdminAudit = { id: string; actor: string; target: string | null; action: string; createdAt: string };
export type AdminActivities = { items: AdminActivity[]; calls: AdminCall[]; audits: AdminAudit[]; total: number; page: number; pageSize: number };
export type AdminOverview = {
  users: number; disabledUsers: number; onlineUsers: number; activeToday: number; registrationsToday: number;
  callsToday: number; failedToday: number; runningCalls: number; platformCallsToday: number;
  inputTokens: number; outputTokens: number; knownUsageCalls: number; costUsd: number; knownCostCalls: number;
  series: { date: string; calls: number; failed: number; activeUsers: number }[]; recent: AdminActivity[]; timezone: string; mode: 'mock' | 'live';
};
export const platformAiSettingsSchema = z.strictObject({
  enabled: z.boolean(), label: z.string().trim().min(1).max(60), providerId: z.string().max(100), modelId: z.string().max(200),
  perUserDailyCalls: z.number().int().min(1).max(10000), globalDailyCalls: z.number().int().min(1).max(1000000), maxConcurrent: z.number().int().min(1).max(100),
});
export type PlatformAiSettings = z.infer<typeof platformAiSettingsSchema>;
export const platformAiSaveSchema = platformAiSettingsSchema.extend({ expectedRevision: z.number().int().nonnegative(), apiKey: z.string().trim().min(1).max(4096).optional(), clearKey: z.boolean().optional() }).strict();
export type PlatformAiView = PlatformAiSettings & { revision: number; keyConfigured: boolean; keySource: 'saved' | 'environment' | 'none'; mode: 'mock' | 'live'; providers: { id: string; name: string; models: { id: string; name: string }[] }[] };
export type PlatformAiPublic = { label: string; available: boolean; message: string; perUserDailyCalls: number };
export type ServerSample = { at: string; cpuPercent: number; memoryPercent: number; processRssBytes: number; eventLoopDelayMs: number };
export type ServerMetrics = {
  sampledAt: string; startedAt: string; uptimeSeconds: number; cpuCores: number; totalMemoryBytes: number; usedMemoryBytes: number;
  processRssBytes: number; heapUsedBytes: number; heapTotalBytes: number; loadAverage: number[]; cpuPercent: number;
  eventLoopDelayMs: number; activeRequests: number; sessions: number; history: ServerSample[];
};
