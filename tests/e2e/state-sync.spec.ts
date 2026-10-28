import { expect, test, type Page, type Route } from '@playwright/test';
import { LIMITS, type PublicDocument, type PublicState, type PublicStateUpdate } from '@sanxing/contracts';
import { autoAcceptDialogs } from './dialog.ts';

// Every API route is intercepted: these fixtures never use a personal database/provider.
function fixture(): PublicState {
  const now = new Date().toISOString();
  return { mode: 'mock', timezone: 'UTC', revision: 1, csrfToken: 'offline-csrf',
    capabilities: { maxUploadBytes: LIMITS.uploadBytes, maxDocuments: LIMITS.documents, maxFollowups: LIMITS.followups, quizCount: LIMITS.quizQuestions, schedulingEnabled: false },
    recitations: [{ id: 'recitation', learningDate: now.slice(0, 10), version: 1, learned: '原有复述', unclear: '', application: '', topic: '', documentIds: ['document', 'temporary'], createdAt: now, updatedAt: now }],
    documents: [{ id: 'document', recitationId: 'recitation', name: '原始资料.md', lineCount: 2, textLength: 12, createdAt: now }],
    sessions: [], knowledge: [], quizzes: [], cards: [], reviewSessions: [], reviewEvents: [], evidence: [], runs: [] };
}
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function offline(page: Page, handler: (route: Route, url: URL) => Promise<unknown>) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await autoAcceptDialogs(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/status') { await json(route, { authenticated: true }); return; }
    // Live progress is a separate read; these state-sync fixtures have no worker telemetry.
    if (url.pathname === '/api/runs/progress' && route.request().method() === 'GET') { await json(route, {}); return; }
    // Budget is independent of state synchronization; fail closed without reaching a host.
    if (url.pathname.endsWith('/input-preview')) { await json(route, { error: { code: 'OFFLINE_BUDGET', message: '此同步 fixture 未提供预算。' } }, 503); return; }
    await handler(route, url);
  });
  return errors;
}
function activeRun(data: PublicState) {
  data.runs = [{ id: 'run', kind: 'extract', status: 'running', sessionId: null, reviewSessionId: null, error: null, createdAt: data.recitations[0]!.createdAt }];
}

test('polls with since after the bare initial snapshot and fetches document text only on expansion', async ({ page }) => {
  const data = fixture(); activeRun(data);
  const stateQueries: (string | null)[] = []; const documentRequests: string[] = [];
  const errors = await offline(page, async (route, url) => {
    if (url.pathname === '/api/state') {
      const since = url.searchParams.get('since'); stateQueries.push(since);
      return json(route, since === null ? data : { kind: 'unchanged', revision: 1, csrfToken: data.csrfToken } satisfies PublicStateUpdate);
    }
    if (url.pathname === '/api/documents/document') {
      documentRequests.push(url.pathname);
      return json(route, { ...data.documents[0]!, text: '按需读取第一行\n第二行' } satisfies PublicDocument);
    }
    errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
  });
  await page.goto('/recite');
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('原有复述');
  await expect.poll(() => stateQueries.length).toBeGreaterThan(1);
  expect(stateQueries[0]).toBeNull(); expect(stateQueries.slice(1).every(since => since === '1')).toBe(true);
  expect(documentRequests).toEqual([]);
  await page.locator('.source summary>span').first().click();
  await page.getByRole('button', { name: '原文（行号）', exact: true }).click();
  await expect(page.locator('.source-lines')).toContainText('按需读取第一行');
  expect(documentRequests).toEqual(['/api/documents/document']);
  await page.locator('.source summary>span').first().click(); await page.locator('.source summary>span').first().click();
  await expect(page.locator('.source-lines')).toContainText('第二行');
  expect(documentRequests).toHaveLength(1); expect(errors).toEqual([]);
});

