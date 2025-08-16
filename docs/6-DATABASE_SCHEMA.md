# **6. Target Database Schema (Drizzle ORM)**

This is the target schema for the TypeScript migration using Drizzle ORM. It is designed to be compatible with the existing PostgreSQL database.
// schema.ts
import {
pgTable,
serial,
text,
boolean,
timestamp,
integer,
decimal,
jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Core Tables

export const communities \= pgTable('communities', {
id: serial('id').primaryKey(),
name: text('name').notNull(),
description: text('description'),
slug: text('slug').unique().notNull(),
public_stories: boolean('public_stories').default(false),
theme_id: integer('theme_id').references(() => themes.id),
created_at: timestamp('created_at').defaultNow(),
updated_at: timestamp('updated_at').defaultNow(),
});

export const users \= pgTable('users', {
id: serial('id').primaryKey(),
email: text('email').unique().notNull(),
encrypted_password: text('encrypted_password').notNull(),
role: text('role').default('viewer').notNull(), // viewer, editor, admin, super_admin
community_id: integer('community_id').references(() => communities.id),
created_at: timestamp('created_at').defaultNow(),
updated_at: timestamp('updated_at').defaultNow(),
});

export const stories \= pgTable('stories', {
id: serial('id').primaryKey(),
title: text('title').notNull(),
description: text('description'),
language: text('language'),
topic: text('topic'),
permission_level: text('permission_level').default('public'), // public, restricted, private
media_urls: jsonb('media_urls'), // To store paths to attached media
community_id: integer('community_id').references(() => communities.id).notNull(),
created_at: timestamp('created_at').defaultNow(),
updated_at: timestamp('updated_at').defaultNow(),
});

export const places \= pgTable('places', {
id: serial('id').primaryKey(),
name: text('name').notNull(),
description: text('description'),
type_of_place: text('type_of_place'),
region: text('region'),
lat: decimal('lat', { precision: 10, scale: 6 }),
long: decimal('long', { precision: 10, scale: 6 }),
photo_url: text('photo_url'),
name_audio_url: text('name_audio_url'),
community_id: integer('community_id').references(() => communities.id).notNull(),
created_at: timestamp('created_at').defaultNow(),
updated_at: timestamp('updated_at').defaultNow(),
});

export const speakers \= pgTable('speakers', {
id: serial('id').primaryKey(),
name: text('name').notNull(),
photo_url: text('photo_url'),
community_id: integer('community_id').references(() => communities.id).notNull(),
created_at: timestamp('created_at').defaultNow(),
updated_at: timestamp('updated_at').defaultNow(),
});

export const themes \= pgTable('themes', {
id: serial('id').primaryKey(),
name: text('name').notNull(),
});

// Join Tables for Many-to-Many Relationships

export const story_places \= pgTable('story_places', {
story_id: integer('story_id').references(() => stories.id).notNull(),
place_id: integer('place_id').references(() => places.id).notNull(),
});

export const story_speakers \= pgTable('story_speakers', {
story_id: integer('story_id').references(() => stories.id).notNull(),
speaker_id: integer('speaker_id').references(() => speakers.id).notNull(),
});

// Drizzle Relations

export const communityRelations \= relations(communities, ({ many }) => ({
stories: many(stories),
places: many(places),
speakers: many(speakers),
users: many(users),
}));

export const storyRelations \= relations(stories, ({ one, many }) => ({
community: one(communities, { fields: \[stories.community_id\], references: \[communities.id\] }),
story_places: many(story_places),
story_speakers: many(story_speakers),
}));

export const placeRelations \= relations(places, ({ one, many }) => ({
community: one(communities, { fields: \[places.community_id\], references: \[communities.id\] }),
story_places: many(story_places),
}));

export const speakerRelations \= relations(speakers, ({ one, many }) => ({
community: one(communities, { fields: \[speakers.community_id\], references: \[communities.id\] }),
story_speakers: many(story_speakers),
}));
