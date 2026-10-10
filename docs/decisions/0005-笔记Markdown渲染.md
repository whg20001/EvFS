# ADR 0005：原始笔记 Markdown 排版与最大化阅读

状态：已实现。日期：2026-10-10。

## 背景与范围

共享 `Source` 原先仅按行显示原始文本。Markdown 源码难以阅读，380px 内容区也不适合长笔记。复述、学习会话、知识详情和资料检索复用同一组件，因此阅读能力在这里统一提供。

只有上传/粘贴文档（带文档 ID 的 `data.documents` 条目）提供“排版 / 原文（行号）”分段按钮。`.md`、`.markdown`（忽略大小写）和无扩展名文档默认排版；`.txt` 及未知扩展名默认原文。旧知识及原始复述快照没有文档 ID，始终显示行号，不提供排版切换。

现有服务端要求上传/粘贴名称以 `.txt/.md/.markdown` 结尾。因此新粘贴资料未填支持的扩展名时，前端默认补 `.md`，保持现有服务端校验；显式 `.txt` 不变。已有无扩展名条目同样默认排版，历史自动补成 `.txt` 的资料仍默认原文，可手动切换。不修改存储文本、来源 ID、行号、AI 输入、历史快照或数据库 schema。

## 依赖与性能

固定 `react-markdown 10.1.0`、`remark-gfm 4.0.1`、`remark-math 6.0.0`、`rehype-katex 7.0.1`、`katex 0.16.47`，同步 npm lock。KaTeX 选用 rehype-katex 声明兼容的 0.16 分支，CSS 与实际渲染器共用一份版本；没有跨大版本混用 0.19 样式。

- 用 `next/dynamic`、`ssr:false` 在首次排版时加载渲染器及依赖；不放入初始页面 JavaScript。KaTeX CSS 从 npm 导入，相对字体由 Next 打包到同源静态资源，无 CDN。
- `React.memo` 按文本跳过已挂载组件的重复渲染。原文行视图也 memo；不维护全局私人正文/AST 缓存。
- Python、JS、TS 代码块复用现有 CodeMirror 的语言解析器与 `@lezer/highlight`，生成 React span；带语言标签。未知语言保留等宽样式，没有增加另一套高亮器。
- 表格、代码块及块级公式各自限制宽度并内部滚动；移动端页面不因长表格而横向溢出。

## 非可信内容边界

