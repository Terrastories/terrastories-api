import { describe, expect, it } from 'vitest';
import { toPublicStory } from '../../src/shared/types/public.js';

describe('V2 sovereignty field serialization', () => {
  const story = {
    id: 7,
    title: 'Public story',
    description: 'Public description',
    slug: 'public-story',
    mediaUrls: ['https://example.test/story.jpg'],
    language: 'en',
    tags: ['history'],
    communityId: 11,
    createdBy: 42,
    privacyLevel: 'public',
    isRestricted: false,
    culturalProtocols: {
      accessNotes: 'protected operational note',
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  it('fails closed when a public serializer is used without an explicit publication grant', () => {
    const result = (toPublicStory as unknown as Function)(story, {
      resourceCommunityId: story.communityId,
      explicitlyPublic: false,
    });

    expect(result).toBeNull();
  });

  it('projects only explicitly public fields when publication is granted', () => {
    const result = (toPublicStory as unknown as Function)(story, {
      resourceCommunityId: story.communityId,
      explicitlyPublic: true,
    });

    expect(result).toMatchObject({
      id: 7,
      title: 'Public story',
      description: 'Public description',
      slug: 'public-story',
      language: 'en',
    });
    expect(result).not.toHaveProperty('communityId');
    expect(result).not.toHaveProperty('createdBy');
    expect(result).not.toHaveProperty('privacyLevel');
    expect(result).not.toHaveProperty('isRestricted');
    expect(result).not.toHaveProperty('culturalProtocols');
  });
});
