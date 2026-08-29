import { describe, expect, it } from 'vitest';
import {
  NEVER_EXPOSED_FIELDS_BY_FAMILY,
  projectCommunityResourceFields,
} from '../../src/shared/authorization/sovereignty-policy.js';
import { toPublicStory } from '../../src/shared/types/public.js';

describe('V2 sovereignty field serialization', () => {
  const actor = {
    id: 3,
    role: 'editor' as const,
    communityId: 11,
    active: true,
  };

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

  it('classifies concrete operational fields as never exposed', () => {
    expect(NEVER_EXPOSED_FIELDS_BY_FAMILY.themes).toHaveLength(1);
    expect(NEVER_EXPOSED_FIELDS_BY_FAMILY.files).toEqual(['path']);
  });

  it('removes the configured theme operational field from community responses', () => {
    const [themeSecretField] = NEVER_EXPOSED_FIELDS_BY_FAMILY.themes;
    const projected = projectCommunityResourceFields(
      'themes',
      {
        id: 9,
        name: 'Community map',
        communityId: 11,
        mapboxStyleUrl: 'mapbox://styles/example/style',
        [themeSecretField]: 'opaque-test-value',
      },
      actor,
      11
    );

    expect(projected).toMatchObject({
      id: 9,
      name: 'Community map',
      communityId: 11,
      mapboxStyleUrl: 'mapbox://styles/example/style',
    });
    expect(projected).not.toHaveProperty(themeSecretField);
  });

  it('removes an internal file storage path from an authenticated response', () => {
    const projected = projectCommunityResourceFields(
      'files',
      {
        id: 'file-id',
        filename: 'story.jpg',
        communityId: 11,
        url: '/api/v1/files/file-id',
        path: 'community-11/images/private-storage-name.jpg',
      },
      actor,
      11
    );

    expect(projected).toMatchObject({
      id: 'file-id',
      filename: 'story.jpg',
      communityId: 11,
      url: '/api/v1/files/file-id',
    });
    expect(projected).not.toHaveProperty('path');
  });

  it('projects no community-only fields for a cross-community actor', () => {
    const projected = projectCommunityResourceFields(
      'places',
      { id: 1, name: 'Other community place', communityId: 22 },
      actor,
      22
    );

    expect(projected).toEqual({});
  });
});
