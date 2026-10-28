import { expect, test, type Page, type Route } from '@playwright/test';
import { LIMITS, type PublicState, type TaskInputPreview } from '@sanxing/contracts';
import { acknowledgeFeedback, answerDialog } from './dialog.ts';

// Offline UI contract fixtures, NOT proof of the host's accounting or privacy.
// Every API request is intercepted, including unexpected requests (fail closed).
function fixture(): PublicState {
  const now = new Date().toISOString();
  return { mode: 'live', timezone: 'UTC', revision: 1, csrfToken: 'offline-budget-csrf',
    capabilities: { maxUploadBytes: LIMITS.uploadBytes, maxDocuments: LIMITS.documents, maxFollowups: LIMITS.followups, quizCount: LIMITS.quizQuestions, schedulingEnabled: false },
    recitations: [{ id: 'recitation-budget', learningDate: now.slice(0, 10), learned: '独立回忆', unclear: '', application: '', topic: '', version: 1, documentIds: [], createdAt: now, updatedAt: now }],
    documents: [], sessions: [], knowledge: [], cards: [], reviewSessions: [], reviewEvents: [], evidence: [], runs: [],
    quizzes: [{ id: 'quiz-budget', sessionId: null, reviewSessionId: null, version: 1, questionCount: 1, currentIndex: 0, submittedAt: null,
      questions: [{ id: 'question-budget', knowledgeId: 'knowledge-budget', explanation: null, kind: 'short', prompt: '请用自己的话解释独立回忆。', options: [], draft: '', answer: null }] }],
  };
}
function preview(data: PublicState, overrides: Partial<TaskInputPreview> = {}): TaskInputPreview {
  return { kind: 'extract', revision: data.revision, canSubmit: true, reason: null, model: { providerId: 'offline-provider', modelId: 'offline-model' },
    documentCount: data.documents.length, originalChars: 1000, sentChars: 1000, maxChars: LIMITS.modelInputChars,
    contextWindow: 32000, estimatedInputTokens: 1200, outputReserveTokens: 4096, safetyMarginTokens: 512, remainingInputTokens: 26192,
    truncated: false, fields: [], ...overrides };
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function offline(page: Page, data: PublicState, preflight: (route: Route) => Promise<unknown>) {
  const errors: string[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === '/api/auth/status') return json(route, { authenticated: true });
    if (path === '/api/ai/skills' && request.method() === 'GET') return json(route, { mode: data.mode, items: [] });
    if (path === '/api/state') return json(route, data);
    if (path.endsWith('/input-preview')) {
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(data.csrfToken);
      requests.push({ path, body: request.postDataJSON() });
      return preflight(route);
    }
    if (path === '/api/recitations/recitation-budget/draft') {
      Object.assign(data.recitations[0]!, request.postDataJSON(), { version: data.recitations[0]!.version + 1 });
      data.revision++;
      requests.push({ path, body: request.postDataJSON() });
      return json(route, { version: data.recitations[0]!.version });
    }
    if (path === '/api/questions/question-budget/draft') {
      data.quizzes[0]!.questions[0]!.draft = request.postDataJSON().text;
      data.quizzes[0]!.version++; data.revision++;
      requests.push({ path, body: request.postDataJSON() });
      return json(route, { version: data.quizzes[0]!.version });
    }
    if (path === '/api/documents') {
      const recitation = data.recitations[0]!;
      data.documents.push({ id: 'document-budget', recitationId: recitation.id, name: '完整笔记.md', lineCount: 3, textLength: 8800, createdAt: recitation.createdAt });
      recitation.documentIds.push('document-budget'); recitation.version++; data.revision++;
      return json(route, { version: recitation.version });
    }
    if (path.endsWith('/submit') || path.endsWith('/answers')) {
      requests.push({ path, body: request.postDataJSON() });
      return json(route, { ok: true });
    }
    errors.push(`Unexpected API request: ${request.method()} ${path}`);
    return json(route, { error: { code: 'OFFLINE_ONLY', message: 'Unsupported fixture route' } }, 500);
  });
  return { requests, errors };
}
const budget = (page: Page) => page.getByRole('note', { name: 'AI 输入预算' });
const learned = (page: Page) => page.getByRole('textbox', { name: '今天学了什么', exact: true });
const submit = (page: Page) => page.getByRole('button', { name: '提交复述', exact: true });

test('upload invalidates the old budget and refreshes accounting including source text', async ({ page }) => {
  const data = fixture(); let uploaded: Route | undefined;
  const observed = await offline(page, data, async route => {
    if (data.documents.length) { uploaded = route; return; }
    return json(route, preview(data));
  });
  await page.goto('/recite');
  await expect(submit(page)).toBeEnabled();
  await expect(budget(page)).toHaveCount(0);
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: '完整笔记.md', mimeType: 'text/markdown', buffer: Buffer.from('离线笔记原文') });
  await expect.poll(() => Boolean(uploaded)).toBe(true);
  await expect(submit(page)).toBeDisabled();
  await expect(budget(page)).toHaveCount(0);
  await json(uploaded!, preview(data, { originalChars: 9900, sentChars: 9900 }));
  await expect(budget(page)).toHaveCount(0);
  await expect(submit(page)).toBeEnabled();
  expect(observed.requests.filter(item => item.path.endsWith('/input-preview'))).toHaveLength(2);
  expect(observed.errors).toEqual([]);
});

