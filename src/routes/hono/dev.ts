/**
 * Hono Dev Routes
 *
 * V2 equivalent of Fastify dev routes.
 * Development-only endpoints for seeding test data and debugging.
 * Mounted at /v2/dev/*
 *
 * NOTE: No auth middleware — these are dev/seed endpoints.
 * They should only be enabled in non-production environments.
 */

import { Hono } from 'hono';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Database } from '../../db/index.js';
import { CommunityRepository } from '../../repositories/community.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { UserService } from '../../services/user.service.js';
import { SpeakerRepository } from '../../repositories/speaker.repository.js';
import { PlaceRepository } from '../../repositories/place.repository.js';
import { StoryRepository } from '../../repositories/story.repository.js';
import type { AppEnv } from '../../hono-app.js';

export function createDevRoutes(database?: Database): Hono<AppEnv> {
  const dev = new Hono<AppEnv>();

  const db = database;
  if (!db) return dev;

  // ========================================
  // GET /dev/seed — Seed development test data
  // ========================================
  dev.get('/seed', async (c) => {
    try {
      const communityRepo = new CommunityRepository(db);
      const userRepo = new UserRepository(db);
      const userService = new UserService(userRepo, communityRepo);
      const speakerRepo = new SpeakerRepository(db);
      const placeRepo = new PlaceRepository(db);
      const storyRepo = new StoryRepository(
        db as unknown as BetterSQLite3Database<Record<string, unknown>>
      );

      // Check for existing communities first (idempotent approach)
      let community = await communityRepo.findBySlug('demo-community-primary');
      let community2 = await communityRepo.findBySlug(
        'demo-community-secondary'
      );

      // Create primary test community if it doesn't exist
      if (!community) {
        community = await communityRepo.create({
          name: 'Anishinaabe Demo Community',
          description:
            'Primary development community for Indigenous storytelling workflow testing',
          slug: 'demo-community-primary',
          locale: 'en',
          publicStories: false,
          isActive: true,
        });
      }

      // Create second community if it doesn't exist
      if (!community2) {
        community2 = await communityRepo.create({
          name: 'Métis Demo Community',
          description: 'Secondary community for data sovereignty validation',
          slug: 'demo-community-secondary',
          locale: 'en',
          publicStories: false,
          isActive: true,
        });
      }

      // Create or get existing super admin user with expected workflow credentials
      let superAdmin;
      try {
        superAdmin = await userService.createUserAsSuperAdmin({
          email: 'super@example.com',
          password: 'SuperPass123!',
          firstName: 'Super',
          lastName: 'Admin',
          role: 'super_admin',
          communityId: community.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('already exists')
        ) {
          console.info(
            'Super admin already exists, continuing with existing user'
          );
          superAdmin = { id: 1, email: 'super@example.com' };
        } else {
          throw error;
        }
      }

      // Create or get existing cultural admin user expected by workflow script
      let culturalAdmin;
      try {
        culturalAdmin = await userService.createUserInCommunity({
          email: 'cultural.admin@anishinaabe.ca',
          password: 'CulturalAdmin2024!',
          firstName: 'Maria',
          lastName: 'Thunderbird',
          role: 'admin',
          communityId: community.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('already exists') ||
            error.name === 'DuplicateEmailError')
        ) {
          console.info(
            'Cultural admin already exists, checking community association'
          );
          try {
            const userInTargetCommunity =
              await userRepo.findByEmailInCommunity(
                'cultural.admin@anishinaabe.ca',
                community.id
              );

            if (userInTargetCommunity) {
              culturalAdmin = userInTargetCommunity;
              console.info(
                `Cultural admin already in community ${community.id}`
              );
            } else {
              console.info(
                'Cultural admin exists in different community, using target community reference'
              );
              culturalAdmin = {
                id: 2,
                email: 'cultural.admin@anishinaabe.ca',
                communityId: community.id,
              };
            }
          } catch (lookupError) {
            console.warn(
              'Could not look up existing user, using fallback:',
              lookupError
            );
            culturalAdmin = {
              id: 2,
              email: 'cultural.admin@anishinaabe.ca',
              communityId: community.id,
            };
          }
        } else {
          throw error;
        }
      }

      // Create or get existing fallback admin user (for backwards compatibility)
      let fallbackAdmin;
      try {
        fallbackAdmin = await userService.createUserInCommunity({
          email: 'admin@demo.com',
          password: 'TestPassword123!',
          firstName: 'Admin',
          lastName: 'User',
          role: 'admin',
          communityId: community.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('already exists') ||
            error.name === 'DuplicateEmailError')
        ) {
          console.info(
            'Fallback admin already exists, checking community association'
          );
          try {
            const userInTargetCommunity =
              await userRepo.findByEmailInCommunity(
                'admin@demo.com',
                community.id
              );

            if (userInTargetCommunity) {
              fallbackAdmin = userInTargetCommunity;
              console.info(
                `Fallback admin already in community ${community.id}`
              );
            } else {
              console.info(
                'Fallback admin exists in different community, using target community reference'
              );
              fallbackAdmin = {
                id: 3,
                email: 'admin@demo.com',
                communityId: community.id,
              };
            }
          } catch (lookupError) {
            console.warn(
              'Could not look up existing fallback admin, using fallback:',
              lookupError
            );
            fallbackAdmin = {
              id: 3,
              email: 'admin@demo.com',
              communityId: community.id,
            };
          }
        } else {
          throw error;
        }
      }

      // Create or get existing editor user expected by workflow
      let editor;
      try {
        editor = await userService.createUserInCommunity({
          email: 'editor.test@anishinaabe.ca',
          password: 'EditorTest2024!',
          firstName: 'Alex',
          lastName: 'Storyteller',
          role: 'editor',
          communityId: community.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('already exists')
        ) {
          console.info(
            'Editor user already exists, continuing with existing user'
          );
          editor = { id: 4, email: 'editor.test@anishinaabe.ca' };
        } else {
          throw error;
        }
      }

      // Create or get existing viewer user expected by workflow
      let viewer;
      try {
        viewer = await userService.createUserInCommunity({
          email: 'community.member@anishinaabe.ca',
          password: 'ViewerAccess2024!',
          firstName: 'Sarah',
          lastName: 'Whitecloud',
          role: 'viewer',
          communityId: community.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('already exists')
        ) {
          console.info(
            'Viewer user already exists, continuing with existing user'
          );
          viewer = { id: 5, email: 'community.member@anishinaabe.ca' };
        } else {
          throw error;
        }
      }

      // Create or get existing second community admin for data sovereignty testing
      let admin2;
      try {
        admin2 = await userService.createUserInCommunity({
          email: 'admin2@metis.ca',
          password: 'MetisAdmin2024!',
          firstName: 'Louis',
          lastName: 'Riel',
          role: 'admin',
          communityId: community2.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('already exists')
        ) {
          console.info(
            'Admin2 user already exists, continuing with existing user'
          );
          admin2 = { id: 6, email: 'admin2@metis.ca' };
        } else {
          throw error;
        }
      }

      // Create test speaker (in primary community)
      const speaker = await speakerRepo.create({
        name: 'Elder Joseph Crow Feather',
        bio: 'Traditional knowledge keeper and storyteller of the Anishinaabe Nation.',
        communityId: community.id,
        elderStatus: true,
        culturalRole: 'Knowledge Keeper',
        isActive: true,
      });

      // Create test place (in primary community)
      const place = await placeRepo.create({
        name: 'Grandmother Turtle Rock',
        description: 'Sacred teaching site where creation stories are shared.',
        latitude: 45.4215,
        longitude: -75.6972,
        communityId: community.id,
        region: 'Traditional Territory',
        culturalSignificance: 'Sacred Teaching Site',
        isRestricted: false,
      });

      // Create test story (in primary community)
      const story = await storyRepo.create({
        title: 'The Teaching of the Seven Fires',
        description:
          'Ancient prophecy story about the spiritual journey of the Anishinaabe people.',
        communityId: community.id,
        createdBy: culturalAdmin.id,
        isRestricted: false,
        language: 'en',
        tags: ['prophecy', 'ceremony', 'traditional-teaching'],
        speakerIds: [speaker.id],
        placeIds: [place.id],
      });

      return c.json(
        {
          message:
            'Development data seeded successfully with deterministic IDs',
          data: {
            community: {
              id: community.id,
              name: community.name,
              slug: 'demo-community-primary',
            },
            community2: {
              id: community2.id,
              name: community2.name,
              slug: 'demo-community-secondary',
            },
            users: {
              superAdmin: { id: superAdmin.id, email: superAdmin.email },
              culturalAdmin: {
                id: culturalAdmin.id,
                email: culturalAdmin.email,
              },
              fallbackAdmin: {
                id: fallbackAdmin.id,
                email: fallbackAdmin.email,
              },
              editor: { id: editor.id, email: editor.email },
              viewer: { id: viewer.id, email: viewer.email },
              admin2: { id: admin2.id, email: admin2.email },
            },
            speaker: { id: speaker.id, name: speaker.name },
            place: { id: place.id, name: place.name },
            story: { id: story.id, title: story.title },
          },
        },
        200
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Seeding error:', error);

      return c.json(
        {
          error: 'Failed to seed development data',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
        500
      );
    }
  });

  return dev;
}
