import { expect, test, type Page, type Route } from '@playwright/test';
import { LIMITS, type PublicState } from '@sanxing/contracts';
import { password } from './settings.ts';
import { acknowledgeFeedback, autoAcceptDialogs } from './dialog.ts';

const markdown = [
  '# 原始笔记标题', '', '## 阅读与公式', '', '- 列表条目', '- 第二条', '', '任务进度：', '', '- [x] 已完成', '- [ ] 待完成', '',
  '| 概念 | 说明 |', '| --- | --- |', '| 记忆 | 独立提取 |', '', '> 引用原句', '', '~~过时说明~~ 和 `inline()`', '',
  '```python', 'def recall(value):', '    return value + 1', '```', '', '```js', 'const value = 1;', '```', '', '```ts', 'const value: number = 1;', '```', '',
  '---', '', '行内公式 $a^2+b^2=c^2$。', '', '$$', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}', '$$', '', '[安全链接](https://example.com/notes)', '',
].join('\n');
const source = (page: Page, name: string) => page.locator('details.source:visible').filter({ has: page.locator('summary').getByText(name, { exact: true }) });
const state = async (page: Page): Promise<PublicState> => (await page.request.get('/api/state')).json();

function fixture(notes: { name: string; text: string }[]) {
  const now = new Date().toISOString();
  const data: PublicState = {
    mode: 'mock', timezone: 'UTC', revision: 1, csrfToken: 'offline-source-csrf',
    capabilities: { maxUploadBytes: LIMITS.uploadBytes, maxDocuments: LIMITS.documents, maxFollowups: LIMITS.followups, quizCount: LIMITS.quizQuestions, schedulingEnabled: false },
    documents: notes.map((note, index) => ({ id: `note-${index}`, recitationId: 'draft', name: note.name, textLength: note.text.length, lineCount: note.text.split('\n').length, createdAt: now })),
    knowledge: [{ id: 'point', title: '笔记阅读测试', description: '合成知识点', sourceIds: notes.map((_, index) => `note-${index}`), understanding: '', version: 1, contentVersion: 1, createdAt: now, updatedAt: now,
      contentHistory: [{ version: 1, title: '# 旧知识标题', description: '**旧知识快照**', sourceIds: [], createdAt: now }] }],
    recitations: [], sessions: [], quizzes: [], cards: [], reviewSessions: [], reviewEvents: [], evidence: [], runs: [],
  };
  return { data, texts: notes.map(note => note.text) };
}
async function offline(page: Page, input = fixture([{ name: '阅读笔记.md', text: markdown }]), defer = false) {
  const observed = { reads: 0, pending: undefined as Route | undefined, errors: [] as string[], requests: [] as string[] };
  page.on('pageerror', error => observed.errors.push(error.message));
  // Reading/security fixtures use system fonts; only the local KaTeX fonts are exercised.
  await page.route(/^https:\/\/fonts\.googleapis\.com\/css2\?/, route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    observed.requests.push(path);
    if (path === '/api/auth/status') return route.fulfill({ json: { authenticated: true } });
    if (path === '/api/state') return route.fulfill({ json: input.data });
    const match = /^\/api\/documents\/note-(\d+)$/.exec(path);
    if (match) {
      observed.reads++;
      if (defer) { observed.pending = route; return; }
      const index = Number(match[1]);
      return route.fulfill({ json: { ...input.data.documents[index], text: input.texts[index] } });
    }
    observed.errors.push(`Unexpected API: ${path}`);
    return route.fulfill({ status: 500, json: { error: { code: 'OFFLINE_ONLY', message: 'Unsupported fixture request' } } });
  });
  await page.goto('/knowledge/point');
  await expect(page.getByRole('heading', { name: '笔记阅读测试', exact: true })).toBeVisible();
  return observed;
}

