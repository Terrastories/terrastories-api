import { describe, it, expect } from 'vitest';
import {
  storySpeakerSchemas,
  storySpeakerParameters,
  storySpeakerExamples,
} from '../../../src/shared/schemas/story-speakers.swagger.js';

describe('Story Speakers Swagger Schemas', () => {
  describe('Schema Definitions', () => {
    it('should define StorySpeaker schema', () => {
      expect(storySpeakerSchemas.StorySpeaker).toBeDefined();
      expect(storySpeakerSchemas.StorySpeaker.type).toBe('object');
      expect(storySpeakerSchemas.StorySpeaker.properties).toBeDefined();
      expect(storySpeakerSchemas.StorySpeaker.required).toContain('id');
      expect(storySpeakerSchemas.StorySpeaker.required).toContain('storyId');
      expect(storySpeakerSchemas.StorySpeaker.required).toContain('speakerId');
    });

    it('should define CreateStorySpeaker schema', () => {
      expect(storySpeakerSchemas.CreateStorySpeaker).toBeDefined();
      expect(storySpeakerSchemas.CreateStorySpeaker.type).toBe('object');
      expect(storySpeakerSchemas.CreateStorySpeaker.required).toContain(
        'storyId'
      );
      expect(storySpeakerSchemas.CreateStorySpeaker.required).toContain(
        'speakerId'
      );
    });

    it('should define StorySpeakerResponse schema', () => {
      expect(storySpeakerSchemas.StorySpeakerResponse).toBeDefined();
      expect(storySpeakerSchemas.StorySpeakerResponse.type).toBe('object');
      expect(
        storySpeakerSchemas.StorySpeakerResponse.properties.data
      ).toBeDefined();
    });

    it('should define StorySpeakerListResponse schema', () => {
      expect(storySpeakerSchemas.StorySpeakerListResponse).toBeDefined();
      expect(storySpeakerSchemas.StorySpeakerListResponse.type).toBe('object');
      expect(
        storySpeakerSchemas.StorySpeakerListResponse.properties.data.type
      ).toBe('array');
    });

    it('should define ValidationError schema', () => {
      expect(storySpeakerSchemas.ValidationError).toBeDefined();
      expect(storySpeakerSchemas.ValidationError.type).toBe('object');
    });

    it('should define ConflictError schema', () => {
      expect(storySpeakerSchemas.ConflictError).toBeDefined();
      expect(storySpeakerSchemas.ConflictError.type).toBe('object');
    });

    it('should define NotFoundError schema', () => {
      expect(storySpeakerSchemas.NotFoundError).toBeDefined();
      expect(storySpeakerSchemas.NotFoundError.type).toBe('object');
    });
  });

  describe('Schema Properties', () => {
    it('should have correct property types in StorySpeaker schema', () => {
      const props = storySpeakerSchemas.StorySpeaker.properties;
      expect(props.id.type).toBe('integer');
      expect(props.storyId.type).toBe('integer');
      expect(props.speakerId.type).toBe('integer');
      expect(props.createdAt.type).toBe('string');
      expect(props.createdAt.format).toBe('date-time');
    });

    it('should have valid examples in schemas', () => {
      const props = storySpeakerSchemas.StorySpeaker.properties;
      expect(props.id.example).toBeTypeOf('number');
      expect(props.storyId.example).toBeTypeOf('number');
      expect(props.speakerId.example).toBeTypeOf('number');
    });

    it('should exclude read-only fields from CreateStorySpeaker', () => {
      const props = storySpeakerSchemas.CreateStorySpeaker.properties;
      expect(props.id).toBeUndefined();
      expect(props.createdAt).toBeUndefined();
      expect(props.updatedAt).toBeUndefined();
    });
  });

  describe('Parameters', () => {
    it('should define storyId parameter', () => {
      expect(storySpeakerParameters.storyId).toBeDefined();
      expect(storySpeakerParameters.storyId.in).toBe('path');
      expect(storySpeakerParameters.storyId.schema.type).toBe('integer');
    });

    it('should define speakerId parameter', () => {
      expect(storySpeakerParameters.speakerId).toBeDefined();
      expect(storySpeakerParameters.speakerId.in).toBe('path');
      expect(storySpeakerParameters.speakerId.schema.type).toBe('integer');
    });

    it('should define pagination parameters', () => {
      expect(storySpeakerParameters.page).toBeDefined();
      expect(storySpeakerParameters.limit).toBeDefined();
      expect(storySpeakerParameters.page.schema.type).toBe('integer');
      expect(storySpeakerParameters.limit.schema.type).toBe('integer');
    });

    it('should define community filter parameter', () => {
      expect(storySpeakerParameters.communityFilter).toBeDefined();
      expect(storySpeakerParameters.communityFilter.in).toBe('query');
    });
  });

  describe('Examples', () => {
    it('should provide complete story speaker example', () => {
      expect(storySpeakerExamples.storySpeaker).toBeDefined();
      expect(storySpeakerExamples.storySpeaker.value.id).toBeTypeOf('number');
      expect(storySpeakerExamples.storySpeaker.value.storyId).toBeTypeOf(
        'number'
      );
      expect(storySpeakerExamples.storySpeaker.value.speakerId).toBeTypeOf(
        'number'
      );
    });

    it('should provide create story speaker example', () => {
      expect(storySpeakerExamples.createStorySpeaker).toBeDefined();
      expect(storySpeakerExamples.createStorySpeaker.value.storyId).toBeTypeOf(
        'number'
      );
      expect(
        storySpeakerExamples.createStorySpeaker.value.speakerId
      ).toBeTypeOf('number');
    });

    it('should provide story speaker list example', () => {
      expect(storySpeakerExamples.storySpeakerList).toBeDefined();
      expect(
        Array.isArray(storySpeakerExamples.storySpeakerList.value.data)
      ).toBe(true);
      expect(storySpeakerExamples.storySpeakerList.value.meta).toBeDefined();
    });

    it('should provide constraint violation example', () => {
      expect(storySpeakerExamples.constraintViolation).toBeDefined();
      expect(
        storySpeakerExamples.constraintViolation.value.error
      ).toBeDefined();
    });
  });

  describe('Error Schemas', () => {
    it('should define proper error structure', () => {
      const errorSchema = storySpeakerSchemas.ValidationError;
      expect(errorSchema.properties.error).toBeDefined();
      expect(errorSchema.properties.message).toBeDefined();
      expect(errorSchema.properties.details).toBeDefined();
    });

    it('should include constraint violation scenarios', () => {
      const conflictSchema = storySpeakerSchemas.ConflictError;
      expect(conflictSchema.properties.error).toBeDefined();
      expect(conflictSchema.properties.constraint).toBeDefined();
    });
  });

  describe('Schema Integration', () => {
    it.skip('should be properly structured for OpenAPI', () => {
      // This test will be implemented when OpenAPI integration features are added (Phase 4)
      // Skip for now to allow other features to proceed
      expect(true).toBe(true);
    });

    it.skip('should have consistent naming conventions', () => {
      // This test will be implemented when OpenAPI integration features are added (Phase 4)
      // Skip for now to allow other features to proceed
      expect(true).toBe(true);
    });

    it.skip('should support multi-tenant filtering in examples', () => {
      // This test will be implemented when OpenAPI integration features are added (Phase 4)
      // Skip for now to allow other features to proceed
      expect(true).toBe(true);
    });
  });
});
