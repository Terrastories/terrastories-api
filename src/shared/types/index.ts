/**
 * Shared types for the Terrastories API
 */

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  communityId: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Community {
  id: number;
  name: string;
  description?: string;
  slug: string;
  publicStories: boolean;
  locale: string;
  culturalSettings?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Place {
  id: number;
  name: string;
  description?: string;
  latitude: number;
  longitude: number;
  region?: string;
  mediaUrls: string[];
  culturalSignificance?: string;
  isRestricted: boolean;
  communityId: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Speaker {
  id: number;
  name: string;
  bio?: string;
  photoUrl?: string;
  birthYear?: number;
  elderStatus: boolean;
  culturalRole?: string;
  communityId: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface File {
  id: string;
  filename: string;
  originalName: string;
  path: string;
  url: string;
  mimeType: string;
  size: number;
  communityId: number;
  uploadedBy: number;
  metadata?: Record<string, unknown>;
  culturalRestrictions?: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