test('reconciles concurrent poll and command deltas against their exact baseline, including reverted entities and removals', async ({ page }) => {
  const initial = fixture(); activeRun(initial);
  const original = structuredClone(initial.documents[0]!);
  let saved: PublicState['recitations'][number] | undefined;
  let heldPoll: Route | undefined;
  let servedCommand = false;
  const queries: (string | null)[] = [];
  const errors = await offline(page, async (route, url) => {
    if (url.pathname === '/api/state') {
      const since = url.searchParams.get('since'); queries.push(since);
      if (since === null) return json(route, initial);
      if (!heldPoll) { heldPoll = route; return; }
      if (!servedCommand && saved) {
        servedCommand = true;
        return json(route, { kind: 'delta', fromRevision: 1, revision: 2, csrfToken: initial.csrfToken, changes: {
          recitations: { upsert: [saved], remove: [] },
          documents: { upsert: [{ ...original, name: '中间版本.md' }, { ...original, id: 'temporary', name: '稍后删除.md' }], remove: [] },
        } } satisfies PublicStateUpdate);
      }
      expect(since).toBe('2');
      return json(route, { kind: 'delta', fromRevision: 2, revision: 3, csrfToken: initial.csrfToken, changes: {
        documents: { upsert: [original], remove: ['temporary'] }, runs: { upsert: [], remove: ['run'] },
      } } satisfies PublicStateUpdate);
    }
    if (url.pathname === '/api/recitations/recitation/draft') {
      saved = { ...initial.recitations[0]!, ...route.request().postDataJSON(), version: 2 };
      return json(route, { version: 2 });
    }
    errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
  });
  await page.goto('/recite');
  await expect.poll(() => Boolean(heldPoll)).toBe(true);
  await page.getByLabel('今日主题').fill('并发保存');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.locator('.source summary')).toContainText(['中间版本.md', '稍后删除.md']);
  // R1 -> R3 omits document because it reverted to its R1 contents. Applying this
  // to R2 would silently retain both the intermediate edit and the deleted entity.
  await json(heldPoll!, { kind: 'delta', fromRevision: 1, revision: 3, csrfToken: initial.csrfToken, changes: {
    recitations: { upsert: [saved!], remove: [] }, runs: { upsert: [], remove: ['run'] },
  } } satisfies PublicStateUpdate);
  await expect(page.locator('.source summary')).toHaveCount(1);
  await expect(page.locator('.source summary')).toContainText('原始资料.md');
  await expect(page.getByLabel('今日主题')).toHaveValue('并发保存');
  expect(queries).toEqual([null, '1', '1', '2']); expect(errors).toEqual([]);
});

test('expired authentication preserves editor input but a new login forces a full snapshot at equal revision', async ({ page }) => {
  const data = fixture(); const queries: (string | null)[] = [];
  let loggedInAgain = false;
  const errors = await offline(page, async (route, url) => {
    if (url.pathname === '/api/state') {
      queries.push(url.searchParams.get('since'));
      const next = structuredClone(data);
      if (loggedInAgain) { next.csrfToken = 'new-session-token'; next.documents[0]!.name = '新会话资料.md'; }
      return json(route, next);
    }
    if (url.pathname === '/api/recitations/recitation/draft') return json(route, { error: { code: 'UNAUTHENTICATED', message: '请先登录个人学习空间。' } }, 401);
    if (url.pathname === '/api/auth/login') { loggedInAgain = true; return json(route, { csrfToken: 'new-session-token' }); }
    if (url.pathname === '/api/auth/logout') return json(route, { ok: true });
    errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
  });
  await page.goto('/recite');
  const input = page.getByRole('textbox', { name: '今天学了什么', exact: true });
  await input.fill('尚未保存的独立回忆');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeVisible();
  await page.getByLabel('访问密码').fill('offline-password');
  await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page.locator('.source summary')).toContainText('新会话资料.md');
  await expect(input).toHaveValue('尚未保存的独立回忆');
  expect(queries).toEqual([null, null]);
  expect(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('sanxing:draft:')))).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('sanxing:')))).toEqual([]);
  expect(queries).toHaveLength(2); expect(errors).toEqual([]);
});

