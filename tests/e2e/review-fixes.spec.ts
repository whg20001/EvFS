import { learningStatistics } from '../../packages/learning-domain/src/statistics.ts';
import { emptyData } from '@sanxing/database';
import { expect, test, type Page } from './test.ts';
import { LIMITS, type TaskInputPreview, type Answer, type PublicState } from '@sanxing/contracts';

// All application API requests are intercepted. No login, personal library, credentials,
// model connection, or paid provider is used by these independent browser fixtures.
function fixture(): PublicState {
  const now = new Date().toISOString();
  const answer: Answer = { text: '当时的独立作答', selectedIndex: null, assisted: false, skipped: false, submittedAt: now,
    assessment: { status: 'graded', score: 1, maxScore: 1, feedback: '离线测试反馈', assessedAt: now, version: 1 } };
  return {
    mode: 'mock', timezone: 'UTC', revision: 1, csrfToken: 'offline-fixture-csrf',
    capabilities: { maxUploadBytes: LIMITS.uploadBytes, maxDocuments: LIMITS.documents, maxFollowups: LIMITS.followups, quizCount: LIMITS.quizQuestions, schedulingEnabled: false },
    recitations: [{ id: 'recitation-fixture', learningDate: now.slice(0, 10), learned: '独立回忆', unclear: '', application: '', topic: '', version: 1, documentIds: [], createdAt: now, updatedAt: now }],
    documents: [], sessions: [],
    knowledge: [{ id: 'knowledge-fixture', title: '当前内容标题', description: '当前内容说明', sourceIds: [], understanding: '', version: 19, contentVersion: 2, createdAt: now, updatedAt: now,
      contentHistory: [{ version: 1, title: '当时内容标题', description: '当时内容说明', sourceIds: [], createdAt: now }, { version: 2, title: '当前内容标题', description: '当前内容说明', sourceIds: [], createdAt: now }] }],
    quizzes: [{ id: 'quiz-fixture', sessionId: null, reviewSessionId: null, version: 1, questionCount: 0, currentIndex: 0, questions: [], submittedAt: now }],
    cards: [{ id: 'card-fixture', knowledgeId: 'knowledge-fixture', version: 1, createdAt: now,
      schedule: { due: now, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: 0, learning_steps: 0 } }],
    reviewSessions: [{ id: 'review-fixture', cardId: 'card-fixture', expectedCardVersion: 1, version: 1, status: 'RECALLING', recall: '', recallSubmittedAt: null, quizId: null, activeRunId: null, createdAt: now, completedAt: null }],
    reviewEvents: [], evidence: [
      { id: 'evidence-old', knowledgeId: 'knowledge-fixture', knowledgeVersion: 1, quizId: 'quiz-fixture', questionId: 'question-old', answer, dimension: 'immediate', simulated: true },
      { id: 'evidence-legacy', knowledgeId: 'knowledge-fixture', quizId: 'quiz-fixture', questionId: 'question-legacy', answer, dimension: 'delayed', simulated: true },
      { id: 'evidence-missing', knowledgeId: 'knowledge-fixture', knowledgeVersion: 99, quizId: 'quiz-fixture', questionId: 'question-missing', answer, dimension: 'immediate', simulated: true },
    ], runs: [],
  };
}

