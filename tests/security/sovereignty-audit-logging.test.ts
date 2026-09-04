import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryService } from '../../src/services/story.service.js';

describe('V2 sovereignty audit logging', () => {
  const storyRepository = {
    findByIdWithRelations: vi.fn(),
  } as any;
  const fileRepository = {
    findOrphanedFiles: vi.fn(),
  } as any;
  const userRepository = {} as any;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
  let service: StoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new StoryService(
      storyRepository,
      fileRepository,
      userRepository,
      logger
    );
  });

  it('records authorization decisions without protected story content or protocol bodies', async () => {
    const story = {
      id: 41,
      title: 'Protected community story title',
      description: 'Protected story body',
      slug: 'protected-community-story',
      communityId: 7,
      createdBy: 10,
      isRestricted: false,
      privacyLevel: 'private',
      mediaUrls: [],
      imageUrl: null,
      audioUrl: null,
      language: 'en',
      tags: [],
      culturalProtocols: {
        permissionLevel: 'community',
        accessNotes: 'Protected access protocol notes',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      places: [],
      speakers: [],
      community: { id: 7 },
      author: { id: 10, role: 'admin', communityId: 7 },
    } as any;
    storyRepository.findByIdWithRelations.mockResolvedValue(story);

    const result = await service.getStoryById(41, 10, 'admin', 7);

    expect(result).not.toBeNull();
    const auditCall = logger.info.mock.calls.find(
      ([message]: [string]) => message === '[CULTURAL_ACCESS_AUDIT]'
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]).toMatchObject({
      storyId: 41,
      userId: 10,
      userRole: 'admin',
      communityId: 7,
      operation: 'read',
      allowed: true,
    });
    expect(auditCall?.[1]).not.toHaveProperty('storyTitle');
    expect(auditCall?.[1]).not.toHaveProperty('description');
    expect(auditCall?.[1]).not.toHaveProperty('culturalProtocols');
    expect(JSON.stringify(auditCall?.[1])).not.toContain('Protected');
  });
});
