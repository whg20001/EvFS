'use client';

import { LIMITS, type KnowledgePoint } from '@sanxing/contracts';
import { useApp, useDraft } from './store';
import { Action, Card, SaveState } from './ui';
import { useConfirm } from './confirm';

export function KnowledgeEditor({ point }: { point: KnowledgePoint }) {
  const { command, busy, authenticated } = useApp();
  const confirm = useConfirm();
  // Edits are cached immediately; content versions are created only by explicit saves.
  const draft = useDraft({ title: point.title, description: point.description, tags: (point.tags ?? []).join(', ') }, point.version, async (value, version) => {
    const { result } = await command(`/knowledge-points/${point.id}/content`, { version, title: value.title, description: value.description, tags: value.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }, 'PUT');
    return result.version!;
  }, false, `knowledge:${point.id}`);
  async function save() {
    const snapshot = draft.value; const version = draft.version();
    if (!await confirm({ title: '保存知识内容', message: '名称或描述修改会保存为新内容版本；原题和历史证据仍引用当时版本。', confirmLabel: '保存修改' })) return;
    const { result } = await command(`/knowledge-points/${point.id}/content`, { version, title: snapshot.title, description: snapshot.description, tags: snapshot.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }, 'PUT');
    draft.accept(result.version!, snapshot);
  }
  return <Card title="管理知识点" caption="归档后退出日常搜索、联想和复习队列，历史记录及来源仍然保留。">
    <details><summary>编辑名称、描述与标签</summary><div className="stack compact" data-unsaved={draft.status !== 'saved'}><label className="field-label">知识名称<input maxLength={LIMITS.knowledgeTitleChars} value={draft.value.title} onChange={event => draft.change({ ...draft.value, title: event.target.value })} /></label><label className="field-label">知识描述<textarea maxLength={LIMITS.knowledgeDescriptionChars} rows={5} value={draft.value.description} onChange={event => draft.change({ ...draft.value, description: event.target.value })} /></label><label className="field-label">标签（逗号分隔，最多 {LIMITS.knowledgeTagsMaximum} 个）<input value={draft.value.tags} maxLength={LIMITS.knowledgeTagsMaximum * (LIMITS.knowledgeTagChars + 2)} onChange={event => draft.change({ ...draft.value, tags: event.target.value })} /></label><SaveState status={draft.status} reset={draft.reset} automatic={false} /><Action disabled={busy || !authenticated || !draft.value.title.trim() || !draft.value.description.trim()} onClick={save}>保存知识内容</Action></div></details>
    <Action disabled={draft.dirty()} onClick={async () => { if (await confirm({ title: point.archivedAt ? '恢复知识点' : '归档知识点', message: point.archivedAt ? '恢复后重新进入搜索和复习队列，保留原到期时间。' : '归档后保留所有历史，停止新复习及排期推进。可以随时恢复。', confirmLabel: point.archivedAt ? '恢复' : '归档' })) await command(`/knowledge-points/${point.id}/archive`, { version: point.version, archived: !point.archivedAt }, 'PUT'); }}>{point.archivedAt ? '恢复知识点' : '归档知识点'}</Action>
  </Card>;
}
