# 单用户聚合存储

PGlite（进程内 PostgreSQL，目录持久化）与 Drizzle，无外部数据库服务。`openRepository(':memory:', mode)` 创建独立内存库；其他路径使用独占目录锁。打开成功表示迁移和完整启动校验已提交。

## 接口与缓存

- `emptyData(mode)`：完整 `AppData`，schemaVersion=1、ownerId=`local`、revision=0。
- `readBackupWithoutMigration(path, mode): Promise<AppData>`：独立的升级前导出入口；仅打开已有 PG_VERSION 的磁盘目录，不初始化、不迁移。取得与 Repository 相同的独占锁，识别物理 v1/v2/v3，在只读 SQL 事务中读取并完整校验 AppData，最终关闭连接并释放锁。不启动 worker 或模型；坏数据、未知版本、缺行、错模式、活锁均拒绝导出。
- `read()`：返回已提交、已校验快照的隔离副本，仍包含文档全文和原始 Base64。进程独占锁期间不重复 SELECT 或全量校验。
- `revision()`：通过同一队列读取已提交缓存版本，不查 SQL、不复制整个快照，适合轻量变化探测。
- `learningPreferences()`：同队列读取并隔离复制小型应用偏好，支持 `/api/me` 而无需 SQL 或全聚合克隆。缺失时继承原配置。
- `transact(fn)`：串行操作隔离草稿；每次写入完整校验，revision 加一，以 SQL revision CAS 更新聚合。文档新增、内容变更、删除与聚合同事务提交；未改变的文档原文不会 UPDATE。回调、校验、CAS、文档 SQL 或 COMMIT 失败均不更新缓存，不自动重试回调。
- `replace(data)`：先完整校验并复制完整导入输入，再排队原子替换聚合和文档；删除备份中不再存在的文档原文。使用本库当前 revision+1，不使用备份 revision。不可改变 owner 或 mock/live 模式。
- `close()`：等待已排队操作，关闭后释放目录锁；幂等，关闭开始后拒绝新操作。

事务回调不能嵌套调用同一 Repository 的任何接口，包括 `revision()`、`close()`。回调返回值、保留的草稿引用和 `read()` 返回值均不共享缓存对象。回调不应启动脱离其 Promise 生命周期的草稿修改；外部副作用不能被 SQL 回滚，应放在事务外。

校验发生在启动/迁移、恢复输入和每次写入边界；拒绝损坏聚合、未知数据版本、错误类型、丢失字段、非 JSON 数据和实体 ID/索引键不一致。唯一有意的 JSON 规范化是 `schedule.last_review: undefined` 变为属性缺省。完整领域状态机/引用规则仍由领域层负责。

M1 可选内容版本字段兼容旧快照：校验 `contentVersion`、`contentHistory`、各处 `knowledgeVersion` 和 quiz task `recall` 的类型；历史版本序号不能重复，显式非空版本引用必须存在于知识点当前内容版本或历史中。缺失/null 的旧引用保持未知，不填当前版本，不用乐观锁 `version` 充当内容版本。非敏感 `aiModel` 选择随导出恢复；密钥、OAuth vault 不在数据库中。

新增的 `learningPreferences`、会话 `relatedKnowledge` 和 run `inputPrepared` 随逻辑备份保留，不新增物理迁移。旧字段缺失继续接受；关联快照必须匹配真实内容版本，缓存计数不得超过总输入。新字段写入后不承诺旧程序能打开；回滚需使用升级前备份与兼容程序，不原地降级。

## 物理 schema v3

`AppData.schemaVersion` 仍为 **1**，导出/导入继续使用完整兼容格式。内部 `app_schema_version` 账本现在为 **3**：

- `app_aggregate`：固定单用户主键、revision、updated_at、JSONB；文档条目只存元数据，不含 `text` 和 `originalBase64`；AI 任务条目只存状态等元数据，不含 `task`。
- `app_documents`：文档 ID、`text`、`original_base64`，逐条差量写入。
- `app_run_tasks`：任务 ID、`task`（JSONB，模型输入，H2 后单条可达预算上限）。新增插入、删除时删除，只有内容变化才 UPDATE；状态变化只改聚合元数据。

