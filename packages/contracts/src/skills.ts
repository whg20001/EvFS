import { z } from 'zod';

export const SKILL_LIMITS = { fileBytes: 32_768, instructionsChars: 16_000, stored: 20, active: 3, activeChars: 24_000, archiveBytes: 10 * 1024 * 1024, archiveEntries: 256, expandedBytes: 20 * 1024 * 1024, resourceFiles: 8, resourceChars: 8000 } as const;
export const SKILL_TASKS = ['extract', 'followup', 'quiz', 'grade'] as const;
export type SkillTask = typeof SKILL_TASKS[number];
export const SKILL_TASK_LABELS: Record<SkillTask, string> = { extract: '知识提取', followup: '追问', quiz: '出题', grade: '评分' };
const text = (max: number) => z.string().min(1).max(max).refine(value => !!value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(value));
export const skillResourcesSchema = z.array(z.strictObject({ path: z.string().min(1).max(240).refine(path => !/^[\/\\]|[\\:\u0000-\u001f]/.test(path) && path.split('/').every(part => part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part))), text: text(SKILL_LIMITS.resourceChars) })).max(SKILL_LIMITS.resourceFiles)
  .refine(items => new Set(items.map(item => item.path)).size === items.length && items.reduce((sum, item) => sum + item.text.length, 0) <= SKILL_LIMITS.resourceChars);
export const skillSelectionSchema = z.array(z.strictObject({ id: z.uuid(), version: z.number().int().positive() })).max(SKILL_LIMITS.active).refine(items => new Set(items.map(item => item.id)).size === items.length);
export type SkillSelection = z.infer<typeof skillSelectionSchema>;
export const skillFileInputSchema = z.strictObject({ filename: z.string().max(120), content: z.string().max(SKILL_LIMITS.fileBytes), resources: skillResourcesSchema.optional() });
export const skillDocumentSchema = z.strictObject({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: text(1024), instructions: text(SKILL_LIMITS.instructionsChars),
  license: text(1024).optional(), compatibility: text(500).optional(), allowedTools: text(1024).optional(),
  metadata: z.record(z.string().min(1).max(128).refine(key => !['__proto__', 'constructor', 'prototype'].includes(key)), z.string().max(1024)).refine(value => Object.keys(value).length <= 32).optional(),
  resources: skillResourcesSchema.optional(),
});
export type SkillDocument = z.infer<typeof skillDocumentSchema>;
export const skillTasksSchema = z.array(z.enum(SKILL_TASKS)).min(1).max(SKILL_TASKS.length).refine(value => new Set(value).size === value.length);
export const learningSkillSchema = z.strictObject({
  id: z.uuid(), version: z.number().int().positive(), document: skillDocumentSchema,
  enabled: z.boolean(), tasks: skillTasksSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type LearningSkill = z.infer<typeof learningSkillSchema>;
export type SkillSummary = Omit<LearningSkill, 'document'> & { name: string; description: string; instructionChars: number };
export type SkillPreview = { document: SkillDocument; warnings: string[]; existing: { id: string; version: number } | null };
export const cloudSkillEntrySchema = z.object({
  name: skillDocumentSchema.shape.name,
  description: text(1024),
  url: z.string().min(1).max(2048),
  version: text(64).optional(),
  author: text(128).optional(),
});
export const cloudSkillCatalogSchema = z.object({ skills: z.array(cloudSkillEntrySchema).max(100) })
  .refine(value => new Set(value.skills.map(skill => skill.name)).size === value.skills.length);
export type CloudSkillSummary = Omit<z.infer<typeof cloudSkillEntrySchema>, 'url'>;
export type CloudSkillCatalogView = { configured: boolean; source: string | null; items: CloudSkillSummary[] };
export const skillSnapshotSchema = skillDocumentSchema.pick({ name: true, description: true, instructions: true, resources: true }).extend({ id: z.uuid(), version: z.number().int().positive() });
export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;
export const skillSnapshotsSchema = z.array(skillSnapshotSchema).max(SKILL_LIMITS.active)
  .refine(items => new Set(items.map(item => item.id)).size === items.length && new Set(items.map(item => item.name)).size === items.length)
  .refine(items => items.reduce((total, item) => total + item.instructions.length + (item.resources ?? []).reduce((sum, file) => sum + file.text.length, 0), 0) <= SKILL_LIMITS.activeChars);
export const learningSkillsSchema = z.array(learningSkillSchema).max(SKILL_LIMITS.stored)
  .refine(items => new Set(items.map(item => item.id)).size === items.length && new Set(items.map(item => item.document.name)).size === items.length);

export function summarizeSkill({ document, ...skill }: LearningSkill): SkillSummary {
  return { ...skill, name: document.name, description: document.description, instructionChars: document.instructions.length };
}
