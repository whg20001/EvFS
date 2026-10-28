import type { NextConfig } from 'next';
import { networkInterfaces } from 'node:os';

// Verification uses a separate Next cache/lock, so it never takes over the owner's dev server.
const profile = process.env.SANXING_NEXT_PROFILE;
const isolated = profile === 'e2e' || profile === 'validation';
const config: NextConfig = {
  experimental: { agentUpgrade: 'security' },
  distDir: isolated ? `.next-${profile}` : '.next',
  typescript: { tsconfigPath: isolated ? 'tsconfig.verification.json' : 'tsconfig.json' },
  // Permit this machine's concrete addresses for WSL/LAN dev assets, not arbitrary hosts.
  allowedDevOrigins: [...new Set(['localhost', ...Object.values(networkInterfaces()).flatMap(entries => entries ?? []).filter(entry => entry.family === 'IPv4').map(entry => entry.address)])],
  async headers() {
    return [
      { source: '/code-runner/:path*', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }, { key: 'X-Content-Type-Options', value: 'nosniff' }] },
      // Fail closed when Host cannot match the scoped policy below (including IPv6 literals).
      { source: '/code-runner/runner.html', headers: [{ key: 'Content-Security-Policy', value: "default-src 'none'; sandbox allow-scripts; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" }] },
      { source: '/code-runner/runner.html', has: [{ type: 'header', key: 'host', value: '(?<runnerHost>[a-zA-Z0-9.-]+(?::[0-9]+)?)' }], headers: [
        { key: 'Content-Security-Policy', value: "default-src 'none'; sandbox allow-scripts; frame-ancestors 'self'; script-src http://:runnerHost/code-runner/ https://:runnerHost/code-runner/ 'unsafe-eval' 'wasm-unsafe-eval' blob:; connect-src http://:runnerHost/code-runner/ https://:runnerHost/code-runner/; worker-src blob:; base-uri 'none'; form-action 'none'" },
        { key: 'Cache-Control', value: 'no-store' },
      ] },
    ];
  },
  transpilePackages: ['@sanxing/contracts'],
  // /api is owned by server.mjs: Next rewrites cannot authenticate the socket peer.
};
export default config;
