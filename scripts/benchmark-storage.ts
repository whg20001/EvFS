import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { openRepository } from '@sanxing/database';
import { projectState, searchLibrary, type DomainConfig } from '@sanxing/learning-domain';
import { storageFixture } from './storage-fixture.ts';

const directory = await mkdtemp(join(tmpdir(), 'sanxing-capacity-'));
const config: DomainConfig = { mode: 'mock', timezone: 'Asia/Shanghai', maxUploadBytes: 131072, maxDocuments: 10, maxFollowups: 5, quizCount: 3, schedulingEnabled: true, maxCallsPerSession: 20, dailyBudgetUsd: null, requestReservationUsd: 0, runTimeoutMs: 30000 };
let repository = await openRepository(directory, 'mock');
const measurements: Record<string, { medianMs: number; maxMs: number; samples: number }> = {};
async function measure<T>(name: string, n: number, fn: () => Promise<T> | T): Promise<T> {
  const times: number[] = []; let value!: T;
  for (let i = 0; i < n; i++) { const start = performance.now(); value = await fn(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  measurements[name] = { medianMs: Math.round(times[Math.floor(n / 2)]!), maxMs: Math.round(times.at(-1)!), samples: n };
  return value;
}
try {
  const fixture = storageFixture();
  await measure('restore', 1, () => repository.replace(fixture));
  await repository.close();
  repository = await measure('coldOpen', 1, () => openRepository(directory, 'mock'));
  const state = await measure('initialStateJson', 5, async () => JSON.stringify(projectState(await repository.read(), config, 'synthetic', true)));
  await measure('draftSave', 5, () => repository.transact(data => { data.recitations['recitation-0']!.learned += '.'; data.recitations['recitation-0']!.version++; }));
  await measure('runCompletionWrite', 5, () => repository.transact(data => {
    const run = data.runs['run-quiz-0-q0']!; run.status = 'failed'; run.error = `synthetic ${data.revision}`;
    data.quizzes['quiz-0']!.answers['quiz-0-q0']!.assessment.feedback += '.';
    data.evidence['quiz-0-q0']!.answer = structuredClone(data.quizzes['quiz-0']!.answers['quiz-0-q0']!);
  }));
  await measure('search', 5, async () => searchLibrary(await repository.read(), '缓存失效'));
  const exported = await measure('export', 1, async () => {
    const json = JSON.stringify(await repository.read()); await writeFile(join(directory, 'synthetic-export.json'), json); return json;
  });
  const metadata = { ...fixture, documents: Object.fromEntries(Object.entries(fixture.documents).map(([id, { text, originalBase64, ...rest }]) => [id, rest])), runs: Object.fromEntries(Object.entries(fixture.runs).map(([id, { task, ...rest }]) => [id, rest])) };
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, workload: { knowledge: 1000, documents: 500, days: 365, quizzes: 1095, evidence: 3285, runs: 3285 }, measurements, bytes: { publicState: Buffer.byteLength(state), export: Buffer.byteLength(exported), aggregateV3: Buffer.byteLength(JSON.stringify(metadata)), aggregateV4: Buffer.byteLength(JSON.stringify({ ...metadata, quizzes: Object.fromEntries(Object.keys(fixture.quizzes).map(id => [id, { id }])), evidence: Object.fromEntries(Object.keys(fixture.evidence).map(id => [id, { id }])) })), quizzes: Buffer.byteLength(JSON.stringify(fixture.quizzes)), evidence: Buffer.byteLength(JSON.stringify(fixture.evidence)) }, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }, null, 2));
} finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
