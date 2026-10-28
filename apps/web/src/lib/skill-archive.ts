import { proxy, wrap, type Remote } from 'comlink';
import { SKILL_LIMITS, type SkillDocument } from '@sanxing/contracts';

export type SkillImportFile = { filename: string; content: string; resources?: SkillDocument['resources'] };
export type SkillArchiveCandidate = { path: string; file: SkillImportFile; warnings: string[] };
type Entry = { path: string; type: string; size: number; fileName?: string; fileData?: ArrayBuffer };
type ArchiveWorker = { open(file: File, ready: () => void): Promise<void>; listFiles(): Promise<Entry[]>; hasEncryptedData(): Promise<boolean | null>; extractSingleFile(path: string): Promise<Entry> };
const isArchive = (name: string) => /\.(zip|7z|tar|tar\.gz|tgz)$/i.test(name);
export const skillArchiveFilename = isArchive;
export function safeArchivePath(path: string) {
  const normalized = path.replace(/^(\.\/)+/, '').replace(/\/$/, '');
  if (!normalized || normalized.length > 240 || /^[\/\\]|[\\:\u0000-\u001f]/.test(normalized) || normalized.split('/').some(part => !part || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('压缩包包含无效或不安全的文件路径。');
  return normalized;
}
export function validateArchiveEntries(entries: Entry[]) {
  if (entries.length > SKILL_LIMITS.archiveEntries) throw new Error('压缩包最多包含 256 个文件及目录。');
  let expanded = 0; const paths = new Set<string>();
  return entries.flatMap(entry => {
    if (entry.type === 'DIR' && ['.', './'].includes(entry.path)) return [];
    const path = safeArchivePath(entry.path);
    if (!['FILE', 'DIR'].includes(entry.type)) throw new Error('压缩包不能包含符号链接或特殊文件。');
    if (paths.has(path)) throw new Error('压缩包包含重复文件路径。'); paths.add(path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('无法确认压缩包文件大小。');
    expanded += entry.size;
    if (expanded > SKILL_LIMITS.expandedBytes) throw new Error('压缩包展开后不能超过 20 MiB。');
    return entry.type === 'FILE' ? [{ ...entry, normalizedPath: path }] : [];
  });
}
const decode = (bytes: ArrayBuffer) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Skill 指令与参考文本需要使用 UTF-8 编码。'); }
};

/** Local worker only. Flat entry validation happens before extraction; archive paths never become object keys or filesystem paths. */
export async function readSkillImport(file: File, signal: AbortSignal): Promise<SkillArchiveCandidate[]> {
  signal.throwIfAborted();
  if (!isArchive(file.name)) {
    if (file.name !== 'SKILL.md') throw new Error('请选择 SKILL.md，或 ZIP、7Z、TAR、TAR.GZ、TGZ 压缩包。');
    if (file.size > SKILL_LIMITS.fileBytes) throw new Error('SKILL.md 不能超过 32 KiB。');
    const content = decode(await file.arrayBuffer()); signal.throwIfAborted();
    return [{ path: 'SKILL.md', file: { filename: 'SKILL.md', content }, warnings: [] }];
  }
  if (file.size > SKILL_LIMITS.archiveBytes) throw new Error('Skill 压缩包不能超过 10 MiB。');
  const worker = new Worker('/skill-archive/worker-bundle.js', { type: 'module' });
  let rejectStop!: (error: Error) => void;
  const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const abort = () => rejectStop(new Error('已取消 Skill 解包。'));
  const failed = () => rejectStop(new Error('解压程序未能启动或压缩包损坏，请重新选择文件。'));
  const timer = setTimeout(() => rejectStop(new Error('解包超时，请减少压缩包中的文件。')), 30000);
  signal.addEventListener('abort', abort, { once: true }); worker.addEventListener('error', failed);
  try {
    return await Promise.race([stop, (async () => {
      let ready!: () => void; const initialized = new Promise<void>(resolve => { ready = resolve; });
      const Client = wrap<new (ready: () => void) => ArchiveWorker>(worker);
      const client: Remote<ArchiveWorker> = await new Client(proxy(ready)); await initialized;
      await new Promise<void>((resolve, reject) => { void client.open(file, proxy(resolve)).catch(reject); });
      if (await client.hasEncryptedData()) throw new Error('暂不支持加密压缩包，请移除密码后导入。');
      const entries = validateArchiveEntries(await client.listFiles());
      const skills = entries.filter(entry => entry.normalizedPath.split('/').at(-1) === 'SKILL.md' && !entry.normalizedPath.startsWith('__MACOSX/'));
      if (!skills.length) throw new Error('压缩包内未找到 SKILL.md。');
      if (skills.length > SKILL_LIMITS.stored) throw new Error('压缩包最多包含 20 个 Skill。');
      const candidates: SkillArchiveCandidate[] = [];
      const extract = async (entry: Entry, limit: number) => {
        if (entry.size > limit) throw new Error('文件超过 Skill 导入上限。');
        const value = await client.extractSingleFile(entry.path);
        if (!value?.fileData || value.fileData.byteLength > limit || value.fileData.byteLength !== entry.size) throw new Error('解压结果与文件大小不一致，或文件超过导入上限。');
        return decode(value.fileData);
      };
      for (const skill of skills) {
        signal.throwIfAborted();
        const content = await extract(skill, SKILL_LIMITS.fileBytes); const root = skill.normalizedPath.slice(0, -'SKILL.md'.length);
        const resources: NonNullable<SkillDocument['resources']> = []; const warnings: string[] = []; let chars = 0;
        const attachments = entries.filter(entry => {
          if (entry === skill || !entry.normalizedPath.startsWith(root)) return false;
          const owner = skills.filter(candidate => entry.normalizedPath.startsWith(candidate.normalizedPath.slice(0, -'SKILL.md'.length)))
            .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)[0];
          return owner === skill;
        });
        for (const entry of attachments) {
          const path = entry.normalizedPath.slice(root.length);
          if (!/\.(md|txt|json|ya?ml|csv)$/i.test(path) || /(^|\/)\./.test(path)) { warnings.push(`未导入附带文件：${path}`); continue; }
          if (resources.length >= SKILL_LIMITS.resourceFiles || entry.size > SKILL_LIMITS.resourceChars * 4) { warnings.push(`参考文本超出上限，未导入：${path}`); continue; }
          const text = await extract(entry, SKILL_LIMITS.resourceChars * 4);
          if (!text.trim()) continue;
          if (chars + text.length > SKILL_LIMITS.resourceChars) { warnings.push(`参考文本超出上限，未导入：${path}`); continue; }
          chars += text.length; resources.push({ path, text });
        }
        candidates.push({ path: skill.normalizedPath, file: { filename: 'SKILL.md', content, ...(resources.length ? { resources } : {}) }, warnings });
      }
      return candidates;
    })()]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.removeEventListener('error', failed); worker.terminate(); }
}
