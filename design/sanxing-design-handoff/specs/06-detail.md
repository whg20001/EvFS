# 06 知识点详情

截图：`screenshots/06-detail.png`。导航选中「知识库」。从 02 / 03 / 04 / 05 的知识点链接进入。

## 顶部

- 面包屑：「知识库 › 深度学习 › Transformer › 缩放点积注意力」，前三级 `.text-body-small ink-500` 可点，当前级 `.text-label ink-900`，分隔符 14 右箭头 `ink-300`。
- 顶栏：标题 = 知识点名称；副标题「10 月 8 日首次学习 · 复述 1 次 · 追问 5 题 · 测验 2 题」；下面一行 Tag：主题（Primary）、上级（Neutral）、状态（待巩固 = Warning / 已掌握 = Success / 有误解 = Danger）。右侧：搜索 · 通知 · Secondary「编辑笔记」· Primary「立即复习」。

## 主体：左栏自适应 + 右栏 360，间距 24

### 左栏（间距 20）

1. **我的理解**（卡片，内边距 24）：标题右侧「来自 10/08 复述，已按追问修订」`.text-caption ink-500`。正文 `.text-body-large`。公式块（`bg-subtle` 底、1px 描边、圆角 10、内边距 14 / 18，居中，`.text-num-medium`；实现时用 KaTeX 渲染 LaTeX）。AI 补全块（`primary-50` 底，「AI 补全 · 已加入笔记」+ 内容 `.text-body-small ink-700`）。「编辑笔记」进入编辑态，AI 补全块可单独删除。
2. **我的误区**（卡片）：标题右侧 Success Tag「1 个已纠正」。每条误区一行（`bg-subtle` 底、1px 描边、圆角 10、内边距 14）：IconTile 32（danger 感叹号）+ 「复杂度写成了 O(n)」`.text-label` / 经过「10/08 复述中出现 → 追问时确认 → 测验第 4 题答对。10/11 复习时会再考一次。」`.text-caption ink-500` + 状态 Tag（已纠正 Success / 未纠正 Danger）。
3. **学习记录**（卡片，内边距 24）：标题右侧分段控件「全部 / 复述 / 追问 / 测验」。时间线每项：IconTile 32（复述 primary 笔 · 追问 info 对话 · 补全 primary 闪光 · 测验 success 勾选框 · 复习 accent 日历）+ 竖线 2×20 `line-default`；右侧「复述」`.text-label` +「10/08 21:40」`.text-num-small ink-500`，下一行详情 `.text-body-small ink-700`。计划中的项（最后一条「第 1 次复习 · 计划中 · 届时预计保持率约 43%」）文字用 `ink-500`。

### 右栏（间距 20）

1. **掌握度**：圆环 104「64% / 待巩固」+ 四行统计（名称 `.text-body-small ink-500` … 值 `.text-label`）：复述 1 次 · 追问 5 题 · 测验正确率 50% · 下次复习 10/09。
2. **遗忘曲线**：标题右侧 Neutral Tag「预测」，副标题「按计划复习后的记忆保持率」。小图 312×170：与 04 相同的模型和平方根刻度，从今天开始画未来 30 天；不画纵轴刻度；横轴标「今天、1天、4天、15天、30天」，对齐各自的复习节点。
3. **相关知识点**：Tag 列表（自动换行），颜色表示该知识点的状态（Success 已掌握 / Warning 待巩固 / Neutral 未学）。点击跳到对应知识点。
4. **笔记附件**：标题右侧数量 `.text-num-medium ink-500`；每行 IconTile 28 + 文件名 `.text-body-small ink-700` + 下载图标。
