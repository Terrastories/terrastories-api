// Example: Complete route with validation and tests
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Request/Response schemas
const getUserParamsSchema = z.object({
  id: z.string().uuid(),
});

const userResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.string().datetime(),
});

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /users/:id
  fastify.get(
    '/users/:id',
    {
      schema: {
        params: zodToJsonSchema(getUserParamsSchema),
        response: {
          200: zodToJsonSchema(userResponseSchema),
          404: zodToJsonSchema(
            z.object({
              error: z.string(),
            })
          ),
        },
        tags: ['Users'],
        summary: 'Get user by ID',
      },
    },
    async (request, reply) => {
      const { id } = getUserParamsSchema.parse(request.params);

      try {
        const user = await fastify.userService.getById(id);

        if (!user) {
          return reply.status(404).send({ error: 'User not found' });
        }

        return userResponseSchema.parse(user);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
};
