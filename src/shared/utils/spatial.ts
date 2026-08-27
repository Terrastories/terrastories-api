/**
 * Spatial Utilities for Geographic Data Processing
 *
 * Provides backend-neutral geographic helpers for PostgreSQL and
 * SQLite/D1-compatible deployments. V2 spatial behavior is application-level
 * and does not depend on database spatial extensions.
 */

import { z } from 'zod';

export interface GeoJSONPoint {
  type: 'Point';
  coordinates: [number, number];
}

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface GeographicBoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
  crossesAntimeridian: boolean;
  includesAllLongitudes: boolean;
}

export const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const GeometryPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
});

export const GeometryPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

const EARTH_RADIUS_KM = 6371;

function normalizeLongitudeRadians(radians: number): number {
  const fullTurn = 2 * Math.PI;
  return ((radians + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

export const SpatialUtils = {
  createPoint(latitude: number, longitude: number): string {
    const point: GeoJSONPoint = {
      type: 'Point',
      coordinates: [longitude, latitude],
    };
    return JSON.stringify(point);
  },

  parsePoint(
    geometryString: string | null
  ): { latitude: number; longitude: number } | null {
    if (!geometryString) return null;

    try {
      const geometry = JSON.parse(geometryString);

      if (geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) {
        return null;
      }

      const [longitude, latitude] = geometry.coordinates;

      if (typeof longitude !== 'number' || typeof latitude !== 'number') {
        return null;
      }

      return { latitude, longitude };
    } catch {
      return null;
    }
  },

  createPolygon(coordinates: number[][][]): string {
    const polygon: GeoJSONPolygon = {
      type: 'Polygon',
      coordinates,
    };
    return JSON.stringify(polygon);
  },

  parsePolygon(geometryString: string | null): number[][][] | null {
    if (!geometryString) return null;

    try {
      const geometry = JSON.parse(geometryString);

      if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
        return null;
      }

      return geometry.coordinates;
    } catch {
      return null;
    }
  },

  validateGeometry(geometryString: string | null): boolean {
    if (!geometryString) return false;

    try {
      const geometry = JSON.parse(geometryString);

      if (!geometry.type || !geometry.coordinates) {
        return false;
      }

      if (geometry.type === 'Point') {
        return GeometryPointSchema.safeParse(geometry).success;
      }

      if (geometry.type === 'Polygon') {
        return GeometryPolygonSchema.safeParse(geometry).success;
      }

      return false;
    } catch {
      return false;
    }
  },

  validateCoordinates(latitude: number, longitude: number): boolean {
    return CoordinateSchema.safeParse({ latitude, longitude }).success;
  },

  /**
   * Calculate distance between two points using the Haversine formula.
   * Returns distance in meters.
   */
  calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
  ): number {
    const radiusMeters = EARTH_RADIUS_KM * 1000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return radiusMeters * c;
  },

  /**
   * Return a conservative spherical bounding box for a radius search.
   * The box is safe as a database prefilter: exact inclusion still comes from
   * Haversine distance. Near a pole longitude is intentionally unrestricted.
   */
  calculateBoundingBox(
    latitude: number,
    longitude: number,
    radiusKm: number
  ): GeographicBoundingBox {
    if (!this.validateCoordinates(latitude, longitude)) {
      throw new Error('Invalid coordinates for bounding box');
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new Error('Radius must be a non-negative finite number');
    }

    if (radiusKm === 0) {
      return {
        north: latitude,
        south: latitude,
        east: longitude,
        west: longitude,
        crossesAntimeridian: false,
        includesAllLongitudes: false,
      };
    }

    const latitudeRadians = this.toRadians(latitude);
    const longitudeRadians = this.toRadians(longitude);
    const angularDistance = radiusKm / EARTH_RADIUS_KM;
    const halfPi = Math.PI / 2;

    const rawSouth = latitudeRadians - angularDistance;
    const rawNorth = latitudeRadians + angularDistance;
    const southRadians = Math.max(-halfPi, rawSouth);
    const northRadians = Math.min(halfPi, rawNorth);

    const south = this.toDegrees(southRadians);
    const north = this.toDegrees(northRadians);

    if (
      rawSouth <= -halfPi ||
      rawNorth >= halfPi ||
      angularDistance >= Math.PI
    ) {
      return {
        north,
        south,
        east: 180,
        west: -180,
        crossesAntimeridian: false,
        includesAllLongitudes: true,
      };
    }

    const cosineLatitude = Math.cos(latitudeRadians);
    const longitudeRatio = Math.sin(angularDistance) / cosineLatitude;

    if (Math.abs(longitudeRatio) >= 1) {
      return {
        north,
        south,
        east: 180,
        west: -180,
        crossesAntimeridian: false,
        includesAllLongitudes: true,
      };
    }

    const longitudeDelta = Math.asin(longitudeRatio);
    const westRadians = normalizeLongitudeRadians(
      longitudeRadians - longitudeDelta
    );
    const eastRadians = normalizeLongitudeRadians(
      longitudeRadians + longitudeDelta
    );
    const west = this.toDegrees(westRadians);
    const east = this.toDegrees(eastRadians);

    return {
      north,
      south,
      east,
      west,
      crossesAntimeridian: west > east,
      includesAllLongitudes: false,
    };
  },

  isPointInBounds(
    latitude: number,
    longitude: number,
    bounds: { north: number; south: number; east: number; west: number }
  ): boolean {
    return (
      latitude >= bounds.south &&
      latitude <= bounds.north &&
      longitude >= bounds.west &&
      longitude <= bounds.east
    );
  },

  toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
  },

  toDegrees(radians: number): number {
    return (radians * 180) / Math.PI;
  },
};
