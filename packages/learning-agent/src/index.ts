import { z } from 'zod';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai/models';
import { InMemoryCredentialStore, type AssistantMessage, type CredentialStore } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createExplicitProvider, isolatedAuthContext, LIVE_PROVIDER_IDS, providerPolicy, unsafeEnvironmentKeys, type LiveProviderId } from '@sanxing/ai-access/providers';
import { LIMITS, aiOutputSchema, modelAiTaskSchema, type AiTask, type AiOutput, type AiResponse, type LearningEngine, type LearningProgressEvent, type Mode, type Usage } from '@sanxing/contracts';
import { scriptOutput } from './mock.ts';
import { connectionPolicySchema, type ConnectionPolicy } from '@sanxing/contracts';
import { LearningTransport, RequestTransport } from './transport.ts';
export { LearningTransport } from './transport.ts';
import { RequestFailureObserver } from './failure.ts';
import { assertLearningPrompt, checkLearningRequest, LearningEngineError } from './request.ts';
export { describeLearningPrompt, assertLearningPrompt, prepareLearningRequest, inspectLearningRequest, checkLearningRequest, fitsLearningRequest, INPUT_SAFETY_MARGIN_TOKENS, CONNECTION_TEST_OUTPUT_TOKENS, LearningEngineError, type LearningRequestOptions, type PreparedLearningRequest } from './request.ts';

export interface EngineConfig {
  mode: Mode;
  provider?: LiveProviderId;
  model?: string;
  apiKey?: string;
  authMethod?: 'api_key' | 'oauth';
  allowUnboundedOAuthOutput?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  firstResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  connectionPolicy?: ConnectionPolicy;
  cacheRetention?: 'none' | 'short';
}

export const LIVE_ENVIRONMENT_WARNING = 'Live 仅使用传入的 key/model；AuthContext 不是进程沙箱。请在净化的独立 Node 进程中运行，SDK、代理、TLS 或预加载代码仍可能读取进程环境。env={} 不能关闭环境回退。';

const configSchema = z.object({
  mode: z.enum(['mock', 'live']), provider: z.enum(LIVE_PROVIDER_IDS).optional(),
  model: z.string().trim().min(1).max(200).optional(), apiKey: z.string().trim().min(1).optional(),
  authMethod: z.enum(['api_key', 'oauth']).default('api_key'), allowUnboundedOAuthOutput: z.boolean().default(false),
  maxOutputTokens: z.number().int().min(1).max(16_384).default(4096),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
  firstResponseTimeoutMs: z.number().int().min(1).max(120_000).default(60_000),
  streamIdleTimeoutMs: z.number().int().min(1).max(120_000).default(45_000),
  connectionPolicy: connectionPolicySchema.default('pooled'),
  cacheRetention: z.enum(['none', 'short']).default('none'),
}).strict();

function fail(code: string, message: string): never { throw new LearningEngineError(code, message); }

// Reject known ambient SDK/config channels rather than pretending empty overrides isolate them.
// Names are inspected, never used as credentials. Do not mutate global process.env.
function assertLiveEnvironment() {
  const forbidden = unsafeEnvironmentKeys();
  if (forbidden.length) fail('UNSAFE_ENVIRONMENT', `${LIVE_ENVIRONMENT_WARNING} 请移除环境项：${forbidden.join(', ')}`);
}

function rejectUnknownFields(raw: unknown, parsed: unknown): void {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((value, index) => rejectUnknownFields(value, parsed[index]));
  } else if (raw && parsed && typeof raw === 'object' && typeof parsed === 'object') {
    for (const key of Object.keys(raw)) {
      if (!Object.hasOwn(parsed, key)) fail('INVALID_OUTPUT', '模型输出包含契约外字段');
      rejectUnknownFields((raw as Record<string, unknown>)[key], (parsed as Record<string, unknown>)[key]);
    }
  }
}

