import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LIMITS, type CodeExercise } from '@sanxing/contracts';
import type { CodeRunner } from '../../apps/web/src/lib/code-runner.ts';
import { HARD_TIMEOUT_MS } from '../../apps/web/code-runner/protocol.ts';

declare global { interface Window { sandboxRunner: CodeRunner } }
let client: string;
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: "import { CodeRunner } from './apps/web/src/lib/code-runner'; window.sandboxRunner = new CodeRunner();", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false });
  client = bundle.outputFiles![0]!.text;
});
async function harness(page: Page) { await page.goto('/login'); await page.addScriptTag({ content: client }); }
const exercise = (language: CodeExercise['language'] = 'javascript', code = 'assertEqual(value, 2);'): CodeExercise => ({ language, starter: '// TODO', tests: [{ name: '结果断言', code }] });
async function run(page: Page, text: string, spec = exercise()) { return page.evaluate(({ text, spec }) => window.sandboxRunner.run(text, spec), { text, spec }); }

test('沙箱响应头、JS/TS 同作用域断言、输出截断与逐条失败', async ({ page }) => {
  await harness(page);
  await page.evaluate(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
  const response = await page.request.get('/code-runner/runner.html');
  expect(response.headers()['content-security-policy']).toContain('sandbox allow-scripts');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
  expect(response.headers()['content-security-policy']).toContain('http://127.0.0.1:3027/code-runner/');
  expect(response.headers()['access-control-allow-origin']).toBe('*');
  expect(response.headers()['access-control-allow-credentials']).toBeUndefined();
  const result = await run(page, "const value = 2; console.log('x'.repeat(9000));", { ...exercise(), tests: [
    { name: '深比较', code: 'assertEqual({a:[value, {b:3}]}, {a:[2, {b:3}]}); assertClose(0.1 + 0.2, 0.3);' },
    { name: '失败仍继续', code: 'assert(false, "预期失败");' }, { name: '最后一条', code: 'assertEqual(value, 2);' },
  ] });
  expect(result?.execution, JSON.stringify(result)).toMatchObject({ status: 'failed', passed: 2, total: 3 });
  expect(result?.execution.output).toHaveLength(LIMITS.codeOutputChars);
  expect((await run(page, 'const value: string = 2;', exercise('typescript')))?.execution.status).toBe('passed');
  expect((await run(page, 'throw new Error("boom");'))?.execution).toMatchObject({ status: 'error', passed: 0 });
  expect((await run(page, 'const value = 2;'))?.execution.status).toBe('passed');
  expect((await run(page, '\0'.repeat(LIMITS.answerChars)))?.execution.output).toContain('消息过大');
});

test('不透明源、CSP 阻止 API、外网、动态模块与 WebSocket', async ({ page }) => {
  const escaped: string[] = [];
  await page.route('**/api/state', route => { escaped.push(route.request().url()); return route.abort(); });
  await page.route('https://runner-forbidden.invalid/**', route => { escaped.push(route.request().url()); return route.abort(); });
  await page.routeWebSocket('wss://runner-forbidden.invalid/**', socket => { escaped.push(socket.url()); socket.close(); });
  await harness(page);
  const base = new URL(page.url()).origin;
  const result = await run(page, `let blocked = 0;
    for (const url of ['${base}/api/state', 'https://runner-forbidden.invalid/leak']) {
      try { await fetch(url, { credentials: 'include' }); } catch { blocked++; }
    }
    try { await import('https://runner-forbidden.invalid/code.js'); } catch { blocked++; }
    await new Promise(resolve => { try { const socket = new WebSocket('wss://runner-forbidden.invalid/socket'); socket.onerror = () => { blocked++; resolve(null); }; socket.onopen = () => { socket.close(); resolve(null); }; } catch { blocked++; resolve(null); } });
    const value = blocked;`, exercise('javascript', 'assertEqual(value, 4); assertEqual(typeof document, "undefined");'));
  expect(result?.execution, JSON.stringify(result)).toMatchObject({ status: 'passed' });
  expect(escaped).toEqual([]);
  const frame = page.frames().find(frame => frame.url().includes('/code-runner/runner.html'))!;
  expect(await frame.evaluate(() => { try { return parent.document.title; } catch { return 'blocked'; } })).toBe('blocked');
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
});

test('死循环超时后可恢复，编辑取消丢弃旧结果', async ({ page }) => {
  await harness(page);
  expect((await run(page, 'while (true) {}'))?.execution.status).toBe('timeout');
  expect((await run(page, 'const value = 2;'))?.execution.status).toBe('passed');
  const stale = await page.evaluate(async spec => {
    const pending = window.sandboxRunner.run('await new Promise(r => setTimeout(r, 1000)); const value = 2;', spec);
    window.sandboxRunner.cancel(); return pending;
  }, exercise());
  expect(stale).toBeNull();
  expect((await run(page, 'const value = 2;'))?.execution.status).toBe('passed');
});

test('在途取消立即作废，排队请求可替换且不重建 iframe 或重复抓取 worker', async ({ page }) => {
  let workerFetches = 0;
  page.on('request', request => { if (request.url().endsWith('/code-runner/worker.js')) workerFetches++; });
  await harness(page);
  const result = await page.evaluate(async spec => {
    const started = new Promise<void>(resolve => {
      const listen = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        try { if (JSON.parse(event.data).type === 'started') { window.removeEventListener('message', listen); resolve(); } } catch { /* unrelated message */ }
      };
      window.addEventListener('message', listen);
    });
    const first = window.sandboxRunner.run('globalThis.previousRun = true; await new Promise(r => setTimeout(r, 700)); const value = 2;', spec);
    await started;
    const frame = document.querySelector('iframe');
    window.sandboxRunner.cancel();
    const second = window.sandboxRunner.run('throw new Error("排队请求应被替换");', spec);
    const third = window.sandboxRunner.run('assertEqual(globalThis.previousRun, undefined); const value = 2;', spec);
    const results = await Promise.race([Promise.all([first, second, third]), new Promise<null>(resolve => setTimeout(() => resolve(null), 5000))]);
    return { results, sameFrame: document.querySelector('iframe') === frame };
  }, exercise());
  expect(result.sameFrame).toBe(true);
  expect(result.results?.[0]).toBeNull(); expect(result.results?.[1]).toBeNull();
  expect(result.results?.[2]?.execution.status).toBe('passed');
  expect(workerFetches).toBe(1);
});

