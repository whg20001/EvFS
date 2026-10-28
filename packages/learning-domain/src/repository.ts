import type { AgentRun, AppData, Usage } from '@sanxing/contracts';

export interface StateRepository {
  read(): Promise<AppData>;
  readFields?<K extends keyof AppData>(fields: readonly K[]): Promise<Pick<AppData, K>>;
  hasPendingRuns?(): Promise<boolean>;
  run?(id: string): Promise<AgentRun | undefined>;
  recordRunUsage?(id: string, attempt: number, usage: Usage): Promise<void>;
  transact<T>(fn: (data: AppData) => T | Promise<T>): Promise<T>;
}
