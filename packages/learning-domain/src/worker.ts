import { taskTimeoutMs, usageSchema, runTransportSchema, runRequestSchema, updateRunProgress, type LearningEngine, type LearningProgressEvent, type RunErrorCode, type RunProgress, type RunProgressMap, type RunRequest, type RunTransport } from '@sanxing/contracts';
import type { LearningService } from './service.ts';
import { runFailure } from './run-failure.ts';

/** One worker for the single-process PGlite deployment. All commits are attempt-fenced. */
export class RunWorker {
  private active: Promise<void> | null = null;
  private wakeRequested = false;
  private controllers = new Map<string, AbortController>();
  private liveProgress = new Map<string, { started: number; value: RunProgress; request?: RunRequest; transport?: RunTransport }>();
  private stopping = false;
  constructor(private readonly service: LearningService, private readonly engine: LearningEngine) {}
  async start() { await this.service.recoverRuns(); void this.tick(); }
  cancel(id: string) { this.controllers.get(id)?.abort('CANCELLED'); }
  /** The host may reconcile only these (at most one) runs inside a command transaction. */
  activeRunIds(): string[] { return [...this.controllers.keys()]; }
  /** Transient progress never enters the repository's transaction/read queue. */
  progress(): RunProgressMap {
    return Object.fromEntries([...this.liveProgress].map(([id, { started, value }]) => [id,
      { ...value, elapsedMs: value.completedMs ?? Math.max(value.elapsedMs, Math.floor(performance.now() - started)) },
    ]));
  }
  diagnostics(id: string): { progress: RunProgress; request?: RunRequest; transport?: RunTransport } | undefined {
    const current = this.liveProgress.get(id);
    return current ? { progress: this.progress()[id]!, ...(current.request ? { request: { ...current.request } } : {}), ...(current.transport ? { transport: { ...current.transport } } : {}) } : undefined;
  }
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
      const repository = this.service.repository;
      const pending = repository.hasPendingRuns ? await repository.hasPendingRuns()
        : Object.values((await repository.read()).runs).some(run => run.status === 'pending');
      if (!pending) return;
      const run = await this.service.claimRun(); if (!run?.attemptId) return;
      const controller = new AbortController(); this.controllers.set(run.id, controller);
      const started = performance.now();
      const totalTimeoutMs = taskTimeoutMs(run.task.kind, this.service.config);
      const value: RunProgress = { phase: 'preparing', elapsedMs: 0, totalTimeoutMs,
        queuedMs: Math.max(0, this.service.now().getTime() - Date.parse(run.createdAt)) };
      const diagnostics: { started: number; value: RunProgress; request?: RunRequest; transport?: RunTransport } = { started, value };
      this.liveProgress.set(run.id, diagnostics);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort: (() => void) | undefined;
      let acceptProgress = true;
      // Coalesce callback/return/error delivery. A failed save remains retryable locally.
      let usageDelivery: Promise<void> | undefined;
      const recordUsage = (input: unknown): Promise<void> => {
        const usage = usageSchema.parse(input);
        usageDelivery ??= this.service.recordUsage(run.id, run.attempt, usage).catch(error => {
          usageDelivery = undefined; throw error;
        });
        return usageDelivery;
      };
      const onProgress = (event: LearningProgressEvent) => {
        if (!acceptProgress || controller.signal.aborted) return;
        updateRunProgress(value, event, performance.now() - started);
        if (event === 'validated') clearTimeout(timeout);
      };
      try {
        const deadline = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(new Error('Task aborted'));
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
          timeout = setTimeout(() => controller.abort('TIMEOUT'), totalTimeoutMs);
        });
        const response = await Promise.race([this.engine.execute(run.task, { signal: controller.signal,
          cacheScope: run.sessionId ?? run.reviewSessionId ?? run.id,
          expectedPrompt: { version: run.promptVersion, ...(run.promptHash ? { hash: run.promptHash } : {}) },
          ...(run.evaluation?.connectionPolicy ? { connectionPolicy: run.evaluation.connectionPolicy } : {}),
          onTransport: transport => {
            if (!acceptProgress || controller.signal.aborted) return;
            const parsed = runTransportSchema.safeParse(transport);
            if (parsed.success) diagnostics.transport = parsed.data;
          },
          onUsage: recordUsage,
          onProgress,
          onRequest: request => {
            if (!acceptProgress || controller.signal.aborted || diagnostics.request) return;
            const parsed = runRequestSchema.safeParse(request);
            if (parsed.success) diagnostics.request = parsed.data;
          },
        }), deadline]);
        // Custom engines may not emit events; their returned result still starts saving.
        onProgress('validated');
        if (response.usage !== null) await recordUsage(response.usage);
        await this.service.finishRun(run.id, run.attemptId, response);
      } catch (error) {
        // Failure accounting is storage work too; preserve the original failure category.
        clearTimeout(timeout); acceptProgress = false;
        const interruption = controller.signal.aborted ? controller.signal.reason as RunErrorCode : undefined;
        // Preserve validated counters, never expose provider exception messages or credentials.
        const usage = usageSchema.safeParse(error && typeof error === 'object' && 'usage' in error ? error.usage : null);
        if (usage.success) await recordUsage(usage.data);
        const failure = runFailure(error, run, interruption);
        await this.service.failRun(run.id, run.attemptId, failure.message, failure.code);
      } finally {
        acceptProgress = false;
        if (timeout) clearTimeout(timeout);
        if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
        this.controllers.delete(run.id);
        value.elapsedMs = Math.max(value.elapsedMs, Math.floor(performance.now() - started));
        value.completedMs = value.elapsedMs;
        try { await this.service.recordRunProgress(run.id, run.attempt, value, diagnostics.request, diagnostics.transport); }
        catch { /* Telemetry failure cannot roll back a committed learning result. */ }
        finally { this.liveProgress.delete(run.id); }
      }
    }
  }
  async stop() {
    this.stopping = true; this.wakeRequested = false;
    for (const controller of this.controllers.values()) controller.abort('SERVICE_RESTARTED');
    await this.active;
  }
}
