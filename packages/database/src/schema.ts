import type { AgentRun, AppData, DocumentRecord } from '@sanxing/contracts';
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Physical schema v4 only. Exported AppData remains schemaVersion 1.
export type StoredData = Omit<AppData, 'documents' | 'runs' | 'quizzes' | 'evidence'> & {
  quizzes: Record<string, { id: string }>;
  evidence: Record<string, { id: string }>;
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

// Fast-growing assessment payloads are updated per record; the aggregate retains identity indexes.
export const learningRecords = pgTable('app_learning_records', {
  kind: text('kind').$type<'quizzes' | 'evidence'>().notNull(),
  id: text('id').notNull(),
  value: jsonb('value').$type<AppData['quizzes'][string] | AppData['evidence'][string]>().notNull(),
}, table => [primaryKey({ columns: [table.kind, table.id] })]);