test('aborts an on-demand document request when its source component unmounts', async ({ page }) => {
  const data = fixture(); let source: Route | undefined;
  const failures: string[] = [];
  page.on('requestfailed', request => { if (request.url().includes('/api/documents/')) failures.push(request.url()); });
  const errors = await offline(page, async (route, url) => {
    if (url.pathname === '/api/state') return json(route, data);
    if (url.pathname === '/api/documents/document') { source = route; return; }
    errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
  });
  await page.goto('/recite');
  await page.locator('.source summary>span').first().click();
  await expect.poll(() => Boolean(source)).toBe(true);
  // History also renders this document in a closed source viewer; choose a page
  // without sources so we test unmount cancellation, not history's own rendering.
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的知识库' }).click();
  await expect(page.locator('.source')).toHaveCount(0);
  // Let the intercepted response complete too: the unmounted component must have
  // cancelled its fetch, rather than retaining a request until the body arrives.
  await json(source!, { ...data.documents[0]!, text: '迟到的原文' });
  await expect.poll(() => failures.length).toBe(1);
  expect(errors).toEqual([]);
});

for (const kind of ['feature', 'command'] as const) for (const status of [200, 401]) {
  test(`ignores an old session's late ${kind} response (${status}) while replacing the login session`, async ({ page }) => {
    const data = fixture();
    let held: Route | undefined;
    let loginRequest: Route | undefined;
    let documentReads = 0;
    let loggedInAgain = false;
    const queries: (string | null)[] = [];
    const expired = { error: { code: 'UNAUTHENTICATED', message: '旧会话已失效。' } };
    const errors = await offline(page, async (route, url) => {
      if (url.pathname === '/api/state') { queries.push(url.searchParams.get('since')); return json(route, { ...data, csrfToken: loggedInAgain ? 'new-token' : data.csrfToken }); }
      if (url.pathname === '/api/documents/document') {
        documentReads++;
        if (loggedInAgain) return json(route, { ...data.documents[0]!, text: '新会话的原文' });
        if (kind === 'feature') { held = route; return; }
        return json(route, expired, 401);
      }
      if (url.pathname === '/api/recitations/recitation/draft') {
        if (kind === 'command') { held = route; return; }
        return json(route, expired, 401);
      }
      if (url.pathname === '/api/auth/login') { if (kind === 'feature') { loginRequest = route; return; } loggedInAgain = true; return json(route, { csrfToken: 'new-token' }); }
      errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
    });
    await page.goto('/recite');
    const input = page.getByRole('textbox', { name: '今天学了什么', exact: true });
    await input.fill('跨会话保留的草稿');
    if (kind === 'feature') {
      await page.locator('.source summary>span').first().click();
      await expect.poll(() => Boolean(held)).toBe(true);
      await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '保存草稿', exact: true }).click();
      await expect.poll(() => Boolean(held)).toBe(true);
      await page.locator('.source summary>span').first().click();
    }
    await expect(page.getByLabel('访问密码')).toBeVisible();
    await page.getByLabel('访问密码').fill('offline-password');
    await page.getByRole('button', { name: '进入我的学习空间' }).click();
    if (kind === 'feature') {
      await expect.poll(() => Boolean(loginRequest)).toBe(true);
      // While login is pending the editor remains mounted; this request has not
      // been aborted by a new read session, so the epoch fence itself is tested.
      await json(held!, status === 401 ? expired : { ...data.documents[0]!, text: '旧会话迟到原文' }, status);
      await expect(page.locator('.source-content')).toContainText(status === 401 ? '旧会话已失效' : '登录状态已变化');
      loggedInAgain = true;
      await json(loginRequest!, { csrfToken: 'new-token' });
    } else {
      await expect(input).toBeVisible();
      await json(held!, status === 401 ? expired : { version: 2 }, status);
      await expect(page.locator('.save-state')).toContainText('未保存');
    }
    await expect(page.locator('.source-content')).toContainText('新会话的原文');
    expect(documentReads).toBe(2);
    await expect(page.getByLabel('访问密码')).toHaveCount(0);
    await expect(page).toHaveURL(/\/recite$/);
    await expect(input).toHaveValue('跨会话保留的草稿');
    await expect(page.locator('.source-content')).not.toContainText('旧会话迟到原文');
    expect(queries).toEqual([null, null]); expect(errors).toEqual([]);
  });
}

