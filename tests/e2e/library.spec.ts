import { learningStatistics } from '../../packages/learning-domain/src/statistics.ts';
import { emptyData } from '@sanxing/database';
import { expect, test, type Page, type Route } from './test.ts';
import { LIMITS, type LearningPreferencesView, type LibrarySearchResult, type PublicState, type TaskInputPreview, type TokenUsageHeatmap } from '@sanxing/contracts';
import { acknowledgeFeedback, answerDialog } from './dialog.ts';

// Browser-only contracts: every API route fails closed, never a provider or personal database.
function fixture(): PublicState {
  const now = new Date().toISOString();
  return {
    mode: 'live', timezone: 'UTC', revision: 1, csrfToken: 'offline-library-csrf',
    capabilities: { maxUploadBytes: LIMITS.uploadBytes, maxDocuments: LIMITS.documents, maxFollowups: LIMITS.followups, quizCount: LIMITS.quizQuestions, schedulingEnabled: false },
    recitations: [{ id: 'draft', learningDate: now.slice(0, 10), learned: '提取练习', unclear: '', application: '', topic: '', version: 1, documentIds: [], createdAt: now, updatedAt: now }],
    documents: [{ id: 'old-doc', recitationId: 'original-owner', name: '历史记忆笔记.md', textLength: 6000, lineCount: 12, createdAt: now }],
    knowledge: Array.from({ length: 4 }, (_, index) => ({ id: `old-${index}`, title: `不同标题 ${index}`, description: '提取练习促进长期记忆', sourceIds: ['old-doc'], understanding: '', version: 7, contentVersion: 2,
      contentHistory: [{ version: 1, title: `原有标题 ${index}`, description: '旧版本不可替代的说明', sourceIds: ['old-doc'], createdAt: now }, { version: 2, title: `不同标题 ${index}`, description: '提取练习促进长期记忆', sourceIds: ['old-doc'], createdAt: now }], createdAt: now, updatedAt: now })),
    sessions: [{ id: 'session', recitationId: 'draft', snapshot: { learned: '提取练习', unclear: '', application: '', topic: '' }, documentIds: [], scopeVersion: 1, version: 1, status: 'CONFIRMING',
      candidates: [{ id: 'candidate', title: '新主题', description: '提取练习促进长期记忆', decision: 'pending', sourceIds: [], existingKnowledgeId: null, knowledgeId: null }],
      turns: [], quizId: null, activeRunId: null, completionReason: null, createdAt: now, completedAt: null }],
    quizzes: [], cards: [], reviewSessions: [], reviewEvents: [], evidence: [], runs: [],
  };
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function offline(page: Page, data: PublicState) {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const controls = { conflict: false, cache: true };
  let preferences: LearningPreferencesView = { revision: 4, source: 'environment', reviewOrder: 'due', reviewBatchSize: null, schedulingEnabled: data.capabilities.schedulingEnabled, promptCacheRetention: 'none', associationEnabled: false, codeExercisesEnabled: false, codeLanguages: ['python'] };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    const body = request.postData() ? request.postDataJSON() : {};
    requests.push({ path, method, body });
    if (method !== 'GET') expect(request.headers()['x-csrf-token']).toBe(data.csrfToken);
    if (path === '/api/auth/status') return json(route, { authenticated: true });
    if (path === '/api/state') return json(route, data);
    if (path === '/api/runs/progress' && method === 'GET') return json(route, {});
    if (path === '/api/library/search') {
      expect(method).toBe('POST');
      const documents = [{ kind: 'document' as const, id: 'old-doc', title: '历史记忆笔记.md', excerpt: '提取练习资料片段', score: 3, startLine: 4, endLine: 6, contentVersion: null }];
      const knowledge = data.knowledge.map(point => ({ kind: 'knowledge' as const, id: point.id, title: point.title, excerpt: point.description, score: 2, startLine: 1, endLine: 2, contentVersion: point.contentVersion ?? null }));
      return json(route, { query: body.query, strategy: 'local-bm25-v1', total: body.kind === 'document' ? 1 : body.kind === 'knowledge' ? knowledge.length : knowledge.length + 1, offset: 0, nextOffset: null, revision: data.revision, expandedTerms: [], hits: body.kind === 'document' ? documents : body.kind === 'knowledge' ? knowledge : [...documents, ...knowledge] } satisfies LibrarySearchResult);
    }
    if (path === '/api/documents/old-doc') return json(route, { ...data.documents[0], text: '按需读取的公开原文\n提取练习资料' });
    if (path === '/api/recitations/draft/input-preview') return json(route, {
      kind: 'extract', revision: data.revision, canSubmit: true, reason: null, model: { providerId: 'offline', modelId: 'offline' }, documentCount: data.recitations[0]!.documentIds.length,
      originalChars: 1200, sentChars: 1200, maxChars: 48000, contextWindow: 32000, estimatedInputTokens: 1300, outputReserveTokens: 4000, safetyMarginTokens: 512, remainingInputTokens: 26188,
      truncated: false, fields: [], retrieval: { mode: 'excerpt', sourceCount: 1, originalChars: 6000, selectedChars: 900, originalTurns: 8, selectedTurns: 2 },
    } satisfies TaskInputPreview);
    if (path === '/api/recitations/draft/draft') {
      expect(body.version).toBe(data.recitations[0]!.version);
      Object.assign(data.recitations[0]!, body, { version: data.recitations[0]!.version + 1 }); data.revision++;
      return json(route, { version: data.recitations[0]!.version });
    }
    if (path === '/api/recitations/draft/references') {
      expect(body).toEqual({ version: data.recitations[0]!.version, documentId: 'old-doc', confirm: true });
      data.recitations[0]!.documentIds = ['old-doc']; data.recitations[0]!.version++; data.revision++;
      return json(route, { version: data.recitations[0]!.version });
    }
    if (path === '/api/sessions/session/confirmations') {
      const session = data.sessions[0]!;
      session.candidates = session.candidates.map(candidate => ({ ...candidate, ...body.decisions.find((decision: { candidateId: string }) => decision.candidateId === candidate.id) }));
      // Association is server-side and preference-gated; the client never chooses related points.
      expect(Object.keys(body).sort()).toEqual(['decisions', 'skillSelections', 'version']);
      expect(body.skillSelections).toEqual([]);
      session.relatedKnowledge = [];
      session.status = 'CLARIFYING'; session.version++; data.revision++;
      return json(route, { version: session.version });
    }
    if (path === '/api/learning/statistics') return json(route, learningStatistics(emptyData(data.mode), new Date(), data.timezone));
    if (path === '/api/learning/preferences') {
      if (method === 'GET') return json(route, preferences);
      expect(method).toBe('PUT');
      if (controls.conflict) {
        preferences = { ...preferences, revision: 5 }; controls.conflict = false;
        return json(route, { error: { code: 'VERSION_CONFLICT', message: '设置版本冲突' } }, 409);
      }
      expect(body.expectedRevision).toBe(preferences.revision); expect(body.confirm).toBe(true);
      preferences = { revision: preferences.revision + 1, source: 'saved', reviewOrder: body.reviewOrder ?? preferences.reviewOrder, reviewBatchSize: body.reviewBatchSize === undefined ? preferences.reviewBatchSize : body.reviewBatchSize, schedulingEnabled: body.schedulingEnabled, promptCacheRetention: body.promptCacheRetention, associationEnabled: body.associationEnabled, codeExercisesEnabled: body.codeExercisesEnabled, codeLanguages: body.codeLanguages };
      data.capabilities.schedulingEnabled = preferences.schedulingEnabled; data.revision++;
      return json(route, { version: preferences.revision });
    }
    if (path === '/api/knowledge-points/old-0/review-card') {
      expect(body).toEqual({ version: 7, confirm: true });
      data.cards.push({ id: 'single-card', knowledgeId: 'old-0', version: 1, createdAt: data.knowledge[0]!.createdAt,
        schedule: { due: data.knowledge[0]!.createdAt, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: 0, learning_steps: 0 } }); data.revision++;
      return json(route, { id: 'single-card' });
    }
    if (path === '/api/ai/access') return json(route, { mode: 'live', providers: [], notice: '' });
    if (path === '/api/ai/skills' && method === 'GET') return json(route, { mode: data.mode, items: [] });
    if (path === '/api/ai/configuration') return json(route, { mode: 'live', revision: 0, selection: null, source: 'none', ready: false, problem: null, budget: { enabled: false, dailyUsd: null, reservationUsd: null }, providers: [] });
    if (path === '/api/ai/usage') return json(route, {
      mode: 'live', timezone: 'UTC', year: 2026, availableYears: [2026], days: [],
      totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, attempts: 2, knownUsageAttempts: 2, unknownUsageAttempts: 0 },
      ...(controls.cache ? { cache: { readTokens: 30, writeTokens: 10, unknownAttempts: 1 } } : {}),
    } satisfies TokenUsageHeatmap);
    errors.push(`${method} ${path}`);
    return json(route, { error: { code: 'OFFLINE_ONLY', message: 'Unsupported offline route' } }, 500);
  });
  return { requests, errors, controls };
}
const writes = <T extends { path: string; method: string }>(requests: T[]) => requests.filter(item => item.method !== 'GET' && !item.path.endsWith('/input-preview') && item.path !== '/api/library/search');