function validateOutput(text: string, task: AiTask): AiOutput {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fail('INVALID_OUTPUT', '模型输出不是完整 JSON'); }
  const result = aiOutputSchema.safeParse(raw);
  if (!result.success) fail('INVALID_OUTPUT', '模型输出不符合契约');
  const output = result.data;
  rejectUnknownFields(raw, output);
  if (output.kind !== task.kind) fail('INVALID_OUTPUT', '模型输出任务类型不匹配');
  const sourceIds = new Set('sources' in task ? task.sources.map(s => s.id) : []);
  const checkSources = (ids: string[]) => {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !sourceIds.has(id))) fail('INVALID_OUTPUT', '模型引用不属于本次资料范围');
  };
  if (output.kind === 'extract') output.candidates.forEach(c => checkSources(c.sourceIds));
  if (output.kind === 'quiz' && task.kind === 'quiz') {
    if (output.questions.length !== task.count) fail('INVALID_OUTPUT', '题量与请求不一致');
    for (const q of output.questions) {
      const point = task.points.find(p => p.id === q.knowledgeId);
      if (!point || q.sourceIds.some(id => !point.sourceIds.includes(id))) fail('INVALID_OUTPUT', '题目超出已确认范围');
      checkSources(q.sourceIds);
      // Combination context only: the question is still assessed and scheduled under knowledgeId.
      if (q.relatedKnowledgeIds?.some(id => !task.related?.some(item => item.id === id))) fail('INVALID_OUTPUT', '结合的旧知识点不属于本次联想范围');
      if (q.kind === 'single' && new Set(q.options).size !== q.options.length) fail('INVALID_OUTPUT', '单选选项重复');
      if (q.code && !task.code?.languages.includes(q.code.language)) fail('INVALID_OUTPUT', '代码题未开启或语言不在所选范围');
    }
  }
  if (output.kind === 'grade' && task.kind === 'grade') {
    if (output.status === 'needs_verification' && output.scores.length) fail('INVALID_OUTPUT', '待核对不能伪装为已有分数');
    const rubric = task.question.rubric;
    if (output.status === 'graded' && output.scores.length !== rubric.length) fail('INVALID_OUTPUT', '评分项不完整');
    if (new Set(output.scores.map(s => s.rubricId)).size !== output.scores.length) fail('INVALID_OUTPUT', '评分项重复');
    for (const score of output.scores) {
      const item = rubric.find(r => r.id === score.rubricId);
      if (!item || score.score > item.maxScore || !score.evidence.trim()) fail('INVALID_OUTPUT', '评分缺乏合法依据或超出分项上限');
    }
  }
  return output;
}

/**
 * Anthropic charges a write premium for every cache_control block, so Pi's default marks (system
 * prompt and the last user block) would pay for content that is never reused. Keep one mark at the
 * end of the stable scope block, only for tasks whose prefix is reused within a learning session.
 */
export function anthropicCacheMarks(payload: unknown, cacheable: boolean): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const next = structuredClone(payload) as { system?: unknown; tools?: unknown; messages?: { role?: string; content?: unknown }[] };
  const strip = (blocks: unknown) => { if (Array.isArray(blocks)) for (const block of blocks) if (block && typeof block === 'object') delete (block as { cache_control?: unknown }).cache_control; };
  strip(next.system); strip(next.tools);
  for (const message of next.messages ?? []) strip(message.content);
  const first = next.messages?.[0];
  if (cacheable && first?.role === 'user' && Array.isArray(first.content) && first.content.length > 1) {
    const stable = first.content[0] as { type?: string; cache_control?: unknown } | undefined;
    if (stable?.type === 'text') stable.cache_control = { type: 'ephemeral' };
  }
  return next;
}

function usageOf(message: AssistantMessage, mode: Mode): Usage | null {
  const u = message.usage;
  if (!u || [u.input, u.output, u.cacheRead, u.cacheWrite].some(n => !Number.isSafeInteger(n) || n < 0)) return null;
  if (!Number.isSafeInteger(u.input + u.cacheRead + u.cacheWrite)) return null;
  // Pi can initialize missing provider usage to zeros. That is unknown, not a free live call.
  if (mode === 'live' && u.input + u.output + u.cacheRead + u.cacheWrite === 0) return null;
  const cost = u.cost?.total;
  return { provider: message.provider, model: message.model, inputTokens: u.input + u.cacheRead + u.cacheWrite,
    outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite,
    cost: mode === 'mock' ? 0 : Number.isFinite(cost) && cost > 0 ? cost : null };
}