test('stops a single synchronization attempt after two delta collisions and one full fallback', async ({ page }) => {
  const data = fixture(); let saving = false; const queries: (string | null)[] = [];
  const errors = await offline(page, async (route, url) => {
    if (url.pathname === '/api/state') {
      queries.push(url.searchParams.get('since'));
      return json(route, saving ? { kind: 'delta', fromRevision: 99, revision: 100, csrfToken: data.csrfToken, changes: {} } : data);
    }
    if (url.pathname === '/api/recitations/recitation/draft') { saving = true; return json(route, { version: 2 }); }
    errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
  });
  await page.goto('/recite');
  await page.getByLabel('今日主题').fill('同步失败也保留');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.locator('.error-banner')).toContainText('状态同步版本不一致');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await expect(page.getByLabel('今日主题')).toHaveValue('同步失败也保留');
  expect(queries).toEqual([null, '1', '1', null]); expect(errors).toEqual([]);
});

test('unknown route suffixes render a missing page instead of mounting a learning editor', async ({ page }) => {
  const data = fixture();
  const errors = await offline(page, async (route, url) => {
    if (url.pathname === '/api/state') return json(route, data);
    errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
  });
  await page.goto('/recite/not-a-page');
  await expect(page.getByRole('heading', { name: '这条小路，暂时还没有页面' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveCount(0);
  await expect(page.locator('nav [aria-current="page"]')).toHaveCount(0);
  await page.getByRole('link', { name: '回到今日复述' }).click();
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('原有复述');
  expect(errors).toEqual([]);
});

test('refreshes cached source text at an equal revision after login without remounting the editor', async ({ page }) => {
  const data = fixture(); let renewed = false; let reads = 0;
  const errors = await offline(page, async (route, url) => {
    if (url.pathname === '/api/state') return json(route, { ...data, csrfToken: renewed ? 'renewed-token' : data.csrfToken });
    if (url.pathname === '/api/documents/document') { reads++; return json(route, { ...data.documents[0]!, text: renewed ? '重新授权后的原文' : '旧会话缓存原文' }); }
    if (url.pathname === '/api/recitations/recitation/draft') return json(route, { error: { code: 'UNAUTHENTICATED', message: '请重新登录' } }, 401);
    if (url.pathname === '/api/auth/login') { renewed = true; return json(route, { csrfToken: 'renewed-token' }); }
    errors.push(`Unexpected ${url.pathname}`); return json(route, {}, 500);
  });
  await page.goto('/recite');
  await page.locator('.source summary>span').first().click();
  await expect(page.locator('.source-content')).toContainText('旧会话缓存原文');
  const input = page.getByRole('textbox', { name: '今天学了什么', exact: true });
  await input.evaluate(element => { element.setAttribute('data-retained-editor', 'yes'); });
  await input.fill('重新登录也保留这段输入');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.getByLabel('访问密码').fill('offline-password');
  await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(input).toBeVisible(); await expect(input).toHaveValue('重新登录也保留这段输入');
  await expect(input).toHaveAttribute('data-retained-editor', 'yes');
  await expect(page.locator('.source-content')).toContainText('重新授权后的原文');
  await expect(page.locator('.source-content')).not.toContainText('旧会话缓存原文');
  expect(reads).toBe(2); expect(errors).toEqual([]);
});
