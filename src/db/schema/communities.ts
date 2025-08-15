import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

export const communities = sqliteTable('communities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  slug: text('slug').unique(),
  publicStories: integer('public_stories', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Zod schemas for validation
export const insertCommunitySchema = createInsertSchema(communities);
export const selectCommunitySchema = createSelectSchema(communities);

// TypeScript types
export type Community = typeof communities.$inferSelect;
export type NewCommunity = typeof communities.$inferInsert;
