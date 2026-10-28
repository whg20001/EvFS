import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptyData, openRepository } from '@sanxing/database';
import type { SkillSelection, AiTask, LearningEngine, LearningSkill, SkillPreview, SkillSummary } from '@sanxing/contracts';
import { describeLearningPrompt, inspectLearningRequest, prepareLearningRequest } from '@sanxing/learning-agent';
import { bindLearningSkills, LearningService } from '@sanxing/learning-domain';
import { AiModelRuntime } from '../src/ai-runtime.ts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';

const resources: { app: Awaited<ReturnType<typeof createApp>>; repository: Awaited<ReturnType<typeof openRepository>> }[] = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Skill management must stay offline'); })));
afterEach(async () => {
  for (const f of resources.splice(0)) { await f.app.app.close(); await f.repository.close(); }
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const file = (name = 'example-method', instructions = 'PRIVATE_SKILL_BODY: 使用反例检查边界条件。') => ({ filename: 'SKILL.md', content: `---\nname: ${name}\ndescription: 学习时使用例子\n---\n${instructions}` });
async function fixture() {
  const config = readConfig({ OWNER_PASSWORD: 'skill-test-password', SESSION_SECRET: 'skill-test-secret-'.repeat(4), AI_MODE: 'mock' });
  const repository = await openRepository(':memory:', 'mock');
  const execute = vi.fn<LearningEngine['execute']>(async () => { throw new Error('Unexpected model call'); });
  const instance = await createApp({ config, repository, engine: { mode: 'mock', execute }, startWorker: false });
  resources.push({ app: instance, repository });
  vi.spyOn(instance.worker, 'tick').mockResolvedValue();
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin };
  const write = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload: object, key = randomUUID()) => instance.app.inject({ method, url, headers: { ...headers, 'idempotency-key': key }, payload });
  const get = (url: string) => instance.app.inject({ url, headers });
  const add = async (name?: string, instructions?: string) => {
    const result = await write('POST', '/api/ai/skills', file(name, instructions));
    expect(result.statusCode).toBe(200); return result.json<{ id: string; version: number }>();
  };
  const submit = async (skillSelections: SkillSelection = []) => {
    const created = await write('POST', '/api/recitations', {});
    const id = created.json<{ id: string }>().id;
    const draft = await write('PUT', `/api/recitations/${id}/draft`, { version: created.json().version, learned: '学习了缓存的有效期和淘汰策略', unclear: '', application: '', topic: '' });
    const result = await write('POST', `/api/recitations/${id}/submit`, { version: draft.json().version, skillSelections });
    expect(result.statusCode).toBe(202); return result.json<{ runId: string; sessionId: string }>();
  };
  return { ...instance, repository, headers, write, get, add, submit, execute };
}
it('previews without writes, imports disabled idempotently, and omits instruction bodies from list/state/receipts', async () => {
  const f = await fixture(); const before = await f.repository.read();
  const preview = await f.write('POST', '/api/ai/skills/preview', file());
  expect(preview.json<SkillPreview>()).toMatchObject({ existing: null, document: { name: 'example-method' } });
  expect(await f.repository.read()).toEqual(before);
  const key = randomUUID();
  const first = await f.write('POST', '/api/ai/skills', file(), key);
  const replay = await f.write('POST', '/api/ai/skills', file(), key);
  expect(replay.json()).toEqual(first.json());
  expect((await f.write('POST', '/api/ai/skills', file(), randomUUID())).statusCode).toBe(409);
  const detail = (await f.get(`/api/ai/skills/${first.json().id}`)).json<LearningSkill>();
  expect(detail).toMatchObject({ enabled: false, tasks: ['followup', 'quiz'], version: 1 });
  const list = await f.get('/api/ai/skills');
  expect(list.json<{ items: SkillSummary[] }>().items).toHaveLength(1);
  for (const value of [list.body, (await f.get('/api/state')).body, JSON.stringify((await f.repository.read()).receipts)]) expect(value).not.toContain('PRIVATE_SKILL_BODY');
  expect(f.execute).not.toHaveBeenCalled();
});
it('enforces authentication, CSRF, origin and required idempotency on Skill endpoints', async () => {
  const f = await fixture();
  expect((await f.app.inject({ url: '/api/ai/skills' })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: '/api/ai/skills/preview', payload: file() })).statusCode).toBe(401);
  expect((await f.app.inject({ method: 'POST', url: '/api/ai/skills/preview', headers: { cookie: f.headers.cookie }, payload: file() })).statusCode).toBe(403);
  expect((await f.app.inject({ method: 'POST', url: '/api/ai/skills', headers: { ...f.headers, origin: 'https://evil.invalid', 'idempotency-key': randomUUID() }, payload: file() })).statusCode).toBe(403);
  expect((await f.app.inject({ method: 'POST', url: '/api/ai/skills', headers: f.headers, payload: file() })).statusCode).toBe(400);
  expect((await f.repository.read()).skills).toBeUndefined();
});
it('freezes queued and retried instructions despite replacing, disabling or deleting the Skill', async () => {
  const f = await fixture(); const skill = await f.add();
  expect((await f.write('PUT', `/api/ai/skills/${skill.id}`, { version: 1, enabled: true, tasks: ['extract'] })).statusCode).toBe(200);
  const { runId } = await f.submit([{ id: skill.id, version: 2 }]); const queued = (await f.repository.read()).runs[runId]!;
  expect(queued.task).toMatchObject({ skills: [{ id: skill.id, version: 2, instructions: expect.stringContaining('PRIVATE_SKILL_BODY') }] });
  expect(queued.promptHash).toBe(describeLearningPrompt(queued.task).hash);
  const updated = await f.write('POST', '/api/ai/skills', { ...file(undefined, 'NEW_SKILL_BODY'), replace: { id: skill.id, version: 2 } });
  expect(updated.statusCode).toBe(200);
  expect((await f.get(`/api/ai/skills/${skill.id}`)).json<LearningSkill>()).toMatchObject({ enabled: false, version: 3 });
  expect((await f.write('DELETE', `/api/ai/skills/${skill.id}`, { version: 3 })).statusCode).toBe(200);
  expect((await f.repository.read()).runs[runId]).toEqual(queued);
  await f.write('POST', `/api/runs/${runId}/cancel`, {});
  const retried = await f.write('POST', `/api/runs/${runId}/retry`, {});
  const next = (await f.repository.read()).runs[retried.json().runId]!;
  expect(next.task).toEqual(queued.task); expect(next.promptHash).toBe(queued.promptHash);
  const claimed = await f.service.claimRun(); expect(claimed?.id).toBe(next.id);
  expect(inspectLearningRequest(claimed!.task, { maxOutputTokens: 4096 }).systemPrompt).toContain('PRIVATE_SKILL_BODY');
  expect(f.execute).not.toHaveBeenCalled();
});
it('does not add newly enabled skills to an old task with a frozen empty snapshot', async () => {
  const f = await fixture(); const { runId } = await f.submit();
  const original = (await f.repository.read()).runs[runId]!;
  expect(original.task).toMatchObject({ skills: [] });
  const skill = await f.add(); await f.write('PUT', `/api/ai/skills/${skill.id}`, { version: 1, enabled: true, tasks: ['extract'] });
  await f.write('POST', `/api/runs/${runId}/cancel`, {});
  // The input-preparation failure path must also retain absence when explicitly retried.
  await f.repository.transact(data => { data.runs[runId]!.inputPrepared = false; });
  const retry = await f.write('POST', `/api/runs/${runId}/retry`, {});
  const next = (await f.repository.read()).runs[retry.json().runId]!;
  expect(next.task).toMatchObject({ skills: [] }); expect(next.promptHash).toBe(original.promptHash);
});
it('rejects stale changes and incompatible updates atomically, and enforces active/stored limits', async () => {
  const f = await fixture(); const first = await f.add('skill-a');
  await f.write('PUT', `/api/ai/skills/${first.id}`, { version: 1, enabled: true, tasks: ['quiz'] });
  const before = await f.repository.read();
  for (const method of ['PUT', 'DELETE'] as const) expect((await f.write(method, `/api/ai/skills/${first.id}`, { version: 1, ...(method === 'PUT' ? { enabled: false, tasks: ['quiz'] } : {}) })).statusCode).toBe(409);
  expect((await f.write('POST', '/api/ai/skills', { ...file(), replace: { id: first.id, version: 2 } })).statusCode).toBe(400);
  expect(await f.repository.read()).toEqual(before);
  const second = await f.add('skill-b'), third = await f.add('skill-c'), fourth = await f.add('skill-d');
  for (const skill of [second, third]) expect((await f.write('PUT', `/api/ai/skills/${skill.id}`, { version: 1, enabled: true, tasks: ['quiz'] })).statusCode).toBe(200);
  expect((await f.write('PUT', `/api/ai/skills/${fourth.id}`, { version: 1, enabled: true, tasks: ['quiz'] })).statusCode).toBe(200);
  expect((await f.get(`/api/ai/skills/${fourth.id}`)).json<LearningSkill>().enabled).toBe(true);
  for (let index = 4; index < 20; index++) await f.add(`skill-${index}`);
  expect((await f.write('POST', '/api/ai/skills', file('skill-limit'))).json().error.code).toBe('SKILL_LIMIT');
});
it('limits total enabled instruction length and rejects duplicate/empty task scopes', async () => {
  const f = await fixture();
  const first = await f.add('skill-a', 'x'.repeat(16000)), second = await f.add('skill-b', 'y'.repeat(9000));
  await f.write('PUT', `/api/ai/skills/${first.id}`, { version: 1, enabled: true, tasks: ['quiz'] });
  expect((await f.write('PUT', `/api/ai/skills/${second.id}`, { version: 1, enabled: true, tasks: ['quiz'] })).statusCode).toBe(200);
  const state = await f.repository.read();
  expect(() => bindLearningSkills(state, { kind: 'quiz', points: [], sources: [], count: 1 }, [first, second].map(item => ({ id: item.id, version: 2 })))).toThrow('24000');
  for (const tasks of [[], ['quiz', 'quiz'], ['connection_test']]) expect((await f.write('PUT', `/api/ai/skills/${second.id}`, { version: 2, enabled: true, tasks })).statusCode).toBe(400);
});

