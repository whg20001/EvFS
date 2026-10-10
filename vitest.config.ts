import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'apps/web/src/**/*.test.ts'], exclude: ['pi/**', 'node_modules/**'], environment: 'node', fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 60000 } });
