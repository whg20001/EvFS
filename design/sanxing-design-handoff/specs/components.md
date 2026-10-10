# 组件规范

数值单位为 px，颜色写令牌名（`primary-500` = `var(--color-primary-500)`）。对照 `screenshots/00-style-guide.png`。
标注「设计稿未画」的状态，请按这里的说明实现。

## Button

| Kind | 底色 | 描边 | 文字 | 用途 |
|---|---|---|---|---|
| Primary | `primary-500` | 无 | `primary-800` | 每屏最多一个主操作 |
| Secondary | `bg-surface` | 1px `line-strong` | `ink-900` | 次要操作 |
| Ghost | 无 | 无 | `primary-700` | 文字按钮：管理、展开全文、查看全部 |
| Accent | `accent-600` | 无 | `base-white` | 只用于逾期复习 |

| Size | 高 | 左右内边距 | 文字样式 |
|---|---|---|---|
| M | 40 | 18 | `.text-button` |
| S | 32 | 12 | `.text-label` |

圆角 `radius-md`（8），图标与文字间距 6，宽度随内容。文案里的箭头直接用字符「→ / ←」。

状态（设计稿未画）：
- hover：底色叠 6% 的 `ink-900`（`color-mix(in srgb, var(--color-primary-500) 94%, var(--color-ink-900))`）；Ghost 加 `primary-50` 底色。
- pressed：叠 12%。
- disabled：底 `neutral-100`、文字 `ink-300`、无描边，`cursor: not-allowed`。
- focus-visible：2px `primary-600` 外框，偏移 2。
- loading：文字前加 16px 旋转图标，宽度不变，禁止重复点击。

## Tag（状态标签）

内边距 2 / 8，圆角 `radius-sm`（6），文字 `.text-tag`。

| Tone | 底 | 字 | 用途 |
|---|---|---|---|
| Neutral | `neutral-100` | `ink-700` | 主题名、次要信息 |
| Primary | `primary-100` | `primary-700` | 当前主题、题型、问题序号 |
| Accent | `accent-100` | `accent-600` | 「今天」「当前」「5 项到期」 |
| Success | `success-100` | `success-600` | 已确认、已掌握、已解析、正确 |
| Warning | `warning-100` | `warning-600` | 待巩固、逾期、解析中、补全内容 |
| Danger | `danger-100` | `danger-600` | 有误解、可能有误、错误 |
| Info | `info-100` | `info-600` | 文件类信息（目前只用于图标块） |

## Card

白底 `bg-surface`、1px `line-default` 描边、圆角 `radius-xl`（12）、阴影 `--shadow-card`，内边距 20（大卡片 24），子元素间距 16。
提示类卡片（提交栏、复习安排、AI 周报、答题之后）：底 `primary-50`、描边 `primary-100`。

**卡片标题行**：左侧标题 `.text-title-card`（大卡片 `.text-title-section`）+ 可选副标题 `.text-caption ink-500`；右侧放 Tag / Ghost 按钮 / 分段控件，垂直居中。

## Segmented（分段控件）

外框 `neutral-100` 底、圆角 8、内边距 3、项间距 2；每项内边距 6 / 14、圆角 6，文字 `.text-label`。
选中项：白底 + `--shadow-card`，文字 `ink-900`；未选中文字 `ink-500`。用 `role="tablist"` / `aria-selected`。

## IconButton

36×36（顶栏 40×40 圆形），圆角 8，白底 + 1px `line-default`，图标 18–20 `ink-700`。列表行内的操作（预览、移除、附件）用无底无框的 32×32 版本。必须有 `aria-label`。
发送按钮：32×32、`primary-500` 底、`primary-800` 图标。

## NavItem（侧边栏导航）

