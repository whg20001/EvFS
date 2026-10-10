import { expect, test, type Page } from '@playwright/test';
import type { PublicState } from '@sanxing/contracts';
import { password } from './settings.ts';
import { autoAcceptDialogs } from './dialog.ts';

async function login(page: Page) {
  await page.goto('/recite');
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page).toHaveURL(/\/recite$/);
  await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
}
async function state(page: Page): Promise<PublicState> {
  const response = await page.request.get('/api/state'); expect(response.ok()).toBeTruthy(); return response.json() as Promise<PublicState>;
}
async function confirmScope(page: Page) {
  await expect(page.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeVisible();
  for (const checkbox of await page.getByRole('checkbox', { name: /纳入这个知识点/ }).all()) await checkbox.check();
  await page.getByRole('button', { name: '确认学习范围' }).click();
  await expect(page.getByRole('button', { name: '结束追问，准备测验' })).toBeEnabled();
}
async function answerQuiz(page: Page, skipShort = false) {
  await expect(page.locator('.options .option').first()).toBeVisible();
  await page.locator('.options .option').first().click();
  await expect(page.getByLabel('我的回答', { exact: true })).toBeVisible();
  if (skipShort) await page.getByRole('button', { name: '跳过这题' }).click();
  else {
    const text = '独立回忆是合上笔记后提取知识，例如向同伴解释概念，再核对遗漏。';
    await page.getByLabel('我的回答', { exact: true }).fill(text);
    await page.getByRole('button', { name: '暂存答案' }).click();
    const saved = (await state(page)).quizzes.at(-1)!;
    expect(saved.questions[1]!.answer).toBeNull(); expect(saved.questions[1]!.draft).toBe(text);
    await page.reload(); await expect(page.getByLabel('我的回答', { exact: true })).toHaveValue(text);
    await page.getByRole('button', { name: '正式提交' }).click();
  }
  await expect(page.locator('.options .option').first()).toBeVisible();
  await page.locator('.options .option').first().click();
  await page.getByRole('button', { name: '完成测验，查看结果' }).click();
  await expect(page.getByRole('heading', { name: '这一次的努力，已被记录。' })).toBeVisible();
}

test('real UI → API → Pi faux Provider learning and review loop', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await autoAcceptDialogs(page);
  await login(page);
  await expect(page.getByText('演示模式 · 脚本化回答，不代表真实学习评价', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始今天的三省' }).click();
  const learned = '独立回忆是在不看笔记时用自己的话重新提取知识。';
  await page.getByLabel('今日主题').fill('学习方法');
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill(learned);
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue(learned);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => (await state(page)).recitations.at(-1)!.learned).toBe(learned);
  await page.getByLabel('上传 TXT 或 Markdown 笔记').setInputFiles({ name: '学习笔记.md', mimeType: 'text/markdown', buffer: Buffer.from(`# 学习笔记\n${learned}`) });
  await expect(page.getByText('学习笔记.md', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue(learned);
  await page.getByRole('button', { name: '提交复述', exact: true }).click();
  await confirmScope(page);

  // Old unanswered turns must never become the editor for a newly revised scope.
  const priorScope = (await state(page)).sessions.at(-1)!.scopeVersion;
  await page.getByRole('button', { name: '补充资料与调整学习范围' }).click();
  await page.getByRole('button', { name: '确认更新范围' }).click();
  await confirmScope(page);
  const session = (await state(page)).sessions.at(-1)!;
  expect(session.scopeVersion).toBeGreaterThan(priorScope);
  expect(session.turns.at(-1)!.scopeVersion).toBe(session.scopeVersion);
  await expect(page.getByLabel('追问回答')).toHaveAttribute('id', `reply-${session.turns.at(-1)!.id}`);
  await page.getByLabel('追问回答').fill('我会合上笔记，尝试把关键概念教给别人，再检查条件是否完整。');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束追问，准备测验' })).toBeEnabled();
  await page.getByRole('button', { name: '结束追问，准备测验' }).click();
  await page.getByRole('link', { name: '开始 / 继续测验' }).click();
  const quiz = (await state(page)).quizzes.at(-1)!;
  expect(quiz.questionCount).toBe(3); expect(quiz.questions).toHaveLength(1);
  expect(quiz.questions[0]).not.toHaveProperty('correctIndex'); expect(quiz.questions[0]).not.toHaveProperty('rubric');
  await answerQuiz(page);
  await page.getByRole('main').getByRole('link', { name: '查看复习计划', exact: true }).click();
  await page.getByRole('button', { name: /^全部 / }).click();
  await page.getByRole('button', { name: '提前复习', exact: true }).first().click();
  await page.getByLabel('独立回忆').fill('不翻笔记提取概念，用具体例子说明，最后核对遗漏。');
  await page.getByRole('button', { name: '提交回忆，开始检验' }).click();
  await page.getByRole('link', { name: '继续复习测验' }).click();
  await answerQuiz(page, true);
  await page.getByRole('link', { name: '返回单卡复习，完成排期' }).click();
  await page.getByRole('button', { name: '完成本次复习' }).click();
  await expect(page.getByRole('heading', { name: '这次复习，已好好收下。' })).toBeVisible();
  await page.reload();
  const final = await state(page);
  expect(final.reviewEvents).toHaveLength(1); expect(final.reviewEvents[0]!.simulated).toBe(true);
  expect(final.sessions[0]!.snapshot.learned).toBe(learned);
  expect(errors).toEqual([]);
});

test('login, save and logout work when HTTP LAN access has no randomUUID', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
  const keys: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && ['POST', 'PUT', 'DELETE'].includes(request.method())) keys.push(request.headers()['idempotency-key'] ?? '');
  });
  await autoAcceptDialogs(page);
  await login(page);
  const start = page.getByRole('button', { name: '开始今天的三省' });
  if (await start.isVisible()) await start.click();
  await page.getByLabel('今日主题').fill('局域网 HTTP 兼容性验证');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  expect((await state(page)).recitations.at(-1)!.topic).toBe('局域网 HTTP 兼容性验证');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeVisible();
  expect(keys.length).toBeGreaterThanOrEqual(3);
  for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(keys).size).toBe(keys.length);
});

