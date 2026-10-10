'use client';

import { memo, type ReactNode } from 'react';
import Markdown, { type Components, type Options, type UrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { codeLanguage } from '../lib/code-language';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { sourceLink } from '../lib/source-view';
import { sourceRemarkPlugins } from '../lib/source-outline';
import 'katex/dist/katex.min.css';

const katexOptions = { trust: false, throwOnError: false, maxSize: 10, maxExpand: 1000, strict: 'ignore' as const };
const rehypePlugins: Options['rehypePlugins'] = [[rehypeKatex, katexOptions]];
// Image URLs are passed only to our text placeholder, never to a DOM resource attribute.
const urlTransform: UrlTransform = (url, key) => key === 'src' ? url : sourceLink(url);

function codeTokens(text: string, language: string): ReactNode {
  const parser = codeLanguage(language)?.language.parser;
  if (!parser) return text;
  const tokens: ReactNode[] = [];
  highlightCode(text, parser.parse(text), classHighlighter, (value, classes) => {
    tokens.push(classes ? <span key={tokens.length} className={classes}>{value}</span> : value);
  }, () => tokens.push('\n'));
  return tokens;
}

const components: Components = {
  a: ({ href, children }) => {
    const safe = sourceLink(href);
    return safe ? <a href={safe} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>;
  },
  img: ({ alt, src }) => <span className="source-image">🖼 图片未加载：{alt || '未命名图片'}{typeof src === 'string' && <span className="source-image-url">{src}</span>}</span>,
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled readOnly aria-label={checked ? '已完成任务' : '未完成任务'} />,
  table: ({ children }) => <div className="source-table" role="region" aria-label="笔记表格，可横向滚动" tabIndex={0}><table>{children}</table></div>,
  pre: ({ children, node }) => {
    const code = node?.children[0];
    const classes = code?.type === 'element' ? String(code.properties.className ?? '') : '';
    const language = /(?:^|[\s,])language-([^\s,]+)/.exec(classes)?.[1];
    return <div className="source-code">{language && <div className="source-code-label">{language}</div>}<pre>{children}</pre></div>;
  },
  code: ({ className, children }) => {
    const language = /\blanguage-(\S+)/.exec(className ?? '')?.[1]?.toLowerCase();
    return <code className={className}>{language && typeof children === 'string' ? codeTokens(children, language) : children}</code>;
  },
};

const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'): Components['h1'] => ({ node, ...props }) => node?.position ? <Tag data-source-line={node.position.start.line} tabIndex={-1}>{props.children}</Tag> : <Tag {...props} />;
const outlineComponents: Components = { ...components, h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6') };

// No rehype-raw: raw HTML is escaped by react-markdown and stays visible as text.
export default memo(function SourceMarkdown({ text, outline = false }: { text: string; outline?: boolean }) {
  return <div className="source-markdown"><Markdown remarkPlugins={sourceRemarkPlugins} rehypePlugins={rehypePlugins} components={outline ? outlineComponents : components} urlTransform={urlTransform}>{text}</Markdown></div>;
});
