import { expect, test, type Page } from './test.ts';
import { LearningService, previewKnowledgeMerge, projectState, publicQuiz, reviewPlan, learningStatistics, effectiveLearningPreferences, resolvedKnowledgeId } from '@sanxing/learning-domain';
import { phaseFourData, phaseFourConfig, phaseFourNow } from '../fixtures/phase-four.ts';
import { acknowledgeFeedback } from './dialog.ts';

async function fixture(page: Page) {
  const data = phaseFourData(); const errors: string[] = []; const started: string[] = [];
  const service = new LearningService({ read: async () => data, transact: async fn => fn(data) }, phaseFourConfig, () => new Date(phaseFourNow));
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method(); const body = route.request().postDataJSON();
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/auth/status') return json({ authenticated: true });
    if (path === '/api/ai/skills') return json({ mode: data.mode, items: [] });
    if (path === '/api/state') return json(projectState(data, phaseFourConfig, 'phase-four', true));
    // Synthetic pending runs have no executing worker and therefore no live progress.
    if (path === '/api/runs/progress' && method === 'GET') return json({});
    if (path === '/api/learning/statistics') return json(learningStatistics(data, new Date(phaseFourNow), 'UTC'));
    if (path === '/api/reviews/plan') return json(reviewPlan(data, phaseFourConfig, new Date(phaseFourNow)));
    if (path === '/api/learning/preferences') {
      if (method === 'GET') return json({ ...effectiveLearningPreferences(data, phaseFourConfig), source: 'saved', revision: data.revision });
      const result = service.saveLearningPreferences(data, body); data.revision++; return json(result);
    }
    const id = path.split('/')[3]!;
    if (path.endsWith('/merge-preview')) return json(previewKnowledgeMerge(data, id, body.targetId));
    if (path.endsWith('/merge')) { const result = service.mergeKnowledge(data, id, body); data.revision++; return json(result); }
    if (path.endsWith('/evidence')) {
      const all = Object.values(data.evidence).filter(item => data.knowledge[id]!.merge ? item.knowledgeId === id : resolvedKnowledgeId(data, item.knowledgeId) === id);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json({ revision: data.revision, total: all.length, nextOffset: offset + 20 < all.length ? offset + 20 : null, items: all.slice(offset, offset + 20) });
    }
    if (path.startsWith('/api/quizzes/')) return json(publicQuiz(data.quizzes[id]!));
    if (path.endsWith('/start')) { const result = service.startReview(data, id); started.push(id); data.revision++; return json(result); }
    errors.push(path); return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED', message: path } } });
  });
  return { data, errors, started };
}
test('merge requires an explicit card, retains old content, and paginates the combined evidence', async ({ page }) => {
  const { data, errors } = await fixture(page); const original = structuredClone(data.cards.a!.schedule);
  await page.goto('/knowledge/a'); await page.getByText('选择目标并预览影响', { exact: true }).click();
  await page.getByLabel('合并到', { exact: true }).selectOption('b'); await page.getByRole('button', { name: '预览知识合并', exact: true }).click();
  await expect(page.getByText('2 个来源 · 24 条作答证据 · 24 次学习会话。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '按预览合并知识' })).toBeDisabled();
  await page.getByLabel('保留哪张复习卡').selectOption('a'); await page.getByRole('button', { name: '按预览合并知识' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(page).toHaveURL(/knowledge\/b$/); await expect(page.getByRole('heading', { name: '合并来源' })).toBeVisible();
  await expect(page.getByText('共 24 条 · 第 1 页')).toBeVisible(); await page.getByRole('button', { name: '下一页证据' }).click();
  await expect(page.getByText('共 24 条 · 第 2 页')).toBeVisible(); await expect(page.getByText('原答案 23', { exact: true })).toBeVisible();
  expect(data.cards.a!.schedule).toEqual(original); expect(data.cards.a!.currentKnowledgeId).toBe('b'); expect(data.cards.b!.retiredAt).toBeTruthy();
  await page.getByRole('link', { name: '知识 a · 查看原记录' }).click(); await expect(page.getByRole('heading', { name: '此知识已合并' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存知识内容' })).toHaveCount(0); expect(errors).toEqual([]);
});
test('completed quiz summaries load the original answer and updated assessment after refresh', async ({ page }) => {
  const { data, errors } = await fixture(page);
  data.runs.polling = { id: 'polling', status: 'pending', task: { kind: 'extract', recitation: { learned: '', unclear: '', application: '', topic: '' }, sources: [] }, sessionId: null, reviewSessionId: null, quizId: null, questionId: null, attempt: 0, attemptId: null, expectedVersion: 1, createdAt: phaseFourNow, startedAt: null, finishedAt: null, error: null, usage: null, reservationUsd: 0, promptVersion: 'synthetic' };
  await page.goto('/quizzes/q0/result');
  await expect(page.getByText('原答案 0', { exact: true })).toBeVisible(); await expect(page.getByText('PRIVATE_REFERENCE', { exact: true })).toBeVisible();
  await page.getByText('核对这条评价', { exact: true }).click(); await page.getByText('人工核对分项', { exact: true }).click();
  await page.getByLabel('第 1 项得分').fill('1'); await page.getByLabel('第 1 项依据').fill('未保存的核对依据');
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/quizzes/q0');
  data.revision++; await refreshed;
  await expect(page.getByLabel('第 1 项得分')).toHaveValue('1'); await expect(page.getByLabel('第 1 项依据')).toHaveValue('未保存的核对依据');
  await page.getByLabel('第 1 项得分').fill(''); await page.getByLabel('第 1 项依据').fill('');
  data.quizzes.q0!.answers.q0!.assessment.feedback = '核对后的新反馈'; data.quizzes.q0!.version++; data.revision++;
  await page.reload(); await expect(page.getByText('核对后的新反馈', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});
test('saved preferences select one due card by eligible losses and explain its priority', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { data, started, errors } = await fixture(page); await page.goto('/review');
  await page.getByText('学习、复习与缓存设置', { exact: true }).click(); await page.getByLabel('连续复习顺序').selectOption('weakness'); await page.getByLabel('每轮最多复习卡数').fill('1');
  await page.getByRole('button', { name: '确认保存设置' }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始连续复习（1 张）' })).toBeVisible();
  await acknowledgeFeedback(page, ['已保存']);
  await page.getByText('查看本轮顺序依据', { exact: true }).click(); await expect(page.getByText('知识 a：近 30 天最近 5 次独立即时作答得分率 0%（演示）', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '开始连续复习（1 张）' }).click(); await expect(page.getByRole('heading', { name: '知识 a', exact: true })).toBeVisible();
  expect(started).toEqual(['a']); expect(data.reviewEvents).toEqual({}); expect(errors).toEqual([]);
});
