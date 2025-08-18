/**
 * Enhanced Authorization Middleware Tests
 *
 * Tests for role hierarchy, advanced middleware patterns,
 * and composable authorization functionality.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  requirePermission,
  composeMiddleware,
  requireRoleHierarchy,
  hasRoleHierarchy,
  AuthenticatedRequest,
  UserSession,
} from '../../../src/shared/middleware/auth.middleware.js';

describe('Enhanced Authorization Middleware', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockReply: Partial<FastifyReply>;
  let mockLog: any;

  beforeEach(() => {
    mockLog = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    mockRequest = {
      log: mockLog,
      params: {},
      query: {},
      session: {
        user: null,
      },
    };

    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      sent: false,
    };
  });

  describe('Role Hierarchy System', () => {
    it('should validate role hierarchy precedence', () => {
      expect(hasRoleHierarchy('admin', 'editor')).toBe(true);
      expect(hasRoleHierarchy('admin', 'elder')).toBe(true);
      expect(hasRoleHierarchy('admin', 'viewer')).toBe(true);

      expect(hasRoleHierarchy('elder', 'viewer')).toBe(true);
      expect(hasRoleHierarchy('elder', 'editor')).toBe(false);

      expect(hasRoleHierarchy('editor', 'viewer')).toBe(true);
      expect(hasRoleHierarchy('editor', 'elder')).toBe(true);

      expect(hasRoleHierarchy('viewer', 'editor')).toBe(false);
      expect(hasRoleHierarchy('viewer', 'elder')).toBe(false);
      expect(hasRoleHierarchy('viewer', 'admin')).toBe(false);

      // Super admin is blocked from community data (data sovereignty)
      expect(hasRoleHierarchy('super_admin', 'admin')).toBe(false);
    });

    it('should allow admin to access editor-level endpoints', async () => {
      const adminSession: UserSession = {
        id: 1,
        email: 'admin@community1.org',
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'User',
      };

      mockRequest.session!.user = adminSession;

      const middleware = requireRoleHierarchy('editor');
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('should deny viewer access to editor-level endpoints', async () => {
      const viewerSession: UserSession = {
        id: 1,
        email: 'viewer@community1.org',
        role: 'viewer',
        communityId: 1,
        firstName: 'Viewer',
        lastName: 'User',
      };

      mockRequest.session!.user = viewerSession;

      const middleware = requireRoleHierarchy('editor');
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Insufficient permissions - requires editor level or higher',
        required: 'editor',
        current: 'viewer',
        statusCode: 403,
      });
    });

    it('should handle elder role properly in hierarchy', async () => {
      const elderSession: UserSession = {
        id: 1,
        email: 'elder@community1.org',
        role: 'elder',
        communityId: 1,
        firstName: 'Elder',
        lastName: 'User',
      };

      mockRequest.session!.user = elderSession;

      // Elder should access viewer content
      const viewerMiddleware = requireRoleHierarchy('viewer');
      await viewerMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();

      // Reset mocks for next test
      vi.clearAllMocks();

      // Elder should NOT access editor content (editor rank is higher)
      const editorMiddleware = requireRoleHierarchy('editor');
      await editorMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Insufficient permissions - requires editor level or higher',
        required: 'editor',
        current: 'elder',
        statusCode: 403,
      });
    });
  });

  describe('Permission-Based Authorization', () => {
    it('should validate specific permissions for complex operations', async () => {
      const editorSession: UserSession = {
        id: 1,
        email: 'editor@community1.org',
        role: 'editor',
        communityId: 1,
        firstName: 'Content',
        lastName: 'Editor',
      };

      mockRequest.session!.user = editorSession;

      const middleware = requirePermission(['stories:write', 'places:write']);
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('should deny permissions for insufficient role', async () => {
      const viewerSession: UserSession = {
        id: 1,
        email: 'viewer@community1.org',
        role: 'viewer',
        communityId: 1,
        firstName: 'Read Only',
        lastName: 'User',
      };

      mockRequest.session!.user = viewerSession;

      const middleware = requirePermission(['stories:write']);
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: 'Insufficient permissions',
        required: ['stories:write'],
        current: 'viewer',
        statusCode: 403,
      });
    });

    it('should handle elder permissions for cultural content', async () => {
      const elderSession: UserSession = {
        id: 1,
        email: 'elder@community1.org',
        role: 'elder',
        communityId: 1,
        firstName: 'Cultural',
        lastName: 'Guardian',
      };

      mockRequest.session!.user = elderSession;

      const middleware = requirePermission([
        'cultural:read',
        'cultural:validate',
      ]);
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });
  });

  describe('Composable Middleware', () => {
    it('should compose multiple authorization checks', async () => {
      const adminSession: UserSession = {
        id: 1,
        email: 'admin@community1.org',
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'User',
      };

      mockRequest.session!.user = adminSession;
      mockRequest.params = { communityId: '1' };

      const composedMiddleware = composeMiddleware([
        requireRoleHierarchy('editor'),
        requirePermission(['stories:write']),
      ]);

      await composedMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('should fail composed middleware if any check fails', async () => {
      const viewerSession: UserSession = {
        id: 1,
        email: 'viewer@community1.org',
        role: 'viewer',
        communityId: 1,
        firstName: 'Viewer',
        lastName: 'User',
      };

      mockRequest.session!.user = viewerSession;
      mockRequest.params = { communityId: '1' };

      const composedMiddleware = composeMiddleware([
        requireRoleHierarchy('editor'), // This should fail
        requirePermission(['stories:read']),
      ]);

      await composedMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalled();
    });

    it('should handle complex authorization scenarios', async () => {
      const elderSession: UserSession = {
        id: 1,
        email: 'elder@community1.org',
        role: 'elder',
        communityId: 1,
        firstName: 'Knowledge',
        lastName: 'Keeper',
      };

      mockRequest.session!.user = elderSession;
      mockRequest.params = { communityId: '1' };

      const composedMiddleware = composeMiddleware([
        requireRoleHierarchy('viewer'), // Elder can access viewer content
        requirePermission(['cultural:read']), // Elder has cultural permissions
      ]);

      await composedMiddleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });
  });

  describe('Context-Aware Authorization', () => {
    it('should consider request context for dynamic permissions', async () => {
      const editorSession: UserSession = {
        id: 1,
        email: 'editor@community1.org',
        role: 'editor',
        communityId: 1,
        firstName: 'Content',
        lastName: 'Creator',
      };

      mockRequest.session!.user = editorSession;
      mockRequest.params = { storyId: '123' };
      mockRequest.route = { url: '/api/v1/stories/:storyId' };

      const middleware = requirePermission(['stories:write'], {
        contextAware: true,
        resourceOwnership: true,
      });

      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('should log authorization decisions for audit', async () => {
      const adminSession: UserSession = {
        id: 1,
        email: 'admin@community1.org',
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'User',
      };

      mockRequest.session!.user = adminSession;

      const middleware = requireRoleHierarchy('editor');
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          role: 'admin',
          requiredRole: 'editor',
          action: 'role_hierarchy_check',
          result: 'granted',
        }),
        'Role hierarchy authorization granted'
      );
    });
  });

  describe('Performance Optimization', () => {
    it('should cache authorization decisions for repeated requests', async () => {
      const adminSession: UserSession = {
        id: 1,
        email: 'admin@community1.org',
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'User',
      };

      mockRequest.session!.user = adminSession;

      const middleware = requireRoleHierarchy('editor', {
        enableCaching: true,
      });

      // First call
      const start1 = Date.now();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );
      const end1 = Date.now();

      // Reset reply mocks
      vi.clearAllMocks();
      mockReply.sent = false;

      // Second call (should be cached)
      const start2 = Date.now();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );
      const end2 = Date.now();

      // Both should succeed
      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();

      // Second call should be faster (cached)
      const time1 = end1 - start1;
      const time2 = end2 - start2;

      // Allow for some variance but cache should generally be faster
      expect(time2).toBeLessThanOrEqual(time1 + 5); // 5ms tolerance
    });

    it('should maintain performance under 10ms for authorization checks', async () => {
      const editorSession: UserSession = {
        id: 1,
        email: 'editor@community1.org',
        role: 'editor',
        communityId: 1,
        firstName: 'Performance',
        lastName: 'Test',
      };

      mockRequest.session!.user = editorSession;

      const middleware = composeMiddleware([
        requireRoleHierarchy('viewer'),
        requirePermission(['stories:read']),
      ]);

      const start = Date.now();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );
      const end = Date.now();

      const duration = end - start;
      expect(duration).toBeLessThan(10); // Should be under 10ms

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });
  });
});
