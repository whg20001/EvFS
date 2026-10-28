import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { DomainConfig } from '@sanxing/learning-domain';
import { LIMITS, connectionPolicySchema, type ConnectionPolicy } from '@sanxing/contracts';
import { LIVE_PROVIDER_IDS, type LiveProviderId } from '@sanxing/ai-access/providers';

export interface ApiConfig extends DomainConfig {
  ocrServiceUrl?: string; ocrServiceToken?: string; ocrTimeoutMs: number;
  adminUsernames: string[];
  port: number; host: string; appOrigin: string; allowedOrigins: string[]; ownerPassword: string; sessionSecret: string; dataDir: string;
  provider?: LiveProviderId; model?: string; apiKey?: string; maxOutputTokens: number;
  connectionPolicy?: ConnectionPolicy;
  modelAuthMethod: 'api_key' | 'oauth'; allowUnboundedOAuthOutput: boolean; aiAuthDir: string;
  skillCatalogUrl?: string; skillCatalogToken?: string;
  storageMode: 'local-first' | 'server'; accountDataDir: string; allowRegistration: boolean; gatewayDailyCalls: number; registrationLimit: number;
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
  const connectionPolicy = connectionPolicySchema.safeParse(env.AI_CONNECTION_POLICY ?? 'pooled');
  if (!connectionPolicy.success) throw new Error('AI_CONNECTION_POLICY must be pooled or fresh');
  const modelAuthMethod = env.MODEL_AUTH_METHOD ?? 'api_key';
  if (modelAuthMethod !== 'api_key' && modelAuthMethod !== 'oauth') throw new Error('MODEL_AUTH_METHOD must be api_key or oauth');
  if (env.NODE_ENV === 'production' && mode !== 'live') throw new Error('Production requires explicitly configured live mode. Mock is development-only.');
  const storageMode = env.APP_STORAGE_MODE ?? 'local-first';
  if (storageMode !== 'local-first' && storageMode !== 'server') throw new Error('APP_STORAGE_MODE must be local-first or server');
  const ownerPassword = env.OWNER_PASSWORD ?? ''; const sessionSecret = env.SESSION_SECRET ?? '';
  if ((storageMode === 'server' && ownerPassword.length < 12) || sessionSecret.length < 32) throw new Error('Configure SESSION_SECRET (32+ chars); server storage additionally needs OWNER_PASSWORD (12+ chars).');
  const appOrigin = env.APP_ORIGIN ?? 'http://127.0.0.1:3010';
  const allowedOrigins = [...new Set([appOrigin, ...(env.APP_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)])];
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.hostname.includes('*')) throw new Error('APP_ORIGIN and APP_ALLOWED_ORIGINS must be exact HTTP(S) origins without paths, wildcards or trailing slashes');
  }
  const timezone = env.USER_TIMEZONE ?? 'Asia/Shanghai'; new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date());
  const skillCatalogUrl = env.SKILL_CATALOG_URL?.trim();
  const ocrServiceUrl = env.OCR_SERVICE_URL?.trim();
  if (ocrServiceUrl) {
    const url = new URL(ocrServiceUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('OCR_SERVICE_URL must be an HTTP(S) origin without credentials or paths');
  }
  if (skillCatalogUrl) {
    let url: URL;
    try { url = new URL(skillCatalogUrl); } catch { throw new Error('Invalid SKILL_CATALOG_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('SKILL_CATALOG_URL must be an HTTP(S) catalog URL without embedded credentials or fragments');
  }
  // Live may start unconfigured so the owner can select a model in the UI.
  // An omitted budget means no application spending cap, never a zero-cost claim.
  const hasBudget = Boolean(env.AI_BUDGET_PER_USER_DAY?.trim());
  const hasReservation = Boolean(env.AI_REQUEST_RESERVATION_USD?.trim());
  if (hasBudget !== hasReservation) throw new Error('Set both budget variables, or omit both to run without an application budget.');
  const dailyBudgetUsd = hasBudget ? positive('AI_BUDGET_PER_USER_DAY', 1) : null;
  const requestReservationUsd = hasBudget ? positive('AI_REQUEST_RESERVATION_USD', 0.1) : 0;
  if (mode === 'live' && modelAuthMethod === 'oauth' && env.MODEL_API_KEY) throw new Error('Remove MODEL_API_KEY when using OAuth; authentication methods must not silently override one another.');
  if (env.MODEL_BASE_URL) throw new Error('Custom endpoints are not implemented yet; do not silently ignore MODEL_BASE_URL.');
  return { mode, timezone, connectionPolicy: connectionPolicy.data, port: integer('API_PORT', 4000, 1, 65535), host: env.API_HOST ?? '127.0.0.1', appOrigin, allowedOrigins, ownerPassword, sessionSecret,
    ocrTimeoutMs: integer('OCR_TIMEOUT_MS', 120000, 1000, LIMITS.ocrRequestTimeoutMs - 10000), ...(ocrServiceUrl ? { ocrServiceUrl, ...(env.OCR_SERVICE_TOKEN?.trim() ? { ocrServiceToken: env.OCR_SERVICE_TOKEN.trim() } : {}) } : {}),
    adminUsernames: [...new Set((env.ADMIN_USERNAMES ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))],
    storageMode, accountDataDir: resolve(projectRoot, env.ACCOUNT_DATA_DIR ?? 'data/cloud-accounts'), allowRegistration: env.ALLOW_REGISTRATION !== 'false', gatewayDailyCalls: integer('GATEWAY_DAILY_CALLS', 200, 1, 10000), registrationLimit: integer('AUTH_REGISTRATIONS_PER_15_MIN', 5, 1, 1000),
    dataDir: resolve(projectRoot, env.DATA_DIR ?? `data/${mode}`),
    aiAuthDir: resolve(projectRoot, env.AI_AUTH_DIR ?? 'data/ai-auth'), modelAuthMethod,
    ...(skillCatalogUrl ? { skillCatalogUrl, ...(env.SKILL_CATALOG_TOKEN?.trim() ? { skillCatalogToken: env.SKILL_CATALOG_TOKEN.trim() } : {}) } : {}),
    allowUnboundedOAuthOutput: env.AI_ALLOW_UNBOUNDED_OAUTH_OUTPUT === 'true',
    maxUploadBytes: integer('UPLOAD_MAX_BYTES', LIMITS.uploadBytes, 1, LIMITS.uploadBytesMaximum), maxDocuments: integer('UPLOAD_MAX_COUNT', LIMITS.documents, 1, LIMITS.documentsMaximum),
    maxFollowups: integer('AI_MAX_FOLLOWUPS', LIMITS.followups, 1, LIMITS.followupsMaximum), quizCount: integer('AI_QUIZ_COUNT', LIMITS.quizQuestions, 1, LIMITS.quizQuestionsMaximum),
    maxCallsPerSession: integer('AI_MAX_CALLS_PER_SESSION', 20, 1, 100), dailyBudgetUsd, requestReservationUsd,
    runTimeoutMs: integer('AI_RUN_TIMEOUT_MS', 60_000, 50, 120_000), maxOutputTokens: integer('AI_MAX_OUTPUT_TOKENS', 4096, 256, 8192),
    quizTimeoutMs: integer('AI_QUIZ_TIMEOUT_MS', 120_000, 50, 120_000),
    firstResponseTimeoutMs: integer('AI_FIRST_RESPONSE_TIMEOUT_MS', 60_000, 50, 120_000),
    streamIdleTimeoutMs: integer('AI_STREAM_IDLE_TIMEOUT_MS', 45_000, 50, 120_000),
    schedulingEnabled: mode === 'mock' || env.REVIEW_SCHEDULING_ENABLED === 'true',
    ...(provider ? { provider } : {}), ...(env.MODEL_ID ? { model: env.MODEL_ID } : {}), ...(env.MODEL_API_KEY ? { apiKey: env.MODEL_API_KEY } : {}) };
}
