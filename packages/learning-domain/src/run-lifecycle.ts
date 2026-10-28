import { randomUUID } from './runtime.ts';
import { isActiveRun, runProgressSchema, runRequestSchema, runTransportSchema, usageSchema, type AgentRun, type AiTask, type AppData, type CommandResult, type PromptBinding, type RunErrorCode } from '@sanxing/contracts';
import { expectVersion, learningDate, record, requireThat, type DomainConfig } from './policy.ts';
import { bindLearningSkills } from './skills.ts';
import { runFailure } from './run-failure.ts';
import type { StateRepository } from './repository.ts';

/** Admission, ownership and attempt fencing. Learning results are applied by LearningService. */
export class RunLifecycle {
  constructor(private readonly repository: StateRepository, private readonly config: DomainConfig, private readonly now: () => Date,
    private readonly prepareInput: (task: AiTask, data: AppData) => AiTask,
    private readonly describePrompt: (task: AiTask) => PromptBinding) {}
  private stamp() { return this.now().toISOString(); }
  queue(data: AppData, task: AiTask, owner: { sessionId?: string; reviewSessionId?: string; quizId?: string; questionId?: string; assessmentRevision?: boolean }, alreadyPrepared = false): AgentRun {
    let contextError: string | null = null;
    let inputPrepared = alreadyPrepared;
    if (!alreadyPrepared) task = bindLearningSkills(data, task);
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
    const owned = (run: AgentRun) => run.task.kind !== 'connection_test' && (owner.sessionId ? run.sessionId === owner.sessionId : (owner.reviewSessionId ? run.reviewSessionId === owner.reviewSessionId : Boolean(owner.quizId && run.quizId === owner.quizId)));
    // startedAt stays null when admission fails before a model call. Those refusals must not burn the session cap.
    const calls = previous.filter(run => owned(run) && run.startedAt !== null).length;
    let error: string | null = null;
    let errorCode: RunErrorCode | undefined;
    if (task.kind !== 'connection_test' && calls >= this.config.maxCallsPerSession) { error = '本次会话已达到模型调用上限，请结束或稍后再学习。'; errorCode = 'REQUEST_LIMIT'; }
    else if ('points' in task && new Set(task.points.map(point => point.id)).size !== task.points.length) { error = '多个候选归入了同一个知识点。请重新确认范围，每项只绑定一个知识点。'; errorCode = 'INVALID_TASK'; }
    else if (contextError) { error = contextError; errorCode = 'MODEL_INPUT_TOO_LARGE'; }
    else if (dailyBudget !== null) {
      const today = learningDate(this.now(), this.config.timezone);
      const dailyRuns = previous.filter(run => learningDate(new Date(run.createdAt), this.config.timezone) === today);
      const spent = dailyRuns.reduce((sum, run) => sum + (run.usage?.cost ?? run.reservationUsd), 0);
      if (dailyRuns.some(run => run.startedAt !== null && run.usage?.cost == null && run.reservationUsd === 0)) { error = '今日存在未预留的未知费用，不能按零计入预算；请核对预算策略或等待下一个预算日。'; errorCode = 'BUDGET_UNVERIFIABLE'; }
      else if (spent + this.config.requestReservationUsd > dailyBudget) { error = '今日模型预算不足，输入已保存，未发起模型请求。'; errorCode = 'BUDGET_EXCEEDED'; }
    }
    const prompt = this.describePrompt(task);
    const run: AgentRun = {
      id: randomUUID(), status: error ? 'failed' : 'pending', task: structuredClone(task), sessionId: session?.id ?? null, reviewSessionId: review?.id ?? null,
      quizId: quiz?.id ?? null, questionId: owner.questionId ?? null, attempt: 0, attemptId: null,
      expectedVersion: task.kind === 'connection_test' ? 0 : task.kind === 'grade' ? (quiz?.version ?? 0) : (session?.version ?? review?.version ?? 0),
      createdAt: this.stamp(), startedAt: null, finishedAt: error ? this.stamp() : null, error, usage: null,
      reservationUsd: error || dailyBudget === null ? 0 : this.config.requestReservationUsd, promptVersion: prompt.version, inputPrepared,
      ...(prompt.hash ? { promptHash: prompt.hash } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
    data.runs[run.id] = run;
    if (!error) { if (session) session.activeRunId = run.id; if (review) review.activeRunId = run.id; }
    if (error && quiz && owner.questionId && !owner.assessmentRevision) {
      const answer = record(quiz.answers, owner.questionId);
      answer.assessment = { ...answer.assessment, status: 'needs_verification', feedback: error };
    }
    return run;
  }
  cancelRun(data: AppData, id: string): CommandResult {
    const run = record(data.runs, id);
    if (!['pending', 'running'].includes(run.status)) return { runId: id };
    run.status = 'cancelled'; run.error = '任务已取消，已提交的输入仍然保留。'; run.errorCode = 'CANCELLED'; run.finishedAt = this.stamp(); run.attemptId = null;
    this.releaseRun(data, run); return { runId: id };
  }
  releaseRun(data: AppData, run: AgentRun) {
    if (run.sessionId) { const session = record(data.sessions, run.sessionId); if (session.activeRunId === run.id) session.activeRunId = null; }
    if (run.reviewSessionId) { const review = record(data.reviewSessions, run.reviewSessionId); if (review.activeRunId === run.id) review.activeRunId = null; }
    if (run.task.kind === 'grade' && !run.assessmentRevision && run.quizId && run.questionId) {
      const quiz = record(data.quizzes, run.quizId); const answer = record(quiz.answers, run.questionId);
      if (answer.assessment.status === 'pending' && ['failed', 'cancelled'].includes(run.status)) { answer.assessment.status = 'needs_verification'; answer.assessment.feedback = run.error ?? '评价待核对'; quiz.version++; run.expectedVersion = quiz.version; }
    }
  }
  retryRun(data: AppData, id: string): CommandResult {
    const old = record(data.runs, id);
    requireThat(!old.evaluation, 'EVALUATION_CONFIRMATION_REQUIRED', '评估样例不能自动重试，请明确发起新批次');
    requireThat(!old.assessmentRevision, 'ASSESSMENT_CONFIRMATION_REQUIRED', '请从评价核对区重新确认模型复评');
    requireThat(old.task.kind !== 'connection_test', 'CONNECTION_TEST_CONFIRMATION_REQUIRED', '请到 Provider 授权重新点击确认测试；连接测试不能直接重试');
    requireThat(['failed', 'cancelled'].includes(old.status), 'INVALID_STATE', '只能重试失败或取消的任务');
    if (old.sessionId) { const session = record(data.sessions, old.sessionId); requireThat(session.status !== 'COMPLETED' && !session.activeRunId, 'SESSION_CLOSED', '会话已结束或正在处理'); if (old.task.kind !== 'grade') expectVersion(session, old.expectedVersion); }
    if (old.reviewSessionId) { const review = record(data.reviewSessions, old.reviewSessionId); requireThat(!['COMPLETED', 'ABANDONED'].includes(review.status) && !review.activeRunId, 'SESSION_CLOSED', '复习会话已结束或正在处理'); if (old.task.kind !== 'grade') expectVersion(review, old.expectedVersion); }
    if (old.quizId && old.questionId) { const quiz = record(data.quizzes, old.quizId); requireThat(!quiz.submittedAt, 'QUIZ_CLOSED', '已交卷的评价需要人工核对，不自动重评'); expectVersion(quiz, old.expectedVersion); quiz.answers[old.questionId]!.assessment.status = 'pending'; quiz.version++; }
    const run = this.queue(data, structuredClone({ ...old.task, skills: old.task.skills ?? [] }), { ...(old.sessionId ? { sessionId: old.sessionId } : {}), ...(old.reviewSessionId ? { reviewSessionId: old.reviewSessionId } : {}), ...(old.quizId ? { quizId: old.quizId } : {}), ...(old.questionId ? { questionId: old.questionId } : {}) }, old.inputPrepared !== false);
    return { runId: run.id };
  }
  async claimRun(): Promise<AgentRun | null> {
    return this.repository.transact(data => {
      for (const run of Object.values(data.runs).filter(r => r.status === 'pending')) {
        const prompt = this.describePrompt(run.task);
        if (run.promptVersion !== prompt.version || (prompt.hash !== undefined && run.promptHash !== prompt.hash)) {
          const failure = runFailure({ code: 'PROMPT_CHANGED' }, run);
          run.status = 'failed'; run.error = failure.message; run.errorCode = failure.code;
          run.finishedAt = this.stamp(); run.attemptId = null;
          // Rejected before execution: no call count or unknown-cost reservation is consumed.
          if (run.startedAt === null) run.reservationUsd = 0;
          this.releaseRun(data, run);
          continue;
        }
        run.status = 'running'; run.attempt++; run.attemptId = randomUUID(); run.startedAt = this.stamp();
        return structuredClone(run);
      }
      return null;
    });
  }
  async recoverRuns() {
    await this.repository.transact(data => {
      for (const run of Object.values(data.runs)) if (run.status === 'running' || (run.status === 'pending' && (run.task.kind === 'connection_test' || run.evaluation))) {
        // Never replay a diagnostic after restart, even if it had not started yet.
        run.status = 'failed'; run.error = run.task.kind === 'connection_test' ? '服务重启已中断连接测试；如请求已发出则可能已计费。请到 Provider 授权重新点击确认测试。' : '上次服务在运行中停止。输入已保留，请明确重试；原请求可能已计费。'; run.errorCode = 'SERVICE_RESTARTED'; run.attemptId = null; run.finishedAt = this.stamp(); this.releaseRun(data, run);
      }
    });
  }
  async recordUsage(id: string, attempt: number, value: unknown) {
    const usage = usageSchema.parse(value);
    if (this.repository.recordRunUsage) return this.repository.recordRunUsage(id, attempt, usage);
    await this.repository.transact(data => {
      const run = data.runs[id];
      // Accounting is independent of business-result acceptance. Cancellation cannot
      // erase already incurred usage, but an older attempt may never overwrite it.
      if (!run || attempt < 1 || run.attempt !== attempt || run.usage !== null) return;
      run.usage = usage;
    });
  }
  async recordRunProgress(id: string, attempt: number, value: unknown, requestValue?: unknown, transportValue?: unknown) {
    const progress = runProgressSchema.parse(value);
    const request = requestValue === undefined ? undefined : runRequestSchema.parse(requestValue);
    const transport = transportValue === undefined ? undefined : runTransportSchema.parse(transportValue);
    await this.repository.transact(data => {
      const run = data.runs[id];
      if (!run || attempt < 1 || run.attempt !== attempt || isActiveRun(run)) return;
      run.progress = progress;
      if (request) run.request = request;
      if (transport) run.transport = transport;
    });
  }
  async failRun(id: string, attemptId: string, message = 'AI 任务未完成，输入已保存。可以重试或结束本次学习。', code: RunErrorCode = 'MODEL_FAILED') {
    await this.repository.transact(data => {
      const run = record(data.runs, id); if (run.status !== 'running' || run.attemptId !== attemptId) return;
      run.status = 'failed'; run.error = message; run.errorCode = code; run.finishedAt = this.stamp(); this.releaseRun(data, run);
    });
  }
}
