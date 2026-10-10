const formats = { md: 'markdown', markdown: 'markdown', txt: 'text' } as const;
function extensionFormat(name: string) {
  const extension = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(formats, extension) ? formats[extension as keyof typeof formats] : undefined;
}
/** Uploads require an explicit supported suffix; old extensionless documents remain readable. */
export function isDocumentFilename(name: string): boolean { return extensionFormat(name) !== undefined; }
export function documentFormat(name: string): 'markdown' | 'text' { return extensionFormat(name) ?? (name.includes('.') ? 'text' : 'markdown'); }
