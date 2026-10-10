import { describe, expect, it } from 'vitest';
import { sourceOutline } from './source-outline';

describe('source outline', () => {
  it('keeps all six ATX depths, closing markers and duplicate titles in source order', () => {
    expect(sourceOutline('# 相同\n## 相同 ##\n### 三\n#### 四\n##### 五\n###### 六\n####### 非标题')).toEqual([
      { depth: 1, text: '相同', line: 1 }, { depth: 2, text: '相同', line: 2 }, { depth: 3, text: '三', line: 3 },
      { depth: 4, text: '四', line: 4 }, { depth: 5, text: '五', line: 5 }, { depth: 6, text: '六', line: 6 },
    ]);
  });
  it('supports Setext headings and multiline text with the starting line', () => {
    expect(sourceOutline('\n一级\n===\n\n多行\n标题\n---')).toEqual([{ depth: 1, text: '一级', line: 2 }, { depth: 2, text: '多行 标题', line: 5 }]);
  });
  it('ignores fenced and indented code, HTML blocks and math blocks', () => {
    const text = ['```md', '# fenced', '```', '', '~~~', '## fenced too', '~~~', '', '    # indented', '', '<div>', '# html', '</div>', '', '<!--', '# comment', '-->', '', '<script>', '# script', '</script>', '', '$$', '# math', '$$', '', '# 标题'].join('\n');
    expect(sourceOutline(text)).toEqual([{ depth: 1, text: '标题', line: 27 }]);
  });
  it('flattens emphasis, links, code, GFM deletion and math without truncating', () => {
    expect(sourceOutline('# **强调** *斜体* [链接](https://example.com) `inline()` ~~旧~~ $a^2 +  \\alpha$')).toEqual([{ depth: 1, text: '强调 斜体 链接 inline() 旧 a^2 +  \\alpha', line: 1 }]);
  });
  it('uses image alt and link reference text, omitting inline HTML and footnote markers', () => {
    expect(sourceOutline('# ![图片](x) [引用][ref] <b>纯文本</b>[^1]\n\n[ref]: https://example.com\n[^1]: 注释')).toEqual([{ depth: 1, text: '图片 引用 纯文本', line: 1 }]);
  });
  it('keeps escaped punctuation and decoded entities', () => {
    expect(sourceOutline('# \\*文字\\* &amp; A')).toEqual([{ depth: 1, text: '*文字* & A', line: 1 }]);
  });
  it('finds headings inside blockquotes and list items', () => {
    expect(sourceOutline('> ## 引用\n\n- ### 列表\n\n  正文')).toEqual([{ depth: 2, text: '引用', line: 1 }, { depth: 3, text: '列表', line: 3 }]);
  });
  it('counts CRLF and blank source lines correctly', () => {
    expect(sourceOutline('正文\r\n\r\n## 二\r\n\r\n三\r\n---\r\n')).toEqual([{ depth: 2, text: '二', line: 3 }, { depth: 2, text: '三', line: 5 }]);
  });
  it('omits unreferenced and duplicate footnote definitions, as GFM rendering does', () => {
    const text = ['正文[^used]', '', '[^unused]:', '    ## 未引用', '', '[^used]:', '    ### 可见', '', '[^USED]:', '    #### 重复定义'].join('\n');
    expect(sourceOutline(text)).toEqual([{ depth: 3, text: '可见', line: 7 }]);
  });
  it('follows references inside used footnotes without looping on cycles', () => {
    const text = ['正文[^a]', '', '[^a]:', '    ## A[^b]', '', '[^b]:', '    ### B[^a]'].join('\n');
    expect(sourceOutline(text)).toEqual([{ depth: 2, text: 'A', line: 4 }, { depth: 3, text: 'B', line: 7 }]);
  });
  it.each(['', '\n \n', '普通正文\n不是标题', '| 列 |\n| --- |\n| # 单元格 |'])('returns no outline for %j', text => expect(sourceOutline(text)).toEqual([]));
  it('retains empty headings and the full length of long titles', () => {
    const long = '长标题'.repeat(300);
    expect(sourceOutline(`#\n\n## ${long}`)).toEqual([{ depth: 1, text: '', line: 1 }, { depth: 2, text: long, line: 3 }]);
  });
  it('handles thousands of headings with stable depth and line mapping', () => {
    const headings = sourceOutline(Array.from({ length: 2000 }, (_, index) => `${'#'.repeat(index % 6 + 1)} 标题 ${index}\n\n正文\n`).join('\n'));
    expect(headings).toHaveLength(2000);
    headings.forEach((heading, index) => expect(heading).toEqual({ depth: index % 6 + 1, text: `标题 ${index}`, line: index * 4 + 1 }));
  });
});
