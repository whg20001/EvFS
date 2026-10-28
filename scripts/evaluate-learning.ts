import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { connectionPolicySchema, runTransportSchema, type RunTransport, LEARNING_PROMPT_VERSION, usageSchema, runRequestSchema, updateRunProgress, taskTimeoutMs, type AiResponse, type Usage, type RunProgress, type RunRequest } from '@sanxing/contracts';
import { connectEvaluationApp } from './evaluation-app.ts';
import { selectEvaluationCases } from './evaluation-selection.ts';
import { createLearningEngine, LearningTransport, prepareLearningRequest } from '@sanxing/learning-agent';
import { createExplicitProvider, LIVE_PROVIDER_IDS, type LiveProviderId } from '@sanxing/ai-access/providers';
import { stageDurations, summarizePerformance } from '../packages/learning-agent/evaluations/performance.ts';
import { EVALUATION_VERSION, evaluationCases } from '../packages/learning-agent/evaluations/cases.ts';

// OAuth uses authenticated application requests; the running API retains vault ownership.
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'offline' }, provider: { type: 'string', default: 'openai' }, model: { type: 'string' }, auth: { type: 'string', default: 'api_key' }, 'app-url': { type: 'string', default: 'http://127.0.0.1:3010' }, 'env-file': { type: 'string' }, 'connection-policy': { type: 'string' }, cases: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }, output: { type: 'string' }, 'max-cost-usd': { type: 'string' }, 'continue-on-error': { type: 'boolean', default: false }, 'max-output-tokens': { type: 'string', default: '4096' } }, strict: true });
if (!['offline', 'live'].includes(values.mode!)) throw new Error('mode must be offline or live');
const live = values.mode === 'live';
const connectionPolicy = values['connection-policy'] === undefined ? undefined : connectionPolicySchema.parse(values['connection-policy']);
if (!live && connectionPolicy) throw new Error('Connection policy comparison requires live mode');
if (!['api_key', 'oauth'].includes(values.auth!)) throw new Error('auth must be api_key or oauth');
const auth = values.auth as 'api_key' | 'oauth';
if (!live && (auth !== 'api_key' || values['env-file'])) throw new Error('Offline mode does not open credentials');
if (values['env-file']) { if (auth !== 'oauth') throw new Error('env-file is only for application OAuth'); process.loadEnvFile(resolve(values['env-file'])); }
const cases = selectEvaluationCases(values);
const offset = values.cases === undefined ? Number(values.offset ?? 0) : null; const limit = cases.length;
let maxOutputTokens = Number(values['max-output-tokens']);
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 8192) throw new Error('max-output-tokens must be 256–8192');
const budget = values['max-cost-usd'] === undefined ? null : Number(values['max-cost-usd']);
if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Invalid cost stop threshold');
if (!values.output) throw new Error('Provide --output <new report.json>');
const provider = values.provider as LiveProviderId;
if (!LIVE_PROVIDER_IDS.includes(provider)) throw new Error('Unsupported provider');
const model = live ? createExplicitProvider(provider).getModels().find(model => model.id === values.model) : undefined;
if (live && !model) throw new Error('Live requires an explicit catalog model');
if (live && auth === 'api_key' && !process.env.EVALUATION_API_KEY) throw new Error('API key mode requires EVALUATION_API_KEY');
const transport = new LearningTransport();
let application: Awaited<ReturnType<typeof connectEvaluationApp>> | undefined;
try {
if (live && auth === 'oauth') {
  application = await connectEvaluationApp(values['app-url']!, process.env.OWNER_PASSWORD ?? '', provider, model!.id, connectionPolicy);
  if (application.suite.suite !== EVALUATION_VERSION || !evaluationCases.every(item => application!.suite.caseIds.includes(item.id))) throw new Error('Application evaluation suite differs from this CLI');
  maxOutputTokens = application.suite.maxOutputTokens;
}
const createEngine = (timeoutMs: number) => createLearningEngine(live ? { mode: 'live', connectionPolicy, provider, model: model!.id, apiKey: process.env.EVALUATION_API_KEY, maxOutputTokens, timeoutMs } : { mode: 'mock', maxOutputTokens, timeoutMs }, { transport });
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
const report = { reportVersion: 3, connectionPolicy: live ? connectionPolicy ?? application?.suite.connectionPolicy ?? 'pooled' : null, performance: summarizePerformance([]), batchId: randomUUID(), inFlight: null as { caseId: string; key: string; runId: string | null } | null, suite: EVALUATION_VERSION, promptVersion: LEARNING_PROMPT_VERSION, mode: values.mode, auth: live ? auth : null, provider: live ? provider : 'faux', model: model?.id ?? 'scripted', createdAt: new Date().toISOString(), casesHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'), offset, limit, maxOutputTokens, allowUnboundedOAuthOutput: application?.selection.allowUnboundedOutput ?? false, continueOnError: values['continue-on-error'], costStopThresholdUsd: budget, knownCostUsd: 0, unknownUsageAttempts: 0, stopped: null as string | null, results: [] as { id: string; task: typeof cases[number]['task']; reference: string; checks: string[]; expectedScore?: { min: number; max: number }; response: AiResponse | null; usage: Usage | null; promptHash: string | null; durationMs: number; error: string | null; progress: RunProgress | null; request: RunRequest | null; transport: RunTransport | null; boundPromptHash: string | null; stages: ReturnType<typeof stageDurations>; scoreMatchesReference: boolean | null; humanReview: { verdict: 'pending'; notes: string } }[] };
// Refuse overwrite before any billable request. Persist after every attempted case.
await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
for (const item of cases) {
  if (budget !== null && report.knownCostUsd >= budget) { report.stopped = 'observed_cost_threshold'; break; }
  const start = performance.now();
  const timeoutMs = taskTimeoutMs(item.task.kind, { runTimeoutMs: 60_000, quizTimeoutMs: 120_000 });
  const diagnostics: { progress: RunProgress | null; request: RunRequest | null; transport: RunTransport | null; boundPromptHash: string | null } = {
    progress: application ? null : { phase: 'preparing', elapsedMs: 0, queuedMs: 0, totalTimeoutMs: timeoutMs }, request: null, transport: null, boundPromptHash: null };
  let response: AiResponse | null = null; let error: string | null = null; let usage: Usage | null = null; let promptHash: string | null = null;
  try {
    const prepared = prepareLearningRequest(item.task, { ...(model ? { contextWindow: model.contextWindow } : {}), maxOutputTokens });
    promptHash = createHash('sha256').update(prepared.prompt).digest('hex');
    const key = randomUUID(); report.inFlight = { caseId: item.id, key, runId: null };
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    response = application ? await application.execute(item.id, report.batchId, key, async runId => {
      report.inFlight!.runId = runId; await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    }, value => { usage = value; }, value => Object.assign(diagnostics, value)) : await createEngine(timeoutMs).execute(prepared.task, {
      signal: AbortSignal.timeout(timeoutMs), onUsage: async value => { usage = usageSchema.parse(value); },
      onProgress: event => updateRunProgress(diagnostics.progress!, event, performance.now() - start),
      onTransport: value => { diagnostics.transport = runTransportSchema.parse(value); },
      onRequest: value => { diagnostics.request = runRequestSchema.parse(value); },
    });
    report.inFlight = null;
    usage = response.usage ?? usage;
  } catch (cause) {
    // Never serialize provider exceptions or credentials. No automatic retries.
    error = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z_0-9]+$/.test(cause.code) ? cause.code : 'EVALUATION_FAILED';
    if (cause && typeof cause === 'object' && 'usage' in cause) { const parsed = usageSchema.safeParse(cause.usage); if (parsed.success) usage = parsed.data; }
  }
  if (!application && diagnostics.progress) {
    diagnostics.progress.elapsedMs = Math.max(diagnostics.progress.elapsedMs, Math.floor(performance.now() - start));
    diagnostics.progress.completedMs = diagnostics.progress.elapsedMs;
  }
  if (diagnostics.progress?.completedMs !== undefined) report.inFlight = null;
  if (usage?.cost != null) report.knownCostUsd += usage.cost;
  else report.unknownUsageAttempts++;
  const graded = response?.output.kind === 'grade' && response.output.status === 'graded' ? response.output.scores.reduce((sum, row) => sum + row.score, 0) : null;
  const scoreMatchesReference = live && item.expectedScore && graded !== null ? graded >= item.expectedScore.min && graded <= item.expectedScore.max : null;
  report.results.push({ ...item, response, usage, promptHash, error, ...diagnostics, stages: stageDurations(diagnostics.progress), durationMs: Math.round(performance.now() - start), scoreMatchesReference, humanReview: { verdict: 'pending', notes: '' } });
  report.performance = summarizePerformance(report.results);
  console.log(JSON.stringify({ caseId: item.id, error, durationMs: report.results.at(-1)!.durationMs, phase: diagnostics.progress?.phase ?? null }));
  if (live && error && (!values['continue-on-error'] || error.startsWith('APP_HTTP_'))) report.stopped = 'request_failed';
  if (live && budget !== null && usage?.cost == null) report.stopped = 'cost_unknown';
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (report.stopped) break;
}
await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ mode: report.mode, attempted: report.results.length, failures: report.results.filter(row => row.error).length, humanReview: 'pending', stopped: report.stopped, output }));
if (report.stopped || report.results.some(row => row.error)) process.exitCode = 1;
} finally { await transport.close(); await application?.close(); }
