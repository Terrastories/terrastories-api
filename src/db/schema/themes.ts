/**
 * Themes table schema with multi-database support and Rails compatibility
 *
 * Supports both PostgreSQL (production) and SQLite (development/testing)
 * Implements exact Rails schema with 14 fields for map visualization themes
 *
 * Features:
 * - Complete Rails THEMES table compatibility
 * - Multi-tenant data isolation via communityId
 * - Geographic boundary coordinates for map visualization
 * - Mapbox integration with style URLs and access tokens
 * - Cross-database compatibility (PostgreSQL/SQLite)
 * - Cultural protocol support for Indigenous communities
 */

import {
  pgTable,
  serial,
  text as pgText,
  boolean,
  timestamp,
  decimal,
  bigint,
  index,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  integer,
  text as sqliteText,
  real,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import { communitiesPg, communitiesSqlite } from './communities.js';

// Geographic boundary validation schema
export const GeographicBoundsSchema = z
  .object({
    centerLat: z.number().min(-90).max(90),
    centerLong: z.number().min(-180).max(180),
    swBoundaryLat: z.number().min(-90).max(90),
    swBoundaryLong: z.number().min(-180).max(180),
    neBoundaryLat: z.number().min(-90).max(90),
    neBoundaryLong: z.number().min(-180).max(180),
  })
  .refine((data) => data.swBoundaryLat <= data.neBoundaryLat, {
    message:
      'Southwest boundary latitude must be less than or equal to northeast boundary latitude',
    path: ['swBoundaryLat'],
  })
  .refine((data) => data.swBoundaryLong <= data.neBoundaryLong, {
    message:
      'Southwest boundary longitude must be less than or equal to northeast boundary longitude',
    path: ['swBoundaryLong'],
  });

// Mapbox URL validation
export const MapboxStyleUrlSchema = z
  .string()
  .url()
  .regex(/^mapbox:\/\/styles\//, {
    message: 'Must be a valid Mapbox style URL starting with mapbox://styles/',
  })
  .optional()
  .or(z.literal(''));

// PostgreSQL table for production
export const themesPg = pgTable(
  'themes',
  {
    id: serial('id').primaryKey(),
    name: pgText('name').notNull(),
    description: pgText('description'),
    mapboxStyleUrl: pgText('mapbox_style_url'),
    mapboxAccessToken: pgText('mapbox_access_token'),
    centerLat: decimal('center_lat', { precision: 10, scale: 6 }),
    centerLong: decimal('center_long', { precision: 10, scale: 6 }),
    swBoundaryLat: decimal('sw_boundary_lat', { precision: 10, scale: 6 }),
    swBoundaryLong: decimal('sw_boundary_long', { precision: 10, scale: 6 }),
    neBoundaryLat: decimal('ne_boundary_lat', { precision: 10, scale: 6 }),
    neBoundaryLong: decimal('ne_boundary_long', { precision: 10, scale: 6 }),
    active: boolean('active').notNull().default(false),
    communityId: bigint('community_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    communityIdIdx: index('idx_themes_community_id').on(table.communityId),
    activeIdx: index('idx_themes_active').on(table.active),
    nameIdx: index('idx_themes_name').on(table.name),
    communityActiveIdx: index('idx_themes_community_active').on(
      table.communityId,
      table.active
    ),
  })
);