async function semantics(scope: ReturnType<typeof source>) {
  await expect(scope.locator('h1')).toHaveText('原始笔记标题');
  await expect(scope.locator('h2')).toHaveText('阅读与公式');
  await expect(scope.locator('ul')).toHaveCount(2);
  await expect(scope.getByRole('checkbox')).toHaveCount(2);
  await expect(scope.getByRole('checkbox').first()).toBeChecked();
  for (const checkbox of await scope.getByRole('checkbox').all()) await expect(checkbox).toBeDisabled();
  await expect(scope.locator('table th')).toHaveText(['概念', '说明']);
  await expect(scope.locator('blockquote')).toContainText('引用原句');
  await expect(scope.locator('del')).toHaveText('过时说明');
  await expect(scope.locator('code')).toHaveCount(4);
  await expect(scope.locator('.source-code-label')).toHaveText(['python', 'js', 'ts']);
  await expect(scope.locator('code .tok-keyword').first()).toBeVisible();
  await expect(scope.locator('hr')).toHaveCount(1);
  await expect(scope.locator('.katex')).toHaveCount(2);
  await expect(scope.locator('.katex-display')).toHaveCount(1);
}

test('上传 Markdown 经真实 mock 学习流程在知识详情排版，原文逐行保留', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-17T04:00:00Z'));
  await autoAcceptDialogs(page);
  await page.goto('/recite'); await page.getByLabel('访问密码').fill(password); await page.getByRole('button', { name: '进入我的学习空间' }).click();
  await expect(page).toHaveURL(/\/recite$/);
  await page.getByRole('button', { name: '开始今天的三省' }).click();
  await page.getByRole('textbox', { name: '今天学了什么', exact: true }).fill('原始笔记标题。');
  await page.getByLabel('上传笔记、PDF 或图片').setInputFiles({ name: '排版验收.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
  await expect(source(page, '排版验收.md')).toBeVisible();
  await page.getByRole('button', { name: '提交复述', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /纳入这个知识点/ }).first()).toBeVisible();
  for (const checkbox of await page.getByRole('checkbox', { name: /纳入这个知识点/ }).all()) await checkbox.check();
  await page.getByRole('button', { name: '确认学习范围' }).click();
  await expect(page.getByRole('button', { name: '结束追问，准备测验' })).toBeEnabled();
  const data = await state(page);
  const document = data.documents.find(note => note.name === '排版验收.md')!;
  const point = data.knowledge.find(item => item.sourceIds.includes(document.id))!;
  expect(point).toBeTruthy();
  await page.goto(`/knowledge/${point.id}`);
  const note = source(page, '排版验收.md');
  await note.locator('summary>span').first().click(); await expect(note.getByRole('button', { name: '排版', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await semantics(note);
  await note.getByRole('button', { name: '原文（行号）', exact: true }).click();
  expect(await note.locator('.source-lines pre').allTextContents()).toEqual(markdown.split('\n').map(line => line || ' '));
  await expect(note.getByLabel('第 1 行', { exact: true })).toHaveText('1');
  await expect(note.locator('.source-lines>div').last().locator('span')).toHaveText(String(markdown.split('\n').length));
  await page.goto('/recite');
  await page.getByRole('button', { name: '直接粘贴笔记' }).click();
  await page.getByLabel('资料名称').fill('粘贴默认排版'); await page.getByLabel('笔记原文').fill('# 粘贴标题');
  await page.getByRole('button', { name: '保存粘贴资料' }).click();
  const pasted = source(page, '粘贴默认排版.md'); await pasted.locator('summary>span').first().click(); await expect(pasted.locator('h1')).toHaveText('粘贴标题');
});

test('HTML、图片、协议与公式攻击保持惰性文本且不发出外部请求', async ({ page }) => {
  const hostile = [
    '<script>window.noteExecuted=true</script>', '', '<img src=x onerror="window.noteExecuted=true">', '', '<iframe src="https://runner-forbidden.invalid/frame"></iframe>', '',
    '![x](https://runner-forbidden.invalid/a.png)', '', '![local](/api/state)', '', '![embedded](data:image/svg+xml;base64,PHN2Zy8+)', '',
    '[bad](javascript:alert(1)) [rel](./a.md) [data](data:text/html,hello) [file](file:///tmp/a) [vb](vbscript:msgbox) [protocol](//runner-forbidden.invalid)', '',
    '[good](https://example.com/note) [mail](mailto:reader@example.com)', '',
    '$\\href{javascript:alert(1)}{danger}$ $\\url{https://runner-forbidden.invalid/math}$ $\\href{https://example.com}{math-link}$', '',
    '$\\includegraphics{https://runner-forbidden.invalid/tex.png}$', '', '$\\def\\x{\\x}\\x$ $\\rule{999999em}{999999em}$', '',
  ].join('\n');
  const external: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { external.push(url.href); return route.abort(); }
    return route.fallback();
  });
  const observed = await offline(page, fixture([{ name: '安全测试.md', text: hostile }]));
  const note = source(page, '安全测试.md'); await note.locator('summary>span').first().click();
  await expect(note.locator('.source-image')).toHaveCount(3);
  await expect(note.locator('.source-image').first()).toContainText('https://runner-forbidden.invalid/a.png');
  await expect(note.locator('script,iframe,img,object,embed,style,link')).toHaveCount(0);
  await expect(note.locator('.source-markdown')).toContainText('<script>window.noteExecuted=true</script>');
  await expect(note.locator('.source-markdown')).toContainText('<img src=x onerror="window.noteExecuted=true">');
  for (const label of ['bad', 'rel', 'data', 'file', 'vb', 'protocol']) { await expect(note.getByText(label, { exact: true })).toBeVisible(); await expect(note.getByRole('link', { name: label, exact: true })).toHaveCount(0); }
  for (const label of ['good', 'mail']) {
    const link = note.getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('target', '_blank'); await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow'); await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  }
  await expect(note.locator('.katex a,.katex img')).toHaveCount(0);
  await expect(note.locator('.katex-error')).toHaveCount(1);
  expect(await page.evaluate(() => 'noteExecuted' in window)).toBe(false);
  expect(observed.requests.filter(path => path === '/api/state')).toHaveLength(1);
  expect(external).toEqual([]); expect(observed.errors).toEqual([]);
});

test('最大化闭合来源按需加载、键盘不切换 details、焦点循环与视图同步', async ({ page }) => {
  const observed = await offline(page);
  const note = source(page, '阅读笔记.md'); const trigger = note.getByRole('button', { name: '最大化查看 阅读笔记.md' }); const dialog = page.getByRole('dialog', { name: '阅读笔记.md' });
  expect(observed.reads).toBe(0);
  await page.evaluate(() => { document.body.style.overflow = 'scroll'; });
  await trigger.click(); await expect(dialog).toBeVisible(); await expect(note).not.toHaveAttribute('open');
  await expect(dialog).toHaveAttribute('aria-modal', 'true'); await expect(page.locator('.modal-backdrop')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '退出最大化' })).toBeFocused();
  await expect(dialog.locator('.source-markdown h1')).toBeVisible(); expect(observed.reads).toBe(1);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  const link = dialog.getByRole('link', { name: '安全链接' }); await link.focus();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: '排版', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(link).toBeFocused();
  await dialog.getByRole('button', { name: '原文（行号）' }).click();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(note).not.toHaveAttribute('open');
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('scroll');
  for (const key of ['Enter', 'Space']) {
    await trigger.press(key); await expect(dialog).toBeVisible(); await expect(note).not.toHaveAttribute('open');
    await dialog.getByRole('button', { name: '退出最大化' }).click(); await expect(trigger).toBeFocused();
  }
  await note.locator('summary>span').first().click(); await expect(note).toHaveAttribute('open', '');
  await expect(note.getByRole('button', { name: '原文（行号）' })).toHaveAttribute('aria-pressed', 'true');
  await trigger.click(); await expect(note).toHaveAttribute('open', '');
  await dialog.getByRole('button', { name: '排版', exact: true }).click();
  await page.mouse.click(8, 8); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await expect(note.getByRole('button', { name: '排版', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(note.locator('h1')).toBeVisible(); expect(observed.reads).toBe(1); expect(observed.errors).toEqual([]);
});

test('内联加载中最大化复用请求，失败关闭后可重试', async ({ page }) => {
  const input = fixture([{ name: '阅读笔记.md', text: markdown }]);
  const observed = await offline(page, input, true);
  const note = source(page, '阅读笔记.md'); await note.locator('summary>span').first().click();
  await expect.poll(() => observed.reads).toBe(1);
  await note.getByRole('button', { name: '最大化查看 阅读笔记.md' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('status')).toHaveText('正在加载原文…');
  await observed.pending!.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '离线临时失败' } } });
  await acknowledgeFeedback(page, ['离线临时失败']); expect(observed.reads).toBe(1);
  await page.keyboard.press('Escape'); await note.locator('summary>span').first().click();
  await note.getByRole('button', { name: '最大化查看 阅读笔记.md' }).click(); await expect.poll(() => observed.reads).toBe(2);
  await observed.pending!.fulfill({ json: { ...input.data.documents[0], text: markdown } });
  await expect(dialog.locator('.source-markdown h1')).toHaveText('原始笔记标题');
  await page.keyboard.press('Escape'); await note.locator('summary>span').first().click();
  await expect(note.locator('h1')).toBeVisible(); expect(observed.reads).toBe(2);
});

