import { transform } from 'sucrase';
import { LIMITS } from '@sanxing/contracts/limits';
import type { PyodideInterface } from 'pyodide';
import { PROTOCOL, runResult, type RunRequest, type RunResult } from './protocol.ts';

let python: PyodideInterface | null = null;
let output = '';
let reportOutput = () => {};
const send = globalThis.postMessage.bind(globalThis);
function print(...args: unknown[]) {
  if (output.length >= LIMITS.codeOutputChars) return;
  output = (output + args.map(value => typeof value === 'string' ? value : String(value)).join(' ') + '\n').slice(0, LIMITS.codeOutputChars);
  reportOutput();
}
function assert(value: unknown, message = '断言失败'): asserts value { if (!value) throw new Error(message); }
function equal(a: unknown, b: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Map && b instanceof Map) return equal([...a], [...b], seen);
  if (a instanceof Set && b instanceof Set) return equal([...a], [...b], seen);
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(Reflect.get(a, key), Reflect.get(b, key), seen));
}
function assertEqual(a: unknown, b: unknown) { assert(equal(a, b), '实际值与预期值不相等'); }
function assertClose(a: number, b: number, tolerance = 1e-6) { assert(Number.isFinite(a) && Number.isFinite(b) && tolerance >= 0 && Math.abs(a - b) <= tolerance, '数值误差超过容差'); }
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let busy = false;
globalThis.addEventListener('message', async event => {
  const { request, runtime } = event.data as { request: RunRequest; runtime: string };
  if (busy) return;
  busy = true; output = '';
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) globalThis.console[method] = print;
  const start = performance.now();
  const tests: RunResult['tests'] = [];
  let lastOutput = 0;
  reportOutput = () => { if (performance.now() - lastOutput < 100) return; lastOutput = performance.now(); send({ protocol: PROTOCOL, type: 'output', id: request.id, output }); };
  const started = () => send({ protocol: PROTOCOL, type: 'started', id: request.id });
  const record = (index: number, error?: unknown) => {
    const message = error === undefined ? undefined : String(error).slice(0, 500);
    tests.push({ name: request.exercise.tests[index].name, passed: error === undefined, ...(message ? { error: message } : {}) });
    if (message) print(message);
  };
  let status: RunResult['execution']['status'] = 'error';
  try {
    if (request.exercise.language === 'python') {
      const base = `${runtime}pyodide/`;
      if (!python) {
        const { loadPyodide } = await import(/* webpackIgnore: true */ `${base}pyodide.mjs`);
        python = await loadPyodide({ indexURL: base, lockFileURL: `${base}pyodide-lock.json`, packageBaseUrl: base, cdnUrl: base, stdout: print, stderr: print });
      }
      const py = python!;
      py.setStdout({ batched: print }); py.setStderr({ batched: print });
      // Pyodide's scanner also sees imports used exclusively by visible tests.
      let packageError = false;
      try { await py.loadPackagesFromImports([request.text, ...request.exercise.tests.map(test => test.code)].join('\n'), { messageCallback: () => {}, errorCallback: () => { packageError = true; } }); if (packageError) throw new Error('缺少本地包'); }
      catch { throw new Error('Python 依赖未安装或加载失败。请在项目根目录执行 npm run code-runner:packages，再重试。'); }
      started();
      const globals = py.runPython('dict()');
      try {
        await py.runPythonAsync(request.text, { globals });
        for (const [index, test] of request.exercise.tests.entries()) {
          try { await py.runPythonAsync(test.code, { globals }); record(index); } catch (error) { record(index, error); }
        }
      } finally { globals.destroy(); }
    } else {
      started();
      const body = `${request.text}\n${request.exercise.tests.map((test, index) => `try { await (async () => {\n${test.code}\n})(); __record(${index}); } catch (__error) { __record(${index}, __error); }`).join('\n')}`;
      const js = request.exercise.language === 'typescript' ? transform(body, { transforms: ['typescript'], disableESTransforms: true }).code : body;
      await new AsyncFunction('assert', 'assertEqual', 'assertClose', '__record', 'console', js)(assert, assertEqual, assertClose, record, { log: print, info: print, warn: print, error: print, debug: print });
    }
    status = tests.every(test => test.passed) && tests.length === request.exercise.tests.length ? 'passed' : 'failed';
  } catch (error) { print(error); }
  const result = runResult(request, status, output, performance.now() - start, tests);
  send({ protocol: PROTOCOL, type: 'result', id: request.id, result }); busy = false;
});