// SQLite table for development/testing
export const themesSqlite = sqliteTable('themes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: sqliteText('name').notNull(),
  description: sqliteText('description'),
  mapboxStyleUrl: sqliteText('mapbox_style_url'),
  mapboxAccessToken: sqliteText('mapbox_access_token'),
  centerLat: real('center_lat'),
  centerLong: real('center_long'),
  swBoundaryLat: real('sw_boundary_lat'),
  swBoundaryLong: real('sw_boundary_long'),
  neBoundaryLat: real('ne_boundary_lat'),
  neBoundaryLong: real('ne_boundary_long'),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
  communityId: integer('community_id')
    .notNull()
    .references(() => communitiesSqlite.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Relations for PostgreSQL
export const themesPgRelations = relations(themesPg, ({ one }) => ({
  community: one(communitiesPg, {
    fields: [themesPg.communityId],
    references: [communitiesPg.id],
  }),
}));

// Relations for SQLite
export const themesSqliteRelations = relations(themesSqlite, ({ one }) => ({
  community: one(communitiesSqlite, {
    fields: [themesSqlite.communityId],
    references: [communitiesSqlite.id],
  }),
}));

// Base Zod schemas
export const insertThemePgSchema = createInsertSchema(themesPg, {
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  mapboxStyleUrl: MapboxStyleUrlSchema,
  mapboxAccessToken: z.string().optional(),
  centerLat: z.string().optional(),
  centerLong: z.string().optional(),
  swBoundaryLat: z.string().optional(),
  swBoundaryLong: z.string().optional(),
  neBoundaryLat: z.string().optional(),
  neBoundaryLong: z.string().optional(),
  active: z.boolean().default(false),
  communityId: z.number().positive(),
});

export const insertThemeSqliteSchema = createInsertSchema(themesSqlite, {
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  mapboxStyleUrl: MapboxStyleUrlSchema,
  mapboxAccessToken: z.string().optional(),
  centerLat: z.number().optional(),
  centerLong: z.number().optional(),
  swBoundaryLat: z.number().optional(),
  swBoundaryLong: z.number().optional(),
  neBoundaryLat: z.number().optional(),
  neBoundaryLong: z.number().optional(),
  active: z.boolean().default(false),
  communityId: z.number().positive(),
});

export const selectThemePgSchema = createSelectSchema(themesPg);
export const selectThemeSqliteSchema = createSelectSchema(themesSqlite);

// Enhanced schemas with geographic validation
export const createThemeSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(1000).optional(),
    mapboxStyleUrl: MapboxStyleUrlSchema,
    mapboxAccessToken: z.string().optional(),
    centerLat: z.number().min(-90).max(90).optional(),
    centerLong: z.number().min(-180).max(180).optional(),
    swBoundaryLat: z.number().min(-90).max(90).optional(),
    swBoundaryLong: z.number().min(-180).max(180).optional(),
    neBoundaryLat: z.number().min(-90).max(90).optional(),
    neBoundaryLong: z.number().min(-180).max(180).optional(),
    active: z.boolean().default(false),
    communityId: z.number().positive(),
  })
  .refine(
    (data) => {
      if (data.swBoundaryLat && data.neBoundaryLat) {
        return data.swBoundaryLat <= data.neBoundaryLat;
      }
      return true;
    },
    {
      message:
        'Southwest boundary latitude must be less than or equal to northeast boundary latitude',
      path: ['swBoundaryLat'],
    }
  )
  .refine(
    (data) => {
      if (data.swBoundaryLong && data.neBoundaryLong) {
        return data.swBoundaryLong <= data.neBoundaryLong;
      }
      return true;
    },
    {
      message:
        'Southwest boundary longitude must be less than or equal to northeast boundary longitude',
      path: ['swBoundaryLong'],
    }
  );

export const updateThemeSchema = createThemeSchema
  .partial()
  .omit({ communityId: true });

// TypeScript types - Use SQLite for consistency with current deployment
export type ThemePg = typeof themesPg.$inferSelect;
export type ThemeSqlite = typeof themesSqlite.$inferSelect;
export type NewThemePg = typeof themesPg.$inferInsert;
export type NewThemeSqlite = typeof themesSqlite.$inferInsert;
export type CreateTheme = z.infer<typeof createThemeSchema>;
export type UpdateTheme = z.infer<typeof updateThemeSchema>;

// Consistent types for current SQLite deployment
export type Theme = typeof themesSqlite.$inferSelect;
export type NewTheme = typeof themesSqlite.$inferInsert;

// Export the SQLite table to match the types
export const themes = themesSqlite;
export const themesRelations = themesSqliteRelations;
