import { runErrorCodeSchema, type AgentRun, type RunErrorCode } from '@sanxing/contracts';

const aliases: Record<string, RunErrorCode> = {
  AI_MODEL_UNAUTHORIZED: 'MODEL_NOT_AUTHORIZED', AI_CREDENTIALS_UNAVAILABLE: 'MODEL_AUTH_FAILED',
  AI_MODEL_REQUIRED: 'MODEL_NOT_CONFIGURED', AI_MODEL_INVALID: 'MODEL_NOT_CONFIGURED',
  AI_PROVIDER_UNSUPPORTED: 'MODEL_NOT_CONFIGURED', AI_MODEL_UNSUPPORTED: 'MODEL_NOT_CONFIGURED',
  AI_API_KEY_UNAVAILABLE: 'MODEL_NOT_CONFIGURED', AI_OUTPUT_ACK_REQUIRED: 'MODEL_NOT_CONFIGURED',
  AI_MODEL_LIMIT_INVALID: 'INVALID_CONFIG', AI_OUTPUT_LIMIT_INVALID: 'INVALID_CONFIG',
  INVALID_MODEL_OUTPUT: 'INVALID_OUTPUT', INVALID_REFERENCE: 'INVALID_OUTPUT', INPUT_LIMIT: 'MODEL_INPUT_TOO_LARGE',
  VERSION_CONFLICT: 'STALE_RUN', QUIZ_CLOSED: 'STALE_RUN',
};

