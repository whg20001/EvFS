import { defineConfig, devices } from '@playwright/test';
import { apiOrigin, webOrigin, sessionSecret } from './tests/e2e/settings.ts';

export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/*.spec.ts', testIgnore: '**/local-first.spec.ts', fullyParallel: false, workers: 1, retries: 0, forbidOnly: !!process.env.CI,
  timeout: 120_000, expect: { timeout: 20_000 }, reporter: 'list',
  use: { baseURL: webOrigin, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: [
    { command: 'node --import tsx tests/e2e/server.ts', url: `${apiOrigin}/api/health`, env: { SESSION_SECRET: sessionSecret }, reuseExistingServer: false, timeout: 90_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
    { command: `npm run code-runner:build && node apps/web/server.mjs --hostname 127.0.0.1 --port ${new URL(webOrigin).port}`, url: `${webOrigin}/login`,
      env: { API_INTERNAL_URL: apiOrigin, SESSION_SECRET: sessionSecret, NEXT_TELEMETRY_DISABLED: '1', SANXING_NEXT_PROFILE: 'e2e' }, reuseExistingServer: false, timeout: 180_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  ],
});
