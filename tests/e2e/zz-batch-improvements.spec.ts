import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from './test.ts';
import type { CommandResult, PublicState } from '@sanxing/contracts';
import { password, webOrigin } from './settings.ts';
import { acknowledgeFeedback, answerDialog, autoAcceptDialogs, openModule } from './dialog.ts';

const state = async (page: Page): Promise<PublicState> => (await page.request.get('/api/state')).json();
async function write(page: Page, path: string, data: unknown, method = 'POST'): Promise<CommandResult> {
  const response = await page.request.fetch(`/api${path}`, { method, data, headers: { origin: webOrigin, 'x-csrf-token': (await state(page)).csrfToken, 'idempotency-key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
async function prepared(page: Page, date: string) {
  await page.goto('/recite'); await page.getByLabel('访问密码').fill(password); await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page.getByRole('heading', { name: '今日复述', exact: true })).toBeVisible();
  const draft = await write(page, '/recitations', { learningDate: date });
  await write(page, `/recitations/${draft.id}/draft`, { version: 1, learned: '空值缓存能够减少不存在的键反复查询数据库，必须设置有限 TTL。', unclear: '失效条件', application: '保护查询', topic: '批次修复回归' }, 'PUT');
  const submitted = await write(page, `/recitations/${draft.id}/submit`, { version: 2 });
  await expect.poll(async () => (await state(page)).sessions.find(item => item.id === submitted.sessionId)?.candidates.length ?? 0).toBeGreaterThan(0);
  await page.goto(`/sessions/${submitted.sessionId}/ask`);
  await expect(page.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeVisible();
  return submitted.sessionId!;
}

test('scope draft survives navigation and refresh, and refuses a changed candidate scope', async ({ page }) => {
  const sessionId = await prepared(page, '2097-01-01');
  const title = page.getByLabel('名称', { exact: true }).first();
  await title.fill('本地修改的名称'); await page.getByRole('textbox', { name: '学习范围', exact: true }).first().fill('本地保留的范围说明');
  await page.getByRole('checkbox', { name: /纳入这个知识点/ }).first().check();
  await openModule(page, '我的知识库');
  await answerDialog(page, false, ['未保存']); await expect(title).toHaveValue('本地修改的名称');
  await openModule(page, '我的知识库');
  await answerDialog(page, true); await expect(page).toHaveURL(/\/knowledge$/);
  await page.goto(`/sessions/${sessionId}/ask`); await expect(title).toHaveValue('本地修改的名称');
  page.on('dialog', dialog => dialog.accept()); await page.reload(); await expect(title).toHaveValue('本地修改的名称');
  const confirmation = `**/api/sessions/${sessionId}/confirmations`;
  await page.route(confirmation, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '会话已过期' } }) }));
  await page.getByRole('button', { name: '确认学习范围' }).click();
  await expect(page.getByLabel('访问密码')).toBeVisible();
  await acknowledgeFeedback(page, ['会话已过期']);
  await page.unroute(confirmation); await page.getByLabel('访问密码').fill(password); await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(title).toHaveValue('本地修改的名称');
  await expect(page.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeChecked();
  const session = (await state(page)).sessions.find(item => item.id === sessionId)!;
  await write(page, `/sessions/${sessionId}/scope-revisions`, { version: session.version, documentIds: [] });
  await page.reload();
  await acknowledgeFeedback(page, ['旧草稿不能直接提交']);
  await expect(title).toHaveValue('本地修改的名称');
  await expect(page.getByRole('button', { name: '确认学习范围' })).toBeDisabled();
  await expect.poll(async () => (await state(page)).runs.filter(run => run.sessionId === sessionId && ['pending', 'running'].includes(run.status)).length).toBe(0);
  await page.getByRole('button', { name: '重新载入候选范围', exact: true }).click(); await answerDialog(page, true);
  await expect(title).not.toHaveValue('本地修改的名称');
  await expect(page.getByRole('button', { name: '确认学习范围' })).toBeEnabled();
});

