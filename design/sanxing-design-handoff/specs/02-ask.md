# 02 AI 追问与补全

截图：`screenshots/02-ask.png`。导航选中「AI 追问」。交互细节见 `interactions.md`「02」。

## 顶栏

- 标题「AI 追问 · 自注意力机制」（「·」后为本次复述的主要主题）；副标题「第 1 轮 · 已回答 2 / 5 个问题」。
- 右侧：搜索 · 通知 · Secondary「跳过剩余追问」· Primary「完成并生成测验」（任何时候可点；未答的问题不计入完整度）。

## 主体：对话区自适应 + 右栏 360，间距 24

### 对话区

容器 `bg-subtle` 底、1px `line-default`、圆角 12、内边距 24、消息间距 20；高度随内容，实际实现为可滚动区域（顶栏以下撑满视口），输入框固定在底部。

消息顺序（示例）：
1. **我的复述（折叠）**：白底小卡片，笔图标 +「我的复述 · 386 字 · 附 3 份笔记」`.text-label ink-700` + Ghost S「展开全文」；下面一行摘要 `.text-body-small ink-500`，单行省略。
2. **AI：确认知识点**。正文 + 知识点列表（1px 描边、圆角 10，行内边距 12 / 14，行间分隔线）。每行左侧名称 `.text-label` + 一句话说明 `.text-caption`，右侧：
   - 已确认：Success Tag「已确认」
   - 待确认：Secondary S「准确」+ Ghost S「修改」
   - 可能有误：整行 `danger-100` 底，说明文字 `danger-600`（写明冲突来源，如「复述写的是 O(n)，笔记第 2 页写的是 O(n²·d)」），右侧 Danger Tag「可能有误」
3. **AI：追问**。Tag 行（Primary「问题 2 / 5」+ Neutral「追问细节」）→ 问题 `.text-body` → 可选提示条（`warning-100` 底、圆角 8、内边距 6 / 10，问号图标 +「提示：……」`.text-caption warning-600`）。
4. **用户回答**（右对齐气泡，见 components.md）。
5. **AI：评价 + 补全**。评价行：对勾 `success-600` +「回答很完整」`.text-label success-600` + Success Tag 若干（准确、能说清原因）→ 说明 → AI 补全块（闪光图标 +「AI 补全」`.text-label primary-700`，每段 `.text-body-small ink-700`）→ 按钮组：Primary S「加入今天的笔记」· Secondary S「我已经掌握」· Ghost S「稍后再说」。
6. **AI：当前问题**（问题 3 / 5，Neutral「回应你的疑问」——针对用户复述里自己提出的疑问）。
7. **输入框**：白底、1.5px `primary-600` 描边（聚焦态即默认态）、圆角 12、内边距 12 / 14；占位「输入你的回答，或者贴一段笔记…」；底部一行：附加笔记 / 上传图片 / 语音输入（32 无框图标按钮）+ 留白 +「Enter 发送 · Shift + Enter 换行」`.text-caption ink-500` + 发送按钮。

### 右栏（间距 20）

1. **本次学习画像**（卡片，副标题「与本节的标准知识点对比」）：圆环 108「72% / 完整度」+ 图例四行（圆点 8 + 名称 `.text-body-small ink-700` + 数量 `.text-num-medium`）：已掌握 `success-600` · 待巩固 `warning-600` · 有误解 `danger-600` · 未提及 `ink-300`。分隔线下「未提及的知识点」`.text-label ink-700` + Neutral Tag 列表（自动换行）。
2. **追问进度**（卡片，右上「2 / 5」`.text-num-medium ink-700`）：五行，已完成为对勾 `success-600`；当前为 16 圆（`accent-100` 底 + `accent-600` 描边）+ 名称 `.text-label` + Accent Tag「当前」；未开始为空心圆 + `ink-500` 文字。点击已完成的行滚动到对应对话。
3. **复习安排**（提示卡片）：日历图标 +「完成后将加入复习计划」`.text-title-card`；「首次复习：明天 21:00\n之后按 2、4、7、15、30 天的间隔提醒；有误解的知识点会提前。」`.text-body-small ink-700`（时间取用户设置的提醒时间，待确认是否提供该设置）。