test('library is read-only and source text is fetched only on explicit expansion', async ({ page }) => {
  const observed = await offline(page, fixture());
  await page.goto('/library');
  await expect(page.getByRole('heading', { name: '本地资料库' })).toBeVisible();
  expect(observed.requests.some(item => item.path === '/api/library/search')).toBe(false);
  await page.getByLabel('检索关键词').fill('提取练习'); await page.getByRole('button', { name: '搜索本地资料', exact: true }).click();
  await expect(page.getByText('第 4–6 行', { exact: false })).toBeVisible();
  expect(observed.requests.some(item => item.path === '/api/documents/old-doc')).toBe(false);
  await page.locator('.source summary').filter({ hasText: '历史记忆笔记.md' }).locator('span').first().click();
  await page.getByRole('button', { name: '原文（行号）', exact: true }).click();
  await expect(page.getByText('按需读取的公开原文', { exact: true })).toBeVisible();
  expect(writes(observed.requests)).toEqual([]); expect(observed.errors).toEqual([]);
});

test('historical document starts unselected and explicit attach saves draft before latest CAS', async ({ page }) => {
  const data = fixture(); const observed = await offline(page, data);
  await page.goto('/recite'); await page.getByText('搜索历史资料并附加', { exact: true }).click();
  await page.getByLabel('检索关键词').fill('提取练习'); await page.getByRole('button', { name: '搜索本地资料', exact: true }).click();
  const selected = page.getByRole('checkbox', { name: '选择 历史记忆笔记.md', exact: true });
  await expect(selected).not.toBeChecked(); await expect(page.getByRole('button', { name: '确认附加所选资料' })).toBeDisabled();
  expect(writes(observed.requests)).toEqual([]);
  await selected.check(); await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('附加前需要保留的本地草稿');
  await page.getByRole('button', { name: '确认附加所选资料' }).click(); await answerDialog(page, true, ['相关片段可能发给 AI']);
  await expect(page.getByText('已附加 1 份资料', { exact: false })).toBeVisible();
  expect(data.recitations[0]!.learned).toBe('附加前需要保留的本地草稿'); expect(data.documents[0]!.recitationId).toBe('original-owner');
  const save = observed.requests.findIndex(item => item.path.endsWith('/draft/draft'));
  const attach = observed.requests.findIndex(item => item.path.endsWith('/references'));
  expect(save).toBeGreaterThan(-1); expect(attach).toBeGreaterThan(save);
  expect(observed.requests.slice(save + 1, attach).some(item => item.path === '/api/state')).toBe(true);
  expect(writes(observed.requests).every(item => item.path.endsWith('/draft/draft') || item.path.endsWith('/references'))).toBe(true);
  expect(observed.errors).toEqual([]);
});

