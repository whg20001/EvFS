import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IDEMPOTENCY_KEY_PATTERN, skillFileInputSchema, skillTasksSchema, summarizeSkill, type SkillPreview } from '@sanxing/contracts';
import { getSkill, saveSkill, configureSkill, deleteSkill, type LearningService } from '@sanxing/learning-domain';
import { parseSkillFile } from '../skill-import.ts';
import { readFields } from '../repository-reads.ts';
import type { CloudSkillCatalog } from '../cloud-skills.ts';

const fileInput = skillFileInputSchema;
const version = z.number().int().positive();
export function registerSkillRoutes(app: FastifyInstance, service: LearningService, cloud: CloudSkillCatalog) {
  const id = (request: FastifyRequest) => z.object({ id: z.uuid() }).parse(request.params).id;
  const key = (request: FastifyRequest) => z.string().regex(IDEMPOTENCY_KEY_PATTERN).parse(request.headers['idempotency-key']);
  app.get('/api/ai/skills', async () => {
    const data = await readFields(service.repository, ['mode', 'skills']);
    return { mode: data.mode, items: (data.skills ?? []).map(summarizeSkill) };
  });
  app.get('/api/ai/skills/cloud', () => cloud.list());
  app.post('/api/ai/skills/cloud/:name/download', async request => {
    const { name } = z.object({ name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    return service.command(`POST:/api/ai/skills/cloud/${name}/download`, key(request), { name }, async data => {
      const document = await cloud.download(name);
      return saveSkill(data, { document }, service.now());
    });
  });
  app.get('/api/ai/skills/:id', async request => getSkill(await readFields(service.repository, ['skills']), id(request)));
  app.post('/api/ai/skills/preview', async request => {
    const { filename, content, resources } = fileInput.strict().parse(request.body);
    const result = parseSkillFile(filename, content, resources);
    const existing = (await readFields(service.repository, ['skills'])).skills?.find(skill => skill.document.name === result.document.name);
    return { ...result, existing: existing ? { id: existing.id, version: existing.version } : null } satisfies SkillPreview;
  });
  app.post('/api/ai/skills', async request => {
    const body = fileInput.extend({ replace: z.object({ id: z.uuid(), version }).strict().optional() }).strict().parse(request.body);
    const { document } = parseSkillFile(body.filename, body.content, body.resources);
    return service.command('POST:/api/ai/skills', key(request), body, data => saveSkill(data, { document, replace: body.replace }, service.now()));
  });
  app.put('/api/ai/skills/:id', async request => {
    const skillId = id(request);
    const body = z.object({ version, enabled: z.boolean(), tasks: skillTasksSchema }).strict().parse(request.body);
    return service.command(`PUT:/api/ai/skills/${skillId}`, key(request), body, data => configureSkill(data, skillId, body, service.now()));
  });
  app.delete('/api/ai/skills/:id', async request => {
    const skillId = id(request);
    const body = z.object({ version }).strict().parse(request.body);
    return service.command(`DELETE:/api/ai/skills/${skillId}`, key(request), body, data => deleteSkill(data, skillId, body));
  });
}
