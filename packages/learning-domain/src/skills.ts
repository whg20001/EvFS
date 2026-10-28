import { randomUUID } from './runtime.ts';
import { z } from 'zod';
import { SKILL_LIMITS, skillDocumentSchema, skillTasksSchema, skillSelectionSchema, skillSnapshotsSchema, type SkillSelection, type AiTask, type AppData, type LearningSkill } from '@sanxing/contracts';
import { DomainError } from './policy.ts';

const version = z.number().int().positive();
const saveInput = z.object({ document: skillDocumentSchema, replace: z.object({ id: z.uuid(), version }).strict().optional() }).strict();
const configureInput = z.object({ version, enabled: z.boolean(), tasks: skillTasksSchema }).strict();

export function getSkill(data: Pick<AppData, 'skills'>, id: string): LearningSkill {
  const skill = data.skills?.find(item => item.id === id);
  if (!skill) throw new DomainError('SKILL_NOT_FOUND', 'Skill 已删除或不存在，请刷新列表', 404);
  return skill;
}
function expectSkillVersion(skill: LearningSkill, expected: number) {
  if (skill.version !== expected) throw new DomainError('SKILL_CHANGED', 'Skill 已被修改，请刷新列表后重新操作', 409);
}

/** Domain commands mutate the caller's transaction draft, never commit independently. */
export function saveSkill(data: AppData, input: unknown, now: Date) {
  const { document, replace } = saveInput.parse(input);
  const skills = data.skills ??= [];
  const existing = replace ? getSkill(data, replace.id) : undefined;
  if (existing) expectSkillVersion(existing, replace!.version);
  if (skills.some(skill => skill.document.name === document.name && skill.id !== existing?.id)) throw new DomainError('SKILL_EXISTS', '同名 Skill 已存在，请重新预览并选择更新', 409);
  if (existing && document.name !== existing.document.name) throw new DomainError('SKILL_NAME_CHANGED', '更新文件的 name 必须与原 Skill 一致', 400);
  if (!existing && skills.length >= SKILL_LIMITS.stored) throw new DomainError('SKILL_LIMIT', '最多保存 20 个 Skill，请先删除不再使用的项目', 400);
  const stamp = now.toISOString();
  const skill: LearningSkill = { id: existing?.id ?? randomUUID(), version: (existing?.version ?? 0) + 1, document,
    enabled: false, tasks: existing?.tasks ?? ['followup', 'quiz'], createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
  if (existing) skills[skills.indexOf(existing)] = skill; else skills.push(skill);
  return { id: skill.id, version: skill.version };
}
export function configureSkill(data: AppData, id: string, input: unknown, now: Date) {
  const body = configureInput.parse(input);
  const skill = getSkill(data, id); expectSkillVersion(skill, body.version);
  Object.assign(skill, { enabled: body.enabled, tasks: body.tasks, version: skill.version + 1, updatedAt: now.toISOString() });
  return { id, version: skill.version };
}
export function deleteSkill(data: AppData, id: string, input: unknown) {
  const body = z.object({ version }).strict().parse(input);
  expectSkillVersion(getSkill(data, id), body.version);
  data.skills = data.skills!.filter(skill => skill.id !== id);
  return { id };
}

/** An explicit empty snapshot also freezes absence. Never re-read configuration on retry. */
export function bindLearningSkills<T extends AiTask>(data: Pick<AppData, 'skills'>, task: T, selections: SkillSelection = []): T {
  if (task.kind === 'connection_test' || task.skills !== undefined) return task;
  const selected = skillSelectionSchema.parse(selections).map(item => {
    const skill = getSkill(data, item.id); expectSkillVersion(skill, item.version);
    if (!skill.enabled || !skill.tasks.includes(task.kind)) throw new DomainError('SKILL_UNAVAILABLE', '所选 Skill 已停用或不适用于此任务，请刷新选择。', 409);
    return skill;
  });
  const skills = selected
    .sort((a, b) => a.document.name < b.document.name ? -1 : 1)
    .map(({ id, version, document: { name, description, instructions, resources } }) => ({ id, version, name, description, instructions, ...(resources ? { resources } : {}) }));
  if (!skillSnapshotsSchema.safeParse(skills).success) throw new DomainError('SKILL_ACTIVE_LIMIT', '本次最多选择 3 个 Skill，指令和参考文本合计不能超过 24000 字。', 400);
  return { ...task, skills: structuredClone(skills) };
}
