import type { AiTask, GeneratedQuestion } from '@sanxing/contracts';

export const EVALUATION_VERSION = 'learning-quality-v1';
export interface EvaluationCase {
  id: string;
  topic: string;
  task: AiTask;
  reference: string;
  checks: string[];
  expectedScore?: { min: number; max: number };
}
// Original, synthetic examples. No personal database, documents or credentials are inputs.
const topics = [
  { id: 'cache', title: '空值缓存', note: '对不存在的键也缓存空结果，可以减少重复查询数据库。空结果必须设置有限 TTL；新增数据后若不失效旧空值，可能暂时读不到新数据。', question: '空值缓存解决什么问题，有什么限制？', correct: '缓存不存在键的空结果，减少数据库查询；设置有限 TTL，新增数据时使旧空值失效，避免短期读取不到新数据。', partial: '缓存空结果能减少数据库查询。', checks: ['说明缓存不存在键的空结果', '说明有限 TTL 和新增数据后的失效问题'] },
  { id: 'queue', title: '先进先出队列', note: 'FIFO 队列从队尾入队，从队头出队。依次入队 A、B、C 后，第一次出队得到 A，剩余 B、C。栈是后进先出。', question: 'A、B、C 依次入队后第一次出队是什么？为什么？', correct: '第一次得到 A，因为队列先进先出，从队头取最早入队的元素，剩余 B、C。', partial: '第一次得到 C，因为最后加入的先取出。', checks: ['结果为 A', '理由是先进先出，而非后进先出'] },
  { id: 'search', title: '二分查找', note: '二分查找要求可按比较规则有序访问的数据。每次比较中间元素并排除一半区间，时间复杂度 O(log n)。对无序数组直接使用普通二分查找不能保证正确。', question: '二分查找为什么快，使用前需要什么条件？', correct: '数据需要有序，每次根据中间值的比较排除一半区间，所以查询时间 O(log n)。', partial: '任意无序数组都可以直接二分，因为每次随机去掉一半。', checks: ['明确有序条件', '解释减半与 O(log n)'] },
  { id: 'probability', title: '独立事件乘法规则', note: '当 A、B 独立时，P(A 且 B)=P(A)P(B)。如果 P(A)=0.5、P(B)=0.4，则交集概率为 0.2。不独立时，不能仅凭两个边缘概率相乘。', question: '已知 P(A)=0.5、P(B)=0.4，什么时候交集为 0.2？', correct: 'A 与 B 独立时相乘得到 0.2；没有独立性等条件，不能仅凭这两个边缘概率确定交集。', partial: '任何情况下交集都等于 0.2。', checks: ['明确独立条件', '不把边缘概率乘法推广到任意事件'] },
  { id: 'unique', title: '保持顺序的去重', note: 'JavaScript 的 Set 按插入顺序迭代。对整数数组 [2,1,2,3,1]，展开 new Set 后为 [2,1,3]，原数组不变。', question: '解释 [...new Set([2,1,2,3,1])] 的结果和顺序。', correct: '结果是 [2,1,3]。Set 去掉重复值并保持首次插入顺序，不修改原数组。', partial: '结果是 [1,2,3]，因为 Set 会自动排序。', checks: ['结果为 [2,1,3]', '顺序来自首次插入而不是排序'], language: 'javascript' as const },
  { id: 'mean', title: '算术平均值', note: '非空数值列表的算术平均值为总和除以元素个数。[2,4,9] 的平均值为 5。空列表没有这里定义的平均值，函数应显式拒绝空输入。', question: '如何计算 [2,4,9] 的平均值，空列表应如何处理？', correct: '总和 15 除以个数 3 得到 5。空列表应抛出明确错误，而不是直接除以零或假设均值为零。', partial: '取中间元素 4 就是平均值，空列表返回零。', checks: ['计算总和除以个数得到 5', '明确拒绝空输入'], language: 'python' as const },
];

export const evaluationCases: EvaluationCase[] = topics.flatMap(topic => {
  const source = { id: `source-${topic.id}`, name: `${topic.title}.txt`, text: topic.note };
  const point = { id: `point-${topic.id}`, title: topic.title, description: topic.note, sourceIds: [source.id], knowledgeVersion: 1 };
  const rubric = topic.checks.map((description, index) => ({ id: `r${index + 1}`, description, maxScore: 1 }));
  const question: GeneratedQuestion = { knowledgeId: point.id, kind: 'short', prompt: topic.question, options: [], correctIndex: null, referenceAnswer: topic.correct, rubric, sourceIds: [source.id] };
  const base = { topic: topic.title, reference: topic.note };
  return [
    { ...base, id: `${topic.id}-extract`, task: { kind: 'extract', recitation: { learned: topic.correct, unclear: '适用条件是什么？', application: '用一个小例子检验', topic: topic.title }, sources: [source] }, checks: ['仅引用给定来源', '提取结论及适用条件', '不扩展未提供的考核范围'] },
    { ...base, id: `${topic.id}-followup`, task: { kind: 'followup', points: [point], turns: [{ id: 'turn-1', question: topic.question, answer: topic.partial, feedback: null, assisted: false, scopeVersion: 1 }], sources: [source] }, checks: ['针对回答中的遗漏或错误反馈', '一次提出一个可回答的追问', '不把未提及内容直接判为不会'] },
    { ...base, id: `${topic.id}-quiz`, task: { kind: 'quiz', points: [point], sources: [source], count: 2, ...(topic.language ? { code: { languages: [topic.language] } } : {}) }, checks: ['两道题均在给定范围内', '参考答案和评分细则正确', ...(topic.language ? ['检查骨架不泄露答案、测试可执行且预期正确；代码题是否生成单独记录'] : ['题目有明确可判定答案'])] },
    { ...base, id: `${topic.id}-grade-correct`, task: { kind: 'grade', question, answer: topic.correct }, checks: ['完整正确回答应得满分', '每项依据来自答案内容'], expectedScore: { min: 2, max: 2 } },
    { ...base, id: `${topic.id}-grade-incomplete`, task: { kind: 'grade', question, answer: topic.partial }, checks: ['不能给遗漏条件或错误答案满分', '扣分对应原评分细则'], expectedScore: topic.id === 'cache' ? { min: 1, max: 1 } : { min: 0, max: 0 } },
  ] satisfies EvaluationCase[];
});
