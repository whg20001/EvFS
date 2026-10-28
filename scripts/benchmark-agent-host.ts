import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { openRepository, type Repository } from '@sanxing/database';
import { LearningService, RunWorker } from '@sanxing/learning-domain';
import { describeLearningPrompt } from '@sanxing/learning-agent';
import { AiModelRuntime } from '../apps/api/src/ai-runtime.ts';
import { readConfig } from '../apps/api/src/config.ts';
import { storageFixture } from './storage-fixture.ts';

// Synthetic host work only: no env file, OAuth store or network/model request.
const output = process.argv[2];
if (!output) throw new Error('Provide a new output JSON path');
const directory = await mkdtemp(join(tmpdir(), 'sanxing-agent-host-'));
const repository = await openRepository(directory, 'mock');
const measurements: { elapsedMs: number; preparationMs: number | null; savingMs: number | null; fullReads: number; transactions: number }[] = [];
let fullReads = 0;
const counted: Repository = { ...repository,
  read: async () => { fullReads++; return repository.read(); },
};
const config = readConfig({ OWNER_PASSWORD: 'benchmark-offline-only', SESSION_SECRET: 'benchmark-offline-only-'.repeat(3), AI_MODE: 'mock' });
const engine = new AiModelRuntime({ config, repository: counted, engineFactory: () => ({ mode: 'mock', async execute(task, options) {
  if (task.kind !== 'extract') throw new Error('Unexpected benchmark task');
  options.onProgress?.('request'); options.onProgress?.('response'); options.onProgress?.('text');
  const usage = { provider: 'offline', model: 'host-only', inputTokens: 10, outputTokens: 5, cost: 0 };
  options.onProgress?.('generated'); options.onProgress?.('validated');
  await options.onUsage?.(usage);
  return { output: { kind: 'extract', candidates: [{ title: 'Benchmark', description: 'Synthetic host execution', sourceIds: [task.sources[0]!.id] }] }, usage };
} }) });
const service = new LearningService(counted, config, undefined, undefined, describeLearningPrompt);
const worker = new RunWorker(service, engine);
try {
  await repository.replace(storageFixture());
  for (let i = 0; i < 6; i++) {
    const queued = await repository.transact(data => {
      const draft = service.createRecitation(data, { learningDate: `2030-01-${String(i + 1).padStart(2, '0')}` });
      service.saveDraft(data, draft.id!, { version: 1, learned: 'A queue removes entries in insertion order.', unclear: '', application: '', topic: '' });
      return service.submitRecitation(data, draft.id!, { version: 2 });
    });
    const before = await repository.revision(); fullReads = 0;
    const started = performance.now(); await worker.tick(); const elapsedMs = Math.round(performance.now() - started);
    const reads = fullReads; const commits = (await repository.revision()) - before;
    const progress = (await repository.read()).runs[queued.runId!]!.progress;
    if (i > 0) measurements.push({ elapsedMs, preparationMs: progress?.requestStartedMs ?? null,
      savingMs: progress?.completedMs !== undefined && progress.saveStartedMs !== undefined ? progress.completedMs - progress.saveStartedMs : null,
      fullReads: reads, transactions: commits });
  }
  const sorted = measurements.map(row => row.elapsedMs).sort((a, b) => a - b);
  const report = { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, network: false,
    workload: { knowledge: 1000, documents: 500, historicalRuns: 3285, warmup: 1, measuredRuns: measurements.length },
    measurements, medianMs: sorted[Math.floor(sorted.length / 2)]!, maxMs: sorted.at(-1)! };
  await writeFile(resolve(output), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { await worker.stop(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
