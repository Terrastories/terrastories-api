/**
 * Data Sovereignty Enforcement Tests
 *
 * Critical tests for Indigenous data sovereignty compliance.
 * These tests ensure super admins CANNOT access community data,
 * which is essential for Indigenous community trust and legal compliance.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  enforceDataSovereignty,
  requireCommunityAccess,
  AuthenticatedRequest,
  UserSession,
} from '../../../src/shared/middleware/auth.middleware.js';

describe('Data Sovereignty Enforcement', () => {
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

  describe('enforceDataSovereignty', () => {
    it('should allow authenticated non-super-admin users', async () => {
      const userSession: UserSession = {
        id: 1,
        email: 'admin@community1.org',
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'User',
      };

      mockRequest.session!.user = userSession;

      await enforceDataSovereignty(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
      expect(mockLog.warn).not.toHaveBeenCalled();
    });

    it('should block super admin from community data access (CRITICAL)', async () => {
      const superAdminSession: UserSession = {
        id: 2,
        email: 'superadmin@system.org',
        role: 'super_admin',
        communityId: 0, // Super admins may have communityId 0
        firstName: 'Super',
        lastName: 'Admin',
      };

      mockRequest.session!.user = superAdminSession;

      await enforceDataSovereignty(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: 'Super administrators cannot access community data',
        },
        reason: 'Indigenous data sovereignty protection',
      });

      expect(mockLog.warn).toHaveBeenCalledWith(
        {
          userId: 2,
          action: 'community_data_access_blocked',
          reason: 'data_sovereignty_protection',
        },
        'Super admin blocked from community data'
      );
    });

    it('should return 401 for unauthenticated requests', async () => {
      mockRequest.session!.user = undefined;

      await enforceDataSovereignty(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(401);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: 'Authentication required',
        },
      });
    });

    it('should log security event for all super admin blocks', async () => {
      const superAdminSession: UserSession = {
        id: 999,
        email: 'another.superadmin@system.org',
        role: 'super_admin',
        communityId: 0,
        firstName: 'Another',
        lastName: 'SuperAdmin',
      };

      mockRequest.session!.user = superAdminSession;

      await enforceDataSovereignty(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 999,
          action: 'community_data_access_blocked',
          reason: 'data_sovereignty_protection',
        }),
        'Super admin blocked from community data'
      );
    });
  });

  describe('requireCommunityAccess', () => {
    it('should allow access to users own community data', async () => {
      const userSession: UserSession = {
        id: 1,
        email: 'user@community1.org',
        role: 'editor',
        communityId: 1,
        firstName: 'Community',
        lastName: 'User',
      };

      mockRequest.session!.user = userSession;
      mockRequest.params = { communityId: '1' };

      const middleware = requireCommunityAccess();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('should block access to different community data', async () => {
      const userSession: UserSession = {
        id: 1,
        email: 'user@community1.org',
        role: 'admin',
        communityId: 1,
        firstName: 'Community',
        lastName: 'User',
      };

      mockRequest.session!.user = userSession;
      mockRequest.params = { communityId: '2' }; // Requesting different community

      const middleware = requireCommunityAccess();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: 'Access denied - community data isolation',
        },
      });

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          userCommunityId: 1,
          requestedCommunityId: 2,
          userRole: 'admin',
        }),
        'Unauthorized community data access attempt'
      );
    });

    it('should block super admin even if they somehow have communityId', async () => {
      // This test covers edge case where super admin might have communityId set
      const superAdminSession: UserSession = {
        id: 2,
        email: 'superadmin@system.org',
        role: 'super_admin',
        communityId: 1, // Edge case: super admin with community ID
        firstName: 'Super',
        lastName: 'Admin',
      };

      mockRequest.session!.user = superAdminSession;
      mockRequest.params = { communityId: '1' };

      const middleware = requireCommunityAccess();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      // Should be blocked by enforceDataSovereignty first
      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: 'Super administrators cannot access community data',
        },
        reason: 'Indigenous data sovereignty protection',
      });
    });

    it('should handle missing community ID in request gracefully', async () => {
      const userSession: UserSession = {
        id: 1,
        email: 'user@community1.org',
        role: 'editor',
        communityId: 1,
        firstName: 'Community',
        lastName: 'User',
      };

      mockRequest.session!.user = userSession;
      mockRequest.params = {}; // No communityId in params
      mockRequest.query = {}; // No communityId in query

      const middleware = requireCommunityAccess();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      // Should allow access when no specific community requested
      expect(mockReply.status).not.toHaveBeenCalled();
      expect(mockReply.send).not.toHaveBeenCalled();
    });

    it('should extract community ID from query parameters', async () => {
      const userSession: UserSession = {
        id: 1,
        email: 'user@community1.org',
        role: 'editor',
        communityId: 1,
        firstName: 'Community',
        lastName: 'User',
      };

      mockRequest.session!.user = userSession;
      mockRequest.params = {};
      mockRequest.query = { communityId: '2' }; // Different community in query

      const middleware = requireCommunityAccess();
      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
      expect(mockReply.send).toHaveBeenCalledWith({
        error: {
          message: 'Access denied - community data isolation',
        },
      });
    });
  });

  describe('Data Sovereignty Compliance', () => {
    it('should maintain complete isolation between communities', async () => {
      const community1User: UserSession = {
        id: 1,
        email: 'user1@community1.org',
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'One',
      };

      const community2User: UserSession = {
        id: 2,
        email: 'user2@community2.org',
        role: 'admin',
        communityId: 2,
        firstName: 'Admin',
        lastName: 'Two',
      };

      const middleware = requireCommunityAccess();

      // Test community 1 user accessing community 2 data
      mockRequest.session!.user = community1User;
      mockRequest.params = { communityId: '2' };

      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);

      // Reset mocks
      vi.clearAllMocks();

      // Test community 2 user accessing community 1 data
      mockRequest.session!.user = community2User;
      mockRequest.params = { communityId: '1' };

      await middleware(
        mockRequest as FastifyRequest,
        mockReply as FastifyReply
      );

      expect(mockReply.status).toHaveBeenCalledWith(403);
    });

    it('should prevent any role from bypassing community isolation', async () => {
      const roles = ['viewer', 'editor', 'admin'] as const;
      const middleware = requireCommunityAccess();

      for (const role of roles) {
        const userSession: UserSession = {
          id: 1,
          email: `${role}@community1.org`,
          role,
          communityId: 1,
          firstName: role.charAt(0).toUpperCase() + role.slice(1),
          lastName: 'User',
        };

        mockRequest.session!.user = userSession;
        mockRequest.params = { communityId: '2' };

        await middleware(
          mockRequest as FastifyRequest,
          mockReply as FastifyReply
        );

        expect(mockReply.status).toHaveBeenCalledWith(403);

        // Reset for next iteration
        vi.clearAllMocks();
      }
    });
  });
});