test('TXT 默认原文，无扩展名和 MARKDOWN 默认排版，历史快照不提供切换', async ({ page }) => {
  const input = fixture([{ name: '纯文本.txt', text: '# 纯文本\n第二行\n' }, { name: '无扩展名资料', text: '# 粘贴排版' }, { name: '长扩展名.MARKDOWN', text: '# 长扩展名排版' }]);
  const now = input.data.knowledge[0]!.createdAt;
  input.data.knowledge[0]!.sourceIds.push('knowledge:point:v1', 'recitation:snapshot');
  input.data.sessions.push({ id: 'snapshot', recitationId: 'draft', snapshot: { learned: '# 原始复述', unclear: '', application: '', topic: '' }, documentIds: [], scopeVersion: 1, version: 1, status: 'CONFIRMING', candidates: [], turns: [], quizId: null, activeRunId: null, completionReason: null, createdAt: now, completedAt: null });
  await offline(page, input);
  const txt = source(page, '纯文本.txt'); await txt.locator('summary>span').first().click(); await expect(txt.getByRole('button', { name: '原文（行号）' })).toHaveAttribute('aria-pressed', 'true');
  expect(await txt.locator('.source-lines pre').allTextContents()).toEqual(['# 纯文本', '第二行', ' ']);
  await txt.getByRole('button', { name: '最大化查看 纯文本.txt' }).click();
  await expect(page.getByRole('dialog').getByRole('navigation', { name: '笔记大纲' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '排版', exact: true }).click();
  await expect(page.getByRole('dialog').locator('h1')).toHaveText('纯文本');
  await expect(page.getByRole('dialog').getByRole('navigation', { name: '笔记大纲' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  for (const name of ['无扩展名资料', '长扩展名.MARKDOWN']) { const note = source(page, name); await note.locator('summary>span').first().click(); await expect(note.locator('h1')).toBeVisible(); }
  for (const name of ['旧知识 · # 旧知识标题 · 内容版本 1', '原始复述 · 已提交快照']) {
    const snapshot = source(page, name); await snapshot.locator('summary>span').first().click(); await expect(snapshot.locator('.source-lines')).toBeVisible(); await expect(snapshot.getByRole('group', { name: '笔记视图' })).toHaveCount(0);
    await snapshot.getByRole('button', { name: `最大化查看 ${name}` }).click();
    await expect(page.getByRole('dialog').getByRole('navigation', { name: '笔记大纲' })).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('.source-lines')).toBeVisible(); await expect(page.getByRole('dialog').getByRole('group', { name: '笔记视图' })).toHaveCount(0); await page.keyboard.press('Escape');
  }
});

test('390px 深色内联与全屏阅读仅表格内部横向滚动，本地 KaTeX 字体可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  const wide = `${markdown}\n| 很宽的表格列名一 | 很宽的表格列名二 | 很宽的表格列名三 |\n| --- | --- | --- |\n| ${'宽内容'.repeat(20)} | 第二列 | 第三列 |\n\n${Array.from({ length: 90 }, (_, index) => `阅读第 ${index + 1} 段。`).join('\n\n')}`;
  const fonts: string[] = []; page.on('request', request => { if (/KaTeX.*\.(woff2?|ttf)/i.test(request.url())) fonts.push(request.url()); });
  const observed = await offline(page, fixture([{ name: '窄屏长笔记.md', text: wide }]));
  const note = source(page, '窄屏长笔记.md'); await note.locator('summary>span').first().click(); await expect(note.locator('.katex')).toHaveCount(2);
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await noOverflow();
  expect(await note.locator('.source-table').last().evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await note.getByRole('button', { name: '最大化查看 窄屏长笔记.md' }).click(); const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible(); await noOverflow();
  expect(await dialog.evaluate(node => Math.abs(node.getBoundingClientRect().height - innerHeight) < 2)).toBe(true);
  expect(await dialog.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(30, 28, 23)');
  expect(await dialog.locator('.source-modal-content').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await dialog.locator('.source-modal-content').evaluate(node => { node.scrollTop = 200; });
  await page.evaluate(() => document.fonts.ready); expect(fonts.length).toBeGreaterThan(0); expect(fonts.every(url => new URL(url).hostname === '127.0.0.1')).toBe(true);
  await page.screenshot({ path: 'test-results/source-markdown-mobile-dark.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '原文（行号）' }).click(); await noOverflow();
  await dialog.getByRole('button', { name: '退出最大化' }).click(); await noOverflow(); expect(observed.errors).toEqual([]);
});

const longTitle = `深入章节 ${'完整标题'.repeat(30)}`;
const outlineMarkdown = [
  '# 大纲笔记', '', '```md', '# 代码不是标题', '```', '', '<div>', '# HTML 不是标题', '</div>', '',
  ...Array.from({ length: 18 }, (_, index) => [
    `${'#'.repeat(index % 6 + 1)} ${index === 14 ? longTitle : `章节 ${index + 1}`}`,
    '', ...Array.from({ length: 8 }, (_, paragraph) => `第 ${index + 1} 章第 ${paragraph + 1} 段正文，用于验证独立内容滚动与标题定位。\n`),
  ].join('\n')),
  'Setext **结尾** `code` $a^2$', '---', '', ...Array.from({ length: 24 }, () => '结尾正文，保留定位余量。\n'),
].join('\n');
const headingLine = (title: string) => outlineMarkdown.split('\n').findIndex(line => line.endsWith(title)) + 1;
const inContent = async (page: Page, selector: string) => expect.poll(() => page.getByRole('dialog').locator(selector).evaluate(node => {
  const box = node.getBoundingClientRect(); const root = node.closest('.source-modal-content')!.getBoundingClientRect();
  return box.top >= root.top && box.top < root.top + 40 && box.bottom <= root.bottom;
})).toBe(true);

async function sampleOutlineJump(page: Page, title: string) {
  return page.evaluate(title => new Promise<{ active: (string | null)[]; positions: number[]; timedOut: boolean }>(resolve => {
    const content = document.querySelector<HTMLElement>('.source-modal-content')!;
    const nav = document.querySelector('.source-outline nav')!;
    const button = [...nav.querySelectorAll('button')].find(node => node.textContent === title)!;
    const active: (string | null)[] = []; const positions: number[] = [];
    let lastTop = content.scrollTop; let stable = 0; const started = performance.now();
    button.click();
    const sample = (now: number) => {
      active.push(nav.querySelector('[aria-current="location"]')?.textContent ?? null);
      positions.push(content.scrollTop);
      stable = content.scrollTop === lastTop ? stable + 1 : 0; lastTop = content.scrollTop;
      const timedOut = now - started > 5000;
      // Keep sampling after native scrollend / the stable-frame fallback runs.
      if ((stable >= 12 && now - started > 350) || timedOut) resolve({ active, positions, timedOut });
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), title);
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) for (const scrollend of [true, false]) test(`点击大纲逐帧保持目标、底部钳位与手动滚动恢复（${reducedMotion}，scrollend=${scrollend}）`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  const text = `${outlineMarkdown}\n\n## 底部倒数第二节\n\n尾段。\n\n## 底部最后节\n\n结束。`;
  const observed = await offline(page, fixture([{ name: '大纲.md', text }]));
  await source(page, '大纲.md').getByRole('button', { name: '最大化查看 大纲.md' }).click();
  const dialog = page.getByRole('dialog'); const nav = dialog.getByRole('navigation', { name: '笔记大纲' }); const content = dialog.locator('.source-modal-content');
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  // Suppress delivery, emulating browsers that never emit scrollend.
  if (!scrollend) await content.evaluate(node => node.addEventListener('scrollend', event => event.stopImmediatePropagation(), true));
  const target = nav.getByRole('button', { name: '章节 12', exact: true });
  expect(await target.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
  const sampled = await sampleOutlineJump(page, '章节 12');
  expect(sampled.timedOut).toBe(false); expect(sampled.active.length).toBeGreaterThan(10);
  expect([...new Set(sampled.active)]).toEqual(['章节 12']);
  if (reducedMotion === 'no-preference') {
    const end = sampled.positions.at(-1)!;
    expect(sampled.positions.filter(top => top > 0 && top < end - 1).length).toBeGreaterThan(3);
  }
  await expect(target).toHaveAttribute('aria-current', 'location');
  await inContent(page, `[data-source-line="${headingLine('章节 12')}"]`);
  // A position change without an input event proves the completion unlocked spy.
  await content.evaluate(node => { node.scrollTop = 0; });
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  const bottom = await sampleOutlineJump(page, '底部倒数第二节');
  expect(bottom.timedOut).toBe(false); expect([...new Set(bottom.active)]).toEqual(['底部倒数第二节']);
  expect(await content.evaluate(node => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop))).toBeLessThan(2);
  // Another heading at the same clamped position emits no new scroll event.
  expect([...new Set((await sampleOutlineJump(page, '底部最后节')).active)]).toEqual(['底部最后节']);
  expect([...new Set((await sampleOutlineJump(page, '底部倒数第二节')).active)]).toEqual(['底部倒数第二节']);
  // Once settled, selecting text without scrolling must retain the clicked item.
  await content.dispatchEvent('pointerdown');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(nav.getByRole('button', { name: '底部倒数第二节', exact: true })).toHaveAttribute('aria-current', 'location');
  await content.hover(); await page.mouse.wheel(0, -1200);
  await expect(nav.getByRole('button', { name: '底部倒数第二节', exact: true })).not.toHaveAttribute('aria-current');
  await content.press('Control+Home');
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  expect(observed.errors).toEqual([]);
});

for (const interaction of ['wheel', 'touchstart', 'pointerdown', 'keydown']) test(`大纲平滑跳转中 ${interaction} 立即恢复 scrollspy`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await offline(page, fixture([{ name: '大纲.md', text: outlineMarkdown }]));
  await source(page, '大纲.md').getByRole('button', { name: '最大化查看 大纲.md' }).click();
  const nav = page.getByRole('navigation', { name: '笔记大纲' });
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  const result = await page.evaluate(interaction => new Promise<{ before: string | null; after: string | null; timedOut: boolean }>(resolve => {
    const content = document.querySelector<HTMLElement>('.source-modal-content')!;
    const nav = document.querySelector('.source-outline nav')!;
    const active = () => nav.querySelector('[aria-current="location"]')?.textContent ?? null;
    const started = performance.now();
    [...nav.querySelectorAll('button')].find(node => node.textContent === '章节 12')!.click();
    const interrupt = () => {
      const timedOut = performance.now() - started > 4000;
      if (content.scrollTop < 100 && !timedOut) { requestAnimationFrame(interrupt); return; }
      const before = active();
      // Dispatch intent while motion is still active, then hold the position so
      // the next paint specifically verifies the lock was released immediately.
      content.dispatchEvent(interaction === 'keydown' ? new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }) : new Event(interaction, { bubbles: true }));
      content.scrollTo({ top: 0, behavior: 'instant' });
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ before, after: active(), timedOut })));
    };
    requestAnimationFrame(interrupt);
  }), interaction);
  expect(result).toEqual({ before: '章节 12', after: '大纲笔记', timedOut: false });
  expect(observed.errors).toEqual([]);
});

test('连续点击大纲、滚动中切换视图及关闭后不残留跳转', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const observed = await offline(page, fixture([{ name: '大纲.md', text: outlineMarkdown }]));
  const trigger = source(page, '大纲.md').getByRole('button', { name: '最大化查看 大纲.md' }); await trigger.click();
  const dialog = page.getByRole('dialog'); const nav = dialog.getByRole('navigation', { name: '笔记大纲' }); const content = dialog.locator('.source-modal-content');
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  await nav.getByRole('button', { name: '章节 12', exact: true }).click();
  await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  expect([...new Set((await sampleOutlineJump(page, '章节 3')).active)]).toEqual(['章节 3']);
  await nav.getByRole('button', { name: '章节 12', exact: true }).click();
  await dialog.getByRole('button', { name: '原文（行号）' }).click();
  await content.evaluate(node => node.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  await nav.getByRole('button', { name: '章节 12', exact: true }).click();
  await expect(content.locator('[data-outline-highlight]')).toHaveCount(1);
  await dialog.getByRole('button', { name: '退出最大化' }).click(); await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  await expect(content.locator('[data-outline-highlight]')).toHaveCount(0);
  expect([...new Set((await sampleOutlineJump(page, '章节 2')).active)]).toEqual(['章节 2']);
  expect(observed.errors).toEqual([]);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`大纲层级、排版定位、滚动高亮与键盘循环（${reducedMotion}）`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  const observed = await offline(page, fixture([{ name: '大纲.md', text: outlineMarkdown }]));
  const note = source(page, '大纲.md');
  await note.locator('summary>span').first().click(); await expect(note.locator('h1').first()).toBeVisible();
  await expect(note.getByRole('navigation', { name: '笔记大纲' })).toHaveCount(0);
  const trigger = note.getByRole('button', { name: '最大化查看 大纲.md' }); await trigger.click();
  const dialog = page.getByRole('dialog'); const nav = dialog.getByRole('navigation', { name: '笔记大纲' }); const content = dialog.locator('.source-modal-content');
  await expect(nav.getByRole('button')).toHaveCount(20);
  for (let index = 0; index < 6; index++) await expect(nav.getByRole('button', { name: `章节 ${index + 1}`, exact: true })).toHaveAttribute('data-depth', String(index + 1));
  const target = nav.getByRole('button', { name: longTitle, exact: true });
  await expect(target).toHaveAttribute('title', longTitle);
  expect(await target.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await nav.getByRole('button', { name: '章节 6', exact: true }).evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))).toBeGreaterThan(await nav.getByRole('button', { name: '章节 1', exact: true }).evaluate(node => parseFloat(getComputedStyle(node).paddingLeft)));
  await dialog.getByRole('button', { name: '退出最大化' }).focus(); await page.keyboard.press('Tab');
  await expect(nav.getByRole('button').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: '退出最大化' })).toBeFocused();
  await content.focus(); await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: '排版', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(content).toBeFocused();
  await content.evaluate(node => {
    const original = node.scrollTo.bind(node);
    node.scrollTo = ((options: ScrollToOptions) => { node.setAttribute('data-test-scroll-behavior', options.behavior ?? 'auto'); original(options); }) as typeof node.scrollTo;
  });
  const url = page.url(); await target.click();
  const selector = `[data-source-line="${headingLine(longTitle)}"]`;
  await expect(content.locator(selector)).toBeFocused(); await expect(content.locator(selector)).toHaveAttribute('tabindex', '-1'); await inContent(page, selector);
  await expect(content).toHaveAttribute('data-test-scroll-behavior', reducedMotion === 'reduce' ? 'instant' : 'smooth');
  await expect(target).toHaveAttribute('aria-current', 'location'); expect(page.url()).toBe(url);
  await expect(content.locator(`${selector}[id],${selector}[name]`)).toHaveCount(0);
  await content.evaluate(node => { node.scrollTop = 0; }); await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  const middle = headingLine('章节 9');
  await content.evaluate((node, line) => { const heading = node.querySelector<HTMLElement>(`[data-source-line="${line}"]`)!; node.scrollTop += heading.getBoundingClientRect().top - node.getBoundingClientRect().top - 16; }, middle);
  await expect(nav.getByRole('button', { name: '章节 9', exact: true })).toHaveAttribute('aria-current', 'location');
  await nav.getByRole('button', { name: 'Setext 结尾 code a^2', exact: true }).click();
  await inContent(page, `[data-source-line="${headingLine('Setext **结尾** `code` $a^2$')}"]`);
  await expect(content.locator('h2').last()).toBeFocused();
  if (reducedMotion === 'no-preference') await page.screenshot({ path: 'test-results/source-outline-wide.png', animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(observed.reads).toBe(1); expect(observed.errors).toEqual([]);
});

