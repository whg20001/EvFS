import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { managedUserSchema } from '@sanxing/contracts';
import { DomainError, learningDate } from '@sanxing/learning-domain';
import type { Account, Accounts } from './accounts.ts';
import type { ApiConfig } from './config.ts';
import type { PlatformAi } from './platform-ai.ts';
import type { serverMetrics } from './server-metrics.ts';

export function adminRoutes(app: FastifyInstance, options: { accounts: Accounts; config: ApiConfig; platform: PlatformAi;
  owner: (request: FastifyRequest) => { user: Account }; revoke: (id: string) => Promise<void>; metrics: ReturnType<typeof serverMetrics>; counts: () => { active: number; sessions: number } }) {
  const { accounts, config, platform } = options;
  const admin = (request: FastifyRequest) => { const user = options.owner(request).user; if (user.role !== 'admin') throw new DomainError('ADMIN_REQUIRED', '此页面仅对管理员开放。', 403); return user; };
  const today = () => learningDate(new Date(), config.timezone);
  const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), search: z.string().trim().max(32).default('') });
  app.get('/api/admin/overview', async request => { admin(request); return { ...await accounts.overview(today(), config.timezone), timezone: config.timezone, mode: config.mode }; });
  app.get('/api/admin/users', request => { admin(request); const input = pagination.extend({ status: z.enum(['', 'active', 'disabled']).default('') }).parse(request.query); return accounts.listUsers({ ...input, day: today() }); });
  app.post('/api/admin/users', async request => {
    const user = admin(request); const input = z.strictObject({ username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/).transform(value => value.toLowerCase()), password: z.string().min(12).max(128) }).parse(request.body);
    return accounts.createManaged(user.id, input.username, input.password);
  });
  app.patch('/api/admin/users/:id', async request => {
    const user = admin(request); const { id } = z.object({ id: z.uuid() }).parse(request.params); const input = managedUserSchema.parse(request.body);
    const result = await accounts.updateUser(user.id, id, input);
    await options.revoke(id); return result;
  });
  app.get('/api/admin/activity', request => { admin(request); return accounts.activities(pagination.parse(request.query)); });
  app.get('/api/admin/metrics', request => { admin(request); const counts = options.counts(); return options.metrics.read(counts.active, counts.sessions); });
  app.get('/api/admin/platform-ai', request => { admin(request); return platform.view(); });
  app.put('/api/admin/platform-ai', request => platform.save(admin(request).id, request.body));
}
