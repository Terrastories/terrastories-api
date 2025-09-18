#!/usr/bin/env tsx

import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {
  communitiesSqlite,
  usersSqlite,
  placesSqlite,
  speakersSqlite,
  type Community,
  type User,
  type Place,
  type Speaker,
} from './schema/index.js';
import { getConfig } from '../shared/config/index.js';
import { hashPassword } from '../services/password.service.js';

/**
 * Development Database Seeder
 * Creates test data for development and user workflow testing
 */

interface SeedData {
  communities: Array<{
    id: number;
    name: string;
    slug: string;
  }>;
  users: Array<{
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    communityId: number;
  }>;
  places: Array<{
    id: number;
    name: string;
    communityId: number;
  }>;
  speakers: Array<{
    id: number;
    name: string;
    communityId: number;
  }>;
}

async function seedDatabase(): Promise<SeedData> {
  const config = getConfig();
  console.log('🌱 Starting database seeding...');
  console.log(`📊 Database: ${config.database.url}`);

  // Determine database type and create connection
  let db: any;

  if (
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://')
  ) {
    const err = new Error(
      'PostgreSQL seeding not implemented. Use SQLite (DATABASE_URL=./data.db) for now.'
    );
    console.error('❌', err.message);
    throw err;
  } else {
    // SQLite connection
    const sqlite = new Database(
      config.database.url === ':memory:' ? ':memory:' : config.database.url
    );
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, {
      schema: {
        communities: communitiesSqlite,
        users: usersSqlite,
        places: placesSqlite,
        speakers: speakersSqlite,
      },
    });
    console.log('🔗 Connected to SQLite database');
  }

  try {
    // Clear existing data
    console.log('🗑️ Clearing existing seed data...');
    await db.delete(usersSqlite);
    await db.delete(speakersSqlite);
    await db.delete(placesSqlite);
    await db.delete(communitiesSqlite);
    console.log('✅ Existing data cleared');

    // Create communities
    console.log('🏘️ Creating test communities...');
    const timestamp = Date.now();
    const now = new Date();
    const testCommunities = await db
      .insert(communitiesSqlite)
      .values([
        {
          name: 'Demo Community',
          description: 'A demonstration community for development and testing',
          slug: `demo-community-${timestamp}`,
          publicStories: true,
          locale: 'en',
          culturalSettings: JSON.stringify({
            languagePreferences: ['en'],
            elderContentRestrictions: false,
            ceremonialContent: false,
            traditionalKnowledge: false,
            communityApprovalRequired: false,
            dataRetentionPolicy: 'community-controlled',
            accessRestrictions: [],
          }),
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          name: 'Test Indigenous Community',
          description:
            'A test community representing Indigenous cultural protocols',
          slug: `indigenous-test-${timestamp}`,
          publicStories: false,
          locale: 'en',
          culturalSettings: JSON.stringify({
            languagePreferences: ['en', 'indigenous-lang'],
            elderContentRestrictions: true,
            ceremonialContent: true,
            traditionalKnowledge: true,
            communityApprovalRequired: true,
            dataRetentionPolicy: 'community-controlled',
            accessRestrictions: ['elder-only', 'community-member-only'],
          }),
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning();

    console.log(`✅ Created ${testCommunities.length} communities`);

    // Create users with hashed passwords
    console.log('👥 Creating test users...');
    const hashedPassword = await hashPassword('TestPassword123!');
    const superAdminPassword = await hashPassword('superpass');

    const demoUsers = await db
      .insert(usersSqlite)
      .values([
        // Super admin for workflow script testing
        {
          firstName: 'Super',
          lastName: 'Admin',
          email: 'super@example.com',
          passwordHash: superAdminPassword,
          role: 'super_admin',
          communityId: testCommunities[0].id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          firstName: 'Admin',
          lastName: 'User',
          email: 'admin@demo.com',
          passwordHash: hashedPassword,
          role: 'admin',
          communityId: testCommunities[0].id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          firstName: 'Editor',
          lastName: 'User',
          email: 'editor@demo.com',
          passwordHash: hashedPassword,
          role: 'editor',
          communityId: testCommunities[0].id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          firstName: 'Elder',
          lastName: 'Wisdom',
          email: 'elder@indigenous.com',
          passwordHash: hashedPassword,
          role: 'admin',
          communityId: testCommunities[1].id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          firstName: 'Community',
          lastName: 'Member',
          email: 'member@indigenous.com',
          passwordHash: hashedPassword,
          role: 'viewer',
          communityId: testCommunities[1].id,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning();

    console.log(
      `✅ Created ${demoUsers.length} users (password: TestPassword123!)`
    );

    // Create test places
    console.log('📍 Creating test places...');
    const testPlaces = await db
      .insert(placesSqlite)
      .values([
        {
          name: 'Demo Sacred Mountain',
          description: 'A sacred mountain used for demonstrations and testing',
          latitude: 49.2827, // Vancouver, BC area
          longitude: -123.1207,
          region: 'Pacific Northwest',
          culturalSignificance: 'Sacred site for ceremonies and gatherings',
          isRestricted: false,
          communityId: testCommunities[0].id,
          mediaUrls: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          name: 'Traditional Gathering Place',
          description: 'Historic gathering place for the community',
          latitude: 49.3,
          longitude: -123.1,
          region: 'Traditional Territory',
          culturalSignificance: 'Traditional meeting and ceremony location',
          isRestricted: true,
          communityId: testCommunities[1].id,
          mediaUrls: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          name: 'Storytelling Circle',
          description: 'Ancient storytelling location by the river',
          latitude: 49.25,
          longitude: -123.15,
          region: 'Riverside',
          culturalSignificance: 'Location for oral tradition sharing',
          isRestricted: false,
          communityId: testCommunities[0].id,
          mediaUrls: [],
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning();

    console.log(`✅ Created ${testPlaces.length} places`);

    // Create test speakers
    console.log('🎤 Creating test speakers...');
    const testSpeakers = await db
      .insert(speakersSqlite)
      .values([
        {
          name: 'Elder Sarah Thompson',
          bio: 'Traditional storyteller and community elder with decades of oral tradition knowledge',
          photoUrl: null,
          communityId: testCommunities[1].id,
          culturalRole: 'Traditional storyteller and knowledge keeper',
          elderStatus: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          name: 'David Wilson',
          bio: 'Community historian and cultural preservation advocate',
          photoUrl: null,
          communityId: testCommunities[0].id,
          culturalRole: 'Community historian',
          elderStatus: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          name: 'Maria Rodriguez',
          bio: 'Youth cultural program coordinator and traditional arts teacher',
          photoUrl: null,
          communityId: testCommunities[0].id,
          culturalRole: 'Cultural educator',
          elderStatus: false,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning();

    console.log(`✅ Created ${testSpeakers.length} speakers`);

    // Prepare seed data summary
    const seedData: SeedData = {
      communities: testCommunities.map((c: Community) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
      })),
      users: demoUsers.map((u: User) => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        communityId: u.communityId,
      })),
      places: testPlaces.map((p: Place) => ({
        id: p.id,
        name: p.name,
        communityId: p.communityId,
      })),
      speakers: testSpeakers.map((s: Speaker) => ({
        id: s.id,
        name: s.name,
        communityId: s.communityId,
      })),
    };

    console.log('\n🎉 Database seeding completed successfully!');
    console.log('\n📋 Seed Data Summary:');
    console.log('┌─ Communities:');
    seedData.communities.forEach((c) =>
      console.log(`│  - ${c.name} (ID: ${c.id}, slug: ${c.slug})`)
    );
    console.log('├─ Users:');
    seedData.users.forEach((u) =>
      console.log(
        `│  - ${u.firstName} ${u.lastName} (${u.email}) - ${u.role} in Community ${u.communityId}`
      )
    );
    console.log('├─ Places:');
    seedData.places.forEach((p) =>
      console.log(`│  - ${p.name} (ID: ${p.id}) in Community ${p.communityId}`)
    );
    console.log('└─ Speakers:');
    seedData.speakers.forEach((s) =>
      console.log(`   - ${s.name} (ID: ${s.id}) in Community ${s.communityId}`)
    );

    console.log('\n🔐 All users have password: TestPassword123!');
    console.log('\n🚀 Ready for development and user workflow testing!');

    return seedData;
  } catch (error) {
    console.error('❌ Database seeding failed:', error);
    throw error;
  }
}

// Run seeding if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedDatabase()
    .then(() => {
      console.log('\n✅ Seeding script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Seeding script failed:', error);
      process.exit(1);
    });
}

export { seedDatabase };
