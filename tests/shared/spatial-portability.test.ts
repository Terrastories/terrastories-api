import { describe, expect, it } from 'vitest';
import { SpatialUtils } from '../../src/shared/utils/spatial.js';

describe('SpatialUtils portable radius bounding boxes', () => {
  it('returns a conservative local bounding box', () => {
    const bounds = SpatialUtils.calculateBoundingBox(-1.4558, -48.4902, 1);

    expect(bounds.south).toBeLessThan(-1.4558);
    expect(bounds.north).toBeGreaterThan(-1.4558);
    expect(bounds.west).toBeLessThan(-48.4902);
    expect(bounds.east).toBeGreaterThan(-48.4902);
    expect(bounds.crossesAntimeridian).toBe(false);
    expect(bounds.includesAllLongitudes).toBe(false);
  });

  it('marks antimeridian-crossing bounds without dropping either side', () => {
    const bounds = SpatialUtils.calculateBoundingBox(0, 179.95, 30);

    expect(bounds.crossesAntimeridian).toBe(true);
    expect(bounds.west).toBeGreaterThan(179);
    expect(bounds.east).toBeLessThan(-179);
    expect(bounds.includesAllLongitudes).toBe(false);
  });

  it('leaves longitude unrestricted when a radius reaches a pole', () => {
    const bounds = SpatialUtils.calculateBoundingBox(89.9, 0, 30);

    expect(bounds.north).toBe(90);
    expect(bounds.includesAllLongitudes).toBe(true);
    expect(bounds.west).toBe(-180);
    expect(bounds.east).toBe(180);
  });

  it('rejects negative or non-finite radii', () => {
    expect(() => SpatialUtils.calculateBoundingBox(0, 0, -1)).toThrow(
      /non-negative finite number/
    );
    expect(() => SpatialUtils.calculateBoundingBox(0, 0, Number.NaN)).toThrow(
      /non-negative finite number/
    );
  });
});
