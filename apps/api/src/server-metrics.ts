import { cpus, totalmem, freemem, loadavg } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ServerMetrics, ServerSample } from '@sanxing/contracts';

/** Single-process, real samples. History intentionally starts empty after a restart. */
export function serverMetrics() {
  const startedAt = new Date().toISOString();
  const cpu = () => cpus().reduce((sum, core) => ({ idle: sum.idle + core.times.idle, total: sum.total + Object.values(core.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  let previous = cpu(); const history: ServerSample[] = [];
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  const sample = () => {
    const current = cpu(); const delta = current.total - previous.total;
    const cpuPercent = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / delta))) : 0; previous = current;
    const eventLoopDelayMs = Number.isFinite(delay.mean) ? delay.mean / 1e6 : 0; delay.reset();
    history.push({ at: new Date().toISOString(), cpuPercent, memoryPercent: (1 - freemem() / totalmem()) * 100, processRssBytes: process.memoryUsage().rss, eventLoopDelayMs });
    if (history.length > 180) history.shift();
  };
  const timer = setInterval(sample, 10000); timer.unref();
  return {
    read(activeRequests: number, sessions: number): ServerMetrics {
      const memory = process.memoryUsage(); const last = history.at(-1);
      return { sampledAt: new Date().toISOString(), startedAt, uptimeSeconds: process.uptime(), cpuCores: cpus().length, totalMemoryBytes: totalmem(), usedMemoryBytes: totalmem() - freemem(),
        processRssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, loadAverage: loadavg(), cpuPercent: last?.cpuPercent ?? 0,
        eventLoopDelayMs: last?.eventLoopDelayMs ?? 0, activeRequests, sessions, history: structuredClone(history) };
    },
    close() { clearInterval(timer); delay.disable(); },
  };
}
