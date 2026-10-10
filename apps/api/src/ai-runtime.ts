import { z } from 'zod';
import { createHmac } from 'node:crypto';
import type { CredentialStore } from '@sanxing/ai-access';
import { createExplicitProvider, LIVE_PROVIDER_IDS, providerPolicy, type LiveProviderId } from '@sanxing/ai-access/providers';
import { LIMITS, aiModelSelectionSchema, isActiveRun, type AiModelConfiguration, type AiModelProvider, type AiModelSelection, type AiTask, type AppData, type LearningEngine, type TaskInputPreview } from '@sanxing/contracts';
import type { Repository } from '@sanxing/database';
import { createLearningEngine, prepareLearningRequest, inspectLearningRequest, CONNECTION_TEST_OUTPUT_TOKENS, INPUT_SAFETY_MARGIN_TOKENS } from '@sanxing/learning-agent';
import { DomainError, effectiveLearningPreferences } from '@sanxing/learning-domain';
import { planLearningInput } from './input-plan.ts';
import type { ApiConfig } from './config.ts';

const saveSchema = aiModelSelectionSchema.extend({ expectedRevision: z.number().int().nonnegative() }).strict();

/** Local catalog/configuration only; constructing the runtime never constructs a live engine. */
export class AiModelRuntime implements LearningEngine {
  private readonly config: ApiConfig;
  private readonly repository: Repository;
  private readonly credentials?: CredentialStore;
  private readonly engineFactory: typeof createLearningEngine;

  constructor(options: { config: ApiConfig; repository: Repository; credentials?: CredentialStore; engineFactory?: typeof createLearningEngine }) {
    this.config = structuredClone(options.config);
    this.repository = options.repository;
    this.credentials = options.credentials;
    this.engineFactory = options.engineFactory ?? createLearningEngine;
  }

  get mode() { return this.config.mode; }

  private selected(data: AppData): Pick<AiModelConfiguration, 'selection' | 'source'> {
    if (data.aiModel != null) return { selection: structuredClone(data.aiModel), source: 'saved' };
    const { provider, model, modelAuthMethod, allowUnboundedOAuthOutput } = this.config;
    if (provider && model) return { source: 'environment', selection: {
      providerId: provider, modelId: model, authMethod: modelAuthMethod, allowUnboundedOutput: allowUnboundedOAuthOutput,
    } };
    return { selection: null, source: 'none' };
  }

  private async providers(): Promise<AiModelProvider[]> {
    return Promise.all(LIVE_PROVIDER_IDS.map(async id => {
      const provider = createExplicitProvider(id);
      let oauthConnected = false;
      try { oauthConnected = (await this.credentials?.read(id))?.type === 'oauth'; }
      catch { throw new DomainError('AI_CREDENTIALS_UNAVAILABLE', '无法读取本地 AI 授权状态，请稍后重试', 409); }
      return {
        id, name: provider.name, oauthConnected,
        apiKeyAvailable: this.config.provider === id && Boolean(this.config.apiKey) && !providerPolicy(id).oauthOnly,
        requiresOAuthOutputAcknowledgement: providerPolicy(id).unboundedOAuthOutput,
        // getModels is the explicit provider's synchronous chat catalog, not account discovery.
        models: provider.getModels().filter(model => model.input.includes('text')).map(({ id, name }) => ({ id, name })),
      };
    }));
  }

  private validate(selection: AiModelSelection | null, providers: AiModelProvider[]): asserts selection is AiModelSelection {
    if (!selection) throw new DomainError('AI_MODEL_REQUIRED', '请先在 AI 配置页面选择并保存模型', 400);
    if (!aiModelSelectionSchema.safeParse(selection).success) throw new DomainError('AI_MODEL_INVALID', 'AI 模型配置格式无效，请重新选择并保存', 400);
    const provider = providers.find(item => item.id === selection.providerId);
    if (!provider) throw new DomainError('AI_PROVIDER_UNSUPPORTED', '不支持所选 AI 厂商，请重新选择', 400);
    if (!provider.models.some(model => model.id === selection.modelId)) throw new DomainError('AI_MODEL_UNSUPPORTED', '所选模型不在本地文本聊天模型目录中，请重新选择', 400);
    if (selection.authMethod === 'oauth') {
      if (!provider.oauthConnected) throw new DomainError('AI_MODEL_UNAUTHORIZED', '请先在 AI 配置页面授权所选厂商', 400);
      if (provider.requiresOAuthOutputAcknowledgement && !selection.allowUnboundedOutput) {
        throw new DomainError('AI_OUTPUT_ACK_REQUIRED', '此厂商 OAuth 不保证上游输出 token 硬上限，请先明确确认此限制', 400);
      }
    } else if (!provider.apiKeyAvailable) {
      throw new DomainError('AI_API_KEY_UNAVAILABLE', '所选厂商未配置可用 API key，或该厂商仅支持 OAuth', 400);
    }
  }