test('long input remains complete without displaying preflight descriptions', async ({ page }) => {
  const data = fixture();
  const text = '长'.repeat(LIMITS.recitationFieldChars);
  const observed = await offline(page, data, route => json(route, preview(data, {
    originalChars: 65000, sentChars: 47990, truncated: true,
    fields: [{ path: 'learned', label: '今天学了什么', originalChars: text.length, sentChars: 9000, truncated: true }],
  })));
  await page.goto('/recite'); await learned(page).fill(text);
  await expect(budget(page)).toHaveCount(0);
  await expect(submit(page)).toBeEnabled();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(learned(page)).toHaveValue(text);
  expect(data.recitations[0]!.learned).toBe(text);
  expect(observed.errors).toEqual([]);
});

test('low budget blocks submission but draft save and upload stay available', async ({ page }) => {
  const data = fixture();
  const observed = await offline(page, data, route => json(route, preview(data, { canSubmit: false, reason: '输出预留后无足够输入预算', remainingInputTokens: -100 })));
  await page.goto('/recite'); await acknowledgeFeedback(page, ['输出预留后无足够输入预算']);
  await learned(page).fill('预算不足也要保留我的草稿');
  await acknowledgeFeedback(page, ['输出预留后无足够输入预算']);
  await expect(submit(page)).toBeDisabled();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  expect(data.recitations[0]!.learned).toBe('预算不足也要保留我的草稿');
  await expect(page.getByRole('button', { name: /拖放笔记到这里/ })).toBeEnabled();
  expect(observed.requests.some(item => item.path.endsWith('/submit'))).toBe(false);
  expect(observed.errors).toEqual([]);
});

test('late preview cannot replace new input, and failures never reuse a previous balance', async ({ page }) => {
  const data = fixture(); let late: Route | undefined; let fail = false;
  const observed = await offline(page, data, async route => {
    const text = route.request().postDataJSON().input.learned;
    if (text === '迟到旧输入') { late = route; return; }
    if (fail) return json(route, { error: { code: 'PREVIEW_FAILED', message: '离线预检失败' } }, 503);
    return json(route, preview(data, { sentChars: text === '最新输入' ? 2222 : 1111 }));
  });
  await page.goto('/recite'); await expect(submit(page)).toBeEnabled();
  await expect(budget(page)).toHaveCount(0);
  await learned(page).fill('迟到旧输入'); await expect.poll(() => Boolean(late)).toBe(true);
  await learned(page).fill('最新输入');
  await expect(submit(page)).toBeEnabled();
  await json(late!, preview(data, { canSubmit: false, reason: '过时的检查结果' }));
  await expect(page.getByRole('alertdialog').filter({ hasText: '过时的检查结果' })).toHaveCount(0);
  await expect(submit(page)).toBeEnabled();
  fail = true; await learned(page).fill('失败输入');
  await expect(page.getByRole('alertdialog')).toContainText('离线预检失败');
  await expect(budget(page)).toHaveCount(0);
  await expect(page.locator('.submit-bar button.primary')).toBeDisabled();
  fail = false; await page.getByRole('button', { name: '重试检查' }).click();
  await expect(submit(page)).toBeEnabled();
  expect(observed.errors).toEqual([]);
});

test('submit saves first then rechecks, and a newly refused budget prevents enqueue', async ({ page }) => {
  const data = fixture(); let refuse = false;
  const observed = await offline(page, data, route => json(route, preview(data, { canSubmit: !refuse, reason: refuse ? '模型预算已变化' : null })));
  await page.goto('/recite'); await learned(page).fill('提交前的新内容');
  await expect(submit(page)).toBeEnabled();
  refuse = true; await submit(page).click();
  await expect(page.getByRole('alertdialog')).toContainText('模型预算已变化');
  expect(data.recitations[0]!.learned).toBe('提交前的新内容');
  const saveIndex = observed.requests.findIndex(item => item.path.endsWith('/draft'));
  expect(saveIndex).toBeGreaterThanOrEqual(0);
  expect(observed.requests.slice(saveIndex + 1).some(item => item.path.endsWith('/input-preview'))).toBe(true);
  expect(observed.requests.some(item => item.path.endsWith('/submit'))).toBe(false);
  expect(observed.errors).toEqual([]);
});

