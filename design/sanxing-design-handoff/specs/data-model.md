# 数据模型与 AI 环节

产品要求「在后台记录用户的详细学习情况」，以下是支撑全部 7 个页面所需的最小数据结构。字段名是建议，可按后端习惯调整；**带「待确认」的地方请先和产品确认**。

## 实体关系

```
User ─┬─ Recitation（每天一份复述）─┬─ Attachment（笔记附件）
      │                            ├─ FollowUpSession（追问）── FollowUpTurn（每一问一答）
      │                            └─ Quiz（测验）── Question ── Answer
      │
      └─ KnowledgePoint（知识点，跨天累积）─┬─ Mention（在哪次复述 / 追问 / 测验中出现）
                                          ├─ Misconception（误区）
                                          ├─ Supplement（AI 补全）
                                          └─ ReviewSchedule（复习排期）── ReviewLog（每次复习）
```

## 主要实体

**Recitation（复述）**
`id, userId, date, sections: { learned, unclear, apply }`（三省的三段文本）`, topics[], wordCount, durationSec, status: draft | submitted | followed_up | quizzed, createdAt, updatedAt`

**Attachment（附件）**
`id, recitationId, kind: markdown | pdf | docx | image | pasted, name, sizeBytes, pageRange?, parseStatus: uploading | parsing | done | failed, parseProgress, extractedText, formulaCount?, storageUrl`

**KnowledgePoint（知识点）**
`id, userId, name, topic, parentPath[]`（知识库 / 深度学习 / Transformer）`, myUnderstanding`（最近一次修订后的理解）`, status: mastered | consolidating | misconceived | not_mentioned, mastery (0–100), firstLearnedAt, relatedIds[]`

**FollowUpSession / FollowUpTurn（追问）**
Session：`id, recitationId, round, completeness (0–100), totalQuestions, answeredQuestions`
Turn：`id, sessionId, index, type: confirm | probe | answer_doubt | ..., question, hint?, userAnswer, evaluation: { level: good | ok | weak, tags[] }, knowledgePointIds[]`

**Supplement（AI 补全）**
`id, knowledgePointId, sessionId, content, decision: added | already_known | later`

**Misconception（误区）**
`id, knowledgePointId, description`（复杂度写成了 O(n)）`, source: recitation | followup | quiz, status: open | corrected, correctedAt?, recheckAt?`

**Quiz / Question / Answer（测验）**
Quiz：`id, recitationId?, kind: daily | review, totalQuestions, correctCount, startedAt, finishedAt?, elapsedSec`
Question：`id, quizId, index, type: single | short | derive | judge, difficulty, stem, options?, correctOption?, rubric?: [{ name, weight }], sourceReason: misconception | consolidating | today_core | due_review | synthesis, knowledgePointIds[]`
Answer：`id, questionId, choice? | text?, isCorrect?, score?, rubricScores?, aiFeedback, appealed`

**ReviewSchedule / ReviewLog（复习）**
Schedule：`knowledgePointId, reviewIndex`（第几次）`, dueAt, intervalDays, predictedRetention, overdueDays`
Log：`id, knowledgePointId, reviewIndex, reviewedAt, mode: recite_and_quiz, quizCorrect, quizTotal, retentionBefore`

## 计算口径（设计稿里出现的数字）

| 数字 | 页面 | 建议口径 |
|---|---|---|
| 连续复述天数 | 侧边栏、05 | 连续有 `submitted` 复述的天数，到昨天为止；今天提交后 +1 |
| 完整度 | 02、05 | 本次复述覆盖的标准知识点数 ÷ 标准知识点总数。**标准知识点来源待确认** |
| 掌握度 | 05、06 | 建议：0.4 × 最近 3 次测验正确率 + 0.3 × 追问评价得分 + 0.3 × 预计保持率；有未纠正误区时上限 60 |
| 预计保持率 | 01、04 | 见下文复习模型 |
| 测验正确率 | 05 | 所选范围内客观题答对数 ÷ 客观题总数；简答题按 ≥ 6 / 10 计为答对 |
| 本周复述时长 | 01 | 编辑器获得焦点且有输入的累计时长 |

## 复习模型（04 页曲线与排期）

- 默认间隔：学习后第 **1、2、4、7、15、30** 天复习（`tokens.json → review.intervalsDays`）。
- 设计稿曲线用的示意模型：`R(t) = exp(-(t - t_i) / S_i)`，`S_i = S0 · K^i`，`S0 = 1.2`、`K = 2.3`（第 i 次复习后稳定度变大，曲线变缓）。实现时可以换成 SM-2 / FSRS 等算法，但界面需要的输出不变：下次复习时间、当前预计保持率、未来曲线。
- 答题结果调整排期：本次复习的题目全对 → 进入下一个间隔；有错 → 回退一个间隔，且明天优先复习；有未纠正误区 → 下次复习不晚于 3 天后，并必考该误区。
- 逾期：超过到期日未复习，`overdueDays` 累加，队列置顶并用 Accent 按钮；保持率按模型继续衰减。

## AI 环节的输入输出

每个环节建议约定结构化的 JSON 输出，前端只渲染字段，不解析自由文本。

| 环节 | 输入 | 输出（用于界面） |
|---|---|---|
| 知识点提取 | 复述三段文本 + 附件解析文本 + 用户历史知识点 | `points: [{ name, summary, status: confirmed_candidate | needs_confirm | conflict, conflictNote? }]`、`topics[]`、`missing: [name]` |
| 追问 | 上述结果 + 已有问答 | `question, type, hint?, knowledgePointIds` |
| 回答评价与补全 | 问题 + 用户回答 | `evaluation: { level, tags[] }, supplement?: { title, content }` |
| 出题 | 知识点状态、误区、到期复习、题量 | `questions: [{ type, stem, options?, answer?, rubric?, sourceReason, knowledgePointIds }]` |
| 简答评分 | 题目、评分标准、回答 | `score, rubricScores[], feedback` |
| 周报 | 本周统计数据 | `summary, strengths, weaknesses, suggestions` |

注意：
- 冲突检测（复述和笔记说法不一致）要引用来源（「笔记第 2 页」），前端显示在知识点行的说明里。
- AI 输出都要存档（便于复盘和申诉），并记录模型和提示词版本（只在后台，界面不显示）。
