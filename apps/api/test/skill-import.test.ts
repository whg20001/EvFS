import { describe, expect, it } from 'vitest';
import { parseSkillFile } from '../src/skill-import.ts';

const file = (header = 'name: explain-examples\ndescription: 用例子说明概念', body = '# 指令\n先解释概念，再给例子。') => `---\n${header}\n---\n${body}`;
describe('SKILL.md parser', () => {
  it('supports BOM, CRLF, block YAML and optional standard fields without executing content', () => {
    const content = file('name: explain-examples\ndescription: >\n  Explain concepts\n  with examples\nlicense: MIT\ncompatibility: Requires Python\nallowed-tools: Bash Read\nmetadata:\n  version: "1.0"\ncustom-option: ignored', '<script>throw new Error("never run")</script>\n```bash\nexit 1\n```');
    const { document, warnings } = parseSkillFile('SKILL.md', '\ufeff' + content.replace(/\n/g, '\r\n'));
    expect(document).toMatchObject({ name: 'explain-examples', description: 'Explain concepts with examples\n', metadata: { version: '1.0' }, allowedTools: 'Bash Read' });
    expect(document.instructions).toContain('<script>');
    expect(warnings).toHaveLength(3);
  });
  it.each([
    ['missing metadata', 'plain text'],
    ['missing description', file('name: test')],
    ['blank body', file(undefined, '  ')],
    ['invalid name', file('name: Bad--Name\ndescription: test')],
    ['duplicate fields', file('name: first\nname: second\ndescription: test')],
    ['alias', file('name: &n test\ndescription: *n')],
    ['custom tag', file('name: test\ndescription: !custom value')],
    ['object description', file('name: test\ndescription: {nested: bad}')],
    ['non-string metadata', file('name: test\ndescription: text\nmetadata:\n  version: 1')],
    ['prototype key', file('name: test\ndescription: text\nmetadata:\n  __proto__: unsafe')],
    ['binary', file(undefined, '\u0000binary')],
    ['invalid unicode', file(undefined, '\ud800')],
    ['oversized body', file(undefined, 'x'.repeat(16001))],
  ])('rejects %s', (_label, content) => { expect(() => parseSkillFile('SKILL.md', content)).toThrow(); });
  it('checks the byte limit and rejects paths and arbitrary filenames', () => {
    expect(() => parseSkillFile('SKILL.md', file(undefined, '汉'.repeat(12000)))).toThrow('32 KiB');
    for (const filename of ['../SKILL.md', '/tmp/SKILL.md', 'skill.zip', 'notes.md']) expect(() => parseSkillFile(filename, file())).toThrow('SKILL.md');
  });
});