  async configuration(): Promise<AiModelConfiguration> {
    const data = await this.repository.read();
    const selected = this.selected(data);
    const providers = await this.providers();
    let problem: string | null = null;
    if (this.mode === 'live') {
      try { this.validate(selected.selection, providers); }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        problem = error.message;
      }
    }
    const enabled = this.mode === 'live' && this.config.dailyBudgetUsd !== null;
    return { mode: this.mode, revision: data.revision, ...selected, providers, ready: problem === null, problem,
      budget: { enabled, dailyUsd: enabled ? this.config.dailyBudgetUsd : null, reservationUsd: enabled ? this.config.requestReservationUsd : null } };
  }

  async save(input: unknown): Promise<AiModelConfiguration> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('AI_MODEL_INVALID', 'AI 模型配置格式无效，请仅提交模型选择和当前版本', 400);
    const { expectedRevision, ...selection } = parsed.data;
    await this.repository.transact(async data => {
      if (data.revision !== expectedRevision) throw new DomainError('REVISION_CONFLICT', '数据已更新，请刷新后重新保存模型', 409);
      if (Object.values(data.runs).some(isActiveRun)) {
        throw new DomainError('AI_MODEL_BUSY', '仍有排队或执行中的 AI 任务，请等待任务结束后再更换模型', 409);
      }
      // Recheck local credentials under the repository transaction; never nest repository reads.
      this.validate(selection, await this.providers());
      data.aiModel = structuredClone(selection);
    });
    return this.configuration();
  }

  private async resolved(data: AppData): Promise<AiModelSelection> {
    const selection = this.selected(data).selection;
    this.validate(selection, await this.providers());
    return selection;
  }

  /** Pure local catalog lookup: no credentials, refresh, engine construction or network. */
  private inputPolicy(data: AppData, task: AiTask) {
    if (this.mode === 'mock') return { model: null, contextWindow: undefined, maxOutputTokens: this.config.maxOutputTokens };
    const selection = task.kind === 'connection_test' ? task.selection : this.selected(data).selection;
    if (!selection) throw new DomainError('AI_MODEL_REQUIRED', '请先在 AI 配置页面选择并保存模型', 400);
    if (!LIVE_PROVIDER_IDS.includes(selection.providerId as LiveProviderId)) throw new DomainError('AI_PROVIDER_UNSUPPORTED', '所选厂商不受支持，请重新选择', 400);
    const model = createExplicitProvider(selection.providerId as LiveProviderId).getModels().find(model => model.id === selection.modelId && model.input.includes('text'));
    if (!model) throw new DomainError('AI_MODEL_UNSUPPORTED', '所选模型不在本地文本聊天目录中，请重新选择', 400);
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) {
      throw new DomainError('AI_MODEL_LIMIT_INVALID', '模型目录缺少有效的上下文或输出上限，不能预检或提交任务', 400);
    }
    const maxOutputTokens = task.kind === 'connection_test' ? Math.min(this.config.maxOutputTokens, CONNECTION_TEST_OUTPUT_TOKENS) : this.config.maxOutputTokens;
    if (maxOutputTokens > model.maxTokens) throw new DomainError('AI_OUTPUT_LIMIT_INVALID', '输出预留超过所选模型上限，请调整配置或模型', 400);
    return { model: { providerId: selection.providerId, modelId: model.id }, contextWindow: model.contextWindow, maxOutputTokens };
  }

  /** Used inside the domain transaction, so the persisted run is exactly the budgeted task. */
  prepareTask(data: AppData, task: AiTask): AiTask {
    const policy = this.inputPolicy(data, task);
    return prepareLearningRequest(planLearningInput(task, policy).task, policy).task;
  }

  previewTask(data: AppData, task: Extract<AiTask, { kind: 'extract' | 'grade' }>): TaskInputPreview {
    // Same plan as the queued task, but a model/budget error must still render a read-only view.
    let policy: ReturnType<AiModelRuntime['inputPolicy']> | null = null;
    let retrieval: ReturnType<typeof planLearningInput<typeof task>> | null = null;
    try { policy = this.inputPolicy(data, task); retrieval = planLearningInput(task, policy); task = retrieval.task; } catch (error) { if (!(error instanceof DomainError)) throw error; }
    const view: TaskInputPreview = { kind: task.kind, revision: data.revision, canSubmit: false, reason: null, model: null,
      documentCount: task.kind === 'extract' ? task.sources.filter(source => !source.id.startsWith('recitation:')).length : 0,
      originalChars: JSON.stringify(task).length, sentChars: null, maxChars: LIMITS.modelInputChars,
      contextWindow: null, estimatedInputTokens: null, outputReserveTokens: this.config.maxOutputTokens,
      safetyMarginTokens: INPUT_SAFETY_MARGIN_TOKENS, remainingInputTokens: null, truncated: false, fields: [],
      ...(task.kind === 'extract' && retrieval ? { retrieval: retrieval.summary } : {}) };
    try {
      policy ??= this.inputPolicy(data, task); // rethrows the catalog error for the view
      view.model = policy.model;
      view.contextWindow = policy.contextWindow ?? null;
      view.originalChars = inspectLearningRequest(task, policy).prompt.length;
      const prepared = prepareLearningRequest(task, policy);
      Object.assign(view, { canSubmit: true, sentChars: prepared.prompt.length,
        contextWindow: prepared.contextWindow, estimatedInputTokens: prepared.estimatedInputTokens,
        outputReserveTokens: prepared.outputReserveTokens, safetyMarginTokens: prepared.safetyMarginTokens,
        remainingInputTokens: prepared.remainingInputTokens === null ? null : Math.max(0, prepared.remainingInputTokens - prepared.estimatedInputTokens),
        truncated: prepared.truncated });
      // Only editable/source text has field summaries. Private grading material is never projected.
      if (task.kind === 'extract') view.fields = prepared.fields.map(field => ({ ...field, label:
        ({ 'recitation.learned': '今天学了什么', 'recitation.unclear': '哪里还说不清', 'recitation.application': '明天怎么用上' } as Record<string, string>)[field.path]
          ?? task.sources.find(source => field.path === `sources.${source.id}.text`)?.name ?? '任务文本' }));
      if (!(task.kind === 'extract' ? task.recitation.learned : task.answer).trim()) {
        view.canSubmit = false; view.reason = task.kind === 'extract' ? '请先写下今天学到了什么' : '请填写答案，或明确跳过本题';
      }
    } catch (error) {
      if (error instanceof DomainError) view.reason = error.message;
      else if (error instanceof Error && 'code' in error && error.code === 'MODEL_INPUT_TOO_LARGE') {
        view.reason = task.kind === 'grade' ? '完整评分标准与正式答案超出当前输入预算；不会截断。请精简答案、选择更大上下文模型或跳过。' : '当前模型预算无法容纳固定任务内容和系统提示；请选择更大上下文模型或调整输出预留。';
      } else throw error;
    }
    return view;
  }

  async assertCanQueue(data: AppData): Promise<void> {
    if (this.mode === 'mock') return;
    await this.resolved(data);
  }

  /** Validate against the transaction draft; never choose a model for the caller. */
  async assertConnectionTest(data: AppData, providerId: string, expected: AiModelSelection): Promise<AiModelSelection> {
    if (this.mode !== 'live') throw new DomainError('AI_TEST_LIVE_REQUIRED', '模拟模式不能验证真实连接，请先明确启用 live 并保存模型', 400);
    const selection = await this.resolved(data);
    if (selection.providerId !== providerId || selection.authMethod !== 'oauth') {
      throw new DomainError('AI_TEST_OAUTH_REQUIRED', '请先保存此 Provider 的 OAuth 模型，再测试该授权连接', 400);
    }
    if (!(['providerId', 'modelId', 'authMethod', 'allowUnboundedOutput'] as const).every(key => selection[key] === expected[key])) {
      throw new DomainError('AI_TEST_MODEL_CHANGED', '已保存的模型配置发生变化，请刷新并重新确认测试对象', 409);
    }
    return structuredClone(selection);
  }

  async execute(task: Parameters<LearningEngine['execute']>[0], options: Parameters<LearningEngine['execute']>[1]): ReturnType<LearningEngine['execute']> {
    options.signal.throwIfAborted();
    const data = await this.repository.read();
    options.signal.throwIfAborted();
    const limits = { maxOutputTokens: this.config.maxOutputTokens, timeoutMs: this.config.runTimeoutMs };
    if (this.mode === 'mock') {
      if (task.kind === 'connection_test') throw new DomainError('AI_TEST_LIVE_REQUIRED', '模拟模式不能验证真实连接', 400);
      // Mock remains faux, even when the database contains a saved live candidate.
      return this.engineFactory({ mode: 'mock', ...limits }).execute(task, options);
    }
    const selection = task.kind === 'connection_test'
      ? await this.assertConnectionTest(data, task.selection.providerId, task.selection)
      : await this.resolved(data);
    options.signal.throwIfAborted();
    const { promptCacheRetention } = effectiveLearningPreferences(data, this.config);
    const engine = this.engineFactory({
      mode: 'live', provider: selection.providerId as LiveProviderId, model: selection.modelId,
      authMethod: selection.authMethod, allowUnboundedOAuthOutput: selection.allowUnboundedOutput,
      ...(selection.authMethod === 'api_key' ? { apiKey: this.config.apiKey } : {}), ...limits,
      cacheRetention: task.kind === 'connection_test' ? 'none' : promptCacheRetention,
    }, { credentials: this.credentials });
    // Provider affinity contains no document text, account identifier or credential.
    const { cacheScope, ...execution } = options;
    const key = cacheScope && task.kind !== 'connection_test' && promptCacheRetention === 'short'
      ? createHmac('sha256', this.config.sessionSecret).update(JSON.stringify(['sanxing:prompt-cache:v1', data.ownerId, data.mode, selection.providerId, selection.modelId, cacheScope])).digest('hex')
      : undefined;
    return engine.execute(task, cacheScope === undefined ? options : { ...execution, ...(key ? { cacheScope: key } : {}) });
  }
}
