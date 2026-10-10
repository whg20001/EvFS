import { documentFormat } from '@sanxing/contracts';

export type SourceView = 'formatted' | 'raw';

export function defaultSourceView(name: string): SourceView {
  return documentFormat(name) === 'markdown' ? 'formatted' : 'raw';
}

/** Only explicit web/mail links; never let the browser resolve a relative or disguised URL. */
export function sourceLink(url: string | undefined): string | undefined {
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url) || !/^(https?:\/\/|mailto:)/i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'mailto:' ? Boolean(parsed.pathname) : Boolean(parsed.hostname)) return url;
  } catch { /* Invalid links remain readable text. */ }
  return undefined;
}
