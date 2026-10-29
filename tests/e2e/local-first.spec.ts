import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { LIMITS, type AppData } from '@sanxing/contracts';
import { password } from './settings.ts';
import { acknowledgeFeedback, answerDialog, autoAcceptDialogs } from './dialog.ts';
import { syntheticPdf } from '../fixtures/pdf.ts';

async function register(page: Page, username: string) {
  await page.goto('/recite');
  await page.getByRole('button', { name: '首次使用，创建账号', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '创建账号并进入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
}
async function login(page: Page, username: string) {
  await page.goto('/recite'); await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('访问密码').fill(password); await page.getByRole('button', { name: '进入我的学习空间', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
}
async function state(page: Page): Promise<AppData> {
  const status = await (await page.request.get('/api/auth/status')).json() as { user: { id: string } };
  return page.evaluate(async id => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(`sanxing-learning-v1:${id}:mock`, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<AppData>((resolve, reject) => { const request = database.transaction('state', 'readonly').objectStore('state').get('app'); request.onsuccess = () => resolve(request.result as AppData); request.onerror = () => reject(request.error); }); }
    finally { database.close(); }
  }, status.user.id);
}
async function logout(page: Page) {
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await answerDialog(page, true);
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
}
test('resumes a previous-day draft with its attachments after closing the tab, and submits under the original date', async ({ page }) => {
  const errors: string[] = [];
  const modelCalls: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.context().on('request', request => { if (new URL(request.url()).pathname === '/api/gateway/execute') modelCalls.push(request.url()); });
  await page.clock.setFixedTime(new Date('2026-10-26T04:00:00Z'));
  await register(page, 'cross-day-draft');
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByLabel('今日主题', { exact: true }).fill('昨天没说完的理解');
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('YESTERDAY_DRAFT 独立回忆可以帮助理解知识。');
  await page.getByRole('tab', { name: /哪里还说不清/ }).click();
  await page.getByRole('textbox', { name: '哪里还说不清', exact: true }).fill('如何判断自己真的理解了？');
  await page.getByRole('tab', { name: /明天怎么用上/ }).click();
  await page.getByRole('textbox', { name: '明天怎么用上', exact: true }).fill('明天再用自己的话解释一次。');
  await expect.poll(async () => Object.values((await state(page)).recitations)[0]?.application).toBe('明天再用自己的话解释一次。');
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'draft-reference.md', mimeType: 'text/markdown', buffer: Buffer.from('# DRAFT_ATTACHMENT\n不看笔记独立回忆，然后核对参考资料。') });
  await acknowledgeFeedback(page, ['导入成功']);
  const old = Object.values((await state(page)).recitations)[0]!;
  expect(old.learningDate).toBe('2026-10-26'); expect(old.documentIds).toHaveLength(1);
  expect(modelCalls).toHaveLength(0);

  const previousTab = page;
  page = await page.context().newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-10-27T04:00:00Z'));
  await previousTab.close();
  await page.goto('/recite');
  await expect(page.getByRole('button', { name: '开始今天的三省', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '继续之前的草稿' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('还有 1 份复述草稿未提交。')).toBeVisible();
  await page.getByRole('link', { name: '继续编辑' }).click();
  await expect(page.getByRole('heading', { name: '草稿箱', exact: true })).toBeVisible();
  await expect(page.locator('.draft-card')).toHaveCount(1);
  await expect(page.locator('.draft-card')).toContainText('2026-10-26');
  await expect(page.locator('.draft-card')).toContainText('1 份参考资料');
  await page.screenshot({ path: 'test-results/drafts-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/drafts-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole('link', { name: '今日复述', exact: true }).click();
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('TODAY_DRAFT 第二天的独立内容。');
  await expect.poll(async () => Object.values((await state(page)).recitations).find(item => item.learningDate === '2026-10-27')?.learned).toBe('TODAY_DRAFT 第二天的独立内容。');
  await page.getByRole('link', { name: '草稿箱 · 2', exact: true }).click();
  const card = page.locator('.draft-card').filter({ hasText: '昨天没说完的理解' });
  await card.getByRole('link', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/recite/${old.id}$`));
  await expect(page.locator('.draft-origin')).toContainText('提交后仍归属于这一天');
  await expect(page.getByLabel('今日主题', { exact: true })).toHaveValue('昨天没说完的理解');
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('YESTERDAY_DRAFT 独立回忆可以帮助理解知识。');
  await expect(page.getByText('draft-reference.md', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /哪里还说不清/ }).click();
  await expect(page.getByRole('textbox', { name: '哪里还说不清', exact: true })).toHaveValue('如何判断自己真的理解了？');
  await page.getByRole('tab', { name: /明天怎么用上/ }).click();
  await expect(page.getByRole('textbox', { name: '明天怎么用上', exact: true })).toHaveValue('明天再用自己的话解释一次。');
  await page.getByRole('tab', { name: /今天学了什么/ }).click();
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('RESUMED_DRAFT 不看笔记独立回忆，再对照资料检查理解。');
  await expect.poll(async () => (await state(page)).recitations[old.id]?.learned).toContain('RESUMED_DRAFT');
  await page.reload();
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('RESUMED_DRAFT 不看笔记独立回忆，再对照资料检查理解。');
  expect(modelCalls).toHaveLength(0);
  await page.getByRole('button', { name: '提交复述', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/ask$/);
  await expect(page.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeVisible();
  const saved = await state(page);
  const session = Object.values(saved.sessions).find(item => item.recitationId === old.id)!;
  expect(session.snapshot.learned).toContain('RESUMED_DRAFT');
  expect(session.documentIds).toEqual(old.documentIds);
  expect(saved.recitations[old.id]?.learningDate).toBe('2026-10-26');
  expect(Object.values(saved.recitations).find(item => item.learningDate === '2026-10-27')?.learned).toBe('TODAY_DRAFT 第二天的独立内容。');
  await page.getByRole('button', { name: '全部模块', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索模块', exact: true }).fill('draft');
  await page.getByRole('button', { name: /草稿箱/ }).click();
  await expect(page.locator('.draft-card')).toHaveCount(1);
  await expect(page.locator('.draft-card')).toContainText('TODAY_DRAFT');
  await expect(page.getByRole('heading', { name: '昨天没说完的理解', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keeps the open editor across midnight, saves it before switching days and safely handles a missing draft', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-27T15:59:00Z'));
  await register(page, 'midnight-draft');
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  const original = Object.values((await state(page)).recitations)[0]!;
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('MIDNIGHT_DRAFT 我还在继续编辑。');
  await page.clock.setFixedTime(new Date('2026-10-27T16:01:00Z'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('heading', { name: '继续复述', exact: true })).toBeVisible();
  await expect(page.locator('.draft-origin')).toContainText('2026-10-27');
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('MIDNIGHT_DRAFT 我还在继续编辑。');
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('MIDNIGHT_DRAFT 零点过后还没保存的修改。');
  await page.getByRole('button', { name: '切换到今日复述', exact: true }).click();
  await acknowledgeFeedback(page, ['请先保存当前复述草稿']);
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('MIDNIGHT_DRAFT 零点过后还没保存的修改。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => (await state(page)).recitations[original.id]?.learned).toContain('MIDNIGHT_DRAFT');
  await page.getByRole('button', { name: '切换到今日复述', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('');
  expect(Object.values((await state(page)).recitations).map(item => item.learningDate).sort()).toEqual(['2026-10-27', '2026-10-28']);
  await page.goto('/recite/missing-other-account-draft');
  await expect(page.getByRole('heading', { name: '没有找到这份复述', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '返回草稿箱', exact: true }).click();
  await expect(page.locator('.draft-card')).toHaveCount(1);
  await expect(page.locator('.draft-card')).toContainText('MIDNIGHT_DRAFT');
});

test('keeps notes and attachments local, then completes learning through an explicit stateless gateway task', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const requests: { path: string; body: string }[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, body: request.postData() ?? '' }); });
  await register(page, 'local-learning');
  await autoAcceptDialogs(page);
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  const note = 'PRIVATE_DEVICE_NOTE 独立回忆是在不看笔记时重新提取知识';
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill(note);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).recitations)[0]?.learned).toBe(note);
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'device-only.md', mimeType: 'text/markdown', buffer: Buffer.from('# PRIVATE_LOCAL_ATTACHMENT\n先独立回忆，再核对。') });
  await expect(page.getByText('device-only.md', { exact: true })).toBeVisible();
  expect(requests.filter(request => /PRIVATE_DEVICE_NOTE|PRIVATE_LOCAL_ATTACHMENT/.test(request.body))).toEqual([]);
  expect(requests.some(request => /\/api\/(recitations|documents|state|library)/.test(request.path))).toBe(false);
  expect((await page.request.get('/api/state')).status()).toBe(404);
  await page.reload(); await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue(note);
  await page.getByRole('button', { name: '提交复述', exact: true }).click();
  const checks = page.getByRole('checkbox', { name: /纳入这个知识点/ });
  await expect(checks.first()).toBeVisible();
  for (const checkbox of await checks.all()) await checkbox.check();
  await page.getByRole('button', { name: '确认学习范围', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束追问，准备测验' })).toBeEnabled();
  await page.getByRole('button', { name: '结束追问，准备测验' }).click();
  await page.getByRole('link', { name: '开始 / 继续测验' }).click();
  await expect(page.locator('.options .option').first()).toBeVisible(); await page.locator('.options .option').first().click();
  await page.getByLabel('我的回答', { exact: true }).fill('先合上笔记独立回忆关键概念，再核对来源和适用条件。');
  await page.getByRole('button', { name: '正式提交', exact: true }).click();
  await expect(page.locator('.options .option').first()).toBeVisible(); await page.locator('.options .option').first().click();
  await page.getByRole('button', { name: '完成测验，查看结果' }).click();
  await expect(page.getByRole('heading', { name: '这一次的努力，已被记录。' })).toBeVisible();
  const data = await state(page);
  expect(Object.values(data.quizzes)[0]?.submittedAt).toBeTruthy();
  expect(Object.values(data.runs).filter(run => run.status === 'succeeded').length).toBeGreaterThanOrEqual(4);
  const uploads = requests.filter(request => /PRIVATE_DEVICE_NOTE|PRIVATE_LOCAL_ATTACHMENT/.test(request.body));
  expect(uploads.length).toBeGreaterThan(0); expect(uploads.every(request => request.path === '/api/gateway/execute')).toBe(true);
  expect(errors).toEqual([]);
});
test('isolates accounts on one device and keeps the same cloud account empty on a second device', async ({ page, browser }) => {
  await register(page, 'device-alice');
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('ALICE_PRIVATE_LOCAL 学习数据');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).recitations)[0]?.learned).toBe('ALICE_PRIVATE_LOCAL 学习数据');
  await logout(page); await register(page, 'device-bob');
  expect(Object.keys((await state(page)).recitations)).toHaveLength(0);
  await expect(page.getByText(/ALICE_PRIVATE_LOCAL/)).toHaveCount(0);
  await logout(page); await login(page, 'device-alice');
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('ALICE_PRIVATE_LOCAL 学习数据');
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try { const device = await other.newPage(); await login(device, 'device-alice'); expect(Object.keys((await state(device)).recitations)).toHaveLength(0); }
  finally { await other.close(); }
});
test('exports, clears and restores the local database and installs a cloud Skill locally', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await register(page, 'local-backups');
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('LOCAL_BACKUP_NOTE 需要保留的笔记');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).recitations)[0]?.learned).toBe('LOCAL_BACKUP_NOTE 需要保留的笔记');
  await page.goto('/ai-access');
  const region = page.getByRole('region', { name: '学习 Skill', exact: true });
  await region.getByRole('tab', { name: '云 Skill', exact: true }).click();
  await region.getByRole('button', { name: '下载到本地 remote-examples', exact: true }).click();
  await expect(region.getByRole('button', { name: '已下载 remote-examples', exact: true })).toBeDisabled();
  expect((await state(page)).skills).toHaveLength(1);
  await acknowledgeFeedback(page);
  await page.goto('/local-data');
  await expect(page.getByRole('heading', { name: '本地数据与备份', exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '导出学习备份', exact: true }).click();
  const file = await downloading; const path = await file.path(); const backup = await readFile(path!, 'utf8');
  expect(backup).toContain('LOCAL_BACKUP_NOTE'); expect(backup).toContain('remote-examples'); expect(backup).not.toMatch(/csrfToken|SESSION_SECRET|access_token/);
  await acknowledgeFeedback(page, ['备份已生成']);
  await page.getByRole('button', { name: '清空本地学习数据', exact: true }).click(); await answerDialog(page, true);
  await expect.poll(async () => Object.keys((await state(page)).recitations).length).toBe(0);
  await acknowledgeFeedback(page, ['已清空']);
  await page.getByLabel('选择 JSON 备份（最大 256 MiB）').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await answerDialog(page, true);
  await expect.poll(async () => Object.values((await state(page)).recitations)[0]?.learned).toBe('LOCAL_BACKUP_NOTE 需要保留的笔记');
  expect((await state(page)).skills).toHaveLength(1);
  await acknowledgeFeedback(page, ['备份已导入']);
  await page.getByLabel('选择 JSON 备份（最大 256 MiB）').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":2}') });
  await answerDialog(page, true);
  await expect(page.getByRole('alertdialog').filter({ hasText: '备份格式、版本或运行模式不兼容' })).toBeVisible();
  expect(Object.values((await state(page)).recitations)[0]?.learned).toBe('LOCAL_BACKUP_NOTE 需要保留的笔记');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/local-data-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('keeps browser data authoritative when two tabs edit the same draft', async ({ page }) => {
  await register(page, 'local-tabs');
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  const other = await page.context().newPage();
  try {
    await other.goto('/recite'); await expect(other.getByRole('textbox', { name: '今天学了什么', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('FIRST_TAB_SAVED');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect.poll(async () => Object.values((await state(page)).recitations)[0]?.learned).toBe('FIRST_TAB_SAVED');
    await other.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('SECOND_TAB_UNSAVED');
    await other.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: '未保存 · 自动保存已暂停' })).toBeVisible();
    expect(Object.values((await state(page)).recitations)[0]?.learned).toBe('FIRST_TAB_SAVED');
    await expect(other.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('SECOND_TAB_UNSAVED');
  } finally { await other.close(); }
});
test('locks other tabs after logout without deleting their saved local data', async ({ page }) => {
  await register(page, 'local-logout');
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('PRESERVED_AFTER_LOGOUT');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(async () => Object.values((await state(page)).recitations)[0]?.learned).toBe('PRESERVED_AFTER_LOGOUT');
  const other = await page.context().newPage();
  try {
    await other.goto('/recite'); await expect(other.getByRole('textbox', { name: '今天学了什么', exact: true })).toBeVisible();
    await logout(page);
    await expect(other.getByLabel('用户名', { exact: true })).toBeVisible();
    await expect(other.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveCount(0);
    await login(other, 'local-logout');
    await expect(other.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue('PRESERVED_AFTER_LOGOUT');
  } finally { await other.close(); }
});
test('parses a PDF and downloads its exact original bytes without uploading it', async ({ page }) => {
  const calls: string[] = []; page.on('request', request => { if (request.url().includes('/api/')) calls.push(new URL(request.url()).pathname); });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await register(page, 'local-pdf'); await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  const bytes = syntheticPdf(['PRIVATE_PDF_TEXT first page.', 'Second page remains local.']);
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'local-only.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByText('local-only.pdf', { exact: true })).toBeVisible();
  const document = Object.values((await state(page)).documents)[0]!;
  expect(document.text).toContain('PRIVATE_PDF_TEXT'); expect(document.import?.format === 'pdf' ? document.import.pages : undefined).toHaveLength(2);
  await acknowledgeFeedback(page, ['导入成功']);
  await page.getByText('local-only.pdf', { exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '下载原始 PDF', exact: true }).click();
  const download = await downloading; expect(await readFile((await download.path())!)).toEqual(bytes);
  expect(calls.some(path => /\/api\/(documents|recitations|gateway\/execute)/.test(path))).toBe(false);
  expect(errors).toEqual([]);
});
test('refuses unavailable local storage instead of pretending an in-memory save succeeded', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }); });
  await page.goto('/recite'); await page.getByRole('button', { name: '首次使用，创建账号', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill('storage-disabled'); await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '创建账号并进入', exact: true }).click();
  await expect(page.getByRole('alertdialog').filter({ hasText: '浏览器无法打开本地数据库' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始今天的三省', exact: true })).toHaveCount(0);
});

test('shows file import progress and retry errors, accepts larger PDFs, and keeps the topic full width', async ({ page }) => {
  const calls: string[] = []; const errors: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) calls.push(new URL(request.url()).pathname); });
  page.on('pageerror', error => errors.push(error.message));
  await register(page, 'file-import-progress'); await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  const topic = page.getByLabel('今日主题', { exact: true }); const editor = page.getByRole('textbox', { name: '今天学了什么', exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await topic.fill('今日主题占满当前输入区域');
    const topicBox = (await topic.boundingBox())!, editorBox = (await editor.boundingBox())!;
    expect(Math.abs(topicBox.x - editorBox.x)).toBeLessThan(1); expect(Math.abs(topicBox.width - editorBox.width)).toBeLessThan(1);
    await expect(topic).toHaveCSS('outline-style', 'none'); await expect(topic).toHaveCSS('border-top-width', '0px');
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: /拖放笔记到这里，或点击上传/ }).click();
  await (await chooser).setFiles({ name: 'retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from('invalid pdf') });
  await expect(page.getByRole('alertdialog', { name: '文件导入失败' })).toContainText('无法读取此 PDF');
  await acknowledgeFeedback(page);
  expect(Object.keys((await state(page)).documents)).toHaveLength(0);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/pdfjs/pdf.worker.min.mjs', async route => { await gate; await route.continue(); });
  const bytes = syntheticPdf(['Large PDF first page.', 'Second page.', 'Third page.'], 612, 12_000_000);
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'retry.pdf', mimeType: 'application/pdf', buffer: bytes });
  try {
    await expect(page.locator('.file-import-status.working')).toContainText('正在加载 PDF 解析器');
    await expect(page.getByRole('progressbar', { name: '文件导入进度' })).toBeVisible();
    await expect(page.locator('.upload-zone')).toBeDisabled();
    await page.screenshot({ path: 'test-results/file-import-progress.png', fullPage: true });
  } finally { release(); }
  await acknowledgeFeedback(page, ['导入成功']);
  await expect(page.getByRole('progressbar', { name: '文件导入进度' })).toHaveCount(0);
  await expect(page.getByText('retry.pdf', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/file-import-mobile.png', fullPage: true });
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'too-big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(LIMITS.pdfUploadBytes + 1) });
  await acknowledgeFeedback(page, ['PDF 不能超过 20 MB']);
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'too-big.png', mimeType: 'image/png', buffer: Buffer.alloc(LIMITS.imageUploadBytes + 1) });
  await acknowledgeFeedback(page, ['图片不能超过 10 MB']);
  expect(calls.some(path => /\/api\/(documents|recitations|ocr\/recognize|gateway\/execute)/.test(path))).toBe(false);
  expect(errors).toEqual([]);
});

test('explains PDF page and text limits in a single masked notice and preserves the draft', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await register(page, 'pdf-limit-notices'); await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByLabel('今日主题').fill('保留我的主题'); await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const upload = page.getByLabel('上传笔记、PDF 或图片'); const zone = page.locator('.upload-zone');
  const left = (await zone.boundingBox())!.x;
  await upload.setInputFiles({ name: 'Harness Engineering.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(Array.from({ length: 101 }, () => 'Page text.')) });
  const notice = page.getByRole('alertdialog', { name: '文件导入失败', exact: true });
  await expect(notice).toContainText('此 PDF 共 101 页'); await expect(notice).toContainText('上限 100 页');
  await expect(notice).toContainText('20 MB 是文件大小上限'); await expect(page.getByRole('alertdialog')).toHaveCount(1);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  expect(Math.abs((await zone.boundingBox())!.x - left)).toBeLessThan(1);
  await expect(notice.getByRole('button', { name: '知道了' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(notice.getByRole('button', { name: '知道了' })).toBeFocused();
  await page.screenshot({ path: 'test-results/pdf-page-limit-notice.png' });
  await page.keyboard.press('Escape'); await expect(notice).toHaveCount(0);
  expect(await page.locator('.app-shell').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  await upload.setInputFiles({ name: 'text-heavy.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(['oversized '.repeat(30_000)], 10_000_000) });
  await expect(notice).toContainText('解析到第 1 页'); await expect(notice).toContainText('200,000 字符');
  await expect(notice).not.toContainText('上限 100 页');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/pdf-text-limit-notice-mobile.png' });
  await acknowledgeFeedback(page); await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(Object.keys((await state(page)).documents)).toHaveLength(0);
  await expect(page.getByLabel('今日主题')).toHaveValue('保留我的主题'); expect(errors).toEqual([]);
});

test('deduplicates matching errors and queues different masked notices without blocking the page after dismissal', async ({ page }) => {
  await register(page, 'notice-queue'); let same = true; let failures = 0;
  for (const [path, message] of [['gateway/catalog', '模型目录读取失败'], ['ai/access', '授权列表读取失败']]) await page.route(`**/api/${path}`, route => {
    failures++; return route.fulfill({ status: 503, json: { error: { code: 'OFFLINE_FAILURE', message: same ? '相同的连接错误' : message } } });
  });
  await page.goto('/ai-access'); await expect.poll(() => failures).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('alertdialog')).toHaveCount(1); await acknowledgeFeedback(page, ['相同的连接错误']);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  same = false; failures = 0; await page.reload(); await expect.poll(() => failures).toBeGreaterThanOrEqual(2);
  const messages: string[] = [];
  for (let i = 0; i < 2; i++) {
    const notice = page.getByRole('alertdialog'); await expect(notice).toHaveCount(1); messages.push(await notice.innerText());
    await acknowledgeFeedback(page);
  }
  expect(messages.join('\n')).toContain('模型目录读取失败'); expect(messages.join('\n')).toContain('授权列表读取失败');
  await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(await page.locator('.app-shell').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  await page.getByRole('button', { name: '全部模块', exact: true }).click(); await expect(page.getByRole('dialog', { name: '全部模块', exact: true })).toBeVisible();
});

test('shows the matching admin dashboard, manages users, and blocks ordinary accounts', async ({ page, browser }, info) => {
  const managedUsername = `managed-user-${info.repeatEachIndex}`;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, 'admin');
  await page.getByRole('button', { name: '全部模块', exact: true }).click();
  await page.getByRole('button', { name: /管理后台 用户、活动、服务器与平台 AI/ }).click();
  await expect(page.getByRole('heading', { name: /管理后台/ })).toBeVisible();
  await expect(page.getByText('用户总数', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/admin-overview-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  await page.getByRole('button', { name: '创建用户', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建用户', exact: true });
  await dialog.getByLabel('用户名', { exact: true }).fill(managedUsername);
  await dialog.getByLabel('初始密码').fill(password);
  await dialog.getByRole('button', { name: '创建用户', exact: true }).click();
  await expect(page.getByRole('button', { name: `管理 ${managedUsername}`, exact: true })).toBeVisible();
  await acknowledgeFeedback(page, ['用户已保存']);
  await page.getByRole('button', { name: `管理 ${managedUsername}`, exact: true }).click();
  const edit = page.getByRole('dialog', { name: `管理 ${managedUsername}`, exact: true });
  await edit.getByLabel('每日网关调用上限').fill('8');
  await edit.getByLabel('允许使用平台 AI').uncheck();
  await edit.getByRole('button', { name: '保存用户设置', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await acknowledgeFeedback(page, ['用户已保存']);
  await expect(page.getByRole('row').filter({ hasText: managedUsername })).toContainText('上限 8');
  await page.getByRole('button', { name: '服务器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务运行指标' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/admin-server-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  const users = page.getByRole('region', { name: '用户列表', exact: true });
  await expect(users).toBeVisible();
  await expect(users.getByRole('row').filter({ hasText: managedUsername })).toContainText('上限 8');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await users.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const normal = await other.newPage(); await login(normal, managedUsername);
    expect((await normal.request.get('/api/admin/users')).status()).toBe(403);
    await normal.goto('/admin'); await expect(normal.getByRole('heading', { name: '此页面仅对管理员开放' })).toBeVisible();
    await normal.getByRole('button', { name: '全部模块', exact: true }).click();
    await expect(normal.getByRole('button', { name: /管理后台 用户、活动/ })).toHaveCount(0);
  } finally { await other.close(); }
  expect(errors).toEqual([]);
});

test('configures platform AI once and lets a user explicitly select it for a local learning task', async ({ page, browser }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, 'admin'); await page.goto('/admin');
  await page.getByRole('button', { name: '平台 AI', exact: true }).click();
  await page.getByLabel('服务名称', { exact: true }).fill('三省云端 AI');
  await page.getByRole('combobox', { name: '平台 Provider', exact: true }).selectOption('openai');
  await page.getByRole('combobox', { name: '平台模型', exact: true }).selectOption('gpt-4.1-mini');
  await page.getByLabel('平台 API key', { exact: true }).fill('E2E_PRIVATE_PLATFORM_KEY_NEVER_SENT_LIVE');
  await page.getByLabel('向已开通的用户提供平台 AI').check();
  await page.getByRole('button', { name: '保存平台 AI 配置', exact: true }).click();
  await acknowledgeFeedback(page, ['平台 AI 配置已保存']);
  await expect(page.getByText('配置版本 1', { exact: true })).toBeVisible();
  await expect(page.getByLabel('平台 API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('三省云端 AI');
  await page.screenshot({ path: 'test-results/admin-platform-ai-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const normal = await other.newPage(); await register(normal, 'platform-learner'); await normal.goto('/ai-access');
    await normal.getByRole('radio', { name: /使用平台 AI/ }).check();
    await expect(normal.getByText('三省云端 AI', { exact: true }).first()).toBeVisible();
    await normal.getByRole('button', { name: '保存候选模型', exact: true }).click();
    await expect.poll(async () => (await state(normal)).aiModel?.authMethod).toBe('platform');
    await normal.reload(); await expect(normal.getByRole('radio', { name: /使用平台 AI/ })).toBeChecked();
    const catalog = await normal.request.get('/api/gateway/catalog'); expect(await catalog.text()).not.toContain('E2E_PRIVATE_PLATFORM_KEY');
    await normal.goto('/recite'); await autoAcceptDialogs(normal);
    await normal.getByRole('button', { name: '开始今天的三省', exact: true }).click();
    await normal.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('PLATFORM_LOCAL_NOTE 用自己的语言复述有助于发现理解的缺口。');
    await normal.getByRole('button', { name: '提交复述', exact: true }).click();
    await expect(normal.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeVisible();
    expect(Object.values((await state(normal)).runs).some(run => run.status === 'succeeded')).toBe(true);
  } finally { await other.close(); }
  await page.getByRole('button', { name: '活动记录', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'platform-learner' })).toContainText('平台 AI');
  expect(errors).toEqual([]);
});

for (const format of ['zip', '7z']) test(`imports a ${format} Skill archive locally and sends it only after an explicit task choice`, async ({ page }) => {
  const calls: { path: string; body: string }[] = []; const errors: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) calls.push({ path: new URL(request.url()).pathname, body: request.postData() ?? '' }); });
  page.on('pageerror', error => errors.push(error.message));
  await register(page, `archive-${format}`); await page.goto('/ai-access');
  const region = page.getByRole('region', { name: '学习 Skill', exact: true });
  await expect(region.getByRole('button', { name: '选择文件', exact: true })).toBeVisible();
  await region.getByLabel('导入 Skill 文件或压缩包', { exact: true }).setInputFiles(`tests/fixtures/skill-example.${format}`);
  await expect(region.getByRole('heading', { name: '导入预览 · archive-examples', exact: true })).toBeVisible();
  await expect(region.getByText('参考文本 · references/guide.md', { exact: true })).toBeVisible();
  await expect(region.getByText('未导入附带文件：scripts/run.sh', { exact: true })).toBeVisible();
  if (format === 'zip') await page.screenshot({ path: 'test-results/skill-archive-preview.png', fullPage: true });
  await region.getByRole('button', { name: '确认导入 Skill', exact: true }).click(); await acknowledgeFeedback(page, ['Skill 已保存']);
  await region.getByRole('group', { name: '适用任务 · archive-examples' }).getByRole('checkbox', { name: '知识提取', exact: true }).check();
  await region.getByRole('button', { name: '启用 archive-examples', exact: true }).click();
  await expect(region.getByText('可供选择', { exact: true })).toBeVisible();
  expect(calls.filter(call => /ARCHIVE_REFERENCE|用反例帮助理解边界/.test(call.body))).toEqual([]);
  const saved = (await state(page)).skills![0]!; expect(saved.document.resources).toEqual([{ path: 'references/guide.md', text: 'ARCHIVE_REFERENCE 先判断条件，再给出反例。' }]);
  await page.goto('/recite'); await autoAcceptDialogs(page);
  await expect(page.locator('.composer-placement')).toHaveCount(0);
  await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('先明确概念的适用条件，再用反例检查理解的边界。');
  const picker = page.getByRole('button', { name: '知识提取使用的 Skill，未选择', exact: true });
  await picker.click(); const menu = page.getByRole('dialog', { name: '知识提取 Skill 选择' });
  await expect(menu.getByRole('checkbox', { name: /archive-examples/ })).not.toBeChecked();
  await menu.getByRole('checkbox', { name: /archive-examples/ }).check();
  if (format === 'zip') await page.screenshot({ path: 'test-results/skill-task-picker.png' });
  await menu.getByRole('button', { name: '完成', exact: true }).click();
  const sending = page.waitForRequest(request => request.url().endsWith('/api/gateway/execute'));
  await page.getByRole('button', { name: '提交复述', exact: true }).click(); const request = await sending;
  expect(request.postDataJSON().task.skills).toMatchObject([{ id: saved.id, version: saved.version, resources: saved.document.resources }]);
  await expect(page.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeVisible();
  for (const check of await page.getByRole('checkbox', { name: /纳入这个知识点/ }).all()) await check.check();
  await expect(page.getByRole('button', { name: '追问使用的 Skill，未选择', exact: true })).toBeVisible();
  const followup = page.waitForRequest(request => request.url().endsWith('/api/gateway/execute'));
  await page.getByRole('button', { name: '确认学习范围', exact: true }).click();
  expect((await followup).postDataJSON().task.skills).toEqual([]);
  const uploads = calls.filter(call => /ARCHIVE_REFERENCE|用反例帮助理解边界/.test(call.body)); expect(uploads.length).toBeGreaterThan(0); expect(uploads.every(call => call.path === '/api/gateway/execute')).toBe(true);
  expect(errors).toEqual([]);
});

test('uses paper themed pickers and scrollbars and keeps the composer only on the homepage', async ({ page }) => {
  await register(page, 'styled-controls'); await expect(page.locator('.composer-placement')).toHaveCount(0);
  await page.goto('/'); await expect(page.getByRole('combobox', { name: '学习输入', exact: true })).toBeVisible();
  await page.goto('/ai-access'); await expect(page.locator('.composer-placement')).toHaveCount(0);
  const provider = page.getByRole('combobox', { name: 'Provider', exact: true });
  await provider.click();
  expect(await page.evaluate(() => CSS.supports('appearance', 'base-select'))).toBe(true);
  await expect(provider).toHaveCSS('appearance', 'base-select');
  expect(await provider.evaluate(element => getComputedStyle(element, '::picker(select)').borderRadius)).toBe('8px');
  await page.screenshot({ path: 'test-results/provider-picker-light.png' }); await page.keyboard.press('Escape');
  const light = await page.locator('html').evaluate(element => getComputedStyle(element).scrollbarColor);
  await page.getByRole('button', { name: '切换深色模式', exact: true }).click();
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).scrollbarColor)).not.toBe(light);
  await provider.click(); await page.screenshot({ path: 'test-results/provider-picker-dark.png' }); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('imports multiple nested Skills from one archive with each reference bound to its own Skill', async ({ page }) => {
  await register(page, 'multiple-skills'); await page.goto('/ai-access');
  const region = page.getByRole('region', { name: '学习 Skill', exact: true });
  await region.getByLabel('导入 Skill 文件或压缩包', { exact: true }).setInputFiles('tests/fixtures/skill-multiple.zip');
  await expect(region.getByRole('heading', { name: '导入预览 · root-method', exact: true })).toBeVisible();
  await expect(region.getByText('参考文本 · references/root.md', { exact: true })).toBeVisible();
  await expect(region.getByText('参考文本 · nested/references/nested.md', { exact: true })).toHaveCount(0);
  const entries = region.getByRole('combobox', { name: '压缩包内的 Skill', exact: true });
  await entries.selectOption('nested/SKILL.md');
  await expect(region.getByRole('heading', { name: '导入预览 · nested-method', exact: true })).toBeVisible();
  await expect(region.getByText('参考文本 · references/nested.md', { exact: true })).toBeVisible();
  await region.getByRole('button', { name: '确认导入 Skill', exact: true }).click(); await acknowledgeFeedback(page, ['Skill 已保存']);
  await entries.selectOption('SKILL.md');
  await expect(region.getByRole('heading', { name: '导入预览 · root-method', exact: true })).toBeVisible();
  await region.getByRole('button', { name: '确认导入 Skill', exact: true }).click(); await acknowledgeFeedback(page, ['Skill 已保存']);
  const skills = (await state(page)).skills!; expect(skills).toHaveLength(2);
  expect(skills.find(skill => skill.document.name === 'nested-method')!.document.resources).toEqual([{ path: 'references/nested.md', text: 'NESTED_REFERENCE 只属于嵌套 Skill。' }]);
  expect(skills.find(skill => skill.document.name === 'root-method')!.document.resources).toEqual([{ path: 'references/root.md', text: 'ROOT_REFERENCE 只属于根 Skill。' }]);
});

test('recognizes an uploaded image, saves only after review, and preserves the original through local backup restore', async ({ page }) => {
  const errors: string[] = []; const calls: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.url().includes('/api/')) calls.push(new URL(request.url()).pathname); });
  const bytes = await readFile('tests/fixtures/ocr-note.png');
  await register(page, 'image-notes'); await page.getByRole('button', { name: '开始今天的三省', exact: true }).click();
  await page.getByLabel('上传笔记、PDF 或图片', { exact: true }).setInputFiles('tests/fixtures/ocr-note.png');
  const dialog = page.getByRole('dialog', { name: '图片文字识别', exact: true });
  await expect(dialog.getByLabel('校对识别文字', { exact: true })).toHaveValue('OFFLINE_OCR_NOTE Learning through recall.');
  expect(Object.keys((await state(page)).documents)).toHaveLength(0);
  const corrected = '校对后的图片文字：独立回忆可以暴露理解缺口。';
  await dialog.getByLabel('校对识别文字', { exact: true }).fill(corrected);
  await page.screenshot({ path: 'test-results/image-ocr-desktop.png' });
  await dialog.getByRole('button', { name: '确认导入图片资料', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('ocr-note.png', { exact: true })).toBeVisible();
  let document = Object.values((await state(page)).documents)[0]!;
  expect(document.text).toBe(corrected); expect(document.import).toMatchObject({ format: 'image', parser: 'bbc-ocr', edited: true, reviewed: true });
  expect(Buffer.from(document.originalBase64, 'base64')).toEqual(bytes);
  expect(calls.filter(path => path === '/api/ocr/recognize')).toHaveLength(1);
  expect(calls.some(path => /\/api\/(documents|recitations|gateway\/execute)/.test(path))).toBe(false);
  await acknowledgeFeedback(page, ['导入成功']);
  await page.getByText('ocr-note.png', { exact: true }).click();
  await expect(page.getByAltText('原始图片：ocr-note.png', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载原始图片', exact: true }).click(); expect(await readFile((await (await download).path())!)).toEqual(bytes);
  await page.goto('/local-data'); const backupDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出学习备份', exact: true }).click();
  const backup = await readFile((await (await backupDownload).path())!, 'utf8'); expect(backup).toContain(corrected); expect(backup).not.toContain('OCR_SERVICE_TOKEN');
  await acknowledgeFeedback(page, ['备份已生成']);
  await page.getByRole('button', { name: '清空本地学习数据', exact: true }).click(); await answerDialog(page, true);
  await expect.poll(async () => Object.keys((await state(page)).documents).length).toBe(0);
  await acknowledgeFeedback(page, ['已清空']);
  await page.getByLabel('选择 JSON 备份（最大 256 MiB）').setInputFiles({ name: 'image-backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) }); await answerDialog(page, true);
  await expect.poll(async () => Object.keys((await state(page)).documents).length).toBe(1);
  await acknowledgeFeedback(page, ['备份已导入']);
  document = Object.values((await state(page)).documents)[0]!; expect(document.text).toBe(corrected); expect(Buffer.from(document.originalBase64, 'base64')).toEqual(bytes);
  await page.reload(); expect(Object.values((await state(page)).documents)[0]!.import).toMatchObject({ format: 'image', reviewed: true });
  expect(errors).toEqual([]);
});

test('supports OCR from the homepage on mobile, retries failures and cancels without importing the image', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let attempts = 0;
  await page.route('**/api/ocr/recognize', route => { attempts++; return attempts === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OCR_UNAVAILABLE', message: '图片识别服务暂不可用，请稍后重试。' } }) }) : route.continue(); });
  await register(page, 'image-mobile'); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByLabel('输入框上传笔记', { exact: true }).setInputFiles('tests/fixtures/ocr-note.png');
  const dialog = page.getByRole('dialog', { name: '图片文字识别', exact: true });
  await acknowledgeFeedback(page, ['图片识别服务暂不可用']);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => !!element.closest('[inert]'))).toBe(false);
  expect(Object.keys((await state(page)).documents)).toHaveLength(0);
  await dialog.getByRole('button', { name: '重试识别', exact: true }).click();
  await expect(dialog.getByLabel('校对识别文字', { exact: true })).toHaveValue('OFFLINE_OCR_NOTE Learning through recall.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/image-ocr-mobile.png' });
  await dialog.getByRole('button', { name: '取消导入', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(Object.keys((await state(page)).documents)).toHaveLength(0); expect(attempts).toBe(2); expect(errors).toEqual([]);
});
