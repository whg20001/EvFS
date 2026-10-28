import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@sanxing/contracts';
import { effectiveLearningPreferences, fingerprint, newSchedule } from '../src/policy.ts';
import { emptyData } from '@sanxing/database';
import { describeLearningPrompt } from '@sanxing/learning-agent';
import type { AiModelSelection, AiOutput, AiTask, AppData, CommandResult } from '@sanxing/contracts';
import { DomainError, LearningService, RunWorker, projectState } from '../src/index.ts';
import type { DomainConfig, StateRepository } from '../src/index.ts';

class MemoryRepository implements StateRepository {
  data = emptyData('mock');
  private pending = Promise.resolve();
  async read() { return structuredClone(this.data); }
  async transact<T>(fn: (data: AppData) => T | Promise<T>): Promise<T> {
    const work = this.pending.then(async () => { const draft = structuredClone(this.data); const result = await fn(draft); draft.revision++; this.data = draft; return structuredClone(result); });
    this.pending = work.then(() => {}, () => {}); return work;
  }
}
const config: DomainConfig = { mode: 'mock', timezone: 'Asia/Shanghai', maxUploadBytes: 131072, maxDocuments: 5, maxFollowups: 2, quizCount: 3, schedulingEnabled: true, maxCallsPerSession: 20, dailyBudgetUsd: 1, requestReservationUsd: 0.1, runTimeoutMs: 1000 };
function scripted(task: AiTask): AiOutput {
  if (task.kind === 'connection_test') return { kind: 'connection_test', ok: true };
  if (task.kind === 'extract') return { kind: 'extract', candidates: [{ title: '缓存穿透', description: '不存在的数据绕过缓存反复访问数据库。', sourceIds: [task.sources[0]!.id] }] };
  if (task.kind === 'followup') return { kind: 'followup', question: '空值缓存有哪些局限？', feedback: '这是练习反馈，不是掌握判定。' };
  if (task.kind === 'grade') return { kind: 'grade', status: 'needs_verification', scores: [], feedback: '请人工核对。' };
  const point = task.points[0]!;
  return { kind: 'quiz', questions: Array.from({ length: task.count }, (_, index) => ({ knowledgeId: point.id, kind: index === 1 ? 'short' : 'single', prompt: `解释缓存穿透 ${index}`, options: index === 1 ? [] : ['不存在的 key', '正常命中'], correctIndex: index === 1 ? null : 0, referenceAnswer: 'PRIVATE_REFERENCE_SENTINEL', rubric: [{ id: 'r1', description: 'PRIVATE_RUBRIC_SENTINEL', maxScore: 2 }], sourceIds: [task.sources[0]!.id] })) };
}
function fixture(overrides: Partial<DomainConfig> = {}) {
  const repository = new MemoryRepository(); repository.data.mode = overrides.mode ?? config.mode;
  let now = new Date('2026-03-01T15:59:00Z');
  const service = new LearningService(repository, { ...config, ...overrides }, () => now); let sequence = 0;
  const command = (fn: (data: AppData) => CommandResult, input: unknown = {}) => service.command('test', `key-test-${++sequence}`, input, fn);
  const flush = async () => { let run; while ((run = await service.claimRun())) await service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage: { provider: 'faux', model: 'scripted', inputTokens: 0, outputTokens: 0, cost: 0 } }); };
  return { repository, service, command, flush, advance: (milliseconds = 86_400_000) => { now = new Date(now.getTime() + milliseconds); } };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const draft = await f.command(data => f.service.createRecitation(data, {}));
  await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: '学习 Redis 缓存穿透及空值缓存。', unclear: 'TTL 如何选取？', application: '保护接口。', topic: 'Redis' }));
  const session = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 })); await f.flush();
  return { draftId: draft.id!, sessionId: session.sessionId! };
}
async function quizReady(f: ReturnType<typeof fixture>) {
  const base = await prepared(f); let state = await f.repository.read(); let session = state.sessions[base.sessionId]!;
  await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) })); await f.flush();
  state = await f.repository.read(); session = state.sessions[base.sessionId]!;
  await f.command(data => f.service.finishFollowup(data, session.id, { version: session.version })); await f.flush();
  return { ...base, quizId: (await f.repository.read()).sessions[session.id]!.quizId! };
}
async function answerAndSubmit(f: ReturnType<typeof fixture>, quizId: string) {
  let quiz = (await f.repository.read()).quizzes[quizId]!;
  await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'answer', text: '', selectedIndex: 0, assisted: false }));
  quiz = (await f.repository.read()).quizzes[quizId]!;
  await f.command(data => f.service.submitQuiz(data, quizId, { version: quiz.version, confirmSkip: true }));
}

it('keeps a formal answer and rubric intact when an obsolete grading task is rejected, then retries at the updated quiz version', async () => {
  const f = fixture(); const { quizId } = await quizReady(f);
  const service = new LearningService(f.repository, f.service.config, f.service.now, undefined, describeLearningPrompt);
  let quiz = (await f.repository.read()).quizzes[quizId]!;
  await f.command(data => service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'skip' }));
  quiz = (await f.repository.read()).quizzes[quizId]!;
  const question = quiz.questions[1]!;
  const submitted = await f.command(data => service.answerQuestion(data, question.id, { version: quiz.version, action: 'answer', text: '正式回答必须保留', assisted: false }));
  const original = (await f.repository.read()).runs[submitted.runId!]!;
  await f.repository.transact(data => { data.runs[original.id]!.promptVersion = 'learning-v5'; });
  expect(await service.claimRun()).toBeNull();
  quiz = (await f.repository.read()).quizzes[quizId]!;
  expect(quiz.answers[question.id]).toMatchObject({ text: '正式回答必须保留', assessment: { status: 'needs_verification', score: null } });
  expect(quiz.questions[1]).toEqual(question);
  const retry = await f.command(data => service.retryRun(data, original.id));
  const run = (await service.claimRun())!;
  expect(run.id).toBe(retry.runId); expect(run.task).toEqual(original.task);
  await service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage: null });
  expect((await f.repository.read()).runs[run.id]!.status).toBe('succeeded');
  expect((await f.repository.read()).quizzes[quizId]!.answers[question.id]!.text).toBe('正式回答必须保留');
});

describe('post-submission assessment isolation', () => {
  async function submittedShort(f: ReturnType<typeof fixture>) {
    const { quizId } = await quizReady(f);
    let quiz = (await f.repository.read()).quizzes[quizId]!;
    await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'skip' }));
    quiz = (await f.repository.read()).quizzes[quizId]!;
    const questionId = quiz.questions[1]!.id;
    await f.command(data => f.service.answerQuestion(data, questionId, { version: quiz.version, action: 'answer', text: '缓存空值，同时限制 TTL', selectedIndex: null, assisted: false })); await f.flush();
    quiz = (await f.repository.read()).quizzes[quizId]!;
    await f.command(data => f.service.submitQuiz(data, quizId, { version: quiz.version, confirmSkip: true }));
    quiz = (await f.repository.read()).quizzes[quizId]!;
    return { quizId, questionId, body: { version: quiz.version, assessmentVersion: quiz.answers[questionId]!.assessment.version, method: 'model', reason: '核对遗漏' } };
  }
  it.each(['cancel', 'fail', 'restart'] as const)('preserves the original assessment and fences late results after %s', async action => {
    const f = fixture(); const { quizId, questionId, body } = await submittedShort(f);
    const before = await f.repository.read();
    await f.command(data => f.service.reviseAssessment(data, questionId, body));
    const run = (await f.service.claimRun())!;
    if (action === 'cancel') await f.command(data => f.service.cancelRun(data, run.id));
    if (action === 'fail') await f.service.failRun(run.id, run.attemptId!);
    if (action === 'restart') await f.service.recoverRuns();
    await f.service.finishRun(run.id, run.attemptId!, { output: { kind: 'grade', status: 'graded', scores: [{ rubricId: 'r1', score: 2, evidence: '晚到的结果' }], feedback: '晚到的评价' }, usage: null });
    const after = await f.repository.read();
    expect(after.quizzes[quizId]).toEqual(before.quizzes[quizId]); expect(after.evidence).toEqual(before.evidence); expect(after.cards).toEqual(before.cards);
  });
  it('does not replace a previous grade when a correction is refused before execution', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null }); const { quizId, questionId, body } = await submittedShort(f);
    // Explicit manual correction gives a fully graded assessment before failed admission.
    await f.command(data => f.service.reviseAssessment(data, questionId, { ...body, method: 'manual', feedback: '核对后正确', scores: [{ rubricId: 'r1', score: 2, evidence: '答案中包含定义与条件' }] }));
    const before = await f.repository.read(); const quiz = before.quizzes[quizId]!;
    const capped = new LearningService(f.repository, { ...f.service.config, dailyBudgetUsd: 0.01, requestReservationUsd: 0.1 }, f.service.now);
    const result = await f.command(data => capped.reviseAssessment(data, questionId, { ...body, version: quiz.version, assessmentVersion: quiz.answers[questionId]!.assessment.version }));
    const after = await f.repository.read(); expect(after.runs[result.runId!]!.status).toBe('failed');
    expect(after.quizzes[quizId]).toEqual(before.quizzes[quizId]); expect(after.evidence).toEqual(before.evidence);
  });
});

it.each(['manual', 'dispute', 'archived'] as const)('does not advance a review schedule with %s evidence', async mode => {
  const f = fixture(); const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
  const card = Object.values((await f.repository.read()).cards)[0]!;
  const started = await f.command(data => f.service.startReview(data, card.id)); const reviewId = started.reviewSessionId!;
  await f.command(data => f.service.reviewRecall(data, reviewId, { version: 1, action: 'submitted', text: '有限 TTL，新增数据时失效空值缓存' })); await f.flush();
  const reviewQuizId = (await f.repository.read()).reviewSessions[reviewId]!.quizId!;
  await answerAndSubmit(f, reviewQuizId);
  let state = await f.repository.read(); const quiz = state.quizzes[reviewQuizId]!; const question = quiz.questions[0]!;
  const body = { version: quiz.version, assessmentVersion: quiz.answers[question.id]!.assessment.version, reason: '本次证据需核对' };
  if (mode === 'manual') await f.command(data => f.service.reviseAssessment(data, question.id, { ...body, method: 'manual', feedback: '自评通过', scores: [{ rubricId: 'r1', score: 2, evidence: '人工核对依据' }] }));
  if (mode === 'dispute') await f.command(data => f.service.disputeAssessment(data, question.id, body));
  if (mode === 'archived') await f.command(data => f.service.archiveKnowledge(data, card.knowledgeId, { version: state.knowledge[card.knowledgeId]!.version, archived: true }));
  state = await f.repository.read(); const review = state.reviewSessions[reviewId]!;
  await f.command(data => f.service.completeReview(data, reviewId, { version: review.version, expectedCardVersion: card.version, rating: 3 }));
  state = await f.repository.read(); expect(state.cards[card.id]).toEqual(card); expect(Object.values(state.reviewEvents)).toHaveLength(0); expect(state.reviewSessions[reviewId]!.status).toBe('COMPLETED');
});

it('does not replay a queued synthetic evaluation after restart', async () => {
  const f = fixture({ mode: 'live', dailyBudgetUsd: null });
  const task: AiTask = { kind: 'extract', recitation: { learned: '人工样例', unclear: '', application: '', topic: '' }, sources: [{ id: 'synthetic', name: '人工样例', text: '人工样例' }] };
  const result = await f.command(data => f.service.evaluate(data, task, { suite: 'test-v1', caseId: 'case-1', batchId: '00000000-0000-4000-8000-000000000001', selection }));
  await f.service.recoverRuns(); expect(await f.service.claimRun()).toBeNull();
  expect((await f.repository.read()).runs[result.runId!]!.status).toBe('failed');
  await expect(f.command(data => f.service.retryRun(data, result.runId!))).rejects.toMatchObject({ code: 'EVALUATION_CONFIRMATION_REQUIRED' });
});

