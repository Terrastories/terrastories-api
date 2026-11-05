import { describe, expect, it } from 'vitest';
import {
  SearchQuerySchema,
  StoryFiltersSchema,
  StoryWithRelationsResponseSchema,
} from '@/shared/schemas/stories.js';

const point = { type: 'Point', coordinates: [-60, -3] };

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

describe('story filter input regressions', () => {
  const validGeo = { nearPoint: point, radiusKm: 5 };
  const orderedDates = { dateFrom: '2024-01-01', dateTo: '2024-12-31' };
  const reversedDates = { dateFrom: '2024-12-31', dateTo: '2024-01-01' };

  it('StoryFiltersSchema accepts a valid nearPoint/radiusKm pair and ordered dates', () => {
    expect(() =>
      StoryFiltersSchema.parse({ ...validGeo, ...orderedDates })
    ).not.toThrow();
  });

  it('StoryFiltersSchema rejects nearPoint without radiusKm', () => {
    expect(() => StoryFiltersSchema.parse({ nearPoint: point })).toThrow();
  });

  it('StoryFiltersSchema rejects radiusKm without nearPoint', () => {
    expect(() => StoryFiltersSchema.parse({ radiusKm: 5 })).toThrow();
  });

  it('StoryFiltersSchema rejects reversed dates', () => {
    expect(() => StoryFiltersSchema.parse(reversedDates)).toThrow();
  });

  it('SearchQuerySchema accepts valid q with a valid geo pair and ordered dates', () => {
    expect(() =>
      SearchQuerySchema.parse({ q: 'river', ...validGeo, ...orderedDates })
    ).not.toThrow();
  });

  it('SearchQuerySchema rejects nearPoint without radiusKm', () => {
    expect(() =>
      SearchQuerySchema.parse({ q: 'river', nearPoint: point })
    ).toThrow();
  });

  it('SearchQuerySchema rejects radiusKm without nearPoint', () => {
    expect(() =>
      SearchQuerySchema.parse({ q: 'river', radiusKm: 5 })
    ).toThrow();
  });

  it('SearchQuerySchema rejects reversed dates', () => {
    expect(() =>
      SearchQuerySchema.parse({ q: 'river', ...reversedDates })
    ).toThrow();
  });

  it('SearchQuerySchema rejects a nearPoint without both lng and lat coordinates', () => {
    expect(() =>
      SearchQuerySchema.parse({
        q: 'river',
        nearPoint: { type: 'Point', coordinates: [-60] },
        radiusKm: 5,
      })
    ).toThrow();
  });

  it('SearchQuerySchema rejects missing q', () => {
    expect(() => SearchQuerySchema.parse({})).toThrow();
  });

  it('SearchQuerySchema rejects empty q', () => {
    expect(() => SearchQuerySchema.parse({ q: '' })).toThrow();
  });

  it('SearchQuerySchema rejects nonpositive radiusKm', () => {
    expect(() =>
      SearchQuerySchema.parse({ q: 'river', nearPoint: point, radiusKm: 0 })
    ).toThrow();
  });

  it('SearchQuerySchema rejects unknown fields', () => {
    expect(() =>
      SearchQuerySchema.parse({ q: 'river', unknownField: 1 })
    ).toThrow();
  });
});
