# 评估说明

本目录记录可复核的评估方法及获准执行的结果。2026-10-21 已经用户授权，通过应用内 OpenAI/Codex OAuth 执行 GPT 样例；原始记录保存在 `results/`。报告中的 `humanReview` 默认待评审，不把模型自评、假 Provider 的演示分数或工程测试数量当学习效果。

## 固定样例与复现命令

`packages/learning-agent/evaluations/cases.ts` 包含 30 条原创、无个人资料的样例：空值缓存、FIFO 队列、二分查找、独立事件概率、JavaScript 去重、Python 平均值，每个主题包含提取、追问、出题、正确答案评分、错误/不完整答案评分。评分题冻结原题、rubric 和参考分数区间；出题中另检查 JS/Python 代码题是否生成、参考实现及测试是否正确。

```sh
# 无凭据、无真实模型；只证明契约和执行流程。
npm run evaluate:learning -- --mode offline --output /tmp/sanxing-offline-new.json

# 先在应用 AI 配置中授权并保存这个模型，保持应用运行。
# 仅显式读取本地 .env，用 OWNER_PASSWORD 创建临时应用登录会话。
# OAuth token 留在应用 vault 中，任务与用量通过原有 worker 记录。
npm run evaluate:learning -- --mode live --auth oauth --env-file .env \
  --provider openai-codex --model gpt-6.1-sol --limit 30 \
  --output /tmp/sanxing-gpt-new.json
```

模型必须与应用当前保存的 OAuth 选择完全一致，且存在于本地目录；不会切换模型、启用真实排期或读取个人学习资料。API 只接受固定样例 ID，不接受调用方提供任意任务；沿用 Cookie、CSRF、Origin、持久化幂等收据、单 worker、预算及取消机制。重启不自动重放样例，通用 retry 不能重发评估。学习备份含运行记录与合成输入输出，不含 OAuth 凭据。

默认每例一次请求、失败即停止；`--offset N --limit M` 只选尚未测试的固定样例。为统计失败率，可显式加 `--continue-on-error`，保留模型失败并继续下一个样例，仍不重试；应用 HTTP 错误仍停整批。API key 路径使用 `--auth api_key` 与本地 `EVALUATION_API_KEY`，不自动读取 `.env`。报告拒绝覆盖现有文件，包含样例 hash、用户任务提示 hash（`promptHash`；系统提示由 `promptVersion` 固定）、实际输出、耗时、已知用量、未知项及人工复核栏；失败退出码为 1。

OAuth 运行采用应用的超时及输出预留设置。OpenAI/Codex OAuth 的上游输出硬上限限制仍以应用已确认配置为准。`--max-cost-usd` 是**已观测估算费用的停止阈值**，不是账单硬上限；下一次调用仍可能越过阈值，费用未知时停止。OAuth usage 中的金额是 SDK 目录估算，不是订阅实际扣费证明。失败的已知 usage 保留，未知不记为免费。

## 2026-10-21 实际结果

Provider 为 `openai-codex`，模型为 `gpt-6.1-sol`，认证为应用内 OAuth，提示词为报告记录的 `learning-v6`，固定样例版本 `learning-quality-v1`。用户先完成应用授权，再明确执行评估。没有读取或发送个人复述、笔记、题目及答案；应用内新增的是评估运行/幂等收据及其用量记录。

| 项目 | 实测结果 |
|---|---|
| 样例覆盖 | 30 个唯一 ID 均已请求；27 个取得有效结构化输出，3 个评分请求失败 |
| 任务分布 | 提取 6/6、追问 6/6、出题 6/6 返回有效结构化输出；评分 9/12 返回有效评分 |
| 参考分数一致性 | 返回的 9 个评分均落在预先冻结区间；其余 3 个无评分，不能算为正确 |
| 失败样例 | `cache-grade-correct`、`mean-grade-correct`、`mean-grade-incomplete`：`MODEL_FAILED`，用量未知，不据此判断答案错误 |
| 额外诊断 | 最初 `cache-extract` 请求失败，随后单独获准的一次诊断成功；总计 31 次尝试、27 次有效返回、4 次失败，原失败未删除 |
| 已知用量 | 37,042 输入 token、5,714 输出 token；SDK 已知费用估算合计 $0.131224，另 4 次失败费用未知；不是实际账单总额 |

