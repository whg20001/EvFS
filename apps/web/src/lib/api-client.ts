import { LIMITS } from '@sanxing/contracts';
export type DocumentImportProgress = { phase: 'reading' | 'parsing' | 'saving' | 'uploading'; completed?: number; total?: number };
export type ImportOptions = { onImportProgress?: (progress: DocumentImportProgress) => void };
export type RequestOptions = RequestInit & ImportOptions;
export type ApiOptions = { method?: string; body?: unknown; signal?: AbortSignal } & ImportOptions;
export type ApiClient = <T>(path: string, options?: ApiOptions) => Promise<T>;
type LocalTransport = (path: string, options?: RequestOptions) => Promise<unknown>;
let localTransport: LocalTransport | null = null;
export function useLocalTransport(transport: LocalTransport | null) { localTransport = transport; }

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
/** User-facing text of a failure; non-Error throwables get the caller's fallback. */
export const errorMessage = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;
export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // HTTP on a WSL/LAN IP is not a secure context; getRandomValues still works.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  if (localTransport && !isCloudPath(path)) {
    try { return await localTransport(path, options) as T; }
    catch (error) {
      if (error instanceof HttpError) throw error;
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 400;
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'LOCAL_REQUEST_FAILED';
      throw new HttpError(status, code, errorMessage(error, '本地操作失败，请检查输入或浏览器存储空间。'));
    }
  }
  return cloudRequest<T>(path, options);
}
function isCloudPath(path: string) {
  const url = path.split('?')[0];
  return url?.startsWith('/auth/') || url?.startsWith('/gateway/') || url?.startsWith('/admin/') || url?.startsWith('/activity/') || url?.startsWith('/ocr/') || url === '/ai/access' || url?.startsWith('/ai/oauth/') ||
    /^\/ai\/providers\/[^/]+\/disconnect$/.test(url ?? '') || url === '/ai/skills/cloud';
}
export async function cloudRequest<T>(path: string, options?: RequestOptions): Promise<T> {
  const { onImportProgress, ...init } = options ?? {};
  if (init.body instanceof FormData) onImportProgress?.({ phase: 'uploading' });
  const timeout = AbortSignal.timeout(path === '/ocr/recognize' ? LIMITS.ocrRequestTimeoutMs : path.split('?')[0] === '/documents' && init.body instanceof FormData ? 120000 : 30000);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`/api${path}`, { ...init, signal, credentials: 'same-origin', cache: 'no-store' });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    let message = '服务暂时不可用，请稍后重试。';
    let code = '';
    if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object') {
      if ('message' in body.error && typeof body.error.message === 'string') message = body.error.message;
      if ('code' in body.error && typeof body.error.code === 'string') code = body.error.code;
    }
    throw new HttpError(response.status, code, message);
  }
  return body as T;
}