test('submitted assessment corrections retain history; knowledge edit/archive/restore retain references', async ({ page }) => {
  await autoAcceptDialogs(page); const sessionId = await prepared(page, '2097-01-02');
  for (const checkbox of await page.getByRole('checkbox', { name: /纳入这个知识点/ }).all()) await checkbox.check();
  await page.getByRole('button', { name: '确认学习范围' }).click();
  await page.getByRole('button', { name: '结束追问，准备测验' }).click();
  await page.getByRole('link', { name: '开始 / 继续测验' }).click();
  await page.locator('.options .option').first().click();
  await page.getByLabel('我的回答', { exact: true }).fill('缓存不存在的键的空结果；设置 TTL，新增数据后及时失效。');
  await page.getByRole('button', { name: '正式提交' }).click();
  await page.locator('.options .option').first().click();
  await page.getByRole('button', { name: '完成测验，查看结果' }).click();
  await expect(page.locator('.question-feedback')).toHaveCount(3);
  const before = await state(page); const quizId = before.sessions.find(item => item.id === sessionId)!.quizId!;
  const quiz = before.quizzes.find(item => item.id === quizId)!; const question = quiz.questions.find(item => item.kind === 'short')!;
  const feedback = page.locator('.question-feedback').nth(1);
  await feedback.getByText('核对这条评价', { exact: true }).click();
  await feedback.getByLabel('核对原因').fill('逐项核对原答案');
  await feedback.getByRole('button', { name: '标记有争议' }).click();
  await expect(feedback.getByRole('status')).toContainText('评价有争议');
  await feedback.getByLabel('核对原因').fill('按原评分标准逐项修正');
  await feedback.getByText('人工核对分项', { exact: true }).click();
  for (let index = 0; index < question.rubric!.length; index++) {
    await feedback.getByLabel(`第 ${index + 1} 项得分`).fill(String(question.rubric![index]!.maxScore));
    await feedback.getByLabel(`第 ${index + 1} 项依据`).fill(`原答案明确给出第 ${index + 1} 项要求`);
  }
  await feedback.getByLabel('核对结论').fill('已核对原题与正式答案');
  await feedback.getByRole('button', { name: '保存人工核对' }).click();
  await expect(feedback).toContainText('人工核对（自评）');
  await feedback.getByText('评价修订历史（1）', { exact: true }).click();
  await expect(feedback).toContainText('模型评价');
  const corrected = (await state(page)).quizzes.find(item => item.id === quizId)!.questions.find(item => item.id === question.id)!;
  expect(corrected.answer!.text).toBe(question.answer!.text); expect(corrected.answer!.submittedAt).toBe(question.answer!.submittedAt);
  expect(corrected.answer!.assessmentHistory).toHaveLength(1); expect((await state(page)).cards).toEqual(before.cards);
  const knowledgeId = question.knowledgeId;
  await page.goto(`/knowledge/${knowledgeId}`);
  await page.getByText('编辑名称、描述与标签', { exact: true }).click();
  await page.getByLabel('知识名称', { exact: true }).fill('回归专用空值缓存');
  await page.getByRole('textbox', { name: '知识描述', exact: true }).fill('新增数据后主动失效空值缓存，并配置有限 TTL。');
  await page.getByLabel(/标签（逗号分隔/).fill('回归标签, 缓存');
  await page.getByRole('button', { name: '保存知识内容', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回归专用空值缓存', exact: true })).toBeVisible();
  await expect(page.getByText('证据依据：内容版本 1').first()).toBeVisible();
  await page.getByRole('button', { name: '归档知识点', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复知识点', exact: true })).toBeVisible();
  await page.goto('/knowledge'); await page.getByLabel('筛选知识点', { exact: true }).fill('回归专用空值缓存');
  await expect(page.locator('.knowledge-card')).toHaveCount(0);
  await page.getByLabel('知识状态').selectOption('archived'); await page.getByLabel('标签筛选').selectOption('回归标签');
  await expect(page.locator('.knowledge-card')).toHaveCount(1); await page.locator('.knowledge-card').click();
  await page.getByRole('button', { name: '恢复知识点', exact: true }).click();
  await expect(page.getByRole('button', { name: '归档知识点', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const after = await state(page); expect(after.cards).toEqual(before.cards); expect(after.knowledge.find(item => item.id === knowledgeId)!.contentHistory).toHaveLength(2);
});
