import { cloudSkillCatalogSchema, SKILL_LIMITS, type CloudSkillCatalogView, type SkillDocument } from '@sanxing/contracts';
import { DomainError } from '@sanxing/learning-domain';
import { parseSkillFile } from './skill-import.ts';

export type CloudSkillCatalog = { list: () => Promise<CloudSkillCatalogView>; download: (name: string) => Promise<SkillDocument> };
type Options = { skillCatalogUrl?: string; skillCatalogToken?: string };

/** Only the server-configured catalog and files in its own directory are fetched. */
export function createCloudSkillCatalog(options: Options, fetcher: typeof fetch = globalThis.fetch): CloudSkillCatalog {
  const catalogUrl = options.skillCatalogUrl ? new URL(options.skillCatalogUrl) : null;
  const directory = catalogUrl ? new URL('.', catalogUrl).pathname : '';
  async function read(url: URL, limit: number, accept: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetcher(url, { redirect: 'error', signal: controller.signal,
        headers: { Accept: accept, ...(options.skillCatalogToken ? { Authorization: `Bearer ${options.skillCatalogToken}` } : {}) } });
      if (!response.ok || !response.body) throw new DomainError('CLOUD_SKILL_FETCH', '云 Skill 服务器暂时不可用，请稍后刷新。', 502);
      if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new DomainError('CLOUD_SKILL_TOO_LARGE', '云 Skill 响应超过大小限制。', 413); }
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) { await reader.cancel(); throw new DomainError('CLOUD_SKILL_TOO_LARGE', '云 Skill 响应超过大小限制。', 413); }
        chunks.push(value);
      }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { throw new DomainError('CLOUD_SKILL_ENCODING', '云 Skill 服务器返回的内容不是有效 UTF-8 文本。', 502); }
    } catch (cause) {
      if (cause instanceof DomainError) throw cause;
      throw new DomainError('CLOUD_SKILL_FETCH', '无法读取云 Skill，请检查服务器地址或稍后重试。', 502);
    } finally { clearTimeout(timeout); }
  }
  function fileUrl(value: string) {
    let url: URL;
    try { url = new URL(value, catalogUrl!); } catch { throw new DomainError('CLOUD_SKILL_CATALOG', '云 Skill 列表中的下载地址无效。', 502); }
    if (url.origin !== catalogUrl!.origin || url.username || url.password || url.hash || !url.pathname.startsWith(directory)) {
      throw new DomainError('CLOUD_SKILL_CATALOG', '云 Skill 下载地址必须位于目录服务器的同一目录内。', 502);
    }
    return url;
  }
  async function entries() {
    if (!catalogUrl) throw new DomainError('CLOUD_SKILL_UNCONFIGURED', '尚未配置云 Skill 目录。', 503);
    let payload: unknown;
    try { payload = JSON.parse(await read(catalogUrl, 262_144, 'application/json')); }
    catch (cause) { if (cause instanceof DomainError) throw cause; throw new DomainError('CLOUD_SKILL_CATALOG', '云 Skill 列表不是有效的 JSON。', 502); }
    const parsed = cloudSkillCatalogSchema.safeParse(payload);
    if (!parsed.success) throw new DomainError('CLOUD_SKILL_CATALOG', '云 Skill 列表格式无效，请核对目录文件。', 502);
    return parsed.data.skills.map(skill => ({ ...skill, url: fileUrl(skill.url) }));
  }
  return {
    async list() {
      if (!catalogUrl) return { configured: false, source: null, items: [] };
      const items = (await entries()).map(({ url: _url, ...skill }) => skill);
      return { configured: true, source: `${catalogUrl.origin}${catalogUrl.pathname}`, items };
    },
    async download(name) {
      const entry = (await entries()).find(item => item.name === name);
      if (!entry) throw new DomainError('CLOUD_SKILL_NOT_FOUND', '该云 Skill 已从目录移除，请刷新列表。', 404);
      const content = await read(entry.url, SKILL_LIMITS.fileBytes, 'text/markdown, text/plain');
      const { document } = parseSkillFile('SKILL.md', content);
      if (document.name !== entry.name) throw new DomainError('CLOUD_SKILL_NAME', '下载文件的名称与云 Skill 列表不一致，未保存。', 502);
      return document;
    },
  };
}
