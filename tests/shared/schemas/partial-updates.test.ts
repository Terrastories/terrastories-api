/**
 * Partial-update schema tests
 *
 * Every update schema must accept an empty payload as a no-op update without
 * injecting create-time defaults, and must retain explicit values that are the
 * opposite of those create defaults. The db files update schema is the one
 * exception on emptiness: it requires a UUID id.
 */
import { describe, expect, it } from 'vitest';
import { updateThemeSchema as updateThemeDbSchema } from '../../../src/db/schema/themes.js';
import { updateStorySchema as updateStoryDbSchema } from '../../../src/db/schema/stories.js';
import { updatePlaceSchema as updatePlaceDbSchema } from '../../../src/db/schema/places.js';
import { updateSpeakerSchema as updateSpeakerDbSchema } from '../../../src/db/schema/speakers.js';
import { updateUserSchema as updateUserDbSchema } from '../../../src/db/schema/users.js';
import { updateCommunitySchema as updateCommunityDbSchema } from '../../../src/db/schema/communities.js';
import { updateFileSchema } from '../../../src/db/schema/files.js';
import { StoryUpdateInputSchema } from '../../../src/shared/schemas/stories.js';
import { updateCommunitySchema as updateCommunitySharedSchema } from '../../../src/shared/schemas/communities.js';
import {
  updateCommunitySchema as updateCommunitySuperAdminSchema,
  updateUserSchema as updateUserSuperAdminSchema,
} from '../../../src/shared/schemas/super-admin.js';

type ParseableSchema = { parse: (data: unknown) => unknown };

const fileId = '123e4567-e89b-42d3-a456-426614174000';

const emptyPayloadSchemas: Array<[string, ParseableSchema]> = [
  ['db themes updateThemeSchema', updateThemeDbSchema],
  ['db stories updateStorySchema', updateStoryDbSchema],
  ['db places updatePlaceSchema', updatePlaceDbSchema],
  ['db speakers updateSpeakerSchema', updateSpeakerDbSchema],
  ['db users updateUserSchema', updateUserDbSchema],
  ['db communities updateCommunitySchema', updateCommunityDbSchema],
  ['shared stories StoryUpdateInputSchema', StoryUpdateInputSchema],
  ['shared communities updateCommunitySchema', updateCommunitySharedSchema],
  ['super-admin updateCommunitySchema', updateCommunitySuperAdminSchema],
  ['super-admin updateUserSchema', updateUserSuperAdminSchema],
];

// Each payload carries explicit values opposite the corresponding create
// schema defaults (role viewer -> admin, isActive true -> false, language en
// -> pt, active false -> true, publicStories false -> true, locale en -> pt,
// beta false -> true, empty tags -> non-empty, empty mediaUrls -> valid URL).
const explicitValueCases: Array<
  [string, ParseableSchema, Record<string, unknown>]
> = [
  ['db themes updateThemeSchema', updateThemeDbSchema, { active: true }],
  [
    'db stories updateStorySchema',
    updateStoryDbSchema,
    {
      language: 'pt',
      tags: ['oral-history'],
      mediaUrls: ['https://example.com/story.mp3'],
      isRestricted: true,
    },
  ],
  [
    'db places updatePlaceSchema',
    updatePlaceDbSchema,
    {
      mediaUrls: ['https://example.com/place.jpg'],
      isRestricted: true,
    },
  ],
  [
    'db speakers updateSpeakerSchema',
    updateSpeakerDbSchema,
    { isActive: false },
  ],
  [
    'db users updateUserSchema',
    updateUserDbSchema,
    { role: 'admin', isActive: false },
  ],
  [
    'db communities updateCommunitySchema',
    updateCommunityDbSchema,
    { publicStories: true, locale: 'pt', isActive: false },
  ],
  [
    'db files updateFileSchema',
    updateFileSchema,
    { id: fileId, isActive: false },
  ],
  [
    'shared stories StoryUpdateInputSchema',
    StoryUpdateInputSchema,
    {
      language: 'pt',
      tags: ['oral-history'],
      mediaUrls: ['https://example.com/story.mp3'],
    },
  ],
  [
    'shared communities updateCommunitySchema',
    updateCommunitySharedSchema,
    { locale: 'pt', publicStories: true, beta: true, isActive: false },
  ],
  [
    'super-admin updateCommunitySchema',
    updateCommunitySuperAdminSchema,
    { locale: 'pt', publicStories: true, beta: true, isActive: false },
  ],
  [
    'super-admin updateUserSchema',
    updateUserSuperAdminSchema,
    { role: 'admin', isActive: false },
  ],
];

describe('partial update schemas', () => {
  describe('parses an empty object to an empty object', () => {
    it.each(emptyPayloadSchemas)('%s', (_name, schema) => {
      expect(schema.parse({})).toEqual({});
    });
  });

  describe('db files updateFileSchema requires a UUID id', () => {
    it('rejects an empty payload', () => {
      expect(() => updateFileSchema.parse({})).toThrow();
    });

    it('parses a payload with only a UUID id to that id', () => {
      expect(updateFileSchema.parse({ id: fileId })).toEqual({ id: fileId });
    });
  });

  describe('retains explicit values opposite to create defaults', () => {
    it.each(explicitValueCases)('%s', (_name, schema, payload) => {
      expect(schema.parse(payload)).toEqual(payload);
    });
  });
});
