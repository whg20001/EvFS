import { AsyncLocalStorage } from 'node:async_hooks';
import { channel, type Channel } from 'node:diagnostics_channel';
import { Agent } from 'undici';
import type { ConnectionPolicy, RunTransport } from '@sanxing/contracts';
import { transportError } from './transport-error.ts';

const context = new AsyncLocalStorage<RequestTransport>();
const counter = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;

/** Host-owned pool: same client/options for both policies, never a global dispatcher override. */
export class LearningTransport {
  private pooled?: Agent;
  private fresh = new Set<Agent>();
  private closed = false;
  private agent() {
    // Bound idle reuse, avoid HTTP/1 pipelining and multiplexed socket counters.
    return new Agent({ connections: 2, pipelining: 1, allowH2: false,
      keepAliveTimeout: 4_000, keepAliveMaxTimeout: 10_000, keepAliveTimeoutThreshold: 2_000 });
  }
  acquire(policy: ConnectionPolicy) {
    if (this.closed) throw new Error('Model transport is closed');
    const dispatcher = policy === 'pooled' ? this.pooled ??= this.agent() : this.agent();
    if (policy === 'fresh') this.fresh.add(dispatcher);
    return { dispatcher, release: () => {
      if (policy === 'fresh' && this.fresh.delete(dispatcher)) void dispatcher.destroy().catch(() => {});
    } };
  }
  async close() {
    this.closed = true;
    const agents = [...this.fresh, ...(this.pooled ? [this.pooled] : [])];
    this.fresh.clear(); this.pooled = undefined;
    await Promise.all(agents.map(agent => agent.destroy().catch(() => {})));
  }
}

/** Per-execution subscriptions; request identity isolates concurrent tasks and unrelated HTTP. */
export class RequestTransport {
  private readonly requests = new WeakSet<object>();
  private subscriptions: { channel: Channel; listener: (message: unknown) => void }[] = [];
  private lease?: ReturnType<LearningTransport['acquire']>;
  private socket?: Record<string, unknown>;
  private baseline = { read: null as number | null, written: null as number | null };
  private closed = false;
  private failed = false;
  private value: RunTransport;
  constructor(private readonly owner: LearningTransport, policy: ConnectionPolicy,
    private readonly active: () => boolean, private readonly observe?: (value: RunTransport) => void) {
    this.value = { policy, phase: 'dispatching', requestCount: 0, reusedSocket: null, bytesRead: null, bytesWritten: null };
  }
  private emit() {
    if (this.closed || !this.active()) return;
    try { this.observe?.({ ...this.value }); } catch { /* Telemetry never alters a request. */ }
  }
  private sampleBytes() {
    for (const [field, base] of [['bytesRead', this.baseline.read], ['bytesWritten', this.baseline.written]] as const) {
      const current = counter(this.socket?.[field]);
      if (base !== null && current !== null && current >= base) this.value[field] = current - base;
    }
  }
  error(error: unknown) {
    if (this.closed || !this.active() || this.failed) return;
    this.failed = true; this.sampleBytes(); Object.assign(this.value, transportError(error)); this.emit();
  }
  response(status: number) {
    if (this.closed || !this.active() || this.failed) return;
    if (status >= 100 && status <= 599) this.value.httpStatus = status;
    if (this.value.phase !== 'complete') this.value.phase = 'streaming';
    this.emit();
  }
  private subscribe(name: string, handler: (message: Record<string, unknown>) => void) {
    const target = channel(name);
    const listener = (input: unknown) => {
      if (this.closed || !this.active() || this.failed) return;
      try { const message = object(input); if (message) handler(message); } catch { /* Channels must never throw into Undici. */ }
    };
    target.subscribe(listener); this.subscriptions.push({ channel: target, listener });
  }
  private start() {
    this.subscribe('undici:request:create', ({ request }) => {
      if (context.getStore() !== this || !object(request)) return;
      this.requests.add(request as object); this.value.requestCount++;
      this.value.phase = 'dispatching'; this.value.reusedSocket = null;
      this.socket = undefined; this.baseline = { read: null, written: null };
      this.value.bytesRead = null; this.value.bytesWritten = null; delete this.value.httpStatus; this.emit();
    });
    const own = (request: unknown) => Boolean(object(request) && this.requests.has(request as object));
    this.subscribe('undici:client:sendHeaders', ({ request, socket }) => {
      if (!own(request)) return;
      this.socket = object(socket);
      this.baseline = { read: counter(this.socket?.bytesRead), written: counter(this.socket?.bytesWritten) };
      // H1 sendHeaders is published before writing this request; positive bytes mean prior use.
      this.value.reusedSocket = this.baseline.written === null ? null : this.baseline.written > 0;
      this.value.phase = 'awaiting_headers'; this.sampleBytes(); this.emit();
    });
    this.subscribe('undici:request:headers', ({ request, response }) => {
      if (own(request)) { this.sampleBytes(); this.response(Number(object(response)?.statusCode)); }
    });
    this.subscribe('undici:request:trailers', ({ request }) => {
      if (own(request)) { this.sampleBytes(); this.value.phase = 'complete'; this.emit(); }
    });
    this.subscribe('undici:request:error', ({ request, error }) => { if (own(request)) this.error(error); });
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.closed) throw new Error('Request transport is closed');
    if (!this.lease) { this.start(); this.lease = this.owner.acquire(this.value.policy); }
    this.emit();
    return context.run(this, async () => {
      try {
        const options = { ...init, dispatcher: this.lease!.dispatcher };
        const response = await globalThis.fetch(input, options);
        this.response(response.status); return response;
      } catch (error) { this.error(error); throw error; }
    });
  };
  close() {
    if (this.closed) return;
    // Completed/failing snapshots are frozen before another request can reuse this socket.
    if (this.lease) { if (!this.failed && this.value.phase !== 'complete') this.sampleBytes(); this.emit(); }
    this.closed = true;
    for (const { channel, listener } of this.subscriptions) channel.unsubscribe(listener);
    this.subscriptions = []; this.socket = undefined; this.lease?.release();
  }
}