test('learning confirmation has no manual association picker and sends only scope decisions', async ({ page }) => {
  const data = fixture(); const observed = await offline(page, data);
  await page.goto('/sessions/session/ask');
  await expect(page.getByText('关联旧知识作比较', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查找相关旧知识' })).toHaveCount(0);
  await expect(page.getByLabel('知识点归属')).toHaveValue('');
  await expect(page.getByText('与设置中的“旧知识联想”不同', { exact: false })).toBeVisible();
  await page.getByLabel('知识点归属').selectOption('old-1');
  await page.getByRole('checkbox', { name: '纳入这个知识点', exact: false }).check();
  await page.getByRole('button', { name: '确认学习范围' }).click();
  await expect.poll(() => observed.requests.filter(item => item.path.endsWith('/confirmations')).length).toBe(1);
  const confirmation = observed.requests.find(item => item.path.endsWith('/confirmations'))!;
  expect(confirmation.body.decisions).toEqual([expect.objectContaining({ existingKnowledgeId: 'old-1', decision: 'accepted' })]);
  expect(confirmation.body).not.toHaveProperty('relatedKnowledgeIds');
  expect(observed.requests.some(item => item.path === '/api/library/search')).toBe(false);
  await expect(page.getByRole('heading', { name: '关联旧知识 · 联想参考' })).toHaveCount(0);
  expect(observed.errors).toEqual([]);
});

test('preferences need explicit confirmation, retain choices after CAS conflict, and do not backfill cards', async ({ page }) => {
  const data = fixture(); const observed = await offline(page, data);
  await page.goto('/review'); await page.locator('#learning-preferences summary').click();
  const card = page.locator('#learning-preferences');
  await expect(card).toContainText('继承环境设置');
  const scheduling = card.getByRole('checkbox', { name: '启用复习排期' }); const cache = card.getByLabel('厂商提示缓存');
  await expect(scheduling).not.toBeChecked(); await expect(cache).toHaveValue('none');
  await scheduling.check(); await cache.selectOption('short');
  await card.getByRole('button', { name: '确认保存设置' }).click(); await answerDialog(page, false);
  expect(writes(observed.requests)).toEqual([]);
  observed.controls.conflict = true;
  await card.getByRole('button', { name: '确认保存设置' }).click(); await answerDialog(page, true, ['缓存非免费、不保证命中']);
  await acknowledgeFeedback(page, ['设置版本冲突']);
  await expect(scheduling).toBeChecked(); await expect(cache).toHaveValue('short'); await expect(card).toContainText('设置版本 4');
  await card.getByRole('button', { name: '重新读取设置' }).click(); await answerDialog(page, true);
  await expect(card).toContainText('设置版本 5'); await expect(scheduling).not.toBeChecked();
  const association = card.getByRole('checkbox', { name: '旧知识联想' }); await expect(association).not.toBeChecked();
  await scheduling.check(); await cache.selectOption('short'); await association.check();
  await card.getByRole('button', { name: '确认保存设置' }).click(); await answerDialog(page, true, ['旧知识联想：开启']);
  await acknowledgeFeedback(page, ['学习、复习与缓存设置已保存']);
  await expect(association).toBeChecked();
  expect(writes(observed.requests).map(item => item.body)).toEqual([
    { expectedRevision: 4, schedulingEnabled: true, promptCacheRetention: 'short', associationEnabled: false, codeExercisesEnabled: false, codeLanguages: ['python'], reviewOrder: 'due', reviewBatchSize: null, confirm: true },
    { expectedRevision: 5, schedulingEnabled: true, promptCacheRetention: 'short', associationEnabled: true, codeExercisesEnabled: false, codeLanguages: ['python'], reviewOrder: 'due', reviewBatchSize: null, confirm: true },
  ]);
  expect(data.cards).toEqual([]); expect(data.mode).toBe('live');
  expect(observed.requests.filter(item => item.path === '/api/learning/preferences' && item.method === 'GET').length).toBeGreaterThanOrEqual(3);
  expect(observed.errors).toEqual([]);
});

test('pending task disables preferences rather than changing model or cancelling work', async ({ page }) => {
  const data = fixture();
  data.runs.push({ id: 'pending', kind: 'extract', status: 'pending', sessionId: 'session', reviewSessionId: null, error: null, createdAt: data.recitations[0]!.createdAt });
  const observed = await offline(page, data); await page.goto('/review'); await page.locator('#learning-preferences summary').click();
  await expect(page.getByRole('checkbox', { name: '启用复习排期' })).toBeDisabled();
  await expect(page.getByLabel('厂商提示缓存')).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '旧知识联想' })).toBeDisabled();
  await expect(page.getByText('有等待或运行中的任务', { exact: false })).toBeVisible();
  expect(writes(observed.requests)).toEqual([]); expect(observed.errors).toEqual([]);
});

