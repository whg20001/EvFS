import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { CODE_LANGUAGES, DEFAULT_CODE_LANGUAGES, IDEMPOTENCY_KEY_PATTERN, LEARNING_PROMPT_VERSION, LIMITS, aiOutputSchema, answerInputSchema, codeExecutionSchema, executionFitsQuestion, isDocumentFilename, learningPreferencesSchema, isActiveRun, prepareTaskContext, recitationInputSchema, recitationSourceText, usageSchema } from '@sanxing/contracts';
import type { AgentRun, AiModelSelection, AiResponse, AiTask, AppData, Assessment, CodeExecution, CodeLanguage, CommandResult, KnowledgePoint, LearningSession, PointInput, Question, Quiz, RelatedPoint, SourceInput } from '@sanxing/contracts';
import { DomainError, currentQuestionIndex, effectiveLearningPreferences, expectVersion, fingerprint, learningDate, newSchedule, nextSchedule, normalizeTitle, projectState, record, requireThat } from './policy.ts';
import type { DomainConfig } from './policy.ts';
import { findRelatedKnowledge, selectRelevantSources } from './retrieval.ts';

export interface StateRepository {
  read(): Promise<AppData>;
  transact<T>(fn: (data: AppData) => T | Promise<T>): Promise<T>;
}
const versionBody = z.object({ version: z.number().int().positive() });
const noteInput = z.object({ recitationId: z.string(), name: z.string().min(1).max(120), text: z.string() });
const confirmInput = z.object({ version: z.number().int().positive(), decisions: z.array(z.object({ candidateId: z.string(), decision: z.enum(['accepted', 'rejected']), title: z.string().min(1).max(100).optional(), description: z.string().min(1).max(2000).optional(), existingKnowledgeId: z.string().nullable().optional() })).min(1).max(LIMITS.quizQuestionsMaximum) });

// Only known, non-billable, CAS-protected autosaves are transient. Unknown operations stay durable.
const transientReceipt = /^PUT:\/api\/(?:recitations\/[^/:]+\/draft|questions\/[^/:]+\/draft|knowledge-points\/[^/:]+\/understanding|review-sessions\/[^/:]+\/recall):/;

