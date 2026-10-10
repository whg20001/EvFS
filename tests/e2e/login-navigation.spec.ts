import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { PublicState } from '@sanxing/contracts';
import { password, webOrigin } from './settings.ts';

// Uses only the fixed-port E2E host's in-memory mock repository. No model tasks,
// prior learning-loop state, private library, or real credentials are required.
async function state(page: Page): Promise<PublicState> {
  const response = await page.request.get('/api/state');
  expect(response.ok()).toBe(true);
  return response.json() as Promise<PublicState>;
}
async function seedDraft(page: Page) {
  const login = await page.request.post('/api/auth/login', { headers: { Origin: webOrigin }, data: { password } });
  expect(login.ok()).toBe(true);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const headers = () => ({ Origin: webOrigin, 'X-CSRF-Token': csrfToken, 'Idempotency-Key': randomUUID() });
  let data = await state(page);
  expect(data.mode).toBe('mock');
  const learningDate = new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (!data.recitations.some(item => item.learningDate === learningDate)) {
    const created = await page.request.post('/api/recitations', { headers: headers(), data: { learningDate } });
    expect(created.ok()).toBe(true);
    data = await state(page);
  }
  const recitation = data.recitations.find(item => item.learningDate === learningDate)!;
  const learned = '登录导航回归：服务端原有草稿';
  const saved = await page.request.put(`/api/recitations/${recitation.id}/draft`, {
    headers: headers(), data: { version: recitation.version, learned, unclear: '', application: '', topic: '独立导航回归' },
  });
  expect(saved.ok()).toBe(true);
  return { id: recitation.id, learned };
}

async function holdReturnNavigation(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route('**/recite?*', async route => {
    if (route.request().headers().rsc !== '1') return route.continue();
    // Obtain the real RSC response first, then hold delivery with an explicit
    // barrier. No timing sleeps, API stubs, or synthetic navigation are used.
    const response = await route.fetch();
    held = true;
    await gate;
    await route.fulfill({ response });
  });
  return { release, wait: () => expect.poll(() => held).toBe(true) };
}

for (const existingCookie of [false, true]) {
  test(existingCookie ? 'valid cookie visiting login returns automatically without exposing a transient editor' : 'login keeps the mounted editor inert until the return navigation commits', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const draft = await seedDraft(page);
    if (!existingCookie) await page.context().clearCookies();
    const navigation = await holdReturnNavigation(page);
    try {
      await page.goto('/login');
      if (!existingCookie) {
        await page.getByLabel('访问密码').fill(password);
        await page.getByRole('button', { name: '进入我的学习空间' }).click();
      }
      await navigation.wait();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('status').filter({ hasText: '正在返回学习空间…' })).toBeVisible();
      const shell = page.locator('.app-shell');
      await expect(shell).toHaveAttribute('hidden', '');
      await expect(shell).toHaveAttribute('inert', '');
      const retained = page.locator('textarea[aria-label="今天学了什么"]');
      await expect(retained).toHaveCount(1); // Retained, not conditionally unmounted.
      await expect(retained).toHaveValue(draft.learned);
      await expect(retained).toBeHidden();
      expect(await retained.evaluate(element => { element.focus(); return document.activeElement === element; })).toBe(false);
      await expect(page.getByRole('textbox', { name: '今天学了什么', exact: true })).toHaveCount(0);

      navigation.release();
      await expect(page).toHaveURL(/\/recite$/);
      await expect(shell).not.toHaveAttribute('inert', '');
      const learned = page.getByRole('textbox', { name: '今天学了什么', exact: true });
      const text = existingCookie ? '已有 Cookie 返回后保留的新输入' : '登录导航完成后保留的新输入';
      await learned.fill(text);
      await expect(learned).toHaveValue(text);
      const saved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/recitations/${draft.id}/draft`);
      await page.getByRole('button', { name: '保存草稿', exact: true }).click();
      expect((await saved).ok()).toBe(true);
      await expect.poll(async () => (await state(page)).recitations.find(item => item.id === draft.id)?.learned).toBe(text);
      await expect(learned).toHaveValue(text);
      expect(errors).toEqual([]);
    } finally { navigation.release(); }
  });
}
