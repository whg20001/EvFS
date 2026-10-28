type Completion = { completed: () => boolean; signal?: AbortSignal };

/** Pi cancels after the terminal event, potentially before HTTP EOF. Drain only a completed tail. */
function completedBody(body: ReadableStream<Uint8Array>, completion: Completion): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const cancel = (reason?: unknown) => { void reader.cancel(reason).catch(() => {}); };
  const release = () => { try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); release(); } else controller.enqueue(value);
      } catch (error) { controller.error(error); release(); }
    },
    async cancel(reason) {
      if (!completion.completed() || completion.signal?.aborted) { cancel(reason); release(); return; }
      const deadline = performance.now() + 250;
      let stop!: () => void;
      const stopped = new Promise<void>(resolve => { stop = () => { cancel(reason); resolve(); }; });
      const timer = setTimeout(stop, 250);
      completion.signal?.addEventListener('abort', stop, { once: true });
      try {
        if (completion.signal?.aborted) { stop(); return; }
        await Promise.race([stopped, (async () => {
          let bytes = 0;
          while (performance.now() < deadline && !completion.signal?.aborted) {
            const { done, value } = await reader.read();
            if (done) return;
            bytes += value.byteLength;
            if (bytes > 64 * 1024) break;
          }
          cancel(reason);
        })()]);
      } catch { /* A tail failure cannot revoke an already complete model response. */ }
      finally { clearTimeout(timer); completion.signal?.removeEventListener('abort', stop); release(); }
    },
  }, { highWaterMark: 0 });
}

/** Pi 1.0.4's Codex parser splits on LF LF only. Normalize SSE line endings incrementally. */
export function normalizeCodexSse(response: Response, completion?: Completion): Response {
  if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') return response;
  let previousCR = false;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!previousCR && !chunk.includes(13)) { controller.enqueue(chunk); return; }
      const normalized = new Uint8Array(chunk.length); let length = 0;
      // CR/LF are single-byte ASCII; leave UTF-8 and JSON-escaped line endings untouched.
      for (const byte of chunk) {
        if (!(previousCR && byte === 10)) normalized[length++] = byte === 13 ? 10 : byte;
        previousCR = byte === 13;
      }
      if (length) controller.enqueue(normalized.subarray(0, length));
    },
  }));
  const headers = new Headers(response.headers); headers.delete('content-length');
  return new Response(completion ? completedBody(body, completion) : body, { status: response.status, statusText: response.statusText, headers });
}