const selection: AiModelSelection = { providerId: 'offline-provider', modelId: 'offline-model', authMethod: 'oauth', allowUnboundedOutput: false };
const probeUsage = { provider: 'offline-provider', model: 'offline-model', inputTokens: 8, outputTokens: 3, cost: 0.1 };
const businessState = (data: AppData) => ({ recitations: data.recitations, documents: data.documents, sessions: data.sessions, reviewSessions: data.reviewSessions, knowledge: data.knowledge, quizzes: data.quizzes, cards: data.cards, evidence: data.evidence, reviewEvents: data.reviewEvents });

it('re-prepares only a task that never reached a sendable frozen input', async () => {
  const f = fixture(); let calls = 0;
  const service = new LearningService(f.repository, f.service.config, f.service.now, task => {
    if (++calls === 1) throw Object.assign(new Error('Cannot fit this model'), { code: 'MODEL_INPUT_TOO_LARGE' });
    return structuredClone(task);
  });
  const draft = await f.command(data => service.createRecitation(data, {}));
  await f.command(data => service.saveDraft(data, draft.id!, { version: 1, learned: '学习内容', unclear: '', application: '', topic: '' }));
  const first = await f.command(data => service.submitRecitation(data, draft.id!, { version: 2 }));
  expect((await f.repository.read()).runs[first.runId!]!).toMatchObject({ status: 'failed', inputPrepared: false, startedAt: null });
  const retry = await f.command(data => service.retryRun(data, first.runId!));
  expect(calls).toBe(2);
  expect((await f.repository.read()).runs[retry.runId!]!).toMatchObject({ status: 'pending', inputPrepared: true });
  await f.command(data => service.cancelRun(data, retry.runId!));
  const frozen = (await f.repository.read()).runs[retry.runId!]!.task;
  const second = await f.command(data => service.retryRun(data, retry.runId!));
  expect(calls).toBe(2); expect((await f.repository.read()).runs[second.runId!]!.task).toEqual(frozen);
});

describe('persisted connection tests', () => {
  it('uses the worker and records usage without changing any existing learning state', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null, maxCallsPerSession: 1 });
    const { sessionId } = await prepared(f);
    const before = businessState(await f.repository.read());
    const result = await f.command(data => f.service.connectionTest(data, selection));
    expect((await f.repository.read()).runs[result.runId!]!).toMatchObject({ status: 'pending', task: { kind: 'connection_test', selection }, sessionId: null, reviewSessionId: null, quizId: null, questionId: null, expectedVersion: 0, promptVersion: 'connection-v1', reservationUsd: 0 });
    const worker = new RunWorker(f.service, { mode: 'live', async execute(task, options) {
      expect(task).toEqual({ kind: 'connection_test', selection });
      await options.onUsage?.(probeUsage);
      return { output: scripted(task), usage: probeUsage };
    } });
    await worker.tick(); await worker.stop();
    const state = await f.repository.read();
    expect(state.runs[result.runId!]!).toMatchObject({ status: 'succeeded', attempt: 1, usage: probeUsage, error: null });
    expect(businessState(state)).toEqual(before);
    expect(state.sessions[sessionId]).toEqual(before.sessions[sessionId]);
  });
  it('requires live mode and rejects admission while any task is pending or running', async () => {
    const mock = fixture();
    await expect(mock.command(data => mock.service.connectionTest(data, selection))).rejects.toMatchObject({ code: 'LIVE_MODE_REQUIRED' });
    const f = fixture({ mode: 'live' });
    await prepared(f);
    const session = Object.values((await f.repository.read()).sessions)[0]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) }));
    await expect(f.command(data => f.service.connectionTest(data, selection))).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
    const run = (await f.service.claimRun())!;
    await expect(f.command(data => f.service.connectionTest(data, selection))).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
    await f.command(data => f.service.cancelRun(data, run.id));
    await f.command(data => f.service.connectionTest(data, selection));
    await expect(f.command(data => f.service.connectionTest(data, selection))).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
  });
  it('enforces a global 30-second cooldown, including changed selections and failed admission', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: 0.01 });
    const first = await f.command(data => f.service.connectionTest(data, selection));
    expect((await f.repository.read()).runs[first.runId!]!.status).toBe('failed');
    await expect(f.command(data => f.service.connectionTest(data, selection))).rejects.toMatchObject({ code: 'CONNECTION_TEST_COOLDOWN', status: 429 });
    f.advance(29_999);
    await expect(f.command(data => f.service.connectionTest(data, { ...selection, modelId: 'other-model' }))).rejects.toMatchObject({ code: 'CONNECTION_TEST_COOLDOWN', status: 429 });
    f.advance(1);
    const second = await f.command(data => f.service.connectionTest(data, selection));
    expect(second.runId).not.toBe(first.runId);
    expect(Object.values((await f.repository.read()).runs)).toHaveLength(2);
  });
  it('counts probe cost and unknown reserved usage against the shared daily budget', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: 0.25, requestReservationUsd: 0.1 }); f.advance(-3_600_000);
    const first = await f.command(data => f.service.connectionTest(data, selection));
    expect((await f.repository.read()).runs[first.runId!]!.reservationUsd).toBe(0.1);
    let run = (await f.service.claimRun())!;
    await f.service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage: probeUsage });
    f.advance(30_000);
    await f.command(data => f.service.connectionTest(data, selection));
    run = (await f.service.claimRun())!;
    await f.service.recordUsage(run.id, run.attempt, { ...probeUsage, cost: null });
    await f.service.failRun(run.id, run.attemptId!);
    f.advance(30_000);
    const third = await f.command(data => f.service.connectionTest(data, selection));
    expect((await f.repository.read()).runs[third.runId!]!).toMatchObject({ status: 'failed', startedAt: null, reservationUsd: 0, error: expect.stringContaining('预算不足') });
    const draft = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: '共享预算', unclear: '', application: '', topic: '' }));
    const learning = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 }));
    expect((await f.repository.read()).runs[learning.runId!]!.error).toContain('预算不足');
  });
  it('has no spending cap without a budget but blocks unreserved unknown probe cost when enabled later', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null, requestReservationUsd: 0 }); f.advance(-3_600_000);
    await f.command(data => f.service.connectionTest(data, selection));
    const run = (await f.service.claimRun())!;
    await f.service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage: { ...probeUsage, cost: 10000 } });
    f.advance(30_000);
    const second = await f.command(data => f.service.connectionTest(data, selection));
    expect((await f.repository.read()).runs[second.runId!]!).toMatchObject({ status: 'pending', reservationUsd: 0 });
    const unknown = (await f.service.claimRun())!;
    await f.service.recordUsage(unknown.id, unknown.attempt, { ...probeUsage, cost: null });
    await f.service.failRun(unknown.id, unknown.attemptId!);
    f.advance(30_000);
    const capped = new LearningService(f.repository, { ...f.service.config, dailyBudgetUsd: 20000, requestReservationUsd: 0.1 }, f.service.now);
    const rejected = await f.command(data => capped.connectionTest(data, selection));
    expect((await f.repository.read()).runs[rejected.runId!]!).toMatchObject({ status: 'failed', startedAt: null, error: expect.stringContaining('未预留的未知费用') });
    expect((await f.repository.read()).runs[unknown.id]!.usage?.cost).toBeNull();
  });
  it('does not charge probe calls to learning or review session limits', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null, maxCallsPerSession: 3 });
    await f.command(data => f.service.connectionTest(data, selection)); await f.flush();
    const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    const card = Object.values((await f.repository.read()).cards)[0]!;
    const started = await f.command(data => f.service.startReview(data, card.id));
    const review = (await f.repository.read()).reviewSessions[started.reviewSessionId!]!;
    const reviewTask = await f.command(data => f.service.reviewRecall(data, review.id, { version: review.version, text: '复习', action: 'submitted' }));
    expect((await f.repository.read()).runs[reviewTask.runId!]!.status).toBe('pending');
    await f.flush();
    f.advance(30_000);
    const zeroCap = new LearningService(f.repository, { ...f.service.config, maxCallsPerSession: 0 }, f.service.now);
    const probe = await f.command(data => zeroCap.connectionTest(data, selection));
    expect((await f.repository.read()).runs[probe.runId!]!.status).toBe('pending');
  });
  it('fences wrong attempts and cancelled results while retaining usage once', async () => {
    const f = fixture({ mode: 'live' });
    await f.command(data => f.service.connectionTest(data, selection));
    const before = businessState(await f.repository.read());
    const run = (await f.service.claimRun())!;
    await f.service.finishRun(run.id, 'wrong-attempt', { output: scripted(run.task), usage: probeUsage });
    expect((await f.repository.read()).runs[run.id]!.status).toBe('running');
    await f.command(data => f.service.cancelRun(data, run.id));
    await f.service.recordUsage(run.id, run.attempt - 1, probeUsage);
    expect((await f.repository.read()).runs[run.id]!.usage).toBeNull();
    await f.service.recordUsage(run.id, run.attempt, probeUsage);
    await f.service.recordUsage(run.id, run.attempt, { ...probeUsage, cost: 999 });
    await f.service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage: probeUsage });
    await f.service.failRun(run.id, run.attemptId!, 'late error must not win');
    const state = await f.repository.read();
    expect(state.runs[run.id]!).toMatchObject({ status: 'cancelled', attemptId: null, usage: probeUsage, error: expect.stringContaining('已取消') });
    expect(businessState(state)).toEqual(before);
    await expect(f.command(data => f.service.retryRun(data, run.id))).rejects.toMatchObject({ code: 'CONNECTION_TEST_CONFIRMATION_REQUIRED' });
  });
  it('retains late callback usage after worker cancellation without replacing the cancelled status', async () => {
    const f = fixture({ mode: 'live' });
    const result = await f.command(data => f.service.connectionTest(data, selection));
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    let release!: () => void; const response = new Promise<void>(resolve => { release = resolve; });
    let recorded!: () => void; const lateUsage = new Promise<void>(resolve => { recorded = resolve; });
    const worker = new RunWorker(f.service, { mode: 'live', async execute(task, options) {
      began(); await response; await options.onUsage?.(probeUsage); recorded();
      return { output: scripted(task), usage: probeUsage };
    } });
    const tick = worker.tick(); await started;
    await f.command(data => f.service.cancelRun(data, result.runId!)); worker.cancel(result.runId!);
    await tick; release(); await lateUsage; await worker.stop();
    expect((await f.repository.read()).runs[result.runId!]!).toMatchObject({ status: 'cancelled', usage: probeUsage, error: expect.stringContaining('已取消') });
  });
  it('fails both pending and running probes on recovery and requires fresh explicit confirmation', async () => {
    for (const claimed of [false, true]) {
      const f = fixture({ mode: 'live' });
      const result = await f.command(data => f.service.connectionTest(data, selection));
      const run = claimed ? (await f.service.claimRun())! : null;
      await f.service.recoverRuns();
      expect((await f.repository.read()).runs[result.runId!]!).toMatchObject({ status: 'failed', attemptId: null, startedAt: claimed ? expect.any(String) : null, error: expect.stringContaining('Provider 授权重新点击确认测试') });
      expect(await f.service.claimRun()).toBeNull();
      await expect(f.command(data => f.service.retryRun(data, result.runId!))).rejects.toMatchObject({ code: 'CONNECTION_TEST_CONFIRMATION_REQUIRED', message: expect.stringContaining('Provider 授权重新点击确认测试') });
      if (run) {
        await f.service.recordUsage(run.id, run.attempt, probeUsage);
        await f.service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage: probeUsage });
        expect((await f.repository.read()).runs[run.id]!).toMatchObject({ status: 'failed', usage: probeUsage });
      }
    }
    const f = fixture();
    const draft = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: '恢复', unclear: '', application: '', topic: '' }));
    const pending = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 }));
    await f.service.recoverRuns();
    expect((await f.repository.read()).runs[pending.runId!]!.status).toBe('pending');
  });
  it.each([
    ['TIMEOUT', '中断或超时'], ['CANCELLED', '中断或超时'], ['MODEL_NOT_AUTHORIZED', '授权已失效'],
    ['INVALID_OUTPUT', '响应校验失败'], ['INVALID_MODEL_OUTPUT', '响应校验失败'], ['OUTPUT_LIMIT', '响应校验失败'],
    ['UNKNOWN_USAGE', '执行失败'], ['private-token-code', '执行失败'],
  ])('maps %s to a fixed safe failure while retaining observed usage', async (code, message) => {
    const f = fixture({ mode: 'live' });
    const result = await f.command(data => f.service.connectionTest(data, selection));
    const before = businessState(await f.repository.read());
    const worker = new RunWorker(f.service, { mode: 'live', async execute() { throw Object.assign(new Error('private-token-message'), { code, stack: 'private-token-stack', usage: { ...probeUsage, cost: null } }); } });
    await worker.tick(); await worker.stop();
    const state = await f.repository.read(); const run = state.runs[result.runId!]!;
    expect(run).toMatchObject({ status: 'failed', usage: { ...probeUsage, cost: null }, error: expect.stringContaining(message) });
    expect(run.error).not.toContain('private-token');
    expect(run.reservationUsd).toBe(0.1); expect(businessState(state)).toEqual(before);
  });
  it('labels generic aborts as interruption or timeout, without provider text', async () => {
    const f = fixture({ mode: 'live', runTimeoutMs: 5 });
    const result = await f.command(data => f.service.connectionTest(data, selection));
    const worker = new RunWorker(f.service, { mode: 'live', async execute(_task, options) {
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('private abort detail')), { once: true }));
    } });
    await worker.tick(); await worker.stop();
    expect((await f.repository.read()).runs[result.runId!]!).toMatchObject({ status: 'failed', usage: null, reservationUsd: 0.1, error: expect.stringContaining('中断或超时') });
  });
  it('rejects invalid output without creating business records and keeps billed usage', async () => {
    const f = fixture({ mode: 'live' });
    const result = await f.command(data => f.service.connectionTest(data, selection));
    const worker = new RunWorker(f.service, { mode: 'live', async execute() {
      return { output: { kind: 'connection_test', ok: false } as unknown as AiOutput, usage: probeUsage };
    } });
    await worker.tick(); await worker.stop();
    const state = await f.repository.read();
    expect(state.runs[result.runId!]!).toMatchObject({ status: 'failed', usage: probeUsage, error: expect.stringContaining('响应校验失败') });
    expect(businessState(state)).toEqual(businessState(emptyData('live')));
  });
});

