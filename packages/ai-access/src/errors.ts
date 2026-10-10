const messages = {
  storage: '授权凭据存储不可用，请检查私有目录和密钥。',
  closed: '授权服务已关闭。',
  owner_expired: '本站登录已过期，请重新登录。',
  not_found: '未找到授权会话。',
  provider: '不支持此授权提供方。',
  busy: '已有授权正在进行，请完成或取消后重试。',
  input: '授权输入无效或已失效，请刷新后重试。',
  failed: '授权未完成，请重试。',
  unsafe: '授权环境或链接不安全，已停止授权。',
} as const;
export class AiAccessError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: keyof typeof messages, status = 400) {
    super(messages[code]); this.name = 'AiAccessError'; this.code = code; this.status = status;
  }
}
