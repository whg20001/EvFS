import { expect, test, type Page } from './test.ts';
import type { PublicState } from '@sanxing/contracts';
import { password } from './settings.ts';
import { acknowledgeFeedback, answerDialog } from './dialog.ts';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page.locator('.home-roundel > img')).toBeVisible();
}

test('v3 roundel, command palette, shared input and real note attachments', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page.locator('.home-roundel > img')).toHaveJSProperty('complete', true);
  expect(await page.locator('.home-roundel > img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1600);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.home-art-credit')).toContainText('宋 · 佚名 · 团扇 · 绢本设色');
  await expect(page.locator('.title-slip, .issue-briefings, .issue-signature')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '每日三省首页' })).toHaveCount(1);
  await page.screenshot({ path: 'test-results/v3-home-desktop.png', fullPage: true });

  await page.keyboard.press('Control+k');
  const menu = page.getByRole('dialog', { name: '全部模块' });
  await expect(menu).toBeVisible();
  await menu.getByLabel('搜索模块').fill('复习计划');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole('heading', { name: '让记忆，再深一点' })).toBeVisible();
  await page.getByRole('link', { name: '每日三省首页' }).click();
  await expect(page.locator('.home-roundel > img')).toBeVisible();

  const learned = '今天我学习了独立回忆：合上笔记，用自己的话提取所学，再核对遗漏。';
  const input = page.getByRole('combobox', { name: '学习输入' });
  await input.fill(learned);
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(page).toHaveURL(/\/$/);
  await expect(input).toHaveValue(learned);
  await input.press('Enter');
  await expect(page).toHaveURL(/\/recite$/);
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue(new RegExp(learned));
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: /哪里还说不清/ }).click();
  await expect(input).toHaveCount(0);
  await page.getByRole('textbox', { name: '哪里还说不清', exact: true }).fill('为什么提取记忆比重复阅读更有效？');
  await expect(page.getByRole('textbox', { name: '哪里还说不清', exact: true })).toHaveValue('为什么提取记忆比重复阅读更有效？');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();

  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: 'v3-redesign-note.md', mimeType: 'text/markdown', buffer: Buffer.from('# 独立回忆\n先回忆，再核对。') });
  await expect(page.getByText('v3-redesign-note.md', { exact: true })).toBeVisible();
  await acknowledgeFeedback(page, ['导入成功']);
  const pasted = '独立回忆需要反复提取并核对原始笔记。'.repeat(30);
  await page.getByRole('button', { name: '直接粘贴笔记', exact: true }).click();
  await page.getByLabel('资料名称', { exact: true }).fill('粘贴的笔记.md');
  await page.getByLabel('笔记原文', { exact: true }).fill(pasted);
  await page.getByRole('button', { name: '保存粘贴资料', exact: true }).click();
  await expect(page.getByText('粘贴的笔记.md', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '每日三省首页' }).click();
  await input.fill('复习');
  await expect(page.getByRole('listbox', { name: '输入意图' })).toBeVisible();
  await input.press('Escape'); await input.press('Enter');
  await expect(page).toHaveURL(/\/recite$/);
  await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveValue(/\n\n复习$/);
  await expect(input).toHaveCount(0);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/v3-recite-desktop.png', fullPage: true });
  // Earlier learning tests may have left today's session open. End that test
  // fixture through the UI before starting a new submission of the same day.
  const snapshot = await (await page.request.get('/api/state?compact=1')).json() as PublicState;
  const unfinished = snapshot.sessions.findLast(session => session.status !== 'COMPLETED');
  if (unfinished) {
    await page.goto(`/sessions/${unfinished.id}/ask`);
    const finish = page.getByRole('button', { name: '结束本次学习', exact: true });
    await expect(finish).toBeEnabled(); await finish.click();
    await answerDialog(page, true);
    await expect.poll(async () => {
      const next = await (await page.request.get('/api/state?compact=1')).json() as PublicState;
      return next.sessions.find(session => session.id === unfinished.id)?.status;
    }).toBe('COMPLETED');
    await page.goto('/recite');
    await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '提交复述', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeVisible();
  for (const checkbox of await page.getByRole('checkbox', { name: /纳入这个知识点/ }).all()) await checkbox.check();
  await page.getByRole('button', { name: '确认学习范围' }).click();
  await expect(page.getByRole('textbox', { name: '追问回答' })).toBeVisible();
  await expect(input).toHaveCount(0);
  await page.getByRole('textbox', { name: '追问回答' }).fill('提取记忆会暴露遗漏，核对之后就能针对薄弱的地方继续学习。');
  await expect(page.getByRole('textbox', { name: '追问回答' })).toHaveValue('提取记忆会暴露遗漏，核对之后就能针对薄弱的地方继续学习。');
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束追问，准备测验' })).toBeEnabled();
  await page.getByRole('button', { name: '结束追问，准备测验' }).click();
  await page.getByRole('link', { name: '开始 / 继续测验' }).click();
  await expect(page.locator('.options .option').first()).toBeVisible();
  await page.locator('.options .option').first().click();
  await expect(page.getByLabel('我的回答', { exact: true })).toBeVisible();
  await page.getByLabel('我的回答', { exact: true }).fill('在不看笔记时解释一个概念，先回忆，再核对。');
  await expect(page.getByLabel('我的回答', { exact: true })).toHaveValue('在不看笔记时解释一个概念，先回忆，再核对。');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('v3 mobile modules, dark theme and reduced motion remain usable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page);
  await page.screenshot({ path: 'test-results/v3-home-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/v3-home-dark.png', fullPage: true });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '切换浅色模式' }).click();
  for (const route of ['/', '/recite', '/review', '/knowledge', '/week', '/weak', '/ai-access']) {
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), route).toBe(true);
  }
  await page.getByRole('button', { name: '全部模块' }).click();
  await page.getByRole('dialog', { name: '全部模块' }).getByRole('button', { name: /学习足迹/ }).click();
  await expect(page).toHaveURL(/\/history$/);
  await page.screenshot({ path: 'test-results/v3-history-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('roundel geometry, date breakpoint and all three daily paintings match the updated handoff', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-26T04:42:00Z') });
  await login(page);
  const roundel = page.locator('.home-roundel');
  for (const { width, height } of [
    { width: 320, height: 1000 },
    { width: 390, height: 844 },
    { width: 759, height: 1000 },
    { width: 760, height: 1000 },
    { width: 1024, height: 1000 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 844, height: 390 },
    { width: 1000, height: 1000 },
  ]) {
    await page.setViewportSize({ width, height });
    const box = (await roundel.boundingBox())!;
    // The stable scrollbar gutter also reserves space when the page is short.
    const contentWidth = await page.evaluate(() => document.body.clientWidth);
    expect(Math.abs(box.width - Math.min(width, height) * .618), `diameter at ${width}×${height}px`).toBeLessThan(1);
    expect(Math.abs(box.width - box.height), `circle at ${width}px`).toBeLessThan(1);
    expect(Math.abs(box.x + box.width / 2 - contentWidth / 2), `centering at ${width}px`).toBeLessThan(1);
    await expect(roundel).toHaveCSS('border-radius', '50%');
    if (width < 760) {
      await expect(page.locator('.home-vertical').first()).toBeHidden();
      await expect(page.locator('.issue-dateline')).toBeVisible();
    } else {
      await expect(page.locator('.home-vertical').first()).toBeVisible();
      await expect(page.locator('.issue-dateline')).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `overflow at ${width}px`).toBe(true);
    if (width === 1440 || width === 390) await page.screenshot({ path: `test-results/v3-home-${width === 1440 ? 'desktop' : 'mobile'}.png`, fullPage: true });
  }
  const artworks = [
    { day: '2026-10-26', file: 'lizhi.jpg', title: '紫荔山禽' },
    { day: '2026-10-27', file: 'quezhu.jpg', title: '梅竹双雀' },
    { day: '2026-10-28', file: 'pipa.jpg', title: '枇杷八哥' },
  ];
  for (const artwork of artworks) {
    await page.clock.setFixedTime(new Date(`${artwork.day}T04:42:00Z`));
    await page.reload();
    const image = page.locator('.home-roundel > img');
    await expect(image).toHaveAttribute('src', `/design/${artwork.file}`);
    await expect(image).toHaveJSProperty('complete', true);
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1600);
    await expect(page.locator('.home-art-credit')).toContainText(artwork.title);
  }
});