test('confirm stays disabled when two accepted candidates reuse one knowledge point', async ({ page }) => {
  // Today's knowledge point is created by the learning-loop test above.
  await autoAcceptDialogs(page);
  await login(page);
  const learned = page.getByRole('textbox', { name: '今天学了什么', exact: true });
  await expect(learned).toBeVisible();
  const text = '热点键过期会造成击穿。大量请求同时重建缓存。';
  await learned.fill(text);
  await expect(learned).toHaveValue(text);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => (await state(page)).recitations.at(-1)!.learned).toBe(text);
  await page.getByRole('button', { name: '提交复述', exact: true }).click();
  const boxes = page.getByRole('checkbox', { name: /纳入这个知识点/ });
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const selects = page.getByLabel('知识点归属');
  const existing = '复用：独立回忆是在不看笔记时用自己的话重新提取知识';
  await selects.nth(0).selectOption({ label: existing });
  await expect(page.getByText('多个候选归入了同一个已有知识点。请改为新建，或只保留一项。')).toHaveCount(0);
  await selects.nth(1).selectOption({ label: existing });
  await expect(page.getByText('多个候选归入了同一个已有知识点。请改为新建，或只保留一项。')).toBeVisible();
  const confirm = page.getByRole('button', { name: '确认学习范围' });
  await expect(confirm).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('多个候选归入了同一个已有知识点。请改为新建，或只保留一项。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await selects.nth(1).selectOption({ label: '创建新的知识点' });
  await expect(page.getByText('多个候选归入了同一个已有知识点。请改为新建，或只保留一项。')).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole('button', { name: '结束追问，准备测验' })).toBeEnabled();
});

test('mobile login, navigation and learning editor fit a small viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/recite-mobile.png', fullPage: true });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '学习足迹' }).click();
  await expect(page.getByRole('main')).toContainText('学习');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
