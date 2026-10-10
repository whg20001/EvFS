import { PROTOCOL, RUN_TIMEOUT_MS, LOAD_TIMEOUT_MS, failedResult, type RunRequest } from './protocol.ts';
import { decode, requestSchema, responseSchema } from './protocol-schema.ts';

// location keeps the document URL even though sandbox makes its security origin opaque.
const origin = new URL(location.href).origin;
const runtime = `${origin}/code-runner/`;
let python: Worker | null = null;
let worker: Worker | null = null;
let workerUrl: Promise<string> | null = null;
let active: RunRequest | null = null;
let started = 0;
let output = '';
let timer: ReturnType<typeof setTimeout>;
const send = (value: unknown) => parent.postMessage(JSON.stringify(value), origin);
function dispose() {
  if (worker === python) python = null;
  worker?.terminate(); worker = null;
}
function fail(status: 'error' | 'timeout', message: string) {
  if (!active) return;
  const request = active; active = null; clearTimeout(timer); dispose();
  send({ protocol: PROTOCOL, type: 'result', id: request.id, result: failedResult(request, status, `${message}\n${output}`, performance.now() - started) });
}
function deadline(ms: number) { clearTimeout(timer); timer = setTimeout(() => fail('timeout', '运行超时，沙箱已重建。请检查死循环或缩小输入后重试。'), ms); }
function loadWorker() {
  return workerUrl ??= fetch(`${runtime}worker.js`, { credentials: 'omit', redirect: 'error' }).then(async response => {
    if (!response.ok) throw new Error('运行器文件缺失，请执行 npm run code-runner:build');
    return URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  }).catch(error => { workerUrl = null; throw error; });
}
async function run(request: RunRequest) {
  if (active) return;
  active = request; started = performance.now(); output = ''; deadline(LOAD_TIMEOUT_MS);
  try {
    // JS/TS get fresh workers; their disposal never evicts the warm Python worker.
    const url = await loadWorker();
    if (active !== request) return;
    worker = request.exercise.language === 'python' ? (python ??= new Worker(url)) : new Worker(url);
    const current = worker;
    current.onmessage = event => {
      let message;
      try { message = decode(responseSchema, JSON.stringify(event.data)); } catch { return; }
      if (!message || worker !== current || !active || !('id' in message) || message.id !== active.id) return;
      if (message.type === 'started') deadline(RUN_TIMEOUT_MS);
      if (message.type === 'output') output = message.output;
      if (message.type === 'result') {
        clearTimeout(timer); active = null;
        if (current !== python) current.terminate();
        worker = null;
      }
      send(message);
    };
    current.onerror = event => { if (worker === current) fail('error', `运行器加载或执行失败：${event.message || '浏览器拒绝加载 Worker'}。请执行 npm run code-runner:build。`); };
    current.postMessage({ request, runtime });
  } catch (error) { if (active === request) fail('error', String(error)); }
}
addEventListener('message', event => {
  if (event.source !== parent || event.origin !== origin) return;
  const request = decode(requestSchema, event.data);
  if (request) void run(request);
});
send({ protocol: PROTOCOL, type: 'ready' });