describe('learning domain invariants', () => {
  it('keeps drafts independent from immutable submission snapshots', async () => {
    const f = fixture(); const { draftId, sessionId } = await prepared(f);
    await f.command(data => f.service.saveDraft(data, draftId, { version: 2, learned: '已修改的复述', unclear: '', application: '', topic: '' }));
    const state = await f.repository.read(); expect(state.sessions[sessionId]!.snapshot.learned).toContain('Redis'); expect(state.recitations[draftId]!.learned).toBe('已修改的复述');
  });
  it('rejects stale versions and rolls back their mutations', async () => {
    const f = fixture(); const { draftId } = await prepared(f);
    await expect(f.command(data => f.service.saveDraft(data, draftId, { version: 1, learned: 'wrong', unclear: '', application: '', topic: '' }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await f.repository.read()).recitations[draftId]!.learned).not.toBe('wrong');
  });
  it('deduplicates concurrent commands and rejects key reuse with different data', async () => {
    const f = fixture(); const call = () => f.service.command('create', 'stable-request', {}, data => f.service.createRecitation(data, {}));
    const [a, b] = await Promise.all([call(), call()]); expect(a).toEqual(b); expect(Object.keys((await f.repository.read()).recitations)).toHaveLength(1);
    await expect(f.service.command('create', 'stable-request', { different: true }, () => ({}))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('ends without a quiz without inventing evidence or ratings', async () => {
    const f = fixture(); const { sessionId } = await prepared(f); const session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.endSession(data, sessionId, { version: session.version, reason: 'no_quiz' }));
    const state = await f.repository.read(); expect(state.sessions[sessionId]!.completionReason).toBe('no_quiz'); expect(Object.keys(state.evidence)).toHaveLength(0); expect(Object.keys(state.reviewEvents)).toHaveLength(0);
  });
  it('does not create initial due dates before scheduling is explicitly enabled', async () => {
    const f = fixture({ schedulingEnabled: false }); const { quizId, sessionId } = await quizReady(f);
    await answerAndSubmit(f, quizId);
    const state = await f.repository.read();
    expect(state.sessions[sessionId]!.status).toBe('COMPLETED'); expect(Object.values(state.evidence)).toHaveLength(1);
    expect(Object.values(state.cards)).toHaveLength(0); expect(Object.values(state.reviewEvents)).toHaveLength(0);
  });
  it('does not leak reference answers, rubrics, or future questions in DTOs', async () => {
    const f = fixture(); const { quizId } = await quizReady(f); const state = projectState(await f.repository.read(), config, 'csrf'); const text = JSON.stringify(state);
    expect(text).not.toContain('PRIVATE_REFERENCE_SENTINEL'); expect(text).not.toContain('PRIVATE_RUBRIC_SENTINEL'); expect(text).not.toContain('correctIndex');
    expect(state.quizzes.find(q => q.id === quizId)!.questions).toHaveLength(1);
  });
  it('draft saving never grades, final answer is immutable, skipped is not wrong', async () => {
    const f = fixture(); const { quizId } = await quizReady(f); let quiz = (await f.repository.read()).quizzes[quizId]!; const questionId = quiz.questions[0]!.id;
    await f.command(data => f.service.saveAnswerDraft(data, questionId, { version: quiz.version, text: '草稿' }));
    quiz = (await f.repository.read()).quizzes[quizId]!; expect(quiz.answers).toEqual({});
    await f.command(data => f.service.answerQuestion(data, questionId, { version: quiz.version, action: 'skip' }));
    quiz = (await f.repository.read()).quizzes[quizId]!; expect(quiz.answers[questionId]!.assessment.score).toBeNull();
    await expect(f.command(data => f.service.saveAnswerDraft(data, questionId, { version: quiz.version, text: '覆盖' }))).rejects.toMatchObject({ code: 'ANSWER_LOCKED' });
  });
  it('cancellation fences late model results', async () => {
    const f = fixture(); const draft = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: 'Redis', unclear: '', application: '', topic: '' }));
    const result = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 })); const run = await f.service.claimRun();
    await f.command(data => f.service.cancelRun(data, result.runId!));
    await f.service.finishRun(run!.id, run!.attemptId!, { output: scripted(run!.task), usage: { provider: 'faux', model: 'faux', inputTokens: 0, outputTokens: 0, cost: 0 } });
    const state = await f.repository.read(); expect(state.runs[run!.id]!.status).toBe('cancelled'); expect(state.sessions[result.sessionId!]!.candidates).toHaveLength(0);
  });
  it('preserves usage reported with a failure independently of the rejected result', async () => {
    const f = fixture(); const draft = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: 'Redis', unclear: '', application: '', topic: '' }));
    const submitted = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 }));
    const usage = { provider: 'test', model: 'test', inputTokens: 20, outputTokens: 5, cost: null };
    const worker = new RunWorker(f.service, { mode: 'mock', async execute() { throw Object.assign(new Error('private provider detail'), { usage }); } });
    await worker.tick(); await worker.stop();
    const run = (await f.repository.read()).runs[submitted.runId!]!;
    expect(run.status).toBe('failed'); expect(run.usage).toEqual(usage); expect(run.error).not.toContain('private provider detail');
  });
  it('keeps cancelled usage exactly once while fencing older attempts and business writes', async () => {
    const f = fixture(); const draft = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: 'Redis', unclear: '', application: '', topic: '' }));
    const submitted = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 }));
    const run = (await f.service.claimRun())!;
    const usage = { provider: 'test', model: 'test', inputTokens: 10, outputTokens: 4, cost: null };
    await f.command(data => f.service.cancelRun(data, run.id));
    await f.service.recordUsage(run.id, run.attempt - 1, usage);
    expect((await f.repository.read()).runs[run.id]!.usage).toBeNull();
    await f.service.recordUsage(run.id, run.attempt, usage); await f.service.recordUsage(run.id, run.attempt, usage);
    await f.service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage });
    const state = await f.repository.read();
    expect(state.runs[run.id]!.usage).toEqual(usage); expect(state.runs[run.id]!.status).toBe('cancelled');
    expect(state.sessions[submitted.sessionId!]!.candidates).toHaveLength(0);
  });
  it('supports UTF-8 TXT/Markdown and rejects other formats and invalid bytes', async () => {
    const f = fixture(); const result = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.addDocument(data, { recitationId: result.id, name: '笔记.md', text: '# 缓存\r\n原理' }));
    expect(Object.values((await f.repository.read()).documents)[0]!.lineCount).toBe(2);
    await expect(f.command(data => f.service.addDocument(data, { recitationId: result.id, name: 'x.pdf', text: 'x' }))).rejects.toMatchObject({ code: 'PDF_FILE_REQUIRED' });
    await expect(f.command(data => f.service.addDocument(data, { recitationId: result.id, name: 'x.txt', text: '' }, new Uint8Array([255, 254, 0])))).rejects.toBeInstanceOf(DomainError);
  });
  it('reuses cards across days and updates one review event exactly once', async () => {
    const f = fixture(); const first = await quizReady(f); await answerAndSubmit(f, first.quizId); const original = Object.values((await f.repository.read()).cards)[0]!;
    f.advance(); const second = await quizReady(f); await answerAndSubmit(f, second.quizId);
    expect(Object.values((await f.repository.read()).cards)).toHaveLength(1);
    const [start, same] = await Promise.all([f.command(data => f.service.startReview(data, original.id)), f.command(data => f.service.startReview(data, original.id))]); expect(start.reviewSessionId).toBe(same.reviewSessionId);
    let review = (await f.repository.read()).reviewSessions[start.reviewSessionId!]!;
    await f.command(data => f.service.reviewRecall(data, review.id, { version: review.version, text: '不存在的数据反复到数据库', action: 'submitted' })); await f.flush();
    review = (await f.repository.read()).reviewSessions[review.id]!; await answerAndSubmit(f, review.quizId!); review = (await f.repository.read()).reviewSessions[review.id]!;
    const body = { version: review.version, expectedCardVersion: review.expectedCardVersion, rating: 3 };
    const finish = () => f.service.command('complete', 'finish-one-review', body, data => f.service.completeReview(data, review.id, body));
    await finish(); await finish(); const state = await f.repository.read(); expect(Object.values(state.reviewEvents)).toHaveLength(1); expect(state.cards[original.id]!.version).toBe(2); expect(state.cards[original.id]!.schedule.reps).toBe(1);
  });
  it('disables only the spending cap when no budget is set, retaining observed and unknown costs', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null, requestReservationUsd: 0 });
    const { sessionId } = await prepared(f);
    await f.repository.transact(data => { Object.values(data.runs)[0]!.usage!.cost = 10000; });
    const session = (await f.repository.read()).sessions[sessionId]!;
    const result = await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) }));
    const pending = (await f.repository.read()).runs[result.runId!]!;
    expect(pending.status).toBe('pending'); expect(pending.reservationUsd).toBe(0);
    const run = (await f.service.claimRun())!;
    await f.service.recordUsage(run.id, run.attempt, { provider: 'test', model: 'test', inputTokens: 7, outputTokens: 3, cost: null });
    await f.service.failRun(run.id, run.attemptId!);
    expect((await f.repository.read()).runs[run.id]!.usage?.cost).toBeNull();
    expect(Object.values((await f.repository.read()).runs)[0]!.usage!.cost).toBe(10000);
  });
  it('still enforces per-session attempts without a budget and optional explicit budgets when supplied', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null, requestReservationUsd: 0, maxCallsPerSession: 1 });
    const { sessionId } = await prepared(f); const session = (await f.repository.read()).sessions[sessionId]!;
    const result = await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) }));
    expect((await f.repository.read()).runs[result.runId!]!.error).toContain('调用上限');
    const capped = fixture({ mode: 'live', dailyBudgetUsd: 0.05, requestReservationUsd: 0.1 });
    const draft = await capped.command(data => capped.service.createRecitation(data, {}));
    await capped.command(data => capped.service.saveDraft(data, draft.id!, { version: 1, learned: '预算测试', unclear: '', application: '', topic: '' }));
    const submitted = await capped.command(data => capped.service.submitRecitation(data, draft.id!, { version: 2 }));
    expect((await capped.repository.read()).runs[submitted.runId!]!).toMatchObject({ status: 'failed', startedAt: null, reservationUsd: 0 });
    expect((await capped.repository.read()).runs[submitted.runId!]!.error).toContain('预算不足');
  });
  it('does not count unreserved unknown history as free when a budget is later enabled', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null, requestReservationUsd: 0 });
    const { sessionId } = await prepared(f);
    await f.repository.transact(data => { Object.values(data.runs)[0]!.usage!.cost = null; });
    const capped = new LearningService(f.repository, { ...f.service.config, dailyBudgetUsd: 20, requestReservationUsd: 0.1 }, f.service.now);
    const session = (await f.repository.read()).sessions[sessionId]!;
    const rejected = await f.command(data => capped.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) }));
    expect((await f.repository.read()).runs[rejected.runId!]!).toMatchObject({ status: 'failed', startedAt: null, error: expect.stringContaining('未预留的未知费用') });
    f.advance(); const retried = await f.command(data => capped.retryRun(data, rejected.runId!));
    expect((await f.repository.read()).runs[retried.runId!]!).toMatchObject({ status: 'pending', reservationUsd: 0.1 });
  });
  it('rolls back a command and its receipt when asynchronous host admission fails', async () => {
    const f = fixture();
    await expect(f.service.command('admission', 'async-admission-test', {}, async data => {
      f.service.createRecitation(data, {});
      await Promise.resolve(); throw new DomainError('AI_MODEL_NOT_SELECTED', '请先选择模型');
    })).rejects.toMatchObject({ code: 'AI_MODEL_NOT_SELECTED' });
    const state = await f.repository.read(); expect(state.recitations).toEqual({}); expect(state.receipts).toEqual({});
  });
  it('does not accept prototype property names as resource IDs', async () => {
    const f = fixture(); await expect(f.command(data => f.service.startReview(data, '__proto__'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects binding two accepted candidates to one knowledge point', async () => {
    const f = fixture();
    const draft = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: '缓存穿透与缓存击穿。', unclear: '', application: '', topic: 'Redis' }));
    const submitted = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 }));
    const run = (await f.service.claimRun())!;
    const sourceId = run.task.kind === 'extract' ? run.task.sources[0]!.id : '';
    const usage = { provider: 'faux', model: 'scripted', inputTokens: 1, outputTokens: 1, cost: 0 };
    await f.service.finishRun(run.id, run.attemptId!, { output: { kind: 'extract', candidates: [
      { title: '缓存穿透', description: '不存在的 key 打到数据库。', sourceIds: [sourceId] },
      { title: '缓存击穿', description: '热点 key 失效后并发打到数据库。', sourceIds: [sourceId] },
    ] }, usage });
    const session = (await f.repository.read()).sessions[submitted.sessionId!]!;
    const pointId = 'shared-point';
    await f.repository.transact(data => {
      data.knowledge[pointId] = { id: pointId, title: '缓存', description: '已有知识点', sourceIds: [sourceId], version: 1, understanding: '', createdAt: session.createdAt, updatedAt: session.createdAt };
    });
    const decisions = session.candidates.map(candidate => ({ candidateId: candidate.id, decision: 'accepted' as const, existingKnowledgeId: pointId }));
    await expect(f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions }))).rejects.toMatchObject({ code: 'DUPLICATE_KNOWLEDGE' });
    const state = await f.repository.read();
    expect(state.sessions[session.id]!.candidates.every(candidate => candidate.decision === 'pending')).toBe(true);
    expect(state.knowledge[pointId]!.description).toBe('已有知识点');
    expect(Object.values(state.runs).filter(item => item.task.kind === 'followup')).toHaveLength(0);
  });
  it('clears candidates when the scope changes and does not rewrite an older answer', async () => {
    const f = fixture({ maxFollowups: 1 });
    const { sessionId } = await prepared(f);
    let session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(candidate => ({ candidateId: candidate.id, decision: 'accepted' as const })) }));
    await f.flush();
    session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.followupAnswer(data, session.id, { version: session.version, text: '旧回答', assisted: false }));
    await f.flush();
    session = (await f.repository.read()).sessions[sessionId]!;
    const savedFeedback = session.turns[0]!.feedback;
    expect(savedFeedback).toContain('练习反馈');
    await f.command(data => f.service.changeScope(data, session.id, { version: session.version, documentIds: [] }));
    session = (await f.repository.read()).sessions[sessionId]!;
    expect(session.status).toBe('CONFIRMING');
    expect(session.candidates).toEqual([]);
    const failed = (await f.service.claimRun())!;
    await f.service.failRun(failed.id, failed.attemptId!);
    session = (await f.repository.read()).sessions[sessionId]!;
    expect(session.candidates).toEqual([]);
    await expect(f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: 'gone', decision: 'accepted' }] }))).rejects.toMatchObject({ code: 'INCOMPLETE_CONFIRMATION' });
    const retried = await f.command(data => f.service.retryRun(data, failed.id));
    const next = (await f.service.claimRun())!;
    expect(next.id).toBe(retried.runId);
    const sourceId = next.task.kind === 'extract' ? next.task.sources[0]!.id : '';
    const usage = { provider: 'faux', model: 'scripted', inputTokens: 1, outputTokens: 1, cost: 0 };
    await f.service.finishRun(next.id, next.attemptId!, { output: { kind: 'extract', candidates: [{ title: '新范围', description: '更新后的候选。', sourceIds: [sourceId] }] }, usage });
    session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted' }] }));
    const follow = (await f.service.claimRun())!;
    expect(follow.task.kind === 'followup' && follow.task.turns).toEqual([]);
    expect(JSON.stringify(follow.task)).not.toContain('旧回答');
    await f.service.finishRun(follow.id, follow.attemptId!, { output: { kind: 'followup', question: '新问题', feedback: '新范围反馈' }, usage });
    session = (await f.repository.read()).sessions[sessionId]!;
    expect(session.turns[0]).toMatchObject({ answer: '旧回答', feedback: savedFeedback });
    expect(session.turns.at(-1)).toMatchObject({ question: '新问题', answer: null, feedback: null, scopeVersion: session.scopeVersion });
  });
  it('does not let budget refusals consume the session model-call cap', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: 0.05, requestReservationUsd: 0.1, maxCallsPerSession: 2 });
    const draft = await f.command(data => f.service.createRecitation(data, {}));
    await f.command(data => f.service.saveDraft(data, draft.id!, { version: 1, learned: '预算', unclear: '', application: '', topic: '' }));
    const first = await f.command(data => f.service.submitRecitation(data, draft.id!, { version: 2 }));
    expect((await f.repository.read()).runs[first.runId!]!.error).toContain('预算不足');
    const second = await f.command(data => f.service.retryRun(data, first.runId!));
    expect((await f.repository.read()).runs[second.runId!]!.error).toContain('预算不足');
    const relaxed = new LearningService(f.repository, { ...f.service.config, dailyBudgetUsd: 100 }, f.service.now);
    const third = await f.command(data => relaxed.retryRun(data, second.runId!));
    expect((await f.repository.read()).runs[third.runId!]).toMatchObject({ status: 'pending', startedAt: null, error: null });
  });
});