原始记录依次为：[首次失败](./results/gpt-6.1-sol-2026-10-21.json)、[单例诊断](./results/gpt-6.1-sol-2026-10-21-diagnostic.json)、[继续样例 2–4](./results/gpt-6.1-sol-2026-10-21-remaining.json)、[剩余样例 5–30](./results/gpt-6.1-sol-2026-10-21-unattempted.json)。前三批失败即停止；最后一批显式启用继续下一个样例，不重试失败样例。失败报告的 `inFlight` 保留最后请求的运行 ID，便于核查，不表示该运行仍在执行。

本轮由编码助手对输出和给定资料进行逐项核查，**不是独立人工盲评**，`humanReview` 保持 pending。6 组题目的参考结论和来源与输入一致；两道代码题为 JS 保序去重和 Python 平均值。`tests/e2e/evaluation-outputs.spec.ts` 用既有浏览器沙箱回放记录的题目，检查参考实现、骨架和典型错误实现；实测两道题的参考实现均通过全部 3 条测试，骨架均未通过，保序题的排序错误及均值题的取中间值错误均被识别。参考答案中的解释文字在回放前显式分离，不将整段说明作为程序运行。

保留问题：部分追问在一句话中同时询问多个子问题（例如平均值计算规则与空输入处理），后续宜再收敛到一个关键疑点。样例规模小、知识范围简单，未覆盖复杂长文、跨资料冲突和不同学科评分偏差；失败原因没有足够上游证据，不能宣称已修复全部真实请求稳定性，也不能把 9/9 已返回评分外推为整体评分准确率。

## 2026-10-22 GPT 阶段耗时基线

按本次阶段一、二授权，使用应用已有的 `openai-codex / gpt-6.1-sol` OAuth、`learning-v8` 和 30 条固定合成样例执行一批；每例一次，开启 `--continue-on-error`，无自动重试。保持现有模型、缓存 `none` 和预算设置，通过应用接口记录任务及用量，没有打开或导出 OAuth 凭据。原始报告：[gpt-6.1-sol-2026-10-22-performance.json](./results/gpt-6.1-sol-2026-10-22-performance.json)。

| 任务 | 请求数 | 有效返回 | 失败 | 全部请求 p50 | 全部请求 p95 |
|---|---:|---:|---:|---:|---:|
| 提取 | 6 | 4 | 2 | 9.06 s | 16.09 s |
| 追问 | 6 | 6 | 0 | 12.07 s | 18.10 s |
| 出题 | 6 | 5 | 1 | 19.11 s | 32.17 s |
| 评分 | 12 | 9 | 3 | 9.06 s | 16.09 s |
| 合计 | 30 | 24 | 6 | 10.07 s | 30.14 s |

失败率 20%，六次均为 `MODEL_FAILED`，没有观测到总超时、首响应超时或流停滞超时；CLI 因存在失败按设计退出 1，批次仍完成 30 次，`stopped` / `inFlight` 均为 null。五次在等待阶段失败且未观测到首响应，一次在已收到文本后失败；不能仅据这些现象判断是网络、OAuth、SDK 还是上游原因。全部请求 p50 受到快速失败影响，成功请求 p50 为 12.07 s，应同时查看。

阶段中位数：应用准备 0 ms（p95 2 ms、最大 4 ms）；首响应等待 5.17 s、首文本等待 7.33 s（各 25 个有观测样本）；生成 3.30 s、校验 4 ms、保存 12 ms（各 24 个完成样本）。本批主要时间在请求等待和生成，测验的文本生成中位数为 11.62 s；本地准备读数 0 表示不足 1 ms，不能理解为无开销。仍需更细的脱敏错误类别定位六次失败，不能宣称所有 SDK 稳定性问题已解决。

