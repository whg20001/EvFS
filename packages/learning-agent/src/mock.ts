import type { AiOutput, AiTask, CodeExercise, CodeLanguage, GeneratedQuestion } from '@sanxing/contracts';

const clip = (text: string, size: number) => text.trim().slice(0, size);
function citedSourceIds(text: string, sources: { id: string; text: string }[]): string[] {
  const matched = sources.filter(source => source.text.includes(text)).map(source => source.id);
  if (matched.length) return matched.slice(0, 10);
  const fallback = sources.find(source => source.id.startsWith('recitation:')) ?? sources[0];
  return fallback ? [fallback.id] : [];
}

/** A runnable scaffold whose tests fail until the TODO is implemented. */
const demoCode: Record<CodeLanguage, { exercise: CodeExercise; reference: string }> = {
  python: { exercise: { language: 'python', starter: [
    '# 演示代码题（脚本演示，不是 AI 生成）',
    '# 目标：实现 count_mentions(text, keyword)，返回 keyword 在 text 中不重叠出现的次数。',
    '# 输入：text 为字符串，keyword 为非空字符串；输出：整数。',
    '# 边界：keyword 不出现时返回 0。',
    'def count_mentions(text, keyword):',
    '    # TODO: 统计 keyword 的出现次数',
    '    raise NotImplementedError',
    '',
  ].join('\n'), tests: [
    { name: '重复出现', code: 'assert count_mentions("abcabc", "abc") == 2' },
    { name: '未出现', code: 'assert count_mentions("xyz", "a") == 0' },
  ] }, reference: 'def count_mentions(text, keyword):\n    return text.count(keyword)' },
  javascript: { exercise: { language: 'javascript', starter: [
    '// 演示代码题（脚本演示，不是 AI 生成）',
    '// 目标：实现 countMentions(text, keyword)，返回 keyword 在 text 中不重叠出现的次数。',
    '// 输入：text 为字符串，keyword 为非空字符串；输出：整数。',
    '// 边界：keyword 不出现时返回 0。',
    'function countMentions(text, keyword) {',
    '  // TODO: 统计 keyword 的出现次数',
    "  throw new Error('TODO');",
    '}',
    '',
  ].join('\n'), tests: [
    { name: '重复出现', code: "assertEqual(countMentions('abcabc', 'abc'), 2);" },
    { name: '未出现', code: "assertEqual(countMentions('xyz', 'a'), 0);" },
  ] }, reference: 'function countMentions(text, keyword) {\n  return text.split(keyword).length - 1;\n}' },
  typescript: { exercise: { language: 'typescript', starter: [
    '// 演示代码题（脚本演示，不是 AI 生成）',
    '// 目标：实现 countMentions(text, keyword)，返回 keyword 在 text 中不重叠出现的次数。',
    '// 输入：text 为字符串，keyword 为非空字符串；输出：整数。',
    '// 步骤：按 keyword 切分，再统计不重叠出现次数；边界：未出现时返回 0。',
    'function countMentions(text: string, keyword: string): number {',
    '  // TODO: 统计 keyword 的出现次数',
    "  throw new Error('TODO');",
    '}',
    '',
  ].join('\n'), tests: [
    { name: '重复出现', code: "assertEqual(countMentions('abcabc', 'abc'), 2);" },
    { name: '未出现', code: "assertEqual(countMentions('xyz', 'a'), 0);" },
  ] }, reference: 'function countMentions(text: string, keyword: string): number {\n  return text.split(keyword).length - 1;\n}' },
};

/** Deterministic demonstration, not a knowledge model or scientific assessment. */
export function scriptOutput(task: AiTask): AiOutput {
  switch (task.kind) {
    // Offline fixture only; this does not establish real provider connectivity.
    case 'connection_test': return { kind: 'connection_test', ok: true };
    case 'extract': {
      const learned = task.recitation.learned.trim();
      const fragments = learned.split(/[。！？\n]+/u).map(s => s.trim()).filter(Boolean);
      const inputs = fragments.length ? fragments.slice(0, 5) : [task.recitation.topic || task.sources[0]?.text || '待确认的学习范围'];
      return { kind: 'extract', candidates: inputs.map(text => {
        const sourceIds = citedSourceIds(text, task.sources);
        const caveat = sourceIds.some(id => id.startsWith('recitation:')) ? '；用户复述引用，不是外部验证。' : '';
        return { title: clip(text, 100), description: `演示候选（待确认）：${clip(text, 1600)}${caveat}`, sourceIds };
      }) };
    }
    case 'followup': {
      const point = task.points[task.turns.length % task.points.length]!;
      const lastAnswer = task.turns.at(-1)?.answer;
      return { kind: 'followup',
        question: `演示追问 ${task.turns.length + 1}：请用一个具体例子说明「${clip(point.title, 150)}」${task.turns.length % 2 ? '的适用边界' : '如何应用'}？`,
        feedback: lastAnswer ? `已记录你的回答「${clip(lastAnswer, 500)}」。演示不判定掌握程度。` : '先独立回忆；此为脚本演示，不是科学评分。',
      };
    }
    case 'quiz': {
      const questions: GeneratedQuestion[] = Array.from({ length: task.count }, (_, index) => {
        const point = task.points[index % task.points.length]!;
        const language = index === task.count - 1 ? task.code?.languages[0] : undefined;
        if (language) {
          const { exercise, reference } = demoCode[language];
          return { knowledgeId: point.id, kind: 'code', prompt: `演示代码题 ${index + 1}：按骨架注释完成函数，并运行测试（与「${clip(point.title, 150)}」的关联仅为演示）。`,
            options: [], correctIndex: null, referenceAnswer: reference, code: structuredClone(exercise),
            rubric: [{ id: `r${index + 1}`, description: '实现满足注释要求并处理未出现的边界；需人工核对。', maxScore: 2 }],
            sourceIds: point.sourceIds.filter(id => task.sources.some(source => source.id === id)).slice(0, 10) };
        }
        const single = index % 2 === 0;
        const reference = clip(point.description, 450) || point.title;
        return { knowledgeId: point.id, kind: single ? 'single' : 'short',
          prompt: single ? `演示题 ${index + 1}：哪一项对应你确认的「${clip(point.title, 150)}」？` : `演示题 ${index + 1}：请独立解释「${clip(point.title, 150)}」并给出一个应用例子。`,
          options: single ? [reference, `演示干扰项：忽略「${clip(point.title, 100)}」的条件即可用于所有情况。`] : [],
          correctIndex: single ? 0 : null, referenceAnswer: reference,
          rubric: [{ id: `r${index + 1}`, description: '依据确认的描述解释核心概念；需人工核对。', maxScore: 2 }],
          sourceIds: point.sourceIds.filter(id => task.sources.some(source => source.id === id)).slice(0, 10),
        };
      });
      return { kind: 'quiz', questions };
    }
    case 'grade': return { kind: 'grade', status: 'needs_verification', scores: [],
      feedback: `已收到回答「${clip(task.answer, 1000)}」。这是脚本演示，不是科学评分；请按固定参考答案与评分细则人工核对，未知不计零分。`,
    };
  }
}
