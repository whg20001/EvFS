import { expect, it } from 'vitest';
import { readConfig } from '../src/config.ts';

const local = { OWNER_PASSWORD: 'configuration-test-password', SESSION_SECRET: 'configuration-test-secret-'.repeat(3) };
it('lets an unconfigured live installation start without imposing a default budget or model', () => {
  const config = readConfig({ ...local, AI_MODE: 'live' });
  expect(config).toMatchObject({ mode: 'live', dailyBudgetUsd: null, requestReservationUsd: 0, maxCallsPerSession: 20, runTimeoutMs: 60000, maxOutputTokens: 4096, schedulingEnabled: false });
  expect(config.provider).toBeUndefined(); expect(config.model).toBeUndefined(); expect(config.apiKey).toBeUndefined();
  expect(config.allowUnboundedOAuthOutput).toBe(false);
});
it('preserves optional explicit budget controls and rejects incomplete or invalid configurations', () => {
  expect(readConfig({ ...local, AI_MODE: 'live', AI_BUDGET_PER_USER_DAY: '2', AI_REQUEST_RESERVATION_USD: '0.2' })).toMatchObject({ dailyBudgetUsd: 2, requestReservationUsd: 0.2 });
  expect(() => readConfig({ ...local, AI_BUDGET_PER_USER_DAY: '2' })).toThrow(/both budget/);
  expect(() => readConfig({ ...local, AI_REQUEST_RESERVATION_USD: '0.2' })).toThrow(/both budget/);
  for (const value of ['0', '-1', 'NaN', 'Infinity']) expect(() => readConfig({ ...local, AI_BUDGET_PER_USER_DAY: value, AI_REQUEST_RESERVATION_USD: '0.2' })).toThrow(/Invalid/);
  expect(readConfig({ ...local, AI_BUDGET_PER_USER_DAY: '', AI_REQUEST_RESERVATION_USD: '' }).dailyBudgetUsd).toBeNull();
});
it('does not remove time, output or per-session safeguards when the budget is disabled', () => {
  expect(() => readConfig({ ...local, AI_MODE: 'live', AI_RUN_TIMEOUT_MS: '9999999' })).toThrow(/AI_RUN_TIMEOUT_MS/);
  expect(() => readConfig({ ...local, AI_MODE: 'live', AI_MAX_CALLS_PER_SESSION: '9999999' })).toThrow(/AI_MAX_CALLS_PER_SESSION/);
  expect(() => readConfig({ ...local, AI_MODE: 'live', AI_MAX_OUTPUT_TOKENS: '9999999' })).toThrow(/AI_MAX_OUTPUT_TOKENS/);
});
it('accepts setup before OAuth/model selection but retains explicit authentication and endpoint checks', () => {
  expect(readConfig({ ...local, AI_MODE: 'live', MODEL_AUTH_METHOD: 'oauth' }).model).toBeUndefined();
  expect(() => readConfig({ ...local, AI_MODE: 'live', MODEL_AUTH_METHOD: 'oauth', MODEL_API_KEY: 'test-key' })).toThrow(/Remove MODEL_API_KEY/);
  expect(() => readConfig({ ...local, MODEL_BASE_URL: 'https://unapproved.invalid' })).toThrow(/Custom endpoints/);
  expect(() => readConfig({ ...local, NODE_ENV: 'production', AI_MODE: 'mock' })).toThrow(/Production/);
});