v3 的原因：H2 保留全文后，任务输入留在聚合里会让每次写入都重写全部历史输入（1000 条 × 4 万字时空写约 1 秒）。拆表后同规模空写约 16ms；内存快照拷贝共享不可变字符串，不再深拷贝正文。完整任务仍常驻内存快照，聚合元数据写入和全量校验仍随条数线性增长。

已有物理 v1/v2 库在打开时，先完整校验原数据及模式，再在同一 SQL 事务中建缺少的表（v1 建文档表和任务表，v2 建任务表）、拆分原文和任务输入、更新聚合和账本，最后重组并校验完整数据。迁移不改变应用 schemaVersion、revision、原文或任务；任何失败回滚 DDL、数据和账本。**旧程序不能直接打开物理 v3 库**；这不是物理库向后兼容承诺。需要旧程序时应另行评估完整 JSON 导出/导入的应用字段兼容性，而非复用新目录。

升级前备份无需旧程序副本：停服后、任何 `openRepository()` 调用之前，运行 `npm run data:export -- ./backup-before-v3.json --before-migration`，由本包 `readBackupWithoutMigration()` 获取完整 AppData 并保存备份。临时物理 v1 CLI 测试确认导出后 schema 仍 1、文件权限 0600、wx 拒绝覆盖。普通 `openRepository()` 会先自动迁移，不能代替这个升级前入口。该入口保证不写业务数据、不改变物理 schema/账本，但 PGlite 打开时可能执行 WAL 恢复等引擎写入，锁文件也会写入和释放，**不是磁盘零写**。

已有账本但表/记录缺失、未知账本版本、元数据和原文/任务记录不匹配、孤立原文/任务或残留内联原文/任务均拒绝打开，不重新填充空数据。无 PG_VERSION 的非空目录、无账本但已有表的数据库也拒绝初始化。`mock`、`live` 使用不同目录，模式不匹配不会迁移或修改数据。

## 工程边界与剩余成本

这是**单进程、单用户**权衡，不是多进程数据库服务。同进程重复打开真实目录被拒绝；独占文件锁拒绝其他应用进程，仅自动回收可确认死亡的本机 PID。未知/损坏锁 fail closed。PGlite 自身的崩溃恢复由其引擎处理，本包不手工删除 `postmaster.pid`。

缓存以独占访问为前提：不可绕过锁直接用原始 PGlite、外部工具或另一进程写目录；不承诺检测进程运行期间未经授权的磁盘改动。下次启动重新完整校验，CAS 保留为额外写保护。不应在运行中直接复制数据目录备份，使用 `read()` 完整导出。

仍有全聚合内存成本：缓存保存全部 AppData（包括文档原文），`read()` 复制全量，事务复制并校验全量，导出/恢复也需要完整内存快照；非文档原文部分仍为整行 JSONB 更新。任务中的来源快照可能继续包含文本。已拆文档原文和任务输入，不拆全部实体、不解决调用方全量响应、无限收据增长或重复保存。PGlite 目录有数据库引擎固定开销，目录约 39MB **不代表逻辑业务数据量**。

## 验证

```sh
npx vitest run packages/database/src --testTimeout=30000 --hookTimeout=30000
```

本包测试已纳入最终 `npm run test:unit` 全量回归（全项目 12 文件、265 测试通过）；`npm run check` 的根/web TypeScript 与边界检查通过。不叠加此前单包局部执行次数，完整结果见[审查修复记录](../../docs/审查修复记录.md#最终验证)。这不是实际用户库迁移或 live 服务验证；最后仅修正知识点测试夹具字段为 `contentVersion`，不改变生产代码。

测试全部使用内存或系统临时目录。升级前导出覆盖 v1/v2 账本不升级、v3 完整一致、活锁拒绝、不初始化新库、坏库/错模式失败与锁释放。覆盖副本隔离、排队/关闭/嵌套拒绝、完整导出导入、v1→v3 与 v2→v3 迁移及 SQL/COMMIT 失败回滚、CAS、模式隔离、原文与任务输入差量写入/删除（触发器验证未变化时不写）、坏数据拒绝、缓存免 SELECT/校验、内容版本兼容校验。锁测试覆盖真实子进程互斥、活/死 PID、未知锁，以及实际 SIGKILL 后 `.sanxing.lock` 和 PGlite `postmaster.pid` 残留下恢复已提交状态；不操作用户服务或真实数据目录。
