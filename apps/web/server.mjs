import { createHmac } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('.', import.meta.url));
const PURPOSE = 'sanxing:login-client-address:v1';
const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const privateHeader = name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-') || name.startsWith('x-sanxing-');

export function normalizeIp(value) {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return undefined;
  const canonical = new URL(`http://[${value.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function apiDestination(value = 'http://127.0.0.1:4000') {
  const url = new URL(value);
  const ip = normalizeIp(url.hostname.replace(/^\[|\]$/g, ''));
  // Literal loopback only: no DNS rebinding, remote secret-derived signatures or SSRF.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(ip === '::1' || (ip && isIP(ip) === 4 && ip.startsWith('127.')))) {
    throw new Error('API_INTERNAL_URL must be an HTTP(S) origin with a literal loopback address');
  }
  return url;
}

function cleanHeaders(headers) {
  const connection = String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    return !privateHeader(lower) && !hopByHop.has(lower) && !connection.includes(lower);
  }));
}

export function createWebHandler({ apiUrl = 'http://127.0.0.1:4000', secret, nextHandler = (_req, res) => { res.writeHead(404).end(); } }) {
  const destination = apiDestination(apiUrl);
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET must be configured (32+ characters)');
  const send = destination.protocol === 'https:' ? httpsRequest : httpRequest;
  return (req, res) => {
    // All remote traffic through the normal entrance is re-signed from the socket.
    // If WSL/NAT already merged client addresses, headers cannot recover them safely.
    const ip = normalizeIp(req.socket.remoteAddress ?? '');
    if (!ip) { res.writeHead(400).end('Missing client address'); return; }
    const url = req.url ?? '/';
    // Reject non-origin-form targets; never resolve a browser-supplied authority.
    if (!url.startsWith('/') || url.startsWith('//')) { res.writeHead(400).end('Invalid request target'); return; }
    const headers = cleanHeaders(req.headers);
    req.headers = headers;
    req.rawHeaders = req.rawHeaders.flatMap((value, index, all) => index % 2 === 0 && !privateHeader(value.toLowerCase()) ? [value, all[index + 1]] : []);
    if (!(url === '/api' || url.startsWith('/api/') || url.startsWith('/api?'))) {
      Promise.resolve().then(() => nextHandler(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end('Internal server error');
        else res.destroy();
      });
      return;
    }
    const timestamp = String(Date.now());
    headers.host = destination.host;
    headers['x-sanxing-client-ip'] = ip;
    headers['x-sanxing-proxy-timestamp'] = timestamp;
    headers['x-sanxing-proxy-signature'] = createHmac('sha256', secret)
      .update(JSON.stringify([PURPOSE, ip, timestamp, req.method, url])).digest('hex');
    const upstream = send(destination, { method: req.method, path: url, headers }, response => {
      res.writeHead(response.statusCode ?? 502, cleanHeaders(response.headers));
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('API unavailable');
      else res.destroy();
    });
    upstream.setTimeout(120_000, () => upstream.destroy());
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  };
}

export function attachNextHandlers(server, { app, dev }) {
  // Next 16.4's prepared custom-server getters expose the router handlers.
  // Do not use getRequestHandler(): it lazily installs an unguarded upgrade
  // listener on the first HTTP request. getUpgradeHandler() instead reaches
  // the render server, not the router's dev/HMR handler.
  const handle = app.requestHandler;
  const upgrade = app.upgradeHandler;
  const sockets = new Set();
  let closing = false;
  server.on('upgrade', (req, socket, head) => {
    // This app has no basePath/assetPrefix. Installed Next's router and client
    // both use /_next/hmr; reject prefix lookalikes and the old webpack path.
    if (closing || !dev || !/^\/_next\/hmr(?:\?[^#]*)?$/.test(req.url ?? '')) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    for (const name of Object.keys(req.headers)) if (privateHeader(name.toLowerCase())) delete req.headers[name];
    req.rawHeaders = req.rawHeaders.flatMap((value, index, all) => index % 2 === 0 && !privateHeader(value.toLowerCase()) ? [value, all[index + 1]] : []);
    // Preserve Upgrade/Connection and head bytes for Next's WS handshake.
    Promise.resolve().then(() => {
      if (!closing && !socket.destroyed) return upgrade(req, socket, head);
    }).catch(() => socket.destroy());
  });
  return {
    handle,
    closeUpgraded() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

export function loadServerEnvironment({ profile = process.env.SANXING_NEXT_PROFILE, rootEnvPath = fileURLToPath(new URL('../../.env', import.meta.url)), directory = webDir } = {}) {
  if (profile === 'e2e' || profile === 'validation') {
    // Next itself loads app-directory .env files. Fail closed before importing it.
    if (readdirSync(directory).some(name => name === '.env' || name.startsWith('.env.'))) {
      throw new Error('Isolated verification refuses app-directory .env files');
    }
    return;
  }
  if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
}

async function main() {
  loadServerEnvironment();
  const dev = !process.argv.includes('--production');
  process.env.NODE_ENV ??= dev ? 'development' : 'production';
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const hostname = option('--hostname', dev ? '0.0.0.0' : '127.0.0.1');
  const port = Number(option('--port', '3010'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid web port');
  // Validate before preparing Next; keep the secret exclusively in this Node closure.
  const secret = process.env.SESSION_SECRET;
  const apiUrl = process.env.API_INTERNAL_URL;
  let handle;
  const server = createServer(createWebHandler({ apiUrl, secret, nextHandler: (req, res) => handle(req, res) }));
  const { default: next } = await import('next');
  const app = next({ dev, dir: webDir, hostname, port, httpServer: server });
  await app.prepare();
  const nextHandlers = attachNextHandlers(server, { app, dev });
  handle = nextHandlers.handle;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolveListen);
  });
  console.log(`> Web listening at http://${hostname}:${port}`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    // HTTP closeAllConnections deliberately excludes upgraded sockets.
    nextHandlers.closeUpgraded();
    await app.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Web server failed to start; check local configuration and port availability.'); process.exitCode = 1; });
}
