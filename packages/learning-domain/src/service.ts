import { applyKnowledgeMerge, contentBaseline, previewKnowledgeMerge } from './knowledge-merge.ts';
import { bindLearningSkills } from './skills.ts';
import { currentKnowledgeId, taskPromptVersion, skillSelectionSchema, type PromptBinding, type RunErrorCode } from '@sanxing/contracts';
import { REVIEW_ALGORITHM, reviewRating } from './review-policy.ts';
import { recentWeaknessCues } from './review-evidence.ts';
import { randomUUID, hashBytes, encodeBase64 } from './runtime.ts';
import { z } from 'zod';
import { CODE_LANGUAGES, DEFAULT_CODE_LANGUAGES, LIMITS, aiOutputSchema, answerInputSchema, codeExecutionSchema, executionFitsQuestion, documentUploadLimit, isUploadFilename, isPdfFilename, isImageFilename, imageMediaType, imageImportInputSchema, learningPreferencesSchema, isActiveRun, prepareTaskContext, recitationInputSchema, recitationSourceText, usageSchema } from '@sanxing/contracts';
import type { AgentRun, AiModelSelection, AiResponse, AiTask, AppData, Assessment, CodeExecution, CodeLanguage, CommandResult, KnowledgePoint, LearningSession, DocumentImport, PointInput, Question, Quiz, RelatedPoint, SourceInput } from '@sanxing/contracts';
import { DomainError, currentQuestionIndex, effectiveLearningPreferences, expectVersion, learningDate, newSchedule, nextSchedule, normalizeTitle, projectState, record, requireThat } from './policy.ts';
import type { DomainConfig } from './policy.ts';
import { findRelatedKnowledge, selectRelevantSources } from './retrieval.ts';

import type { StateRepository } from './repository.ts';
export type { StateRepository } from './repository.ts';
import { executeCommand } from './commands.ts';
import { RunLifecycle } from './run-lifecycle.ts';

const versionBody = z.object({ version: z.number().int().positive() });
const taskVersionBody = versionBody.extend({ skillSelections: skillSelectionSchema.optional() });
const noteInput = z.object({ recitationId: z.string(), name: z.string().min(1).max(120), text: z.string() });
const confirmInput = z.object({ skillSelections: skillSelectionSchema.optional(), version: z.number().int().positive(), decisions: z.array(z.object({ candidateId: z.string(), decision: z.enum(['accepted', 'rejected']), title: z.string().min(1).max(100).optional(), description: z.string().min(1).max(2000).optional(), existingKnowledgeId: z.string().nullable().optional() })).min(1).max(LIMITS.quizQuestionsMaximum) });

