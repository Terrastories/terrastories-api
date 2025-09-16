/**
 * Tests for Issue #106: Complete database migrations for all missing columns
 *
 * This test verifies that all columns defined in schema files are actually
 * present in the database after migrations are applied.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Issue #106 - Database Migration Completeness', () => {
  const testDbPath = resolve('./test-migration.db');
  let db: Database.Database;

  beforeAll(async () => {
    // Clean up any existing test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Create test database
    db = new Database(testDbPath);

    // Run migrations directly using drizzle
    const drizzleDb = drizzle(db);
    const migrationsFolder = path.resolve(__dirname, '../../src/db/migrations');

    console.log('🔍 Migration folder:', migrationsFolder);

    // List migration files to debug
    const fs = await import('fs');
    const migrations = fs.readdirSync(migrationsFolder);
    console.log(
      '📁 Available migrations:',
      migrations.filter((f) => f.endsWith('.sql'))
    );

    await migrate(drizzleDb, { migrationsFolder });

    // Debug: Check what tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    console.log(
      '📊 Created tables:',
      tables.map((t: any) => t.name)
    );

    // Debug: Check places table structure
    const placesSchema = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='places'"
      )
      .get();
    console.log('🏗️ Places schema:', (placesSchema as any)?.sql);
  });

  afterAll(() => {
    db?.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('Places table schema completeness', () => {
    it('should have photo_url column defined in schema', () => {
      const schema = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='places'"
        )
        .get();
      expect(schema?.sql).toBeDefined();
      expect(schema!.sql).toContain('photo_url');
    });

    it('should allow inserting places with photo_url', async () => {
      const insertPlace = db.prepare(`
        INSERT INTO places (name, description, community_id, latitude, longitude, photo_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      const result = insertPlace.run(
        'Test Place',
        'A test place with photo',
        1, // assuming community id 1 exists
        45.0,
        -122.0,
        'https://example.com/photo.jpg',
        now,
        now
      );

      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeDefined();
    });

    it('should allow NULL values for photo_url', () => {
      const insertPlace = db.prepare(`
        INSERT INTO places (name, community_id, latitude, longitude, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      const result = insertPlace.run(
        'Test Place No Photo',
        1,
        45.1,
        -122.1,
        now,
        now
      );
      expect(result.changes).toBe(1);
    });
  });

  describe('Stories table schema completeness', () => {
    it('should have image_url column', () => {
      const schema = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='stories'"
        )
        .get();
      expect(schema?.sql).toBeDefined();
      expect(schema!.sql).toContain('image_url');
    });

    it('should have audio_url column', () => {
      const schema = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='stories'"
        )
        .get();
      expect(schema?.sql).toBeDefined();
      expect(schema!.sql).toContain('audio_url');
    });

    it('should allow inserting stories with media URLs', () => {
      const insertStory = db.prepare(`
        INSERT INTO stories (
          title, slug, community_id, created_by, image_url, audio_url,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      const result = insertStory.run(
        'Test Story',
        'test-story',
        1,
        1, // assuming user id 1 exists
        'https://example.com/image.jpg',
        'https://example.com/audio.mp3',
        now,
        now
      );

      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeDefined();
    });
  });

  describe('Speakers table schema completeness', () => {
    it('should have bio_audio_url column', () => {
      const schema = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='speakers'"
        )
        .get();
      expect(schema?.sql).toBeDefined();
      expect(schema!.sql).toContain('bio_audio_url');
    });

    it('should allow inserting speakers with bio_audio_url', () => {
      const insertSpeaker = db.prepare(`
        INSERT INTO speakers (name, community_id, bio_audio_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      const result = insertSpeaker.run(
        'Test Speaker',
        1,
        'https://example.com/bio-audio.mp3',
        now,
        now
      );

      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeDefined();
    });
  });

  describe('Database seeding integration', () => {
    it('should be able to run seeding without column errors', () => {
      // This test verifies that the database can be seeded after migrations
      // Test seeding directly using the test database instead of external script
      expect(() => {
        // Test inserting sample data to verify columns exist
        const now = new Date();

        // Insert a test community with all expected columns
        db.prepare(
          `
          INSERT INTO communities (name, description, slug, public_stories, locale, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          'Test Seed Community',
          'Test description',
          'test-seed-123',
          1,
          'en',
          now.getTime(),
          now.getTime()
        );

        // Insert a test user with all expected columns
        db.prepare(
          `
          INSERT INTO users (first_name, last_name, email, password_hash, role, community_id, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          'Test',
          'User',
          'test@seed.com',
          'hash123',
          'admin',
          1,
          1,
          now.getTime(),
          now.getTime()
        );

        // Insert a test place with all expected columns including media ones
        db.prepare(
          `
          INSERT INTO places (name, description, community_id, latitude, longitude, region, media_urls, cultural_significance, is_restricted, created_at, updated_at, photo_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          'Test Place',
          'Test place description',
          1,
          49.0,
          -123.0,
          'Test Region',
          '[]',
          'Test significance',
          0,
          now.getTime(),
          now.getTime(),
          null
        );

        // Insert a test speaker with all expected columns
        db.prepare(
          `
          INSERT INTO speakers (name, bio, community_id, photo_url, elder_status, cultural_role, is_active, created_at, updated_at, bio_audio_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          'Test Speaker',
          'Test bio',
          1,
          null,
          0,
          'Test role',
          1,
          now.getTime(),
          now.getTime(),
          null
        );
      }).not.toThrow();
    });

    it('should have all required tables after successful migration', () => {
      const tables = db
        .prepare(
          `
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'
        ORDER BY name
      `
        )
        .all();

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('places');
      expect(tableNames).toContain('stories');
      expect(tableNames).toContain('speakers');
      expect(tableNames).toContain('communities');
      expect(tableNames).toContain('users');
    });
  });

  describe('Migration system validation', () => {
    it('should have migration history recorded', () => {
      const migrations = db
        .prepare('SELECT * FROM __drizzle_migrations ORDER BY id')
        .all();
      expect(migrations.length).toBeGreaterThan(0);
    });

    it('should be able to run migrations multiple times (idempotent)', () => {
      expect(() => {
        execSync('npm run db:migrate', {
          env: { ...process.env, DATABASE_URL: `sqlite:${testDbPath}` },
          stdio: 'pipe',
        });
      }).not.toThrow();
    });
  });
});