async function offline(page: Page, data: PublicState) {
  const requests: string[] = [];
  const recalls: { action: string; text: string }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push(`${method} ${path}`);
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/status') return json({ authenticated: true });
    if (path === '/api/ai/skills') return json({ mode: data.mode, items: [] });
    if (path === '/api/state') return json(data);
    if (path === '/api/learning/statistics') return json(learningStatistics(emptyData(data.mode), new Date(), data.timezone));
    if (path === '/api/learning/preferences') return json({ revision: 0, source: 'environment', schedulingEnabled: data.capabilities.schedulingEnabled, promptCacheRetention: 'none', associationEnabled: false, codeExercisesEnabled: false, codeLanguages: ['python'] });
    if (path === '/api/recitations/recitation-fixture/input-preview') return json({
      kind: 'extract', revision: data.revision, canSubmit: true, reason: null, model: null, documentCount: 1,
      originalChars: 170000, sentChars: 47000, maxChars: LIMITS.modelInputChars,
      contextWindow: null, estimatedInputTokens: null, outputReserveTokens: 0, safetyMarginTokens: 512, remainingInputTokens: null,
      truncated: true, fields: [{ path: 'sources[0].text', label: '仅元数据.md', originalChars: 80000, sentChars: 12000, truncated: true }],
    } satisfies TaskInputPreview);
    if (method === 'PUT' && path === '/api/recitations/recitation-fixture/draft') {
      const body = request.postDataJSON();
      Object.assign(data.recitations[0]!, body, { version: data.recitations[0]!.version + 1 });
      data.revision++;
      return json({ version: data.recitations[0]!.version });
    }
    if (method === 'PUT' && path === '/api/knowledge-points/knowledge-fixture/understanding') {
      const body = request.postDataJSON() as { text: string };
      data.knowledge[0]!.understanding = body.text;
      data.knowledge[0]!.version++;
      data.revision++;
      return json({ version: data.knowledge[0]!.version });
    }
    if (method === 'PUT' && path === '/api/review-sessions/review-fixture/recall') {
      const body = request.postDataJSON() as { action: string; text: string };
      recalls.push(body);
      const session = data.reviewSessions[0]!;
      session.recall = body.text;
      session.version++;
      if (body.action === 'submitted') { session.status = 'QUIZ_READY'; session.recallSubmittedAt = new Date().toISOString(); }
      data.revision++;
      return json({ version: session.version });
    }
    // Fail closed rather than falling through to any running API.
    errors.push(`Unexpected API request: ${method} ${path}`);
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OFFLINE_FIXTURE_ONLY', message: 'Unsupported fixture request' } }) });
  });
  return { requests, recalls, errors };
}

