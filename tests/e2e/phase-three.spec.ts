import { expect, test, type Page } from './test.ts';
import { LIMITS, type PublicState } from '@sanxing/contracts';
import { emptyData } from '@sanxing/database';
import { learningStatistics } from '../../packages/learning-domain/src/statistics.ts';
import { syntheticPdf } from '../fixtures/pdf.ts';
import { password } from './settings.ts';

function fixture(): PublicState {
  const stamp = '2026-01-01T00:00:00.000Z';
  return { mode: 'mock', timezone: 'UTC', revision: 1, csrfToken: 'phase-three', capabilities: { maxUploadBytes: LIMITS.uploadBytes, maxDocuments: 5, maxFollowups: 3, quizCount: 3, schedulingEnabled: false },
    recitations: [], documents: [], sessions: [], quizzes: [], evidence: [], runs: [], reviewSessions: [], reviewEvents: [],
    knowledge: [1, 2, 3].map(index => ({ id: `k${index}`, title: `复习知识 ${index}`, description: '测试', sourceIds: [], version: 1, understanding: '', createdAt: stamp, updatedAt: stamp })),
    cards: [1, 2, 3].map(index => ({ id: `c${index}`, knowledgeId: `k${index}`, version: 1, createdAt: stamp, pausedAt: index === 3 ? stamp : null, schedule: { due: stamp, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: 0, learning_steps: 0 } })),
  };
}
async function offline(page: Page, data: PublicState) {
  const starts: string[] = []; const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON(); const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/auth/status') return json({ authenticated: true });
    if (path === '/api/state') return json(data);
    if (path === '/api/learning/preferences') return json({ revision: data.revision, source: 'environment', schedulingEnabled: false, promptCacheRetention: 'none', associationEnabled: false, codeExercisesEnabled: false, codeLanguages: ['python'] });
    if (path === '/api/learning/statistics') return json(learningStatistics(emptyData('mock'), new Date(), 'UTC'));
    if (path.startsWith('/api/reviews/') && path.endsWith('/start')) {
      const cardId = path.split('/')[3]!; starts.push(cardId);
      const existing = data.reviewSessions.find(review => review.cardId === cardId && review.status !== 'COMPLETED');
      if (existing) return json({ reviewSessionId: existing.id });
      const id = `review-${cardId}`;
      data.reviewSessions.push({ id, cardId, expectedCardVersion: 1, version: 1, status: 'READY_TO_COMPLETE', recall: '已完成独立回忆与测验', recallSubmittedAt: new Date().toISOString(), quizId: `quiz-${cardId}`, activeRunId: null, createdAt: new Date().toISOString(), completedAt: null }); data.revision++;
      return json({ reviewSessionId: id });
    }
    if (path.endsWith('/complete')) {
      const review = data.reviewSessions.find(item => item.id === path.split('/')[3])!; expect(body.version).toBe(review.version);
      review.status = 'COMPLETED'; review.version++; review.completedAt = new Date().toISOString(); data.revision++;
      return json({ reviewSessionId: review.id });
    }
    errors.push(path); return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED', message: path } } });
  });
  return { starts, errors };
}
test('continuous review survives refresh and finishes without replaying a still-due card when scheduling is disabled', async ({ page }) => {
  const data = fixture(); const observed = await offline(page, data);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: '复习与作答统计' })).toBeVisible();
  await expect(page.getByText('演示统计，不构成真实学习评价', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '开始连续复习（2 张）' }).click();
  await expect(page).toHaveURL(/review-sessions\/review-c1$/);
  await page.getByRole('button', { name: '完成本次复习' }).click();
  await page.reload();
  await page.getByRole('button', { name: '继续下一张复习卡' }).click();
  await expect(page).toHaveURL(/review-sessions\/review-c2$/);
  await page.getByRole('button', { name: '完成本次复习' }).click();
  await page.getByRole('button', { name: '继续下一张复习卡' }).click();
  await expect(page.getByRole('status').filter({ hasText: '本轮队列已结束' })).toBeVisible();
  expect(observed.starts).toEqual(['c1', 'c2']); expect(data.reviewEvents).toEqual([]); expect(observed.errors).toEqual([]);
});
test('search paginates and resets results when switching personal notes and terminology', async ({ page }) => {
  const data = fixture(); const observed = await offline(page, data); const searches: Record<string, unknown>[] = [];
  await page.route('**/api/library/search', async route => {
    const body = route.request().postDataJSON(); searches.push(body);
    const offset = body.offset as number;
    await route.fulfill({ json: { query: body.query, strategy: body.expandTerms ? 'local-bm25-terms-v1' : 'local-bm25-v1', total: 11, offset, nextOffset: offset === 0 ? 10 : null, revision: data.revision, expandedTerms: body.expandTerms ? ['先进先出'] : [],
      hits: Array.from({ length: offset === 0 ? 10 : 1 }, (_, index) => ({ kind: 'knowledge', id: `k${offset + index}`, title: `分页结果 ${offset + index}`, excerpt: 'FIFO', score: 1, startLine: 1, endLine: 1, contentVersion: body.includeUnderstanding ? null : 1, field: body.includeUnderstanding ? 'understanding' : 'content' })) } });
  });
  await page.goto('/library'); await page.getByLabel('检索关键词').fill('FIFO');
  await page.getByRole('button', { name: '搜索本地资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '分页结果 0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('heading', { name: '分页结果 10', exact: true })).toBeVisible();
  expect(searches[1]).toMatchObject({ offset: 10, expectedRevision: 1 });
  await page.getByLabel('包含我的理解（当前个人笔记）').check();
  await expect(page.getByRole('heading', { name: '分页结果 10', exact: true })).toHaveCount(0);
  await page.getByLabel('扩展常见缩写和中英文术语').check();
  await page.getByRole('button', { name: '搜索本地资料', exact: true }).click();
  await expect(page.getByText('扩展词：先进先出')).toBeVisible();
  await expect(page.getByText('我的理解 · 当前可编辑笔记，不是历史内容快照')).toHaveCount(10);
  expect(searches[2]).toMatchObject({ offset: 0, includeUnderstanding: true, expandTerms: true }); expect(observed.errors).toEqual([]);
});
test('PDF upload displays page mapping, reads the selected page and downloads the retained original', async ({ page }) => {
  await page.goto('/recite'); await page.getByLabel('访问密码').fill(password); await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
  const start = page.getByRole('button', { name: '开始今天的三省' });
  if (await start.isVisible()) await start.click();
  const bytes = syntheticPdf(['FIFO original first page', 'BINARY original second page']);
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'phase-three.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.document-row').filter({ hasText: 'phase-three.pdf' })).toBeVisible();
  await page.goto('/library'); await page.getByLabel('检索关键词').fill('BINARY'); await page.getByRole('button', { name: '搜索本地资料', exact: true }).click();
  const hit = page.locator('.candidate').filter({ has: page.getByRole('heading', { name: 'phase-three.pdf' }) });
  await expect(hit).toContainText('PDF 第 1、2 页');
  await hit.locator('summary').click(); await hit.getByLabel('PDF 页码').selectOption('2');
  await expect(hit.locator('.source-lines')).toContainText('BINARY original second page');
  await expect(hit.locator('.source-lines')).not.toContainText('FIFO original first page');
  await hit.getByRole('button', { name: '最大化查看 phase-three.pdf' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('PDF 页码')).toHaveValue('2');
  await expect(dialog.locator('.source-lines')).toContainText('BINARY original second page');
  await dialog.getByLabel('PDF 页码').selectOption('1');
  await dialog.getByRole('button', { name: '退出最大化' }).click();
  await expect(hit.getByLabel('PDF 页码')).toHaveValue('1');
  const [download] = await Promise.all([page.waitForEvent('download'), hit.getByRole('link', { name: '下载原始 PDF' }).click()]);
  expect(download.suggestedFilename()).toBe('phase-three.pdf');
});

test('a queued card paused elsewhere is skipped after refresh, including on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = fixture(); const observed = await offline(page, data);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: '复习与作答统计' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phase-three-review-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '开始连续复习（2 张）' }).click();
  await page.getByRole('button', { name: '完成本次复习' }).click();
  data.cards[1]!.pausedAt = new Date().toISOString(); data.revision++;
  await page.reload(); await page.getByRole('button', { name: '继续下一张复习卡' }).click();
  await expect(page.getByRole('status').filter({ hasText: '本轮队列已结束' })).toBeVisible();
  expect(observed.starts).toEqual(['c1']); expect(observed.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