test('old knowledge only gets one explicitly confirmed card, never a batch or model request', async ({ page }) => {
  const data = fixture(); data.capabilities.schedulingEnabled = true;
  const observed = await offline(page, data); await page.goto('/knowledge/old-0');
  const add = page.getByRole('button', { name: '将此知识加入复习' }); await expect(add).toBeEnabled();
  expect(data.cards).toEqual([]);
  await add.click(); await answerDialog(page, false); expect(writes(observed.requests)).toEqual([]);
  await add.click(); await answerDialog(page, true);
  await expect(page.getByRole('link', { name: '查看现有复习卡' })).toBeVisible(); await expect(add).toHaveCount(0);
  expect(data.cards.map(card => card.knowledgeId)).toEqual(['old-0']);
  expect(writes(observed.requests)).toHaveLength(1); expect(observed.errors).toEqual([]);
});

test('confirmation dialog is an in-page mask: Escape, backdrop and cancel never write; focus is trapped and restored', async ({ page }) => {
  const data = fixture(); data.capabilities.schedulingEnabled = true;
  const observed = await offline(page, data); await page.goto('/knowledge/old-0');
  const add = page.getByRole('button', { name: '将此知识加入复习' }); const dialog = page.getByRole('alertdialog', { name: '加入复习' });
  await add.click(); await expect(dialog).toBeVisible(); await expect(dialog).toContainText('不调用模型');
  await expect(dialog.locator('[data-confirm]')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.locator('[data-cancel]')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.locator('[data-confirm]')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(add).toBeFocused();
  await add.click(); await page.mouse.click(8, 8); await expect(dialog).toHaveCount(0);
  await add.click(); await dialog.getByRole('button', { name: '取消' }).click(); await expect(dialog).toHaveCount(0);
  expect(writes(observed.requests)).toEqual([]); expect(data.cards).toEqual([]);
  await add.click(); await dialog.getByRole('button', { name: '加入复习' }).click();
  await expect(page.getByRole('link', { name: '查看现有复习卡' })).toBeVisible(); expect(writes(observed.requests)).toHaveLength(1);
  expect(observed.errors).toEqual([]);
});

test('unsaved input holds navigation behind the dialog and replays it only after confirmation', async ({ page }) => {
  const observed = await offline(page, fixture());
  await page.route('**/api/recitations/draft/draft', () => { /* never settles: the draft stays unsaved */ });
  await page.goto('/recite'); await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('尚未保存的复述');
  await expect(page.locator('[data-unsaved="true"]')).toHaveCount(1);
  const home = page.getByRole('link', { name: '每日三省首页' });
  await home.click(); await answerDialog(page, false, ['仍有未保存的输入']);
  await expect(page).toHaveURL(/\/recite$/);
  await expect(home).toBeFocused();
  // The module menu navigates in-app too, so it waits for the same confirmation.
  const openLibrary = async () => {
    await page.getByRole('button', { name: '全部模块', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '全部模块' });
    await menu.getByLabel('搜索模块').fill('本地资料库');
    await menu.getByRole('button', { name: /本地资料库/ }).click();
  };
  await openLibrary();
  await answerDialog(page, false); await expect(page).toHaveURL(/\/recite$/);
  // An in-page anchor never leaves the page, so it never asks.
  await page.getByRole('link', { name: '跳至主要内容' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await openLibrary(); await answerDialog(page, true);
  await expect(page).toHaveURL(/\/library$/); await expect(page.getByRole('heading', { name: '本地资料库' })).toBeVisible();
  expect(observed.errors).toEqual([]);
});

test('recitation keeps preflight descriptions hidden for retrieved context', async ({ page }) => {
  const observed = await offline(page, fixture()); await page.goto('/recite');
  const budget = page.getByRole('note', { name: 'AI 输入预算' });
  await expect(budget).toHaveCount(0);
  await expect(page.getByRole('button', { name: '提交复述', exact: true })).toBeEnabled();
  expect(observed.errors).toEqual([]);
});

test('cache totals are informational subsets, and old fixtures without cache remain usable', async ({ page }) => {
  const observed = await offline(page, fixture()); await page.goto('/ai-access');
  const total = (name: string) => page.locator('dl > div').filter({ has: page.locator('dt').filter({ hasText: new RegExp(`^${name}$`) }) }).locator('dd');
  await expect(total('已知 token 总数')).toHaveText('120');
  await expect(total('年度缓存读取 token')).toHaveText('30'); await expect(total('年度缓存写入 token')).toHaveText('10');
  await expect(total('缓存用量未知次数')).toHaveText('1');
  await expect(page.getByText('缓存读写已含在总输入中，不重复相加', { exact: false })).toBeVisible();
  observed.controls.cache = false; await page.reload();
  await expect(total('已知 token 总数')).toHaveText('120'); await expect(total('年度缓存读取 token')).toHaveCount(0);
  expect(writes(observed.requests)).toEqual([]); expect(observed.errors).toEqual([]);
});

test('an unsubmitted review result does not reveal sources or fetch private question data', async ({ page }) => {
  const data = fixture();
  data.quizzes = [{ id: 'review-quiz', sessionId: null, reviewSessionId: 'review', version: 1, questionCount: 1, currentIndex: 0, submittedAt: null,
    questions: [{ id: 'unanswered', knowledgeId: 'old-0', kind: 'short', prompt: '未作答的复习题', options: [], draft: '', answer: null, explanation: null }] }];
  const observed = await offline(page, data); await page.goto('/quizzes/review-quiz/result');
  await expect(page.getByText('测验尚未交卷，先返回作答或确认交卷。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '参考讲解' })).toHaveCount(0);
  await expect(page.locator('.source')).toHaveCount(0);
  expect(observed.requests.every(item => ['/api/auth/status', '/api/state'].includes(item.path))).toBe(true);
  expect(observed.errors).toEqual([]);
});

test('knowledge detail recalls completed-session comparisons from frozen v1, not current knowledge', async ({ page }) => {
  const data = fixture();
  const session = data.sessions[0]!;
  Object.assign(session, { id: 'completed-comparison', status: 'COMPLETED', scopeVersion: 3, completionReason: 'assessed', completedAt: session.createdAt });
  Object.assign(session.candidates[0]!, { decision: 'accepted', knowledgeId: 'old-0', knowledgeVersion: 1 });
  session.relatedKnowledge = [{ id: 'old-1', title: '当时关联的旧标题', description: '仅在确认时冻结的比较说明', knowledgeVersion: 1, sourceIds: [] }];
  Object.assign(data.knowledge[1]!, { title: '后来修改的最新标题', description: '后来的最新说明不能替代冻结版本', contentVersion: 9, version: 20, contentHistory: [] });
  // A rejected or unrelated candidate must not make this point inherit another session's comparisons.
  data.sessions.push(
    { ...session, id: 'rejected-session', candidates: [{ ...session.candidates[0]!, decision: 'rejected' }] },
    { ...session, id: 'other-point-session', candidates: [{ ...session.candidates[0]!, knowledgeId: 'old-2' }] },
    { ...session, id: 'no-comparison-session', relatedKnowledge: [] },
  );
  const observed = await offline(page, data); await page.goto('/knowledge/old-0');
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: '学习时关联过的旧知识', exact: true }) });
  await expect(history).toBeVisible();
  await expect(history).toContainText('会话 completed-comparison · 范围 v3 · 本点内容版本 1');
  await expect(history.getByRole('heading', { name: '当时关联的旧标题', exact: true })).toBeVisible();
  await expect(history).toContainText('关联内容版本 1');
  await expect(history.getByText('仅在确认时冻结的比较说明', { exact: true })).toBeVisible();
  await expect(history).not.toContainText('后来修改的最新标题');
  await expect(history).not.toContainText('后来的最新说明');
  await expect(history).not.toContainText('关联内容版本 9');
  await expect(history).not.toContainText('rejected-session');
  await expect(history).not.toContainText('other-point-session');
  await expect(history).not.toContainText('no-comparison-session');
  await expect(history.getByRole('link')).toHaveCount(1);
  await expect(history.getByRole('link', { name: '回看当时学习会话' })).toHaveAttribute('href', '/sessions/completed-comparison/ask');
  expect(observed.requests.every(item => ['/api/auth/status', '/api/state'].includes(item.path))).toBe(true);
  expect(observed.errors).toEqual([]);
});

test('knowledge sources resolve actual historical and frozen versions, never current replacements', async ({ page }) => {
  const data = fixture();
  data.knowledge[0]!.sourceIds = ['knowledge:old-1:v1', 'knowledge:missing:v3', 'knowledge:old-1:v99'];
  data.sessions[0]!.relatedKnowledge = [{ id: 'missing', title: '冻结来源', description: '冻结的比较内容', knowledgeVersion: 3, sourceIds: [] }];
  const observed = await offline(page, data); await page.goto('/knowledge/old-0');
  const sources = page.locator('section').filter({ has: page.getByRole('heading', { name: '来源与原始笔记', exact: true }) });
  await sources.locator('summary').filter({ hasText: '原有标题 1 · 内容版本 1' }).click();
  await expect(sources.getByText('旧版本不可替代的说明', { exact: true })).toBeVisible();
  await sources.locator('summary').filter({ hasText: '冻结来源 · 内容版本 3' }).click();
  await expect(sources.getByText('冻结的比较内容', { exact: true })).toBeVisible();
  await expect(sources).toContainText('知识来源版本未知 / 快照不可用：knowledge:old-1:v99');
  await expect(sources).not.toContainText('提取练习促进长期记忆');
  expect(observed.errors).toEqual([]);
});
