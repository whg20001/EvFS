import type { AuthContext } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai/models';
export type { Provider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

interface ProviderPolicy {
  create(): Provider;
  /** Subscription-only in this app: no server API key path. */
  oauthOnly: boolean;
  /** Pi omits max_output_tokens on these OAuth requests, so there is no upstream output hard limit. */
  unboundedOAuthOutput: boolean;
  /** The only hosts an authorization or device-verification URL may point to. */
  authHosts: readonly string[];
  /** Ambient environment prefix the provider SDK may read; always refused. */
  envPrefix: string;
  notice: string;
}

/** One record per provider: a new provider that misses a fact fails to compile. */
const PROVIDERS = {
  openai: { create: openaiProvider, oauthOnly: false, unboundedOAuthOutput: true, authHosts: ['auth.openai.com'], envPrefix: 'OPENAI_',
    notice: 'OpenAI 与 Codex 授权不可互换。需在服务端绑定 127.0.0.1:1455；手工输入须为完整最终回调 URL。' },
  anthropic: { create: anthropicProvider, oauthOnly: false, unboundedOAuthOutput: false, authHosts: ['claude.ai', 'platform.claude.com'], envPrefix: 'ANTHROPIC_',
    notice: '请选择 browser 或 copy_code；copy_code 不占用回调端口，适合 WSL。' },
  'openai-codex': { create: openaiCodexProvider, oauthOnly: true, unboundedOAuthOutput: true, authHosts: ['auth.openai.com'], envPrefix: 'OPENAI_',
    notice: 'Codex 与 OpenAI 授权不可互换。请选择 browser 或 device_code。' },
  xai: { create: xaiProvider, oauthOnly: false, unboundedOAuthOutput: false, authHosts: ['auth.x.ai', 'accounts.x.ai'], envPrefix: 'XAI_',
    notice: '使用 SuperGrok 或 X Premium 订阅（与 Grok Build 同一授权），设备码登录：在官方页面输入设备码，不占用回调端口，适合 WSL。' },
} as const satisfies Record<string, ProviderPolicy>;

export type LiveProviderId = keyof typeof PROVIDERS;
export const LIVE_PROVIDER_IDS = Object.keys(PROVIDERS) as [LiveProviderId, ...LiveProviderId[]];
export const providerPolicy = (id: LiveProviderId): ProviderPolicy => PROVIDERS[id];
export const createExplicitProvider = (id: LiveProviderId): Provider => PROVIDERS[id].create();
export function providerNotice(id: LiveProviderId): string {
  const policy = PROVIDERS[id];
  return `授权不代表免费，不会自动切换 mock/live 或模型。本地凭据状态不代表账号在线；到期凭据可由 Pi 自动刷新。${policy.notice}${policy.unboundedOAuthOutput ? '上游请求省略 max_output_tokens，不保证输出硬上限。' : '上游请求携带 max_output_tokens。'}`;
}

/** Credentials and settings come only from the app; Pi never falls back to process env or files. */
export const isolatedAuthContext: AuthContext = {
  async env() { return undefined; },
  async fileExists() { return false; },
};
const PROVIDER_ENV = new RegExp(`^(${[...new Set(Object.values(PROVIDERS).map(policy => policy.envPrefix)), 'PI_OAUTH_'].join('|')})`, 'i');
const TRANSPORT_ENV = /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i;
/** Set environment names that could redirect provider endpoints, credentials, proxies or TLS trust. */
export function unsafeEnvironmentKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter(name => env[name] && (PROVIDER_ENV.test(name) || TRANSPORT_ENV.test(name)));
}
