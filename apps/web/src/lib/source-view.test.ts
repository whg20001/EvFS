import { describe, expect, it } from 'vitest';
import { defaultSourceView, sourceLink } from './source-view';

describe('source view defaults', () => {
  it.each(['笔记.md', 'NOTES.MARKDOWN', '粘贴资料'])('formats %s', name => expect(defaultSourceView(name)).toBe('formatted'));
  it.each(['笔记.txt', 'NOTES.TXT', 'legacy.pdf'])('keeps %s as original lines', name => expect(defaultSourceView(name)).toBe('raw'));
});
describe('source link allowlist', () => {
  it.each(['https://example.com/a?q=1#part', 'http://example.com', 'HTTPS://example.com', 'mailto:reader@example.com'])('allows %s', value => expect(sourceLink(value)).toBe(value));
  it.each([undefined, '', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hello', 'vbscript:msgbox(1)', 'file:///tmp/note', './a.md', '/a.md', '//example.com', '#part', 'https:example.com', 'https://', 'mailto:', ' https://example.com', 'java\nscript:alert(1)', 'https://example.com\u0000', 'https://example.com\\@evil.invalid'])('blocks %s', value => expect(sourceLink(value)).toBeUndefined());
});