test('successful formal submit uses the saved CAS version after a fresh preview', async ({ page }) => {
  const data = fixture();
  const observed = await offline(page, data, route => json(route, preview(data)));
  await page.goto('/recite'); await learned(page).fill('通过最新预算后正式提交');
  await expect(submit(page)).toBeEnabled(); await submit(page).click();
  await expect.poll(() => observed.requests.filter(item => item.path.endsWith('/submit')).length).toBe(1);
  const saved = observed.requests.findIndex(item => item.path.endsWith('/draft'));
  const submitted = observed.requests.findIndex(item => item.path.endsWith('/submit'));
  expect(observed.requests.slice(saved + 1, submitted).some(item => item.path.endsWith('/input-preview'))).toBe(true);
  expect(observed.requests[submitted]!.body.version).toBe(data.recitations[0]!.version);
  expect(observed.errors).toEqual([]);
});

test('unmount aborts an outstanding preview rather than retaining its response', async ({ page }) => {
  const data = fixture(); let held: Route | undefined;
  const failures: string[] = [];
  page.on('requestfailed', request => { if (request.url().endsWith('/input-preview')) failures.push(request.url()); });
  const observed = await offline(page, data, async route => { held = route; });
  await page.goto('/recite'); await expect.poll(() => Boolean(held)).toBe(true);
  await page.getByRole('button', { name: '全部模块', exact: true }).click();
  await page.getByRole('dialog', { name: '全部模块' }).getByRole('button', { name: /^我的知识库 / }).click();
  await expect(page.getByRole('heading', { name: '我的知识库', exact: true })).toBeVisible();
  await expect(budget(page)).toHaveCount(0);
  await json(held!, preview(data));
  await expect.poll(() => failures.length).toBe(1);
  expect(observed.errors).toEqual([]);
});

test('short-answer numeric preview never requests private answers; low budget permits save and skip', async ({ page }) => {
  const data = fixture();
  const observed = await offline(page, data, route => json(route, preview(data, { kind: 'grade', canSubmit: false, reason: '评分输入预算不足', remainingInputTokens: -1 })));
  await page.goto('/quizzes/quiz-budget');
  await page.getByLabel('我的回答', { exact: true }).fill('我的独立回答');
  await expect(budget(page)).toContainText('包含当前题目及服务端私有评分规则（不返回答案）');
  await expect(page.getByRole('button', { name: '正式提交', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '暂存答案' }).click();
  expect(data.quizzes[0]!.questions[0]!.draft).toBe('我的独立回答');
  await expect(page.getByRole('heading', { name: '参考讲解', exact: true })).toHaveCount(0);
  const previews = observed.requests.filter(item => item.path.endsWith('/input-preview'));
  expect(previews.length).toBeGreaterThan(0);
  for (const item of previews) { expect(Object.keys(item.body).sort()).toEqual(['skillSelections', 'text']); expect(item.body.skillSelections).toEqual([]); }
  await page.getByRole('button', { name: '跳过这题' }).click(); await answerDialog(page, true, ['跳过不计为答错']);
  await expect.poll(() => observed.requests.filter(item => item.path.endsWith('/answers')).length).toBe(1);
  expect(observed.requests.filter(item => item.path.endsWith('/answers'))).toEqual([expect.objectContaining({ body: expect.objectContaining({ action: 'skip' }) })]);
  expect(observed.errors).toEqual([]);
});

test('short-answer formal submission also performs a fresh preflight after saving', async ({ page }) => {
  const data = fixture(); let refuse = false;
  const observed = await offline(page, data, route => json(route, preview(data, { kind: 'grade', canSubmit: !refuse, reason: refuse ? '最新评分预算不足' : null })));
  await page.goto('/quizzes/quiz-budget'); await page.getByLabel('我的回答', { exact: true }).fill('回答草稿');
  const formal = page.getByRole('button', { name: '正式提交', exact: true });
  await expect(formal).toBeEnabled(); refuse = true; await formal.click();
  await expect(budget(page)).toContainText('最新评分预算不足');
  expect(data.quizzes[0]!.questions[0]!.draft).toBe('回答草稿');
  expect(observed.requests.some(item => item.path.endsWith('/answers'))).toBe(false);
  expect(observed.errors).toEqual([]);
});

test('preview authentication expiry keeps the unsaved local draft', async ({ page }) => {
  const data = fixture();
  const observed = await offline(page, data, route => route.request().postDataJSON().input.learned === '未保存的本地草稿'
    ? json(route, { error: { code: 'UNAUTHENTICATED', message: '请先登录个人学习空间。' } }, 401)
    : json(route, preview(data)));
  await page.goto('/recite'); await learned(page).fill('未保存的本地草稿');
  await expect(page.getByLabel('访问密码')).toBeVisible();
  const stored = await page.evaluate(() => sessionStorage.getItem('sanxing:draft:recitation:recitation-budget'));
  expect(JSON.parse(stored!).value.learned).toBe('未保存的本地草稿');
  expect(observed.requests.some(item => item.path.endsWith('/submit'))).toBe(false);
  expect(observed.errors).toEqual([]);
});
