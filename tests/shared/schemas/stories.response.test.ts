import { describe, expect, it } from 'vitest';
import { StoryWithRelationsResponseSchema } from '@/shared/schemas/stories.js';

function createStoryResponse(speaker: Record<string, unknown>) {
  return {
    id: 1,
    title: 'Test story',
    description: null,
    slug: 'test-story',
    communityId: 1,
    createdBy: 1,
    mediaUrls: [],
    language: 'en',
    tags: [],
    isRestricted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    places: [],
    speakers: [
      {
        id: 1,
        name: 'Test speaker',
        elderStatus: false,
        ...speaker,
      },
    ],
    community: {
      id: 1,
      name: 'Test community',
      slug: 'test-community',
      locale: 'en',
    },
    author: {
      id: 1,
      firstName: 'Test',
      lastName: 'Author',
      role: 'admin',
    },
  };
}

describe('StoryWithRelationsResponseSchema', () => {
  it('accepts a related speaker with no photo URL', () => {
    expect(() =>
      StoryWithRelationsResponseSchema.parse(createStoryResponse({}))
    ).not.toThrow();
  });

  it('normalizes an empty related-speaker photo URL to undefined', () => {
    const result = StoryWithRelationsResponseSchema.parse(
      createStoryResponse({ photoUrl: '' })
    );

    expect(result.speakers[0].photoUrl).toBeUndefined();
  });

  it('rejects an invalid related-speaker photo URL', () => {
    expect(() =>
      StoryWithRelationsResponseSchema.parse(
        createStoryResponse({ photoUrl: 'not-a-url' })
      )
    ).toThrow();
  });
});
