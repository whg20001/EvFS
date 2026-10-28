import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runTransportSchema, connectionPolicySchema, type ConnectionPolicy, type RunTransport, aiOutputSchema, usageSchema, runProgressSchema, runRequestSchema, promptHashSchema, type AiModelConfiguration, type AgentRun, type AiResponse, type Usage, type RunProgress, type RunRequest } from '@sanxing/contracts';

/** Authenticated loopback client. No credential export and no personal state endpoint. */
export async function connectEvaluationApp(url: string, password: string, provider: string, model: string, connectionPolicy?: ConnectionPolicy) {
  if (connectionPolicy !== undefined) connectionPolicySchema.parse(connectionPolicy);
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Evaluation application must be an explicit loopback origin');
  let cookie = ''; let csrf = '';
  async function request(path: string, body?: unknown, key: string = randomUUID()) {
    const response = await fetch(`${base.origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { origin: base.origin, cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw Object.assign(new Error(`Application request failed (${response.status}); no request was retried`), { code: `APP_HTTP_${response.status}` });
    if (path === '/auth/login') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return response.json();
  }
  const close = async () => { if (cookie) await request('/auth/logout', {}).catch(() => undefined); };
  try {
    if (!password) throw new Error('OAuth evaluation requires local OWNER_PASSWORD to sign into the running application');
    csrf = (await request('/auth/login', { password })).csrfToken;
    const config = await request('/ai/configuration') as AiModelConfiguration;
    if (config.mode !== 'live' || !config.ready || config.selection?.providerId !== provider || config.selection?.modelId !== model || config.selection?.authMethod !== 'oauth') throw new Error('Application must have this exact OAuth provider/model saved and authorized in live mode');
    const selection = config.selection;
    const suite = await request('/ai/evaluations') as { suite: string; caseIds: string[]; maxOutputTokens: number; timeoutMs: number; connectionPolicy?: ConnectionPolicy };
    return { suite, selection, close,
      async execute(caseId: string, batchId: string, key: string, onQueued: (runId: string) => Promise<void>, onUsage: (usage: Usage | null) => void, onDiagnostics?: (value: { progress: RunProgress | null; request: RunRequest | null; transport: RunTransport | null; boundPromptHash: string | null }) => void): Promise<AiResponse> {
        const queued = await request('/ai/evaluations', { confirm: true, suite: suite.suite, batchId, caseId, expectedSelection: selection, ...(connectionPolicy ? { connectionPolicy } : {}) }, key) as { runId: string };
        const deadline = Date.now() + suite.timeoutMs + 30_000;
        try {
          await onQueued(queued.runId);
          while (Date.now() < deadline) {
            const run = await request(`/ai/evaluations/${queued.runId}`) as Pick<AgentRun, 'status' | 'usage' | 'evaluation' | 'error' | 'errorCode' | 'progress' | 'request' | 'transport' | 'promptHash'> & { diagnosticsPending?: boolean };
            const usage = run.usage === null ? null : usageSchema.parse(run.usage); onUsage(usage);
            onDiagnostics?.({ progress: run.progress ? runProgressSchema.parse(run.progress) : null,
              transport: run.transport ? runTransportSchema.parse(run.transport) : null,
              request: run.request ? runRequestSchema.parse(run.request) : null, boundPromptHash: run.promptHash ? promptHashSchema.parse(run.promptHash) : null });
            if (run.diagnosticsPending && (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled')) { await delay(250); continue; }
            if (run.status === 'succeeded') return { output: aiOutputSchema.parse(run.evaluation?.output), usage };
            if (run.status === 'failed' || run.status === 'cancelled') {
              const code = run.errorCode ?? run.error?.match(/（([A-Z_0-9]+)）/)?.[1] ?? 'APP_RUN_FAILED';
              throw Object.assign(new Error('Application evaluation did not complete'), { code, usage });
            }
            await delay(1000);
          }
          throw Object.assign(new Error('Application evaluation timed out'), { code: 'APP_RUN_TIMEOUT' });
        } catch (error) {
          // Cancellation is idempotent and never submits another paid request.
          await request(`/runs/${queued.runId}/cancel`, {}).catch(() => undefined);
          throw error;
        }
      },
    };
  } catch (error) { await close(); throw error; }
}
