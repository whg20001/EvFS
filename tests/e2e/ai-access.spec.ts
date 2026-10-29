import { expect, test, type Page } from './test.ts';
import { tokenUsageHeatmap } from '@sanxing/ai-usage';
import type { AiAccessOverview, AiConnectionTestView, AiModelConfiguration, AiModelSelection, TokenUsageHeatmap } from '@sanxing/contracts';
import { password } from './settings.ts';
import { acknowledgeFeedback, answerDialog, autoAcceptDialogs } from './dialog.ts';

test.use({ actionTimeout: 20_000 });

async function openModule(page: Page, name: string) {
  await page.getByRole('button', { name: '全部模块', exact: true }).click();
  await page.getByRole('dialog', { name: '全部模块', exact: true }).getByRole('button', { name: new RegExp(`^${name} `) }).click();
}
async function login(page: Page) {
  await page.goto('/recite'); await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
  await openModule(page, 'AI 配置');
  await expect(page.locator('.journal-stage h1')).toHaveText('AI 配置');
}
async function openAuthorization(page: Page) {
  await page.getByRole('button', { name: /^添加授权/ }).click();
  await page.getByLabel('选择要授权的 Provider', { exact: true }).selectOption('anthropic');
}
async function requestCode(page: Page) {
  await openAuthorization(page);
  await page.getByRole('button', { name: '开始授权', exact: true }).click();
  await page.getByLabel('选择授权方式', { exact: true }).selectOption('copy_code');
  await page.getByRole('button', { name: '提交授权信息', exact: true }).click();
  await expect(page.getByLabel('测试授权码', { exact: true })).toBeVisible();
}

