import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { DomainConfig } from '@sanxing/learning-domain';
import { LIMITS } from '@sanxing/contracts';
import { LIVE_PROVIDER_IDS, type LiveProviderId } from '@sanxing/ai-access/providers';

export interface ApiConfig extends DomainConfig {
  port: number; host: string; appOrigin: string; allowedOrigins: string[]; ownerPassword: string; sessionSecret: string; dataDir: string;
  provider?: LiveProviderId; model?: string; apiKey?: string; maxOutputTokens: number;
  modelAuthMethod: 'api_key' | 'oauth'; allowUnboundedOAuthOutput: boolean; aiAuthDir: string;
}
export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function loadEnvironment() {
  const path = resolve(projectRoot, '.env'); if (existsSync(path)) process.loadEnvFile(path);
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const integer = (name: string, fallback: number, min = 1, max = 1_000_000) => {
    const value = Number(env[name] ?? fallback); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`); return value;
  };
  const positive = (name: string, fallback: number) => { const value = Number(env[name] ?? fallback); if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`); return value; };
  const mode = env.AI_MODE ?? 'mock'; if (mode !== 'mock' && mode !== 'live') throw new Error('AI_MODE must be mock or live');
  const provider = env.MODEL_PROVIDER as LiveProviderId | undefined;
  if (provider !== undefined && !LIVE_PROVIDER_IDS.includes(provider)) throw new Error(`Unsupported explicit MODEL_PROVIDER; currently ${LIVE_PROVIDER_IDS.join(', ')} are supported.`);
  const modelAuthMethod = env.MODEL_AUTH_METHOD ?? 'api_key';
  if (modelAuthMethod !== 'api_key' && modelAuthMethod !== 'oauth') throw new Error('MODEL_AUTH_METHOD must be api_key or oauth');
  if (env.NODE_ENV === 'production' && mode !== 'live') throw new Error('Production requires explicitly configured live mode. Mock is development-only.');
  const ownerPassword = env.OWNER_PASSWORD ?? ''; const sessionSecret = env.SESSION_SECRET ?? '';
  if (ownerPassword.length < 12 || sessionSecret.length < 32) throw new Error('Run npm run setup first, or configure OWNER_PASSWORD (12+ chars) and SESSION_SECRET (32+ chars).');
  const appOrigin = env.APP_ORIGIN ?? 'http://127.0.0.1:3010';
  const allowedOrigins = [...new Set([appOrigin, ...(env.APP_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)])];
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.hostname.includes('*')) throw new Error('APP_ORIGIN and APP_ALLOWED_ORIGINS must be exact HTTP(S) origins without paths, wildcards or trailing slashes');
  }
  const timezone = env.USER_TIMEZONE ?? 'Asia/Shanghai'; new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date());
  // Live may start unconfigured so the owner can select a model in the UI.
  // An omitted budget means no application spending cap, never a zero-cost claim.
  const hasBudget = Boolean(env.AI_BUDGET_PER_USER_DAY?.trim());
  const hasReservation = Boolean(env.AI_REQUEST_RESERVATION_USD?.trim());
  if (hasBudget !== hasReservation) throw new Error('Set both budget variables, or omit both to run without an application budget.');
  const dailyBudgetUsd = hasBudget ? positive('AI_BUDGET_PER_USER_DAY', 1) : null;
  const requestReservationUsd = hasBudget ? positive('AI_REQUEST_RESERVATION_USD', 0.1) : 0;
  if (mode === 'live' && modelAuthMethod === 'oauth' && env.MODEL_API_KEY) throw new Error('Remove MODEL_API_KEY when using OAuth; authentication methods must not silently override one another.');
  if (env.MODEL_BASE_URL) throw new Error('Custom endpoints are not implemented yet; do not silently ignore MODEL_BASE_URL.');
  return { mode, timezone, port: integer('API_PORT', 4000, 1, 65535), host: env.API_HOST ?? '127.0.0.1', appOrigin, allowedOrigins, ownerPassword, sessionSecret,
    dataDir: resolve(projectRoot, env.DATA_DIR ?? `data/${mode}`),
    aiAuthDir: resolve(projectRoot, env.AI_AUTH_DIR ?? 'data/ai-auth'), modelAuthMethod,
    allowUnboundedOAuthOutput: env.AI_ALLOW_UNBOUNDED_OAUTH_OUTPUT === 'true',
    maxUploadBytes: integer('UPLOAD_MAX_BYTES', LIMITS.uploadBytes, 1, LIMITS.uploadBytesMaximum), maxDocuments: integer('UPLOAD_MAX_COUNT', LIMITS.documents, 1, LIMITS.documentsMaximum),
    maxFollowups: integer('AI_MAX_FOLLOWUPS', LIMITS.followups, 1, LIMITS.followupsMaximum), quizCount: integer('AI_QUIZ_COUNT', LIMITS.quizQuestions, 1, LIMITS.quizQuestionsMaximum),
    maxCallsPerSession: integer('AI_MAX_CALLS_PER_SESSION', 20, 1, 100), dailyBudgetUsd, requestReservationUsd,
    runTimeoutMs: integer('AI_RUN_TIMEOUT_MS', 60_000, 50, 120_000), maxOutputTokens: integer('AI_MAX_OUTPUT_TOKENS', 4096, 256, 8192),
    schedulingEnabled: mode === 'mock' || env.REVIEW_SCHEDULING_ENABLED === 'true',
    ...(provider ? { provider } : {}), ...(env.MODEL_ID ? { model: env.MODEL_ID } : {}), ...(env.MODEL_API_KEY ? { apiKey: env.MODEL_API_KEY } : {}) };
}
