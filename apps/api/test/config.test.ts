import { expect, it } from 'vitest';
import { readConfig } from '../src/config.ts';

const local = { OWNER_PASSWORD: 'configuration-test-password', SESSION_SECRET: 'configuration-test-secret-'.repeat(3) };
it('defaults to browser learning storage and separates cloud identity from the legacy learning directory', () => {
  expect(readConfig({ SESSION_SECRET: local.SESSION_SECRET })).toMatchObject({ storageMode: 'local-first', allowRegistration: true, gatewayDailyCalls: 200 });
  expect(readConfig(local).accountDataDir).not.toBe(readConfig(local).dataDir);
  expect(readConfig({ ...local, APP_STORAGE_MODE: 'server', ALLOW_REGISTRATION: 'false' })).toMatchObject({ storageMode: 'server', allowRegistration: false });
  expect(() => readConfig({ SESSION_SECRET: local.SESSION_SECRET, APP_STORAGE_MODE: 'server' })).toThrow('OWNER_PASSWORD');
  expect(() => readConfig({ ...local, APP_STORAGE_MODE: 'unknown' })).toThrow('APP_STORAGE_MODE');
});
it('keeps the cloud Skill catalog optional and accepts only server-configured HTTP addresses', () => {
  expect(readConfig(local).skillCatalogUrl).toBeUndefined();
  expect(readConfig({ ...local, SKILL_CATALOG_URL: ' https://skills.example.test/catalog.json ', SKILL_CATALOG_TOKEN: ' private-token ' }))
    .toMatchObject({ skillCatalogUrl: 'https://skills.example.test/catalog.json', skillCatalogToken: 'private-token' });
  expect(readConfig({ ...local, SKILL_CATALOG_URL: 'http://localhost:8080/skills/catalog.json' }).skillCatalogUrl).toBe('http://localhost:8080/skills/catalog.json');
  for (const value of ['relative/catalog.json', 'file:///tmp/catalog.json', 'https://user:secret@example.test/catalog.json', 'https://example.test/catalog.json#fragment']) {
    expect(() => readConfig({ ...local, SKILL_CATALOG_URL: value })).toThrow('SKILL_CATALOG_URL');
  }
});
it('defaults to pooled connections and only accepts the explicit fresh diagnostic alternative', () => {
  expect(readConfig(local).connectionPolicy).toBe('pooled');
  expect(readConfig({ ...local, AI_CONNECTION_POLICY: 'fresh' }).connectionPolicy).toBe('fresh');
  for (const value of ['auto', 'false', '', 'PRIVATE']) expect(() => readConfig({ ...local, AI_CONNECTION_POLICY: value })).toThrow('AI_CONNECTION_POLICY');
});
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
it('configures separate quiz, first-response and stream-idle limits without removing the task deadline', () => {
  expect(readConfig(local)).toMatchObject({ runTimeoutMs: 60_000, quizTimeoutMs: 120_000, firstResponseTimeoutMs: 60_000, streamIdleTimeoutMs: 45_000 });
  expect(readConfig({ ...local, AI_RUN_TIMEOUT_MS: '50000', AI_QUIZ_TIMEOUT_MS: '90000', AI_FIRST_RESPONSE_TIMEOUT_MS: '20000', AI_STREAM_IDLE_TIMEOUT_MS: '10000' }))
    .toMatchObject({ runTimeoutMs: 50_000, quizTimeoutMs: 90_000, firstResponseTimeoutMs: 20_000, streamIdleTimeoutMs: 10_000 });
  for (const name of ['AI_QUIZ_TIMEOUT_MS', 'AI_FIRST_RESPONSE_TIMEOUT_MS', 'AI_STREAM_IDLE_TIMEOUT_MS']) {
    for (const value of ['0', '-1', '49', '120001', 'NaN', 'Infinity', '50.5']) expect(() => readConfig({ ...local, [name]: value })).toThrow(name);
  }
});
