import { describe, it, expect } from 'vitest';
import {
  speakerSchemas,
  speakerParameters,
  speakerExamples,
} from '../../../src/shared/schemas/speakers.swagger.js';

describe('Speakers Swagger Schemas', () => {
  describe('Speaker Schema', () => {
    it('should have all required properties defined', () => {
      const schema = speakerSchemas.Speaker;

      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.required).toEqual([
        'id',
        'name',
        'communityId',
        'elderStatus',
        'isActive',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('should define correct property types', () => {
      const properties = speakerSchemas.Speaker.properties;

      expect(properties.id.type).toBe('integer');
      expect(properties.name.type).toBe('string');
      expect(properties.bio.type).toBe('string');
      expect(properties.communityId.type).toBe('integer');
      expect(properties.photoUrl.type).toBe('string');
      expect(properties.photoUrl.format).toBe('uri');
      expect(properties.birthYear.type).toBe('integer');
      expect(properties.elderStatus.type).toBe('boolean');
      expect(properties.culturalRole.type).toBe('string');
      expect(properties.isActive.type).toBe('boolean');
      expect(properties.createdAt.type).toBe('string');
      expect(properties.createdAt.format).toBe('date-time');
      expect(properties.updatedAt.type).toBe('string');
      expect(properties.updatedAt.format).toBe('date-time');
    });

    it('should have proper descriptions for cultural fields', () => {
      const properties = speakerSchemas.Speaker.properties;

      expect(properties.elderStatus.description).toContain('elder');
      expect(properties.culturalRole.description.toLowerCase()).toContain(
        'cultural'
      );
      expect(properties.birthYear.description).toBeDefined();
      expect(properties.isActive.description).toBeDefined();
    });

    it('should have validation constraints', () => {
      const properties = speakerSchemas.Speaker.properties;

      expect(properties.name.minLength).toBeGreaterThan(0);
      expect(properties.birthYear.minimum).toBeDefined();
      expect(properties.birthYear.maximum).toBeDefined();
    });
  });

  describe('CreateSpeaker Schema', () => {
    it('should exclude auto-generated fields', () => {
      const schema = speakerSchemas.CreateSpeaker;

      expect(schema.type).toBe('object');
      expect(schema.properties.id).toBeUndefined();
      expect(schema.properties.createdAt).toBeUndefined();
      expect(schema.properties.updatedAt).toBeUndefined();
    });

    it('should have required fields for creation', () => {
      const schema = speakerSchemas.CreateSpeaker;

      expect(schema.required).toEqual(['name', 'communityId']);
    });

    it('should have default values for optional fields', () => {
      const properties = speakerSchemas.CreateSpeaker.properties;

      expect(properties.elderStatus.default).toBe(false);
      expect(properties.isActive.default).toBe(true);
    });
  });

  describe('UpdateSpeaker Schema', () => {
    it('should make all fields optional except restricted ones', () => {
      const schema = speakerSchemas.UpdateSpeaker;

      expect(schema.type).toBe('object');
      expect(schema.required).toEqual([]);
      expect(schema.properties.id).toBeUndefined();
      expect(schema.properties.createdAt).toBeUndefined();
      expect(schema.properties.communityId).toBeUndefined(); // Should not be updatable
    });

    it('should allow updating profile fields', () => {
      const properties = speakerSchemas.UpdateSpeaker.properties;

      expect(properties.name).toBeDefined();
      expect(properties.bio).toBeDefined();
      expect(properties.photoUrl).toBeDefined();
      expect(properties.birthYear).toBeDefined();
      expect(properties.elderStatus).toBeDefined();
      expect(properties.culturalRole).toBeDefined();
      expect(properties.isActive).toBeDefined();
    });
  });

  describe('SpeakerResponse Schema', () => {
    it('should extend Speaker schema', () => {
      const schema = speakerSchemas.SpeakerResponse;

      expect(schema.type).toBe('object');
      expect(schema.properties.data).toBeDefined();
      expect(schema.properties.data.$ref).toContain('Speaker');
    });

    it('should have success response structure', () => {
      const properties = speakerSchemas.SpeakerResponse.properties;

      expect(properties.success.type).toBe('boolean');
      expect(properties.success.default).toBe(true);
      expect(properties.data).toBeDefined();
    });
  });

  describe('SpeakerListResponse Schema', () => {
    it('should have pagination structure', () => {
      const schema = speakerSchemas.SpeakerListResponse;

      expect(schema.properties.data.type).toBe('array');
      expect(schema.properties.data.items.$ref).toContain('Speaker');
      expect(schema.properties.meta).toBeDefined();
      expect(schema.properties.meta.properties.total).toBeDefined();
      expect(schema.properties.meta.properties.page).toBeDefined();
      expect(schema.properties.meta.properties.limit).toBeDefined();
    });

    it('should support filtering metadata', () => {
      const metaProperties =
        speakerSchemas.SpeakerListResponse.properties.meta.properties;

      expect(metaProperties.filters).toBeDefined();
      expect(metaProperties.filters.properties.community).toBeDefined();
      expect(metaProperties.filters.properties.elderStatus).toBeDefined();
      expect(metaProperties.filters.properties.active).toBeDefined();
    });
  });

  describe('Parameters', () => {
    it('should define speakerId path parameter', () => {
      const param = speakerParameters.speakerId;

      expect(param.name).toBe('speakerId');
      expect(param.in).toBe('path');
      expect(param.required).toBe(true);
      expect(param.schema.type).toBe('integer');
      expect(param.description).toContain('speaker');
    });

    it('should define community filter parameter', () => {
      const param = speakerParameters.communityFilter;

      expect(param.name).toBe('community');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('integer');
      expect(param.description).toContain('community');
    });

    it('should define elder status filter parameter', () => {
      const param = speakerParameters.elderStatusFilter;

      expect(param.name).toBe('elderStatus');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('boolean');
      expect(param.description).toContain('elder');
    });

    it('should define active status filter parameter', () => {
      const param = speakerParameters.activeFilter;

      expect(param.name).toBe('active');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('boolean');
      expect(param.description).toContain('active');
    });

    it('should define pagination parameters', () => {
      const pageParam = speakerParameters.page;
      const limitParam = speakerParameters.limit;

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
    it('should provide complete speaker example', () => {
      const example = speakerExamples.speaker;

      expect(example.id).toBeDefined();
      expect(example.name).toBeDefined();
      expect(example.communityId).toBeDefined();
      expect(typeof example.elderStatus).toBe('boolean');
      expect(typeof example.isActive).toBe('boolean');
      expect(example.createdAt).toBeDefined();
      expect(example.updatedAt).toBeDefined();
    });

    it('should provide create speaker example', () => {
      const example = speakerExamples.createSpeaker;

      expect(example.id).toBeUndefined();
      expect(example.createdAt).toBeUndefined();
      expect(example.updatedAt).toBeUndefined();
      expect(example.name).toBeDefined();
      expect(example.communityId).toBeDefined();
    });

    it('should provide elder speaker example', () => {
      const elderExample = speakerExamples.elderSpeaker;

      expect(elderExample.elderStatus).toBe(true);
      expect(elderExample.culturalRole).toBeDefined();
      expect(elderExample.birthYear).toBeDefined();
      expect(elderExample.birthYear).toBeLessThan(
        new Date().getFullYear() - 50
      );
    });

    it('should provide speaker list example', () => {
      const example = speakerExamples.speakerList;

      expect(Array.isArray(example.data)).toBe(true);
      expect(example.meta).toBeDefined();
      expect(example.meta.total).toBeDefined();
      expect(example.meta.page).toBeDefined();
      expect(example.meta.limit).toBeDefined();
    });

    it('should provide cultural speaker examples', () => {
      const culturalExample = speakerExamples.culturalSpeaker;

      expect(culturalExample.culturalRole).toBeDefined();
      expect(culturalExample.bio).toContain('traditional');
      expect(culturalExample.elderStatus).toBeDefined();
    });

    it('should provide young speaker example', () => {
      const youngExample = speakerExamples.youngSpeaker;

      expect(youngExample.elderStatus).toBe(false);
      expect(youngExample.birthYear).toBeGreaterThan(1980);
      expect(youngExample.isActive).toBe(true);
    });
  });

  describe('Error Schemas', () => {
    it('should define ValidationError schema', () => {
      const schema = speakerSchemas.ValidationError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.details).toBeDefined();
    });

    it('should define NotFoundError schema', () => {
      const schema = speakerSchemas.NotFoundError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.resource).toBeDefined();
    });

    it('should define ConflictError schema', () => {
      const schema = speakerSchemas.ConflictError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.conflictType).toBeDefined();
    });

    it('should define UnauthorizedError schema', () => {
      const schema = speakerSchemas.UnauthorizedError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
    });

    it('should define ForbiddenError schema', () => {
      const schema = speakerSchemas.ForbiddenError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.reason).toBeDefined();
    });
  });

  describe('Cultural Sensitivity in Schemas', () => {
    it('should handle traditional names in examples', () => {
      const traditionalExample = speakerExamples.traditionalSpeaker;

      expect(traditionalExample.name).toContain('-');
      expect(traditionalExample.culturalRole).toContain('Traditional');
    });

    it('should support elder recognition fields', () => {
      const properties = speakerSchemas.Speaker.properties;

      expect(properties.elderStatus.description.toLowerCase()).toContain(
        'recognition'
      );
      expect(properties.culturalRole.description).toContain('community');
      expect(properties.birthYear.description).toContain('age');
    });

    it('should validate cultural role examples', () => {
      const examples = [
        speakerExamples.elderSpeaker.culturalRole,
        speakerExamples.culturalSpeaker.culturalRole,
      ];

      examples.forEach((role) => {
        expect(typeof role).toBe('string');
        expect(role.length).toBeGreaterThan(0);
      });
    });

    it('should handle inactive speakers appropriately', () => {
      const inactiveExample = speakerExamples.inactiveSpeaker;

      expect(inactiveExample.isActive).toBe(false);
      expect(inactiveExample.bio.toLowerCase()).toContain('former');
    });
  });

  describe('Schema Integration', () => {
    it('should be properly structured for OpenAPI', () => {
      expect(speakerSchemas).toBeDefined();
      expect(typeof speakerSchemas).toBe('object');

      // Check that all schemas have proper OpenAPI structure
      Object.values(speakerSchemas).forEach((schema) => {
        expect(schema.type).toBeDefined();
        expect(schema.properties || schema.$ref || schema.allOf).toBeDefined();
      });
    });

    it('should have consistent naming conventions', () => {
      const schemaNames = Object.keys(speakerSchemas);

      expect(schemaNames).toContain('Speaker');
      expect(schemaNames).toContain('CreateSpeaker');
      expect(schemaNames).toContain('UpdateSpeaker');
      expect(schemaNames).toContain('SpeakerResponse');
      expect(schemaNames).toContain('SpeakerListResponse');
    });

    it('should support multi-tenant filtering in examples', () => {
      const listExample = speakerExamples.speakerList;

      expect(listExample.meta.filters).toBeDefined();
      expect(listExample.meta.filters.community).toBeDefined();
      // elderStatus filter may be optional
      if (listExample.meta.filters.elderStatus !== undefined) {
        expect(listExample.meta.filters.elderStatus).toBeDefined();
      }
    });

    it('should provide comprehensive parameter coverage', () => {
      const paramNames = Object.keys(speakerParameters);

      expect(paramNames).toContain('speakerId');
      expect(paramNames).toContain('communityFilter');
      expect(paramNames).toContain('elderStatusFilter');
      expect(paramNames).toContain('activeFilter');
      expect(paramNames).toContain('page');
      expect(paramNames).toContain('limit');
    });
  });
});
