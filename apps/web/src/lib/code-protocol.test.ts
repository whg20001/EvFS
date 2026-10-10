import { describe, expect, it } from 'vitest';
import { LIMITS } from '@sanxing/contracts';
import { decode, requestSchema, responseSchema } from '../../code-runner/protocol-schema';
import { MESSAGE_CHARS_MAXIMUM, PROTOCOL, runResult, type RunRequest } from '../../code-runner/protocol';

const request: RunRequest = { protocol: PROTOCOL, type: 'run', id: '12345678-1234-4234-8234-123456789abc', text: '', exercise: { language: 'python', starter: '# TODO', tests: [{ name: '测试', code: 'assert True' }] } };
const response = { protocol: PROTOCOL, type: 'result', id: request.id, result: runResult(request, 'passed', '', 1, [{ name: '测试', passed: true }]) };
describe('沙箱协议的 Zod 边界', () => {
  it('保留有界 JSON、UUID、字段过滤和输入大小限制', () => {
    expect(decode(requestSchema, JSON.stringify({ ...request, extra: 'removed' }))).toEqual(request);
    for (const value of [request, null, '{', ' '.repeat(MESSAGE_CHARS_MAXIMUM + 1)]) expect(decode(requestSchema, value)).toBeNull();
    for (const patch of [{ protocol: 'other' }, { type: 'cancel' }, { id: 'not-uuid' }, { text: 1 }, { text: 'x'.repeat(LIMITS.answerChars + 1) }, { exercise: { ...request.exercise, language: 'ruby' } }, { exercise: { ...request.exercise, tests: [] } }]) {
      expect(decode(requestSchema, JSON.stringify({ ...request, ...patch }))).toBeNull();
    }
  });
  it('拒绝无效输出、状态计数矛盾、非整数、日期和超长测试结果', () => {
    expect(decode(responseSchema, JSON.stringify(response))).toEqual(response);
    for (const patch of [{ passed: 0 }, { passed: 2 }, { total: 0 }, { status: 'failed' }, { status: 'unknown' }, { durationMs: -1 }, { durationMs: 1.5 }, { durationMs: LIMITS.codeDurationMsMaximum + 1 }, { ranAt: '2026-02-30T00:00:00Z' }, { ranAt: '2026-10-10T00:00:00+08:00' }, { output: 'x'.repeat(LIMITS.codeOutputChars + 1) }]) {
      expect(decode(responseSchema, JSON.stringify({ ...response, result: { ...response.result, execution: { ...response.result.execution, ...patch } } }))).toBeNull();
    }
    for (const tests of [[{ name: 'x'.repeat(201), passed: true }], [{ name: '测试', passed: 1 }], [{ name: '测试', passed: false, error: 'x'.repeat(501) }], Array(7).fill({ name: '测试', passed: true })]) {
      expect(decode(responseSchema, JSON.stringify({ ...response, result: { ...response.result, tests } }))).toBeNull();
    }
  });
});
