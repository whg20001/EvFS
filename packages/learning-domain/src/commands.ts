import { IDEMPOTENCY_KEY_PATTERN, LIMITS, type AppData, type CommandResult } from '@sanxing/contracts';
import { fingerprint, requireThat } from './policy.ts';
import type { StateRepository } from './repository.ts';

// Only known, non-billable, CAS-protected autosaves are transient. Unknown operations stay durable.
const transientReceipt = /^PUT:\/api\/(?:recitations\/[^/:]+\/draft|questions\/[^/:]+\/draft|knowledge-points\/[^/:]+\/understanding|review-sessions\/[^/:]+\/recall):/;

export async function executeCommand(repository: StateRepository, now: () => Date, operation: string, key: string, body: unknown, action: (state: AppData) => CommandResult | Promise<CommandResult>): Promise<CommandResult> {
  requireThat(IDEMPOTENCY_KEY_PATTERN.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '写入请求需要有效的幂等标识', 400);
  const receiptId = `${operation}:${key}`;
  const hash = fingerprint(body);
  return repository.transact(async data => {
    const previous = data.receipts[receiptId];
    if (previous) {
      requireThat(previous.hash === hash, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同内容');
      return previous.result as CommandResult;
    }
    const result = await action(data);
    data.receipts[receiptId] = { hash, result, createdAt: now().toISOString() };
    const cutoff = now().getTime() - LIMITS.transientReceiptTtlMs;
    const transient = Object.entries(data.receipts).filter(([id, receipt]) => transientReceipt.test(id) && !(receipt.result && typeof receipt.result === 'object' && 'runId' in receipt.result));
    const remaining: typeof transient = [];
    for (const entry of transient) {
      if (Date.parse(entry[1].createdAt) < cutoff) delete data.receipts[entry[0]];
      else remaining.push(entry);
    }
    remaining.sort(([a, x], [b, y]) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || (a < b ? -1 : a > b ? 1 : 0));
    for (const [id] of remaining.slice(0, Math.max(0, remaining.length - LIMITS.transientReceiptMaximum))) delete data.receipts[id];
    return result;
  });
}
