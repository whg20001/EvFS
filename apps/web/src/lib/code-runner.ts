import { requestId } from './api-client.ts';
import type { CodeExercise } from '@sanxing/contracts';
import { HARD_TIMEOUT_MS, MESSAGE_CHARS_MAXIMUM, PROTOCOL, failedResult, type RunRequest, type RunResult } from '../../code-runner/protocol.ts';
import { decode, requestSchema, responseSchema } from '../../code-runner/protocol-schema.ts';

type WaitingRun = { request: RunRequest; resolve: (result: RunResult | null) => void };
/** The opaque frame may only report bounded, explicitly untrusted evidence. */
export class CodeRunner {
  private frame: HTMLIFrameElement | null = null;
  private ready = false;
  private pending: { request: RunRequest; resolve: WaitingRun['resolve'] | null; sent: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  private queued: WaitingRun | null = null;
  constructor() { window.addEventListener('message', this.receive); }
  private receive = (event: MessageEvent) => {
    if (event.source !== this.frame?.contentWindow || event.origin !== 'null') return;
    const message = decode(responseSchema, event.data);
    if (!message) return;
    if (message.type === 'ready') { this.ready = true; this.dispatch(); return; }
    if (!this.pending || message.id !== this.pending.request.id || message.type !== 'result') return;
    const { request } = this.pending;
    if (message.result.execution.total !== request.exercise.tests.length || message.result.tests.some((test, index) => test.name !== request.exercise.tests[index]?.name)) return;
    clearTimeout(this.pending.timer); this.pending.resolve?.(message.result); this.pending = null; this.dispatch();
  };
  private dispatch() {
    if (!this.pending && this.queued) {
      const { request, resolve } = this.queued; this.queued = null;
      const start = performance.now();
      const timer = setTimeout(() => {
        if (this.pending?.request.id !== request.id) return;
        this.pending.resolve?.(failedResult(request, 'timeout', '沙箱未响应，已销毁并重建。请重试。', performance.now() - start));
        this.pending = null; this.resetFrame(); this.mount(); this.dispatch();
      }, HARD_TIMEOUT_MS);
      this.pending = { request, resolve, timer, sent: false };
    }
    if (this.ready && this.pending && !this.pending.sent) {
      this.pending.sent = true;
      this.frame?.contentWindow?.postMessage(JSON.stringify(this.pending.request), '*');
    }
  }
  private mount() {
    this.frame = document.createElement('iframe'); this.frame.hidden = true;
    this.frame.title = '代码运行沙箱'; this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.src = '/code-runner/runner.html'; document.body.append(this.frame);
  }
  run(text: string, exercise: CodeExercise): Promise<RunResult | null> {
    this.cancel();
    const request = requestSchema.parse({ protocol: PROTOCOL, type: 'run', id: requestId(), text, exercise });
    if (JSON.stringify(request).length > MESSAGE_CHARS_MAXIMUM) return Promise.resolve(failedResult(request, 'error', '代码与测试转义后的消息过大，请精简后重试。', 0));
    if (!this.frame) this.mount();
    return new Promise(resolve => { this.queued = { request, resolve }; this.dispatch(); });
  }
  private resetFrame() { this.frame?.remove(); this.frame = null; this.ready = false; }
  cancel() {
    this.queued?.resolve(null); this.queued = null;
    if (!this.pending) return;
    this.pending.resolve?.(null); this.pending.resolve = null;
    // A dispatched run must finish (or time out) before the next one reaches the frame.
    if (!this.pending.sent) { clearTimeout(this.pending.timer); this.pending = null; }
  }
  destroy() {
    this.cancel();
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null; this.resetFrame(); window.removeEventListener('message', this.receive);
  }
}

let shared: CodeRunner | null = null;
/** Lazy, page-owned runtime survives editor unmounts and client-side navigation. */
export function sharedCodeRunner(): CodeRunner { return shared ??= new CodeRunner(); }