test('topbar centers the navigation on the page with unequal side groups and scrolls on phones', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-26T01:35:00Z') });
  await login(page);
  await expect(page.locator('.home-vertical').last()).toHaveText('巳时三刻');
  await expect(page.locator('.home-vertical').last()).toHaveAttribute('title', '巳时 · 九时三十五分');
  const trail = page.getByRole('navigation', { name: '今日轨迹' });
  const brand = page.getByRole('link', { name: '每日三省首页' });
  const tools = page.locator('.journal-tools');
  for (const [title, path] of [
    ['AI 配置', '/ai-access'], ['复习计划', '/review'], ['我的知识库', '/knowledge'],
    ['本周复盘', '/week'], ['薄弱知识点', '/weak'], ['学习足迹', '/history'], ['本地资料库', '/library'],
  ]) {
    await page.getByRole('button', { name: '全部模块', exact: true }).click();
    await page.getByRole('dialog', { name: '全部模块' }).getByRole('button', { name: new RegExp(title!) }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(trail.locator(`a[href="${path}"]`)).toBeVisible();
  }
  await expect(trail.locator('a')).toHaveCount(7);
  for (const width of [1920, 1440, 1100, 1024, 760, 641, 640, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const navBox = (await trail.boundingBox())!;
    const brandBox = (await brand.boundingBox())!;
    const toolsBox = (await tools.boundingBox())!;
    const contentWidth = await page.evaluate(() => document.body.clientWidth);
    expect(brandBox.x + brandBox.width, `brand collision at ${width}px`).toBeLessThanOrEqual(navBox.x + 1);
    expect(navBox.x + navBox.width, `actions collision at ${width}px`).toBeLessThanOrEqual(toolsBox.x + 1);
    if (width > 640) {
      expect(Math.abs(navBox.x + navBox.width / 2 - contentWidth / 2), `navigation centering at ${width}px`).toBeLessThan(1);
      expect(Math.abs(brandBox.width - toolsBox.width)).toBeGreaterThan(20);
      expect(navBox.width).toBeLessThanOrEqual(width * .5 + 1);
    } else {
      await expect(trail).toHaveCSS('justify-content', 'flex-start');
      const scroll = await trail.evaluate(element => {
        element.scrollLeft = element.scrollWidth;
        return { left: element.scrollLeft, width: element.clientWidth, content: element.scrollWidth };
      });
      expect(scroll.content).toBeGreaterThan(scroll.width);
      expect(scroll.left).toBeGreaterThan(0);
      await expect(page.getByRole('button', { name: '全部模块', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `page overflow at ${width}px`).toBe(true);
    if (width === 1440 || width === 390) await page.screenshot({ path: `test-results/v3-topbar-${width === 1440 ? 'desktop' : 'mobile'}.png`, fullPage: true });
  }
});
