import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { createExplicitProvider, LIVE_PROVIDER_IDS, providerPolicy, type LiveProviderId } from '@sanxing/ai-access/providers';
import { DomainError } from '@sanxing/learning-domain';
import { platformAiSaveSchema, type AiModelConfiguration, type AiModelSelection, type PlatformAiSettings, type PlatformAiView } from '@sanxing/contracts';
import type { Accounts, PlatformRecord } from './accounts.ts';
import type { ApiConfig } from './config.ts';

export const PLATFORM_SELECTION: AiModelSelection = { providerId: 'platform', modelId: 'managed', authMethod: 'platform', allowUnboundedOutput: false };
export class PlatformAi {
  private readonly key: Buffer;
  private readonly providers = LIVE_PROVIDER_IDS.filter(id => !providerPolicy(id).oauthOnly).map(id => {
    const provider = createExplicitProvider(id);
    return { id, name: provider.name, models: provider.getModels().filter(model => model.input.includes('text')).map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens })) };
  });
  constructor(private accounts: Accounts, private config: ApiConfig) { this.key = createHmac('sha256', config.sessionSecret).update('sanxing:platform-ai:v1').digest(); }
  private seal(value: string, providerId: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(providerId));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  private unseal(value: string, providerId: string) {
    try {
      const bytes = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(providerId)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch { throw new DomainError('PLATFORM_KEY_UNAVAILABLE', '平台密钥无法读取，请管理员重新保存密钥。', 409); }
  }
  private async record(): Promise<PlatformRecord> {
    return await this.accounts.platform() ?? { revision: 0, encryptedKey: null, settings: { enabled: false, label: '每日三省 AI', providerId: '', modelId: '', perUserDailyCalls: 50, globalDailyCalls: 1000, maxConcurrent: 4 } };
  }
  private envKey(settings: PlatformAiSettings) { return this.config.provider === settings.providerId && this.config.modelAuthMethod === 'api_key' ? this.config.apiKey : undefined; }
  private model(settings: PlatformAiSettings) { return this.providers.find(provider => provider.id === settings.providerId)?.models.find(model => model.id === settings.modelId); }
  private ready(record: PlatformRecord) { return record.settings.enabled && !!this.model(record.settings) && (this.config.mode === 'mock' || !!record.encryptedKey || !!this.envKey(record.settings)); }
  async view(): Promise<PlatformAiView> {
    const record = await this.record();
    return { ...record.settings, revision: record.revision, keyConfigured: !!record.encryptedKey || !!this.envKey(record.settings), keySource: record.encryptedKey ? 'saved' : this.envKey(record.settings) ? 'environment' : 'none', mode: this.config.mode,
      providers: this.providers.map(provider => ({ id: provider.id, name: provider.name, models: provider.models.map(({ id, name }) => ({ id, name })) })) };
  }
  async save(actor: string, input: unknown) {
    const { expectedRevision, apiKey, clearKey, ...settings } = platformAiSaveSchema.parse(input);
    if (apiKey && clearKey) throw new DomainError('INVALID_INPUT', '不能同时保存和清除密钥。', 400);
    if ((settings.providerId || settings.modelId || settings.enabled) && !this.model(settings)) throw new DomainError('AI_MODEL_UNSUPPORTED', '请从目录选择有效的 Provider 和模型。', 400);
    const previous = await this.record();
    const encryptedKey = apiKey ? this.seal(apiKey, settings.providerId) : clearKey || previous.settings.providerId !== settings.providerId ? null : previous.encryptedKey;
    const record = { revision: expectedRevision + 1, settings, encryptedKey };
    if (settings.enabled && !this.ready(record)) throw new DomainError('PLATFORM_KEY_REQUIRED', '启用平台 AI 前请保存有效的 API key。', 400);
    await this.accounts.savePlatform(actor, record, expectedRevision);
    return this.view();
  }
  async catalog(userId: string, configuration: AiModelConfiguration): Promise<AiModelConfiguration> {
    const record = await this.record(); const account = await this.accounts.sessionAccount(userId);
    const available = this.ready(record) && !!account?.platformAccess;
    const model = this.model(record.settings);
    return { ...configuration, platform: { label: record.settings.label, available, perUserDailyCalls: record.settings.perUserDailyCalls,
      message: !account?.platformAccess ? '此账号尚未开通平台 AI，请联系管理员。' : available ? '由平台统一提供，无需个人授权。' : '管理员尚未启用平台 AI。' },
      providers: [...configuration.providers, { id: 'platform', name: record.settings.label, oauthConnected: false, apiKeyAvailable: false, platformAvailable: available,
        requiresOAuthOutputAcknowledgement: false, models: model ? [{ ...model, id: 'managed', name: record.settings.label }] : [] }] };
  }
  async resolve(userId: string, selection: AiModelSelection) {
    if (selection.providerId !== 'platform' || selection.modelId !== 'managed' || selection.authMethod !== 'platform' || selection.allowUnboundedOutput) throw new DomainError('AI_MODEL_INVALID', '平台 AI 选择无效，请重新保存。', 400);
    const record = await this.record(); const account = await this.accounts.sessionAccount(userId);
    if (!account?.platformAccess) throw new DomainError('PLATFORM_ACCESS_DISABLED', '此账号未开通平台 AI。', 403);
    if (!this.ready(record)) throw new DomainError('PLATFORM_UNAVAILABLE', '平台 AI 暂不可用，请联系管理员或选择个人 AI。', 409);
    return { selection: { providerId: record.settings.providerId, modelId: record.settings.modelId, authMethod: 'api_key', allowUnboundedOutput: false } satisfies AiModelSelection,
      config: { ...this.config, provider: record.settings.providerId as LiveProviderId, model: undefined, modelAuthMethod: 'api_key' as const,
        apiKey: record.encryptedKey ? this.unseal(record.encryptedKey, record.settings.providerId) : this.envKey(record.settings) }, limits: record.settings };
  }
}
