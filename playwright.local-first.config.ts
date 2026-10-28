import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({ ...base, testMatch: '**/local-first.spec.ts', testIgnore: [], webServer: [
  { ...servers[0]!, command: 'node --import tsx tests/e2e/local-first-server.ts' }, ...servers.slice(1),
] });
