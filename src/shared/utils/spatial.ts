/**
 * Spatial Utilities for Geographic Data Processing
 *
 * Provides cross-database spatial utilities for both PostgreSQL/PostGIS
 * and SQLite environments with graceful fallbacks.
 */

import { z } from 'zod';

// GeoJSON Point interface
export interface GeoJSONPoint {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
}

// GeoJSON Polygon interface
export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: number[][][]; // Array of linear rings
}

// Coordinate validation schemas
export const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const GeometryPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]), // [lng, lat] GeoJSON format
});

export const GeometryPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

/**
 * Spatial utility functions for creating and parsing geographic data
 */
export const SpatialUtils = {
  /**
   * Create a GeoJSON Point geometry from latitude and longitude
   */
  createPoint(latitude: number, longitude: number): string {
    const point: GeoJSONPoint = {
      type: 'Point',
      coordinates: [longitude, latitude], // GeoJSON uses [lng, lat] order
    };
    return JSON.stringify(point);
  },

  /**
   * Parse a GeoJSON Point geometry string to extract coordinates
   */
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

  /**
   * Create a GeoJSON Polygon geometry from coordinate array
   */
  createPolygon(coordinates: number[][][]): string {
    const polygon: GeoJSONPolygon = {
      type: 'Polygon',
      coordinates,
    };
    return JSON.stringify(polygon);
  },

  /**
   * Parse a GeoJSON Polygon geometry string
   */
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

  /**
   * Validate if a geometry string is valid GeoJSON
   */
  validateGeometry(geometryString: string | null): boolean {
    if (!geometryString) return false;

    try {
      const geometry = JSON.parse(geometryString);

      if (!geometry.type || !geometry.coordinates) {
        return false;
      }

      // Basic validation for Point and Polygon types
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

  /**
   * Validate latitude and longitude coordinates
   */
  validateCoordinates(latitude: number, longitude: number): boolean {
    return CoordinateSchema.safeParse({ latitude, longitude }).success;
  },

  /**
   * Calculate distance between two points using Haversine formula
   * Returns distance in meters
   */
  calculateDistance(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number
  ): number {
    const R = 6371000; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  },

  /**
   * Check if a point is within a bounding box
   */
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

  /**
   * Convert degrees to radians
   */
  toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
  },

  /**
   * Convert radians to degrees
   */
  toDegrees(radians: number): number {
    return (radians * 180) / Math.PI;
  },
};

// Types are already exported above as interfaces
