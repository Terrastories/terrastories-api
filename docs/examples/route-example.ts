// Example: Complete route with validation and tests
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { UserNotFoundError } from '../../services/userService';

// Define Zod schemas for validation
const ParamsSchema = z.object({
  id: z.string().uuid('Invalid user ID format'),
});

const UserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.date(), // Use z.date() for better type safety, Fastify will serialize it
});

// Define a type for the request with validated params
type GetUserRequest = FastifyRequest<{
  Params: z.infer<typeof ParamsSchema>;
}>;

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /users/:id
  fastify.get(
    '/users/:id',
    {
      schema: {
        params: zodToJsonSchema(ParamsSchema),
        response: {
          200: zodToJsonSchema(UserResponseSchema),
          // Add other status codes for better API documentation
          404: zodToJsonSchema(z.object({ error: z.string() })),
          500: zodToJsonSchema(z.object({ error: z.string() })),
        },
        tags: ['Users'],
        summary: 'Get a user by their ID',
      },
    },
    async (request: GetUserRequest, reply) => {
      // No need to parse params manually, Fastify does it.
      // `request.params` is already validated and typed.
      const { id } = request.params;

      try {
        const user = await fastify.userService.getUserById(id);
        // No need to parse user, the service returns the correct type.
        // Fastify will automatically serialize the Date object to a string.
        return user;
      } catch (error) {
        fastify.log.error(error, `Error fetching user with id ${id}`);
        // Handle custom errors from the service layer
        if (error instanceof UserNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        // Fallback for unexpected errors
        return reply.status(500).send({ error: 'An unexpected error occurred' });
      }
    }
  );
};