export function createLearningEngine(input: EngineConfig = { mode: 'mock' }, dependencies: { credentials?: CredentialStore; transport?: LearningTransport } = {}): LearningEngine {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) fail('INVALID_CONFIG', '学习引擎配置无效');
  const config = parsed.data;
  if (config.mode === 'live') {
    if (!config.provider || !config.model) fail('MODEL_NOT_CONFIGURED', `Live 必须显式指定 provider、model 和认证方式。${LIVE_ENVIRONMENT_WARNING}`);
    if (config.authMethod === 'api_key' && (!config.apiKey || providerPolicy(config.provider).oauthOnly)) fail('MODEL_NOT_CONFIGURED', '此模式必须显式提供 API key；所选厂商仅支持 OAuth');
    if (config.authMethod === 'oauth' && (config.apiKey || !dependencies.credentials)) fail('MODEL_NOT_CONFIGURED', 'OAuth 必须使用应用自己的 CredentialStore，不能同时指定 API key');
    if (config.authMethod === 'oauth' && providerPolicy(config.provider).unboundedOAuthOutput && !config.allowUnboundedOAuthOutput) fail('OUTPUT_LIMIT_NOT_SUPPORTED', 'Pi 的 OpenAI/Codex OAuth 不提供上游输出 token 硬上限；需明确确认此限制后才能启用真实调用');
    assertLiveEnvironment();
  }
  if (config.mode === 'mock' && (config.provider || config.model || config.apiKey || config.authMethod === 'oauth')) fail('INVALID_CONFIG', 'Mock 不接受真实模型或凭据配置');

  // Each execute owns a fresh mutable Agent and faux queue; concurrent tasks cannot share transcripts.
  const liveProvider = config.mode === 'live' ? createExplicitProvider(config.provider!) : undefined;
  const liveModel = liveProvider?.getModels().find(m => m.id === config.model);
  if (liveProvider && !liveModel) fail('MODEL_NOT_CONFIGURED', '所选 Provider 中不存在指定聊天模型');
  if (liveModel && (!Number.isSafeInteger(liveModel.contextWindow) || liveModel.contextWindow < 1)) fail('INVALID_CONFIG', '模型目录的上下文窗口无效');
  const transport = dependencies.transport ?? new LearningTransport();
  return {
    mode: config.mode,
    close: async () => { if (!dependencies.transport) await transport.close(); },
    async execute(inputTask, { signal, onUsage, onProgress, onRequest, onTransport, connectionPolicy, cacheScope, expectedPrompt }): Promise<AiResponse> {
      if (signal.aborted) fail('CANCELLED', '任务已取消');
      const parsedTask = modelAiTaskSchema.safeParse(inputTask);
      if (!parsedTask.success) fail('INVALID_TASK', '任务输入不符合契约或范围限额');
      const task = parsedTask.data;
      assertLearningPrompt(task, expectedPrompt);
      const cacheRetention = task.kind === 'connection_test' ? 'none' : config.cacheRetention;
      // The host supplies an opaque, purpose-scoped identity, never a credential or raw user data.
      // This is routing affinity only: every task still sends its own prompt and obtains a new answer.
      const sessionId = cacheRetention === 'short' ? cacheScope : undefined;
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId))) {
        fail('INVALID_TASK', '缓存范围标识无效');
      }
      // Final validation only: never silently change the persisted prepared task at execution.
      // Complete system/schema/user budget checks precede credentials, stream, and usage.
      const prepared = checkLearningRequest(task, {
        ...(liveModel ? { contextWindow: liveModel.contextWindow } : {}), maxOutputTokens: config.maxOutputTokens,
      });
      const { blocks, systemPrompt, outputReserveTokens: maxOutputTokens } = prepared;
      const timeoutMs = task.kind === 'connection_test' ? Math.min(config.timeoutMs, 30_000) : config.timeoutMs;
      if (liveModel && !liveModel.input.includes('text')) fail('MODEL_NOT_CONFIGURED', '模型不支持文本任务');
      if (liveModel && (!Number.isSafeInteger(liveModel.maxTokens) || liveModel.maxTokens < maxOutputTokens)) fail('INVALID_CONFIG', '输出限额超过模型目录上限');
      if ('sources' in task && new Set(task.sources.map(s => s.id)).size !== task.sources.length) fail('INVALID_TASK', '资料 ID 重复');
      if ('points' in task && new Set(task.points.map(p => p.id)).size !== task.points.length) fail('INVALID_TASK', '知识点 ID 重复');
      if (config.mode === 'live') assertLiveEnvironment();
      const policy = connectionPolicySchema.safeParse(connectionPolicy ?? config.connectionPolicy);
      if (!policy.success) fail('INVALID_CONFIG', '模型连接策略无效');
      let closed = false;
      const controller = new AbortController();
      const requestTransport = new RequestTransport(transport, policy.data, () => !closed && !signal.aborted && !controller.signal.aborted, onTransport);
      const failure = new RequestFailureObserver(() => !closed && !signal.aborted, liveModel?.api === 'openai-codex-responses', requestTransport.fetch, controller.signal);
      const credentials = failure.credentials(config.mode === 'live' && config.authMethod === 'oauth' ? dependencies.credentials! : new InMemoryCredentialStore());
      if (config.mode === 'live' && config.authMethod === 'oauth') {
        let credential;
        try { credential = await credentials.read(config.provider!, { signal }); }
        catch { fail(signal.aborted ? 'CANCELLED' : 'MODEL_AUTH_FAILED', '读取模型授权失败'); }
        if (credential?.type !== 'oauth') fail('MODEL_NOT_AUTHORIZED', '请先在 AI 授权页面连接所选 Provider');
      }
      const models = createModels({ credentials, authContext: isolatedAuthContext });
      const faux = liveProvider ? undefined : fauxProvider({ api: 'learning-faux', provider: 'learning-mock', tokenSize: { min: 4, max: 4 } });
      const provider = liveProvider ?? faux!.provider;
      models.setProvider(provider);
      const model = models.getModel(provider.id, config.model ?? faux!.getModel().id);
      if (!model || !model.input.includes('text')) fail('MODEL_NOT_CONFIGURED', '模型不支持文本任务');
      if (maxOutputTokens > model.maxTokens) fail('INVALID_CONFIG', '输出限额超过模型目录上限');
      faux?.setResponses([fauxAssistantMessage(JSON.stringify(scriptOutput(task)))]);
      let requestCount = 0;
      let streamedChars = 0;
      let observedUsage: Usage | null = null;
      let usageDelivery = Promise.resolve();
      let generated = false;
      let responded = false;
      let firstResponseTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const progress = (event: LearningProgressEvent) => {
        if (closed || controller.signal.aborted) return;
        try { onProgress?.(event); } catch { /* Telemetry must not interrupt a model task. */ }
      };
      const clearStreamTimers = () => { clearTimeout(firstResponseTimer); clearTimeout(idleTimer); };
      const responseActivity = () => {
        if (closed || generated || controller.signal.aborted) return;
        if (!responded) { responded = true; clearTimeout(firstResponseTimer); progress('response'); }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop('STREAM_IDLE_TIMEOUT', '模型响应流长时间没有新内容；上游可能仍有费用'), Math.min(config.streamIdleTimeoutMs, timeoutMs));
      };
      const stream = models.streamSimple.bind(models);
      // Only follow-ups and the session quiz reuse a scope prefix; a review quiz (with recall) is one-off.
      const cacheable = cacheRetention === 'short' && (task.kind === 'followup' || (task.kind === 'quiz' && task.recall === undefined));
      const agent = new Agent({
        initialState: { model, thinkingLevel: 'off', tools: [], systemPrompt },
        toolExecution: 'sequential',
        finishTurn: async () => ({ action: 'end' }),
        streamFn: (requestModel, context, options) => {
          if (++requestCount > 1) fail('REQUEST_LIMIT', '每个任务最多一次模型请求，不自动修复或重试');
          if (!closed && !controller.signal.aborted) {
            try { onRequest?.({ provider: model.provider, model: model.id, authMethod: config.mode === 'mock' ? 'mock' : config.authMethod,
              cacheRetention, inputChars: systemPrompt.length + prepared.prompt.length,
              inputBytes: Buffer.byteLength(systemPrompt, 'utf8') + Buffer.byteLength(prepared.prompt, 'utf8'),
              estimatedInputTokens: prepared.estimatedInputTokens, contextWindow: prepared.contextWindow,
              maxOutputTokens, timeoutMs, firstResponseTimeoutMs: Math.min(config.firstResponseTimeoutMs, timeoutMs),
              streamIdleTimeoutMs: Math.min(config.streamIdleTimeoutMs, timeoutMs),
            }); } catch { /* Diagnostics cannot alter a learning request. */ }
          }
          progress('request');
          firstResponseTimer = setTimeout(() => stop('FIRST_RESPONSE_TIMEOUT', '等待模型首响应超时；上游可能仍有费用'), Math.min(config.firstResponseTimeoutMs, timeoutMs));
          return stream(requestModel, context, { ...options,
            signal: AbortSignal.any([controller.signal, ...(options?.signal ? [options.signal] : [])]),
            apiKey: config.apiKey, maxTokens: maxOutputTokens, timeoutMs, maxRetries: 0,
            reasoning: undefined, cacheRetention, sessionId, transport: 'sse',
            headers: { 'OpenAI-Organization': null, 'OpenAI-Project': null },
            fetch: failure.fetch,
            onProviderStreamEvent: event => failure.event(event),
            onResponse: response => {
              failure.response(response.status);
              responseActivity();
            },
            onPayload: (payload, payloadModel) => payloadModel.api === 'anthropic-messages' ? anthropicCacheMarks(payload, cacheable) : undefined,
          });
        },
      });
      let rejectStopped!: (error: LearningEngineError) => void;
      const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const stop = (code: string, message: string) => {
        if (closed || controller.signal.aborted) return;
        clearStreamTimers();
        controller.abort();
        agent.abort();
        rejectStopped(new LearningEngineError(code, message, observedUsage));
      };
      const onAbort = () => stop('CANCELLED', '任务已取消；上游可能仍有费用');
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop('TIMEOUT', '任务超时；上游可能仍有费用'), timeoutMs);
      const unsubscribe = agent.subscribe(event => {
        if (closed) return;
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          generated = true; clearStreamTimers();
          if (event.message.stopReason === 'stop' && !failure.code(event.message)) progress('generated');
          observedUsage = usageOf(event.message, config.mode);
          if (observedUsage && onUsage) {
            const snapshot = structuredClone(observedUsage);
            usageDelivery = usageDelivery.then(() => onUsage(snapshot));
            void usageDelivery.catch(() => undefined);
          }
        }
        if (event.type === 'message_update' && !controller.signal.aborted) {
          const update = event.assistantMessageEvent;
          // Start events and empty chunks/keepalives do not prove generation is progressing.
          if ((update.type === 'text_delta' || update.type === 'thinking_delta') && update.delta.length > 0) {
            responseActivity(); progress(update.type === 'text_delta' ? 'text' : 'thinking');
          }
          if (update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta') streamedChars += update.delta.length;
          if (streamedChars > 100_000) stop('OUTPUT_LIMIT', '模型输出超出字符限额');
          if (update.type === 'toolcall_start') stop('INVALID_OUTPUT', '固定任务不允许模型调用工具');
        }
      });
      try {
        if (signal.aborted) { onAbort(); await stopped; }
        // Separate text blocks keep the stable scope context as an exact, reusable prefix.
        const message = { role: 'user' as const, content: blocks.map(text => ({ type: 'text' as const, text })), timestamp: Date.now() };
        await Promise.race([agent.prompt(message), stopped]);
        if (signal.aborted || controller.signal.aborted) fail('CANCELLED', '任务已取消');
        const last = agent.state.messages.at(-1);
        if (!last || last.role !== 'assistant') fail('INVALID_OUTPUT', '模型未返回最终消息');
        const observedFailure = failure.code(last);
        if (observedFailure || last.stopReason !== 'stop') throw new LearningEngineError(observedFailure ?? (last.stopReason === 'aborted' ? 'CANCELLED' : 'MODEL_FAILED'), '模型未完成可接受的响应', observedUsage);
        if (last.content.some(c => c.type !== 'text' && c.type !== 'thinking')) fail('INVALID_OUTPUT', '模型返回了非文本任务结果');
        const text = last.content.filter(c => c.type === 'text').map(c => c.text).join('');
        if (text.length > 100_000 || (last.usage?.output ?? 0) > maxOutputTokens) fail('OUTPUT_LIMIT', '模型输出超出限额');
        const output = validateOutput(text, task);
        clearTimeout(timer); clearStreamTimers(); progress('validated');
        // Persistence latency is observable as saving, not charged to model time.
        await Promise.race([usageDelivery, stopped]);
        return { output, usage: observedUsage };
      } catch (error) {
        if (error instanceof LearningEngineError) throw new LearningEngineError(error.code, error.message, error.usage ?? observedUsage);
        throw new LearningEngineError(failure.code() ?? 'MODEL_FAILED', '模型执行失败；未提交任何学习结果', observedUsage);
      } finally {
        requestTransport.close();
        closed = true; clearTimeout(timer); clearStreamTimers();
        signal.removeEventListener('abort', onAbort);
        unsubscribe();
        controller.abort();
        agent.abort();
        // No unbounded waitForIdle: abandoned work has no tools, subscriptions, or write authority.
      }
    },
  };
}
