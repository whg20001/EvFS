import { expect, test, type Page } from './test.ts';
import type { PublicState, RunProgress } from '@sanxing/contracts';

function fixture(): PublicState {
  const now = new Date().toISOString();
  return {
    mode: 'mock', timezone: 'UTC', revision: 1, csrfToken: 'offline-progress-csrf',
    capabilities: { maxUploadBytes: 131072, maxDocuments: 5, maxFollowups: 3, quizCount: 3, schedulingEnabled: true },
    recitations: [], documents: [], knowledge: [], quizzes: [], cards: [], reviewSessions: [], reviewEvents: [], evidence: [],
    sessions: [{ id: 'progress-session', recitationId: 'recitation', snapshot: { learned: '离线复述', topic: '', unclear: '', application: '' },
      documentIds: [], scopeVersion: 1, version: 1, status: 'CONFIRMING', candidates: [], turns: [], quizId: null, activeRunId: 'progress-run', completionReason: null, createdAt: now, completedAt: null }],
    runs: [{ id: 'progress-run', kind: 'extract', sessionId: 'progress-session', reviewSessionId: null, status: 'running', error: null, createdAt: now }],
  };
}
async function offline(page: Page) {
  const state = fixture();
  const progress: RunProgress = { phase: 'preparing', queuedMs: 1200, elapsedMs: 2000, totalTimeoutMs: 60_000 };
  let releaseState!: () => void;
  const delayedState = new Promise<void>(resolve => { releaseState = resolve; });
  const control = { progressAvailable: true, progressRequests: 0, unchanged: 0, cancelled: false, holdState: false, releaseState };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/auth/status') return json({ authenticated: true });
    if (url.pathname === '/api/ai/skills') return json({ mode: state.mode, items: [] });
    if (url.pathname === '/api/state') {
      if (control.holdState) await delayedState;
      if (url.searchParams.get('since') === String(state.revision)) { control.unchanged++; return json({ kind: 'unchanged', revision: state.revision, csrfToken: state.csrfToken }); }
      return json(state);
    }
    if (url.pathname === '/api/runs/progress') {
      control.progressRequests++;
      if (!control.progressAvailable) return json({ error: { code: 'TEMPORARY', message: 'Offline fixture unavailable' } }, 503);
      return json({ 'progress-run': progress });
    }
    if (url.pathname === '/api/runs/progress-run/cancel' && route.request().method() === 'POST') {
      control.cancelled = true;
      Object.assign(state.runs[0]!, { status: 'cancelled', error: '任务已取消，已提交的输入仍然保留。', progress: { ...progress, completedMs: progress.elapsedMs } });
      state.sessions[0]!.activeRunId = null; state.revision++;
      return json({ runId: 'progress-run' });
    }
    errors.push(`Unexpected API request: ${url.pathname}`);
    return json({ error: { code: 'FIXTURE_ONLY', message: 'Unsupported request' } }, 500);
  });
  await page.goto('/sessions/progress-session/ask');
  return { state, progress, control, errors, run: page.locator('.run-state') };
}

test('shows stage progress with an unchanged state revision, then preserves final timing after cancellation', async ({ page }) => {
  const f = await offline(page);
  await expect(f.run).toContainText('准备请求');
  await expect(f.run).toContainText('已用 2.0 秒');
  await expect(f.run).toContainText('排队 1.2 秒');
  f.progress.phase = 'waiting'; f.progress.elapsedMs = 5000; f.progress.requestStartedMs = 2000;
  await expect(f.run).toContainText('等待模型响应');
  f.progress.phase = 'generating'; f.progress.elapsedMs = 12_000; f.progress.firstResponseMs = 6000; f.progress.firstTextMs = 7000; f.progress.lastContentMs = 11_000;
  await expect(f.run).toContainText('正在生成'); await expect(f.run).toContainText('1.0 秒前收到内容');
  await expect(f.run).toContainText('生成总时限 60.0 秒');
  expect(f.state.revision).toBe(1); expect(f.control.unchanged).toBeGreaterThan(0);
  f.progress.phase = 'validating'; f.progress.elapsedMs = 13_000; f.progress.generationCompletedMs = 13_000;
  await expect(f.run).toContainText('校验结果');
  f.progress.phase = 'saving'; f.progress.elapsedMs = 15_000; f.progress.saveStartedMs = 14_000;
  await expect(f.run).toContainText('正在保存'); await expect(f.run).not.toContainText('生成总时限');
  await f.run.getByRole('button', { name: '取消', exact: true }).click();
  await expect(f.run).toContainText('已取消'); await expect(f.run).toContainText('已用 15.0 秒');
  await expect(f.run).toContainText('结束阶段：正在保存');
  await expect(f.run.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  expect(f.control.cancelled).toBe(true);
  const requests = f.control.progressRequests;
  // Prove active polling is cleaned up; no model or external network is used.
  await page.waitForTimeout(1500); expect(f.control.progressRequests).toBe(requests);
  expect(f.errors).toEqual([]);
});

test('falls back when transient progress is unavailable and recovers without hiding cancellation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await offline(page);
  await expect(f.run).toContainText('准备请求');
  f.control.progressAvailable = false;
  await expect(f.run).toContainText('处理中');
  await expect(f.run.getByRole('button', { name: '取消', exact: true })).toBeEnabled();
  await expect(f.run).not.toContainText('已用');
  f.control.progressAvailable = true; f.progress.phase = 'generating'; f.progress.elapsedMs = 80_000;
  f.progress.totalTimeoutMs = 120_000; f.progress.lastContentMs = 79_000;
  await expect(f.run).toContainText('已用 80.0 秒');
  await expect(f.run).toContainText('生成总时限 120.0 秒');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/agent-progress-mobile.png', fullPage: true });
  expect(f.errors).toEqual([]);
});


test('keeps progress polling responsive while a database state snapshot is delayed', async ({ page }) => {
  const f = await offline(page);
  await expect(f.run).toContainText('准备请求');
  f.control.holdState = true;
  try {
    f.progress.phase = 'saving'; f.progress.elapsedMs = 61_000; f.progress.saveStartedMs = 60_000;
    await expect(f.run).toContainText('正在保存'); await expect(f.run).toContainText('已用 61.0 秒');
    f.progress.elapsedMs = 70_000;
    await expect(f.run).toContainText('已用 70.0 秒');
    f.progress.elapsedMs = 80_000;
    await expect(f.run).toContainText('已用 80.0 秒');
    expect(f.errors).toEqual([]);
  } finally { f.control.holdState = false; f.control.releaseState(); }
});
