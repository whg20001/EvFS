import { expect, it } from 'vitest';
import { safeArchivePath, validateArchiveEntries } from './skill-archive';

it('validates flat archive names before they can be interpreted as objects or resources', () => {
  expect(safeArchivePath('./examples/SKILL.md')).toBe('examples/SKILL.md');
  for (const path of ['../SKILL.md', 'foo/../../SKILL.md', '/SKILL.md', 'C:/SKILL.md', 'a\\SKILL.md', '__proto__/SKILL.md', 'constructor/prototype/SKILL.md', 'a//SKILL.md']) expect(() => safeArchivePath(path)).toThrow();
});
it('rejects links, duplicate entries, invalid sizes and expanded archive bombs before decompression', () => {
  const file = { path: 'example/SKILL.md', type: 'FILE', size: 100 };
  expect(validateArchiveEntries([file])).toMatchObject([{ normalizedPath: file.path, size: 100 }]);
  for (const entries of [[file, file], [{ ...file, type: 'SYMBOLIC_LINK' }], [{ ...file, size: -1 }], [{ ...file, size: 21 * 1024 * 1024 }], Array.from({ length: 257 }, (_, i) => ({ ...file, path: String(i) }))]) expect(() => validateArchiveEntries(entries)).toThrow();
});
