import { PUBLIC_STATE_COLLECTIONS, type PublicState, type PublicStateUpdate } from '@sanxing/contracts';

/** null requests a fresh baseline; a delta belongs to the exact snapshot sent. */
export function reconcileState(current: PublicState | null, baseline: PublicState | null, response: PublicState | PublicStateUpdate): PublicState | null {
  let next: PublicState;
  if (!('kind' in response)) next = response;
  else if (response.kind === 'snapshot') next = response.state;
  else {
    if (!current || current !== baseline || (response.kind === 'delta' && response.fromRevision !== current.revision)) {
      return current && response.revision <= current.revision ? current : null;
    }
    if (response.kind === 'unchanged') {
      if (response.revision !== current.revision) return null;
      return response.csrfToken === current.csrfToken ? current : { ...current, csrfToken: response.csrfToken };
    }
    if (response.revision <= current.revision) return current;
    next = { ...current, revision: response.revision, csrfToken: response.csrfToken };
    for (const name of PUBLIC_STATE_COLLECTIONS) {
      const change = response.changes[name];
      if (!change) continue;
      const entities = new Map<string, { id: string }>(current[name].map(entity => [entity.id, entity]));
      for (const id of change.remove) entities.delete(id);
      for (const entity of change.upsert) entities.set(entity.id, entity);
      Object.assign(next, { [name]: [...entities.values()] });
    }
  }
  return current && next.revision < current.revision ? current : next;
}
