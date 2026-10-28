import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAiAccessController } from '@sanxing/ai-access';
import { openAccounts } from '../../apps/api/src/accounts.ts';
import { createGatewayApp } from '../../apps/api/src/gateway-app.ts';
import { readConfig } from '../../apps/api/src/config.ts';
import { apiOrigin, webOrigin, sessionSecret, password } from './settings.ts';

// No dotenv, personal database, live model or persistent user vault enters this fixture.
const directory = await mkdtemp(join(tmpdir(), 'sanxing-local-first-e2e-'));
const config = readConfig({ AI_MODE: 'mock', APP_STORAGE_MODE: 'local-first', NODE_ENV: 'test', API_PORT: '4107', APP_ORIGIN: webOrigin,
  SESSION_SECRET: sessionSecret, ADMIN_USERNAMES: 'admin', AUTH_REGISTRATIONS_PER_15_MIN: '100', SKILL_CATALOG_URL: `${apiOrigin}/cloud-skills/catalog.json` });
const accounts = await openAccounts(directory);
await accounts.register('admin', password);
const { app } = await createGatewayApp({ config, accounts,
  ocrRecognizer: async (_bytes, mediaType, signal) => { signal.throwIfAborted(); return { text: 'OFFLINE_OCR_NOTE Learning through recall.', import: { format: 'image', parser: 'bbc-ocr', mediaType: mediaType as 'image/png', width: 900, height: 240, modelId: 'offline-ocr-fixture', engineVersion: 'test', confidence: 0.96, warnings: [] } }; },
  accessFactory: async () => createAiAccessController({ credentials: new InMemoryCredentialStore(), deviceId: randomUUID() }) });
app.get('/cloud-skills/catalog.json', async () => ({ skills: [{ name: 'remote-examples', description: '云端学习教学方法', url: 'remote-examples/SKILL.md' }] }));
app.get('/cloud-skills/remote-examples/SKILL.md', async (_request, reply) => reply.type('text/markdown').send('---\nname: remote-examples\ndescription: 云端学习教学方法\n---\n用具体例子说明边界。'));
let closing = false;
async function shutdown() { if (closing) return; closing = true; await app.close(); await accounts.close(); await rm(directory, { recursive: true, force: true }); }
process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
try { await app.listen({ port: config.port, host: '127.0.0.1' }); } catch (error) { await shutdown(); throw error; }