test('AI settings choose models explicitly, preserve conflicts, and use the offline Pi OAuth bridge', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await autoAcceptDialogs(page);
  const submitted: { promptId: string; value: string }[] = [];
  page.on('request', request => { if (/\/api\/ai\/oauth\/sessions\/[^/]+\/input$/.test(request.url())) submitted.push(request.postDataJSON() as { promptId: string; value: string }); });
  let modelReads = 0;
  page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/api/ai/configuration')) modelReads++; });
  await login(page);
  await expect(page.getByLabel('Provider', { exact: true })).toHaveValue('');
  await expect(page.getByText('未设置应用预算', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/选择存于当前模式的学习数据库/)).toHaveCount(0);
  await expect(page.getByText(/所有真实模型调用都会向所选厂商发送任务资料/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Anthropic（离线测试）', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始授权', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '浏览器与 WSL 授权提示', exact: true })).toHaveCount(0);
  const configuration = await (await page.request.get('/api/ai/configuration')).json() as AiModelConfiguration;
  const anthropic = configuration.providers.find(provider => provider.id === 'anthropic')!;
  const codex = configuration.providers.find(provider => provider.id === 'openai-codex')!;
  await page.getByLabel('Provider', { exact: true }).selectOption(codex.id);
  await page.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  await page.getByLabel('模型', { exact: true }).selectOption(codex.models[0]!.id);
  await expect(page.getByRole('checkbox', { name: /上游输出token硬上限/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存候选模型', exact: true })).toBeDisabled();
  await page.getByLabel('Provider', { exact: true }).selectOption(anthropic.id);
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('认证方式', { exact: true })).toHaveValue('');
  await page.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  await page.getByLabel('模型', { exact: true }).selectOption(anthropic.models[0]!.id);
  await expect(page.getByRole('heading', { name: 'Token 使用热力图' })).toBeVisible();
  const usage = await (await page.request.get('/api/ai/usage')).json() as TokenUsageHeatmap;
  await expect(page.getByRole('region', { name: /年每日 token 用量/ }).getByRole('button')).toHaveCount(usage.days.length);
  await requestCode(page);
  await expect(page.getByRole('link', { name: /打开厂商授权页/ })).toHaveAttribute('href', /^https:\/\/claude\.ai\//);
  await page.getByLabel('测试授权码', { exact: true }).fill('offline-test-code');
  await page.getByRole('button', { name: '提交授权信息', exact: true }).click();
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(page.getByLabel('选择要授权的 Provider', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^测试 .* 连接$/ })).toBeDisabled();
  expect(submitted.map(value => value.value)).toEqual(['copy_code', 'offline-test-code']);
  expect(submitted[0]!.promptId).not.toBe(submitted[1]!.promptId);
  const overview = await (await page.request.get('/api/ai/access')).json() as AiAccessOverview;
  expect(overview.mode).toBe('mock'); expect(JSON.stringify(overview)).not.toContain('offline-test-access-token');
  // OAuth connection refresh must retain the model draft rather than selecting a default.
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue(anthropic.models[0]!.id);
  const save = page.getByRole('button', { name: '保存候选模型', exact: true });
  await expect(save).toBeEnabled(); await save.click();
  await expect(save).toBeEnabled();
  expect((await (await page.request.get('/api/ai/configuration')).json() as AiModelConfiguration).selection).toMatchObject({ providerId: 'anthropic', modelId: anthropic.models[0]!.id, authMethod: 'oauth' });
  await page.getByLabel('模型', { exact: true }).selectOption(anthropic.models[1]!.id);
  const state = await (await page.request.get('/api/state')).json() as { csrfToken: string };
  const otherWindow = await (await page.request.get('/api/ai/configuration')).json() as AiModelConfiguration;
  const revisionChange = await page.request.post('/api/ai/configuration', { data: { expectedRevision: otherWindow.revision, ...otherWindow.selection! }, headers: { origin: new URL(page.url()).origin, 'x-csrf-token': state.csrfToken, 'idempotency-key': `model-revision-test-${Date.now()}` } });
  expect(revisionChange.status()).toBe(200);
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.getByText('模型配置保存成功', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue(anthropic.models[1]!.id);
  await expect(save).toBeDisabled();
  const reads = modelReads;
  const oauthRefresh = page.waitForResponse(response => response.url().endsWith('/api/ai/access') && response.request().method() === 'GET');
  await page.getByRole('button', { name: '刷新授权状态', exact: true }).click(); await oauthRefresh;
  await expect(page.getByRole('button', { name: '刷新授权状态', exact: true })).toBeEnabled();
  expect(modelReads).toBe(reads);
  await page.getByRole('button', { name: '刷新模型配置', exact: true }).click();
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue(anthropic.models[0]!.id);
  await page.getByLabel('模型', { exact: true }).selectOption(anthropic.models[1]!.id);
  await save.click(); await expect(save).toBeEnabled();
  expect((await (await page.request.get('/api/ai/configuration')).json() as AiModelConfiguration).selection?.modelId).toBe(anthropic.models[1]!.id);
  await page.getByRole('button', { name: /^断开 .* 连接$/ }).click();
  await expect(page.getByRole('heading', { name: 'Anthropic（离线测试）', exact: true })).toHaveCount(0);
  await expect(page.getByText('尚无已连接的 Provider，可展开“添加授权”。', { exact: true })).toBeVisible();
  await requestCode(page);
  await page.getByLabel('测试授权码', { exact: true }).fill('never-persist-this-code');
  await openModule(page, '今日复述');
  await expect(page.getByRole('button', { name: '开始今天的三省' })).toBeEnabled();
  await openModule(page, 'AI 配置');
  await openAuthorization(page);
  await expect(page.getByLabel('测试授权码', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('never-persist-this-code');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeVisible(); expect(errors).toEqual([]);
});

test('connected cards require confirmation for probes and show safe outcomes without automatic resubmission', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const providerId = 'openai-codex'; const providerName = 'Codex（连接测试离线场景）';
  let selection: AiModelSelection;
  let latest: AiConnectionTestView | null = null;
  let outcome: 'succeeded' | 'failed' | 'running' = 'succeeded';
  let polls = 0; let usageReads = 0; let cancelled = 0;
  const submissions: { confirm: boolean; expectedSelection: AiModelSelection }[] = [];
  await page.route('**/api/ai/access', route => route.fulfill({ json: { mode: 'live', notice: '', providers: [
    { id: providerId, name: providerName, connected: true, expiresAt: '2099-01-01T00:00:00Z', oauthAvailable: true, session: null },
    { id: 'openai', name: '未授权且应隐藏的 Provider', connected: false, expiresAt: null, oauthAvailable: true, session: null },
  ] } satisfies AiAccessOverview }));
  await page.route('**/api/ai/configuration', async route => {
    const original = await (await route.fetch()).json() as AiModelConfiguration;
    selection = { providerId, modelId: original.providers.find(provider => provider.id === providerId)!.models[0]!.id, authMethod: 'oauth', allowUnboundedOutput: true };
    await route.fulfill({ json: { ...original, mode: 'live', source: 'saved', selection, ready: true, problem: null,
      providers: original.providers.map(provider => ({ ...provider, oauthConnected: provider.id === providerId })) } satisfies AiModelConfiguration });
  });
  // Deliberately browser-only offline fixtures; no probe POST reaches a real model or the fixture API.
  await page.route(`**/api/ai/providers/${providerId}/test`, async route => {
    if (route.request().method() === 'POST') {
      submissions.push(route.request().postDataJSON() as { confirm: boolean; expectedSelection: AiModelSelection }); polls = 0;
      const createdAt = new Date(Date.UTC(2026, 3, 1) + submissions.length * 31_000).toISOString();
      latest = { id: `offline-probe-${submissions.length}`, providerId, modelId: selection.modelId, mode: 'live', status: 'running',
        createdAt, startedAt: createdAt, finishedAt: null, durationMs: null, usage: null, error: null };
      await route.fulfill({ status: 202, json: latest }); return;
    }
    if (latest?.status === 'running' && outcome !== 'running' && ++polls >= 2) {
      latest = { ...latest, status: outcome, finishedAt: new Date(Date.parse(latest.startedAt!) + 25).toISOString(), durationMs: 25,
        usage: outcome === 'succeeded' ? { provider: providerId, model: latest.modelId, inputTokens: 12, outputTokens: 7, cost: null } : null,
        error: outcome === 'failed' ? '连接测试超时；请求可能已经产生费用，请手动确认后再试。' : null };
    }
    await route.fulfill({ json: { test: latest } });
  });
  await page.route('**/api/runs/*/cancel', async route => {
    expect(route.request().method()).toBe('POST'); cancelled++;
    latest = { ...latest!, status: 'cancelled', finishedAt: latest!.createdAt, durationMs: 0, error: '测试已取消；上游可能仍有费用。' };
    await route.fulfill({ json: { runId: latest.id } });
  });
  await page.route('**/api/ai/usage*', route => {
    usageReads++;
    return route.fulfill({ json: tokenUsageHeatmap({ mode: 'live', timezone: 'UTC', year: 2026, now: new Date('2026-04-02T00:00:00Z'), runs: latest ? [latest] : [] }) });
  });
  await login(page);
  await expect(page.getByRole('heading', { name: providerName, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '未授权且应隐藏的 Provider', exact: true })).toHaveCount(0);
  const start = page.getByRole('button', { name: `测试 ${providerName} 连接`, exact: true });
  await expect(start).toBeEnabled(); expect(submissions).toHaveLength(0);
  await start.click(); await answerDialog(page, false); expect(submissions).toHaveLength(0);
  const before = usageReads;
  await start.click(); await answerDialog(page, true, [selection!.modelId, '不携带任何学习笔记', '费用']);
  await expect(page.getByText('本次连接测试成功', { exact: true })).toBeVisible();
  await expect.poll(() => usageReads).toBeGreaterThan(before);
  expect(submissions).toEqual([{ confirm: true, expectedSelection: selection! }]);
  await page.getByRole('button', { name: '刷新授权状态', exact: true }).click();
  await expect(start).toBeEnabled(); expect(submissions).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/ai-connection-mobile.png', fullPage: true });
  outcome = 'failed'; await start.click(); await answerDialog(page, true);
  await expect(page.getByText('本次连接测试失败', { exact: true })).toBeVisible();
  await expect(page.getByText(/连接测试超时；请求可能已经产生费用/)).toBeVisible();
  await expect(page.getByText(/token 用量未知，不代表 0 消耗/)).toBeVisible();
  await expect(start).toBeEnabled(); expect(submissions).toHaveLength(2);
  outcome = 'running'; await start.click(); await answerDialog(page, true);
  const cancel = page.getByRole('button', { name: `取消 ${providerName} 本次连接测试`, exact: true });
  await expect(cancel).toBeEnabled(); await cancel.click();
  await expect(page.getByText('本次测试已取消', { exact: true })).toBeVisible();
  expect(cancelled).toBe(1); expect(submissions).toHaveLength(3);
});

test('saved unavailable authorization does not interrupt other settings, while explicit changes still explain the missing credentials', async ({ page }) => {
  await page.route('**/api/ai/configuration', async route => {
    const configuration = await (await route.fetch()).json() as AiModelConfiguration;
    const provider = configuration.providers.find(item => item.models.length > 0)!;
    await route.fulfill({ json: { ...configuration, mode: 'mock', ready: true, source: 'saved',
      selection: { providerId: provider.id, modelId: provider.models[0]!.id, authMethod: 'oauth', allowUnboundedOutput: false },
      providers: configuration.providers.map(item => ({ ...item, oauthConnected: false, apiKeyAvailable: false })) } satisfies AiModelConfiguration });
  });
  await login(page);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const skills = page.getByRole('region', { name: '学习 Skill', exact: true });
  await skills.getByRole('tab', { name: '云 Skill', exact: true }).click();
  await expect(skills.getByRole('tab', { name: '云 Skill', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('认证方式', { exact: true }).selectOption('api_key');
  await expect(page.getByRole('alertdialog', { name: 'API key 尚未配置', exact: true })).toBeVisible();
  await acknowledgeFeedback(page, ['没有可用的 API key']);
  await expect(page.getByRole('button', { name: '保存候选模型', exact: true })).toBeDisabled();
});

test('mobile heatmap supports leap days, unknown usage and year switching without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/ai/usage*', async route => {
    const year = Number(new URL(route.request().url()).searchParams.get('year') ?? 2024);
    const body = tokenUsageHeatmap({ mode: 'mock', timezone: 'Asia/Shanghai', year, now: new Date('2024-03-01T00:00:00Z'), runs: [
      { startedAt: '2024-02-29T10:00:00Z', usage: { provider: 'faux', model: 'test', inputTokens: 100, outputTokens: 20, cost: 0 } },
      { startedAt: '2024-02-29T10:00:00Z', usage: null },
      { startedAt: '2023-01-01T10:00:00Z', usage: null },
    ] });
    await route.fulfill({ json: body });
  });
  await login(page);
  await expect(page.getByLabel('年份', { exact: true })).toHaveValue('2024');
  const calendar = page.getByRole('region', { name: /年每日 token 用量/ });
  await expect(calendar.getByRole('button')).toHaveCount(366);
  const leapDay = page.getByRole('button', { name: /^2024-02-29：/ });
  await expect(leapDay).toHaveAccessibleName(/已知总数 120 tokens.*未知用量 1 次/);
  await leapDay.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/ai-access-mobile.png', fullPage: true });
  await page.getByLabel('年份', { exact: true }).selectOption('2023');
  await expect(calendar.getByRole('button')).toHaveCount(365);
  await expect(page.getByRole('button', { name: /^2023-01-01：/ })).toHaveAccessibleName(/用量未知，不能视为零消耗/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('a model listed by an unauthorized provider points to the authorized provider and saves its output capability', async ({ page }) => {
  // Browser-only fixture: Codex is authorized, and its models are also listed under OpenAI with a separate authorization.
  let original: AiModelConfiguration;
  let saved: AiModelSelection | null = null;
  await page.route('**/api/ai/configuration', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as AiModelSelection & { expectedRevision: number };
      saved = { providerId: body.providerId, modelId: body.modelId, authMethod: body.authMethod, allowUnboundedOutput: body.allowUnboundedOutput };
      await route.fulfill({ json: { ...original, selection: saved, ready: true, source: 'saved', problem: null, revision: original.revision + 1,
        providers: original.providers.map(provider => ({ ...provider, oauthConnected: provider.id === 'openai-codex' })) } satisfies AiModelConfiguration });
      return;
    }
    original = await (await route.fetch()).json() as AiModelConfiguration;
    await route.fulfill({ json: { ...original, providers: original.providers.map(provider => ({ ...provider, oauthConnected: provider.id === 'openai-codex' })) } satisfies AiModelConfiguration });
  });
  await login(page);
  const configuration = await (await page.request.get('/api/ai/configuration')).json() as AiModelConfiguration;
  const shared = configuration.providers.find(provider => provider.id === 'openai-codex')!.models[0]!.id;
  const providerSelect = page.getByLabel('Provider', { exact: true });
  await expect(providerSelect.locator('option[value="openai-codex"]')).toHaveText(/OAuth 已授权$/);
  await expect(providerSelect.locator('option[value="openai"]')).not.toHaveText(/已授权/);
  await providerSelect.selectOption('openai');
  await page.getByLabel('模型', { exact: true }).selectOption(shared);
  await page.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  await expect(page.getByText(/授权不可互换/)).toBeVisible();
  await page.getByRole('button', { name: /^改用已授权的 / }).click();
  await expect(providerSelect).toHaveValue('openai-codex');
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue(shared);
  await expect(page.getByLabel('认证方式', { exact: true })).toHaveValue('oauth');
  await expect(page.getByText(/尚未 OAuth 授权/)).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /上游输出token硬上限/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存候选模型', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存候选模型', exact: true }).click();
  await acknowledgeFeedback(page, ['候选模型已保存']);
  expect(saved).toEqual({ providerId: 'openai-codex', modelId: shared, authMethod: 'oauth', allowUnboundedOutput: true });
  await page.screenshot({ path: 'test-results/ai-access-desktop.png', fullPage: true });
});

test('combines model and provider settings and announces success only after the live selection is saved', async ({ page }) => {
  let saved: AiModelSelection | null = null; let release!: () => void; let current: AiModelConfiguration;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/ai/configuration', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as AiModelSelection;
      await gate; saved = { providerId: body.providerId, modelId: body.modelId, authMethod: body.authMethod, allowUnboundedOutput: body.allowUnboundedOutput };
    } else current = await (await route.fetch()).json() as AiModelConfiguration;
    await route.fulfill({ json: { ...current, mode: 'live', selection: saved, source: saved ? 'saved' : 'none', ready: !!saved, revision: current.revision + (saved ? 1 : 0),
      providers: current.providers.map(provider => ({ ...provider, apiKeyAvailable: true })) } satisfies AiModelConfiguration });
  });
  await login(page);
  await acknowledgeFeedback(page, ['尚不能提交模型任务']);
  const module = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '模型与授权', exact: true }) });
  await expect(module.getByRole('heading', { name: '模型选择', exact: true })).toBeVisible();
  await expect(module.getByRole('heading', { name: 'Provider 授权', exact: true })).toBeVisible();
  const original = await (await page.request.get('/api/ai/configuration')).json() as AiModelConfiguration;
  const provider = original.providers.find(provider => provider.models.length > 0)!;
  await page.getByLabel('Provider', { exact: true }).selectOption(provider.id);
  await page.getByLabel('认证方式', { exact: true }).selectOption('api_key');
  await page.getByLabel('模型', { exact: true }).selectOption(provider.models[0]!.id);
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  try {
    await expect(page.getByRole('button', { name: '保存模型配置', exact: true })).toBeDisabled();
    await expect(page.getByText('模型配置保存成功', { exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('alertdialog', { name: '模型配置保存成功', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/model-save-success-notice.png' });
  await acknowledgeFeedback(page);
  expect(saved).toMatchObject({ providerId: provider.id });
  await module.screenshot({ path: 'test-results/model-authorization-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await module.screenshot({ path: 'test-results/model-authorization-mobile.png' });
  await page.getByLabel('模型', { exact: true }).selectOption(provider.models[0]!.id);
  await expect(page.getByText('模型配置保存成功', { exact: true })).toHaveCount(0);
});