describe('explicit library reuse and mode-local preferences', () => {
  it('attaches original documents across recitations with CAS/shared quota and only detaches draft references', async () => {
    const f = fixture({ maxDocuments: 1 }); const first = await prepared(f);
    const doc = await f.command(data => f.service.addDocument(data, { recitationId: first.draftId, name: 'shared.md', text: 'SHARED_ORIGINAL' }));
    let state = await f.repository.read();
    await f.command(data => f.service.changeScope(data, first.sessionId, { version: state.sessions[first.sessionId]!.version, documentIds: [doc.id!] })); await f.flush();
    f.advance(); const second = await prepared(f);
    state = await f.repository.read(); const original = state.documents[doc.id!]!;
    await expect(f.command(data => f.service.changeScope(data, second.sessionId, { version: state.sessions[second.sessionId]!.version, documentIds: [doc.id!] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.command(data => f.service.attachDocument(data, second.draftId, { version: 1, documentId: doc.id, confirm: true }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(f.command(data => f.service.attachDocument(data, second.draftId, { version: 2, documentId: 'missing', confirm: true }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const attached = await f.command(data => f.service.attachDocument(data, second.draftId, { version: 2, documentId: doc.id, confirm: true }));
    expect(attached.version).toBe(3);
    expect(await f.command(data => f.service.attachDocument(data, second.draftId, { version: 3, documentId: doc.id, confirm: true }))).toEqual(attached);
    await expect(f.command(data => f.service.addDocument(data, { recitationId: second.draftId, name: 'extra.md', text: 'extra' }))).rejects.toMatchObject({ code: 'DOCUMENT_LIMIT' });
    await expect(f.command(data => f.service.attachDocument(data, first.draftId, { version: 3, documentId: doc.id, confirm: false }))).rejects.toThrow();
    await f.command(data => f.service.changeScope(data, second.sessionId, { version: state.sessions[second.sessionId]!.version, documentIds: [doc.id!] })); await f.flush();
    await f.command(data => f.service.removeDocument(data, second.draftId, doc.id!, { version: 3 }));
    state = await f.repository.read();
    expect(state.documents[doc.id!]).toEqual(original); expect(Object.keys(state.documents)).toHaveLength(1);
    expect(state.recitations[first.draftId]!.documentIds).toEqual([doc.id]);
    expect(state.recitations[second.draftId]!.documentIds).toEqual([]);
    expect(state.sessions[first.sessionId]!.documentIds).toEqual([doc.id]);
    expect(state.sessions[second.sessionId]!.documentIds).toEqual([doc.id]);
    await expect(f.command(data => f.service.removeDocument(data, second.draftId, doc.id!, { version: 4 }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.command(data => f.service.changeScope(data, second.sessionId, { version: state.sessions[second.sessionId]!.version, documentIds: [doc.id!] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const local = await f.command(data => f.service.addDocument(data, { recitationId: second.draftId, name: 'local.md', text: 'local' }));
    await expect(f.command(data => f.service.attachDocument(data, first.draftId, { version: 3, documentId: local.id, confirm: true }))).rejects.toMatchObject({ code: 'DOCUMENT_LIMIT' });
  });
  it('associates old knowledge only when enabled, freezing it beside (never inside) sources and points', async () => {
    const f = fixture(); await quizReady(f); const old = Object.values((await f.repository.read()).knowledge)[0]!;
    // Default off: nothing is associated, even with identical content.
    f.advance(); const second = await prepared(f); let session = (await f.repository.read()).sessions[second.sessionId]!;
    const off = await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted', existingKnowledgeId: null }], relatedKnowledgeIds: [old.id] }));
    let state = await f.repository.read();
    const offTask = state.runs[off.runId!]!.task;
    expect(offTask.kind === 'followup' && offTask.related).toBeUndefined();
    expect(state.sessions[session.id]!.relatedKnowledge).toEqual([]);
    const secondPoint = state.sessions[session.id]!.candidates[0]!.knowledgeId!;
    await f.command(data => f.service.endSession(data, session.id, { version: data.sessions[session.id]!.version, reason: 'user_ended' }));
    await f.command(data => f.service.saveLearningPreferences(data, { expectedRevision: data.revision, schedulingEnabled: true, promptCacheRetention: 'none', associationEnabled: true, confirm: true }));
    expect(effectiveLearningPreferences(await f.repository.read(), f.service.config).associationEnabled).toBe(true);
    // Enabled: the reused point is the scope itself and is never its own association.
    f.advance(); const third = await prepared(f); session = (await f.repository.read()).sessions[third.sessionId]!;
    const on = await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted', existingKnowledgeId: secondPoint }] }));
    state = await f.repository.read();
    const task = state.runs[on.runId!]!.task;
    if (task.kind !== 'followup') throw new Error('expected followup');
    expect(task.related).toEqual([{ id: old.id, title: old.title, description: old.description, knowledgeVersion: 1 }]);
    expect(task.points.map(point => point.id)).toEqual([secondPoint]);
    expect(task.points[0]!.sourceIds.some(id => id.startsWith('knowledge:'))).toBe(false);
    expect(task.sources.some(source => source.id.startsWith('knowledge:'))).toBe(false);
    expect(state.sessions[session.id]!.relatedKnowledge).toEqual([{ id: old.id, title: old.title, description: old.description, sourceIds: old.sourceIds, knowledgeVersion: 1 }]);
    await f.flush(); session = (await f.repository.read()).sessions[session.id]!;
    await f.repository.transact(data => { data.knowledge[old.id]!.description = 'LATEST_MUST_NOT_REPLACE_REFERENCE'; });
    const quiz = await f.command(data => f.service.finishFollowup(data, session.id, { version: session.version }));
    const quizTask = (await f.repository.read()).runs[quiz.runId!]!.task;
    if (quizTask.kind !== 'quiz') throw new Error('expected quiz');
    expect(quizTask.related).toEqual(task.related);
    const completedScope = (await f.repository.read()).sessions[session.id]!;
    expect(quizTask.turns).toEqual(completedScope.turns.filter(turn => turn.scopeVersion === completedScope.scopeVersion));
    expect(JSON.stringify(quizTask)).not.toContain('LATEST_MUST_NOT_REPLACE_REFERENCE');
    // A combined question stays assessed under the current point; unknown or assessed-alone related ids are rejected.
    const run = (await f.service.claimRun())!; const output = scripted(run.task);
    if (output.kind !== 'quiz') throw new Error('expected quiz');
    await expect(f.service.finishRun(run.id, run.attemptId!, { output: { ...output, questions: output.questions.map(q => ({ ...q, relatedKnowledgeIds: ['unknown'] })) }, usage: null })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    await expect(f.service.finishRun(run.id, run.attemptId!, { output: { ...output, questions: output.questions.map(q => ({ ...q, knowledgeId: old.id })) }, usage: null })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    await f.service.finishRun(run.id, run.attemptId!, { output: { ...output, questions: output.questions.map(q => ({ ...q, relatedKnowledgeIds: [old.id] })) }, usage: null });
    state = await f.repository.read();
    const stored = state.quizzes[state.sessions[session.id]!.quizId!]!;
    expect(stored.questions.every(q => q.knowledgeId === secondPoint && q.relatedKnowledgeIds?.[0] === old.id)).toBe(true);
    await f.command(data => f.service.endSession(data, session.id, { version: data.sessions[session.id]!.version, reason: 'user_ended' }));
  });
  it('combines related knowledge in review quizzes without showing it or touching other cards', async () => {
    const f = fixture(); const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    f.advance(); const second = await prepared(f); let session = (await f.repository.read()).sessions[second.sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted', existingKnowledgeId: null }] })); await f.flush();
    session = (await f.repository.read()).sessions[second.sessionId]!;
    await f.command(data => f.service.finishFollowup(data, session.id, { version: session.version })); await f.flush();
    await answerAndSubmit(f, (await f.repository.read()).sessions[second.sessionId]!.quizId!);
    let state = await f.repository.read();
    const [card, other] = Object.values(state.cards).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
    const otherBefore = structuredClone(other!);
    const recall = async () => {
      const start = await f.command(data => f.service.startReview(data, card!.id));
      const result = await f.command(data => f.service.reviewRecall(data, start.reviewSessionId!, { version: 1, text: '缓存穿透：不存在的数据绕过缓存', action: 'submitted' }));
      return { reviewSessionId: start.reviewSessionId!, task: (await f.repository.read()).runs[result.runId!]!.task };
    };
    const disabled = await recall();
    expect(disabled.task.kind === 'quiz' && disabled.task.related).toBeUndefined();
    await f.command(data => f.service.abandonReview(data, disabled.reviewSessionId, { version: data.reviewSessions[disabled.reviewSessionId]!.version }));
    await f.command(data => f.service.saveLearningPreferences(data, { expectedRevision: data.revision, schedulingEnabled: true, promptCacheRetention: 'none', associationEnabled: true, confirm: true }));
    const enabled = await recall();
    if (enabled.task.kind !== 'quiz') throw new Error('expected quiz');
    expect(enabled.task.related?.map(point => point.id)).toEqual([other!.knowledgeId]);
    expect(enabled.task.points.map(point => point.id)).toEqual([card!.knowledgeId]);
    const run = (await f.service.claimRun())!; const output = scripted(run.task);
    if (output.kind !== 'quiz') throw new Error('expected quiz');
    await f.service.finishRun(run.id, run.attemptId!, { output: { ...output, questions: output.questions.map(q => ({ ...q, relatedKnowledgeIds: [other!.knowledgeId] })) }, usage: null });
    state = await f.repository.read();
    const review = state.reviewSessions[enabled.reviewSessionId]!;
    await answerAndSubmit(f, review.quizId!);
    state = await f.repository.read();
    const ready = state.reviewSessions[enabled.reviewSessionId]!;
    await f.command(data => f.service.completeReview(data, ready.id, { version: ready.version, expectedCardVersion: card!.version, rating: 3 }));
    state = await f.repository.read();
    expect(state.cards[other!.id]).toEqual(otherBefore);
    expect(Object.values(state.reviewEvents).every(event => event.cardId === card!.id)).toBe(true);
    expect(Object.values(state.evidence).filter(item => item.quizId === review.quizId).every(item => item.knowledgeId === card!.knowledgeId)).toBe(true);
  });
  it('rejects a quiz source allowed globally but not by its specific frozen point', async () => {
    const f = fixture(); const { draftId, sessionId } = await prepared(f);
    const doc = await f.command(data => f.service.addDocument(data, { recitationId: draftId, name: 'second.md', text: 'second point only' }));
    await f.repository.transact(data => {
      const session = data.sessions[sessionId]!; session.documentIds.push(doc.id!);
      session.candidates.push({ ...session.candidates[0]!, id: 'second-candidate', title: 'Other', sourceIds: [doc.id!] });
    });
    let session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) })); await f.flush();
    session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.finishFollowup(data, session.id, { version: session.version }));
    const run = (await f.service.claimRun())!; const output = scripted(run.task);
    if (output.kind !== 'quiz') throw new Error('expected quiz');
    output.questions[0]!.sourceIds = [doc.id!];
    await expect(f.service.finishRun(run.id, run.attemptId!, { output, usage: null })).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    expect((await f.repository.read()).sessions[sessionId]!.quizId).toBeNull();
  });
  it('resolves only review point originals plus fallback, freezes versions, and skips preparation on retry', async () => {
    const f = fixture(); const { quizId, draftId, sessionId } = await quizReady(f); await answerAndSubmit(f, quizId);
    const original = await f.command(data => f.service.addDocument(data, { recitationId: draftId, name: 'original.md', text: 'REVIEW_ORIGINAL_TEXT' }));
    await f.command(data => f.service.addDocument(data, { recitationId: draftId, name: 'unrelated.md', text: 'UNRELATED_LIBRARY_SECRET' }));
    let state = await f.repository.read(); const card = Object.values(state.cards)[0]!; const point = state.knowledge[card.knowledgeId]!;
    await f.repository.transact(data => {
      data.knowledge[point.id]!.sourceIds = [original.id!, `recitation:${sessionId}`, `recitation:${draftId}`, 'missing-source'];
      data.recitations[draftId]!.learned = 'CHANGED_DRAFT_NOT_SNAPSHOT';
    });
    const prepare = vi.fn((task: AiTask) => structuredClone(task));
    const service = new LearningService(f.repository, f.service.config, f.service.now, prepare);
    const started = await f.command(data => service.startReview(data, card.id));
    const submitted = await f.command(data => service.reviewRecall(data, started.reviewSessionId!, { version: 1, text: 'my recall', action: 'submitted' }));
    state = await f.repository.read(); const frozen = state.runs[submitted.runId!]!.task;
    if (frozen.kind !== 'quiz') throw new Error('expected quiz');
    expect(frozen.sources.map(source => source.id)).toEqual([`knowledge:${point.id}:v1`, original.id, `recitation:${sessionId}`]);
    expect(frozen.sources[0]!.text).toBe(point.description);
    expect(frozen.sources[1]!.text).toBe('REVIEW_ORIGINAL_TEXT');
    expect(frozen.sources[2]!.text).toContain('Redis');
    expect(frozen.points[0]!.sourceIds).toEqual(frozen.sources.map(source => source.id));
    expect(JSON.stringify(frozen)).not.toMatch(/UNRELATED_LIBRARY_SECRET|CHANGED_DRAFT_NOT_SNAPSHOT|missing-source/);
    expect(prepare).toHaveBeenCalledTimes(1);
    const run = (await service.claimRun())!; await service.failRun(run.id, run.attemptId!);
    await f.repository.transact(data => { data.knowledge[point.id]!.description = 'later version'; data.knowledge[point.id]!.contentVersion = 9; });
    const retried = await f.command(data => service.retryRun(data, run.id));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await f.repository.read()).runs[retried.runId!]!.task).toEqual(frozen);
    const retry = (await service.claimRun())!; await service.finishRun(retry.id, retry.attemptId!, { output: scripted(retry.task), usage: null });
    state = await f.repository.read();
    expect(state.quizzes[state.reviewSessions[started.reviewSessionId!]!.quizId!]!.questions.every(question => question.knowledgeVersion === 1)).toBe(true);
  });
  it('adds only eligible historical weak dimensions to review quiz context', async () => {
    const f = fixture(); const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    await f.repository.transact(data => {
      const evidence = Object.values(data.evidence).find(item => item.quizId === quizId)!;
      evidence.answer.assessment.score = 0;
      evidence.answer.assessment.scores = [{ rubricId: 'r1', description: '失效策略', maxScore: 2, score: 0, evidence: '没有说明 TTL 的影响' }];
    });
    const state = await f.repository.read(); const card = Object.values(state.cards)[0]!;
    const started = await f.command(data => f.service.startReview(data, card.id));
    const submitted = await f.command(data => f.service.reviewRecall(data, started.reviewSessionId!, { version: 1, text: '先找回空值缓存的含义', action: 'submitted' }));
    const task = (await f.repository.read()).runs[submitted.runId!]!.task;
    if (task.kind !== 'quiz') throw new Error('expected quiz');
    expect(task.weaknesses).toHaveLength(1);
    expect(task.weaknesses![0]!.dimension).toBe('immediate');
    expect(task.weaknesses![0]!.weakAreas.join(' ')).toContain('没有说明 TTL 的影响');
    expect(JSON.stringify(task.weaknesses)).not.toContain('selectedIndex');
  });
  it('caps resolved review originals at documentsMaximum while keeping the description fallback', async () => {
    const f = fixture({ maxDocuments: LIMITS.documentsMaximum }); const { quizId, draftId, sessionId } = await quizReady(f); await answerAndSubmit(f, quizId);
    const ids: string[] = [];
    for (let index = 0; index < LIMITS.documentsMaximum; index++) ids.push((await f.command(data => f.service.addDocument(data, { recitationId: draftId, name: `${index}.md`, text: `original ${index}` }))).id!);
    const card = Object.values((await f.repository.read()).cards)[0]!;
    await f.repository.transact(data => { data.knowledge[card.knowledgeId]!.sourceIds = [`recitation:${sessionId}`, ...ids, ids[0]!, 'missing']; });
    const start = await f.command(data => f.service.startReview(data, card.id));
    const result = await f.command(data => f.service.reviewRecall(data, start.reviewSessionId!, { version: 1, text: 'recall', action: 'submitted' }));
    const task = (await f.repository.read()).runs[result.runId!]!.task;
    if (task.kind !== 'quiz') throw new Error('expected quiz');
    expect(task.sources).toHaveLength(LIMITS.documentsMaximum + 1);
    expect(task.sources.length).toBeLessThanOrEqual(LIMITS.modelSourcesMaximum);
    expect(task.sources[0]!.id).toBe(`knowledge:${card.knowledgeId}:v1`);
    expect(new Set(task.points[0]!.sourceIds).size).toBe(task.sources.length);
  });
  it('uses mode-local preference defaults/CAS, rejects active tasks, and does not backfill cards on enable', async () => {
    const f = fixture({ schedulingEnabled: false }); const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    let state = await f.repository.read(); const point = Object.values(state.knowledge)[0]!;
    expect(effectiveLearningPreferences(state, f.service.config)).toEqual({ schedulingEnabled: false, promptCacheRetention: 'none', associationEnabled: false, codeExercisesEnabled: false, codeLanguages: ['python'], reviewOrder: 'due', reviewBatchSize: null });
    await expect(f.command(data => f.service.addReviewCard(data, point.id, { version: point.version, confirm: true }))).rejects.toMatchObject({ code: 'SCHEDULING_NOT_ENABLED' });
    const preferences = { expectedRevision: state.revision, schedulingEnabled: true, promptCacheRetention: 'short', confirm: true };
    await expect(f.command(data => f.service.saveLearningPreferences(data, { ...preferences, expectedRevision: state.revision - 1 }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(f.command(data => f.service.saveLearningPreferences(data, { ...preferences, confirm: false }))).rejects.toThrow();
    expect(await f.command(data => f.service.saveLearningPreferences(data, preferences))).toEqual({ version: state.revision + 1 });
    state = await f.repository.read();
    expect(state.cards).toEqual({}); expect(state.reviewEvents).toEqual({});
    expect(state.mode).toBe('mock'); expect(f.service.config.schedulingEnabled).toBe(false);
    expect(effectiveLearningPreferences(state, f.service.config)).toEqual({ schedulingEnabled: true, promptCacheRetention: 'short', associationEnabled: false, codeExercisesEnabled: false, codeLanguages: ['python'], reviewOrder: 'due', reviewBatchSize: null });
    expect(projectState(state, f.service.config, 'csrf').capabilities.schedulingEnabled).toBe(true);
    const runCount = Object.keys(state.runs).length;
    await expect(f.command(data => f.service.addReviewCard(data, point.id, { version: point.version + 1, confirm: true }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const card = await f.command(data => f.service.addReviewCard(data, point.id, { version: point.version, confirm: true }));
    expect(await f.command(data => f.service.addReviewCard(data, point.id, { version: point.version, confirm: true }))).toEqual(card);
    state = await f.repository.read();
    expect(Object.values(state.cards)).toHaveLength(1); expect(state.cards[card.id!]!.schedule).toEqual(newSchedule(f.service.now()));
    expect(state.knowledge[point.id]).toEqual(point); expect(Object.keys(state.runs)).toHaveLength(runCount); expect(state.reviewEvents).toEqual({});
    f.advance(); const next = await prepared(f); const session = (await f.repository.read()).sessions[next.sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) }));
    for (const claimed of [false, true]) {
      if (claimed) await f.service.claimRun();
      state = await f.repository.read();
      await expect(f.command(data => f.service.saveLearningPreferences(data, { ...preferences, expectedRevision: state.revision, schedulingEnabled: false }))).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
      expect((await f.repository.read()).learningPreferences).toEqual(state.learningPreferences);
    }
  });
  it.each([false, true])('uses saved scheduling=%s rather than the opposite environment default when finalizing quizzes', async schedulingEnabled => {
    const f = fixture({ schedulingEnabled: !schedulingEnabled });
    await f.command(data => f.service.saveLearningPreferences(data, { expectedRevision: data.revision, schedulingEnabled, promptCacheRetention: 'none', confirm: true }));
    const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    const state = await f.repository.read();
    expect(Object.values(state.cards)).toHaveLength(schedulingEnabled ? 1 : 0);
    expect(state.reviewEvents).toEqual({}); expect(Object.values(state.evidence)).toHaveLength(1);
    expect(projectState(state, f.service.config, 'csrf').capabilities.schedulingEnabled).toBe(schedulingEnabled);
  });
  it('allows a graded review to complete after disabling schedules, without events or card mutation', async () => {
    const f = fixture(); const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    const card = Object.values((await f.repository.read()).cards)[0]!;
    const started = await f.command(data => f.service.startReview(data, card.id));
    await f.command(data => f.service.reviewRecall(data, started.reviewSessionId!, { version: 1, text: 'recall', action: 'submitted' })); await f.flush();
    let state = await f.repository.read(); const reviewQuizId = state.reviewSessions[started.reviewSessionId!]!.quizId!;
    await answerAndSubmit(f, reviewQuizId); state = await f.repository.read();
    await f.command(data => f.service.saveLearningPreferences(data, { expectedRevision: state.revision, schedulingEnabled: false, promptCacheRetention: 'none', confirm: true }));
    const review = state.reviewSessions[started.reviewSessionId!]!;
    await f.command(data => f.service.completeReview(data, review.id, { version: review.version, expectedCardVersion: card.version, rating: 4 }));
    state = await f.repository.read();
    expect(state.reviewSessions[review.id]!.status).toBe('COMPLETED');
    expect(state.cards[card.id]).toEqual(card); expect(state.reviewEvents).toEqual({});
    expect(state.quizzes[reviewQuizId]!.submittedAt).not.toBeNull();
    expect(Object.values(state.evidence).filter(evidence => evidence.quizId === reviewQuizId)).toHaveLength(1);
    f.advance(); const next = await quizReady(f); await answerAndSubmit(f, next.quizId);
    expect(Object.values((await f.repository.read()).cards)).toHaveLength(1);
  });
  it('counts the complete followup history even when preparation sends only the last two turns', async () => {
    const f = fixture({ maxFollowups: 5 }); const { sessionId } = await prepared(f);
    const service = new LearningService(f.repository, f.service.config, f.service.now, task => task.kind === 'followup' ? { ...task, turns: task.turns.slice(-2) } : task);
    let session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => service.confirm(data, session.id, { version: session.version, decisions: session.candidates.map(c => ({ candidateId: c.id, decision: 'accepted' })) })); await f.flush();
    for (let index = 0; index < 5; index++) {
      session = (await f.repository.read()).sessions[sessionId]!;
      const queued = await f.command(data => service.followupAnswer(data, sessionId, { version: session.version, text: `answer ${index}` }));
      const task = (await f.repository.read()).runs[queued.runId!]!.task;
      expect(task.kind === 'followup' && task.turns.length).toBeLessThanOrEqual(2); await f.flush();
    }
    session = (await f.repository.read()).sessions[sessionId]!;
    expect(session.turns).toHaveLength(5); expect(session.turns.every(turn => turn.answer !== null)).toBe(true);
    await expect(f.command(data => service.followupAnswer(data, sessionId, { version: session.version, text: 'extra' }))).rejects.toMatchObject({ code: 'NO_ACTIVE_QUESTION' });
  });
});

describe('review report regressions', () => {
  it('separates CAS notes from content history and freezes old quiz/evidence versions across days', async () => {
    const f = fixture(); const first = await quizReady(f);
    let state = await f.repository.read(); const point = Object.values(state.knowledge)[0]!;
    const original = structuredClone(point.contentHistory![0]!);
    expect(point).toMatchObject({ version: 1, contentVersion: 1 });
    expect(state.sessions[first.sessionId]!.candidates[0]!.knowledgeVersion).toBe(1);
    expect(state.quizzes[first.quizId]!.questions.every(q => q.knowledgeVersion === 1)).toBe(true);
    await f.command(data => f.service.saveUnderstanding(data, point.id, { version: 1, text: '仅更新理解笔记' }));
    expect((await f.repository.read()).knowledge[point.id]).toMatchObject({ version: 2, contentVersion: 1, contentHistory: [original] });
    f.advance(); const second = await prepared(f);
    const session = (await f.repository.read()).sessions[second.sessionId]!;
    const confirmed = await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted', description: '第二天修正的解释', existingKnowledgeId: point.id }] }));
    state = await f.repository.read();
    expect(state.knowledge[point.id]).toMatchObject({ version: 3, contentVersion: 2, description: '第二天修正的解释' });
    expect(state.knowledge[point.id]!.contentHistory).toHaveLength(2);
    expect(state.knowledge[point.id]!.contentHistory![0]).toEqual(original);
    const follow = state.runs[confirmed.runId!]!.task;
    expect(follow.kind === 'followup' && follow.points[0]!.knowledgeVersion).toBe(2);
    const quiz = state.quizzes[first.quizId]!;
    await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'answer', selectedIndex: 0 }));
    state = await f.repository.read();
    expect(Object.values(state.evidence)[0]).toMatchObject({ knowledgeId: point.id, knowledgeVersion: 1 });
    expect(state.quizzes[first.quizId]!.questions[0]!.knowledgeVersion).toBe(1);
    expect(state.sessions[first.sessionId]!.candidates[0]!.description).toBe(original.description);
  });
  it('versions source-only content changes but not an identical reconfirmation', async () => {
    const f = fixture(); const { sessionId } = await prepared(f);
    let session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted' }] })); await f.flush();
    session = (await f.repository.read()).sessions[sessionId]!;
    const pointId = session.candidates[0]!.knowledgeId!;
    await f.command(data => f.service.changeScope(data, session.id, { version: session.version, documentIds: [] })); await f.flush();
    session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted' }] })); await f.flush();
    expect((await f.repository.read()).knowledge[pointId]).toMatchObject({ version: 1, contentVersion: 1 });
    f.advance(); const next = await prepared(f); session = (await f.repository.read()).sessions[next.sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted' }] }));
    const point = (await f.repository.read()).knowledge[pointId]!;
    expect(point.contentVersion).toBe(2); expect(point.contentHistory).toHaveLength(2);
    expect(point.contentHistory![0]!.description).toBe(point.contentHistory![1]!.description);
    expect(point.contentHistory![1]!.sourceIds).toHaveLength(2);
  });
  it('creates only a current legacy baseline and never invents versions for legacy questions or evidence', async () => {
    const f = fixture(); const { quizId } = await quizReady(f);
    let state = await f.repository.read(); const point = Object.values(state.knowledge)[0]!;
    await f.repository.transact(data => {
      delete data.knowledge[point.id]!.contentVersion; delete data.knowledge[point.id]!.contentHistory;
      data.knowledge[point.id]!.version = 8;
      for (const q of data.quizzes[quizId]!.questions) delete q.knowledgeVersion;
    });
    f.advance();
    await f.command(data => f.service.saveUnderstanding(data, point.id, { version: 8, text: '旧点理解' }));
    state = await f.repository.read();
    expect(state.knowledge[point.id]).toMatchObject({ version: 9, contentVersion: 1 });
    expect(state.knowledge[point.id]!.contentHistory).toEqual([{ version: 1, title: point.title, description: point.description, sourceIds: point.sourceIds, createdAt: f.service.now().toISOString() }]);
    const quiz = state.quizzes[quizId]!;
    await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'answer', selectedIndex: 0 }));
    expect(Object.values((await f.repository.read()).evidence)[0]!.knowledgeVersion).toBeNull();
  });
  it('binds question versions to the queued host scope, ignoring model-supplied versions', async () => {
    const f = fixture(); const { sessionId } = await prepared(f);
    let session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.confirm(data, session.id, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted' }] })); await f.flush();
    session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.finishFollowup(data, session.id, { version: session.version }));
    const run = (await f.service.claimRun())!; const output = scripted(run.task);
    if (output.kind !== 'quiz') throw new Error('expected quiz');
    Object.assign(output.questions[0]!, { knowledgeVersion: 999 });
    await f.repository.transact(data => { data.knowledge[session.candidates[0]!.knowledgeId!]!.contentVersion = 7; });
    await f.service.finishRun(run.id, run.attemptId!, { output, usage: null });
    const state = await f.repository.read();
    expect(Object.values(state.quizzes)[0]!.questions[0]!.knowledgeVersion).toBe(1);
  });
  it.each(['no_quiz', 'user_ended'])('preserves the requested %s reason when no quiz exists', async reason => {
    const f = fixture(); const { sessionId } = await prepared(f); const session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.endSession(data, session.id, { version: session.version, reason }));
    expect((await f.repository.read()).sessions[sessionId]!.completionReason).toBe(reason);
  });
  it('preserves assessed completion, cancelling grading and skipping unanswered questions on end', async () => {
    const f = fixture(); const { quizId, sessionId } = await quizReady(f);
    let state = await f.repository.read(); let quiz = state.quizzes[quizId]!;
    await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'skip' }));
    quiz = (await f.repository.read()).quizzes[quizId]!;
    const grading = await f.command(data => f.service.answerQuestion(data, quiz.questions[1]!.id, { version: quiz.version, action: 'answer', text: '正式答案' }));
    state = await f.repository.read(); const session = state.sessions[sessionId]!;
    await f.command(data => f.service.endSession(data, sessionId, { version: session.version, reason: 'user_ended' }));
    state = await f.repository.read();
    expect(state.sessions[sessionId]).toMatchObject({ status: 'COMPLETED', completionReason: 'assessed', version: session.version + 1 });
    expect(state.runs[grading.runId!]!.status).toBe('cancelled');
    expect(state.quizzes[quizId]!.answers[quiz.questions[1]!.id]!.assessment.status).toBe('needs_verification');
    expect(state.quizzes[quizId]!.answers[quiz.questions[2]!.id]!.skipped).toBe(true);
  });
  it('requires submitted recall but permits blank drafts, sends original recall and captures current content', async () => {
    const f = fixture(); const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    let state = await f.repository.read(); const card = Object.values(state.cards)[0]!;
    const start = await f.command(data => f.service.startReview(data, card.id));
    let review = (await f.repository.read()).reviewSessions[start.reviewSessionId!]!;
    await f.command(data => f.service.reviewRecall(data, review.id, { version: review.version, text: '', action: 'draft' }));
    review = (await f.repository.read()).reviewSessions[review.id]!;
    await expect(f.command(data => f.service.reviewRecall(data, review.id, { version: review.version, text: ' \n\t ', action: 'submitted' }))).rejects.toMatchObject({ code: 'EMPTY_RECALL' });
    expect((await f.repository.read()).reviewSessions[review.id]).toEqual(review);
    const recall = '  用户未经修饰的原始回忆  ';
    const submitted = await f.command(data => f.service.reviewRecall(data, review.id, { version: review.version, text: recall, action: 'submitted' }));
    state = await f.repository.read(); const task = state.runs[submitted.runId!]!.task;
    expect(task).toMatchObject({ kind: 'quiz', recall, points: [{ knowledgeVersion: state.knowledge[card.knowledgeId]!.contentVersion }] });
    expect(state.reviewSessions[review.id]!.recall).toBe(recall);
    await f.flush(); state = await f.repository.read(); review = state.reviewSessions[review.id]!;
    const quiz = state.quizzes[review.quizId!]!;
    await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'skip' }));
    expect((await f.repository.read()).reviewSessions[review.id]).toMatchObject({ status: 'QUIZZING', version: review.version + 1 });
  });
  it('increments the learning owner version exactly on the QUIZ_READY transition', async () => {
    const f = fixture(); const { quizId, sessionId } = await quizReady(f);
    const state = await f.repository.read(); const quiz = state.quizzes[quizId]!; const session = state.sessions[sessionId]!;
    await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'skip' }));
    expect((await f.repository.read()).sessions[sessionId]).toMatchObject({ status: 'QUIZZING', version: session.version + 1 });
    await expect(f.command(data => f.service.endSession(data, sessionId, { version: session.version, reason: 'user_ended' }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const next = (await f.repository.read()).quizzes[quizId]!;
    await f.command(data => f.service.answerQuestion(data, next.questions[1]!.id, { version: next.version, action: 'skip' }));
    expect((await f.repository.read()).sessions[sessionId]!.version).toBe(session.version + 1);
  });
  it('filters current sources by confirmed references and refuses to re-add documents removed from the draft', async () => {
    const f = fixture(); const { draftId, sessionId } = await prepared(f);
    const doc = await f.command(data => f.service.addDocument(data, { recitationId: draftId, name: 'removed.md', text: 'REMOVED_SOURCE_SENTINEL' }));
    let session = (await f.repository.read()).sessions[sessionId]!;
    await f.command(data => f.service.changeScope(data, sessionId, { version: session.version, documentIds: [doc.id!] })); await f.flush();
    session = (await f.repository.read()).sessions[sessionId]!;
    const confirmed = await f.command(data => f.service.confirm(data, sessionId, { version: session.version, decisions: [{ candidateId: session.candidates[0]!.id, decision: 'accepted' }] }));
    const follow = (await f.repository.read()).runs[confirmed.runId!]!.task;
    expect(follow.kind === 'followup' && follow.sources.map(source => source.id)).toEqual([`recitation:${sessionId}`]);
    expect(JSON.stringify(follow)).not.toContain('REMOVED_SOURCE_SENTINEL'); await f.flush();
    let state = await f.repository.read();
    await f.command(data => f.service.removeDocument(data, draftId, doc.id!, { version: state.recitations[draftId]!.version }));
    session = (await f.repository.read()).sessions[sessionId]!;
    await expect(f.command(data => f.service.changeScope(data, sessionId, { version: session.version, documentIds: [doc.id!] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const changed = await f.command(data => f.service.changeScope(data, sessionId, { version: session.version, documentIds: [] }));
    state = await f.repository.read();
    expect(JSON.stringify(state.runs[changed.runId!]!.task)).not.toContain('REMOVED_SOURCE_SENTINEL');
    expect(state.documents[doc.id!]!.text).toBe('REMOVED_SOURCE_SENTINEL');
  });
  it('keeps full uploaded and legacy recitation text while queueing only bounded copies', async () => {
    const f = fixture({ maxUploadBytes: LIMITS.uploadBytesMaximum, maxDocuments: LIMITS.documentsMaximum });
    const created = await f.command(data => f.service.createRecitation(data, {}));
    const large = 'x'.repeat(LIMITS.uploadBytesMaximum);
    await f.command(data => f.service.addDocument(data, { recitationId: created.id, name: 'large.md', text: large }));
    await f.repository.transact(data => { data.recitations[created.id!]!.learned = '旧备份'.repeat(20_000); });
    let before = (await f.repository.read()).recitations[created.id!]!;
    await f.command(data => f.service.saveDraft(data, created.id!, before));
    expect((await f.repository.read()).recitations[created.id!]).toEqual(before);
    await f.command(data => f.service.saveDraft(data, created.id!, { ...before, topic: '保留旧原文' }));
    before = (await f.repository.read()).recitations[created.id!]!;
    await expect(f.command(data => f.service.saveDraft(data, created.id!, { ...before, learned: before.learned + '新增' }))).rejects.toThrow();
    const submitted = await f.command(data => f.service.submitRecitation(data, created.id!, { version: before.version }));
    const state = await f.repository.read();
    expect(state.runs[submitted.runId!]!.status).toBe('pending');
    expect(JSON.stringify(state.runs[submitted.runId!]!.task).length).toBeLessThanOrEqual(LIMITS.modelInputChars);
    expect(state.sessions[submitted.sessionId!]!.snapshot.learned).toBe(before.learned);
    expect(state.recitations[created.id!]).toEqual(before);
    expect(Object.values(state.documents)[0]!.text).toBe(large);
  });
  it('rejects an oversized grade before answer submission or new task/reservation, leaving drafts intact', async () => {
    const f = fixture(); const { quizId } = await quizReady(f);
    let quiz = (await f.repository.read()).quizzes[quizId]!;
    await f.command(data => f.service.answerQuestion(data, quiz.questions[0]!.id, { version: quiz.version, action: 'skip' }));
    quiz = (await f.repository.read()).quizzes[quizId]!; const id = quiz.questions[1]!.id;
    const text = '\u0001'.repeat(LIMITS.answerChars);
    await f.command(data => f.service.saveAnswerDraft(data, id, { version: quiz.version, text }));
    const before = await f.repository.read(); quiz = before.quizzes[quizId]!;
    await expect(f.command(data => f.service.answerQuestion(data, id, { version: quiz.version, action: 'answer', text }))).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE', status: 413 });
    expect(await f.repository.read()).toEqual(before);
  });
  it('does not mutate an unchanged draft, even timestamps, and still checks CAS', async () => {
    const f = fixture(); const { draftId } = await prepared(f); const before = await f.repository.read(); const draft = before.recitations[draftId]!;
    f.advance();
    const result = f.service.saveDraft(before, draftId, draft);
    expect(result).toEqual({ id: draftId, version: draft.version });
    expect(before).toEqual(await f.repository.read());
    expect(() => f.service.saveDraft(before, draftId, { ...draft, version: draft.version - 1 })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  });
  it('expires only safe autosave receipts; charged and unknown-operation receipts remain replayable', async () => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: null });
    const created = await f.command(data => f.service.createRecitation(data, {}));
    const operation = `PUT:/api/recitations/${created.id!}/draft`;
    const body = { version: 1, learned: '初始内容', unclear: '', application: '', topic: '' };
    await f.service.command(operation, 'expiring-draft-key', body, data => f.service.saveDraft(data, created.id!, body));
    const paid = await f.service.command('POST:/api/providers/test', 'durable-paid-key', {}, data => f.service.connectionTest(data, selection)); await f.flush();
    await f.repository.transact(data => {
      data.receipts[`${operation}:durable-run-key`] = { hash: fingerprint({}), result: { runId: paid.runId }, createdAt: f.service.now().toISOString() };
    });
    f.advance(LIMITS.transientReceiptTtlMs + 1);
    await f.command(data => f.service.createRecitation(data, {}));
    const state = await f.repository.read();
    expect(state.receipts[`${operation}:expiring-draft-key`]).toBeUndefined();
    expect(state.receipts[`${operation}:durable-run-key`]).toBeDefined();
    expect(state.receipts['test:key-test-1']).toBeDefined();
    await expect(f.service.command(operation, 'expiring-draft-key', body, data => f.service.saveDraft(data, created.id!, body))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const replay = await f.service.command('POST:/api/providers/test', 'durable-paid-key', {}, () => { throw new Error('must not run twice'); });
    expect(replay).toEqual(paid);
  });
  it('caps only safe receipts by deterministic age and keeps replay/conflict semantics for retained keys', async () => {
    const f = fixture(); const operation = 'PUT:/api/knowledge-points/point/understanding';
    await f.repository.transact(data => {
      for (let index = 0; index < LIMITS.transientReceiptMaximum + 10; index++) {
        data.receipts[`${operation}:receipt-${String(index).padStart(5, '0')}`] = { hash: fingerprint({ index }), result: { id: 'point', version: index + 1 }, createdAt: f.service.now().toISOString() };
      }
    });
    await f.command(data => f.service.createRecitation(data, {}));
    const state = await f.repository.read(); const retained = Object.keys(state.receipts).filter(id => id.startsWith(operation));
    expect(retained).toHaveLength(LIMITS.transientReceiptMaximum);
    expect(state.receipts[`${operation}:receipt-00000`]).toBeUndefined();
    const index = LIMITS.transientReceiptMaximum + 9; const key = `receipt-${String(index).padStart(5, '0')}`;
    expect(await f.service.command(operation, key, { index }, () => { throw new Error('must replay'); })).toEqual({ id: 'point', version: index + 1 });
    await expect(f.service.command(operation, key, { index: -1 }, () => ({}))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('projects document metadata and length without eagerly exposing archived text', async () => {
    const f = fixture(); const draft = await f.command(data => f.service.createRecitation(data, {}));
    const text = 'LARGE_DOCUMENT_SENTINEL\n完整正文';
    const saved = await f.command(data => f.service.addDocument(data, { recitationId: draft.id, name: 'source.md', text }));
    const state = await f.service.state('csrf');
    expect(state.documents).toEqual([{ id: saved.id, recitationId: draft.id, name: 'source.md', textLength: text.length, lineCount: 2, createdAt: f.service.now().toISOString() }]);
    expect(JSON.stringify(state)).not.toContain('LARGE_DOCUMENT_SENTINEL');
    expect((await f.repository.read()).documents[saved.id!]!.text).toBe(text);
  });
  it('fingerprints object keys without consulting localeCompare', () => {
    const spy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('locale-dependent ordering'); });
    try { expect(fingerprint({ z: 1, ä: { b: 2, a: 3 }, a: 4 })).toBe(fingerprint({ a: 4, ä: { a: 3, b: 2 }, z: 1 })); }
    finally { spy.mockRestore(); }
  });
  it.each([false, true])('accepts unknown response usage and preserves reservation/observed usage (%s)', async observed => {
    const f = fixture({ mode: 'live', dailyBudgetUsd: 1 });
    const result = await f.command(data => f.service.connectionTest(data, selection));
    const run = (await f.service.claimRun())!;
    if (observed) await f.service.recordUsage(run.id, run.attempt, probeUsage);
    await f.service.finishRun(run.id, run.attemptId!, { output: scripted(run.task), usage: null });
    expect((await f.repository.read()).runs[result.runId!]).toMatchObject({ status: 'succeeded', usage: observed ? probeUsage : null, reservationUsd: 0.1 });
  });
});

describe('代码题领域链路', () => {
  const execution = { status: 'passed' as const, passed: 1, total: 1, output: '浏览器证据', durationMs: 10, ranAt: '2026-10-10T00:00:00.000Z' };
  async function ready() {
    const f = fixture();
    await f.command(data => f.service.saveLearningPreferences(data, { expectedRevision: data.revision, schedulingEnabled: true, promptCacheRetention: 'none', codeExercisesEnabled: true, codeLanguages: ['typescript'], confirm: true }));
    const { quizId } = await quizReady(f);
    await f.repository.transact(data => {
      const quiz = data.quizzes[quizId]!; const old = quiz.questions[0]!;
      quiz.questions[0] = { ...old, kind: 'code', options: [], correctIndex: null, code: { language: 'typescript', starter: 'const value: number = 0;', tests: [{ name: '值', code: 'assertEqual(value, 2);' }] } };
    });
    const state = await f.repository.read(); const quiz = state.quizzes[quizId]!;
    return { ...f, quizId, quiz, question: quiz.questions[0]! };
  }
  it('偏好进入 quiz、预览与 grade 带证据，代码初始分数为 null，草稿清空可区分', async () => {
    const f = await ready(); let state = await f.repository.read();
    expect(Object.values(state.runs).find(run => run.task.kind === 'quiz')!.task).toMatchObject({ code: { languages: ['typescript'] } });
    expect(projectState(state, config, 'csrf').quizzes[0]!.questions[0]).toMatchObject({ hasDraft: false, code: f.question.code });
    await f.command(data => f.service.saveAnswerDraft(data, f.question.id, { version: f.quiz.version, text: '' }));
    state = await f.repository.read();
    expect(projectState(state, config, 'csrf').quizzes[0]!.questions[0]).toMatchObject({ hasDraft: true, draft: '' });
    expect(f.service.previewAnswerTask(state, f.question.id, { text: 'const value = 2;', execution })).toMatchObject({ kind: 'grade', execution });
    const result = await f.command(data => f.service.answerQuestion(data, f.question.id, { version: data.quizzes[f.quizId]!.version, action: 'answer', codeProtocol: 1, text: 'const value = 2;', execution }));
    state = await f.repository.read();
    expect(state.runs[result.runId!]!.task).toMatchObject({ kind: 'grade', answer: 'const value = 2;', execution });
    expect(state.quizzes[f.quizId]!.answers[f.question.id]).toMatchObject({ execution, assessment: { score: null, status: 'pending' } });
    await f.flush();
    expect((await f.repository.read()).quizzes[f.quizId]!.answers[f.question.id]!.assessment).toMatchObject({ score: null, status: 'needs_verification' });
  });
  it('拒绝旧客户端、测试数量不匹配、非代码题运行证据，均不保存答案', async () => {
    const f = await ready();
    await expect(f.command(data => f.service.answerQuestion(data, f.question.id, { version: f.quiz.version, action: 'answer', text: 'const value = 2;' }))).rejects.toMatchObject({ code: 'CLIENT_UPDATE_REQUIRED' });
    const bad = { ...execution, total: 2, passed: 2 };
    expect(() => f.service.previewAnswerTask(f.repository.data, f.question.id, { text: '代码', execution: bad })).toThrow('测试数量');
    await expect(f.command(data => f.service.answerQuestion(data, f.question.id, { version: f.quiz.version, action: 'answer', codeProtocol: 1, text: '代码', execution: bad }))).rejects.toMatchObject({ code: 'INVALID_ANSWER' });
    expect((await f.repository.read()).quizzes[f.quizId]!.answers).toEqual({});
    await f.command(data => f.service.answerQuestion(data, f.question.id, { version: f.quiz.version, action: 'skip', codeProtocol: 1 }));
    const state = await f.repository.read(); const quiz = state.quizzes[f.quizId]!; const short = quiz.questions[1]!;
    expect(() => f.service.previewAnswerTask(state, short.id, { text: '回答', execution })).toThrow('只有代码题');
    await expect(f.command(data => f.service.answerQuestion(data, short.id, { version: quiz.version, action: 'answer', text: '回答', execution }))).rejects.toMatchObject({ code: 'INVALID_ANSWER' });
  });
  it('评分只准备一次并入队已准备结果，正式答案仍保留原文', async () => {
    const f = await ready();
    const prepare = vi.fn((task: AiTask): AiTask => task.kind === 'grade' ? { ...task, answer: `prepared:${task.answer}` } : task);
    const service = new LearningService(f.repository, f.service.config, f.service.now, prepare);
    const result = await f.command(data => service.answerQuestion(data, f.question.id, { version: f.quiz.version, action: 'answer', codeProtocol: 1, text: '代码', execution }));
    const state = await f.repository.read();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(state.runs[result.runId!]!).toMatchObject({ inputPrepared: true, task: { kind: 'grade', answer: 'prepared:代码', execution } });
    expect(state.quizzes[f.quizId]!.answers[f.question.id]!.text).toBe('代码');
  });
  it('多项输入同时无效时保留原有错误优先级且不保存答案', async () => {
    const f = await ready();
    for (const [patch, code, message] of [
      [{ action: 'skip', selectedIndex: 0, execution }, 'INVALID_ANSWER', '跳过题目不能携带运行结果'],
      [{ text: '', execution: { ...execution, total: 2, passed: 2 } }, 'EMPTY_ANSWER', '请填写答案或明确跳过'],
      [{ selectedIndex: 0, execution: { ...execution, total: 2, passed: 2 } }, 'INVALID_ANSWER', '简答题与代码题不能携带单选答案'],
    ] as const) {
      await expect(f.command(data => f.service.answerQuestion(data, f.question.id, Object.assign({ version: f.quiz.version, action: 'answer', codeProtocol: 1, text: '代码' }, patch)))).rejects.toMatchObject({ code, message });
    }
    expect((await f.repository.read()).quizzes[f.quizId]!.answers).toEqual({});
  });
  it('旧偏好请求保留设置，语言非空且按固定顺序去重', async () => {
    const f = fixture();
    const save = (patch: object) => f.command(data => f.service.saveLearningPreferences(data, { expectedRevision: data.revision, schedulingEnabled: false, promptCacheRetention: 'none', confirm: true, ...patch }));
    await save({ codeExercisesEnabled: true, codeLanguages: ['typescript', 'javascript', 'typescript'] });
    await save({ associationEnabled: true });
    expect((await f.repository.read()).learningPreferences).toMatchObject({ codeExercisesEnabled: true, codeLanguages: ['javascript', 'typescript'], associationEnabled: true });
    await expect(save({ codeLanguages: [] })).rejects.toThrow();
  });
});

describe('review card participation', () => {
  it('pauses and restores with CAS without rewriting a schedule or historical events', async () => {
    const f = fixture(); const { quizId } = await quizReady(f); await answerAndSubmit(f, quizId);
    const before = await f.repository.read(); const card = Object.values(before.cards)[0]!;
    await f.command(data => f.service.pauseReviewCard(data, card.id, { version: card.version, paused: true }));
    expect((await f.repository.read()).cards[card.id]!.schedule).toEqual(card.schedule);
    await expect(f.command(data => f.service.startReview(data, card.id))).rejects.toMatchObject({ code: 'CARD_PAUSED' });
    await expect(f.command(data => f.service.pauseReviewCard(data, card.id, { version: card.version, paused: false }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await f.command(data => f.service.pauseReviewCard(data, card.id, { version: card.version + 1, paused: false }));
    const review = await f.command(data => f.service.startReview(data, card.id));
    expect((await f.command(data => f.service.startReview(data, card.id))).reviewSessionId).toBe(review.reviewSessionId);
    await expect(f.command(data => f.service.pauseReviewCard(data, card.id, { version: card.version + 2, paused: true }))).rejects.toMatchObject({ code: 'REVIEW_IN_PROGRESS' });
    const after = await f.repository.read(); expect(after.cards[card.id]!.schedule).toEqual(card.schedule); expect(after.reviewEvents).toEqual(before.reviewEvents);
  });
});
