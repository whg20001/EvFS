'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { LIMITS, type CodeExercise, type CodeExecution } from '@sanxing/contracts';
import type { RunResult } from '../../code-runner/protocol';
import { sharedCodeRunner, type CodeRunner } from '../lib/code-runner';
import { Action } from './ui';
import { useConfirm } from './confirm';

const CodeEditor = dynamic(() => import('./code-editor'), { ssr: false, loading: () => <p role="status">正在加载代码编辑器…</p> });
export const languageLabels = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript' };
const executionLabels = { passed: '测试通过', failed: '测试未通过', error: '运行出错', timeout: '运行超时' };
export function ExecutionSummary({ execution }: { execution: CodeExecution }) {
  return <div className="code-output"><p>{executionLabels[execution.status]} · {execution.passed} / {execution.total} · {execution.durationMs} ms</p><p className="small muted">浏览器上报的辅助证据，最终评价以评分细则为准。</p><pre>{execution.output || '（无输出）'}</pre></div>;
}
export function CodeExerciseEditor({ exercise, value, disabled, onChange, onExecution }: { exercise: CodeExercise; value: string; disabled: boolean; onChange: (value: string) => void; onExecution: (execution?: CodeExecution) => void }) {
  const confirm = useConfirm();
  const runner = useRef<CodeRunner | null>(null);
  const generation = useRef(0);
  const latest = useRef(onExecution); latest.current = onExecution;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  useEffect(() => { runner.current = sharedCodeRunner(); return () => { generation.current++; runner.current?.cancel(); }; }, []);
  useEffect(() => { generation.current++; runner.current?.cancel(); setRunning(false); setResult(null); latest.current(undefined); }, [value, exercise.language]);
  async function run() {
    const current = ++generation.current;
    setRunning(true); setResult(null); onExecution(undefined);
    try {
      const next = await runner.current!.run(value, exercise);
      if (current === generation.current && next) { setResult(next); onExecution(next.execution); }
    } finally { if (current === generation.current) setRunning(false); }
  }
  return <div className="code-workspace stack compact">
    <p className="small muted">代码仅在浏览器沙箱执行。Python 首次加载较慢；运行限时 10 秒。{exercise.language === 'typescript' && 'TypeScript 仅去除类型标注，不做类型检查。'}</p>
    <CodeEditor language={exercise.language} value={value} disabled={disabled} onChange={onChange} />
    <div className="row between wrap"><span className="small muted">{value.length} / {LIMITS.answerChars} 字符 · Tab 可离开编辑器</span><div className="row wrap"><Action disabled={disabled || running} onClick={run}>{running ? '正在运行…' : '运行测试'}</Action><Action disabled={disabled} onClick={async () => {
      if (await confirm({ title: '重置为骨架', message: '这会替换当前代码并清除运行结果。是否继续？', confirmLabel: '重置', tone: 'danger' })) onChange(exercise.starter);
    }}>重置为骨架</Action></div></div>
    <div className="code-tests"><h3>可见测试</h3>{exercise.tests.map((test, index) => <details key={index}><summary>{test.name} · {result?.tests[index] ? result.tests[index].passed ? '通过' : '失败' : '待运行'}</summary><pre className="code-block">{test.code}</pre>{result?.tests[index]?.error && <p className="danger-text">{result.tests[index].error}</p>}</details>)}</div>
    <div aria-live="polite">{running ? <p role="status">正在准备运行时或执行代码…</p> : result ? <ExecutionSummary execution={result.execution} /> : <p className="small muted">尚无运行结果。可运行测试，也可直接正式提交。</p>}</div>
  </div>;
}