test('父页面硬超时销毁无响应 iframe 并可重建运行', async ({ page }) => {
  await page.route('**/code-runner/frame.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await harness(page); await page.clock.install();
  const pending = run(page, 'const value = 2;');
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.clock.fastForward(HARD_TIMEOUT_MS + 1);
  expect((await pending)?.execution.status).toBe('timeout');
  await page.unroute('**/code-runner/frame.js');
  await page.evaluate(() => { window.sandboxRunner.destroy(); });
  await page.addScriptTag({ content: client });
  expect((await run(page, 'const value = 2;'))?.execution.status).toBe('passed');
});

test('Python 科学计算包本地校验、答案与测试 import、常驻加速和隔离命名空间', async ({ page }) => {
  const base = 'apps/web/public/code-runner/pyodide/';
  const lock = JSON.parse(await readFile(`${base}pyodide-lock.json`, 'utf8'));
  // No skip: missing/corrupt wheels fail with the documented installation command.
  for (const name of ['numpy', 'scipy', 'scikit-learn', 'joblib', 'threadpoolctl']) {
    const pkg = lock.packages[name];
    const bytes = await readFile(`${base}${pkg.file_name}`).catch(() => { throw new Error('缺少 Python 包，请执行 npm run code-runner:packages'); });
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pkg.sha256);
  }
  const remote: string[] = []; let wasm = 0;
  await page.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith('http://127.0.0.1:3027/')) { remote.push(url); return route.abort(); }
    if (url.endsWith('.wasm')) wasm++;
    return route.continue();
  });
  await harness(page);
  const result = await run(page, 'import numpy as np\nsecret_previous_run = 1\ndef double(x):\n    return np.array(x) * 2\nprint("本地 Python 就绪")', exercise('python', 'from scipy.linalg import norm\nfrom sklearn.preprocessing import StandardScaler\nassert norm(double([3, 4])) == 10\nassert StandardScaler().fit_transform([[1.0], [3.0]]).tolist() == [[-1.0], [1.0]]'));
  expect(result?.execution, JSON.stringify(result)).toMatchObject({ status: 'passed', passed: 1 });
  expect((await run(page, 'value = 2', exercise('python', 'assert value == 2\nassert "secret_previous_run" not in globals()')))?.execution.status).toBe('passed');
  expect((await run(page, 'const value = 2;'))?.execution.status).toBe('passed');
  const cancelled = await page.evaluate(async spec => {
    const started = new Promise<void>(resolve => {
      const listen = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        try { if (JSON.parse(event.data).type === 'started') { window.removeEventListener('message', listen); resolve(); } } catch { /* unrelated message */ }
      };
      window.addEventListener('message', listen);
    });
    const previous = window.sandboxRunner.run('import time\ntime.sleep(0.5)\nvalue = 2', spec);
    await started; window.sandboxRunner.cancel();
    const next = window.sandboxRunner.run('value = 2', spec);
    return Promise.all([previous, next]);
  }, exercise('python', 'assert value == 2'));
  expect(cancelled[0]).toBeNull(); expect(cancelled[1]?.execution.status).toBe('passed');
  expect(wasm).toBe(1); expect(remote).toEqual([]);
});