30 条均保存请求配置；输入为 3,053–9,086 UTF-8 字节。24 条取得可信计量：输入合计 36,325 tokens、输出 5,200 tokens，已报告缓存读写均为 0；另外 6 条用量未知。Pi 目录估算合计 $0.12465，不是 OAuth 账单，也未计入未知部分。本次未更改缓存偏好，不能用它验证短缓存命中率提升。9 条返回的评分落在冻结参考区间，但 `humanReview` 全部保留 pending；这是运行与性能基线，不是人工盲评或长期质量结论。

## 性能报告 v2（2026-10-22）

2026-10-22 后续修复新增定向选择：`--cases id1,id2` 只接受固定样例中的唯一 ID，与 `--offset` / `--limit` 互斥，在连接应用之前校验。它创建新批次，不重放已有 run；已完成的失败记录会清除 `inFlight`，尚未确认终态的请求仍保留待核查标记。网络连接超时也计入 `timeoutCount`，网络连接重置单独统计。

`evaluate:learning` 的报告新增 `reportVersion: 2`、逐例 `progress` / `request` / `stages` / `boundPromptHash` 和汇总 `performance`。旧报告不补造阶段数据。OAuth 通过运行中的应用读取单条任务，终态若仍在保存最终诊断则继续查询，不额外调用模型；普通/测验的默认总时限分别为 60/120 秒，实际生效值以逐例 `request` 为准。

- 阶段统计包括排队、应用准备、首响应等待、首文本等待、文本生成、输出校验、业务保存和执行总耗时。首响应可指 HTTP 响应头；首响应等待与首文本等待相互重叠，不能相加。SDK 内部认证包含在请求等待里，不能将它当作纯上游网络耗时。
- 仅已观察到起止时间的阶段参与 p50/p95（最近秩）统计，同时记录 `samples` 与 `missing`。超时和错误包含在全部请求延迟与失败率中；另外提供成功请求延迟、错误码和失败阶段分布，避免只看成功样本。失败后未完成的生成阶段不填 0。
- 请求元数据记录 SDK 调用时的 Provider、模型、认证、缓存配置、输入字符/UTF-8 字节/保守 token 估算、窗口、输出预留及超时。它不证明上游实际采用同名模型；用量中的 Provider/模型另行保留。输出大小以实际报告的 outputTokens 表示。元数据不含凭据、提示词正文、推理内容或亲和键。
- inputTokens 已包含缓存部分；cacheReadTokens / cacheWriteTokens 不重复相加，未报告时保持未知。汇总区分已知总量、已知样本和未知样本；`cost:null` 不表示免费。保留逐例数据并按任务种类、Provider/模型/认证方式分组，少量样例的 p95 不能作为服务等级保证。
- `durationMs` 是 CLI 观察的端到端耗时，包含轮询粒度与应用请求开销；`progress.completedMs` 从 worker 领取后计时，不含排队及最后一次诊断写入。`boundPromptHash` 来自服务端完整提示绑定；旧 `promptHash` 仍为 CLI 用户文本哈希，两者含义不同。

本地开销使用独立合成库复测，无网络或真实模型，命令为：

```sh
node --import tsx scripts/benchmark-agent-host.ts /tmp/sanxing-agent-host-new.json
```

工作负载为 1,000 知识点、500 份资料、3,285 条历史任务；同机 Node v22.23.2 / i5-14600KF，预热 1 次、测量 5 次。比较本轮改动前后，原始数据见 [before](../benchmarks/agent-host-before.json) / [after](../benchmarks/agent-host-after.json)：

| 指标 | 修改前 | 修改后 |
|---|---:|---:|
| 完整本地任务中位耗时 | 1,122 ms | 858 ms |
| 5 次中的最大耗时 | 1,157 ms | 919 ms |
| 每次全量 `read()` | 3 | 0 |
| 每次实际 revision 提交 | 5 | 4 |