内边距 10 / 12、圆角 8、图标 20 与文字间距 12。
- 默认：图标 `ink-700`，文字 `.text-body ink-700`。
- 选中：底 `primary-500`，图标和文字 `primary-800`，文字 `.text-label`。
- hover（设计稿未画）：底 `primary-50`。
- 角标：`accent-600` 底、白字 `.text-num-small`、圆角 10、内边距 1 / 7，靠右。

## SearchField

高 40、宽 240、圆角 pill、白底、1px `line-default`，左侧 16 搜索图标，占位文字「搜索知识点、笔记…」`.text-body-small ink-500`。快捷键 `/` 聚焦（见 interactions.md）。

## ProgressBar

轨道 `neutral-100`、值 `primary-500`，两端全圆角。高度：列表 6、主题掌握度 8、上传进度 4（上传用 `warning-100` / `warning-600`）。
低于阈值改用 `warning-600`：保持率 < 50%、掌握度 < 60%。**旁边必须显示数值**。

## Ring（圆环）

线宽 = 直径 × 9%，轨道 `neutral-100`，弧 `primary-500`，圆头，从 12 点方向顺时针。中心数值 `.text-num-large`（直径 > 100）或 `.text-num-medium`，下方可选说明 `.text-caption ink-500`。尺寸：108（完整度）、104（掌握度）、40（薄弱知识点列表）。

## StatusDot / 时间线节点

- 图例圆点 8。
- 时间线节点 12（已完成 `primary-600` 实心 / 今天 14 `accent-600` 实心 / 计划中 白底 1.5px `line-strong` 描边），节点之间 2px 竖线：已完成段 `primary-300`，其余 `line-default`。

## IconTile（图标块）

36×36（列表 32、附件 28），圆角 8，底 `{tone}-100`，图标 `{tone}-600`，图标尺寸为块的一半。文件类型：Markdown / PDF / Word 用 info，图片用 accent。

## 聊天气泡（02 页）

- AI：左侧 32 圆形头像（`primary-500` 底 + `primary-800` 闪光图标），气泡白底、1px `line-default`、圆角 12、内边距 16、子元素间距 12，撑满剩余宽度。
- 用户：右对齐，宽 520，底 `primary-100`、圆角 12、内边距 16，右侧 32 圆形头像（`neutral-100` 底 + 姓氏首字）。
- 气泡里可以嵌：知识点确认列表、提示条（`warning-100`）、评价行、AI 补全块（`primary-50` 底 + `primary-100` 描边）、操作按钮组（S 号按钮，间距 8）。

## 选择题选项（03 页）

内边距 14 / 16、圆角 10、1px `line-default`，单选圈 20、字母 `.text-num-medium ink-500`、选项文字 `.text-body`，间距 14。
- 选中且正确：底 `success-100`、1.5px `success-600` 描边、实心圈 + 右侧对勾。
- 选中且错误（设计稿未画）：底 `danger-100`、1.5px `danger-600` 描边、右侧叉号；同时把正确选项标成「正确」样式。
- 未作答时 hover：描边 `primary-600`。

## 文件行与上传区（01 页）

文件行：内边距 12 / 14、圆角 10、1px `line-default`，左侧 IconTile 36，中间文件名 `.text-label` + 元信息 `.text-caption ink-500`（解析中时下方加 240 宽进度条），右侧状态 Tag + 预览 / 移除按钮。
上传区：内边距 20、圆角 10、1px 虚线 `line-strong`（6 / 4）、底 `bg-subtle`，居中排列上传图标（22，`primary-600`）、主文案 `.text-label`、说明 `.text-caption ink-500`。拖拽悬停时（设计稿未画）：描边改 `primary-600`、底 `primary-50`。

## 表格（04 页复习队列）

表头底 `bg-subtle`、上下 1px `line-default`，文字 `.text-caption ink-500`；行内边距 14 / 24、行间 1px 分隔线；第一列自适应，其余固定宽（主题 120、复习进度 110、预计保持率 190、上次表现 130、状态 110、操作 96）。窄屏时整表放进横向滚动容器。