export class LearningService {
  private readonly runs: RunLifecycle;
  constructor(readonly repository: StateRepository, readonly config: DomainConfig, readonly now: () => Date = () => new Date(),
    private readonly prepareInput: (task: AiTask, data: AppData) => AiTask = task => prepareTaskContext(task).task,
    describePrompt: (task: AiTask) => PromptBinding = task => ({ version: taskPromptVersion(task.kind) })) {
    this.runs = new RunLifecycle(repository, config, now, prepareInput, describePrompt);
  }
  async state(csrfToken: string) { return projectState(await this.repository.read(), this.config, csrfToken); }
  private stamp() { return this.now().toISOString(); }
  command(operation: string, key: string, body: unknown, action: (state: AppData) => CommandResult | Promise<CommandResult>): Promise<CommandResult> {
    return executeCommand(this.repository, this.now, operation, key, body, action);
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
    contentBaseline(point, this.stamp());
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
  evaluate(data: AppData, task: AiTask, metadata: NonNullable<AgentRun['evaluation']>): CommandResult {
    requireThat(data.mode === 'live', 'LIVE_MODE_REQUIRED', '真实样例评估需要 live 模式');
    requireThat(!Object.values(data.runs).some(isActiveRun), 'RUN_IN_PROGRESS', '请等待当前任务完成后再开始样例评估');
    const batch = Object.values(data.runs).filter(run => run.evaluation?.batchId === metadata.batchId);
    requireThat(batch.length < 30, 'EVALUATION_LIMIT', '单批评估最多 30 次请求');
    requireThat(!batch.some(run => run.evaluation?.caseId === metadata.caseId), 'EVALUATION_DUPLICATE', '本批样例已请求，不自动重放');
    requireThat(batch.every(run => JSON.stringify(run.evaluation!.selection) === JSON.stringify(metadata.selection) && run.evaluation!.suite === metadata.suite), 'EVALUATION_MODEL_CHANGED', '同一批评估的模型与样例版本必须一致');
    // Baseline evaluation must never include personal imported instructions.
    const run = this.runs.queue(data, task.kind === 'connection_test' ? task : { ...task, skills: [] }, {});
    run.evaluation = structuredClone(metadata);
    return { runId: run.id };
  }
  connectionTest(data: AppData, selection: AiModelSelection): CommandResult {
    requireThat(this.config.mode === 'live', 'LIVE_MODE_REQUIRED', '连接测试仅适用于真实模型模式');
    const runs = Object.values(data.runs);
    requireThat(!runs.some(isActiveRun), 'RUN_IN_PROGRESS', '已有活动任务，请等待完成或取消后再测试连接');
    const latest = runs.filter(run => run.task.kind === 'connection_test').reduce((time, run) => Math.max(time, Date.parse(run.createdAt)), -Infinity);
    requireThat(this.now().getTime() - latest >= 30_000, 'CONNECTION_TEST_COOLDOWN', '连接测试需间隔至少 30 秒，请稍后到 Provider 授权重新点击确认测试', 429);
    const run = this.runs.queue(data, { kind: 'connection_test', selection }, {});
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
  addDocument(data: AppData, input: unknown, original?: Uint8Array, parsedDocument?: { text: string; import: DocumentImport }): CommandResult {
    const body = noteInput.parse(input); const draft = record(data.recitations, body.recitationId);
    const bytes = original ?? new TextEncoder().encode(body.text);
    requireThat(isUploadFilename(body.name) && !/[\\/\u0000-\u001f]/.test(body.name), 'UNSUPPORTED_FILE', '只接受 TXT / Markdown、文本型 PDF 或 PNG / JPEG / WebP 图片', 400);
    requireThat(bytes.byteLength <= documentUploadLimit(body.name, this.config.maxUploadBytes), 'FILE_TOO_LARGE', '文件超过当前大小限制', 413);
    requireThat(draft.documentIds.length < this.config.maxDocuments, 'DOCUMENT_LIMIT', '这份复述的笔记数量已达上限', 400);
    let text: string;
    const pdf = isPdfFilename(body.name); const image = isImageFilename(body.name);
    requireThat(!pdf || (original && parsedDocument?.import.format === 'pdf'), 'PDF_FILE_REQUIRED', 'PDF 必须上传原文件进行本地解析，不能粘贴文本冒充 PDF', 400);
    if (pdf) {
      text = parsedDocument!.text;
      requireThat(text.length <= LIMITS.pdfTextChars && parsedDocument!.import.format === 'pdf' && parsedDocument!.import.pages.length <= LIMITS.pdfPages, 'PDF_TEXT_LIMIT', 'PDF 解析内容超过限制', 400);
    } else if (image) {
      requireThat(original && parsedDocument?.import.format === 'image', 'IMAGE_OCR_REQUIRED', '图片需要先完成 OCR 并确认文字后导入。', 400);
      const parsed = imageImportInputSchema.parse(parsedDocument);
      requireThat(imageMediaType(bytes) === parsed.import.mediaType && parsed.import.width * parsed.import.height <= LIMITS.imagePixels, 'IMAGE_INVALID', '图片格式或像素信息无效。', 400);
      text = parsed.text.replace(/\r\n?/g, '\n').trim();
    } else try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
    catch { throw new DomainError('INVALID_ENCODING', '请先将文件转换为 UTF-8 编码'); }
    requireThat(text.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), 'INVALID_TEXT', '笔记为空或包含二进制控制字符', 400);
    const hash = hashBytes(bytes);
    const existing = draft.documentIds.map(docId => record(data.documents, docId)).find(doc => doc.hash === hash);
    if (existing) return { id: existing.id, version: draft.version };
    const id = randomUUID();
    data.documents[id] = { id, recitationId: draft.id, name: body.name, text, hash, lineCount: text.split('\n').length, originalBase64: encodeBase64(bytes), createdAt: this.stamp(), ...(pdf || image ? { import: parsedDocument!.import } : {}) };
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
    const { skillSelections } = z.object({ skillSelections: skillSelectionSchema.optional() }).parse(input);
    const snapshot = recitationInputSchema.parse(input);
    const session = { id: '00000000-0000-0000-0000-000000000000', snapshot, documentIds: draft.documentIds };
    return bindLearningSkills(data, { kind: 'extract', recitation: snapshot, sources: this.sources(data, session) }, skillSelections);
  }
  submitRecitation(data: AppData, id: string, input: unknown): CommandResult {
    const body = taskVersionBody.parse(input); const draft = record(data.recitations, id); expectVersion(draft, body.version);
    requireThat(draft.learned.trim().length > 0, 'EMPTY_RECITATION', '请先写下今天学到了什么', 400);
    const active = Object.values(data.sessions).find(s => s.recitationId === id && s.status !== 'COMPLETED');
    requireThat(!active, 'SESSION_IN_PROGRESS', '这份复述还有未结束的学习，请先继续或结束原会话');
    const session: LearningSession = { id: randomUUID(), recitationId: id, snapshot: { learned: draft.learned, unclear: draft.unclear, application: draft.application, topic: draft.topic }, documentIds: [...draft.documentIds], scopeVersion: 1, version: 1, status: 'CONFIRMING', candidates: [], turns: [], quizId: null, activeRunId: null, completionReason: null, createdAt: this.stamp(), completedAt: null };
    data.sessions[session.id] = session;
    const run = this.runs.queue(data, bindLearningSkills(data, { kind: 'extract', recitation: session.snapshot, sources: this.sources(data, session) }, body.skillSelections), { sessionId: session.id });
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
        requireThat(!point.archivedAt, 'KNOWLEDGE_ARCHIVED', '请先恢复已归档知识点，再复用');
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
    const run = this.runs.queue(data, bindLearningSkills(data, { kind: 'followup', points, turns: session.turns.filter(turn => turn.scopeVersion === session.scopeVersion), sources: this.sources(data, session, points), ...this.related(session.relatedKnowledge) }, body.skillSelections), { sessionId: id });
    return { sessionId: id, runId: run.id, version: session.version };
  }
  changeScope(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), documentIds: z.array(z.string()).max(this.config.maxDocuments), skillSelections: skillSelectionSchema.optional() }).parse(input);
    const session = this.session(data, id, body.version);
    requireThat(!session.quizId, 'SCOPE_FROZEN', '题集已固定，请结束后创建新的学习会话');
    const draft = record(data.recitations, session.recitationId);
    for (const documentId of body.documentIds) {
      requireThat(draft.documentIds.includes(documentId), 'NOT_FOUND', '资料未附加到本次复述或已从草稿移除', 404);
      record(data.documents, documentId);
    }
    session.documentIds = [...new Set(body.documentIds)]; session.candidates = []; session.relatedKnowledge = []; session.scopeVersion++; session.version++; session.status = 'CONFIRMING';
    const run = this.runs.queue(data, bindLearningSkills(data, { kind: 'extract', recitation: session.snapshot, sources: this.sources(data, session) }, body.skillSelections), { sessionId: id });
    return { sessionId: id, runId: run.id };
  }
  followupAnswer(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), text: z.string().trim().min(1).max(LIMITS.answerChars), assisted: z.boolean().default(false), skillSelections: skillSelectionSchema.optional() }).parse(input);
    const session = this.session(data, id, body.version);
    requireThat(session.status === 'CLARIFYING', 'INVALID_STATE', '当前不在追问步骤');
    const turn = session.turns.at(-1);
    requireThat(turn && turn.answer === null && turn.scopeVersion === session.scopeVersion, 'NO_ACTIVE_QUESTION', '当前没有等待回答的问题');
    turn.answer = body.text; turn.assisted = body.assisted; session.version++;
    const points = this.points(session);
    const run = this.runs.queue(data, bindLearningSkills(data, { kind: 'followup', points, turns: session.turns.filter(turn => turn.scopeVersion === session.scopeVersion), sources: this.sources(data, session, points), ...this.related(session.relatedKnowledge ?? []) }, body.skillSelections), { sessionId: id });
    return { sessionId: id, runId: run.id };
  }
  finishFollowup(data: AppData, id: string, input: unknown): CommandResult {
    const body = taskVersionBody.parse(input); const session = this.session(data, id, body.version);
    requireThat(session.status === 'CLARIFYING' && !session.quizId, 'INVALID_STATE', '请先完成学习范围确认');
    const points = this.points(session); requireThat(points.length, 'EMPTY_SCOPE', '没有可考核的已确认知识点');
    session.version++;
    const turns = session.turns.filter(turn => turn.scopeVersion === session.scopeVersion);
    const run = this.runs.queue(data, bindLearningSkills(data, { kind: 'quiz', points, turns, sources: this.sources(data, session, points), count: this.config.quizCount, ...this.related(session.relatedKnowledge ?? []), ...this.codeOption(data) }, body.skillSelections), { sessionId: id });
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
    const body = z.object({ text: z.string().max(LIMITS.answerChars), execution: z.optional(codeExecutionSchema), skillSelections: skillSelectionSchema.optional() }).parse(input);
    const { quiz, question } = this.findQuestion(data, questionId);
    this.assertCurrentQuestion(quiz, questionId, '预检');
    requireThat(question.kind !== 'single', 'INVALID_QUESTION', '只有简答题与代码题需要模型输入预检', 400);
    return bindLearningSkills(data, { kind: 'grade', question, answer: body.text, ...this.codeEvidence(question, body.execution) }, body.skillSelections);
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
      try { grade = this.prepareInput(bindLearningSkills(data, grade, body.skillSelections), data); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODEL_INPUT_TOO_LARGE') throw error;
        throw new DomainError('MODEL_INPUT_TOO_LARGE', '固定评分标准与正式答案超过当前模型输入预算；答案尚未提交，请精简答案、选择更大上下文模型或明确跳过。', 413);
      }
    }
    const exposed = quiz.questions.some(q => q.knowledgeId === question.knowledgeId && quiz.answers[q.id]);
    const maxScore = question.rubric.reduce((sum, item) => sum + item.maxScore, 0);
    const correct = question.kind === 'single' && body.selectedIndex === question.correctIndex;
    const assessment: Assessment = { status: skipped ? 'skipped' : modelGraded ? 'pending' : 'graded', score: skipped || modelGraded ? null : correct ? maxScore : 0, maxScore, feedback: skipped ? '本题已跳过，不计入正确率。' : modelGraded ? '答案已保存，等待评价。' : correct ? '本次选择正确。' : '本次选择有误，请对照讲解核对。', assessedAt: modelGraded ? null : this.stamp(), version: 1 };
    if (!modelGraded) { assessment.source = 'automatic'; assessment.scores = skipped ? [] : question.rubric.map(row => ({ rubricId: row.id, description: row.description, maxScore: row.maxScore, score: correct ? row.maxScore : 0, evidence: `所选答案：${question.options[body.selectedIndex!]}` })); }
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
      const run = this.runs.queue(data, grade, { quizId: quiz.id, questionId, ...(quiz.sessionId ? { sessionId: quiz.sessionId } : {}), ...(quiz.reviewSessionId ? { reviewSessionId: quiz.reviewSessionId } : {}) }, true);
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
      if (effectiveLearningPreferences(data, this.config).schedulingEnabled) for (const point of this.points(session)) if (!data.knowledge[point.id]?.archivedAt && !Object.values(data.cards).some(card => !card.retiredAt && currentKnowledgeId(card) === point.id)) {
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
    requireThat(!card.retiredAt, 'CARD_RETIRED', '此卡片已在知识合并时停用，请使用保留的复习卡');
    requireThat(!card.pausedAt, 'CARD_PAUSED', '请先恢复这张卡片，再开始复习');
    requireThat(!record(data.knowledge, currentKnowledgeId(card)).archivedAt, 'KNOWLEDGE_ARCHIVED', '请先恢复知识点，再开始复习');
    const active = Object.values(data.reviewSessions).find(s => s.cardId === cardId && !['COMPLETED', 'ABANDONED'].includes(s.status));
    if (active) return { reviewSessionId: active.id };
    const id = randomUUID(); data.reviewSessions[id] = { id, cardId, expectedCardVersion: card.version, version: 1, status: 'RECALLING', recall: '', recallSubmittedAt: null, quizId: null, activeRunId: null, createdAt: this.stamp(), completedAt: null };
    return { reviewSessionId: id };
  }
  pauseReviewCard(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.extend({ paused: z.boolean() }).strict().parse(input);
    const card = record(data.cards, id); expectVersion(card, body.version);
    requireThat(!card.retiredAt, 'CARD_RETIRED', '合并时停用的卡片不能恢复');
    requireThat(!Object.values(data.reviewSessions).some(review => review.cardId === id && !['COMPLETED', 'ABANDONED'].includes(review.status)), 'REVIEW_IN_PROGRESS', '请先完成或放弃这张卡片正在进行的复习');
    if (Boolean(card.pausedAt) === body.paused) return { id, version: card.version };
    card.pausedAt = body.paused ? this.stamp() : null; card.version++;
    return { id, version: card.version };
  }
  reviewRecall(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), text: z.string().max(LIMITS.answerChars), action: z.enum(['draft', 'submitted']), skillSelections: skillSelectionSchema.optional() }).parse(input);
    const review = record(data.reviewSessions, id); expectVersion(review, body.version);
    requireThat(review.status === 'RECALLING' && !review.activeRunId && !review.recallSubmittedAt, 'INVALID_STATE', '回忆已提交或任务正在处理');
    requireThat(body.action === 'draft' || body.text.trim().length > 0, 'EMPTY_RECALL', '请先写下回忆内容，再开始定向测验', 400);
    review.recall = body.text; review.version++;
    if (body.action === 'draft') return { reviewSessionId: id, version: review.version };
    review.recallSubmittedAt = this.stamp();
    const card = record(data.cards, review.cardId); const point = record(data.knowledge, currentKnowledgeId(card));
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
    const weaknesses = recentWeaknessCues(data, point.id, this.now());
    const run = this.runs.queue(data, bindLearningSkills(data, { kind: 'quiz', points: [{ id: point.id, title: point.title, description: point.description, sourceIds: sources.map(item => item.id), knowledgeVersion: point.contentVersion! }], sources, recall: body.text, ...(weaknesses.length ? { weaknesses } : {}), count: Math.min(LIMITS.quizQuestions, this.config.quizCount), ...this.related(related), ...this.codeOption(data) }, body.skillSelections), { reviewSessionId: id });
    return { reviewSessionId: id, runId: run.id };
  }
  completeReview(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), expectedCardVersion: z.number().int().positive(), rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).parse(input);
    const review = record(data.reviewSessions, id); expectVersion(review, body.version);
    requireThat(review.status === 'READY_TO_COMPLETE' && review.quizId, 'INVALID_STATE', '请先交卷，再完成本次复习');
    const card = record(data.cards, review.cardId);
    requireThat(card.version === review.expectedCardVersion && body.expectedCardVersion === card.version, 'CARD_VERSION_CONFLICT', '卡片已被更新，请放弃旧会话后重新复习');
    const quiz = record(data.quizzes, review.quizId);
    const decision = reviewRating(Object.values(quiz.answers), body.rating);
    if (!card.retiredAt && !card.pausedAt && !record(data.knowledge, currentKnowledgeId(card)).archivedAt && effectiveLearningPreferences(data, this.config).schedulingEnabled && decision) {
      const { rating, reviewedAt } = decision;
      requireThat(!Object.values(data.reviewEvents).some(e => e.reviewSessionId === id), 'REVIEW_ALREADY_APPLIED', '这次复习已生效');
      const before = structuredClone(card.schedule); const after = nextSchedule(before, new Date(reviewedAt), rating);
      const eventId = randomUUID(); data.reviewEvents[eventId] = { id: eventId, reviewSessionId: id, cardId: card.id, rating, reviewedAt, before, after, algorithm: REVIEW_ALGORITHM, simulated: data.mode === 'mock' };
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
      reviewOrder: body.reviewOrder ?? saved?.reviewOrder ?? 'due',
      reviewBatchSize: body.reviewBatchSize === undefined ? saved?.reviewBatchSize ?? null : body.reviewBatchSize,
      codeExercisesEnabled: body.codeExercisesEnabled ?? saved?.codeExercisesEnabled ?? false,
      // Canonical order and no duplicates, so an unchanged choice compares equal.
      codeLanguages: CODE_LANGUAGES.filter(language => (body.codeLanguages ?? saved?.codeLanguages ?? DEFAULT_CODE_LANGUAGES).includes(language)) };
    return { version: data.revision + 1 };
  }
  addReviewCard(data: AppData, knowledgeId: string, input: unknown): CommandResult {
    const body = versionBody.extend({ confirm: z.literal(true) }).parse(input);
    requireThat(effectiveLearningPreferences(data, this.config).schedulingEnabled, 'SCHEDULING_NOT_ENABLED', '请先启用复习排期');
    const point = record(data.knowledge, knowledgeId); expectVersion(point, body.version);
    requireThat(!point.archivedAt, 'KNOWLEDGE_ARCHIVED', '请先恢复知识点，再加入复习');
    const existing = Object.values(data.cards).find(card => !card.retiredAt && currentKnowledgeId(card) === knowledgeId);
    if (existing) return { id: existing.id, version: existing.version };
    const id = randomUUID();
    data.cards[id] = { id, knowledgeId, version: 1, schedule: newSchedule(this.now()), createdAt: this.stamp() };
    return { id, version: 1 };
  }
  saveKnowledge(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.extend({ title: z.string().trim().min(1).max(LIMITS.knowledgeTitleChars), description: z.string().trim().min(1).max(LIMITS.knowledgeDescriptionChars), tags: z.array(z.string().trim().min(1).max(LIMITS.knowledgeTagChars)).max(LIMITS.knowledgeTagsMaximum) }).strict().parse(input);
    const point = record(data.knowledge, id); expectVersion(point, body.version);
    requireThat(!point.merge, 'KNOWLEDGE_MERGED', '此记录已合并，请前往当前知识点修改');
    this.contentBaseline(point);
    if (point.title !== body.title || point.description !== body.description) {
      point.title = body.title; point.description = body.description; point.contentVersion!++;
      this.contentBaseline(point);
    }
    point.tags = [...new Set(body.tags)]; point.version++; point.updatedAt = this.stamp();
    return { id, version: point.version };
  }
  archiveKnowledge(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.extend({ archived: z.boolean() }).strict().parse(input);
    const point = record(data.knowledge, id); expectVersion(point, body.version);
    requireThat(!point.merge, 'KNOWLEDGE_MERGED', '此记录已合并，请前往当前知识点修改');
    point.archivedAt = body.archived ? this.stamp() : null; point.version++; point.updatedAt = this.stamp();
    return { id, version: point.version };
  }
  mergeKnowledge(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ targetId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), retainedCardId: z.string().min(1).nullable(), confirm: z.literal(true) }).strict().parse(input);
    expectVersion({ version: data.revision }, body.expectedRevision);
    const preview = previewKnowledgeMerge(data, id, body.targetId);
    return applyKnowledgeMerge(data, preview, body.retainedCardId, this.stamp());
  }
  private correctionTarget(data: AppData, id: string, version: number, assessmentVersion: number) {
    const { quiz, question } = this.findQuestion(data, id); expectVersion(quiz, version);
    requireThat(quiz.submittedAt, 'QUIZ_NOT_SUBMITTED', '请先交卷，再核对评价');
    const answer = record(quiz.answers, id); expectVersion(answer.assessment, assessmentVersion);
    requireThat(!answer.skipped && answer.assessment.status !== 'pending', 'INVALID_ASSESSMENT', '跳过或正在评分的答案不能核对');
    requireThat(!Object.values(data.runs).some(run => run.quizId === quiz.id && isActiveRun(run)), 'RUN_IN_PROGRESS', '请等待或取消本测验的评价任务');
    return { quiz, question, answer };
  }
  disputeAssessment(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.extend({ assessmentVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(LIMITS.assessmentReasonChars) }).strict().parse(input);
    const { quiz, answer } = this.correctionTarget(data, id, body.version, body.assessmentVersion);
    requireThat(!answer.dispute || answer.dispute.resolvedAt, 'DISPUTE_OPEN', '此评价已有待核对标记');
    answer.dispute = { reason: body.reason, createdAt: this.stamp(), resolvedAt: null }; quiz.version++;
    this.addEvidence(data, quiz, id);
    return { quizId: quiz.id, version: quiz.version };
  }
  reviseAssessment(data: AppData, id: string, input: unknown): CommandResult {
    const body = versionBody.extend({ assessmentVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(LIMITS.assessmentReasonChars), method: z.enum(['manual', 'model']), skillSelections: skillSelectionSchema.optional(), feedback: z.string().trim().min(1).max(4000).optional(), scores: z.array(z.object({ rubricId: z.string(), score: z.number().nonnegative(), evidence: z.string().trim().min(1).max(2000) }).strict()).max(5).optional() }).strict().parse(input);
    const { quiz, question, answer } = this.correctionTarget(data, id, body.version, body.assessmentVersion);
    if (body.method === 'model') {
      requireThat(question.kind !== 'single', 'INVALID_ASSESSMENT', '单选题按固定答案判定，请使用人工核对');
      const task: AiTask = { kind: 'grade', question: structuredClone(question), answer: answer.text, ...(answer.execution ? { execution: structuredClone(answer.execution) } : {}) };
      const run = this.runs.queue(data, bindLearningSkills(data, task, body.skillSelections), { quizId: quiz.id, questionId: id, assessmentRevision: true });
      run.assessmentRevision = { expectedVersion: answer.assessment.version, reason: body.reason };
      return { quizId: quiz.id, runId: run.id };
    }
    requireThat(body.scores && body.feedback, 'INVALID_ASSESSMENT', '请填写每项得分、依据和核对结论', 400);
    const next = this.assessmentResult(question, { kind: 'grade', status: 'graded', scores: body.scores, feedback: body.feedback }, answer.assessment, 'manual', body.reason);
    this.commitAssessment(data, quiz, id, next, true);
    return { quizId: quiz.id, version: quiz.version };
  }
  private assessmentResult(question: Question, output: Extract<AiResponse['output'], { kind: 'grade' }>, previous: Assessment, source: 'model' | 'manual', reason?: string): Assessment {
    const rubric = question.rubric;
    requireThat(output.status === 'graded' || output.scores.length === 0, 'INVALID_SCORE', '待核对评价不能携带分数');
    if (output.status === 'graded') requireThat(output.scores.length === rubric.length && new Set(output.scores.map(s => s.rubricId)).size === rubric.length && output.scores.every(s => { const row = rubric.find(r => r.id === s.rubricId); return row && Number.isFinite(s.score) && s.score >= 0 && s.score <= row.maxScore && s.evidence.trim().length > 0; }), 'INVALID_SCORE', '评分不符合固定评分标准');
    return { status: output.status, score: output.status === 'graded' ? output.scores.reduce((sum, row) => sum + row.score, 0) : null,
      maxScore: previous.maxScore, feedback: output.feedback, assessedAt: this.stamp(), version: previous.version + 1, source,
      scores: output.scores.map(item => { const row = rubric.find(row => row.id === item.rubricId)!; return { ...item, description: row.description, maxScore: row.maxScore }; }), ...(reason ? { reason } : {}) };
  }
  private commitAssessment(data: AppData, quiz: Quiz, id: string, next: Assessment, revision: boolean) {
    const answer = record(quiz.answers, id);
    if (revision) (answer.assessmentHistory ??= []).push(structuredClone(answer.assessment));
    answer.assessment = next;
    if (answer.dispute && next.status === 'graded') answer.dispute.resolvedAt = this.stamp();
    quiz.version++;
    // Evidence is the latest projection, with its full prior assessment history attached.
    delete data.evidence[`${quiz.id}:${id}`];
    this.addEvidence(data, quiz, id);
  }
  saveUnderstanding(data: AppData, id: string, input: unknown): CommandResult {
    const body = z.object({ version: z.number().int().positive(), text: z.string().max(LIMITS.answerChars) }).parse(input);
    const point = record(data.knowledge, id); expectVersion(point, body.version);
    requireThat(!point.merge, 'KNOWLEDGE_MERGED', '此记录已合并，请前往当前知识点修改'); this.contentBaseline(point); point.understanding = body.text; point.version++; point.updatedAt = this.stamp(); return { id, version: point.version };
  }
  cancelRun(data: AppData, id: string) { return this.runs.cancelRun(data, id); }
  retryRun(data: AppData, id: string) { return this.runs.retryRun(data, id); }
  claimRun() { return this.runs.claimRun(); }
  recoverRuns() { return this.runs.recoverRuns(); }
  recordUsage(id: string, attempt: number, value: unknown) { return this.runs.recordUsage(id, attempt, value); }
  recordRunProgress(id: string, attempt: number, value: unknown, requestValue?: unknown, transportValue?: unknown) {
    return this.runs.recordRunProgress(id, attempt, value, requestValue, transportValue);
  }
  failRun(id: string, attemptId: string, message?: string, code?: RunErrorCode) { return this.runs.failRun(id, attemptId, message, code); }
  async finishRun(id: string, attemptId: string, response: AiResponse) {
    await this.repository.transact(data => {
      const run = record(data.runs, id);
      if (run.status !== 'running' || run.attemptId !== attemptId) return;
      const parsed = aiOutputSchema.safeParse(response.output);
      requireThat(parsed.success, 'INVALID_MODEL_OUTPUT', '模型响应校验失败');
      const output = parsed.data;
      requireThat(run.task.kind === output.kind, 'INVALID_MODEL_OUTPUT', '模型返回了错误的任务类型');
      if (run.evaluation) {
        run.evaluation.output = structuredClone(output);
        run.status = 'succeeded'; run.finishedAt = this.stamp(); if (response.usage != null) run.usage ??= usageSchema.parse(response.usage); run.error = null;
        return;
      }
      if (output.kind === 'connection_test') {
        run.status = 'succeeded'; run.finishedAt = this.stamp(); if (response.usage != null) run.usage ??= usageSchema.parse(response.usage); run.error = null;
        return;
      }
      if (run.assessmentRevision) {
        requireThat(output.kind === 'grade' && run.task.kind === 'grade' && run.quizId && run.questionId, 'INVALID_MODEL_OUTPUT', '无效复评任务');
        const quiz = record(data.quizzes, run.quizId); const answer = record(quiz.answers, run.questionId);
        requireThat(quiz.submittedAt, 'QUIZ_NOT_SUBMITTED', '复评需要已交卷测验');
        expectVersion(answer.assessment, run.assessmentRevision.expectedVersion);
        this.commitAssessment(data, quiz, run.questionId, this.assessmentResult(run.task.question as Question, output, answer.assessment, 'model', run.assessmentRevision.reason), true);
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
        session.candidates = output.candidates.map(c => ({ ...c, id: randomUUID(), decision: 'pending', knowledgeId: null, existingKnowledgeId: Object.values(data.knowledge).find(k => !k.archivedAt && normalizeTitle(k.title) === normalizeTitle(c.title))?.id ?? null }));
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
        const answer = record(quiz.answers, run.questionId);
        this.commitAssessment(data, quiz, run.questionId, this.assessmentResult(run.task.question as Question, output, answer.assessment, 'model'), false);
      } else throw new DomainError('INVALID_MODEL_OUTPUT', '任务结果缺少有效的业务关联');
      run.status = 'succeeded'; run.finishedAt = this.stamp(); if (response.usage != null) run.usage ??= usageSchema.parse(response.usage); run.error = null; this.runs.releaseRun(data, run);
    });
  }
}