本地中位耗时减少约 24%，不是模型生成提速；此测量引擎立即返回固定结果。聚合写入仍复制和校验全量数据，未承诺消除大库写入成本。真实 GPT 样例用于建立本轮阶段基线；此前提示词版本不同的报告不构成受控的速度对照。

## 2026-10-22 流解析修复与六例定向复核

后续修复沿用当前模型、OAuth、`learning-v8` 和缓存 `none`，仅对上一批失败的六个固定样例各执行一次，共新增 6 次请求，未自动重试或修改旧记录。原始报告：[gpt-6.1-sol-2026-10-22-stream-fixes.json](./results/gpt-6.1-sol-2026-10-22-stream-fixes.json)。

| 样例 | 本批结果 | CLI 耗时 |
|---|---|---:|
| cache-grade-correct | 有效返回 | 11.16 s |
| queue-extract | 有效返回 | 7.10 s |
| search-extract | MODEL_CONNECTION_RESET | 1.04 s |
| probability-quiz | MODEL_CONNECTION_RESET | 3.05 s |
| unique-grade-correct | MODEL_CONNECTION_RESET | 2.05 s |
| mean-grade-correct | 有效返回 | 7.06 s |

三次失败均在未观测到 HTTP 响应头时发生，来自 fetch 异常链中连接重置/关闭类的已知代码，不是根据错误正文猜测。没有超时，三次失败的用量未知。原先的 `MODEL_FAILED` 历史记录缺少这些信息，无法追溯判定为同一原因。该小样本专门选择上一批失败项，不能与整批 30 条直接比较成功率，也不能据三次恢复宣称网络稳定性已修复。

本次确定修复的本地缺陷：Pi 1.0.4 Codex SSE 对 CRLF/CR 换行不能逐条解析（真实适配器离线复现，修复前两种换行失败、修复后通过）；非完成的 Responses 终态被 SDK 归为成功（新增状态校验）；网络、授权及服务流错误被压成统一错误而丢失类别。新增请求内观察只保留白名单错误码，未存储响应正文、凭据、地址或异常堆栈。取消、UTF-8 单字节分块、收到内容早于 EOF、流资源释放、失败用量保留均有回归。

仍未解决：本批连接重置的具体责任点。现有证据不能区分远端服务、网络路径或连接复用；本轮没有通过禁用 TLS、换账号/模型或增加自动重试掩盖它。尚未进行人工质量盲评。

```sh
npm run evaluate:learning -- --mode live --auth oauth --env-file .env \
  --provider openai-codex --model gpt-6.1-sol \
  --cases cache-grade-correct,queue-extract,search-extract,probability-quiz,unique-grade-correct,mean-grade-correct \
  --continue-on-error --output /tmp/sanxing-six-cases-new.json
```

## 两类证据分开

| 类型 | 能证明什么 | 不能证明什么 |
|---|---|---|
| 离线工程测试 | 契约、状态机、版本/CAS、幂等、数据迁移、私有答案隔离、取消/错误、UI 回归 | 真实 Provider 连通、OAuth 账号权限、知识正确性或评分公平性 |
| 真实模型人工评估 | 指定模型/提示词/样例上经人工核查的表现 | 所有学科的准确率、账号永远可用、长期学习效果或厂商账单完整性 |

真实连接测试仅是指定模型在某时的一次最小请求，不含学习资料，不能替代模型质量评估。FSRS 的假时间正确性也不能证明长期记忆效果。

## 执行前的授权门槛

1. 用户明确允许真实 Provider 请求、具体模型和认证方式。
2. 逐项确认可外发样例；默认使用去标识化或人工编写的内容，不自动读取 `.env`、个人资料库或凭据。
3. 告知费用/额度风险并约定此次评估的调用数量、超时和停止条件。当前应用不设金额预算是已确定决定，不能假定免费，也不擅自开启付费评估。
4. 先冻结提示词、题目与人工参考依据，再生成和盲评；存在争议时记录待核对，不把模型自评概率当正确性裁决。

