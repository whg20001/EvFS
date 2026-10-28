import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AppData } from '@sanxing/contracts';
import { openRepository, type Repository } from './index.ts';
import { phaseFourData } from '../../../tests/fixtures/phase-four.ts';

const repositories: Repository[] = []; const directories: string[] = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function open(path = ':memory:') {
  const repository = await openRepository(path, 'mock'); repositories.push(repository); return repository;
}
function data() {
  const state = phaseFourData();
  state.documents.doc = { id: 'doc', recitationId: 'q0', name: 'read.md', text: 'original', originalBase64: Buffer.from('original').toString('base64'), hash: 'hash', lineCount: 1, createdAt: state.recitations.q0!.createdAt };
  state.recitations.q0!.documentIds = ['doc'];
  return state;
}

it('returns only selected own fields/entities with deeply detached values and absent legacy options', async () => {
  const repository = await open(); await repository.replace(data());
  const before = await repository.read();
  const selected = await repository.readFields!(['revision', 'quizzes', 'skills']);
  expect(Object.keys(selected).sort()).toEqual(['quizzes', 'revision']);
  expect(selected).toEqual({ revision: before.revision, quizzes: before.quizzes });
  selected.quizzes.q0!.answers.q0!.assessment.feedback = 'outside change';
  const document = await repository.readEntity!('documents', 'doc'); document!.text = 'outside change';
  const quiz = await repository.readEntity!('quizzes', 'q0'); quiz!.questions[0]!.rubric[0]!.description = 'outside rubric';
  for (const collection of ['documents', 'quizzes'] as const) for (const id of ['missing', '__proto__', 'constructor', 'toString']) {
    expect(await repository.readEntity!(collection, id)).toBeUndefined();
  }
  expect(await repository.read()).toEqual(before);
});

it('captures field selection before queuing and reads one committed revision after an asynchronous write', async () => {
  const repository = await open(); await repository.replace(data());
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const write = repository.transact(async state => {
    state.learningPreferences = { schedulingEnabled: true, promptCacheRetention: 'short' };
    state.quizzes.q0!.version = 2; started(); await gate;
  });
  await entered;
  const fields: (keyof AppData)[] = ['revision', 'learningPreferences'];
  const selected = repository.readFields!(fields); const quiz = repository.readEntity!('quizzes', 'q0');
  fields.push('runs'); release(); await write;
  expect(await selected).toEqual({ revision: 2, learningPreferences: { schedulingEnabled: true, promptCacheRetention: 'short' } });
  expect((await quiz)!.version).toBe(2);
});

it('retains committed reads on rollback and rejects nested or closed repository operations', async () => {
  const repository = await open(); await repository.replace(data());
  const before = await repository.readFields!(['revision', 'quizzes']);
  await expect(repository.transact(async state => {
    state.quizzes.q0!.version = 4;
    await expect(repository.readFields!(['quizzes'])).rejects.toThrow('cannot be nested');
    await expect(repository.readEntity!('documents', 'doc')).rejects.toThrow('cannot be nested');
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await repository.readFields!(['revision', 'quizzes'])).toEqual(before);
  expect((await repository.readEntity!('quizzes', 'q0'))!.version).toBe(1);
  await repository.close();
  await expect(repository.readFields!(['quizzes'])).rejects.toThrow('closed');
  await expect(repository.readEntity!('quizzes', 'q0')).rejects.toThrow('closed');
});

it('reflects replacement, deletion, physical reopen and restored backups without stale read caches', async () => {
  const path = await mkdtemp(join(tmpdir(), 'sanxing-read-projection-')); directories.push(path);
  const repository = await open(path); await repository.replace(data());
  const backup = await repository.read(); await repository.close();
  const reopened = await open(path);
  expect(await reopened.readEntity!('quizzes', 'q0')).toEqual(backup.quizzes.q0);
  const replacement = structuredClone(backup); delete replacement.documents.doc; replacement.recitations.q0!.documentIds = [];
  replacement.quizzes.q0!.answers.q0!.assessment.feedback = 'restored feedback';
  await reopened.replace(replacement);
  replacement.quizzes.q0!.answers.q0!.assessment.feedback = 'outside change';
  expect(await reopened.readEntity!('documents', 'doc')).toBeUndefined();
  expect((await reopened.readEntity!('quizzes', 'q0'))!.answers.q0!.assessment.feedback).toBe('restored feedback');
  const restored = await open(); await restored.replace(await reopened.read());
  expect(await restored.readFields!(['quizzes', 'documents', 'skills'])).toEqual(await reopened.readFields!(['quizzes', 'documents', 'skills']));
});
