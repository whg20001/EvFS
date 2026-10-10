import { AiAccessError } from './errors.ts';
import { LIVE_PROVIDER_IDS, providerPolicy, unsafeEnvironmentKeys, type LiveProviderId } from './providers.ts';
export { isolatedAuthContext } from './providers.ts';

export function assertOfficialEnvironment(): void {
  // Some SDK modules inspect process.env directly; deny rather than mutating global state.
  if (unsafeEnvironmentKeys().length) throw new AiAccessError('unsafe', 503);
}
export function officialURL(value: string, providerId: string): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new AiAccessError('unsafe');
  if (!LIVE_PROVIDER_IDS.includes(providerId as LiveProviderId)) throw new AiAccessError('unsafe');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !providerPolicy(providerId as LiveProviderId).authHosts.includes(url.hostname)) throw new AiAccessError('unsafe');
  return url.href;
}
export function safeExpiry(expires: number): string | null {
  return Number.isFinite(expires) && Math.abs(expires) <= 8.64e15 ? new Date(expires).toISOString() : null;
}
