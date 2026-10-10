import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

// Wire contract shared with apps/web/server.mjs; never trust ordinary forwarding headers.
const PURPOSE = 'sanxing:login-client-address:v1';
const MAX_AGE_MS = 30_000;

function normalizeIp(value: string): string | undefined {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return undefined;
  const canonical = new URL(`http://[${value.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function loginClientAddress(request: {
  ip: string; method: string; url: string; headers: Record<string, string | string[] | undefined>;
}, secret: string, now = Date.now()): string {
  const socketIp = normalizeIp(request.ip) ?? request.ip;
  if (!(socketIp === '::1' || (isIP(socketIp) === 4 && socketIp.startsWith('127.'))) || secret.length < 32) return socketIp;
  const ip = request.headers['x-sanxing-client-ip'];
  const timestamp = request.headers['x-sanxing-proxy-timestamp'];
  const signature = request.headers['x-sanxing-proxy-signature'];
  if (typeof ip !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') return socketIp;
  if (normalizeIp(ip) !== ip || !/^\d{13}$/.test(timestamp) || !/^[\da-f]{64}$/.test(signature)) return socketIp;
  const age = now - Number(timestamp);
  if (!Number.isFinite(age) || age < -5_000 || age > MAX_AGE_MS) return socketIp;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify([PURPOSE, ip, timestamp, request.method, request.url])).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? ip : socketIp;
}
