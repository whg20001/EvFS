import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loginClientAddress } from '../src/client-address.ts';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import type { Repository } from '@sanxing/database';

const secret = 'client-address-test-only-secret-0123456789';
const now = 1_800_000_000_000;
const url = '/api/auth/login?return=%2Ftoday&x=1';
const request = { ip: '127.0.0.1', method: 'POST', url, headers: {} as Record<string, string | string[] | undefined> };
function signed(ip: string, timestamp = now, key = secret, method = 'POST', path = url) {
  const time = String(timestamp);
  return {
    'x-sanxing-client-ip': ip, 'x-sanxing-proxy-timestamp': time,
    'x-sanxing-proxy-signature': createHmac('sha256', key)
      .update(JSON.stringify(['sanxing:login-client-address:v1', ip, time, method, path])).digest('hex'),
  };
}
const address = (headers: typeof request.headers, overrides = {}) => loginClientAddress({ ...request, headers, ...overrides }, secret, now);

describe('authenticated login client addresses', () => {
  it('enforces separate rate limits through the actual login route and ignores forged forwarding headers', async () => {
    const config = readConfig({ AI_MODE: 'mock', OWNER_PASSWORD: 'offline-login-integration-password', SESSION_SECRET: secret });
    const unexpectedDatabaseAccess = async (): Promise<never> => { throw new Error('Login must not access learning data'); };
    const repository: Repository = { read: unexpectedDatabaseAccess, revision: unexpectedDatabaseAccess, transact: unexpectedDatabaseAccess, replace: unexpectedDatabaseAccess, close: async () => {} };
    const { app } = await createApp({ config, repository, engine: { mode: 'mock', execute: async () => { throw new Error('No model calls in login tests'); } }, startWorker: false });
    try {
      const login = (ip: string, password: string, extraHeaders = {}) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1',
        headers: { ...signed(ip, Date.now(), secret, 'POST', '/api/auth/login'), ...extraHeaders }, payload: { password } });
      for (let attempt = 0; attempt < 8; attempt++) expect((await login('192.0.2.10', 'wrong-password')).statusCode).toBe(401);
      const blocked = await login('192.0.2.10', config.ownerPassword, { 'x-forwarded-for': '198.51.100.20', 'x-real-ip': '198.51.100.20' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
      expect((await login('198.51.100.20', config.ownerPassword)).statusCode).toBe(200);
      // Unsigned direct-loopback requests share their socket bucket regardless of XFF.
      for (let attempt = 0; attempt < 8; attempt++) {
        expect((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}` }, payload: { password: 'wrong-password' } })).statusCode).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.100' }, payload: { password: config.ownerPassword } })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it('isolates the login bucket keys of two authenticated real source addresses', () => {
    const buckets = new Map<string, number>();
    for (const ip of ['192.0.2.10', '192.0.2.10', '198.51.100.20']) {
      const key = address(signed(ip));
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    expect([...buckets]).toEqual([['192.0.2.10', 2], ['198.51.100.20', 1]]);
  });

  it('ignores forged forwarding headers and unsigned identity, including loopback callers', () => {
    const headers = { 'x-forwarded-for': '192.0.2.10', 'x-real-ip': '192.0.2.11', forwarded: 'for=192.0.2.12', 'x-sanxing-client-ip': '192.0.2.13' };
    expect(address(headers)).toBe('127.0.0.1');
    expect(address(headers, { ip: '::ffff:198.51.100.20' })).toBe('198.51.100.20');
    expect(address({ ...headers, 'x-sanxing-proxy-timestamp': String(now), 'x-sanxing-proxy-signature': '0'.repeat(64) })).toBe('127.0.0.1');
  });

  it('rejects even valid signatures from non-loopback sockets', () => {
    for (const ip of ['198.51.100.20', '::ffff:198.51.100.20', '2001:db8::1', '128.0.0.1']) {
      expect(address(signed('192.0.2.10'), { ip })).not.toBe('192.0.2.10');
    }
  });

  it('accepts IPv4, IPv6 and IPv4-mapped loopback peers', () => {
    for (const ip of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(address(signed('2001:db8::10'), { ip })).toBe('2001:db8::10');
    }
    expect(address({}, { ip: '::ffff:c000:20a' })).toBe('192.0.2.10');
    expect(address({}, { ip: '2001:0DB8:0:0:0:0:0:0010' })).toBe('2001:db8::10');
  });

  it('fails closed for expired/future timestamps and a different secret', () => {
    expect(address(signed('192.0.2.10', now - 30_000))).toBe('192.0.2.10');
    for (const headers of [signed('192.0.2.10', now - 30_001), signed('192.0.2.10', now + 5_001), signed('192.0.2.10', now, 'wrong-secret'), signed('192.0.2.10', NaN)]) {
      expect(address(headers)).toBe('127.0.0.1');
    }
    expect(loginClientAddress({ ...request, headers: signed('192.0.2.10') }, '', now)).toBe('127.0.0.1');
  });

  it('binds IP, method and the complete raw path/query', () => {
    const headers = signed('192.0.2.10');
    expect(address({ ...headers, 'x-sanxing-client-ip': '192.0.2.11' })).toBe('127.0.0.1');
    expect(address(headers, { method: 'GET' })).toBe('127.0.0.1');
    for (const path of ['/api/auth/login', '/api/auth/logout?return=%2Ftoday&x=1', '/api/auth/login?return=/today&x=1', `${url}&extra=1`]) {
      expect(address(headers, { url: path })).toBe('127.0.0.1');
    }
  });

  it('rejects duplicate, malformed and non-canonical signing fields', () => {
    for (const ip of ['unknown', '192.0.2.10, 192.0.2.11', '::ffff:192.0.2.10', '2001:0db8::1']) expect(address(signed(ip))).toBe('127.0.0.1');
    for (const name of ['x-sanxing-client-ip', 'x-sanxing-proxy-timestamp', 'x-sanxing-proxy-signature']) {
      const headers = signed('192.0.2.10');
      const value = headers[name as keyof typeof headers];
      expect(address({ ...headers, [name]: [value, value] })).toBe('127.0.0.1');
      expect(address({ ...headers, [name]: '' })).toBe('127.0.0.1');
    }
    expect(address({ ...signed('192.0.2.10'), 'x-sanxing-proxy-signature': 'z'.repeat(64) })).toBe('127.0.0.1');
  });
});
