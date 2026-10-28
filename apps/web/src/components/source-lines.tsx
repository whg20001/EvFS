'use client';

import { memo } from 'react';

export const SourceLines = memo(function SourceLines({ text, headingLines, startLine = 1 }: { text: string; headingLines?: ReadonlySet<number>; startLine?: number }) {
  return <div className="source-lines">{text.split('\n').map((line, index) => <div key={index} data-source-line={headingLines?.has(index + startLine) ? index + startLine : undefined} tabIndex={headingLines?.has(index + startLine) ? -1 : undefined}><span aria-label={`第 ${index + startLine} 行`}>{index + startLine}</span><pre>{line || ' '}</pre></div>)}</div>;
});