test('直接最大化原文仍有大纲，行号定位短暂高亮，切换视图后更新 scrollspy', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const observed = await offline(page, fixture([{ name: '大纲.md', text: outlineMarkdown }]));
  const note = source(page, '大纲.md'); await note.locator('summary>span').first().click();
  await note.getByRole('button', { name: '原文（行号）' }).click();
  await note.getByRole('button', { name: '最大化查看 大纲.md' }).click();
  const dialog = page.getByRole('dialog'); const nav = dialog.getByRole('navigation', { name: '笔记大纲' }); const content = dialog.locator('.source-modal-content');
  const selector = `[data-source-line="${headingLine('章节 12')}"]`; const line = content.locator(selector);
  await nav.getByRole('button', { name: '章节 12', exact: true }).click();
  await inContent(page, selector); await expect(line).toBeFocused(); await expect(line).toHaveAttribute('data-outline-highlight', 'true');
  await expect(line.locator('span')).toHaveText(String(headingLine('章节 12'))); await expect(line.locator('pre')).toHaveText('###### 章节 12');
  await expect(nav.getByRole('button', { name: '章节 12', exact: true })).toHaveAttribute('aria-current', 'location');
  await expect(line).not.toHaveAttribute('data-outline-highlight');
  await content.evaluate(node => { node.scrollTop = 0; }); await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  await dialog.getByRole('button', { name: '排版', exact: true }).click();
  await expect(nav.getByRole('button').first()).toHaveAttribute('aria-current', 'location');
  await nav.getByRole('button', { name: '章节 12', exact: true }).click(); await inContent(page, selector); await expect(content.locator(selector)).toBeFocused();
  await dialog.getByRole('button', { name: '原文（行号）' }).click();
  await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(nav.getByRole('button').last()).toHaveAttribute('aria-current', 'location');
  await nav.getByRole('button', { name: '章节 2', exact: true }).click();
  await inContent(page, `[data-source-line="${headingLine('章节 2')}"]`); expect(observed.errors).toEqual([]);
});

