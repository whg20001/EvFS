# 原始笔记 Markdown 排版与最大化阅读：实施结果

日期：2026-10-10。本文保留前一轮实施说明；验证数量已同步至大纲增补及高亮修复后的最终全量运行，大纲设计见 [ADR 0005](./decisions/0005-笔记Markdown渲染.md#最大化阅读大纲)。

## 已实现

共享 `Source` 支持 Markdown/GFM、KaTeX 公式、Python/JS/TS 代码着色和“排版 / 原文（行号）”同步切换。所有来源可从闭合状态直接最大化，正文按需加载；蒙版支持焦点循环、背景 inert、滚动锁定、Esc/空白关闭和焦点恢复。已覆盖移动端与深色阅读。

HTML 转义为可读文本，所有图片均为文字占位；仅显式 http/https/mailto 链接可主动打开，其他协议和相对链接没有 href。KaTeX 禁用信任命令，设置尺寸和宏展开限制，CSS/字体从 npm 同源打包。原始文本、行号、来源关系及历史快照不变。

## 文件变更

| 文件 | 变更 |
| --- | --- |
| `apps/web/src/components/ui.tsx` | 共享视图状态、动态渲染入口、原文 memo、最大化触发及按需请求/缓存复用 |
| `apps/web/src/components/source-markdown.tsx`（新增） | Markdown/GFM/公式、图片占位、链接约束及 Lezer 高亮 |
| `apps/web/src/components/source-dialog.tsx`（新增） | portal 蒙版、无障碍焦点循环、背景与 body 状态恢复 |
| `apps/web/src/lib/source-view.ts`（新增） | 默认视图判定、链接 URL 白名单纯函数 |
| `apps/web/src/lib/source-view.test.ts`（新增） | 28 项文件名及 URL 协议/混淆单测 |
| `apps/web/src/components/knowledge.tsx` | 更新来源卡片说明 |
| `apps/web/src/components/recite.tsx` | 新粘贴资料默认补 `.md`，显式 `.txt` 保留 |
| `apps/web/src/app/globals.css` | 排版、表格独立滚动、蒙版、深色和移动端样式 |
| `apps/web/package.json`、`package-lock.json` | 固定五个渲染依赖及完整锁文件 |
| `package.json`、`vitest.config.ts` | 将 Web 纯函数测试纳入 `test:unit` |
| `tests/e2e/source-markdown.spec.ts`（新增） | 20 项完整阅读、恶意内容、焦点/键盘/缓存、大纲定位及移动深色浏览器测试 |
| `tests/e2e/library.spec.ts`、`tests/e2e/state-sync.spec.ts` | 原有按行断言显式切到原文，展开动作点击文件名，避免点中新增按钮 |
| `README.md`、`docs/产品与架构规格.md` | 更新能力、行为规则和验证入口 |
| `docs/decisions/0005-笔记Markdown渲染.md`（新增） | 依赖、安全、交互、性能取舍 |
| `docs/审查修复记录.md`、本文件（新增） | 本次改动、验证命令、结果及限制 |

## 设计取舍

- 固定 `react-markdown 10.1.0`、`remark-gfm 4.0.1`、`remark-math 6.0.0`、`rehype-katex 7.0.1`、`katex 0.16.47`。KaTeX 采用 rehype-katex 兼容的 0.16 分支，并通过 npm 依赖树确认共用单一版本。保持 `.npmrc` 的 `ignore-scripts=true`；安装缓存定向到 `/tmp`，没有启用安装脚本。
- Markdown 依赖通过 `next/dynamic`、`ssr:false` 懒加载；渲染组件按文本 memo。着色使用已有语言解析器，不增加独立高亮依赖。
- 仅文档提供排版切换，历史快照保持原文。`.txt` 默认原文，`.md/.markdown` 与已有无扩展名文档默认排版。由于服务端要求支持的扩展名，新粘贴资料默认补 `.md`，没有放宽文件类型校验或改写历史记录。
- 不使用 `rehype-raw` 或 `dangerouslySetInnerHTML`。图片 URL 只传给文字占位；链接双层过滤，公式信任命令关闭。详见 [ADR 0005](./decisions/0005-笔记Markdown渲染.md)。
- 每个 Source 自有缓存，内联和蒙版共享请求/文本/视图状态；未引入全局私人正文缓存。关闭全部视图会取消未完成请求，卸载后可重新请求。

## 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 73 个生产源码边界检查通过；根目录与 Web TypeScript 通过 |
| `npm run test:unit` | 20 文件，496 项通过（含 28 项视图/链接及 16 项大纲纯函数测试） |
| `npm run test:integration` | 12 文件，109 项 API 通过；随后 12 项 Node socket 代理测试通过 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/home/shi/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome npm run test:e2e` | 完整 72 项通过（含 20 项笔记阅读/大纲场景），无跳过 |
| `SANXING_NEXT_PROFILE=validation NEXT_TELEMETRY_DISABLED=1 npm run build` | 隔离生产构建通过，2/2 静态页生成成功；输出到 `.next-validation` |

**合计 689 = 496 + 109 + 12 + 72。** 仅计各套件最后完整运行，不累加局部测试；integration 已包含代理测试，仅统计一次。

浏览器回归实际覆盖：语义标题/列表/任务/表格/代码/公式，原文逐行一致，TXT/无扩展名/历史快照默认模式，原始 HTML 与恶意链接/图片/公式，外部请求为零，同源和 data 图片也不加载，内联加载中打开蒙版不重复请求，失败后重试，Enter/Space 不切换 details，焦点包含链接并循环，Esc/蒙版关闭恢复焦点与滚动，390px 深色无横向溢出及 KaTeX 字体同源加载。修复了实测发现的蒙版 mousedown 默认聚焦覆盖焦点恢复问题。

移动端深色验收截图：[`test-results/source-markdown-mobile-dark.png`](../test-results/source-markdown-mobile-dark.png)（本地测试产物，不纳入版本控制）。

## 已知限制

- 仅 Chromium 自动化验收；未人工验证其他浏览器、真实模型或账号。
- 大笔记解析与着色仍在主线程执行，没有分页或虚拟化。KaTeX 的 `maxSize/maxExpand` 限制单个公式，不提供整篇文档 CPU/内存硬限额。
- 同文本 memo 适用于已挂载组件；跨来源实例、跨页面重新挂载或切换卸载后可重新解析。已加载正文只在当前 Source 生命周期内缓存。
- 无图片加载、相对链接导航、HTML/MDX 执行、完整 TeX、更多语言着色。用户主动打开允许的链接会访问目标站点。
- 历史粘贴资料若已保存为 `.txt`，仍默认原文，可手动切到排版。

## 操作范围

仅使用合成凭据、离线/mock Provider、内存/临时库。E2E 使用 3027/4107，构建使用 validation 隔离输出。未读取或修改 `data/live`、`data/mock`（含锁）、私人 `.env`、备份、AI vault 或凭据；未操作 4000/3010/3000 服务；未提交 git。
