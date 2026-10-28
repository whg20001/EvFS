import { expect, test, type Page } from '@playwright/test';
import { password } from './settings.ts';
import { acknowledgeFeedback, answerDialog } from './dialog.ts';
import type { SkillSummary } from '@sanxing/contracts';

const skillFile = (body = '使用反例解释边界。<script>window.skillExecuted = true</script>') => ({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(`---\nname: browser-examples\ndescription: 浏览器导入学习方法\n---\n${body}`) });
async function open(page: Page) {
  await page.goto('/ai-access');
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page.getByRole('heading', { name: '学习 Skill', exact: true })).toBeVisible();
  await expect(page.getByLabel('导入 Skill 文件或压缩包')).toBeEnabled();
}
test('imports, scopes, enables, persists, replaces and deletes a local SKILL.md', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const region = page.getByRole('region', { name: '学习 Skill', exact: true });
  const input = region.getByLabel('导入 Skill 文件或压缩包');
  await input.setInputFiles(skillFile());
  await expect(region.getByRole('heading', { name: '导入预览 · browser-examples' })).toBeVisible();
  expect((await (await page.request.get('/api/ai/skills')).json()).items).toHaveLength(0);
  await region.getByRole('button', { name: '确认导入 Skill', exact: true }).click(); await acknowledgeFeedback(page, ['Skill 已保存']);
  await expect(region.getByText('未启用', { exact: true })).toBeVisible();
  const tasks = region.getByRole('group', { name: '适用任务 · browser-examples' });
  await tasks.getByRole('checkbox', { name: '知识提取', exact: true }).check();
  await tasks.getByRole('checkbox', { name: '评分', exact: true }).check();
  await region.getByRole('button', { name: '启用 browser-examples', exact: true }).click();
  await expect(region.getByText('可供选择', { exact: true })).toBeVisible();
  const skill = (await (await page.request.get('/api/ai/skills')).json()).items[0] as SkillSummary;
  expect(skill.tasks).toEqual(expect.arrayContaining(['extract', 'followup', 'quiz', 'grade']));
  await page.reload();
  await expect(region.getByText('可供选择', { exact: true })).toBeVisible();
  await region.getByRole('button', { name: '查看指令 · browser-examples', exact: true }).click();
  await expect(region.locator('pre')).toContainText('<script>window.skillExecuted = true</script>');
  expect(await page.evaluate(() => (window as unknown as { skillExecuted?: boolean }).skillExecuted)).toBeUndefined();
  await input.setInputFiles(skillFile('更新后的教学方法。'));
  await expect(region.getByText('同名 Skill 已存在。更新会替换文件内容并停用，需重新启用。')).toBeVisible();
  await region.getByRole('button', { name: '更新已有 Skill', exact: true }).click(); await acknowledgeFeedback(page, ['Skill 已保存']);
  await expect(region.getByText('未启用', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await region.getByRole('button', { name: '删除 browser-examples', exact: true }).click();
  await answerDialog(page, true, ['已经排队和历史任务']);
  await expect(region.getByText('尚未导入 Skill。')).toBeVisible();
  expect(errors).toEqual([]);
});
test('invalid files and cancelled previews never create a Skill', async ({ page }) => {
  await open(page);
  const region = page.getByRole('region', { name: '学习 Skill', exact: true });
  const input = region.getByLabel('导入 Skill 文件或压缩包');
  await input.setInputFiles({ ...skillFile(), name: 'notes.md' });
  await acknowledgeFeedback(page, ['SKILL.md']);
  await input.setInputFiles({ ...skillFile(), buffer: Buffer.from([0xff, 0xfe, 0x00]) });
  await acknowledgeFeedback(page, ['UTF-8']);
  await input.setInputFiles({ ...skillFile(), buffer: Buffer.from('not a skill') });
  await acknowledgeFeedback(page, ['YAML']);
  await input.setInputFiles({ ...skillFile(), buffer: Buffer.alloc(32769, 65) });
  await acknowledgeFeedback(page, ['32 KiB']);
  await input.setInputFiles(skillFile());
  await expect(region.getByRole('button', { name: '确认导入 Skill' })).toBeVisible();
  await region.getByRole('button', { name: '取消导入' }).click();
  await expect(region.getByRole('button', { name: '确认导入 Skill' })).toHaveCount(0);
  expect((await (await page.request.get('/api/ai/skills')).json()).items).toHaveLength(0);
});

test('downloads a cloud Skill to the local library, enables it explicitly and preserves it after reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const region = page.getByRole('region', { name: '学习 Skill', exact: true });
  await region.getByRole('tab', { name: '云 Skill', exact: true }).click();
  const list = region.getByRole('list', { name: '云 Skill 列表' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByText('云端学习教学方法', { exact: true })).toBeVisible();
  await region.getByLabel('搜索云 Skill').fill('不存在');
  await expect(region.getByText('没有匹配的云 Skill，试试其他关键词。')).toBeVisible();
  await region.getByLabel('搜索云 Skill').clear();
  await page.screenshot({ path: 'test-results/ai-cloud-skills-desktop.png', fullPage: true });
  await list.getByRole('button', { name: '下载到本地 remote-examples', exact: true }).click(); await acknowledgeFeedback(page, ['已下载到本地']);
  await expect(list.getByRole('button', { name: '已下载 remote-examples', exact: true })).toBeDisabled();
  const local = (await (await page.request.get('/api/ai/skills')).json()).items as SkillSummary[];
  expect(local).toHaveLength(1); expect(local[0]).toMatchObject({ name: 'remote-examples', enabled: false });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/ai-cloud-skills-mobile.png', fullPage: true });
  await region.getByRole('tab', { name: /本地 Skill/ }).click();
  await region.getByRole('button', { name: '查看指令 · remote-examples', exact: true }).click();
  await expect(region.locator('pre')).toContainText('<script>window.cloudSkillExecuted = true</script>');
  expect(await page.evaluate(() => (window as unknown as { cloudSkillExecuted?: boolean }).cloudSkillExecuted)).toBeUndefined();
  await region.getByRole('button', { name: '启用 remote-examples', exact: true }).click();
  await expect(region.getByText('可供选择', { exact: true })).toBeVisible();
  await page.reload();
  await expect(region.getByText('可供选择', { exact: true })).toBeVisible();
  await region.getByRole('button', { name: '删除 remote-examples', exact: true }).click();
  await answerDialog(page, true, ['已经排队和历史任务']);
  await expect(region.getByText('尚未导入 Skill。')).toBeVisible();
  expect(errors).toEqual([]);
});

test('shows an unconfigured cloud catalog and allows retry after a catalog error', async ({ page }) => {
  let unavailable = false;
  await page.route('**/api/ai/skills/cloud', route => unavailable
    ? route.fulfill({ status: 502, json: { error: { code: 'CLOUD_SKILL_FETCH', message: '无法读取云 Skill，请稍后重试。' } } })
    : route.fulfill({ json: { configured: false, source: null, items: [] } }));
  await open(page);
  const region = page.getByRole('region', { name: '学习 Skill', exact: true });
  await region.getByRole('tab', { name: '云 Skill', exact: true }).click();
  await expect(region.getByRole('heading', { name: '尚未配置远程目录' })).toBeVisible();
  await expect(region.getByRole('button', { name: /^下载到本地/ })).toHaveCount(0);
  unavailable = true;
  await region.getByRole('button', { name: '刷新云 Skill', exact: true }).click();
  await acknowledgeFeedback(page, ['无法读取云 Skill']);
  unavailable = false;
  await region.getByRole('button', { name: '刷新云 Skill', exact: true }).click();
  await expect(region.getByRole('heading', { name: '尚未配置远程目录' })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
