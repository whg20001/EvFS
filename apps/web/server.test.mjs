import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loginClientAddress } from '../api/src/client-address.ts';
import next from 'next';
import { apiDestination, attachNextHandlers, createWebHandler, loadServerEnvironment, normalizeIp } from './server.mjs';

const secret = 'proxy-test-only-secret-0123456789-0123456789';
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function send(origin, { path = '/api/auth/login?next=%2Ftoday&x=1', method = 'POST', headers = {}, body, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, method, headers, localAddress }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function listenNext(t, dev, upgradeHandler) {
  let handle;
  const server = createServer(createWebHandler({ secret, nextHandler: (req, res) => handle(req, res) }));
  // Exercise the installed NextCustomServer getters without prepare(), which
  // would read app configuration/env and start a development build. Only the
  // prepared router implementation is a test double.
  const app = next({ dev, webpack: true });
  app.init = { requestHandler: (_req, res) => res.end('Next page'), upgradeHandler };
  const handlers = attachNextHandlers(server, { app, dev });
  handle = handlers.handle;
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
    handlers.closeUpgraded();
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, handlers, origin: `http://127.0.0.1:${server.address().port}` };
}

function upgradeConnection(t, origin, path, { headers = {}, head = '' } = {}) {
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port) });
  t.after(() => socket.destroy());
  const chunks = [];
  let error;
  socket.on('data', chunk => chunks.push(chunk));
  socket.on('error', value => { if (value.code !== 'ECONNRESET') error = value; });
  socket.setTimeout(2000, () => socket.destroy(new Error('Upgrade socket did not close')));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.on('connect', () => socket.write([
    `GET ${path} HTTP/1.1`, `Host: ${new URL(origin).host}`, 'Connection: Upgrade', 'Upgrade: websocket',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', head,
  ].join('\r\n')));
  return { socket, closed, response: () => Buffer.concat(chunks).toString(), assertNoError: () => assert.ifError(error) };
}

const forged = {
  'x-forwarded-for': '198.51.100.250', 'x-forwarded-host': 'attacker.example', 'x-real-ip': '198.51.100.251', forwarded: 'for=198.51.100.252',
  'x-sanxing-client-ip': '198.51.100.253', 'x-sanxing-proxy-timestamp': String(Date.now()), 'x-sanxing-proxy-signature': 'a'.repeat(64), 'x-sanxing-arbitrary': 'untrusted',
};

test('socket-derived identities overwrite malicious headers and isolate two real source buckets', async t => {
  const seen = [];
  const buckets = new Map();
  const api = await listen(t, (req, res) => {
    const ip = loginClientAddress({ ip: req.socket.remoteAddress, method: req.method, url: req.url, headers: req.headers }, secret);
    seen.push({ ip, headers: req.headers });
    buckets.set(ip, (buckets.get(ip) ?? 0) + 1);
    res.writeHead(401).end('Unauthorized');
  });
  const web = await listen(t, createWebHandler({ apiUrl: api, secret }));
  for (const localAddress of ['127.0.0.2', '127.0.0.2', '127.0.0.3']) {
    const result = await send(web, { headers: forged, localAddress });
    assert.equal(result.status, 401);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes('x-sanxing-'));
  }
  assert.deepEqual([...buckets], [['127.0.0.2', 2], ['127.0.0.3', 1]]);
  for (const { ip, headers } of seen) {
    assert.equal(headers['x-sanxing-client-ip'], ip);
    for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'x-sanxing-arbitrary']) assert.equal(headers[name], undefined);
    assert.ok(!JSON.stringify(headers).includes(secret));
  }
});

