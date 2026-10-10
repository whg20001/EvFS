import type { AgentRun, AppData, DocumentRecord } from '@sanxing/contracts';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Physical schema v3 only. Exported AppData remains schemaVersion 1.
export type StoredData = Omit<AppData, 'documents' | 'runs'> & {
  documents: Record<string, Omit<DocumentRecord, 'text' | 'originalBase64'>>;
  runs: Record<string, Omit<AgentRun, 'task'>>;
};

export const aggregate = pgTable('app_aggregate', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  data: jsonb('data').$type<StoredData>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const documents = pgTable('app_documents', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  originalBase64: text('original_base64').notNull(),
});

// Model inputs can be up to the model budget each; written once, never with every aggregate update.
export const runTasks = pgTable('app_run_tasks', {
  id: text('id').primaryKey(),
  task: jsonb('task').$type<AgentRun['task']>().notNull(),
});