/** Whitelist codes, then select fixed guidance. Never store exception messages, bodies or stacks. */
export function runFailure(error: unknown, run: Pick<AgentRun, 'task' | 'evaluation' | 'assessmentRevision'>, interruption?: RunErrorCode): { code: RunErrorCode; message: string } {
  const raw = error && typeof error === 'object' && 'code' in error ? error.code : null;
  const parsed = runErrorCodeSchema.safeParse(typeof raw === 'string' && Object.hasOwn(aliases, raw) ? aliases[raw] : raw);
  const code = interruption ?? (parsed.success ? parsed.data : 'MODEL_FAILED');
  let message: string;
  if (code === 'PROMPT_CHANGED') message = '任务提示词或输入已变化，或旧任务缺少可核对的指纹；未发送模型请求。输入已保留，重试将使用当前提示词创建新任务。';
  else if (code === 'TIMEOUT') message = '模型请求超时，请稍后手动重试；原请求可能已计费。';
  else if (code === 'FIRST_RESPONSE_TIMEOUT') message = '等待模型首个响应超时，输入已保留；请稍后手动重试，原请求可能已计费。';
  else if (code === 'STREAM_IDLE_TIMEOUT') message = '模型响应长时间没有新的内容，已停止等待；输入已保留，可稍后手动重试，原请求可能已计费。';
  else if (code === 'CANCELLED') message = '模型请求已中断，输入已保留；原请求可能已计费。';
  else if (code === 'SERVICE_RESTARTED') message = '服务中断了任务，输入已保留，请明确重试；原请求可能已计费。';
  else if (code === 'MODEL_DNS_ERROR') message = '模型服务域名解析失败，请检查服务端网络与 DNS 后手动重试。';
  else if (code === 'MODEL_TLS_ERROR') message = '模型连接的证书验证失败，请检查服务端时间和证书配置；请勿关闭证书验证。';
  else if (code === 'MODEL_CONNECTION_TIMEOUT') message = '模型网络连接或数据传输超时，请检查服务端网络后手动重试；原请求可能已计费。';
  else if (code === 'MODEL_CONNECTION_RESET' || code === 'MODEL_NETWORK_ERROR') message = '模型网络连接失败或被中断，请检查服务端网络后手动重试；原请求可能已计费。';
  else if (code === 'MODEL_STREAM_INTERRUPTED') message = '模型响应流提前结束，未收到完整终态；部分内容未作为学习结果保存，可稍后手动重试，原请求可能已计费。';
  else if (code === 'MODEL_PROTOCOL_ERROR') message = '模型响应流格式异常，未保存不完整结果；请检查服务连接后手动重试，原请求可能已计费。';
  else if (code === 'MODEL_RESPONSE_INCOMPLETE') message = '模型返回未完成的响应，未保存为学习结果；请核对任务范围后手动重试，原请求可能已计费。';
  else if (code === 'MODEL_PROVIDER_ERROR') message = '模型服务在响应流中报告失败，请稍后手动重试；原请求可能已计费。';
  else if (code === 'MODEL_RATE_LIMITED') message = '模型服务报告限流，请等待后手动重试。';
  else if (code === 'MODEL_QUOTA_EXCEEDED') message = '模型服务报告额度不足或订阅额度不可用，请核对 Provider 账号额度后再试。';
  else if (code === 'MODEL_AUTH_FAILED') message = '读取、刷新或保存模型授权失败，请在 AI 配置页检查连接状态与服务端网络后手动重试。';
  else if (code === 'MODEL_HTTP_429') message = '模型服务限流或额度不足，请检查 Provider 额度并等待后手动重试。';
  else if (code === 'MODEL_NOT_AUTHORIZED' || code === 'MODEL_HTTP_401' || code === 'MODEL_HTTP_403') message = '模型授权失效或没有访问权限，请在 AI 配置页检查授权、账号权限与所选模型后手动重试。';
  else if (code === 'MODEL_NOT_CONFIGURED' || code === 'INVALID_CONFIG') message = '模型配置不可用，请在 AI 配置页检查模型、认证方式和输出限额后手动重试。';
  else if (code === 'MODEL_INPUT_TOO_LARGE') message = '任务内容超出模型输入预算，未发送模型请求。请选择更大上下文的模型，或调整输入后重新提交。';
  else if (code === 'INVALID_OUTPUT') message = '模型响应格式、引用或评分项未通过校验，输入已保留；可手动重试，原请求可能已计费。';
  else if (code === 'OUTPUT_LIMIT') message = '模型输出超过限制，输入已保留；请检查输出限额后手动重试，或重新创建题量较少的任务。原请求可能已计费。';
  else if (code === 'REQUEST_LIMIT') message = '本次任务或会话达到调用上限，请结束当前会话后重新开始。';
  else if (code === 'UNSAFE_ENVIRONMENT') message = '服务运行环境配置冲突，未发送模型请求；请检查服务端模型、代理及 TLS 环境配置后手动重试。';
  else if (code === 'INVALID_TASK') message = '任务输入不符合当前要求，未发送模型请求；请检查学习范围或重新创建任务。';
  else if (code === 'STALE_RUN') message = '学习记录已变化，本次结果未写入；请刷新页面后继续，原请求可能已计费。';
  else if (code.startsWith('MODEL_HTTP_5')) message = '模型服务暂时异常，请稍后手动重试；原请求可能已计费。';
  else if (code.startsWith('MODEL_HTTP_4')) message = '模型服务拒绝了请求，请检查模型配置、输入和账号状态后手动重试。';
  else message = 'AI 任务未完成，输入已保存。请核对模型配置后手动重试；原请求可能已计费。';
  if (run.task.kind === 'connection_test') {
    const summary = ['TIMEOUT', 'FIRST_RESPONSE_TIMEOUT', 'STREAM_IDLE_TIMEOUT', 'CANCELLED', 'SERVICE_RESTARTED'].includes(code) ? '连接测试已中断或超时；请求可能已计费。'
      : code === 'MODEL_NOT_AUTHORIZED' ? '连接测试授权已失效或未完成。'
      : ['INVALID_OUTPUT', 'OUTPUT_LIMIT'].includes(code) ? '连接测试的模型响应校验失败；请求可能已计费。'
      : `连接测试执行失败。${message}`;
    message = `${summary}请到 Provider 授权核对配置后重新点击确认测试。`;
  } else if (run.evaluation) message = `样例评估失败（${code}）。${message}评估不会直接重试，请明确开始新批次。`;
  else if (run.assessmentRevision) message += '请在评价核对区重新确认模型复评。';
  return { code, message };
}