it('uses the same Skill budget in preview and queue preparation, and keeps baseline evaluation free of personal skills', async () => {
  const f = await fixture(); const skill = await f.add();
  await f.write('PUT', `/api/ai/skills/${skill.id}`, { version: 1, enabled: true, tasks: ['extract'] });
  const data = await f.repository.read();
  const task: Extract<AiTask, { kind: 'extract' }> = { kind: 'extract', recitation: { learned: '缓存有效期', unclear: '', application: '', topic: '' }, sources: [] };
  const config = readConfig({ OWNER_PASSWORD: 'test-password', SESSION_SECRET: 'test-secret-'.repeat(4), AI_MODE: 'mock' });
  const models = new AiModelRuntime({ config, repository: f.repository });
  try {
    const selected = bindLearningSkills(data, task, [{ id: skill.id, version: 2 }]);
    const preview = models.previewTask(data, selected);
    const prepared = models.prepareTask(data, selected);
    expect(preview.canSubmit).toBe(true);
    expect(preview.estimatedInputTokens).toBe(inspectLearningRequest(prepared, { maxOutputTokens: config.maxOutputTokens }).estimatedInputTokens);
    expect(preview.estimatedInputTokens).toBeGreaterThan(models.previewTask({ ...data, skills: [] }, task).estimatedInputTokens!);
    const evaluationData = emptyData('live'); evaluationData.skills = data.skills;
    // Exercise domain evaluation without constructing a live model or sending a request.
    const service = new LearningService(f.repository, { ...config, mode: 'live' }, undefined,
      input => prepareLearningRequest(input, { maxOutputTokens: config.maxOutputTokens }).task, describeLearningPrompt);
    const result = service.evaluate(evaluationData, task, { suite: 'offline-skill-isolation', caseId: 'one', batchId: randomUUID(),
      selection: { providerId: 'openai', modelId: 'test-model', authMethod: 'api_key', allowUnboundedOutput: false } });
    expect(evaluationData.runs[result.runId!]!.task).toMatchObject({ skills: [] });
    expect(JSON.stringify(evaluationData.runs[result.runId!]!.task)).not.toContain('PRIVATE_SKILL_BODY');
  } finally { await models.close(); }
});
