# Learning Agent

仅服务端使用。`createLearningEngine()` 默认 `mock`；也可显式传入 `EngineConfig`。实现 contracts 的 `LearningEngine.execute(task, { signal, onUsage?, onProgress?, onRequest?, onTransport?, connectionPolicy?, cacheScope? })`，返回已验证的 `output` 与 `usage: Usage | null`。

持久任务另传 `expectedPrompt:{version,hash?}`。生产 API 在准备输入后调用 `describeLearningPrompt`，保存版本及应用系统提示（含 Schema）与实际用户文本块的 SHA-256 指纹；领域执行器在领取前核对，运行时及引擎在请求前再次核对。版本或指纹不匹配返回 `PROMPT_CHANGED`，不会读 OAuth 凭据或请求模型。旧排队任务缺少指纹时，生产执行器要求手动重试；新任务复用原冻结输入并绑定当前提示词，旧记录保留。直接调用引擎的非持久任务可省略绑定。指纹不包含 Provider 的协议封装、动态请求 ID、模型配置或凭据，不是跨 SDK 版本的完整网络请求快照。

- Mock 通过独立 `createModels`、`fauxProvider`、真实 Pi `Agent.streamFn`，脚本化演示提取、追问、混合题型、评分流程。结果由输入确定，不使用随机评分；简答永远 `needs_verification` / `scores: []`，不是科学评价。mock token 是 faux 字符估计，费用已知为零。
- Live 必须显式提供 `mode:'live'`、白名单 `provider:'openai'|'anthropic'|'openai-codex'` 及目录中的 `model`。API key 模式需要 `apiKey`（Codex 不支持）；OAuth 模式需要 `authMethod:'oauth'` 并通过工厂第二参数注入应用自己的 `CredentialStore`，不能同时指定 API key。Provider 工厂与白名单集中在 `@sanxing/ai-access/providers`，无默认厂商、动态模型发现、自定义 URL 或个人 Pi 目录。live 配置不代表已取得资料外发、预算或使用厂商的批准。
- 每次任务独占 Models、拒绝环境及文件探测的 AuthContext、Agent 与消息历史。Mock/API key 使用独立内存 CredentialStore；OAuth 使用应用持久凭据存储（不共享对话），由 Pi 在串行 modify 中刷新和保存旋转 token，每次执行读取当前连接，断开后不回退到环境密钥。显式 key 仍经过 Provider auth handler。配置检查拒绝已知厂商环境变量、代理和 TLS 覆盖；错误原本已列出被拒绝的变量名（不是未指出变量名），不会包含变量值，不会自动读取或接受环境凭据，也不会修改全局环境。`LIVE_ENVIRONMENT_WARNING` 提醒 **AuthContext 不是沙箱**：Pi 的 env 空值仍会回退到 process.env，底层 SDK/预加载代码/全局 fetch 也可能读取环境。严格隔离请使用净化的独立 Node 进程，不能声称配置层穷尽一切环境渠道。
- `maxOutputTokens` 默认 4096（1–16384），`timeoutMs` 默认 30000（1–120000）；streamFn 强制 `maxTokens`、`timeoutMs`、`maxRetries:0`，透传合并的取消信号，禁用主动 thinking，最多一次 Provider 请求，坏输出直接失败，不自动修复。模型本身的推理开销仍可能计费，通用 token 参数不是绝对费用保证。
- 超时分为 `firstResponseTimeoutMs`（默认 60000）、`streamIdleTimeoutMs`（默认 45000）与 `timeoutMs` 绝对时限。前两者范围 1–120000 毫秒，且不突破总时限。首响应从调用 Provider 起计，收到 HTTP 响应头或非空内容后结束等待；此后只由非空 text/thinking delta 重置停滞计时。start、空片段及心跳不延长等待。错误码分别为 `FIRST_RESPONSE_TIMEOUT`、`STREAM_IDLE_TIMEOUT`、`TIMEOUT`；先到期者生效。校验后清除模型计时器，单独等待用量持久化，期间仍支持取消。生产 worker 从领取任务起覆盖运行时准备，普通/测验默认 60/120 秒，连接诊断最多 30 秒；直接调用引擎的总时限默认仍为 30 秒。
- `onProgress` 只报告固定事件 request/response/text/thinking/generated/validated，不包含内容；观察器异常不影响任务。worker 使用单调时钟记录排队时间、请求开始、首响应、首文本、最近内容、生成结束、开始保存、完成时间。request 阶段含 SDK 内部认证解析，不能当成精确上游网络耗时；首文本缺失时保持缺失。运行中经鉴权的 `GET /api/runs/progress` 直接读取内存，结束后仅一次写入 `run.progress`，由 attempt 与终态检查保护。
- `onRequest` 在调用 SDK 流时记录本次 Provider/模型、认证方式、缓存设置、输入字符/UTF-8 字节/保守 token 估算、窗口、输出预留与超时配置。只含标量，不含提示词、答案、凭据或路由亲和键；随最终阶段数据一次保存到可选的 `run.request`。它表示应用交给 SDK 的配置，不能证明上游最终采用的模型或 OAuth 输出硬上限。错误/截断的 assistant 终态不标记为生成完成。评估报告按任务与模型统计耗时，详见 [评估说明](../../docs/evaluations/README.md)。
- 请求内通过 SDK 的 `fetch` / `onProviderStreamEvent` 观察传输异常、HTTP 状态与流终态，OAuth 存储包装保留原串行读写及刷新。已知异常区分 DNS、TLS、连接重置/超时、授权读取/刷新/保存、服务流错误、限流/额度、协议异常、未完成与断流；只转换固定白名单错误码，未知仍 `MODEL_FAILED`，不保存原始异常、响应正文、地址、token、堆栈或 Provider 自由文本。HTTP 200 内的 `response.failed` 不伪装成 HTTP 429/500。诊断随任务独立，迟到回调不更新结果；不修改全局 fetch、凭据、TLS 或代理设置，不引入重试。
- `onTransport` 保存白名单原始错误码（区分 ECONNRESET / EPIPE / UND_ERR_SOCKET）、syscall、HTTP 状态、传输阶段、实际 socket 复用情况及该请求的收发字节增量；不采集地址、URL、请求头、正文或异常文本。dispatching 表示尚未观察到 socket 分配，可能是排队、DNS、TCP/TLS 连接或缺少诊断事件；awaiting_headers 表示已分配 socket、等待响应头；streaming 表示收到响应头；complete 仅表示 HTTP body 完整接收，不代表模型输出有效。`requestCount` 是观察到的 HTTP 请求数，缺少诊断事件时为 0，不能据此认定未调用。socket 与字节未知时保留 null，写入字节不证明上游接受请求，未收到字节也不证明未计费。事件按请求对象关联，并在任务结束/取消后解除订阅。
- `connectionPolicy` 默认 pooled；独立的 `LearningTransport` 使用固定 Undici 6.29.1，按 origin 管理最多 2 条 HTTP/1 连接，不启用流水线或 HTTP/2；默认空闲 4 秒、服务端提示最多延长至 10 秒。fresh 每任务使用独立 dispatcher，并在任务结束销毁；两种模式保持相同客户端与参数，无自动重试、不改全局 dispatcher。API runtime 与评估 CLI 各拥有一个共享池，关闭宿主时释放；直接使用 `createLearningEngine` 的调用方在结束时调用 `await engine.close?.()`，或注入共享 `LearningTransport` 并由宿主关闭。池只共享传输连接，不共享 prompt、消息历史、凭据或结果。OAuth 刷新仍由原认证流程管理，诊断仅覆盖 SDK 交给 fetch 的模型请求。
- Pi 1.0.4 的 Codex SSE 解析器只分割 `LF LF`。应用仅对 Codex 的成功 `text/event-stream` 响应逐块规范化 CRLF/CR 换行，不缓冲整段响应、不重新编码 UTF-8，取消向原响应流传播；其他 Provider、JSON 和 HTTP 错误响应保持原路径。真实 SDK 离线回归覆盖单字节分块、中文/emoji、未到 EOF 即收到内容和取消释放。SDK 收到明确 completed 事件后会取消 reader；应用对此增加最多 250 毫秒、64 KiB 额外读取阈值的流收尾（达到阈值的最后一块可能跨过阈值），让及时到达的 HTTP EOF 归还连接。该期间仍受任务总时限和用户取消约束；未完成响应直接取消，超时/超量则释放，不缓冲或解释尾部内容。收尾失败不撤销已完整的模型结果，传输诊断仍保留；服务器不结束流时不能保证复用。Responses 终态必须明确完成；`queued`、`in_progress`、未知/缺失状态、`response.incomplete` 与缺少终态的流均不能凭完整 JSON 判成功。事件含义参考 [OpenAI 官方文档](https://developers.openai.com/api/reference/resources/responses/streaming-events)，Codex legacy 兼容行为以固定依赖源码与回归为准。
- **OpenAI/Codex OAuth 不发送上游输出 token 硬上限**；只有显式设置 `allowUnboundedOAuthOutput:true` 才允许创建这种 live 引擎。事后输出 token 校验不能追回费用。Anthropic OAuth/API key 不适用此开关。
- 成功只接受 `stopReason='stop'`、完整 JSON、contracts Schema、合法题量/知识/来源/评分引用。不转换 `null` 或数字字符串为分数，拒绝额外字段。待核对不能带分数，graded 必须完整覆盖固定 rubric。extract 候选与 quiz 题目均必须至少引用一个输入 sources 的真实 ID；仅有复述时可引用已有 recitation source，但不是外部验证，无资料不得编造 ID。quiz 的可选 recall 作为不可信学习者回忆用于针对性选题，不作为标准答案；points 的可选 knowledgeVersion 仅宿主跟踪，不发给模型，也不允许模型输出。
- 固定任务没有任何工具。原始流、参考答案、rubric 和内部反馈只供服务端处理，不公开转发给作答前的浏览器。
- 整次任务有期限及字符限额（模型任务 JSON 采用 contracts `LIMITS.modelInputChars=48000`、输出 100000）。`prepareLearningRequest(task, {contextWindow?, maxOutputTokens})` 供宿主在事务内准备并持久化，`inspectLearningRequest` 仅离线测量，`checkLearningRequest` 在执行前仅拒绝、不二次截断。live 的窗口来自显式 Provider 本地目录：完整 system + 本任务输出 Schema + user prompt 的 UTF-8 字节数作保守 token 估算，另预留输出及 `INPUT_SAFETY_MARGIN_TOKENS=512`。不称精确分词或实际厂商接受保证；OAuth 输出预留不创造上游硬上限。宿主先离线规划输入（全文放得下就全文发送，超预算才按剩余空间做本地 BM25 检索，见 ADR 0003）；本包再执行 H2，已符合预算的输入不会被二次裁剪；追问与测验中的练习问答共用可节选字段，最近作答自身超过窗口时会保留带标记的片段，完整原文仍存档；正式 grade 答案及 rubric 不截断。模型输入可变字段为节选标记预留空间，不混同存档字段上限。超限在读取凭据/stream 前拒绝。取消不无限等待不合作的 Provider。迟到任务无工具、无订阅、无写权限；宿主仍须使用 run/attempt/version 阻断迟到提交。取消或超时不保证上游停止计费。
- `cacheRetention:'none'|'short'` 默认 none，由用户明确保存偏好后传入。short 时接受宿主提供的非敏感 `cacheScope`（API 用目的限定 HMAC），透传为 Pi sessionId；连接测试始终 none。JSON 把来源放在可变复述/问答之前，保留稳定序列化；不缓存模型答案，也不共享对话。厂商行为不同，特别是 Anthropic 单 JSON 用户块没有独立资料断点，不保证命中；none 也不是所有上游完全不缓存的承诺。
- `usage.inputTokens` 仍为 Pi input + cacheRead + cacheWrite，另保留可选 cacheReadTokens/cacheWriteTokens，不能再加一次或把旧字段缺失当零命中。
- Live 费用是 Pi 目录费率计算的估算，不是账单；没有可信正数则 `cost:null`。缺失、无效或 Pi 全零 live usage 视为未知；合法输出仍成功返回 `usage:null`，不合成零、不伪装免费，宿主不能因此扣减预算预留。失败抛出 `LearningEngineError`，带 `code` 与可取得的 `usage`（否则 null）。宿主当前允许明确不设应用预算，仍保留未知计量；若配置预算，则跨会话检查并保留未知费用的预留。
- `message_end` 中仅可信用量通过可选 `onUsage` 异步交给宿主（未知不回调），独立于输出/引用校验是否成功；worker 合并回调、响应及异常的重复交付，数据库在串行队列内按 run/attempt 原子去重，重复记录不再创建事务或增加 revision。保存失败允许本地再次保存，模型不重试。取消不抹除已记录用量，但进程崩溃、上游未报告等情况仍可能未知，不保证可重建厂商账单。
- 连接测试任务 `connection_test` 使用独立固定短提示与严格 `{kind:'connection_test',ok:true}` 响应，不序列化 selection 元数据、复述或笔记到上游。沿用同一安全调用/计量路径，限制取原配置与 256 输出 tokens / 30 秒中的较小值；OAuth 上游硬上限例外不变。普通学习提示仍仅含原学习输出分支。
- 提示词在 `prompts/*.md`，学习版本 `learning-v8`（新任务标记，历史版本不改写）、连接诊断版本 `connection-v1`。Schema 直接从 contracts 导出，followup 与 quiz 共用同一份系统提示（含两套输出 Schema，按 `kind` 执行），其余任务只附对应分支的输出 Schema；用户消息拆为稳定块（sources/points/related）与动态块；会话测验把本范围追问历史放入动态块，复习测验仅在有符合条件的近期独立失分记录时附最多三条薄弱维度提示。来源按本次请求真实预算选择，只有最新证据挤占预算时才重新选段；Anthropic 短缓存断点仍放在稳定资料块之后。缓存复用取决于资料块是否相同，不为预想的后续历史牺牲当前资料；学习和诊断分支复用定义，不维护第二份 AI 输出契约。

网页模型选择由 `apps/api/src/ai-runtime.ts` 组装：非敏感偏好存于学习数据库，OAuth 凭据仍由 `ai-access` 独立管理；每次任务按当前已验证选择创建引擎。读取/保存配置只查询本地目录，不自动调用引擎。另有明确确认后的手动连接测试，宿主以持久 run/worker 记录用量；只有 live 的同厂商已保存 OAuth 模型可以入队，不把 mock 探针当作真实连通。live 服务可未配置启动，但不能提交模型任务；mock 始终创建 faux 引擎。

运行时只缓存本进程内的静态模型目录，配置视图返回副本；执行只检查选中 Provider 的认证，OAuth 每次重新读取，API key 执行无需打开 OAuth 存储。配置页面仍读取所有 Provider 状态。运行时设置、worker 待执行判断与单条评估查询使用仓库小范围读取，保持原有串行可见性与副本隔离，不复制整个学习库。

学习任务可以携带 `skills` 快照，由宿主按已启用的任务范围选择并冻结；`[]` 明确冻结“不使用 Skill”。技能的名称、描述、完整正文附加到 system prompt，遵守固定任务规则；ID 和版本只作为内部溯源，不发送给模型。指令纳入 UTF-8 输入预算及 `promptHash`，不参与资料节选；预算不足则拒绝发送。无 Skill 的序列化与指纹保持不变；同一组 Skill 下的追问/测验继续共用系统提示前缀。执行入口和存储恢复均验证快照；不允许 Skill 增加工具或自动请求。连接测试、基线评估不绑定个人 Skill，明确重试保留原快照。

任务入参统一使用 contracts 的 `modelAiTaskSchema`，从 `storedAiTaskSchema` 的任务分支派生模型侧限制；`AiTask` 及来源、知识点、追问记录、题目类型均从共享 Schema 推导。共享字段只在基础结构中声明，模型侧只覆盖长度、数量等边界差异。保留既有兼容行为：学习任务未知字段过滤，连接探针拒绝额外字段；评分题目的宿主版本信息不进入 SDK 输入投影。完整提示词预算和字段外发投影仍由 `request.ts` 负责。

`tests/fixtures/task-prompt-baseline.json` 保存整理前 38 组固定合成输入的指纹和输入大小，覆盖学习四类任务、连接探针、Skill 和代码题；回归要求存储解析及 SDK 校验前后不改变模型提示。另用临时物理库验证保存、重开、导出恢复到真实 Pi SDK + faux Provider 的实际消息。未来确需改变提示词时应同时处理提示词版本和历史任务兼容，不能只刷新测试基线消除失败。

只运行本包网络隔离测试：

```sh
npx vitest run packages/learning-agent
```

不调用真实 Provider，不运行 Pi 测试或 build。真实模型质量需独立人工评估。