[react-markdown](https://github.com/remarkjs/react-markdown) 将 Markdown 转为 React 节点。未使用 `rehype-raw`，也未使用 `dangerouslySetInnerHTML`；原始 HTML 保留为转义文本，便于核对原笔记。

- Markdown 图片一律替换成不可点击的文字占位，展示 alt 和原始 URL；外部、同源、相对及 data 图片均不生成 `img`。
- 仅允许显式 `http://`、`https://`、`mailto:` 且可由 URL 解析的链接。控制字符、空白、反斜杠、相对地址、协议相对地址及其他协议只显示文字，不生成 href。允许的链接使用 `target="_blank"`、`rel="noopener noreferrer nofollow"`、`referrerPolicy="no-referrer"`，阅读时不预取链接。
- [KaTeX 安全选项](https://katex.org/docs/options)：`trust:false`、`throwOnError:false`、`maxSize:10`、`maxExpand:1000`，禁用 `\href`、`\url`、`\includegraphics` 等受信任命令，不允许公式创建链接或加载图片。
- rehype-katex 7 内部先以 `throwOnError:true` 尝试渲染，捕获后以 `false` 再次渲染或生成错误节点；调用方仍显式传 `false`。解析错误保留错误文本，不向 React 抛出导致页面崩溃。
- 任务列表只读，代码块仅着色，不接入代码执行器。

“不执行 HTML、脚本或自动加载笔记外部资源”适用于浏览笔记。用户主动点击允许的链接会打开目标网站；本功能不承诺目标站点安全。

## 蒙版和无障碍

每个 summary 都有“最大化查看 {名称}”按钮，点击、Enter、Space 都独立于 details 的展开动作。内联和最大化共用视图状态、加载条件和组件内正文缓存；内联请求进行中打开蒙版不会重新发起请求。关闭全部阅读面板或卸载会中止未完成请求；再次打开可重试。已加载文本在该 Source 挂载期间复用，跨页面重新挂载可重新拉取。

蒙版 portal 到 body，复用 `.modal-backdrop`。桌面宽 `min(1100px,100%)`、高 `calc(100vh - 48px)`；移动端使用 `100dvh`，内容左右 16px。正文独立滚动，头部固定可用；标题、行数、同步切换和关闭按钮在面板头部。

使用 dialog/aria-modal/aria-labelledby，打开时聚焦关闭按钮。Tab/Shift+Tab 包含链接、表格滚动区、正文滚动区和所有可用控件，禁用的任务复选框跳过；背景节点暂时 inert，body 滚动锁定。Esc、关闭按钮或点击空白蒙版均恢复原滚动状态、inert 状态和触发按钮焦点。深色使用现有颜色变量的阅读区域覆盖。

## 最大化阅读大纲

大纲仅用于最大化的 Markdown 文档（带 `data.documents` 文档 ID，文件名为 `.md/.markdown` 或无扩展名），两种视图共用同一份大纲。内联展开、`.txt`/未知扩展名、旧知识快照与原始复述快照不提供大纲；无标题时完全省略大纲栏。`.txt` 即使手动切到排版也不提供大纲，这是按本轮 TXT 验收要求作出的范围取舍，不影响原有视图切换。

- `source-outline.ts` 纯函数使用 `unified 11.0.5`、`remark-parse 11.0.0`，与渲染器共用 `remark-gfm`、`remark-math` 插件配置。新增直接依赖固定为现有 react-markdown 依赖树中的版本，`@types/mdast 4.0.4` 为直接开发依赖；保持 `ignore-scripts=true`。从 mdast heading 节点取 1–6 级深度、起始行和纯文本，支持 ATX、Setext、引用与列表内标题；代码、HTML 块和公式块中的井号不作为标题。
- 标题文字递归去除强调、链接、行内代码等 Markdown 标记，图片取 alt，HTML 标签和脚注引用标记省略；公式保留解析后的源码文本及内部空白。脚注标题仅纳入 GFM 实际渲染的被引用定义（包括间接引用，忽略后续同名定义并防止引用环），未引用定义不产生无法跳转的条目。数据层不截断，按钮仅用 CSS 省略过长文字，完整文本保留在 `title`；空标题使用“（无标题）”。
- 大纲组件与渲染器一起按需加载，提取器不进入首屏包。`useMemo([text])` 在当前蒙版挂载期间仅随正文变化提取，视图切换、展开折叠、点击和 scrollspy 更新均复用结果；正文渲染组件维持 memo。关闭后重开或跨来源实例可重新解析，不增加全局私人正文/AST 缓存。
- 排版标题与对应标题的原文行容器以数字 `data-source-line` 对应；只在带大纲的蒙版标题目标上添加定位属性和 `tabIndex=-1`，普通原文行不加标记。不由笔记文本生成 `id/name`，不写 URL hash。大纲 nav 的 `aria-controls` ID 来自 React `useId`。
- 点击先在下一动画帧等待窄屏面板收起，再将正文容器滚到目标顶部约 16px，并以 `preventScroll` 聚焦目标。通常平滑滚动，`prefers-reduced-motion: reduce` 使用即时滚动；原文行高亮 1.8 秒，重复点击清除前一行高亮，切换视图/卸载时清理计时器。
- scrollspy 使用 passive scroll + `requestAnimationFrame` 节流，按渲染 DOM 顺序二分查找顶部附近标题（每帧 O(log n) 次位置读取），滚到末尾时激活最后一项。`ResizeObserver` 跟踪正文及容器尺寸变化，切换视图后重建目标映射；当前条目标记 `aria-current="location"`。所有监听、observer、动画帧和定时器在清理时移除。
- ≥900px 为 240px 左侧独立滚动大纲，正文独立滚动；<900px 为正文上方“大纲”按钮及最多 30dvh 高的折叠面板，点击条目后自动收起。使用现有颜色变量，深色岛同步适配。`nav aria-label="笔记大纲"` 内均为按钮，缩进反映标题深度；沿用蒙版焦点循环，隐藏面板的条目不会进入 Tab 序列，Esc 仍恢复最大化按钮焦点。

## 验证与限制

纯函数单元测试覆盖文件名默认模式、链接协议/混淆过滤及大纲语义、源码行号、长标题和 2,000 个标题；浏览器测试覆盖真实 mock 上传→确认知识→详情、粘贴、语义元素、原文逐行对照、HTML/图片/公式攻击、网络观察、缓存复用/重试、键盘/焦点/蒙版、两种视图的大纲跳转、scrollspy、减少动态效果和 390px 深色折叠布局。完整验证命令与数量见[已有验证记录](../笔记Markdown渲染-实施结果.md)。

长文排版在主线程执行，未做分页或虚拟化；数学限制仅约束单个公式的尺寸和展开次数，不是整篇文档的 CPU/内存硬限额。不同挂载实例不会共享解析结果；跨视图卸载后会重新解析。未实现图片加载、相对链接导航、HTML/MDX、完整 TeX 或更多语言着色。本次自动化浏览器验收限 Chromium，其他浏览器尚未人工验收。