test('streams multipart bytes, method/raw query, origin and cookies; preserves status and Set-Cookie without signature leakage', async t => {
  const body = '--offline-boundary\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\n你好\u0000binary\r\n--offline-boundary--\r\n';
  let captured;
  const api = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { body: Buffer.concat(chunks), headers: req.headers, method: req.method, url: req.url };
    res.writeHead(429, { 'content-type': 'application/json', 'set-cookie': ['session=a; HttpOnly; SameSite=Strict', 'other=b; HttpOnly'],
      'retry-after': '60', 'x-sanxing-proxy-signature': req.headers['x-sanxing-proxy-signature'], 'x-sanxing-client-ip': req.headers['x-sanxing-client-ip'] });
    res.end('{"error":"limited"}');
  });
  const web = await listen(t, createWebHandler({ apiUrl: api, secret }));
  const result = await send(web, { path: '/api/uploads?name=%2f%20&name=b', body, headers: {
    ...forged, 'content-type': 'multipart/form-data; boundary=offline-boundary', 'content-length': Buffer.byteLength(body),
    cookie: 'session=offline', origin: 'http://localhost:3027', connection: 'keep-alive, x-hop-secret', 'x-hop-secret': 'strip-me',
  } });
  assert.equal(result.status, 429);
  assert.equal(result.body, '{"error":"limited"}');
  assert.equal(result.headers['retry-after'], '60');
  assert.deepEqual(result.headers['set-cookie'], ['session=a; HttpOnly; SameSite=Strict', 'other=b; HttpOnly']);
  assert.equal(result.headers['x-sanxing-proxy-signature'], undefined);
  assert.equal(result.headers['x-sanxing-client-ip'], undefined);
  assert.deepEqual(captured.body, Buffer.from(body));
  assert.equal(captured.headers['content-type'], 'multipart/form-data; boundary=offline-boundary');
  assert.equal(captured.headers.cookie, 'session=offline');
  assert.equal(captured.headers.origin, 'http://localhost:3027');
  assert.equal(captured.headers.host, new URL(api).host);
  assert.equal(captured.headers['x-hop-secret'], undefined);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/api/uploads?name=%2f%20&name=b');
  const expected = createHmac('sha256', secret).update(JSON.stringify(['sanxing:login-client-address:v1', '127.0.0.1', captured.headers['x-sanxing-proxy-timestamp'], captured.method, captured.url])).digest('hex');
  assert.equal(captured.headers['x-sanxing-proxy-signature'], expected);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('normal Next requests see no spoofed forwarding or private headers', async t => {
  let captured;
  const web = await listen(t, createWebHandler({ secret, nextHandler(req, res) {
    captured = { headers: req.headers, raw: req.rawHeaders };
    res.end('Next page');
  } }));
  assert.equal((await send(web, { path: '/login', headers: forged })).body, 'Next page');
  for (const name of Object.keys(forged)) {
    assert.equal(captured.headers[name], undefined);
    assert.ok(!captured.raw.map(value => value.toLowerCase()).includes(name));
  }
});

test('rejects non-loopback API destinations and origin overrides without connecting', async t => {
  for (const origin of ['http://example.com', 'http://localhost:4000', 'http://192.0.2.1', 'http://127.0.0.1.evil.example', 'http://user:password@127.0.0.1', 'file:///tmp/api', 'http://127.0.0.1/api', 'http://127.0.0.1?url=external', 'http://127.0.0.1#fragment']) {
    assert.throws(() => apiDestination(origin));
  }
  for (const origin of ['http://127.0.0.1:4000', 'https://127.0.0.2:4000', 'http://[::1]:4000']) assert.ok(apiDestination(origin));
  let reached = false;
  const web = await listen(t, createWebHandler({ secret, nextHandler(_req, res) { reached = true; res.end(); } }));
  for (const path of ['http://example.com/api/login', '//example.com/api/login']) assert.equal((await send(web, { path })).status, 400);
  assert.equal(reached, false);
  assert.throws(() => createWebHandler({ secret: '' }), /SESSION_SECRET/);
});