test('server budget fixture includes sources and retains full long drafts', async ({ page }) => {
  const data = fixture();
  const recitation = data.recitations[0]!;
  recitation.learned = '\\'.repeat(LIMITS.recitationFieldChars);
  recitation.unclear = '疑'.repeat(LIMITS.recitationFieldChars);
  recitation.application = '用'.repeat(LIMITS.recitationFieldChars);
  recitation.documentIds = ['document-fixture'];
  data.documents = [{ id: 'document-fixture', recitationId: recitation.id, name: '仅元数据.md', lineCount: 100, textLength: 80000, createdAt: recitation.createdAt }];
  const observed = await offline(page, data);
  await page.goto('/recite');
  const input = page.getByRole('textbox', { name: '今天学了什么', exact: true });
  await expect(input).toHaveValue(recitation.learned);
  await expect(input).toHaveAttribute('maxlength', String(LIMITS.recitationFieldChars));
  await expect(page.getByLabel('今日主题')).toHaveAttribute('maxlength', String(LIMITS.topicChars));
  // Tests the UI contract only; real JSON/token accounting is covered by host API regressions.
  const budget = page.getByRole('note').filter({ hasText: 'AI 输入预算' });
  await expect(budget).toHaveCount(0);
  await expect(page.getByText('原文 80,000 个字符 · AI 可能仅使用节选')).toBeVisible();
  await expect(page.getByRole('button', { name: '提交复述', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(input).toHaveValue('\\'.repeat(LIMITS.recitationFieldChars));
  expect(observed.requests.some(request => request.includes('/api/documents'))).toBe(false);
  expect(observed.errors).toEqual([]);
});

test('knowledge shows content snapshots, never CAS versions or invented legacy evidence', async ({ page }) => {
  const data = fixture();
  const observed = await offline(page, data);
  await page.goto('/knowledge/knowledge-fixture');
  await expect(page.locator('.page-heading .badge')).toHaveText('内容版本 2');
  await expect(page.getByLabel('我的理解')).toHaveAttribute('maxlength', String(LIMITS.answerChars));
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: '内容历史', exact: true }) });
  await history.locator('summary').filter({ hasText: '内容版本 1' }).click();
  await expect(history.getByText('当时内容说明', { exact: true })).toBeVisible();
  const oldEvidence = page.locator('.evidence-item').filter({ hasText: '证据依据：内容版本 1' });
  await oldEvidence.locator('summary').click();
  await expect(oldEvidence.getByText('当时内容说明', { exact: true })).toBeVisible();
  await expect(oldEvidence).not.toContainText('当前内容说明');
  const legacy = page.locator('.evidence-item').filter({ hasText: '内容版本未知（旧记录）' });
  await expect(legacy).toContainText('不以当前内容代替当时依据');
  await expect(legacy.locator('summary')).toHaveCount(0);
  const missing = page.locator('.evidence-item').filter({ hasText: '证据依据：内容版本 99' });
  await expect(missing).toContainText('该版本快照不可用');
  await expect(missing.locator('summary')).toHaveCount(0);
  await page.getByLabel('我的理解').fill('这只是个人理解修订');
  await page.getByRole('button', { name: '保存我的理解', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('已保存');
  await expect(page.locator('.page-heading .badge')).toHaveText('内容版本 2');
  expect(data.knowledge[0]!.contentHistory).toHaveLength(2);
  expect(observed.errors).toEqual([]);
});

test('legacy knowledge without content history explicitly remains unknown', async ({ page }) => {
  const data = fixture();
  delete data.knowledge[0]!.contentVersion;
  delete data.knowledge[0]!.contentHistory;
  const observed = await offline(page, data);
  await page.goto('/knowledge/knowledge-fixture');
  await expect(page.locator('.page-heading .badge')).toHaveText('内容版本未知（旧记录）');
  await expect(page.getByText('暂无历史内容快照，旧记录的内容版本未知，不能用当前内容推定当时的依据。')).toBeVisible();
  expect(observed.errors).toEqual([]);
});

test('disabled scheduling is explicit in empty review, quiz results, and learning completion', async ({ page }) => {
  const data = fixture();
  data.cards = []; data.reviewSessions = [];
  data.sessions = [{ id: 'session-fixture', recitationId: 'recitation-fixture', snapshot: { learned: '测试复述', unclear: '', application: '', topic: '' }, documentIds: [], scopeVersion: 1, version: 1, status: 'COMPLETED', candidates: [], turns: [], quizId: null, activeRunId: null, completionReason: 'no_quiz', createdAt: data.recitations[0]!.createdAt, completedAt: data.recitations[0]!.createdAt }];
  const observed = await offline(page, data);
  for (const path of ['/review', '/quizzes/quiz-fixture/result', '/sessions/session-fixture/ask']) {
    await page.goto(path);
    const notice = page.getByRole('note').filter({ hasText: '自动排期已关闭' });
    await expect(notice).toContainText('不会新建复习卡或更新排期');
    await expect(notice.getByRole('link', { name: '复习与缓存设置' })).toHaveAttribute('href', '/review#learning-preferences');
    await expect(notice).toContainText('后续出题与评分可能产生模型费用');
    if (path === '/review') {
      await expect(page.getByText('自动排期已关闭，完成学习或测验不会自动生成复习卡。你仍可复述、作答和查看学习记录。')).toBeVisible();
      await expect(page.getByText('完成学习与检验后，符合条件的知识点会出现在这里。')).toHaveCount(0);
    }
  }
  expect(data.capabilities.schedulingEnabled).toBe(false);
  expect(observed.errors).toEqual([]);
});

test('recall accepts empty drafts but only submits trimmed nonempty content without a blank-confirm dialog', async ({ page }) => {
  const data = fixture();
  const observed = await offline(page, data);
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('/review-sessions/review-fixture');
  const recall = page.getByLabel('独立回忆');
  const submit = page.getByRole('button', { name: '提交回忆，开始检验' });
  await expect(recall).toHaveAttribute('maxlength', String(LIMITS.answerChars));
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/回忆会用于定向出题，不作为独立分数/)).toBeVisible();
  await recall.fill(' \n  ');
  await page.getByRole('button', { name: '保存回忆草稿' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText('已保存');
  await expect(submit).toBeDisabled();
  expect(observed.recalls.every(body => body.action === 'draft')).toBe(true);
  await recall.fill('我记得需要先独立提取，但忘记了适用条件。');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText('原始回忆已保留', { exact: true })).toBeVisible();
  expect(observed.recalls.filter(body => body.action === 'submitted')).toEqual([expect.objectContaining({ text: '我记得需要先独立提取，但忘记了适用条件。' })]);
  expect(dialogs).toEqual([]); await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(observed.errors).toEqual([]);
});

test('review result navigation does not promise disabled scheduling', async ({ page }) => {
  const data = fixture();
  data.quizzes[0]!.reviewSessionId = 'review-fixture';
  const observed = await offline(page, data);
  await page.goto('/quizzes/quiz-fixture/result');
  await expect(page.getByRole('link', { name: '返回单卡复习，保存记录' })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回单卡复习，完成排期' })).toHaveCount(0);
  data.capabilities.schedulingEnabled = true;
  await page.reload();
  await expect(page.getByRole('note').filter({ hasText: '自动排期已关闭' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '返回单卡复习，完成排期' })).toBeVisible();
  expect(observed.errors).toEqual([]);
});
