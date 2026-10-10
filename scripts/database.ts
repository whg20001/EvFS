import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { emptyData, openRepository, readBackupWithoutMigration } from '@sanxing/database';
import { validateData } from '../packages/database/src/validation.ts';
import { loadEnvironment, projectRoot } from '../apps/api/src/config.ts';

// Explicit CLI targets (including isolated tests) need no private dotenv file.
if (!process.env.AI_MODE || !process.env.DATA_DIR) loadEnvironment();
const mode = process.env.AI_MODE ?? 'mock';
if (mode !== 'mock' && mode !== 'live') throw new Error('AI_MODE must be mock or live');
const directory = resolve(projectRoot, process.env.DATA_DIR ?? `data/${mode}`);
const [operation, ...args] = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--'));
if (!operation || !['migrate', 'export', 'import', 'delete'].includes(operation)) throw new Error('Use migrate | export <file> | import <file> --confirm | delete --confirm');
if (args.some(arg => arg.startsWith('--') && arg !== '--confirm' && arg !== '--before-migration') || args.filter(arg => !arg.startsWith('--')).length > 1) throw new Error('Unexpected argument');
if (args.includes('--before-migration') && operation !== 'export') throw new Error('--before-migration is only valid for export');
if ((operation === 'export' || operation === 'import') && !file) throw new Error('A backup file path is required');
if ((operation === 'delete' || operation === 'import') && !args.includes('--confirm')) throw new Error('This replaces local data. Stop the API, back up first, then explicitly pass --confirm.');
if ((operation === 'delete' || operation === 'migrate') && args.some(arg => arg !== '--confirm')) throw new Error('This operation does not take a file argument');

if (operation === 'export' && args.includes('--before-migration')) {
  const data = await readBackupWithoutMigration(directory, mode);
  await writeFile(resolve(file!), `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`Exported (${mode}) before schema migration to ${resolve(file!)}. Private plain JSON; no schema upgrade or model call was performed.`);
} else {
const repository = await openRepository(directory, mode);
try {
  if (operation === 'migrate') console.log(`Database is ready (${mode}): ${directory}`);
  if (operation === 'export') {
    await writeFile(resolve(file!), `${JSON.stringify(await repository.read(), null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`Exported all local records (${mode}) to ${resolve(file!)}. This plain JSON contains private notes and answers; keep it private.`);
  }
  if (operation === 'import') {
    if ((await stat(resolve(file!))).size > 256 * 1024 * 1024) throw new Error('Backup exceeds this MVP import limit (256 MiB). No data was replaced.');
    const data: unknown = JSON.parse(await readFile(resolve(file!), 'utf8'));
    validateData(data, mode, emptyData(mode).ownerId);
    // A restored pending job might already have incurred cost after the backup.
    // Never replay it automatically. Preserve its input for explicit retry.
    for (const run of Object.values(data.runs)) if (run.status === 'pending' || run.status === 'running') {
      run.status = 'failed'; run.attemptId = null; run.finishedAt = new Date().toISOString();
      run.error = 'BACKUP_RESTORED: restored requests require explicit retry; previous charges may be unknown.';
    }
    for (const session of [...Object.values(data.sessions), ...Object.values(data.reviewSessions)]) session.activeRunId = null;
    for (const quiz of Object.values(data.quizzes)) for (const answer of Object.values(quiz.answers)) if (answer.assessment.status === 'pending') {
      answer.assessment.status = 'needs_verification'; answer.assessment.score = null;
      answer.assessment.feedback = '备份恢复后未自动重放评分请求，请显式重试或保留为待核对。';
    }
    await repository.replace(data);
    console.log(`Restored (${mode}): ${directory}. No model was called. Unfinished tasks require explicit retry.`);
  }
  if (operation === 'delete') {
    await repository.replace(emptyData(mode));
    console.log(`Cleared all logical records (${mode}): ${directory}. Backups are not deleted. This is not secure erasure of physical storage.`);
  }
} finally { await repository.close(); }
}