test('无标题 Markdown 不占用大纲栏', async ({ page }) => {
  await offline(page, fixture([{ name: '没有标题.md', text: '普通正文[^shown]\n\n```md\n# 代码\n```\n\n<div>\n# HTML\n</div>\n\n[^unused]:\n    ## 未引用脚注标题\n\n[^shown]: 可见脚注正文' }]));
  await source(page, '没有标题.md').getByRole('button', { name: '最大化查看 没有标题.md' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.locator('.source-markdown')).toContainText('普通正文');
  await expect(dialog.locator('.footnotes h2')).toHaveClass('sr-only'); await expect(dialog.locator('.footnotes h2')).toHaveAttribute('id', 'footnote-label');
  await expect(dialog.locator('.footnotes')).toContainText('可见脚注正文');
  await expect(dialog.getByRole('navigation', { name: '笔记大纲' })).toHaveCount(0); await expect(dialog.locator('.source-outline')).toHaveCount(0);
  await dialog.getByRole('button', { name: '原文（行号）' }).click(); await expect(dialog.locator('.source-lines')).toBeVisible();
  await expect(dialog.locator('.source-outline')).toHaveCount(0);
});

test('390px 深色大纲可折叠，键盘跳转后收起、焦点正确且不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const observed = await offline(page, fixture([{ name: '大纲.md', text: outlineMarkdown }]));
  const trigger = source(page, '大纲.md').getByRole('button', { name: '最大化查看 大纲.md' }); await trigger.click();
  const dialog = page.getByRole('dialog'); const nav = dialog.getByRole('navigation', { name: '笔记大纲' }); const toggle = dialog.getByRole('button', { name: '大纲', exact: true });
  const noOverflow = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const node of [dialog, dialog.locator('.source-modal-body'), dialog.locator('.source-modal-content')]) expect(await node.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  };
  await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(nav).toBeHidden(); await noOverflow();
  await dialog.getByRole('button', { name: '退出最大化' }).focus(); await page.keyboard.press('Tab'); await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.locator('.source-modal-content')).toBeFocused();
  await toggle.press('Enter'); await expect(nav).toBeVisible(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab'); await expect(nav.getByRole('button').first()).toBeFocused();
  expect(await dialog.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(30, 28, 23)'); await noOverflow();
  await page.screenshot({ path: 'test-results/source-outline-mobile-dark.png', animations: 'disabled' });
  const target = nav.getByRole('button', { name: longTitle, exact: true }); await target.focus(); await target.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(nav).toBeHidden();
  const selector = `[data-source-line="${headingLine(longTitle)}"]`;
  await expect(dialog.locator(selector)).toBeFocused();
  // The long heading wraps on mobile; its top must remain in the content viewport.
  expect(await dialog.locator(selector).evaluate(node => Math.abs(node.getBoundingClientRect().top - node.closest('.source-modal-content')!.getBoundingClientRect().top - 16))).toBeLessThan(2);
  await noOverflow();
  await dialog.getByRole('button', { name: '原文（行号）' }).click(); await toggle.click();
  await nav.getByRole('button', { name: '章节 10', exact: true }).click(); await expect(nav).toBeHidden();
  await inContent(page, `[data-source-line="${headingLine('章节 10')}"]`); await noOverflow();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused(); expect(observed.errors).toEqual([]);
});
