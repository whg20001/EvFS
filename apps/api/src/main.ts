import { openRepository } from '@sanxing/database';
import { AiModelRuntime } from './ai-runtime.ts';
import { openAiAccess, type AiAccessController } from '@sanxing/ai-access';
import { createApp } from './app.ts';
import { loadEnvironment, readConfig } from './config.ts';

loadEnvironment();
const config = readConfig();
const repository = await openRepository(config.dataDir, config.mode);
let access: AiAccessController | undefined;
let application: Awaited<ReturnType<typeof createApp>> | undefined;
let closing: Promise<void> | undefined;
function shutdown(): Promise<void> {
  return closing ??= (async () => {
    try { await application?.app.close(); }
    finally { try { await access?.close(); } finally { await repository.close(); } }
  })();
}
try {
  access = await openAiAccess({ directory: config.aiAuthDir, secret: config.sessionSecret });
  const modelRuntime = new AiModelRuntime({ config, repository, credentials: access.credentials });
  application = await createApp({ config, repository, engine: modelRuntime, modelRuntime, aiAccess: access });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await application.app.listen({ port: config.port, host: config.host });
  console.log(`Sanxing API: http://${config.host}:${config.port} | ${config.mode === 'mock' ? 'MOCK — scripted demo, no paid model calls' : 'LIVE — explicit Provider'} | persistent local database`);
  console.log(`Web / AI 配置：${config.allowedOrigins.map(origin => `${origin}/ai-access`).join(' | ')}`);
  if (config.mode === 'live') {
    const status = await modelRuntime.configuration();
    if (!status.ready) console.log(`AI 尚未就绪：${status.problem}。网页和登录服务可正常使用。`);
    if (!status.budget.enabled) console.log('应用预算：未设置。实际费用和订阅额度仍受厂商规则约束。');
  }
} catch (error) { await shutdown(); throw error; }