test('returns a generic 502 for local API failure without leaking configuration', async t => {
  const unavailable = createServer();
  await new Promise(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  const port = unavailable.address().port;
  await new Promise(resolve => unavailable.close(resolve));
  const web = await listen(t, createWebHandler({ apiUrl: `http://127.0.0.1:${port}`, secret }));
  const result = await send(web);
  assert.equal(result.status, 502);
  assert.equal(result.body, 'API unavailable');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('unknown upgrades are destroyed before and after the first ordinary request', async t => {
  let forwarded = 0;
  const { server, origin } = await listenNext(t, true, () => { forwarded++; });
  const paths = ['/unsupported-ws', '/api', '/api/ws?x=1', '/_next/webpack-hmr', '/_next/hmr/extra',
    '/_next/hmr-evil', '/_next/hmr#fragment', '//_next/hmr', 'http://localhost/_next/hmr'];
  for (const afterRequest of [false, true]) {
    if (afterRequest) assert.equal((await send(origin, { path: '/' })).body, 'Next page');
    for (const path of paths) {
      // Deliberately omit the WS key/version: the original leak needed no handshake.
      const connection = upgradeConnection(t, origin, path);
      await connection.closed;
      connection.assertNoError();
      assert.equal(connection.response(), '');
    }
    assert.equal(server.listenerCount('upgrade'), 1);
  }
  assert.equal(forwarded, 0);
});

test('production rejects all upgrades, including the real HMR path with query', async t => {
  let forwarded = 0;
  const { origin } = await listenNext(t, false, () => { forwarded++; });
  for (const path of ['/_next/hmr', '/_next/hmr?id=123', '/unsupported-ws', '/api/ws']) {
    const connection = upgradeConnection(t, origin, path);
    await connection.closed;
    connection.assertNoError();
    assert.equal(connection.response(), '');
  }
  assert.equal(forwarded, 0);
});

test('dev HMR reaches the Next router before ordinary requests with head and sanitized headers', async t => {
  const seen = [];
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const { origin, server } = await listenNext(t, true, (req, socket, head) => {
    seen.push({ url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, head });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  for (const path of ['/_next/hmr?id=test%2F123&other=1', '/_next/hmr']) {
    const connection = upgradeConnection(t, origin, path, {
      headers: { ...forged, origin, 'sec-websocket-key': key, 'sec-websocket-version': '13' }, head: 'head-bytes',
    });
    await connection.closed;
    connection.assertNoError();
    assert.match(connection.response(), /^HTTP\/1\.1 101 /);
    assert.match(connection.response(), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    const captured = seen.at(-1);
    assert.equal(captured.url, path);
    assert.equal(captured.head.toString(), 'head-bytes');
    assert.equal(captured.headers.upgrade, 'websocket');
    assert.equal(captured.headers.connection, 'Upgrade');
    assert.equal(captured.headers.origin, origin);
    for (const name of Object.keys(forged)) {
      assert.equal(captured.headers[name], undefined);
      assert.ok(!captured.rawHeaders.map(value => value.toLowerCase()).includes(name));
    }
    assert.equal((await send(origin, { path: '/' })).body, 'Next page');
    assert.equal(server.listenerCount('upgrade'), 1);
  }
  assert.equal(seen.length, 2);
});

test('shutdown destroys accepted upgrade sockets with or without a completed handshake', async t => {
  for (const handshake of [false, true]) {
    let received;
    const accepted = new Promise(resolve => { received = resolve; });
    let upgradedSocket;
    const { server, handlers, origin } = await listenNext(t, true, (_req, socket) => {
      upgradedSocket = socket;
      if (handshake) socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
      received();
    });
    const connection = upgradeConnection(t, origin, '/_next/hmr', {
      headers: handshake ? { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } : {},
    });
    await Promise.race([accepted, connection.closed.then(() => { throw new Error('HMR did not reach Next'); })]);
    const serverClosed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    assert.equal(upgradedSocket.destroyed, false, 'HTTP cleanup alone does not own upgraded sockets');
    handlers.closeUpgraded();
    handlers.closeUpgraded(); // Shutdown is idempotent.
    assert.equal(upgradedSocket.destroyed, true);
    await connection.closed;
    connection.assertNoError();
    if (handshake) assert.match(connection.response(), /^HTTP\/1\.1 101 /);
    await serverClosed;
  }
});

test('failed Next upgrade handlers destroy their sockets', async t => {
  for (const upgradeHandler of [() => { throw new Error('sync'); }, async () => { throw new Error('async'); }]) {
    const { origin } = await listenNext(t, true, upgradeHandler);
    const connection = upgradeConnection(t, origin, '/_next/hmr');
    await connection.closed;
    connection.assertNoError();
    assert.equal(connection.response(), '');
  }
});

test('normalizes mapped IPv6 before signing', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.10'), '192.0.2.10');
  assert.equal(normalizeIp('::ffff:c000:20a'), '192.0.2.10');
  assert.equal(normalizeIp('2001:0DB8::0001'), '2001:db8::1');
  assert.equal(normalizeIp('browser supplied'), undefined);
});

test('e2e and validation never load the root env and refuse Next app env files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sanxing-proxy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appDir = join(directory, 'web');
  await mkdir(appDir);
  // Synthetic fixture only: never use or inspect the owner's .env.
  const rootEnvPath = join(directory, '.env');
  await writeFile(rootEnvPath, 'SANXING_PROXY_TEST_PRIVATE_SENTINEL=must-not-load\n');
  for (const profile of ['e2e', 'validation']) {
    loadServerEnvironment({ profile, directory: appDir, rootEnvPath });
    assert.equal(process.env.SANXING_PROXY_TEST_PRIVATE_SENTINEL, undefined);
  }
  await writeFile(join(appDir, '.env.local'), 'SANXING_PROXY_TEST_PRIVATE_SENTINEL=must-not-load\n');
  for (const profile of ['e2e', 'validation']) {
    assert.throws(() => loadServerEnvironment({ profile, directory: appDir, rootEnvPath }), /refuses/);
    assert.equal(process.env.SANXING_PROXY_TEST_PRIVATE_SENTINEL, undefined);
  }
});