export class LearningService {
  constructor(readonly repository: StateRepository, readonly config: DomainConfig, readonly now: () => Date = () => new Date(),
    private readonly prepareInput: (task: AiTask, data: AppData) => AiTask = task => prepareTaskContext(task).task) {}
  async state(csrfToken: string) { return projectState(await this.repository.read(), this.config, csrfToken); }
  private stamp() { return this.now().toISOString(); }
  async command(operation: string, key: string, body: unknown, action: (state: AppData) => CommandResult | Promise<CommandResult>): Promise<CommandResult> {
    requireThat(IDEMPOTENCY_KEY_PATTERN.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '写入请求需要有效的幂等标识', 400);
    const receiptId = `${operation}:${key}`;
    const hash = fingerprint(body);
    return this.repository.transact(async data => {
      const previous = data.receipts[receiptId];
      if (previous) {
        requireThat(previous.hash === hash, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同内容');
        return previous.result as CommandResult;
      }
      const result = await action(data);
      data.receipts[receiptId] = { hash, result, createdAt: this.stamp() };
      const cutoff = this.now().getTime() - LIMITS.transientReceiptTtlMs;
      const transient = Object.entries(data.receipts).filter(([id, receipt]) => transientReceipt.test(id) && !(receipt.result && typeof receipt.result === 'object' && 'runId' in receipt.result));
      const remaining: typeof transient = [];
      for (const entry of transient) {
        if (Date.parse(entry[1].createdAt) < cutoff) delete data.receipts[entry[0]];
        else remaining.push(entry);
      }
      remaining.sort(([a, x], [b, y]) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || (a < b ? -1 : a > b ? 1 : 0));
      for (const [id] of remaining.slice(0, Math.max(0, remaining.length - LIMITS.transientReceiptMaximum))) delete data.receipts[id];
      return result;
    });
  }
  private session(data: AppData, id: string, version: number): LearningSession {
    const session = record(data.sessions, id);
    expectVersion(session, version);
    requireThat(session.status !== 'COMPLETED', 'SESSION_CLOSED', '本次学习已结束');
    requireThat(!session.activeRunId, 'RUN_IN_PROGRESS', 'AI 正在处理，请等待或明确取消');
    return session;
  }
  private sources(data: AppData, session: Pick<LearningSession, 'id' | 'snapshot' | 'documentIds'>, points?: PointInput[]): SourceInput[] {
    const sources = [{ id: `recitation:${session.id}`, name: '本次原始复述', text: recitationSourceText(session.snapshot) }, ...session.documentIds.map(id => { const doc = record(data.documents, id); return { id: doc.id, name: doc.name, text: doc.text }; })];
    const referenced = points ? new Set(points.flatMap(point => point.sourceIds)) : null;
    return referenced ? sources.filter(source => referenced.has(source.id)) : sources;
  }
  private resolveSource(data: AppData, id: string): SourceInput | null {
    if (Object.hasOwn(data.documents, id)) {
      const document = data.documents[id]!;
      return { id, name: document.name, text: document.text };
    }
    if (id.startsWith('recitation:')) {
      const sessionId = id.slice('recitation:'.length);
      if (Object.hasOwn(data.sessions, sessionId)) {
        const { snapshot } = data.sessions[sessionId]!;
        return { id, name: '此前原始复述（提交快照）', text: recitationSourceText(snapshot) };
      }
    }
    return null;
  }
  private contentBaseline(point: KnowledgePoint) {
    point.contentVersion ??= 1;
    point.contentHistory ??= [];
    if (!point.contentHistory.some(snapshot => snapshot.version === point.contentVersion)) {
      // A legacy baseline is observed now; no historical content or old evidence versions are invented.
      point.contentHistory.push({ version: point.contentVersion, title: point.title, description: point.description, sourceIds: [...point.sourceIds], createdAt: this.stamp() });
    }
  }
  private points(session: LearningSession): PointInput[] {
    return session.candidates.filter(c => c.decision === 'accepted' && c.knowledgeId).map(c => ({ id: c.knowledgeId!, title: c.title, description: c.description, sourceIds: [...c.sourceIds], knowledgeVersion: c.knowledgeVersion ?? null }));
  }
  /** Frozen comparison context: passed beside sources, never as a source or an assessed point. */
  private related(points: readonly (PointInput | KnowledgePoint)[]): { related?: RelatedPoint[] } {
    return points.length ? { related: points.map(point => ({ id: point.id, title: point.title, description: point.description, knowledgeVersion: 'knowledgeVersion' in point && point.knowledgeVersion ? point.knowledgeVersion : (point as KnowledgePoint).contentVersion! })) } : {};
  }
  /** Offered to the model only when the owner enabled code exercises; the model still decides per point. */
  private codeOption(data: AppData): { code?: { languages: CodeLanguage[] } } {
    const preferences = effectiveLearningPreferences(data, this.config);
    return preferences.codeExercisesEnabled ? { code: { languages: [...preferences.codeLanguages] } } : {};
  }
  private codeEvidence(question: Question, execution?: CodeExecution, skipped = false): { execution?: CodeExecution } {
    if (!execution) return {};
    requireThat(!skipped, 'INVALID_ANSWER', '跳过题目不能携带运行结果', 400);
    requireThat(executionFitsQuestion(question, execution), 'INVALID_ANSWER', question.kind === 'code' ? '运行结果与本题测试数量不一致' : '只有代码题可以附带运行结果', 400);
    return { execution };
  }
  /** Lexical association over confirmed knowledge, only when the owner enabled it. */
  private associate(data: AppData, query: string, exclude: ReadonlySet<string>): KnowledgePoint[] {
    if (!effectiveLearningPreferences(data, this.config).associationEnabled) return [];
    const related = findRelatedKnowledge(data, query, exclude);
    for (const point of related) this.contentBaseline(point);
    return related;
  }
  private queue(data: AppData, task: AiTask, owner: { sessionId?: string; reviewSessionId?: string; quizId?: string; questionId?: string }, alreadyPrepared = false): AgentRun {
    let contextError: string | null = null;
    let inputPrepared = alreadyPrepared;
    try { if (!alreadyPrepared) task = this.prepareInput(task, data); inputPrepared = true; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODEL_INPUT_TOO_LARGE') throw error;
      contextError = error.message;
    }
    const session = owner.sessionId ? record(data.sessions, owner.sessionId) : null;
    const review = owner.reviewSessionId ? record(data.reviewSessions, owner.reviewSessionId) : null;
    const quiz = owner.quizId ? record(data.quizzes, owner.quizId) : null;
    requireThat(!session?.activeRunId && !review?.activeRunId, 'RUN_IN_PROGRESS', '已有活动任务');
    const previous = Object.values(data.runs);
    const dailyBudget = this.config.mode === 'live' ? this.config.dailyBudgetUsd : null;
    const owned = (run: AgentRun) => run.task.kind !== 'connection_test' && (owner.sessionId ? run.sessionId === owner.sessionId : Boolean(owner.reviewSessionId && run.reviewSessionId === owner.reviewSessionId));
    // startedAt stays null when admission fails before a model call. Those refusals must not burn the session cap.
    const calls = previous.filter(run => owned(run) && run.startedAt !== null).length;
    let error: string | null = null;
    if (task.kind !== 'connection_test' && calls >= this.config.maxCallsPerSession) error = '本次会话已达到模型调用上限，请结束或稍后再学习。';
    else if ('points' in task && new Set(task.points.map(point => point.id)).size !== task.points.length) error = '多个候选归入了同一个知识点。请重新确认范围，每项只绑定一个知识点。';
    else if (contextError) error = contextError;
    else if (dailyBudget !== null) {
      const today = learningDate(this.now(), this.config.timezone);
      const dailyRuns = previous.filter(run => learningDate(new Date(run.createdAt), this.config.timezone) === today);
      const spent = dailyRuns.reduce((sum, run) => sum + (run.usage?.cost ?? run.reservationUsd), 0);
      if (dailyRuns.some(run => run.startedAt !== null && run.usage?.cost == null && run.reservationUsd === 0)) error = '今日存在未预留的未知费用，不能按零计入预算；请核对预算策略或等待下一个预算日。';
      else if (spent + this.config.requestReservationUsd > dailyBudget) error = '今日模型预算不足，输入已保存，未发起模型请求。';
    }
    const run: AgentRun = {
      id: randomUUID(), status: error ? 'failed' : 'pending', task: structuredClone(task), sessionId: session?.id ?? null, reviewSessionId: review?.id ?? null,
      quizId: quiz?.id ?? null, questionId: owner.questionId ?? null, attempt: 0, attemptId: null,
      expectedVersion: task.kind === 'connection_test' ? 0 : task.kind === 'grade' ? quiz!.version : (session?.version ?? review!.version),
      createdAt: this.stamp(), startedAt: null, finishedAt: error ? this.stamp() : null, error, usage: null,
      reservationUsd: error || dailyBudget === null ? 0 : this.config.requestReservationUsd, promptVersion: task.kind === 'connection_test' ? 'connection-v1' : LEARNING_PROMPT_VERSION, inputPrepared
    };
    data.runs[run.id] = run;
    if (!error) { if (session) session.activeRunId = run.id; if (review) review.activeRunId = run.id; }
    if (error && quiz && owner.questionId) {
      const answer = record(quiz.answers, owner.questionId);
      answer.assessment = { ...answer.assessment, status: 'needs_verification', feedback: error };
    }
    return run;
  }
  connectionTest(data: AppData, selection: AiModelSelection): CommandResult {
    requireThat(this.config.mode === 'live', 'LIVE_MODE_REQUIRED', '连接测试仅适用于真实模型模式');
    const runs = Object.values(data.runs);
    requireThat(!runs.some(isActiveRun), 'RUN_IN_PROGRESS', '已有活动任务，请等待完成或取消后再测试连接');
    const latest = runs.filter(run => run.task.kind === 'connection_test').reduce((time, run) => Math.max(time, Date.parse(run.createdAt)), -Infinity);
    requireThat(this.now().getTime() - latest >= 30_000, 'CONNECTION_TEST_COOLDOWN', '连接测试需间隔至少 30 秒，请稍后到 Provider 授权重新点击确认测试', 429);
    const run = this.queue(data, { kind: 'connection_test', selection }, {});
    return { runId: run.id };
  }
  createRecitation(data: AppData, input: unknown): CommandResult {
    const body = z.object({ learningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(input);
    const date = body.learningDate ?? learningDate(this.now(), this.config.timezone);
    requireThat(Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date, 'INVALID_DATE', '学习日期无效', 400);
    const existing = Object.values(data.recitations).find(r => r.learningDate === date);
    if (existing) return { id: existing.id, version: existing.version };
    const id = randomUUID();
    data.recitations[id] = { id, learningDate: date, learned: '', unclear: '', application: '', topic: '', version: 1, documentIds: [], createdAt: this.stamp(), updatedAt: this.stamp() };
    return { id, version: 1 };
  }
  saveDraft(data: AppData, id: string, input: unknown): CommandResult {
    // Legacy oversized fields may remain unchanged; new/changed content follows today's archive limits.
    const body = recitationInputSchema.extend({ learned: z.string(), unclear: z.string(), application: z.string(), topic: z.string(), version: z.number().int().positive() }).parse(input);
    const draft = record(data.recitations, id); expectVersion(draft, body.version);
    for (const field of ['learned', 'unclear', 'application', 'topic'] as const) if (body[field] !== draft[field]) recitationInputSchema.shape[field].parse(body[field]);
    if (draft.learned === body.learned && draft.unclear === body.unclear && draft.application === body.application && draft.topic === body.topic) return { id, version: draft.version };
    Object.assign(draft, { learned: body.learned, unclear: body.unclear, application: body.application, topic: body.topic, updatedAt: this.stamp(), version: draft.version + 1 });
    return { id, version: draft.version };
  }
  addDocument(data: AppData, input: unknown, original?: Uint8Array): CommandResult {
    const body = noteInput.parse(input); const draft = record(data.recitations, body.recitationId);
    const bytes = original ?? new TextEncoder().encode(body.text);
    requireThat(isDocumentFilename(body.name) && !/[\\/\u0000-\u001f]/.test(body.name), 'UNSUPPORTED_FILE', '只接受 TXT / Markdown 文本文件', 400);
    requireThat(bytes.byteLength <= this.config.maxUploadBytes, 'FILE_TOO_LARGE', '文件超过当前大小限制', 413);
    requireThat(draft.documentIds.length < this.config.maxDocuments, 'DOCUMENT_LIMIT', '这份复述的笔记数量已达上限', 400);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
    catch { throw new DomainError('INVALID_ENCODING', '请先将文件转换为 UTF-8 编码'); }
    requireThat(text.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), 'INVALID_TEXT', '笔记为空或包含二进制控制字符', 400);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = draft.documentIds.map(docId => record(data.documents, docId)).find(doc => doc.hash === hash);
    if (existing) return { id: existing.id, version: draft.version };
    const id = randomUUID();
    data.documents[id] = { id, recitationId: draft.id, name: body.name, text, hash, lineCount: text.split('\n').length, originalBase64: Buffer.from(bytes).toString('base64'), createdAt: this.stamp() };
    draft.documentIds.push(id); draft.version++; draft.updatedAt = this.stamp();
    return { id, version: draft.version };
  }
  attachDocument(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.extend({ documentId: z.string(), confirm: z.literal(true) }).parse(input);
    const draft = record(data.recitations, id); expectVersion(draft, body.version);
    const document = record(data.documents, body.documentId);
    if (draft.documentIds.includes(document.id)) return { id: document.id, version: draft.version };
    requireThat(draft.documentIds.length < this.config.maxDocuments, 'DOCUMENT_LIMIT', '这份复述的笔记数量已达上限', 400);
    draft.documentIds.push(document.id); draft.version++; draft.updatedAt = this.stamp();
    return { id: document.id, version: draft.version };
  }
  removeDocument(data: AppData, id: string, documentId: string, input: unknown): CommandResult {
    const body = versionBody.parse(input); const draft = record(data.recitations, id); expectVersion(draft, body.version);
    requireThat(draft.documentIds.includes(documentId), 'NOT_FOUND', '笔记未附加到本次复述', 404);
    draft.documentIds = draft.documentIds.filter(value => value !== documentId); draft.version++; draft.updatedAt = this.stamp();
    return { id, version: draft.version };
  }
  /** Read-only preview uses the same source assembly, with a UUID-sized provisional session ID. */
  previewRecitationTask(data: AppData, id: string, input: unknown): Extract<AiTask, { kind: 'extract' }> {
    const draft = record(data.recitations, id);
    const snapshot = recitationInputSchema.parse(input);
    const session = { id: '00000000-0000-0000-0000-000000000000', snapshot, documentIds: draft.documentIds };
    return { kind: 'extract', recitation: snapshot, sources: this.sources(data, session) };
  }
  submitRecitation(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.parse(input); const draft = record(data.recitations, id); expectVersion(draft, body.version);
    requireThat(draft.learned.trim().length > 0, 'EMPTY_RECITATION', '请先写下今天学到了什么', 400);
    const active = Object.values(data.sessions).find(s => s.recitationId === id && s.status !== 'COMPLETED');
    requireThat(!active, 'SESSION_IN_PROGRESS', '这份复述还有未结束的学习，请先继续或结束原会话');
    const session: LearningSession = { id: randomUUID(), recitationId: id, snapshot: { learned: draft.learned, unclear: draft.unclear, application: draft.application, topic: draft.topic }, documentIds: [...draft.documentIds], scopeVersion: 1, version: 1, status: 'CONFIRMING', candidates: [], turns: [], quizId: null, activeRunId: null, completionReason: null, createdAt: this.stamp(), completedAt: null };
    data.sessions[session.id] = session;
    const run = this.queue(data, { kind: 'extract', recitation: session.snapshot, sources: this.sources(data, session) }, { sessionId: session.id });
    return { sessionId: session.id, runId: run.id };
  }
  confirm(data: AppData, id: string, input: unknown): CommandResult {
    const body = confirmInput.parse(input); const session = this.session(data, id, body.version);
    requireThat(session.status === 'CONFIRMING', 'INVALID_STATE', '当前不在范围确认步骤');
    requireThat(body.decisions.length === session.candidates.length && new Set(body.decisions.map(d => d.candidateId)).size === body.decisions.length, 'INCOMPLETE_CONFIRMATION', '请逐一确认或拒绝全部候选知识点', 400);
    const reused = body.decisions.filter(decision => decision.decision === 'accepted').map(decision => {
      const candidate = session.candidates.find(item => item.id === decision.candidateId);
      requireThat(candidate, 'INVALID_CANDIDATE', '候选知识点不属于本次会话', 400);
      return decision.existingKnowledgeId === undefined ? candidate.existingKnowledgeId : decision.existingKnowledgeId;
    }).filter(knowledgeId => knowledgeId !== null);
    requireThat(new Set(reused).size === reused.length, 'DUPLICATE_KNOWLEDGE', '多个候选不能归入同一个已有知识点，请改为新建，或只保留一项。', 400);
    for (const decision of body.decisions) {
      const candidate = session.candidates.find(c => c.id === decision.candidateId);
      requireThat(candidate, 'INVALID_CANDIDATE', '候选知识点不属于本次会话', 400);
      candidate.decision = decision.decision;
      if (decision.decision === 'rejected') continue;
      candidate.title = decision.title ?? candidate.title; candidate.description = decision.description ?? candidate.description;
      const existingId = decision.existingKnowledgeId === undefined ? candidate.existingKnowledgeId : decision.existingKnowledgeId;
      if (existingId) {
        const point = record(data.knowledge, existingId);
        this.contentBaseline(point);
        candidate.knowledgeId = point.id;
        const sourceIds = [...new Set([...point.sourceIds, ...candidate.sourceIds])];
        if (point.description !== candidate.description || point.title !== candidate.title || sourceIds.length !== point.sourceIds.length) {
          point.title = candidate.title; point.description = candidate.description; point.sourceIds = sourceIds;
          point.version++; point.contentVersion = point.contentVersion! + 1; point.updatedAt = this.stamp();
          this.contentBaseline(point);
        }
        candidate.knowledgeVersion = point.contentVersion!;
      } else {
        const pointId = randomUUID(); candidate.knowledgeId = pointId;
        data.knowledge[pointId] = { id: pointId, title: candidate.title, description: candidate.description, sourceIds: [...candidate.sourceIds], version: 1, understanding: '', createdAt: this.stamp(), updatedAt: this.stamp() };
        this.contentBaseline(data.knowledge[pointId]!); candidate.knowledgeVersion = 1;
      }
    }
    session.scopeVersion++; session.version++;
    if (!this.points(session).length) { session.relatedKnowledge = []; return { sessionId: id, version: session.version }; }
    session.status = 'CLARIFYING';
    const points = this.points(session);
    // Points reused or created by this session are the scope itself, never their own association.
    const query = [...points.map(point => `${point.title}\n${point.description}`), session.snapshot.learned].join('\n');
    session.relatedKnowledge = this.associate(data, query, new Set(points.map(point => point.id)))
      .map(point => ({ id: point.id, title: point.title, description: point.description, sourceIds: [...point.sourceIds], knowledgeVersion: point.contentVersion! }));
    const run = this.queue(data, { kind: 'followup', points, turns: session.turns.filter(turn => turn.scopeVersion === session.scopeVersion), sources: this.sources(data, session, points), ...this.related(session.relatedKnowledge) }, { sessionId: id });
    return { sessionId: id, runId: run.id, version: session.version };
  }
  changeScope(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), documentIds: z.array(z.string()).max(this.config.maxDocuments) }).parse(input);
    const session = this.session(data, id, body.version);
    requireThat(!session.quizId, 'SCOPE_FROZEN', '题集已固定，请结束后创建新的学习会话');
    const draft = record(data.recitations, session.recitationId);
    for (const documentId of body.documentIds) {
      requireThat(draft.documentIds.includes(documentId), 'NOT_FOUND', '资料未附加到本次复述或已从草稿移除', 404);
      record(data.documents, documentId);
    }
    session.documentIds = [...new Set(body.documentIds)]; session.candidates = []; session.relatedKnowledge = []; session.scopeVersion++; session.version++; session.status = 'CONFIRMING';
    const run = this.queue(data, { kind: 'extract', recitation: session.snapshot, sources: this.sources(data, session) }, { sessionId: id });
    return { sessionId: id, runId: run.id };
  }
  followupAnswer(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), text: z.string().trim().min(1).max(LIMITS.answerChars), assisted: z.boolean().default(false) }).parse(input);
    const session = this.session(data, id, body.version);
    requireThat(session.status === 'CLARIFYING', 'INVALID_STATE', '当前不在追问步骤');
    const turn = session.turns.at(-1);
    requireThat(turn && turn.answer === null && turn.scopeVersion === session.scopeVersion, 'NO_ACTIVE_QUESTION', '当前没有等待回答的问题');
    turn.answer = body.text; turn.assisted = body.assisted; session.version++;
    const points = this.points(session);
    const run = this.queue(data, { kind: 'followup', points, turns: session.turns.filter(turn => turn.scopeVersion === session.scopeVersion), sources: this.sources(data, session, points), ...this.related(session.relatedKnowledge ?? []) }, { sessionId: id });
    return { sessionId: id, runId: run.id };
  }
  finishFollowup(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.parse(input); const session = this.session(data, id, body.version);
    requireThat(session.status === 'CLARIFYING' && !session.quizId, 'INVALID_STATE', '请先完成学习范围确认');
    const points = this.points(session); requireThat(points.length, 'EMPTY_SCOPE', '没有可考核的已确认知识点');
    session.version++;
    const run = this.queue(data, { kind: 'quiz', points, sources: this.sources(data, session, points), count: this.config.quizCount, ...this.related(session.relatedKnowledge ?? []), ...this.codeOption(data) }, { sessionId: id });
    return { sessionId: id, runId: run.id };
  }
  endSession(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), reason: z.enum(['no_quiz', 'user_ended']) }).parse(input);
    const session = record(data.sessions, id); expectVersion(session, body.version);
    requireThat(session.status !== 'COMPLETED', 'SESSION_CLOSED', '本次学习已结束');
    if (session.activeRunId) this.cancelRun(data, session.activeRunId);
    if (session.quizId) this.finalizeQuiz(data, record(data.quizzes, session.quizId));
    if (session.completionReason !== 'assessed') {
      session.completionReason = body.reason; session.status = 'COMPLETED'; session.completedAt = this.stamp(); session.version++;
    }
    return { sessionId: id };
  }
  private findQuestion(data: AppData, questionId: string) {
    const quiz = Object.values(data.quizzes).find(q => q.questions.some(question => question.id === questionId));
    requireThat(quiz, 'NOT_FOUND', '题目不存在', 404);
    return { quiz, question: quiz.questions.find(q => q.id === questionId)! };
  }
  private assertCurrentQuestion(quiz: Quiz, questionId: string, action: '预检' | '暂存' | '回答') {
    const message = action === '回答' ? '本题已经提交或测验已结束' : `仅能${action}当前未提交题目的答案`;
    requireThat(!quiz.submittedAt && !quiz.answers[questionId], 'ANSWER_LOCKED', message);
    requireThat(quiz.questions[currentQuestionIndex(quiz)]?.id === questionId, action === '回答' ? 'QUESTION_ORDER' : 'ANSWER_LOCKED', action === '回答' ? '请按顺序回答当前题目' : message);
  }
  /** Private rubric stays on the server; the caller may expose only numeric preflight metadata. */
  previewAnswerTask(data: AppData, questionId: string, input: unknown): Extract<AiTask, { kind: 'grade' }> {
    const body = z.object({ text: z.string().max(LIMITS.answerChars), execution: z.optional(codeExecutionSchema) }).parse(input);
    const { quiz, question } = this.findQuestion(data, questionId);
    this.assertCurrentQuestion(quiz, questionId, '预检');
    requireThat(question.kind !== 'single', 'INVALID_QUESTION', '只有简答题与代码题需要模型输入预检', 400);
    return { kind: 'grade', question, answer: body.text, ...this.codeEvidence(question, body.execution) };
  }
  saveAnswerDraft(data: AppData, questionId: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), text: z.string().max(LIMITS.answerChars) }).parse(input);
    const { quiz } = this.findQuestion(data, questionId); expectVersion(quiz, body.version);
    this.assertCurrentQuestion(quiz, questionId, '暂存');
    quiz.drafts[questionId] = body.text; quiz.version++;
    return { quizId: quiz.id, version: quiz.version };
  }
  answerQuestion(data: AppData, questionId: string, input: unknown): CommandResult {
    const body = answerInputSchema.parse(input); const { quiz, question } = this.findQuestion(data, questionId); expectVersion(quiz, body.version);
    this.assertCurrentQuestion(quiz, questionId, '回答');
    requireThat(question.kind !== 'code' || body.codeProtocol === 1, 'CLIENT_UPDATE_REQUIRED', '代码题需要新版编辑器，请刷新页面后重新作答。', 409);
    const skipped = body.action === 'skip';
    const skippedEvidence = skipped ? this.codeEvidence(question, body.execution, true) : undefined;
    if (!skipped && question.kind === 'single') requireThat(body.selectedIndex !== null && body.selectedIndex < question.options.length, 'INVALID_ANSWER', '请选择有效选项', 400);
    const modelGraded = !skipped && question.kind !== 'single';
    if (modelGraded) requireThat(body.text.trim().length, 'EMPTY_ANSWER', '请填写答案或明确跳过', 400);
    requireThat(question.kind === 'single' || body.selectedIndex === null, 'INVALID_ANSWER', '简答题与代码题不能携带单选答案', 400);
    const evidence = skippedEvidence ?? this.codeEvidence(question, body.execution);
    let grade: AiTask | null = modelGraded ? { kind: 'grade', question, answer: body.text, ...evidence } : null;
    if (grade) {
      try { grade = this.prepareInput(grade, data); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODEL_INPUT_TOO_LARGE') throw error;
        throw new DomainError('MODEL_INPUT_TOO_LARGE', '固定评分标准与正式答案超过当前模型输入预算；答案尚未提交，请精简答案、选择更大上下文模型或明确跳过。', 413);
      }
    }
    const exposed = quiz.questions.some(q => q.knowledgeId === question.knowledgeId && quiz.answers[q.id]);
    const maxScore = question.rubric.reduce((sum, item) => sum + item.maxScore, 0);
    const correct = question.kind === 'single' && body.selectedIndex === question.correctIndex;
    const assessment: Assessment = { status: skipped ? 'skipped' : modelGraded ? 'pending' : 'graded', score: skipped || modelGraded ? null : correct ? maxScore : 0, maxScore, feedback: skipped ? '本题已跳过，不计入正确率。' : modelGraded ? '答案已保存，等待评价。' : correct ? '本次选择正确。' : '本次选择有误，请对照讲解核对。', assessedAt: modelGraded ? null : this.stamp(), version: 1 };
    quiz.answers[questionId] = { text: body.text, selectedIndex: body.selectedIndex, assisted: body.assisted || exposed, skipped, submittedAt: this.stamp(), assessment, ...evidence };
    delete quiz.drafts[questionId]; quiz.version++;
    if (quiz.sessionId) {
      const session = record(data.sessions, quiz.sessionId);
      if (session.status === 'QUIZ_READY') { session.status = 'QUIZZING'; session.version++; }
    }
    if (quiz.reviewSessionId) {
      const review = record(data.reviewSessions, quiz.reviewSessionId);
      if (review.status === 'QUIZ_READY') { review.status = 'QUIZZING'; review.version++; }
    }
    if (grade) {
      const run = this.queue(data, grade, { quizId: quiz.id, questionId, ...(quiz.sessionId ? { sessionId: quiz.sessionId } : {}), ...(quiz.reviewSessionId ? { reviewSessionId: quiz.reviewSessionId } : {}) }, true);
      return { quizId: quiz.id, runId: run.id, version: quiz.version };
    }
    this.addEvidence(data, quiz, questionId);
    return { quizId: quiz.id, version: quiz.version };
  }
  private addEvidence(data: AppData, quiz: Quiz, questionId: string) {
    const question = quiz.questions.find(q => q.id === questionId)!; const answer = record(quiz.answers, questionId);
    if (answer.assessment.status !== 'graded') return;
    const id = `${quiz.id}:${questionId}`;
    data.evidence[id] = { id, knowledgeId: question.knowledgeId, knowledgeVersion: question.knowledgeVersion ?? null, quizId: quiz.id, questionId, answer: structuredClone(answer), dimension: quiz.reviewSessionId ? 'delayed' : 'immediate', simulated: data.mode === 'mock' };
  }
  private finalizeQuiz(data: AppData, quiz: Quiz) {
    requireThat(!Object.values(quiz.answers).some(a => a.assessment.status === 'pending'), 'GRADING_PENDING', '评价尚未完成，请等待或取消该任务');
    for (const question of quiz.questions) if (!quiz.answers[question.id]) quiz.answers[question.id] = { text: '', selectedIndex: null, assisted: false, skipped: true, submittedAt: this.stamp(), assessment: { status: 'skipped', score: null, maxScore: question.rubric.reduce((sum, item) => sum + item.maxScore, 0), feedback: '交卷时明确跳过。', assessedAt: this.stamp(), version: 1 } };
    quiz.submittedAt = this.stamp(); quiz.version++;
    if (quiz.sessionId) {
      const session = record(data.sessions, quiz.sessionId); session.status = 'COMPLETED'; session.completionReason = 'assessed'; session.completedAt = this.stamp(); session.version++;
      if (effectiveLearningPreferences(data, this.config).schedulingEnabled) for (const point of this.points(session)) if (!Object.values(data.cards).some(card => card.knowledgeId === point.id)) {
        const id = randomUUID(); data.cards[id] = { id, knowledgeId: point.id, version: 1, schedule: newSchedule(this.now()), createdAt: this.stamp() };
      }
    }
    if (quiz.reviewSessionId) { const review = record(data.reviewSessions, quiz.reviewSessionId); review.status = 'READY_TO_COMPLETE'; review.version++; }
  }
  submitQuiz(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), confirmSkip: z.literal(true) }).parse(input);
    const quiz = record(data.quizzes, id); expectVersion(quiz, body.version); requireThat(!quiz.submittedAt, 'QUIZ_CLOSED', '测验已交卷');
    this.finalizeQuiz(data, quiz); return { quizId: id, ...(quiz.reviewSessionId ? { reviewSessionId: quiz.reviewSessionId } : {}) };
  }
  startReview(data: AppData, cardId: string): CommandResult {
    const card = record(data.cards, cardId);
    const active = Object.values(data.reviewSessions).find(s => s.cardId === cardId && !['COMPLETED', 'ABANDONED'].includes(s.status));
    if (active) return { reviewSessionId: active.id };
    const id = randomUUID(); data.reviewSessions[id] = { id, cardId, expectedCardVersion: card.version, version: 1, status: 'RECALLING', recall: '', recallSubmittedAt: null, quizId: null, activeRunId: null, createdAt: this.stamp(), completedAt: null };
    return { reviewSessionId: id };
  }
  reviewRecall(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), text: z.string().max(LIMITS.answerChars), action: z.enum(['draft', 'submitted']) }).parse(input);
    const review = record(data.reviewSessions, id); expectVersion(review, body.version);
    requireThat(review.status === 'RECALLING' && !review.activeRunId && !review.recallSubmittedAt, 'INVALID_STATE', '回忆已提交或任务正在处理');
    requireThat(body.action === 'draft' || body.text.trim().length > 0, 'EMPTY_RECALL', '请先写下回忆内容，再开始定向测验', 400);
    review.recall = body.text; review.version++;
    if (body.action === 'draft') return { reviewSessionId: id, version: review.version };
    review.recallSubmittedAt = this.stamp();
    const card = record(data.cards, review.cardId); const point = record(data.knowledge, card.knowledgeId);
    this.contentBaseline(point);
    const source: SourceInput = { id: `knowledge:${point.id}:v${point.contentVersion}`, name: '此前确认的知识点（仍可能有误）', text: point.description };
    const available = [...new Set(point.sourceIds)].flatMap(sourceId => {
      const resolved = this.resolveSource(data, sourceId);
      return resolved ? [resolved] : [];
    });
    const originals = selectRelevantSources(available, `${point.title}\n${point.description}\n${body.text}`, Math.min(LIMITS.documentsMaximum, LIMITS.modelSourcesMaximum - 1));
    const sources = [source, ...originals];
    // Combination only: related points are not shown beforehand, not assessed alone, and never scheduled here.
    const related = this.associate(data, `${point.title}\n${point.description}\n${body.text}`, new Set([point.id]));
    const run = this.queue(data, { kind: 'quiz', points: [{ id: point.id, title: point.title, description: point.description, sourceIds: sources.map(item => item.id), knowledgeVersion: point.contentVersion! }], sources, recall: body.text, count: Math.min(LIMITS.quizQuestions, this.config.quizCount), ...this.related(related), ...this.codeOption(data) }, { reviewSessionId: id });
    return { reviewSessionId: id, runId: run.id };
  }
  completeReview(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), expectedCardVersion: z.number().int().positive(), rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).parse(input);
    const review = record(data.reviewSessions, id); expectVersion(review, body.version);
    requireThat(review.status === 'READY_TO_COMPLETE' && review.quizId, 'INVALID_STATE', '请先交卷，再完成本次复习');
    const card = record(data.cards, review.cardId);
    requireThat(card.version === review.expectedCardVersion && body.expectedCardVersion === card.version, 'CARD_VERSION_CONFLICT', '卡片已被更新，请放弃旧会话后重新复习');
    const quiz = record(data.quizzes, review.quizId);
    const independent = Object.values(quiz.answers).filter(a => a.assessment.status === 'graded' && !a.assisted && !a.skipped);
    if (effectiveLearningPreferences(data, this.config).schedulingEnabled && independent.length) {
      const rating = independent.some(a => (a.assessment.score ?? 0) < a.assessment.maxScore) ? 1 : body.rating;
      const reviewedAt = independent.map(a => a.submittedAt).sort().at(-1)!;
      requireThat(!Object.values(data.reviewEvents).some(e => e.reviewSessionId === id), 'REVIEW_ALREADY_APPLIED', '这次复习已生效');
      const before = structuredClone(card.schedule); const after = nextSchedule(before, new Date(reviewedAt), rating);
      const eventId = randomUUID(); data.reviewEvents[eventId] = { id: eventId, reviewSessionId: id, cardId: card.id, rating, reviewedAt, before, after, algorithm: 'ts-fsrs@5.4.2/default-retention-0.9/no-fuzz/no-short-term/mapping-v1', simulated: data.mode === 'mock' };
      card.schedule = after; card.version++;
    }
    review.status = 'COMPLETED'; review.completedAt = this.stamp(); review.version++;
    return { reviewSessionId: id };
  }
  abandonReview(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.parse(input); const review = record(data.reviewSessions, id); expectVersion(review, body.version);
    requireThat(!['COMPLETED', 'ABANDONED'].includes(review.status), 'SESSION_CLOSED', '复习会话已结束');
    if (review.activeRunId) this.cancelRun(data, review.activeRunId);
    review.status = 'ABANDONED'; review.completedAt = this.stamp(); review.version++; return { reviewSessionId: id };
  }
  saveLearningPreferences(data: AppData, input: unknown): CommandResult {
    const body = learningPreferencesSchema.extend({ expectedRevision: z.number().int().nonnegative(), confirm: z.literal(true) }).parse(input);
    expectVersion({ version: data.revision }, body.expectedRevision);
    requireThat(!Object.values(data.runs).some(isActiveRun), 'RUN_IN_PROGRESS', '请等待活动任务完成或取消后再更改学习设置');
    // Older clients omit the association switch: keep the saved choice rather than silently turning it off/on.
    const saved = data.learningPreferences;
    data.learningPreferences = { schedulingEnabled: body.schedulingEnabled, promptCacheRetention: body.promptCacheRetention, associationEnabled: body.associationEnabled ?? saved?.associationEnabled ?? false,
      codeExercisesEnabled: body.codeExercisesEnabled ?? saved?.codeExercisesEnabled ?? false,
      // Canonical order and no duplicates, so an unchanged choice compares equal.
      codeLanguages: CODE_LANGUAGES.filter(language => (body.codeLanguages ?? saved?.codeLanguages ?? DEFAULT_CODE_LANGUAGES).includes(language)) };
    return { version: data.revision + 1 };
  }
  addReviewCard(data: AppData, knowledgeId: string, input: unknown): CommandResult {
    const body = versionBody.extend({ confirm: z.literal(true) }).parse(input);
    requireThat(effectiveLearningPreferences(data, this.config).schedulingEnabled, 'SCHEDULING_NOT_ENABLED', '请先启用复习排期');
    const point = record(data.knowledge, knowledgeId); expectVersion(point, body.version);
    const existing = Object.values(data.cards).find(card => card.knowledgeId === knowledgeId);
    if (existing) return { id: existing.id, version: existing.version };
    const id = randomUUID();
    data.cards[id] = { id, knowledgeId, version: 1, schedule: newSchedule(this.now()), createdAt: this.stamp() };
    return { id, version: 1 };
  }
  saveUnderstanding(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), text: z.string().max(LIMITS.answerChars) }).parse(input);
    const point = record(data.knowledge, id); expectVersion(point, body.version); this.contentBaseline(point); point.understanding = body.text; point.version++; point.updatedAt = this.stamp(); return { id, version: point.version };
  }
  cancelRun(data: AppData, id: string): CommandResult {
    const run = record(data.runs, id);
    if (!['pending', 'running'].includes(run.status)) return { runId: id };
    run.status = 'cancelled'; run.error = '任务已取消，已提交的输入仍然保留。'; run.finishedAt = this.stamp(); run.attemptId = null;
    this.releaseRun(data, run); return { runId: id };
  }
  private releaseRun(data: AppData, run: AgentRun) {
    if (run.sessionId) { const session = record(data.sessions, run.sessionId); if (session.activeRunId === run.id) session.activeRunId = null; }
    if (run.reviewSessionId) { const review = record(data.reviewSessions, run.reviewSessionId); if (review.activeRunId === run.id) review.activeRunId = null; }
    if (run.task.kind === 'grade' && run.quizId && run.questionId) {
      const quiz = record(data.quizzes, run.quizId); const answer = record(quiz.answers, run.questionId);
      if (answer.assessment.status === 'pending' && ['failed', 'cancelled'].includes(run.status)) { answer.assessment.status = 'needs_verification'; answer.assessment.feedback = run.error ?? '评价待核对'; quiz.version++; run.expectedVersion = quiz.version; }
    }
  }
  retryRun(data: AppData, id: string): CommandResult {
    const old = record(data.runs, id);
    requireThat(old.task.kind !== 'connection_test', 'CONNECTION_TEST_CONFIRMATION_REQUIRED', '请到 Provider 授权重新点击确认测试；连接测试不能直接重试');
    requireThat(['failed', 'cancelled'].includes(old.status), 'INVALID_STATE', '只能重试失败或取消的任务');
    if (old.sessionId) { const session = record(data.sessions, old.sessionId); requireThat(session.status !== 'COMPLETED' && !session.activeRunId, 'SESSION_CLOSED', '会话已结束或正在处理'); if (old.task.kind !== 'grade') expectVersion(session, old.expectedVersion); }
    if (old.reviewSessionId) { const review = record(data.reviewSessions, old.reviewSessionId); requireThat(!['COMPLETED', 'ABANDONED'].includes(review.status) && !review.activeRunId, 'SESSION_CLOSED', '复习会话已结束或正在处理'); if (old.task.kind !== 'grade') expectVersion(review, old.expectedVersion); }
    if (old.quizId && old.questionId) { const quiz = record(data.quizzes, old.quizId); requireThat(!quiz.submittedAt, 'QUIZ_CLOSED', '已交卷的评价需要人工核对，不自动重评'); expectVersion(quiz, old.expectedVersion); quiz.answers[old.questionId]!.assessment.status = 'pending'; quiz.version++; }
    const run = this.queue(data, structuredClone(old.task), { ...(old.sessionId ? { sessionId: old.sessionId } : {}), ...(old.reviewSessionId ? { reviewSessionId: old.reviewSessionId } : {}), ...(old.quizId ? { quizId: old.quizId } : {}), ...(old.questionId ? { questionId: old.questionId } : {}) }, old.inputPrepared !== false);
    return { runId: run.id };
  }
  async claimRun(): Promise<AgentRun | null> {
    return this.repository.transact(data => {
      const run = Object.values(data.runs).find(r => r.status === 'pending');
      if (!run) return null;
      run.status = 'running'; run.attempt++; run.attemptId = randomUUID(); run.startedAt = this.stamp();
      return structuredClone(run);
    });
  }
  async recoverRuns() {
    await this.repository.transact(data => {
      for (const run of Object.values(data.runs)) if (run.status === 'running' || (run.status === 'pending' && run.task.kind === 'connection_test')) {
        // Never replay a diagnostic after restart, even if it had not started yet.
        run.status = 'failed'; run.error = run.task.kind === 'connection_test' ? '服务重启已中断连接测试；如请求已发出则可能已计费。请到 Provider 授权重新点击确认测试。' : '上次服务在运行中停止。输入已保留，请明确重试；原请求可能已计费。'; run.attemptId = null; run.finishedAt = this.stamp(); this.releaseRun(data, run);
      }
    });
  }
  async recordUsage(id: string, attempt: number, value: unknown) {
    const usage = usageSchema.parse(value);
    await this.repository.transact(data => {
      const run = data.runs[id];
      // Accounting is independent of business-result acceptance. Cancellation cannot
      // erase already incurred usage, but an older attempt may never overwrite it.
      if (!run || attempt < 1 || run.attempt !== attempt || run.usage !== null) return;
      run.usage = usage;
    });
  }
  async failRun(id: string, attemptId: string, message = 'AI 任务未完成，输入已保存。可以重试或结束本次学习。') {
    await this.repository.transact(data => {
      const run = record(data.runs, id); if (run.status !== 'running' || run.attemptId !== attemptId) return;
      run.status = 'failed'; run.error = message; run.finishedAt = this.stamp(); this.releaseRun(data, run);
    });
  }
  async finishRun(id: string, attemptId: string, response: AiResponse) {
    await this.repository.transact(data => {
      const run = record(data.runs, id);
      if (run.status !== 'running' || run.attemptId !== attemptId) return;
      const parsed = aiOutputSchema.safeParse(response.output);
      if (run.task.kind === 'connection_test') requireThat(parsed.success, 'INVALID_MODEL_OUTPUT', '连接测试响应校验失败');
      const output = parsed.success ? parsed.data : aiOutputSchema.parse(response.output);
      requireThat(run.task.kind === output.kind, 'INVALID_MODEL_OUTPUT', '模型返回了错误的任务类型');
      if (output.kind === 'connection_test') {
        run.status = 'succeeded'; run.finishedAt = this.stamp(); if (response.usage != null) run.usage ??= usageSchema.parse(response.usage); run.error = null;
        return;
      }
      const session = run.sessionId ? record(data.sessions, run.sessionId) : null;
      const review = run.reviewSessionId ? record(data.reviewSessions, run.reviewSessionId) : null;
      if (session) requireThat(session.activeRunId === id && session.status !== 'COMPLETED', 'STALE_RUN', '会话已经改变');
      if (review) requireThat(review.activeRunId === id && !['COMPLETED', 'ABANDONED'].includes(review.status), 'STALE_RUN', '复习会话已经改变');
      if (output.kind !== 'grade') expectVersion(session ?? review!, run.expectedVersion);
      if (output.kind === 'extract' && run.task.kind === 'extract' && session) {
        const allowed = new Set(run.task.sources.map(s => s.id));
        requireThat(output.candidates.every(c => c.sourceIds.length > 0 && c.sourceIds.every(source => allowed.has(source))), 'INVALID_REFERENCE', '模型引用了未授权资料');
        session.candidates = output.candidates.map(c => ({ ...c, id: randomUUID(), decision: 'pending', knowledgeId: null, existingKnowledgeId: Object.values(data.knowledge).find(k => normalizeTitle(k.title) === normalizeTitle(c.title))?.id ?? null }));
        session.version++;
      } else if (output.kind === 'followup' && session) {
        const previous = [...session.turns].reverse().find(turn => turn.scopeVersion === session.scopeVersion);
        if (previous && previous.answer !== null) previous.feedback = output.feedback;
        if (session.turns.filter(t => t.scopeVersion === session.scopeVersion).length < this.config.maxFollowups) session.turns.push({ id: randomUUID(), question: output.question, answer: null, feedback: null, assisted: false, scopeVersion: session.scopeVersion });
        session.version++;
      } else if (output.kind === 'quiz' && run.task.kind === 'quiz') {
        const points = new Map(run.task.points.map(point => [point.id, point])); const sourceIds = new Set(run.task.sources.map(s => s.id));
        requireThat(output.questions.length === run.task.count && output.questions.every(q => points.has(q.knowledgeId) && q.sourceIds.length > 0 && q.sourceIds.every(source => sourceIds.has(source) && points.get(q.knowledgeId)!.sourceIds.includes(source))), 'INVALID_REFERENCE', '题量或出题引用不符合已确认范围');
        const related = new Set((run.task.related ?? []).map(point => point.id));
        requireThat(output.questions.every(q => (q.relatedKnowledgeIds ?? []).every(knowledgeId => related.has(knowledgeId))), 'INVALID_REFERENCE', '结合题引用了本次未联想的旧知识点');
        const languages = run.task.code?.languages ?? [];
        requireThat(output.questions.every(q => !q.code || languages.includes(q.code.language)), 'INVALID_REFERENCE', '代码题未开启或语言不在所选范围');
        const quiz: Quiz = { id: randomUUID(), sessionId: session?.id ?? null, reviewSessionId: review?.id ?? null, scopeVersion: session?.scopeVersion ?? 1, version: 1, questions: output.questions.map(q => ({ ...q, id: randomUUID(), knowledgeVersion: points.get(q.knowledgeId)?.knowledgeVersion ?? null })), answers: {}, drafts: {}, submittedAt: null, createdAt: this.stamp() };
        data.quizzes[quiz.id] = quiz;
        if (session) { session.quizId = quiz.id; session.status = 'QUIZ_READY'; session.version++; }
        if (review) { review.quizId = quiz.id; review.status = 'QUIZ_READY'; review.version++; }
      } else if (output.kind === 'grade' && run.task.kind === 'grade' && run.quizId && run.questionId) {
        const quiz = record(data.quizzes, run.quizId); expectVersion(quiz, run.expectedVersion); requireThat(!quiz.submittedAt, 'QUIZ_CLOSED', '测验已经结束');
        const answer = record(quiz.answers, run.questionId); const rubric = run.task.question.rubric;
        let score: number | null = null;
        if (output.status === 'graded') {
          requireThat(output.scores.length === rubric.length && new Set(output.scores.map(s => s.rubricId)).size === rubric.length && output.scores.every(s => { const row = rubric.find(r => r.id === s.rubricId); return row && s.score <= row.maxScore && s.evidence.trim().length > 0; }), 'INVALID_SCORE', '模型评分不符合固定评分标准');
          score = output.scores.reduce((sum, row) => sum + row.score, 0);
        }
        answer.assessment = { ...answer.assessment, status: output.status, score, feedback: output.feedback, assessedAt: this.stamp(), version: answer.assessment.version + 1 }; quiz.version++;
        this.addEvidence(data, quiz, run.questionId);
      } else throw new DomainError('INVALID_MODEL_OUTPUT', '任务结果缺少有效的业务关联');
      run.status = 'succeeded'; run.finishedAt = this.stamp(); if (response.usage != null) run.usage ??= usageSchema.parse(response.usage); run.error = null; this.releaseRun(data, run);
    });
  }
}
