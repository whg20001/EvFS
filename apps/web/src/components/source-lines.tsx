'use client';

import { memo } from 'react';

export const SourceLines = memo(function SourceLines({ text, headingLines }: { text: string; headingLines?: ReadonlySet<number> }) {
  return <div className="source-lines">{text.split('\n').map((line, index) => <div key={index} data-source-line={headingLines?.has(index + 1) ? index + 1 : undefined} tabIndex={headingLines?.has(index + 1) ? -1 : undefined}><span aria-label={`第 ${index + 1} 行`}>{index + 1}</span><pre>{line || ' '}</pre></div>)}</div>;
});