## 建议样例维度（未执行，不是成绩）

- 正确复述、不同措辞、关键条件缺失、笔记与复述冲突。
- 原始复述作为 source，但没有外部事实核验的情况。
- 过少内容不应判定不会；拒绝/移出范围的内容不再用于出题。
- 长资料节选边界、被省略内容不可假装已评估、正式答案和 rubric 不截断。
- 独立作答与已见解析的辅助作答，跳过、待核对和未知用量。
- 旧内容版本题目与新知识描述不同；证据仍引用原版本。
- 真实回忆是否影响出题相关性，而非只在界面要求填写。

可先准备一小批人工可核对的样例再扩大，不预写通过率、样本数量或“全部通过”。

## 每份实际评估记录应包含

- 日期、操作者与授权范围；代码/模型/Provider/提示词及评级规则版本。
- 样例 ID、允许保存的输入、人工参考依据与评分准则。
- 实际输出、逐项人工结论、争议与复核记录；禁止记录凭据或私密认证参数。
- 已知 token/估算费用、未知项、超时/失败及选择偏差；未知不填零。
- 局限、改进项与是否允许启用相关功能。

记录只代表该次执行。含私人内容的原始结果不直接提交仓库；仓库仅收录获准公开的去标识化材料。工程测试命令及本轮状态统一见 [README](../../README.md) 和[状态表](../实现状态与偏差表.md)。

## 连接诊断与对照报告 v3（2026-10-23）

新报告为 `reportVersion: 3`，新增逐例 `transport` 和汇总 `performance.transport`；v1/v2 历史报告保留原样。原始错误码仅记录固定白名单，例如 `ECONNRESET`、`EPIPE`、`UND_ERR_SOCKET`，避免应用分类 `MODEL_CONNECTION_RESET` 掩盖差异。另含 syscall、HTTP 状态、阶段、观察到的 HTTP 请求数、socket 是否复用和该请求的 socket 收发字节增量。不记录 URL、IP、请求头、凭据、正文、错误文本或堆栈。

`phase` 的含义：`dispatching` 尚未观察到 socket 分配（可能排队、连接建立或缺少底层事件）；`awaiting_headers` 已分配 socket、等待响应头；`streaming` 已收到响应头；`complete` HTTP body 完整结束，模型内容仍需原有终态/Schema 检查。`reusedSocket:null` 与字节 null 表示未知；`requestCount` 只计观察到的 Undici 请求事件，缺少事件时 0 不证明未调用。写入字节不等于服务端已接受，无返回字节也不能排除计费。OAuth 刷新不在模型 fetch 的诊断范围内。

服务端 `AI_CONNECTION_POLICY=pooled` 为默认模式，runtime 生命周期内共享按 origin 隔离的池；`fresh` 每任务单独新建 dispatcher，并在结束/取消后销毁。两种模式都使用固定 Undici 6.29.1、最多每 origin 2 条 HTTP/1 连接，不启用流水线或 HTTP/2，空闲默认 4 秒、最多 10 秒，保持模型、认证和超时不变。不是绕过 TLS 校验、全局代理或全局 dispatcher 的切换。池仅复用连接，学习上下文、结果和凭据仍按原机制隔离。

