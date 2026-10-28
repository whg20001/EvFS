import { openRepository } from '@sanxing/database';
import { createLearningEngine } from '@sanxing/learning-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createAiAccessController } from '@sanxing/ai-access';
import { createApp } from '../../apps/api/src/app.ts';
import { readConfig } from '../../apps/api/src/config.ts';
import { apiOrigin, webOrigin, password, sessionSecret } from './settings.ts';

// Intentionally never load .env, personal data, live credentials or a paid model.
const config = readConfig({ AI_MODE: 'mock', NODE_ENV: 'test', API_PORT: '4107', APP_ORIGIN: webOrigin,
  OWNER_PASSWORD: password, SESSION_SECRET: sessionSecret, SKILL_CATALOG_URL: `${apiOrigin}/cloud-skills/catalog.json` });
const repository = await openRepository(':memory:', 'mock');
const engine = createLearningEngine({ mode: 'mock' });
// A deliberately offline OAuth driver exercises the real Pi login bridge without an upstream account.
const aiAccess = createAiAccessController({ credentials: new InMemoryCredentialStore(), deviceId: '00000000-0000-4000-8000-000000000001', providers: [{
  ...fauxProvider({ provider: 'anthropic', api: 'e2e-oauth-faux' }).provider, name: 'Anthropic（离线测试）',
  auth: { oauth: { name: 'Offline test OAuth', refresh: async value => value, toAuth: async value => ({ apiKey: value.access }), async login(interaction) {
    await interaction.prompt({ type: 'select', message: '选择授权方式', options: [{ id: 'copy_code', label: '复制验证码（离线测试）' }] });
    interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?state=offline-test-only' });
    const code = await interaction.prompt({ type: 'manual_code', message: '测试授权码', placeholder: 'offline-test-code' });
    if (code !== 'offline-test-code') throw new Error('Incorrect offline test code');
    return { type: 'oauth', access: 'offline-test-access-token', refresh: 'offline-test-refresh-token', expires: Date.now() + 3_600_000 };
  } } },
}] });
const { app } = await createApp({ config, repository, engine, aiAccess });
// Local catalog fixtures exercise actual HTTP downloads without an external server.
app.get('/cloud-skills/catalog.json', async () => ({ skills: [{ name: 'remote-examples', description: '云端学习教学方法',
  version: '1.0.0', author: '测试目录', url: 'remote-examples/SKILL.md' }] }));
app.get('/cloud-skills/remote-examples/SKILL.md', async (_request, reply) => reply.type('text/markdown; charset=utf-8').send(
  '---\nname: remote-examples\ndescription: 云端学习教学方法\n---\n先举例，再检查理解。<script>window.cloudSkillExecuted = true</script>'
));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  await app.close(); await repository.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try { await app.listen({ port: config.port, host: '127.0.0.1' }); }
catch (error) { await shutdown(); throw error; }
