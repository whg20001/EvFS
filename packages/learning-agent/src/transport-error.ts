import { transportErrorCodeSchema, type RunTransport } from '@sanxing/contracts';

/** Bounded cause/AggregateError traversal. Only allowlisted codes and operations escape. */
export function transportError(error: unknown): Pick<RunTransport, 'errorCode' | 'syscall'> {
  const queue = [error]; const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 16; i++) {
    const value = queue[i];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const fields = value as Record<string, unknown>;
    const code = transportErrorCodeSchema.safeParse(fields.code);
    if (code.success) {
      const syscall = fields.syscall;
      return { errorCode: code.data, ...(['connect', 'read', 'write', 'getaddrinfo'].includes(syscall as string)
        ? { syscall: syscall as RunTransport['syscall'] } : {}) };
    }
    if (fields.cause) queue.push(fields.cause);
    if (Array.isArray(fields.errors)) queue.push(...fields.errors.slice(0, 8));
  }
  return {};
}
