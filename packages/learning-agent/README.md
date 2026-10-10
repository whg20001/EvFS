# Learning Agent

仅服务端使用。`createLearningEngine()` 默认 `mock`；也可显式传入 `EngineConfig`。实现 contracts 的 `LearningEngine.execute(task, { signal, onUsage?, cacheScope? })`，返回已验证的 `output` 与 `usage: Usage | null`。

- Mock 通过独立 `createModels`、`fauxProvider`、真实 Pi `Agent.streamFn`，脚本化演示提取、追问、混合题型、评分流程。结果由输入确定，不使用随机评分；简答永远 `needs_verification` / `scores: []`，不是科学评价。mock token 是 faux 字符估计，费用已知为零。
- Live 必须显式提供 `mode:'live'`、白名单 `provider:'openai'|'anthropic'|'openai-codex'` 及目录中的 `model`。API key 模式需要 `apiKey`（Codex 不支持）；OAuth 模式需要 `authMethod:'oauth'` 并通过工厂第二参数注入应用自己的 `CredentialStore`，不能同时指定 API key。Provider 工厂与白名单集中在 `@sanxing/ai-access/providers`，无默认厂商、动态模型发现、自定义 URL 或个人 Pi 目录。live 配置不代表已取得资料外发、预算或使用厂商的批准。
- 每次任务独占 Models、拒绝环境及文件探测的 AuthContext、Agent 与消息历史。Mock/API key 使用独立内存 CredentialStore；OAuth 只共享应用持久凭据存储（不共享对话），由 Pi 在串行 modify 中刷新和保存旋转 token，每次执行读取当前连接，断开后不回退到环境密钥。显式 key 仍经过 Provider auth handler。配置检查拒绝已知厂商环境变量、代理和 TLS 覆盖；错误原本已列出被拒绝的变量名（不是未指出变量名），不会包含变量值，不会自动读取或接受环境凭据，也不会修改全局环境。`LIVE_ENVIRONMENT_WARNING` 提醒 **AuthContext 不是沙箱**：Pi 的 env 空值仍会回退到 process.env，底层 SDK/预加载代码/全局 fetch 也可能读取环境。严格隔离请使用净化的独立 Node 进程，不能声称配置层穷尽一切环境渠道。
- `maxOutputTokens` 默认 4096（1–16384），`timeoutMs` 默认 30000（1–120000）；streamFn 强制 `maxTokens`、`timeoutMs`、`maxRetries:0`，透传合并的取消信号，禁用主动 thinking，最多一次 Provider 请求，坏输出直接失败，不自动修复。模型本身的推理开销仍可能计费，通用 token 参数不是绝对费用保证。
- **OpenAI/Codex OAuth 不发送上游输出 token 硬上限**；只有显式设置 `allowUnboundedOAuthOutput:true` 才允许创建这种 live 引擎。事后输出 token 校验不能追回费用。Anthropic OAuth/API key 不适用此开关。
- 成功只接受 `stopReason='stop'`、完整 JSON、contracts Schema、合法题量/知识/来源/评分引用。不转换 `null` 或数字字符串为分数，拒绝额外字段。待核对不能带分数，graded 必须完整覆盖固定 rubric。extract 候选与 quiz 题目均必须至少引用一个输入 sources 的真实 ID；仅有复述时可引用已有 recitation source，但不是外部验证，无资料不得编造 ID。quiz 的可选 recall 作为不可信学习者回忆用于针对性选题，不作为标准答案；points 的可选 knowledgeVersion 仅宿主跟踪，不发给模型，也不允许模型输出。
- 固定任务没有任何工具。原始流、参考答案、rubric 和内部反馈只供服务端处理，不公开转发给作答前的浏览器。
- 整次任务有期限及字符限额（模型任务 JSON 采用 contracts `LIMITS.modelInputChars=48000`、输出 100000）。`prepareLearningRequest(task, {contextWindow?, maxOutputTokens})` 供宿主在事务内准备并持久化，`inspectLearningRequest` 仅离线测量，`checkLearningRequest` 在执行前仅拒绝、不二次截断。live 的窗口来自显式 Provider 本地目录：完整 system + 本任务输出 Schema + user prompt 的 UTF-8 字节数作保守 token 估算，另预留输出及 `INPUT_SAFETY_MARGIN_TOKENS=512`。不称精确分词或实际厂商接受保证；OAuth 输出预留不创造上游硬上限。宿主先离线规划输入（全文放得下就全文发送，超预算才按剩余空间做本地 BM25 检索，见 ADR 0003）；本包再执行 H2，计划内的输入不会被二次裁剪；正式 grade 答案及 rubric 不截断。模型输入可变字段为节选标记预留空间，不混同存档字段上限。超限在读取凭据/stream 前拒绝。取消不无限等待不合作的 Provider。迟到任务无工具、无订阅、无写权限；宿主仍须使用 run/attempt/version 阻断迟到提交。取消或超时不保证上游停止计费。
- `cacheRetention:'none'|'short'` 默认 none，由用户明确保存偏好后传入。short 时接受宿主提供的非敏感 `cacheScope`（API 用目的限定 HMAC），透传为 Pi sessionId；连接测试始终 none。JSON 把来源放在可变复述/问答之前，保留稳定序列化；不缓存模型答案，也不共享对话。厂商行为不同，特别是 Anthropic 单 JSON 用户块没有独立资料断点，不保证命中；none 也不是所有上游完全不缓存的承诺。
- `usage.inputTokens` 仍为 Pi input + cacheRead + cacheWrite，另保留可选 cacheReadTokens/cacheWriteTokens，不能再加一次或把旧字段缺失当零命中。
- Live 费用是 Pi 目录费率计算的估算，不是账单；没有可信正数则 `cost:null`。缺失、无效或 Pi 全零 live usage 视为未知；合法输出仍成功返回 `usage:null`，不合成零、不伪装免费，宿主不能因此扣减预算预留。失败抛出 `LearningEngineError`，带 `code` 与可取得的 `usage`（否则 null）。宿主当前允许明确不设应用预算，仍保留未知计量；若配置预算，则跨会话检查并保留未知费用的预留。
- `message_end` 中仅可信用量通过可选 `onUsage` 异步交给宿主（未知不回调），独立于输出/引用校验是否成功；worker 还处理响应或异常携带的用量，按 run/attempt 去重。取消不抹除已记录用量，但进程崩溃、上游未报告等情况仍可能未知，不保证可重建厂商账单。
- 连接测试任务 `connection_test` 使用独立固定短提示与严格 `{kind:'connection_test',ok:true}` 响应，不序列化 selection 元数据、复述或笔记到上游。沿用同一安全调用/计量路径，限制取原配置与 256 输出 tokens / 30 秒中的较小值；OAuth 上游硬上限例外不变。普通学习提示仍仅含原学习输出分支。
- 提示词在 `prompts/*.md`，学习版本 `learning-v6`（新任务标记，历史版本不改写）、连接诊断版本 `connection-v1`。Schema 直接从 contracts 导出，followup 与 quiz 共用同一份系统提示（含两套输出 Schema，按 `kind` 执行），其余任务只附对应分支的输出 Schema；用户消息拆为稳定块（sources/points/related）与动态块；开启短缓存时 Anthropic 只在 followup/会话 quiz 的稳定块放一个断点；学习和诊断分支复用定义，不维护第二份 AI 输出契约。

网页模型选择由 `apps/api/src/ai-runtime.ts` 组装：非敏感偏好存于学习数据库，OAuth 凭据仍由 `ai-access` 独立管理；每次任务按当前已验证选择创建引擎。读取/保存配置只查询本地目录，不自动调用引擎。另有明确确认后的手动连接测试，宿主以持久 run/worker 记录用量；只有 live 的同厂商已保存 OAuth 模型可以入队，不把 mock 探针当作真实连通。live 服务可未配置启动，但不能提交模型任务；mock 始终创建 faux 引擎。

只运行本包网络隔离测试：

```sh
npx vitest run packages/learning-agent
```

不调用真实 Provider，不运行 Pi 测试或 build。真实模型质量需独立人工评估。
