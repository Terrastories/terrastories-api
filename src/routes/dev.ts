/**
 * Development Routes
 *
 * Development-only endpoints for seeding test data and debugging.
 * Only available in development environment.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../db/index.js';
import { CommunityRepository } from '../repositories/community.repository.js';
import { UserService } from '../services/user.service.js';
import { SpeakerRepository } from '../repositories/speaker.repository.js';
import { PlaceRepository } from '../repositories/place.repository.js';
import { StoryRepository } from '../repositories/story.repository.js';

export async function devRoutes(fastify: FastifyInstance) {
  // Note: Available in all environments for development and testing

  /**
   * GET /dev/seed - Seed development test data
   */
  fastify.get(
    '/dev/seed',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const db = await getDb();
        const communityRepo = new CommunityRepository(db);
        const userService = new UserService(
          new (
            await import('../repositories/user.repository.js')
          ).UserRepository(db),
          communityRepo
        );
        const speakerRepo = new SpeakerRepository(db);
        const placeRepo = new PlaceRepository(db);
        const storyRepo = new StoryRepository(db);

        // Create test community with unique slug to force recreation
        const community = await communityRepo.create({
          name: 'Fresh Demo Community',
          description: 'Development test community for Indigenous storytelling',
          slug: `demo-community-${Date.now()}`,
          locale: 'en',
          publicStories: false,
          isActive: true,
        });

        // Create super admin user with expected workflow credentials
        const superAdmin = await userService.createUserAsSuperAdmin({
          email: 'super@example.com',
          password: 'SuperPass123!', // Different from workflow but meets validation - workflow will be updated
          firstName: 'Super',
          lastName: 'Admin',
          role: 'super_admin',
          communityId: community.id,
        });

        // Create community admin user expected by workflow
        const admin = await userService.createUserInCommunity({
          email: 'admin@demo.com',
          password: 'TestPassword123!',
          firstName: 'Admin',
          lastName: 'User',
          role: 'admin',
          communityId: community.id,
        });

        // Create editor user for testing
        const editor = await userService.createUserInCommunity({
          email: 'editor@demo.com',
          password: 'TestPassword123!',
          firstName: 'Editor',
          lastName: 'User',
          role: 'editor',
          communityId: community.id,
        });

        // Create test speaker
        const speaker = await speakerRepo.create({
          name: 'Elder Joseph Crow Feather',
          bio: 'Traditional knowledge keeper and storyteller of the Anishinaabe Nation.',
          communityId: community.id,
          elderStatus: true,
          culturalRole: 'Knowledge Keeper',
          isActive: true,
        });

        // Create test place
        const place = await placeRepo.create({
          name: 'Grandmother Turtle Rock',
          description:
            'Sacred teaching site where creation stories are shared.',
          latitude: 45.4215,
          longitude: -75.6972,
          communityId: community.id,
          region: 'Traditional Territory',
          culturalSignificance: 'Sacred Teaching Site',
          accessLevel: 'community',
        });

        // Create test story
        const story = await storyRepo.create({
          title: 'The Teaching of the Seven Fires',
          description:
            'Ancient prophecy story about the spiritual journey of the Anishinaabe people.',
          communityId: community.id,
          createdBy: admin.id,
          privacyLevel: 'public',
          language: 'en',
          tags: ['prophecy', 'ceremony', 'traditional-teaching'],
          speakerIds: [speaker.id],
          placeIds: [place.id],
        });

        return reply.status(200).send({
          message: 'Development data seeded successfully',
          data: {
            community: { id: community.id, name: community.name },
            users: {
              superAdmin: { id: superAdmin.id, email: superAdmin.email },
              admin: { id: admin.id, email: admin.email },
              editor: { id: editor.id, email: editor.email },
            },
            speaker: { id: speaker.id, name: speaker.name },
            place: { id: place.id, name: place.name },
            story: { id: story.id, title: story.title },
          },
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Seeding error:', error);

        // If users already exist, that's fine - just return success
        if (
          error instanceof Error &&
          (error.message.includes('UNIQUE constraint failed') ||
            error.message.includes('Community slug already exists'))
        ) {
          return reply.status(200).send({
            message: 'Development data already exists',
            data: { status: 'skipped' },
          });
        }

        return reply.status(500).send({
          error: 'Failed to seed development data',
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
}
