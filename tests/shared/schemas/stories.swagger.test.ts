import { describe, it, expect } from 'vitest';
import {
  storySchemas,
  storyParameters,
  storyExamples,
} from '../../../src/shared/schemas/stories.swagger.js';

describe('Stories Swagger Schemas', () => {
  describe('Story Schema', () => {
    it('should have all required properties defined', () => {
      const schema = storySchemas.Story;

      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.required).toEqual([
        'id',
        'title',
        'communityId',
        'createdBy',
        'isRestricted',
        'language',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('should define correct property types', () => {
      const properties = storySchemas.Story.properties;

      expect(properties.id.type).toBe('integer');
      expect(properties.title.type).toBe('string');
      expect(properties.description.type).toBe('string');
      expect(properties.communityId.type).toBe('integer');
      expect(properties.createdBy.type).toBe('integer');
      expect(properties.isRestricted.type).toBe('boolean');
      expect(properties.mediaUrls.type).toBe('array');
      expect(properties.mediaUrls.items.type).toBe('string');
      expect(properties.language.type).toBe('string');
      expect(properties.tags.type).toBe('array');
      expect(properties.tags.items.type).toBe('string');
      expect(properties.createdAt.type).toBe('string');
      expect(properties.createdAt.format).toBe('date-time');
      expect(properties.updatedAt.type).toBe('string');
      expect(properties.updatedAt.format).toBe('date-time');
    });

    it('should have proper descriptions for cultural fields', () => {
      const properties = storySchemas.Story.properties;

      expect(properties.isRestricted.description).toContain('cultural');
      expect(properties.language.description).toBeDefined();
      expect(properties.tags.description).toBeDefined();
      expect(properties.mediaUrls.description).toBeDefined();
    });
  });

  describe('CreateStory Schema', () => {
    it('should exclude auto-generated fields', () => {
      const schema = storySchemas.CreateStory;

      expect(schema.type).toBe('object');
      expect(schema.properties.id).toBeUndefined();
      expect(schema.properties.createdAt).toBeUndefined();
      expect(schema.properties.updatedAt).toBeUndefined();
    });

    it('should have required fields for creation', () => {
      const schema = storySchemas.CreateStory;

      expect(schema.required).toEqual(['title', 'communityId', 'createdBy']);
    });

    it('should have default values for optional fields', () => {
      const properties = storySchemas.CreateStory.properties;

      expect(properties.isRestricted.default).toBe(false);
      expect(properties.language.default).toBe('en');
      expect(properties.mediaUrls.default).toEqual([]);
      expect(properties.tags.default).toEqual([]);
    });
  });

  describe('UpdateStory Schema', () => {
    it('should make all fields optional except restricted ones', () => {
      const schema = storySchemas.UpdateStory;

      expect(schema.type).toBe('object');
      expect(schema.required).toEqual([]);
      expect(schema.properties.id).toBeUndefined();
      expect(schema.properties.createdAt).toBeUndefined();
      expect(schema.properties.communityId).toBeUndefined(); // Should not be updatable
    });

    it('should allow updating content fields', () => {
      const properties = storySchemas.UpdateStory.properties;

      expect(properties.title).toBeDefined();
      expect(properties.description).toBeDefined();
      expect(properties.isRestricted).toBeDefined();
      expect(properties.mediaUrls).toBeDefined();
      expect(properties.language).toBeDefined();
      expect(properties.tags).toBeDefined();
    });
  });

  describe('StoryResponse Schema', () => {
    it('should extend Story schema', () => {
      const schema = storySchemas.StoryResponse;

      expect(schema.type).toBe('object');
      expect(schema.properties.data).toBeDefined();
      expect(schema.properties.data.$ref).toContain('Story');
    });

    it('should have success response structure', () => {
      const properties = storySchemas.StoryResponse.properties;

      expect(properties.success.type).toBe('boolean');
      expect(properties.success.default).toBe(true);
      expect(properties.data).toBeDefined();
    });
  });

  describe('StoryListResponse Schema', () => {
    it('should have pagination structure', () => {
      const schema = storySchemas.StoryListResponse;

      expect(schema.properties.data.type).toBe('array');
      expect(schema.properties.data.items.$ref).toContain('Story');
      expect(schema.properties.meta).toBeDefined();
      expect(schema.properties.meta.properties.total).toBeDefined();
      expect(schema.properties.meta.properties.page).toBeDefined();
      expect(schema.properties.meta.properties.limit).toBeDefined();
    });

    it('should support filtering metadata', () => {
      const metaProperties =
        storySchemas.StoryListResponse.properties.meta.properties;

      expect(metaProperties.filters).toBeDefined();
      expect(metaProperties.filters.properties.community).toBeDefined();
      expect(metaProperties.filters.properties.language).toBeDefined();
      expect(metaProperties.filters.properties.restricted).toBeDefined();
    });
  });

  describe('Parameters', () => {
    it('should define storyId path parameter', () => {
      const param = storyParameters.storyId;

      expect(param.name).toBe('storyId');
      expect(param.in).toBe('path');
      expect(param.required).toBe(true);
      expect(param.schema.type).toBe('integer');
      expect(param.description).toContain('story');
    });

    it('should define community filter parameter', () => {
      const param = storyParameters.communityFilter;

      expect(param.name).toBe('community');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('integer');
      expect(param.description).toContain('community');
    });

    it('should define language filter parameter', () => {
      const param = storyParameters.languageFilter;

      expect(param.name).toBe('language');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('string');
    });

    it('should define restricted filter parameter', () => {
      const param = storyParameters.restrictedFilter;

      expect(param.name).toBe('restricted');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('boolean');
      expect(param.description).toContain('cultural');
    });

    it('should define pagination parameters', () => {
      const pageParam = storyParameters.page;
      const limitParam = storyParameters.limit;

      expect(pageParam.name).toBe('page');
      expect(pageParam.schema.type).toBe('integer');
      expect(pageParam.schema.minimum).toBe(1);

      expect(limitParam.name).toBe('limit');
      expect(limitParam.schema.type).toBe('integer');
      expect(limitParam.schema.minimum).toBe(1);
      expect(limitParam.schema.maximum).toBe(100);
    });
  });

  describe('Examples', () => {
    it('should provide complete story example', () => {
      const example = storyExamples.story;

      expect(example.id).toBeDefined();
      expect(example.title).toBeDefined();
      expect(example.communityId).toBeDefined();
      expect(example.createdBy).toBeDefined();
      expect(typeof example.isRestricted).toBe('boolean');
      expect(Array.isArray(example.mediaUrls)).toBe(true);
      expect(Array.isArray(example.tags)).toBe(true);
      expect(example.language).toBeDefined();
    });

    it('should provide create story example', () => {
      const example = storyExamples.createStory;

      expect(example.id).toBeUndefined();
      expect(example.createdAt).toBeUndefined();
      expect(example.updatedAt).toBeUndefined();
      expect(example.title).toBeDefined();
      expect(example.communityId).toBeDefined();
      expect(example.createdBy).toBeDefined();
    });

    it('should provide cultural story examples', () => {
      const culturalExample = storyExamples.culturalStory;

      expect(culturalExample.isRestricted).toBe(true);
      expect(culturalExample.tags).toContain('traditional-knowledge');
      expect(culturalExample.language).toBeDefined();
    });

    it('should provide story list example', () => {
      const example = storyExamples.storyList;

      expect(Array.isArray(example.data)).toBe(true);
      expect(example.meta).toBeDefined();
      expect(example.meta.total).toBeDefined();
      expect(example.meta.page).toBeDefined();
      expect(example.meta.limit).toBeDefined();
    });

    it('should provide media-rich story example', () => {
      const example = storyExamples.mediaRichStory;

      expect(Array.isArray(example.mediaUrls)).toBe(true);
      expect(example.mediaUrls.length).toBeGreaterThan(0);
      expect(example.mediaUrls[0]).toMatch(/^https?:\/\//);
    });
  });

  describe('Error Schemas', () => {
    it('should define ValidationError schema', () => {
      const schema = storySchemas.ValidationError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.details).toBeDefined();
    });

    it('should define NotFoundError schema', () => {
      const schema = storySchemas.NotFoundError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.resource).toBeDefined();
    });

    it('should define ConflictError schema', () => {
      const schema = storySchemas.ConflictError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.conflictType).toBeDefined();
    });

    it('should define UnauthorizedError schema', () => {
      const schema = storySchemas.UnauthorizedError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
    });

    it('should define ForbiddenError schema', () => {
      const schema = storySchemas.ForbiddenError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.reason).toBeDefined();
    });
  });

  describe('Schema Integration', () => {
    it('should be properly structured for OpenAPI', () => {
      expect(storySchemas).toBeDefined();
      expect(typeof storySchemas).toBe('object');

      // Check that all schemas have proper OpenAPI structure
      Object.values(storySchemas).forEach((schema) => {
        expect(schema.type).toBeDefined();
        expect(schema.properties || schema.$ref || schema.allOf).toBeDefined();
      });
    });

    it('should have consistent naming conventions', () => {
      const schemaNames = Object.keys(storySchemas);

      expect(schemaNames).toContain('Story');
      expect(schemaNames).toContain('CreateStory');
      expect(schemaNames).toContain('UpdateStory');
      expect(schemaNames).toContain('StoryResponse');
      expect(schemaNames).toContain('StoryListResponse');
    });

    it('should support multi-tenant filtering in examples', () => {
      const listExample = storyExamples.storyList;

      expect(listExample.meta.filters).toBeDefined();
      expect(listExample.meta.filters.community).toBeDefined();
    });
  });
});
