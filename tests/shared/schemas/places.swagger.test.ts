import { describe, it, expect } from 'vitest';
import {
  placeSchemas,
  placeParameters,
  placeExamples,
} from '../../../src/shared/schemas/places.swagger.js';

describe('Places Swagger Schemas', () => {
  describe('Place Schema', () => {
    it('should have all required properties defined', () => {
      const schema = placeSchemas.Place;

      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.required).toEqual([
        'id',
        'name',
        'communityId',
        'latitude',
        'longitude',
        'isRestricted',
        'createdAt',
        'updatedAt',
      ]);
    });

    it('should define correct property types', () => {
      const properties = placeSchemas.Place.properties;

      expect(properties.id.type).toBe('integer');
      expect(properties.name.type).toBe('string');
      expect(properties.description.type).toBe('string');
      expect(properties.communityId.type).toBe('integer');
      expect(properties.latitude.type).toBe('number');
      expect(properties.longitude.type).toBe('number');
      expect(properties.region.type).toBe('string');
      expect(properties.mediaUrls.type).toBe('array');
      expect(properties.mediaUrls.items.type).toBe('string');
      expect(properties.mediaUrls.items.format).toBe('uri');
      expect(properties.culturalSignificance.type).toBe('string');
      expect(properties.isRestricted.type).toBe('boolean');
      expect(properties.createdAt.type).toBe('string');
      expect(properties.createdAt.format).toBe('date-time');
      expect(properties.updatedAt.type).toBe('string');
      expect(properties.updatedAt.format).toBe('date-time');
    });

    it('should have proper coordinate validation constraints', () => {
      const properties = placeSchemas.Place.properties;

      expect(properties.latitude.minimum).toBe(-90);
      expect(properties.latitude.maximum).toBe(90);
      expect(properties.longitude.minimum).toBe(-180);
      expect(properties.longitude.maximum).toBe(180);
    });

    it('should have proper descriptions for geographic fields', () => {
      const properties = placeSchemas.Place.properties;

      expect(properties.latitude.description).toContain('decimal degrees');
      expect(properties.longitude.description).toContain('decimal degrees');
      expect(properties.culturalSignificance.description).toContain('cultural');
      expect(properties.isRestricted.description).toContain('restricted');
    });

    it('should have validation constraints', () => {
      const properties = placeSchemas.Place.properties;

      expect(properties.name.minLength).toBeGreaterThan(0);
      expect(properties.name.maxLength).toBeDefined();
      expect(properties.description.maxLength).toBeDefined();
      expect(properties.culturalSignificance.maxLength).toBeDefined();
    });
  });

  describe('CreatePlace Schema', () => {
    it('should exclude auto-generated fields', () => {
      const schema = placeSchemas.CreatePlace;

      expect(schema.type).toBe('object');
      expect(schema.properties.id).toBeUndefined();
      expect(schema.properties.createdAt).toBeUndefined();
      expect(schema.properties.updatedAt).toBeUndefined();
    });

    it('should have required fields for creation', () => {
      const schema = placeSchemas.CreatePlace;

      expect(schema.required).toEqual([
        'name',
        'communityId',
        'latitude',
        'longitude',
      ]);
    });

    it('should have default values for optional fields', () => {
      const properties = placeSchemas.CreatePlace.properties;

      expect(properties.isRestricted.default).toBe(false);
      expect(properties.mediaUrls.default).toEqual([]);
    });

    it('should validate coordinate ranges', () => {
      const properties = placeSchemas.CreatePlace.properties;

      expect(properties.latitude.minimum).toBe(-90);
      expect(properties.latitude.maximum).toBe(90);
      expect(properties.longitude.minimum).toBe(-180);
      expect(properties.longitude.maximum).toBe(180);
    });
  });

  describe('UpdatePlace Schema', () => {
    it('should make all fields optional except restricted ones', () => {
      const schema = placeSchemas.UpdatePlace;

      expect(schema.type).toBe('object');
      expect(schema.required).toEqual([]);
      expect(schema.properties.id).toBeUndefined();
      expect(schema.properties.createdAt).toBeUndefined();
      expect(schema.properties.communityId).toBeUndefined(); // Should not be updatable
    });

    it('should allow updating location fields', () => {
      const properties = placeSchemas.UpdatePlace.properties;

      expect(properties.name).toBeDefined();
      expect(properties.description).toBeDefined();
      expect(properties.latitude).toBeDefined();
      expect(properties.longitude).toBeDefined();
      expect(properties.region).toBeDefined();
      expect(properties.mediaUrls).toBeDefined();
      expect(properties.culturalSignificance).toBeDefined();
      expect(properties.isRestricted).toBeDefined();
    });
  });

  describe('PlaceResponse Schema', () => {
    it('should extend Place schema', () => {
      const schema = placeSchemas.PlaceResponse;

      expect(schema.type).toBe('object');
      expect(schema.properties.data).toBeDefined();
      expect(schema.properties.data.$ref).toContain('Place');
    });

    it('should have success response structure', () => {
      const properties = placeSchemas.PlaceResponse.properties;

      expect(properties.success.type).toBe('boolean');
      expect(properties.success.default).toBe(true);
      expect(properties.data).toBeDefined();
    });
  });

  describe('PlaceListResponse Schema', () => {
    it('should have pagination structure', () => {
      const schema = placeSchemas.PlaceListResponse;

      expect(schema.properties.data.type).toBe('array');
      expect(schema.properties.data.items.$ref).toContain('Place');
      expect(schema.properties.meta).toBeDefined();
      expect(schema.properties.meta.properties.total).toBeDefined();
      expect(schema.properties.meta.properties.page).toBeDefined();
      expect(schema.properties.meta.properties.limit).toBeDefined();
    });

    it('should support filtering metadata', () => {
      const metaProperties =
        placeSchemas.PlaceListResponse.properties.meta.properties;

      expect(metaProperties.filters).toBeDefined();
      expect(metaProperties.filters.properties.community).toBeDefined();
      expect(metaProperties.filters.properties.region).toBeDefined();
      expect(metaProperties.filters.properties.restricted).toBeDefined();
      expect(metaProperties.filters.properties.withinRadius).toBeDefined();
    });

    it('should support spatial filtering in metadata', () => {
      const filtersProperties =
        placeSchemas.PlaceListResponse.properties.meta.properties.filters
          .properties;

      expect(filtersProperties.withinRadius).toBeDefined();
      expect(filtersProperties.withinRadius.properties.latitude).toBeDefined();
      expect(filtersProperties.withinRadius.properties.longitude).toBeDefined();
      expect(filtersProperties.withinRadius.properties.radiusKm).toBeDefined();
    });
  });

  describe('Parameters', () => {
    it('should define placeId path parameter', () => {
      const param = placeParameters.placeId;

      expect(param.name).toBe('placeId');
      expect(param.in).toBe('path');
      expect(param.required).toBe(true);
      expect(param.schema.type).toBe('integer');
      expect(param.description).toContain('place');
    });

    it('should define community filter parameter', () => {
      const param = placeParameters.communityFilter;

      expect(param.name).toBe('community');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('integer');
      expect(param.description).toContain('community');
    });

    it('should define region filter parameter', () => {
      const param = placeParameters.regionFilter;

      expect(param.name).toBe('region');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('string');
      expect(param.description).toContain('region');
    });

    it('should define restricted filter parameter', () => {
      const param = placeParameters.restrictedFilter;

      expect(param.name).toBe('restricted');
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.type).toBe('boolean');
      expect(param.description).toContain('restriction');
    });

    it('should define spatial search parameters', () => {
      const latParam = placeParameters.latitude;
      const lngParam = placeParameters.longitude;
      const radiusParam = placeParameters.radius;

      expect(latParam.name).toBe('latitude');
      expect(latParam.schema.type).toBe('number');
      expect(latParam.schema.minimum).toBe(-90);
      expect(latParam.schema.maximum).toBe(90);

      expect(lngParam.name).toBe('longitude');
      expect(lngParam.schema.type).toBe('number');
      expect(lngParam.schema.minimum).toBe(-180);
      expect(lngParam.schema.maximum).toBe(180);

      expect(radiusParam.name).toBe('radius');
      expect(radiusParam.schema.type).toBe('number');
      expect(radiusParam.schema.minimum).toBeGreaterThan(0);
      expect(radiusParam.schema.maximum).toBeDefined();
    });

    it('should define pagination parameters', () => {
      const pageParam = placeParameters.page;
      const limitParam = placeParameters.limit;

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
    it('should provide complete place example', () => {
      const example = placeExamples.place;

      expect(example.id).toBeDefined();
      expect(example.name).toBeDefined();
      expect(example.communityId).toBeDefined();
      expect(typeof example.latitude).toBe('number');
      expect(typeof example.longitude).toBe('number');
      expect(typeof example.isRestricted).toBe('boolean');
      expect(Array.isArray(example.mediaUrls)).toBe(true);
      expect(example.createdAt).toBeDefined();
      expect(example.updatedAt).toBeDefined();
    });

    it('should provide create place example', () => {
      const example = placeExamples.createPlace;

      expect(example.id).toBeUndefined();
      expect(example.createdAt).toBeUndefined();
      expect(example.updatedAt).toBeUndefined();
      expect(example.name).toBeDefined();
      expect(example.communityId).toBeDefined();
      expect(example.latitude).toBeDefined();
      expect(example.longitude).toBeDefined();
    });

    it('should provide restricted place example', () => {
      const restrictedExample = placeExamples.restrictedPlace;

      expect(restrictedExample.isRestricted).toBe(true);
      expect(restrictedExample.culturalSignificance).toBeDefined();
      expect(restrictedExample.name).toContain('Burial');
    });

    it('should provide place list example', () => {
      const example = placeExamples.placeList;

      expect(Array.isArray(example.data)).toBe(true);
      expect(example.meta).toBeDefined();
      expect(example.meta.total).toBeDefined();
      expect(example.meta.page).toBeDefined();
      expect(example.meta.limit).toBeDefined();
    });

    it('should validate coordinate values in examples', () => {
      const examples = [
        placeExamples.place,
        placeExamples.createPlace,
        placeExamples.restrictedPlace,
        placeExamples.waterSource,
        placeExamples.ceremonialSite,
        placeExamples.huntingGround,
      ];

      examples.forEach((example) => {
        expect(example.latitude).toBeGreaterThanOrEqual(-90);
        expect(example.latitude).toBeLessThanOrEqual(90);
        expect(example.longitude).toBeGreaterThanOrEqual(-180);
        expect(example.longitude).toBeLessThanOrEqual(180);
      });
    });

    it('should provide culturally diverse place examples', () => {
      const waterExample = placeExamples.waterSource;
      const ceremonialExample = placeExamples.ceremonialSite;
      const huntingExample = placeExamples.huntingGround;

      expect(waterExample.name).toContain('Springs');
      expect(waterExample.culturalSignificance).toContain('healing');

      expect(ceremonialExample.name).toContain('Circle');
      expect(ceremonialExample.culturalSignificance.toLowerCase()).toContain(
        'ceremoni'
      ); // Case insensitive match

      expect(huntingExample.name).toContain('Hunting');
      expect(huntingExample.culturalSignificance).toContain('hunting');
    });

    it('should provide media-rich place examples', () => {
      const examples = [
        placeExamples.place,
        placeExamples.waterSource,
        placeExamples.ceremonialSite,
      ];

      examples.forEach((example) => {
        expect(Array.isArray(example.mediaUrls)).toBe(true);
        if (example.mediaUrls.length > 0) {
          example.mediaUrls.forEach((url) => {
            expect(url).toMatch(/^https?:\/\//);
          });
        }
      });
    });
  });

  describe('Error Schemas', () => {
    it('should define ValidationError schema', () => {
      const schema = placeSchemas.ValidationError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.details).toBeDefined();
    });

    it('should define NotFoundError schema', () => {
      const schema = placeSchemas.NotFoundError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.resource).toBeDefined();
    });

    it('should define ConflictError schema', () => {
      const schema = placeSchemas.ConflictError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.conflictType).toBeDefined();
    });

    it('should define UnauthorizedError schema', () => {
      const schema = placeSchemas.UnauthorizedError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
    });

    it('should define ForbiddenError schema', () => {
      const schema = placeSchemas.ForbiddenError;

      expect(schema.type).toBe('object');
      expect(schema.properties.error).toBeDefined();
      expect(schema.properties.message).toBeDefined();
      expect(schema.properties.reason).toBeDefined();
    });

    it('should have culturally appropriate error messages', () => {
      const forbiddenSchema = placeSchemas.ForbiddenError;

      expect(forbiddenSchema.properties.message.example).toContain(
        'restricted'
      );
      expect(forbiddenSchema.properties.reason.example).toContain(
        'culturally_sensitive'
      );
    });
  });

  describe('Schema Integration', () => {
    it('should be properly structured for OpenAPI', () => {
      expect(placeSchemas).toBeDefined();
      expect(typeof placeSchemas).toBe('object');

      // Check that all schemas have proper OpenAPI structure
      Object.values(placeSchemas).forEach((schema) => {
        expect(schema.type).toBeDefined();
        expect(schema.properties || schema.$ref || schema.allOf).toBeDefined();
      });
    });

    it('should have consistent naming conventions', () => {
      const schemaNames = Object.keys(placeSchemas);

      expect(schemaNames).toContain('Place');
      expect(schemaNames).toContain('CreatePlace');
      expect(schemaNames).toContain('UpdatePlace');
      expect(schemaNames).toContain('PlaceResponse');
      expect(schemaNames).toContain('PlaceListResponse');
    });

    it('should support spatial filtering in examples', () => {
      const listExample = placeExamples.placeList;

      expect(listExample.meta.filters).toBeDefined();
      expect(listExample.meta.filters.community).toBeDefined();
      expect(listExample.meta.filters.withinRadius).toBeDefined();
      expect(listExample.meta.filters.withinRadius.latitude).toBeDefined();
      expect(listExample.meta.filters.withinRadius.longitude).toBeDefined();
      expect(listExample.meta.filters.withinRadius.radiusKm).toBeDefined();
    });

    it('should provide comprehensive parameter coverage', () => {
      const paramNames = Object.keys(placeParameters);

      expect(paramNames).toContain('placeId');
      expect(paramNames).toContain('communityFilter');
      expect(paramNames).toContain('regionFilter');
      expect(paramNames).toContain('restrictedFilter');
      expect(paramNames).toContain('latitude');
      expect(paramNames).toContain('longitude');
      expect(paramNames).toContain('radius');
      expect(paramNames).toContain('page');
      expect(paramNames).toContain('limit');
    });
  });

  describe('PostGIS Integration', () => {
    it('should have coordinate examples within valid ranges', () => {
      const example = placeExamples.place;

      expect(example.latitude).toBeGreaterThanOrEqual(-90);
      expect(example.latitude).toBeLessThanOrEqual(90);
      expect(example.longitude).toBeGreaterThanOrEqual(-180);
      expect(example.longitude).toBeLessThanOrEqual(180);
    });

    it('should support spatial search parameters', () => {
      const spatialParams = [
        placeParameters.latitude,
        placeParameters.longitude,
        placeParameters.radius,
      ];

      spatialParams.forEach((param) => {
        expect(param).toBeDefined();
        expect(param.schema.type).toBe('number');
        expect(param.description).toBeDefined();
      });
    });

    it('should provide realistic geographic examples', () => {
      const listExample = placeExamples.placeList;

      expect(listExample.data.length).toBeGreaterThan(0);
      listExample.data.forEach((place) => {
        expect(typeof place.latitude).toBe('number');
        expect(typeof place.longitude).toBe('number');
        expect(place.latitude).toBeGreaterThanOrEqual(-90);
        expect(place.latitude).toBeLessThanOrEqual(90);
        expect(place.longitude).toBeGreaterThanOrEqual(-180);
        expect(place.longitude).toBeLessThanOrEqual(180);
      });
    });
  });
});