评估参数 `--connection-policy pooled|fresh` 只覆盖本批合成任务，不修改应用模型选择、日常连接策略或 `.env`；不指定时使用应用配置。非法值在连接应用前拒绝。OAuth 路径把策略写入评估元数据，由 worker 传递给实际引擎；API key 路径使用 CLI 持有的池，批次结束关闭。通过 Undici [诊断通道](https://github.com/nodejs/undici/blob/v6.29.1/docs/docs/api/DiagnosticsChannel.md) 按请求对象关联事件，任务结束解除订阅；[Client 选项](https://github.com/nodejs/undici/blob/v6.29.1/docs/docs/api/Client.md) 决定空闲连接回收。没有增加自动重试或额外模型请求。

```sh
# 两个命令各调用 3 次，合计 6 次；每个样例每种策略各一次。
npm run evaluate:learning -- --mode live --auth oauth --env-file .env \
  --provider openai-codex --model gpt-6.1-sol \
  --cases search-extract,probability-quiz,unique-grade-correct \
  --connection-policy pooled --continue-on-error --output /tmp/gpt-pooled-new.json
npm run evaluate:learning -- --mode live --auth oauth --env-file .env \
  --provider openai-codex --model gpt-6.1-sol \
  --cases search-extract,probability-quiz,unique-grade-correct \
  --connection-policy fresh --continue-on-error --output /tmp/gpt-fresh-new.json
```

先核对 `transport.policy` 与实际 `reusedSocket`。pooled 允许复用，但服务端关闭、超出空闲窗口或前一请求失败时仍会新建连接；不能把 pooled 组所有请求视作复用。少量顺序样例只能帮助定位，不足以估计稳定失败率或证明因果；比较失败时应同时看原始码、阶段、实际复用和同一任务的结果。

### 2026-10-23 六次真实对照与流收尾发现

沿用已授权 `openai-codex / gpt-6.1-sol` OAuth，同样三个合成任务分别执行 pooled 与 fresh，每例一次，合计 6 次；没有增加重试。原始报告：[pooled](./results/gpt-6.1-sol-2026-10-23-pooled.json)、[fresh](./results/gpt-6.1-sol-2026-10-23-fresh.json)。两个批次均完成，`stopped` / `inFlight` 为 null，应用临时登录正常退出。

| 策略 | 有效返回 | 失败 | 实际观察到复用 |
|---|---:|---:|---|
| pooled | 3/3 | 0 | 0；三次均为新 socket |
| fresh | 2/3 | 1 | 0；两次新 socket，失败一次尚未分配 socket |

fresh 的 `unique-grade-correct` 在约 1.67 秒失败，原始码 **ECONNRESET**，`phase: dispatching`、`requestCount: 1`，`reusedSocket` / 收发字节均未知，未收到 HTTP 响应头。这是独立新 dispatcher 上的错误，因此该次故障不能归因于复用旧连接；DNS/TCP/TLS 中哪一步、远端/中间网络哪一端关闭仍无充分证据。原来三次失败没有保存原始码，不能追溯赋予这次结论。总计 5 条有可信 usage：输入 6,991 tokens、输出 1,277 tokens，目录费用估算 $0.026752；另 1 条费用未知，不能当作免费或实际账单。所有 `humanReview` 仍为 pending。

本批五条成功响应的传输阶段都停在 streaming。随后检查 Pi 1.0.4 发现：`mapCodexEvents` 在 completed 后返回，`parseSSE` 的 finally 立即取消 reader；若 HTTP EOF 稍晚到达，会破坏连接复用。本地真实 SDK + HTTP 服务将 EOF 延后 40 ms，先复现 pooled 无法复用，再修复为：仅已明确 completed 的流最多等待 250 ms、按 64 KiB 额外读取阈值消费尾部（最后一块可能跨过阈值），EOF 到达即可回收连接；超时、超量或用户取消均释放，不解释尾部内容、不增加请求。直接取消未完成流，任务总时限保持生效。回归还覆盖永不 EOF、连续尾部数据、用户取消和跨引擎复用。

**这 6 次真实报告产生于流收尾修复之前。** 最终收尾行为已用本地真实 SDK/HTTP 验证，尚未再次调用上游验证复用效果；报告原样保留。不能用 3/3 对 2/3 宣称 pooled 胜出，也不能把这批当作旧连接与新连接的有效因果对照，因为 pooled 组实际没有复用。服务器主动关闭连接或尾部超过限额时，最终实现仍可能新建连接。
