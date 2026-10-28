import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openRepository } from '@sanxing/database';
import { createApp } from '../apps/api/src/app.ts';
import { readConfig } from '../apps/api/src/config.ts';
import { storageFixture } from './storage-fixture.ts';

// Real HTTP handlers and repository, synthetic data only. Never loads .env or a Provider.
const output = process.argv[2];
if (!output) throw new Error('Provide a new output JSON path');
const directory = await mkdtemp(join(tmpdir(), 'sanxing-read-benchmark-'));
const repository = await openRepository(directory, 'mock');
let fullReads = 0;
const config = readConfig({ AI_MODE: 'mock', OWNER_PASSWORD: 'benchmark-only', SESSION_SECRET: 'read-benchmark-only-'.repeat(4) });
const app = await createApp({ config, repository: { ...repository, read: async () => { fullReads++; return repository.read(); } },
  engine: { mode: 'mock', async execute() { throw new Error('Benchmark must never call a model'); } }, startWorker: false,
  now: () => new Date('2026-12-31T12:00:00.000Z') });
try {
  const data = storageFixture(); await repository.replace(data);
  const login = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  if (login.statusCode !== 200) throw new Error('Synthetic login failed');
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin };
  const routes = [
    { name: 'document', url: '/api/documents/document-0' },
    { name: 'documentOriginal', url: '/api/documents/document-0/original' },
    { name: 'quiz', url: '/api/quizzes/quiz-0' },
    { name: 'preferences', url: '/api/learning/preferences' },
    { name: 'skills', url: '/api/ai/skills' },
    { name: 'evidencePage', url: '/api/knowledge-points/knowledge-0/evidence?limit=5' },
    { name: 'statistics', url: '/api/learning/statistics?days=0' },
    { name: 'reviewPlan', url: '/api/reviews/plan' },
    { name: 'search', url: '/api/library/search', payload: { query: '缓存失效', limit: 20 } },
  ];
  const measurements = [];
  for (const route of routes) {
    const samplesMs: number[] = []; const readCounts: number[] = []; let hash = ''; let bytes = 0;
    for (let i = 0; i < 13; i++) {
      fullReads = 0; const start = performance.now();
      const response = await app.app.inject({ method: route.payload ? 'POST' : 'GET', url: route.url, headers, ...(route.payload ? { payload: route.payload } : {}) });
      const elapsed = performance.now() - start;
      if (response.statusCode !== 200) throw new Error(`${route.name}: HTTP ${response.statusCode}`);
      const nextHash = createHash('sha256').update(response.rawPayload).digest('hex');
      if (hash && hash !== nextHash) throw new Error(`${route.name}: response changed between samples`);
      hash = nextHash; bytes = response.rawPayload.length;
      if (i >= 3) { samplesMs.push(Number(elapsed.toFixed(3))); readCounts.push(fullReads); }
    }
    const sorted = [...samplesMs].sort((a, b) => a - b);
    measurements.push({ name: route.name, samplesMs, medianMs: Number(((sorted[4]! + sorted[5]!) / 2).toFixed(3)), maxMs: sorted.at(-1), fullReads: readCounts, responseBytes: bytes, responseSha256: hash });
  }
  const report = { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, network: false,
    workload: { knowledge: 1000, documents: 500, quizzes: 1095, evidence: 3285, runs: 3285, warmupPerRoute: 3, samplesPerRoute: 10 }, measurements };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: resolve(output), measurements: measurements.map(({ name, medianMs, fullReads }) => ({ name, medianMs, fullReads: fullReads[0] })) }));
} finally { await app.app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
