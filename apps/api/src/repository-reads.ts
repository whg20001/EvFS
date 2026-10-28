import type { AppData } from '@sanxing/contracts';
import type { Repository } from '@sanxing/database';
import { requireThat } from '@sanxing/learning-domain';

/** Adapters without optimized reads retain the same detached-result semantics. */
export async function readFields<K extends keyof AppData>(repository: Pick<Repository, 'read' | 'readFields'>, fields: readonly K[]): Promise<Pick<AppData, K>> {
  const selected = [...fields];
  if (repository.readFields) return repository.readFields(selected);
  const data = await repository.read();
  return Object.fromEntries(selected.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])) as Pick<AppData, K>;
}

export async function readEntity<K extends 'documents' | 'quizzes'>(repository: Pick<Repository, 'read' | 'readEntity'>, collection: K, id: string): Promise<AppData[K][string]> {
  const value = repository.readEntity ? await repository.readEntity(collection, id) : await repository.read().then(data => Object.hasOwn(data[collection], id) ? data[collection][id] : undefined);
  requireThat(value !== undefined, 'NOT_FOUND', '记录不存在或不可访问', 404);
  return value as AppData[K][string];
}
