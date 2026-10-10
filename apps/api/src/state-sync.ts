import { createHash } from 'node:crypto';
import { PUBLIC_STATE_COLLECTIONS, type PublicState, type PublicStateChanges, type PublicStateCollection, type PublicStateUpdate } from '@sanxing/contracts';
type Projection = Omit<PublicState, 'csrfToken'>;
type Baseline = { metadata: string; maps: Record<PublicStateCollection, Map<string, string>> };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One public projection, sixteen sets of fingerprints, and no session tokens.
 * Polling is incremental after the MVP's full initial load; this is not pagination.
 * Only already-public entities enter this cache (never the private aggregate).
 */
export class StateSync {
  private current: Projection | undefined;
  private pending: Promise<Projection> | undefined;
  private readonly baselines = new Map<number, Baseline>();
  constructor(private readonly project: () => Promise<PublicState>, private readonly revision?: () => Promise<number>) {}

  private async projection(): Promise<Projection> {
    const revision = await this.revision?.();
    if (this.current && revision === this.current.revision) return this.current;
    if (!this.pending) {
      this.pending = this.project().then(({ csrfToken: _token, ...state }) => {
        // A restore can lower the revision; fingerprints from the old lineage are invalid.
        if (this.current && state.revision < this.current.revision) this.baselines.clear();
        this.current = state;
        const maps = Object.fromEntries(PUBLIC_STATE_COLLECTIONS.map(name => [name, new Map(state[name].map(entity => [entity.id, fingerprint(entity)]))])) as Baseline['maps'];
        this.baselines.set(state.revision, { metadata: fingerprint([state.mode, state.timezone, state.capabilities]), maps });
        while (this.baselines.size > 16) this.baselines.delete(this.baselines.keys().next().value!);
        return state;
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  async get(csrfToken: string): Promise<PublicState>;
  async get(csrfToken: string, since: number): Promise<PublicStateUpdate>;
  async get(csrfToken: string, since?: number): Promise<PublicState | PublicStateUpdate> {
    // Capture before projection: a restart must return a snapshot, even at equal revision.
    const baseline = since === undefined ? undefined : this.baselines.get(since);
    const priorRevision = this.current?.revision;
    const state = await this.projection();
    const snapshot = () => ({ ...state, csrfToken });
    if (since === undefined) return snapshot();
    if (!baseline || (priorRevision !== undefined && state.revision < priorRevision) || since > state.revision || baseline.metadata !== fingerprint([state.mode, state.timezone, state.capabilities])) return { kind: 'snapshot', state: snapshot() };
    if (since === state.revision) return { kind: 'unchanged', revision: state.revision, csrfToken };
    const changes: PublicStateChanges = {};
    for (const name of PUBLIC_STATE_COLLECTIONS) {
      const previous = baseline.maps[name];
      const current = this.baselines.get(state.revision)!.maps[name];
      const upsert = state[name].filter(entity => previous.get(entity.id) !== current.get(entity.id));
      const remove = [...previous.keys()].filter(id => !current.has(id));
      if (upsert.length || remove.length) Object.assign(changes, { [name]: { upsert, remove } });
    }
    return { kind: 'delta', fromRevision: since, revision: state.revision, csrfToken, changes };
  }
}