test('Python 缺包提示给出安装命令', async ({ page }) => {
  await page.route('**/*.whl', route => route.fulfill({ status: 404, body: 'missing' }));
  await harness(page);
  const result = await run(page, 'import numpy as np', exercise('python', 'assert np.ones(1)[0] == 1'));
  expect(result?.execution.status).toBe('error');
  expect(result?.execution.output).toContain('npm run code-runner:packages');
});

test('双向消息拒绝错误来源、过大载荷与过期回包', async ({ page }) => {
  await harness(page);
  expect((await run(page, 'const value = 2;'))?.execution.status).toBe('passed');
  await page.evaluate(spec => {
    const target = document.querySelector('iframe')!.contentWindow!;
    const invalid = { protocol: 'sanxing-code-v1', type: 'run', id: crypto.randomUUID(), text: 'while(true) {}', exercise: spec };
    target.postMessage('x'.repeat(65_537), '*'); target.postMessage(JSON.stringify({ ...invalid, text: 123 }), '*');
    const sibling = document.createElement('iframe'); document.body.append(sibling);
    // Same origin but the wrong window is still not the runner's parent.
    const script = sibling.contentDocument!.createElement('script');
    script.textContent = `parent.document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify(JSON.stringify(invalid))}, '*')`;
    sibling.contentDocument!.body.append(script);
    sibling.remove();
    window.postMessage(JSON.stringify({ protocol: 'sanxing-code-v1', type: 'ready' }), '*');
  }, exercise());
  const pending = run(page, 'await new Promise(r => setTimeout(r, 500)); const value = 2;');
  const frame = page.frames().find(frame => frame.url().includes('/code-runner/runner.html'))!;
  await frame.evaluate(() => {
    parent.postMessage('x'.repeat(65_537), '*');
    parent.postMessage(JSON.stringify({ protocol: 'sanxing-code-v1', type: 'result', id: crypto.randomUUID(), result: { execution: { status: 'error', total: 1, passed: 0, output: '过期', durationMs: 0, ranAt: new Date().toISOString() }, tests: [] } }), '*');
  });
  expect((await pending)?.execution.status).toBe('passed');
});
