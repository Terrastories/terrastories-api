/**
 * Shared types for the Terrastories API
 */

export interface Logger {
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
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
  metadata?: any;
  culturalRestrictions?: any;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}