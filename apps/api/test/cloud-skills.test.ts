import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openRepository } from '@sanxing/database';
import type { LearningSkill } from '@sanxing/contracts';
import { createCloudSkillCatalog } from '../src/cloud-skills.ts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';

const url = 'https://skills.example.test/catalog/catalog.json';
const content = '---\nname: remote-examples\ndescription: 云端教学方法\n---\nPRIVATE_CLOUD_INSTRUCTIONS 使用例子检查边界。';
const manifest = { skills: [{ name: 'remote-examples', description: '云端教学方法', url: 'remote-examples/SKILL.md', version: '1.0.0' }] };
const resources: { app: Awaited<ReturnType<typeof createApp>>; repository: Awaited<ReturnType<typeof openRepository>> }[] = [];
afterEach(async () => { for (const item of resources.splice(0)) { await item.app.app.close(); await item.repository.close(); } });

function transport(catalog: unknown = manifest, file: string | Uint8Array = content) {
  return vi.fn<typeof fetch>(async input => new Response(new URL(String(input)).pathname.endsWith('/catalog.json') ? JSON.stringify(catalog) : typeof file === 'string' ? file : new Uint8Array(file), { status: 200 }));
}

it('does not access the network without a configured catalog', async () => {
  const fetcher = transport();
  const catalog = createCloudSkillCatalog({}, fetcher);
  expect(await catalog.list()).toEqual({ configured: false, source: null, items: [] });
  await expect(catalog.download('remote-examples')).rejects.toMatchObject({ code: 'CLOUD_SKILL_UNCONFIGURED' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('lists metadata, keeps source credentials private, and downloads a parsed single-file skill', async () => {
  const fetcher = transport();
  const catalog = createCloudSkillCatalog({ skillCatalogUrl: `${url}?private=secret`, skillCatalogToken: 'private-bearer-token' }, fetcher);
  const list = await catalog.list();
  expect(list).toEqual({ configured: true, source: url, items: [{ name: 'remote-examples', description: '云端教学方法', version: '1.0.0' }] });
  expect(JSON.stringify(list)).not.toMatch(/secret|bearer|SKILL\.md|PRIVATE_CLOUD/);
  expect(await catalog.download('remote-examples')).toMatchObject({ name: 'remote-examples', instructions: expect.stringContaining('PRIVATE_CLOUD_INSTRUCTIONS') });
  expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer private-bearer-token' } });
});

it.each(['https://other.example.test/SKILL.md', '../private/SKILL.md', 'file:///etc/passwd', 'https://user:password@skills.example.test/catalog/SKILL.md'])('rejects download destinations outside the configured catalog: %s', async destination => {
  const fetcher = transport({ skills: [{ ...manifest.skills[0], url: destination }] });
  await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, fetcher).list()).rejects.toMatchObject({ code: 'CLOUD_SKILL_CATALOG' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects malformed catalogs, duplicate names and files with a different name', async () => {
  for (const invalid of [{ skills: [manifest.skills[0], manifest.skills[0]] }, { skills: [{ name: 'Bad Name' }] }, []]) {
    await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, transport(invalid)).list()).rejects.toMatchObject({ code: 'CLOUD_SKILL_CATALOG' });
  }
  await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, transport(manifest, content.replace('name: remote-examples', 'name: different'))).download('remote-examples')).rejects.toMatchObject({ code: 'CLOUD_SKILL_NAME' });
});

it('bounds streamed file and catalog bytes and rejects invalid UTF-8 and failed requests', async () => {
  await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, transport(manifest, 'x'.repeat(32_769))).download('remote-examples')).rejects.toMatchObject({ code: 'CLOUD_SKILL_TOO_LARGE' });
  await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, transport({ skills: [], extra: 'x'.repeat(262_144) })).list()).rejects.toMatchObject({ code: 'CLOUD_SKILL_TOO_LARGE' });
  await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, transport(manifest, new Uint8Array([255, 254]))).download('remote-examples')).rejects.toMatchObject({ code: 'CLOUD_SKILL_ENCODING' });
  await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, async () => new Response('private server error', { status: 500 })).list()).rejects.toMatchObject({ code: 'CLOUD_SKILL_FETCH' });
  await expect(createCloudSkillCatalog({ skillCatalogUrl: url }, async () => new Response('not json')).list()).rejects.toMatchObject({ code: 'CLOUD_SKILL_CATALOG' });
});

it('downloads through authenticated, CSRF-protected, idempotent routes and stores a disabled local Skill', async () => {
  const fetcher = transport();
  const config = readConfig({ OWNER_PASSWORD: 'cloud-skill-test-password', SESSION_SECRET: 'cloud-skill-test-secret-'.repeat(4) });
  const repository = await openRepository(':memory:', 'mock');
  const execute = vi.fn(async () => { throw new Error('Unexpected model call'); });
  const app = await createApp({ config, repository, engine: { mode: 'mock', execute }, startWorker: false, cloudSkills: createCloudSkillCatalog({ skillCatalogUrl: url }, fetcher) });
  resources.push({ app, repository });
  const login = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: config.ownerPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken, origin: config.appOrigin, 'idempotency-key': randomUUID() };
  const endpoint = '/api/ai/skills/cloud/remote-examples/download';
  expect((await app.app.inject({ url: '/api/ai/skills/cloud' })).statusCode).toBe(401);
  expect((await app.app.inject({ method: 'POST', url: endpoint, headers: { cookie: headers.cookie }, payload: {} })).statusCode).toBe(403);
  expect((await app.app.inject({ method: 'POST', url: endpoint, headers: { ...headers, origin: 'https://untrusted.invalid' }, payload: {} })).statusCode).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  const before = await repository.read();
  const listing = await app.app.inject({ url: '/api/ai/skills/cloud', headers });
  expect(listing.statusCode).toBe(200); expect(await repository.read()).toEqual(before);
  const first = await app.app.inject({ method: 'POST', url: endpoint, headers, payload: {} });
  expect(first.statusCode).toBe(200);
  const fetched = fetcher.mock.calls.length;
  const replay = await app.app.inject({ method: 'POST', url: endpoint, headers, payload: {} });
  expect(replay.json()).toEqual(first.json()); expect(fetcher).toHaveBeenCalledTimes(fetched);
  const detail = await app.app.inject({ url: `/api/ai/skills/${first.json().id}`, headers });
  expect(detail.json<LearningSkill>()).toMatchObject({ enabled: false, tasks: ['followup', 'quiz'], document: { name: 'remote-examples' } });
  const local = await app.app.inject({ url: '/api/ai/skills', headers });
  expect(local.json().items).toHaveLength(1); expect(local.body).not.toContain('PRIVATE_CLOUD_INSTRUCTIONS');
  expect(JSON.stringify((await repository.read()).receipts)).not.toContain('PRIVATE_CLOUD_INSTRUCTIONS');
  expect((await app.app.inject({ method: 'POST', url: endpoint, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: {} })).statusCode).toBe(409);
  expect((await repository.read()).skills).toHaveLength(1); expect(execute).not.toHaveBeenCalled();
});
