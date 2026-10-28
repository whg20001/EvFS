import { LIMITS, aiModelSelectionSchema, type AiModelConfiguration, type AiModelSelection, type AiTask, type AppData, type LocalBootstrap, type TaskInputPreview } from '@sanxing/contracts';
import { bindLearningSkills, DomainError, planLearningInput } from '@sanxing/learning-domain';
import { createLearningRequests, CONNECTION_TEST_OUTPUT_TOKENS, INPUT_SAFETY_MARGIN_TOKENS } from '@sanxing/learning-agent/browser';

/** Catalog and prompt inspection contain no credentials or network calls. */
export class LocalModels {
  readonly requests: ReturnType<typeof createLearningRequests>;
  catalog: AiModelConfiguration;
  readonly config;
  constructor(bootstrap: LocalBootstrap) {
    this.requests = createLearningRequests(bootstrap.prompts); this.catalog = bootstrap.configuration;
    this.config = { ...bootstrap.config, maxOutputTokens: bootstrap.maxOutputTokens };
  }
  validate(selection: AiModelSelection | null) {
    if (!selection) throw new DomainError('AI_MODEL_REQUIRED', '请先在 AI 配置中选择模型。', 400);
    aiModelSelectionSchema.parse(selection);
    const provider = this.catalog.providers.find(item => item.id === selection.providerId);
    if (!provider?.models.some(model => model.id === selection.modelId)) throw new DomainError('AI_MODEL_UNSUPPORTED', '所选模型不在目录中，请刷新配置。', 400);
    if (selection.authMethod === 'platform' ? selection.providerId !== 'platform' || !provider.platformAvailable : selection.authMethod === 'oauth' ? !provider.oauthConnected : !provider.apiKeyAvailable) throw new DomainError('AI_MODEL_UNAUTHORIZED', '所选 AI 服务暂不可用，请检查配置或联系管理员。', 400);
    if (selection.authMethod === 'oauth' && provider.requiresOAuthOutputAcknowledgement && !selection.allowUnboundedOutput) throw new DomainError('AI_MODEL_INVALID', '请重新保存所选认证方式。', 400);
    return selection;
  }
  configuration(data: AppData): AiModelConfiguration {
    let problem: string | null = null;
    if (data.mode === 'live') { try { this.validate(data.aiModel ?? null); } catch (error) { problem = error instanceof Error ? error.message : '模型配置不可用。'; } }
    return { ...this.catalog, mode: data.mode, selection: data.aiModel ?? null, source: data.aiModel ? 'saved' : 'none', revision: data.revision, ready: problem === null, problem };
  }
  private inputPolicy(data: AppData, task: AiTask) {
    if (data.mode === 'mock') return { model: null, contextWindow: undefined, maxOutputTokens: this.config.maxOutputTokens };
    const selection = task.kind === 'connection_test' ? task.selection : data.aiModel;
    if (!selection) throw new DomainError('AI_MODEL_REQUIRED', '请先在 AI 配置中选择模型。', 400);
    const model = this.catalog.providers.find(item => item.id === selection.providerId)?.models.find(item => item.id === selection.modelId);
    if (!model?.contextWindow || !model.maxTokens) throw new DomainError('AI_MODEL_UNSUPPORTED', '模型目录不可用，请刷新 AI 配置。', 400);
    const maxOutputTokens = task.kind === 'connection_test' ? Math.min(this.config.maxOutputTokens, CONNECTION_TEST_OUTPUT_TOKENS) : this.config.maxOutputTokens;
    if (maxOutputTokens > model.maxTokens) throw new DomainError('AI_OUTPUT_LIMIT_INVALID', '输出预留超过所选模型上限。', 400);
    return { model: { providerId: selection.providerId, modelId: model.id }, contextWindow: model.contextWindow, maxOutputTokens };
  }
  prepareTask(data: AppData, task: AiTask): AiTask {
    task = bindLearningSkills(data, task);
    const policy = this.inputPolicy(data, task);
    return this.requests.prepareLearningRequest(planLearningInput(task, policy, this.requests).task, policy).task;
  }
  previewTask(data: AppData, task: Extract<AiTask, { kind: 'extract' | 'grade' }>): TaskInputPreview {
    task = bindLearningSkills(data, task);
    let policy: ReturnType<LocalModels['inputPolicy']> | null = null;
    let retrieval: ReturnType<typeof planLearningInput<typeof task>> | null = null;
    try { policy = this.inputPolicy(data, task); retrieval = planLearningInput(task, policy, this.requests); task = retrieval.task; }
    catch (error) { if (!(error instanceof DomainError)) throw error; }
    const view: TaskInputPreview = { kind: task.kind, revision: data.revision, canSubmit: false, reason: null, model: null,
      documentCount: task.kind === 'extract' ? task.sources.filter(source => !source.id.startsWith('recitation:')).length : 0,
      originalChars: JSON.stringify(task).length, sentChars: null, maxChars: LIMITS.modelInputChars,
      contextWindow: null, estimatedInputTokens: null, outputReserveTokens: this.config.maxOutputTokens,
      safetyMarginTokens: INPUT_SAFETY_MARGIN_TOKENS, remainingInputTokens: null, truncated: false, fields: [],
      ...(task.kind === 'extract' && retrieval ? { retrieval: retrieval.summary } : {}) };
    try {
      policy ??= this.inputPolicy(data, task); view.model = policy.model;
      view.originalChars = this.requests.inspectLearningRequest(task, policy).prompt.length;
      const prepared = this.requests.prepareLearningRequest(task, policy);
      Object.assign(view, { canSubmit: true, sentChars: prepared.prompt.length, contextWindow: prepared.contextWindow,
        estimatedInputTokens: prepared.estimatedInputTokens, outputReserveTokens: prepared.outputReserveTokens,
        safetyMarginTokens: prepared.safetyMarginTokens, remainingInputTokens: prepared.remainingInputTokens === null ? null : Math.max(0, prepared.remainingInputTokens - prepared.estimatedInputTokens), truncated: prepared.truncated });
      if (task.kind === 'extract') view.fields = prepared.fields.map(field => ({ ...field, label:
        ({ 'recitation.learned': '今天学了什么', 'recitation.unclear': '哪里还说不清', 'recitation.application': '明天怎么用上' } as Record<string, string>)[field.path]
          ?? task.sources.find(source => field.path === `sources.${source.id}.text`)?.name ?? '任务文本' }));
      if (!(task.kind === 'extract' ? task.recitation.learned : task.answer).trim()) { view.canSubmit = false; view.reason = task.kind === 'extract' ? '请先写下今天学到了什么' : '请填写答案，或明确跳过本题'; }
    } catch (error) { view.reason = error instanceof Error ? error.message : '当前任务不能提交。'; }
    return view;
  }
}
