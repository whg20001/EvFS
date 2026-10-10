import { usageSchema, type LearningEngine } from '@sanxing/contracts';
import type { LearningService } from './service.ts';

function connectionFailure(error: unknown, aborted: boolean): string {
  // Only recognized codes select fixed messages. Never persist provider text or stacks.
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (aborted || code === 'TIMEOUT' || code === 'CANCELLED') return '连接测试已中断或超时；请求可能已计费。请到 Provider 授权重新点击确认测试。';
  if (code === 'MODEL_NOT_AUTHORIZED') return '连接测试授权已失效或未完成，请到 Provider 授权重新连接后确认测试。';
  if (code === 'INVALID_OUTPUT' || code === 'INVALID_MODEL_OUTPUT' || code === 'OUTPUT_LIMIT') return '连接测试的模型响应校验失败；请求可能已计费。请核对所选模型后重新确认测试。';
  return '连接测试执行失败；请求可能已计费。请到 Provider 授权核对配置后重新确认测试。';
}

/** One worker for the single-process PGlite deployment. All commits are attempt-fenced. */
export class RunWorker {
  private active: Promise<void> | null = null;
  private wakeRequested = false;
  private controllers = new Map<string, AbortController>();
  private stopping = false;
  constructor(private readonly service: LearningService, private readonly engine: LearningEngine) {}
  async start() { await this.service.recoverRuns(); void this.tick(); }
  cancel(id: string) { this.controllers.get(id)?.abort(); }
  /** The host may reconcile only these (at most one) runs inside a command transaction. */
  activeRunIds(): string[] { return [...this.controllers.keys()]; }
  async tick(): Promise<void> {
    if (this.stopping) return;
    this.wakeRequested = true;
    if (this.active) return this.active;
    this.active = this.drainRequested().catch(() => { /* Persisted work remains recoverable; no automatic charged retry. */ }).finally(() => {
      this.active = null;
      // A commit may notify us while the previous drain's final read is settling.
      if (this.wakeRequested && !this.stopping) void this.tick();
    });
    return this.active;
  }
  private async drainRequested() {
    while (this.wakeRequested && !this.stopping) {
      this.wakeRequested = false;
      await this.drain();
    }
  }
  private async drain() {
    while (!this.stopping) {
      if (!Object.values((await this.service.repository.read()).runs).some(run => run.status === 'pending')) return;
      const run = await this.service.claimRun(); if (!run?.attemptId) return;
      const controller = new AbortController(); this.controllers.set(run.id, controller);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort: (() => void) | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(new Error('Task aborted'));
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
          timeout = setTimeout(() => controller.abort(), this.service.config.runTimeoutMs);
        });
        const response = await Promise.race([this.engine.execute(run.task, { signal: controller.signal,
          cacheScope: run.sessionId ?? run.reviewSessionId ?? run.id,
          onUsage: usage => this.service.recordUsage(run.id, run.attempt, usage),
        }), deadline]);
        if (response.usage !== null) await this.service.recordUsage(run.id, run.attempt, response.usage);
        await this.service.finishRun(run.id, run.attemptId, response);
      } catch (error) {
        // Preserve validated counters, never expose provider exception messages or credentials.
        const usage = usageSchema.safeParse(error && typeof error === 'object' && 'usage' in error ? error.usage : null);
        if (usage.success) await this.service.recordUsage(run.id, run.attempt, usage.data);
        await this.service.failRun(run.id, run.attemptId, run.task.kind === 'connection_test' ? connectionFailure(error, controller.signal.aborted) : undefined);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
        this.controllers.delete(run.id);
      }
    }
  }
  async stop() {
    this.stopping = true; this.wakeRequested = false;
    for (const controller of this.controllers.values()) controller.abort();
    await this.active;
  }
}
