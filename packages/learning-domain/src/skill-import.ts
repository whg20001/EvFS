import { isAlias, isNode, isPair, isScalar, parseDocument, visit } from 'yaml';
import { SKILL_LIMITS, skillDocumentSchema, skillResourcesSchema, type SkillDocument } from '@sanxing/contracts';
import { DomainError } from './policy.ts';

/** Parse data only. No file paths, resource loading, commands or model calls. */
export function parseSkillFile(filename: string, content: string, resources?: unknown): { document: SkillDocument; warnings: string[] } {
  if (filename !== 'SKILL.md') throw new DomainError('SKILL_FILENAME', '请选择名为 SKILL.md 的文件', 400);
  if (new TextEncoder().encode(content).byteLength > SKILL_LIMITS.fileBytes) throw new DomainError('SKILL_TOO_LARGE', 'SKILL.md 不能超过 32 KiB', 413);
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(content)) !== content || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(content)) {
    throw new DomainError('SKILL_ENCODING', '请使用有效的 UTF-8 文本文件', 400);
  }
  const normalized = content.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) throw new DomainError('SKILL_FRONTMATTER', '文件需要以 --- 包围的 YAML 元数据开头，并包含 Markdown 指令正文', 400);
  let fields: Record<string, unknown>;
  try {
    const yaml = parseDocument(match[1]!, { schema: 'core', uniqueKeys: true, strict: true });
    if (yaml.errors.length || yaml.warnings.length) throw new Error('Invalid YAML');
    visit(yaml, (_key, node) => {
      if (isAlias(node) || (isNode(node) && node.tag)) throw new Error('Aliases and tags are not supported');
      if (isPair(node) && isScalar(node.key) && ['__proto__', 'prototype', 'constructor'].includes(String(node.key.value))) throw new Error('Unsafe key');
    });
    const value: unknown = yaml.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected mapping');
    fields = value as Record<string, unknown>;
  } catch {
    throw new DomainError('SKILL_YAML', 'YAML 元数据无效；请检查重复字段、缩进，移除别名和自定义标签', 400);
  }
  const parsed = skillDocumentSchema.safeParse({ name: fields.name, description: fields.description, instructions: match[2]!.trim(),
    ...(fields.license !== undefined ? { license: fields.license } : {}),
    ...(fields.compatibility !== undefined ? { compatibility: fields.compatibility } : {}),
    ...(fields['allowed-tools'] !== undefined ? { allowedTools: fields['allowed-tools'] } : {}),
    ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}), ...(resources !== undefined ? { resources: skillResourcesSchema.parse(resources) } : {}) });
  if (!parsed.success) throw new DomainError('SKILL_INVALID', '请检查 name（最多 64 位小写字母、数字及单连字符）、description（1–1024 字）和指令正文（1–16000 字）；metadata 的值必须为字符串', 400);
  const warnings: string[] = [];
  if (parsed.data.allowedTools) warnings.push('allowed-tools 仅保留为文件信息，不授予工具或脚本执行权限。');
  if (parsed.data.compatibility) warnings.push('此文件声明了环境要求，请核对其指令是否适用于当前学习任务。');
  if (Object.keys(fields).some(key => !['name', 'description', 'license', 'compatibility', 'allowed-tools', 'metadata'].includes(key))) warnings.push('非标准元数据字段未导入。');
  return { document: parsed.data, warnings };
}
