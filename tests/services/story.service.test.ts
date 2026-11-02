/**
 * Story Service Test Suite
 *
 * Comprehensive test coverage for StoryService including:
 * - CRUD operations with cultural protocols
 * - Data sovereignty enforcement
 * - Media file integration and validation
 * - Story-Places and Story-Speakers associations
 * - Search and filtering capabilities
 * - Performance and edge case testing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StoryService,
  type StoryCreateInput,
  type StoryWithRelations,
  type PaginatedResult,
  type StoryFilters,
  type PaginationOptions,
} from '../../src/services/story.service.js';

// Mock dependencies
const mockStoryRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findBySlug: vi.fn(),
  findByIdWithRelations: vi.fn(),
  findBySlugWithRelations: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findMany: vi.fn(),
  generateUniqueSlug: vi.fn(),
  createAssociations: vi.fn(),
  updateAssociations: vi.fn(),
  deleteAssociations: vi.fn(),
  validatePlacesInCommunity: vi.fn(),
  validateSpeakersInCommunity: vi.fn(),
} as any;

const mockFileRepository = {
  findById: vi.fn(),
  findByPath: vi.fn(),
  findByIds: vi.fn(),
  validateFileAccess: vi.fn(),
  findOrphanedFiles: vi.fn(),
} as any;

const mockUserRepository = {
  findById: vi.fn(),
} as any;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

// Create mock test data
function createMockTestData() {
  return {
    community: {
      id: 1,
      name: 'Test Indigenous Community',
      description: 'Test community for stories',
      slug: 'test-indigenous-community',
      locale: 'en',
    },
    users: {
      admin: {
        id: 1,
        role: 'admin',
        communityId: 1,
        firstName: 'Admin',
        lastName: 'User',
      },
      editor: {
        id: 2,
        role: 'editor',
        communityId: 1,
        firstName: 'Editor',
        lastName: 'User',
      },
      elder: {
        id: 3,
        role: 'elder',
        communityId: 1,
        firstName: 'Elder',
        lastName: 'User',
      },
      viewer: {
        id: 4,
        role: 'viewer',
        communityId: 1,
        firstName: 'Viewer',
        lastName: 'User',
      },
      superAdmin: {
        id: 5,
        role: 'super_admin',
        communityId: null,
        firstName: 'Super',
        lastName: 'Admin',
      },
      otherCommunityUser: {
        id: 6,
        role: 'editor',
        communityId: 2,
        firstName: 'Other',
        lastName: 'User',
      },
    },
    places: [
      {
        id: 1,
        name: 'Sacred Mountain',
        latitude: 49.3,
        longitude: -123.1,
        communityId: 1,
      },
      {
        id: 2,
        name: 'River Crossing',
        latitude: 49.4,
        longitude: -123.2,
        communityId: 1,
      },
    ],
    speakers: [
      {
        id: 1,
        name: 'Elder Maria Stonebear',
        elderStatus: true,
        communityId: 1,
      },
      {
        id: 2,
        name: 'John Rivercrossing',
        elderStatus: false,
        communityId: 1,
      },
    ],
    files: [
      {
        id: 'file1',
        path: '/uploads/story-image.jpg',
        communityId: 1,
      },
      {
        id: 'file2',
        path: '/uploads/story-audio.mp3',
        communityId: 1,
      },
    ],
  };
}

describe('StoryService', () => {
  let storyService: StoryService;
  let testData: ReturnType<typeof createMockTestData>;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Initialize service with mocked dependencies
    storyService = new StoryService(
      mockStoryRepository,
      mockFileRepository,
      mockUserRepository,
      mockLogger
    );

    // Create test data
    testData = createMockTestData();
  });

  describe('createStory', () => {
    it('should create story with media, places, and speakers', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'The Legend of Sacred Mountain',
        description: 'A traditional story passed down through generations...',
        communityId: testData.community.id,
        createdBy: testData.users.elder.id,
        mediaUrls: [testData.files[0].path, testData.files[1].path],
        placeIds: [testData.places[0].id],
        speakerIds: [testData.speakers[0].id],
        culturalProtocols: {
          permissionLevel: 'elder_only',
          culturalSignificance: 'Creation story with sacred elements',
          ceremonialContent: true,
        },
        language: 'en',
        tags: ['creation', 'sacred', 'mountain'],
      };

      const expectedStory: StoryWithRelations = {
        id: 1,
        title: storyInput.title!,
        description: storyInput.description,
        slug: 'the-legend-of-sacred-mountain',
        communityId: storyInput.communityId,
        createdBy: storyInput.createdBy,
        mediaUrls: storyInput.mediaUrls!,
        imageUrl: null, // Added by dual-read
        audioUrl: null, // Added by dual-read
        language: storyInput.language!,
        tags: storyInput.tags!,
        culturalProtocols: storyInput.culturalProtocols,
        isRestricted: true, // Should be auto-set for elder_only content
        createdAt: new Date(),
        updatedAt: new Date(),
        places: [
          {
            ...testData.places[0],
            culturalContext: undefined,
            storyRelationship: undefined,
          },
        ],
        speakers: [
          {
            ...testData.speakers[0],
            culturalRole: 'narrator',
            storyRole: 'narrator',
          },
        ],
        community: testData.community,
        author: testData.users.elder,
      };

      // Mock repository methods
      mockStoryRepository.generateUniqueSlug.mockResolvedValue(
        'the-legend-of-sacred-mountain'
      );
      mockFileRepository.validateFileAccess.mockResolvedValue({ valid: true });
      mockStoryRepository.validatePlacesInCommunity.mockResolvedValue(true);
      mockStoryRepository.validateSpeakersInCommunity.mockResolvedValue(true);
      mockStoryRepository.create.mockResolvedValue(expectedStory);

      // Act
      const result = await storyService.createStory(
        storyInput,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert
      expect(result).toEqual(expectedStory);
      expect(mockStoryRepository.generateUniqueSlug).toHaveBeenCalledWith(
        storyInput.title,
        storyInput.communityId
      );
      expect(mockFileRepository.validateFileAccess).toHaveBeenCalledWith(
        storyInput.mediaUrls,
        testData.users.elder.id,
        testData.community.id
      );
      expect(mockStoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ...storyInput,
          slug: 'the-legend-of-sacred-mountain',
          isRestricted: true,
        })
      );
    });

    it('should reject creation with cross-community places', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'Test Story',
        communityId: testData.community.id,
        createdBy: testData.users.admin.id,
        placeIds: [999], // Non-existent or cross-community place
      };

      mockStoryRepository.validatePlacesInCommunity.mockResolvedValue(false);

      // Act & Assert
      await expect(
        storyService.createStory(
          storyInput,
          testData.users.admin.id,
          testData.users.admin.role,
          testData.community.id
        )
      ).rejects.toThrow(
        'Places must belong to the same community as the story'
      );
    });

    it('should reject creation with invalid media files', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'Test Story',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        mediaUrls: ['/uploads/invalid-file.jpg'],
      };

      mockFileRepository.validateFileAccess.mockResolvedValue({
        valid: false,
        reason: 'File not found or access denied',
      });

      // Act & Assert
      await expect(
        storyService.createStory(
          storyInput,
          testData.users.editor.id,
          testData.users.editor.role,
          testData.community.id
        )
      ).rejects.toThrow('File not found or access denied');
    });

    it('should auto-generate slug when not provided', async () => {
      // Arrange
      const storyInput: StoryCreateInput = {
        title: 'Another Amazing Story!',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
      };

      mockStoryRepository.generateUniqueSlug.mockResolvedValue(
        'another-amazing-story'
      );
      mockStoryRepository.create.mockResolvedValue({
        ...storyInput,
        id: 1,
        slug: 'another-amazing-story',
      } as any);

      // Act
      await storyService.createStory(
        storyInput,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(mockStoryRepository.generateUniqueSlug).toHaveBeenCalledWith(
        'Another Amazing Story!',
        testData.community.id
      );
    });
  });

  describe('getStoryById - Data Sovereignty', () => {
    const createElderOnlyStory = (): StoryWithRelations => ({
      id: 1,
      title: 'Sacred Ceremony Story',
      description: 'A ceremony story for elders only',
      slug: 'sacred-ceremony-story',
      communityId: testData.community.id,
      createdBy: testData.users.elder.id,
      mediaUrls: [],
      imageUrl: null, // Added by dual-read
      audioUrl: null, // Added by dual-read
      language: 'en',
      tags: [],
      culturalProtocols: {
        permissionLevel: 'elder_only',
        ceremonialContent: true,
      },
      isRestricted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      places: [],
      speakers: [],
      community: testData.community,
      author: testData.users.elder,
    });

    it('should block super admin from community stories', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        elderOnlyStory
      );

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.superAdmin.id,
        testData.users.superAdmin.role,
        null // Super admin has no community
      );

      // Assert
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Data sovereignty protection'),
        expect.any(Object)
      );
    });

    it('should deny an elder access to restricted (unavailable) content', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        elderOnlyStory
      );

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert: restricted rows are unavailable to EVERY role in V2 runtime
      // (SPEC-V2 §6.3), the legacy elder role included.
      expect(result).toBeNull();
    });

    it('logs authorization metadata without protected story content', async () => {
      // Available fixture (unrestricted, community audience): the purpose of
      // this test is the audit record's shape, not the audience gate.
      const story = {
        ...createElderOnlyStory(),
        isRestricted: false,
        privacyLevel: 'members_only',
      };
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      const result = await storyService.getStoryById(
        story.id,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      expect(result).toEqual(story);
      const auditCall = mockLogger.info.mock.calls.find(
        ([message]: [string]) => message === '[CULTURAL_ACCESS_AUDIT]'
      );
      expect(auditCall).toBeDefined();
      expect(auditCall?.[1]).toMatchObject({
        storyId: story.id,
        userId: testData.users.admin.id,
        communityId: testData.community.id,
        allowed: true,
      });
      expect(auditCall?.[1]).not.toHaveProperty('storyTitle');
      expect(auditCall?.[1]).not.toHaveProperty('culturalProtocols');
    });

    it('should deny editor access to elder-only content', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        elderOnlyStory
      );

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert: restricted rows are unavailable to every role at the
      // SPEC-V2 §6.3 audience gate, so the editor is denied before any
      // legacy protocol check.
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Story audience access denied'),
        expect.any(Object)
      );
    });

    it('should deny cross-community access', async () => {
      // Arrange
      const elderOnlyStory = createElderOnlyStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        elderOnlyStory
      );

      // Act
      const result = await storyService.getStoryById(
        elderOnlyStory.id,
        testData.users.otherCommunityUser.id,
        testData.users.otherCommunityUser.role,
        999 // Different community ID
      );

      // Assert
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cross-community access denied'),
        expect.any(Object)
      );
    });
  });

  describe('unknown physical roles (fail closed)', () => {
    it('denies an unknown role a public story read by id and by slug', async () => {
      const story = {
        id: 9,
        title: 'Public Story',
        slug: 'public-story-unknown-role',
        communityId: testData.community.id,
        privacyLevel: 'public',
        isRestricted: false,
        places: [],
        speakers: [],
      } as any;
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);
      mockStoryRepository.findBySlugWithRelations.mockResolvedValue(story);

      const byId = await storyService.getStoryById(
        story.id,
        testData.users.viewer.id,
        'guest' as any,
        testData.community.id
      );
      expect(byId).toBeNull();

      await expect(
        storyService.getStoryBySlug(
          story.slug,
          testData.community.id,
          testData.users.viewer.id,
          'guest' as any
        )
      ).resolves.toBeNull();
    });
  });

  describe('getStoryBySlug', () => {
    it('should retrieve story by slug with community scoping', async () => {
      // Arrange
      const story: StoryWithRelations = {
        id: 1,
        title: 'Public Story',
        slug: 'public-story',
        communityId: testData.community.id,
        // Physical Fastify columns the §6.2/§6.3 audience gate reads.
        privacyLevel: 'public',
        isRestricted: false,
        culturalProtocols: { permissionLevel: 'public' },
        imageUrl: null, // Added by dual-read
        audioUrl: null, // Added by dual-read
        mediaUrls: [], // Added by dual-read
      } as any;

      mockStoryRepository.findBySlugWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryBySlug(
        'public-story',
        testData.community.id,
        testData.users.viewer.id,
        testData.users.viewer.role
      );

      // Assert
      expect(result).toEqual(story);
      expect(mockStoryRepository.findBySlugWithRelations).toHaveBeenCalledWith(
        'public-story',
        testData.community.id
      );
    });

    it('should return null for non-existent slug', async () => {
      // Arrange
      mockStoryRepository.findBySlugWithRelations.mockResolvedValue(null);

      // Act
      const result = await storyService.getStoryBySlug(
        'non-existent-story',
        testData.community.id,
        testData.users.viewer.id,
        testData.users.viewer.role
      );

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('story-derived place projection (SPEC-V2 §6.4)', () => {
    // A readable story does not widen a related place's audience. A
    // restricted Fastify place (places.is_restricted = true) is unavailable
    // to EVERY role in V2 runtime — admin, editor, viewer, and the legacy
    // elder path included — so it is always removed from story.places, the
    // same rule the place reads and PlaceService.getCommunityPlaceStats
    // apply.
    const unrestrictedPlace = {
      id: 10,
      name: 'Open River Crossing',
      description: 'Gathering place by the river',
      latitude: 49.4,
      longitude: -123.2,
      storyRelationship: 'mentioned',
      sortOrder: 0,
      isRestricted: false,
    };
    const restrictedPlace = {
      id: 11,
      name: 'Sacred Ceremony Site',
      description: 'Restricted ceremonial site',
      latitude: 49.5,
      longitude: -123.3,
      storyRelationship: 'mentioned',
      sortOrder: 1,
      isRestricted: true,
    };

    const createReadableStoryWithMixedPlaces = (): StoryWithRelations =>
      ({
        id: 42,
        title: 'Public Story Linking Mixed Places',
        description: 'Readable by every same-community role',
        slug: 'public-story-linking-mixed-places',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        mediaUrls: [],
        imageUrl: null,
        audioUrl: null,
        language: 'en',
        tags: [],
        privacyLevel: 'public',
        isRestricted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        places: [unrestrictedPlace, restrictedPlace],
        speakers: [],
        community: testData.community,
        author: testData.users.editor,
      }) as any;

    it('hides the restricted place from a physical viewer (V2 member) on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithMixedPlaces();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryById(
        story.id,
        testData.users.viewer.id,
        testData.users.viewer.role,
        testData.community.id
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
    });

    it('hides the restricted place from an editor on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithMixedPlaces();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryById(
        story.id,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
    });

    it('removes the restricted place for an admin on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithMixedPlaces();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryById(
        story.id,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert: the restricted place is unavailable to admin too (§6.4).
      expect(result).not.toBeNull();
      expect(result!.places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
    });

    it('removes the restricted place for an editor on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithMixedPlaces();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryById(
        story.id,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
    });

    it('removes the restricted place for an elder on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithMixedPlaces();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryById(
        story.id,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert: the legacy elder path loses restricted places too (§6.4).
      expect(result).not.toBeNull();
      expect(result!.places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
    });

    it('filters restricted places for every role in listStories', async () => {
      // Arrange
      const story = createReadableStoryWithMixedPlaces();
      mockStoryRepository.findMany.mockResolvedValue({
        data: [story],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });

      // Act - physical viewer (V2 member)
      const viewerResult = await storyService.listStories(
        {},
        { page: 1, limit: 10 },
        testData.users.viewer.id,
        testData.users.viewer.role,
        testData.community.id
      );

      // Act - admin
      const adminResult = await storyService.listStories(
        {},
        { page: 1, limit: 10 },
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(viewerResult.data[0].places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
      expect(adminResult.data[0].places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
    });

    it('hides the restricted place from a viewer on getStoryBySlug', async () => {
      // Arrange
      const story = createReadableStoryWithMixedPlaces();
      mockStoryRepository.findBySlugWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryBySlug(
        story.slug,
        testData.community.id,
        testData.users.viewer.id,
        testData.users.viewer.role
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.places.map((place) => place.id)).toEqual([
        unrestrictedPlace.id,
      ]);
    });
  });

  describe('story-derived speaker withdrawal projection (SPEC-V2 §6.5)', () => {
    // A withdrawn (inactive) speaker is absent from story.speakers for every
    // caller without the canonical editor/admin gate — the physical Fastify
    // viewer (V2 member), the legacy elder path, and anonymous/public
    // callers. Editors and admins keep the full relation, exactly like the
    // §6.4 place projection above but role-aware.
    const activeStorySpeaker = {
      id: 71,
      name: 'Active Speaker',
      bio: 'Still recording stories',
      elderStatus: false,
      isActive: true,
      storyRole: 'narrator',
      sortOrder: 0,
    };
    const withdrawnStorySpeaker = {
      id: 72,
      name: 'Withdrawn Speaker',
      bio: 'WITHDRAWN-BIO',
      elderStatus: false,
      isActive: false,
      storyRole: 'narrator',
      sortOrder: 1,
    };

    const createReadableStoryWithWithdrawnSpeaker = (): StoryWithRelations =>
      ({
        id: 43,
        title: 'Public Story Linking Withdrawn Speaker',
        description: 'Readable by every same-community role',
        slug: 'public-story-linking-withdrawn-speaker',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        mediaUrls: [],
        imageUrl: null,
        audioUrl: null,
        language: 'en',
        tags: [],
        privacyLevel: 'public',
        isRestricted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        places: [],
        speakers: [activeStorySpeaker, withdrawnStorySpeaker],
        community: testData.community,
        author: testData.users.editor,
      }) as any;

    it('drops a withdrawn interviewer for a physical viewer (V2 member) and keeps it for an editor', async () => {
      const withInterviewer = () =>
        ({
          ...createReadableStoryWithWithdrawnSpeaker(),
          interviewer: {
            id: 73,
            name: 'Withdrawn Interviewer',
            bio: 'WITHDRAWN-INTERVIEWER-BIO',
            elderStatus: false,
            isActive: false,
          },
        }) as any;

      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        withInterviewer()
      );
      const viewerResult = await storyService.getStoryById(
        43,
        testData.users.viewer.id,
        testData.users.viewer.role,
        testData.community.id
      );
      expect(viewerResult).not.toBeNull();
      expect(viewerResult!.interviewer).toBeNull();
      expect(JSON.stringify(viewerResult)).not.toContain(
        'WITHDRAWN-INTERVIEWER-BIO'
      );

      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        withInterviewer()
      );
      const editorResult = await storyService.getStoryById(
        43,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );
      expect(editorResult!.interviewer).toMatchObject({ id: 73 });
    });

    it('removes the withdrawn speaker for a physical viewer (V2 member) on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryById(
        story.id,
        testData.users.viewer.id,
        testData.users.viewer.role,
        testData.community.id
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.speakers.map((speaker) => speaker.id)).toEqual([
        activeStorySpeaker.id,
      ]);
      expect(JSON.stringify(result)).not.toContain('WITHDRAWN-BIO');
    });

    it('removes the withdrawn speaker for the legacy elder role on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryById(
        story.id,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.speakers.map((speaker) => speaker.id)).toEqual([
        activeStorySpeaker.id,
      ]);
    });

    it('keeps the withdrawn speaker for an editor and an admin on getStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const editorResult = await storyService.getStoryById(
        story.id,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );
      const adminResult = await storyService.getStoryById(
        story.id,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(editorResult!.speakers.map((speaker) => speaker.id)).toEqual([
        activeStorySpeaker.id,
        withdrawnStorySpeaker.id,
      ]);
      expect(adminResult!.speakers.map((speaker) => speaker.id)).toEqual([
        activeStorySpeaker.id,
        withdrawnStorySpeaker.id,
      ]);
    });

    it('removes the withdrawn speaker for a viewer on getStoryBySlug', async () => {
      // Arrange
      const story = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findBySlugWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getStoryBySlug(
        story.slug,
        testData.community.id,
        testData.users.viewer.id,
        testData.users.viewer.role
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result!.speakers.map((speaker) => speaker.id)).toEqual([
        activeStorySpeaker.id,
      ]);
    });

    it('filters the withdrawn speaker for a viewer in listStories and keeps it for an editor', async () => {
      // Arrange
      const story = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findMany.mockResolvedValue({
        data: [story],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });

      // Act
      const viewerResult = await storyService.listStories(
        {},
        { page: 1, limit: 10 },
        testData.users.viewer.id,
        testData.users.viewer.role,
        testData.community.id
      );
      const editorResult = await storyService.listStories(
        {},
        { page: 1, limit: 10 },
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(viewerResult.data[0].speakers.map((s) => s.id)).toEqual([
        activeStorySpeaker.id,
      ]);
      expect(editorResult.data[0].speakers.map((s) => s.id)).toEqual([
        activeStorySpeaker.id,
        withdrawnStorySpeaker.id,
      ]);
    });

    it('keeps inactive speakers on createStory results for an admin and removes them for an elder', async () => {
      // Arrange
      const baseStory = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.generateUniqueSlug.mockResolvedValue(
        'created-story-with-withdrawn-speaker'
      );
      mockStoryRepository.validateSpeakersInCommunity.mockResolvedValue(true);
      mockStoryRepository.create.mockResolvedValue({
        ...baseStory,
        id: 44,
        title: 'Created Story With Withdrawn Speaker',
      });

      // Act
      const adminResult = await storyService.createStory(
        {
          title: 'Created Story With Withdrawn Speaker',
          communityId: testData.community.id,
          createdBy: testData.users.admin.id,
          speakerIds: [activeStorySpeaker.id, withdrawnStorySpeaker.id],
        },
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );
      const elderResult = await storyService.createStory(
        {
          title: 'Created Story With Withdrawn Speaker',
          communityId: testData.community.id,
          createdBy: testData.users.elder.id,
          speakerIds: [activeStorySpeaker.id, withdrawnStorySpeaker.id],
        },
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert
      expect(adminResult.speakers.map((s) => s.id)).toEqual([
        activeStorySpeaker.id,
        withdrawnStorySpeaker.id,
      ]);
      expect(elderResult.speakers.map((s) => s.id)).toEqual([
        activeStorySpeaker.id,
      ]);
    });

    it('keeps inactive speakers on updateStory results for an admin', async () => {
      // Arrange
      const existingStory = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        existingStory
      );
      mockStoryRepository.update.mockResolvedValue({
        ...existingStory,
        title: 'Updated Story With Withdrawn Speaker',
      });

      // Act
      const result = await storyService.updateStory(
        existingStory.id,
        { title: 'Updated Story With Withdrawn Speaker' },
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result.speakers.map((s) => s.id)).toEqual([
        activeStorySpeaker.id,
        withdrawnStorySpeaker.id,
      ]);
    });

    it('removes the withdrawn speaker for anonymous callers on getPublicStoryById', async () => {
      // Arrange
      const story = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(story);

      // Act
      const result = await storyService.getPublicStoryById(
        String(story.id),
        String(testData.community.id)
      );

      // Assert: public/anonymous callers never get inactive speakers.
      expect(result).not.toBeNull();
      expect(result!.speakers.map((speaker) => speaker.id)).toEqual([
        activeStorySpeaker.id,
      ]);
    });

    it('removes the withdrawn speaker for anonymous callers on getPublicStoriesByCommunity', async () => {
      // Arrange
      const story = createReadableStoryWithWithdrawnSpeaker();
      mockStoryRepository.findMany.mockResolvedValue({
        data: [story],
        total: 1,
      });

      // Act
      const result = await storyService.getPublicStoriesByCommunity(
        String(testData.community.id),
        { page: 1, limit: 10 }
      );

      // Assert
      expect(result.stories[0].speakers.map((speaker) => speaker.id)).toEqual([
        activeStorySpeaker.id,
      ]);
    });
  });

  describe('updateStory - Association Management', () => {
    const createExistingStory = (): StoryWithRelations =>
      ({
        id: 1,
        title: 'River Crossing Story',
        slug: 'river-crossing-story',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        mediaUrls: ['/uploads/old-image.jpg'],
        // Available fixture (§6.3): these tests exercise association
        // management, not the unavailable-row gate.
        isRestricted: false,
        privacyLevel: 'members_only',
        places: [testData.places[0]],
        speakers: [testData.speakers[0]],
        culturalProtocols: { permissionLevel: 'community' },
      }) as any;

    it('should update place and speaker associations', async () => {
      // Arrange
      const existingStory = createExistingStory();
      const updates = {
        title: 'Updated River Story',
        placeIds: [testData.places[1].id], // Change to different place
        speakerIds: [testData.speakers[1].id], // Change to different speaker
      };

      const updatedStory = {
        ...existingStory,
        ...updates,
        places: [testData.places[1]],
        speakers: [testData.speakers[1]],
      };

      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        existingStory
      );
      mockStoryRepository.validatePlacesInCommunity.mockResolvedValue(true);
      mockStoryRepository.validateSpeakersInCommunity.mockResolvedValue(true);
      mockStoryRepository.update.mockResolvedValue(updatedStory);

      // Act
      const result = await storyService.updateStory(
        existingStory.id,
        updates,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(result.places).toHaveLength(1);
      expect(result.places[0].id).toBe(testData.places[1].id);
      expect(result.speakers).toHaveLength(1);
      expect(result.speakers[0].id).toBe(testData.speakers[1].id);
    });

    it('should handle media file cleanup during updates', async () => {
      // Arrange
      const existingStory = createExistingStory();
      const updates = {
        mediaUrls: ['/uploads/new-image.jpg'],
      };

      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        existingStory
      );
      mockFileRepository.validateFileAccess.mockResolvedValue({ valid: true });
      mockStoryRepository.update.mockResolvedValue({
        ...existingStory,
        ...updates,
      });

      // Act
      await storyService.updateStory(
        existingStory.id,
        updates,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(mockFileRepository.findOrphanedFiles).toHaveBeenCalled();
    });

    it('should reject updates by unauthorized users', async () => {
      // Arrange
      const existingStory = createExistingStory();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        existingStory
      );

      // Act & Assert
      await expect(
        storyService.updateStory(
          existingStory.id,
          { title: 'Unauthorized Update' },
          testData.users.viewer.id, // Viewer cannot edit
          testData.users.viewer.role,
          testData.community.id
        )
      ).rejects.toThrow('Insufficient permissions to modify this story');
    });

    it('should reject an admin update of a restricted (unavailable) story with 404 semantics', async () => {
      // Arrange: a restricted row is not reachable by any role (§6.3).
      const restrictedStory = {
        ...createExistingStory(),
        isRestricted: true,
        privacyLevel: 'public',
      };
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        restrictedStory
      );

      // Act & Assert: the row masks as nonexistent (StoryNotFoundError -> 404).
      await expect(
        storyService.updateStory(
          restrictedStory.id,
          { title: 'Attempted Update' },
          testData.users.admin.id,
          testData.users.admin.role,
          testData.community.id
        )
      ).rejects.toThrow('Story not found');
    });
  });

  describe('deleteStory', () => {
    const createStoryToDelete = (): StoryWithRelations =>
      ({
        id: 1,
        title: 'Story to Delete',
        communityId: testData.community.id,
        createdBy: testData.users.editor.id,
        mediaUrls: ['/uploads/file-to-cleanup.jpg'],
        // Available fixture (§6.3): these tests exercise the deletion flow,
        // not the unavailable-row gate.
        isRestricted: false,
        privacyLevel: 'public',
      }) as any;

    it('should delete story and clean up media files', async () => {
      // Arrange
      const storyToDelete = createStoryToDelete();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        storyToDelete
      );
      mockStoryRepository.delete.mockResolvedValue(true);

      // Act
      await storyService.deleteStory(
        storyToDelete.id,
        testData.users.admin.id, // Admin can delete any story
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(mockStoryRepository.delete).toHaveBeenCalledWith(storyToDelete.id);
      expect(mockFileRepository.findOrphanedFiles).toHaveBeenCalled();
    });

    it('should allow creators to delete their own stories', async () => {
      // Arrange
      const storyToDelete = createStoryToDelete();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        storyToDelete
      );
      mockStoryRepository.delete.mockResolvedValue(true);

      // Act
      await storyService.deleteStory(
        storyToDelete.id,
        testData.users.editor.id, // Creator can delete own story
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(mockStoryRepository.delete).toHaveBeenCalledWith(storyToDelete.id);
    });

    it('should reject deletion by unauthorized users', async () => {
      // Arrange
      const storyToDelete = createStoryToDelete();
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        storyToDelete
      );

      // Act & Assert
      await expect(
        storyService.deleteStory(
          storyToDelete.id,
          testData.users.viewer.id, // Viewer cannot delete
          testData.users.viewer.role,
          testData.community.id
        )
      ).rejects.toThrow('Insufficient permissions to delete this story');
    });

    it('should reject an admin deletion of a restricted (unavailable) story with 404 semantics', async () => {
      // Arrange: a restricted row is not reachable by any role (§6.3).
      const restrictedStory = {
        ...createStoryToDelete(),
        isRestricted: true,
        privacyLevel: 'public',
      };
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        restrictedStory
      );

      // Act & Assert: the row masks as nonexistent (StoryNotFoundError -> 404).
      await expect(
        storyService.deleteStory(
          restrictedStory.id,
          testData.users.admin.id,
          testData.users.admin.role,
          testData.community.id
        )
      ).rejects.toThrow('Story not found');
      expect(mockStoryRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('listStories - Search & Filtering', () => {
    const testStories: StoryWithRelations[] = [
      {
        id: 1,
        title: 'Mountain Spirit Legend',
        description: 'Ancient spirits dwelling in the sacred peaks...',
        communityId: 1, // Same as testData.community.id
        tags: ['spirits', 'mountains', 'ancient'],
        culturalProtocols: { permissionLevel: 'public' },
        imageUrl: null, // Added by dual-read
        audioUrl: null, // Added by dual-read
        mediaUrls: [], // Added by dual-read
      } as any,
      {
        id: 2,
        title: 'River Medicine Teachings',
        description: 'Traditional healing practices by the river...',
        communityId: 1, // Same as testData.community.id
        tags: ['healing', 'medicine', 'river'],
        culturalProtocols: { permissionLevel: 'elder_only' },
        imageUrl: null, // Added by dual-read
        audioUrl: null, // Added by dual-read
        mediaUrls: [], // Added by dual-read
      } as any,
      {
        id: 3,
        title: 'Seasonal Hunting Story',
        description: 'Respectful hunting practices through the seasons...',
        communityId: 1, // Same as testData.community.id
        tags: ['hunting', 'seasons', 'respect'],
        culturalProtocols: { permissionLevel: 'community' },
        imageUrl: null, // Added by dual-read
        audioUrl: null, // Added by dual-read
        mediaUrls: [], // Added by dual-read
      } as any,
    ];

    it('should search stories with text query', async () => {
      // Arrange
      const filters: StoryFilters = {
        search: 'mountain spirit',
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      const expectedResult: PaginatedResult<StoryWithRelations> = {
        data: [testStories[0]],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockStoryRepository.findMany.mockResolvedValue(expectedResult);

      // Act
      const result = await storyService.listStories(
        filters,
        pagination,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result).toEqual(expectedResult);
      expect(mockStoryRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'mountain spirit',
          communityId: testData.community.id,
        }),
        pagination
      );
    });

    it('should filter results by cultural permissions', async () => {
      // Arrange
      const filters: StoryFilters = {};
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      // Elder can see all stories
      const elderResult: PaginatedResult<StoryWithRelations> = {
        data: testStories,
        total: 3,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      // Editor cannot see elder-only content
      const editorResult: PaginatedResult<StoryWithRelations> = {
        data: [testStories[0], testStories[2]], // Excludes elder-only story
        total: 2,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockStoryRepository.findMany
        .mockResolvedValueOnce(elderResult)
        .mockResolvedValueOnce(editorResult);

      // Act - Elder access
      const elderResults = await storyService.listStories(
        filters,
        pagination,
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Act - Editor access
      const editorResults = await storyService.listStories(
        filters,
        pagination,
        testData.users.editor.id,
        testData.users.editor.role,
        testData.community.id
      );

      // Assert
      expect(elderResults.total).toBe(3);
      expect(editorResults.total).toBe(2);
    });

    it('should apply the member audience filter for the legacy elder role', async () => {
      // Arrange: restricted rows and non-public/members_only privacy
      // levels are unavailable to the legacy elder too (SPEC-V2 §6.3), so
      // elder lists use the same audience reach as V2 member.
      mockStoryRepository.findMany.mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      });

      // Act
      await storyService.listStories(
        {},
        { page: 1, limit: 10 },
        testData.users.elder.id,
        testData.users.elder.role,
        testData.community.id
      );

      // Assert
      expect(mockStoryRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          storyAudiences: ['public', 'community'],
        }),
        { page: 1, limit: 10 }
      );
    });

    it('should support geographic proximity filtering', async () => {
      // Arrange
      const filters: StoryFilters = {
        nearPoint: { type: 'Point', coordinates: [-123.11, 49.31] },
        radiusKm: 5,
      };
      const pagination: PaginationOptions = { page: 1, limit: 10 };

      const expectedResult: PaginatedResult<StoryWithRelations> = {
        data: [testStories[0]], // Stories within 5km
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      };

      mockStoryRepository.findMany.mockResolvedValue(expectedResult);

      // Act
      const result = await storyService.listStories(
        filters,
        pagination,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result).toEqual(expectedResult);
      expect(mockStoryRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          nearPoint: filters.nearPoint,
          radiusKm: 5,
        }),
        pagination
      );
    });
  });

  describe('Performance Tests', () => {
    it('should handle large story collections efficiently', async () => {
      // Arrange
      const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        title: `Story ${i + 1}`,
        communityId: testData.community.id, // Should be 1
        culturalProtocols: { permissionLevel: 'public' },
      })) as StoryWithRelations[];

      const expectedResult: PaginatedResult<StoryWithRelations> = {
        data: largeDataset.slice(0, 20),
        total: 1000,
        page: 1,
        limit: 20,
        totalPages: 50,
      };

      mockStoryRepository.findMany.mockResolvedValue(expectedResult);

      const startTime = Date.now();

      // Act
      const result = await storyService.listStories(
        {},
        { page: 1, limit: 20 },
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      const endTime = Date.now();
      const queryTime = endTime - startTime;

      // Assert
      expect(queryTime).toBeLessThan(100); // Should complete very quickly (mocked)
      expect(result.data).toHaveLength(20);
      expect(result.total).toBe(1000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing story gracefully', async () => {
      // Arrange
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(null);

      // Act
      const result = await storyService.getStoryById(
        999,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result).toBeNull();
    });

    it('should handle empty search results', async () => {
      // Arrange
      const emptyResult: PaginatedResult<StoryWithRelations> = {
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };

      mockStoryRepository.findMany.mockResolvedValue(emptyResult);

      // Act
      const result = await storyService.listStories(
        { search: 'nonexistent' },
        { page: 1, limit: 10 },
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  /**
   * Test suite for dual-read functionality (Issue #89)
   * Tests FILES_NATIVE_ENABLED feature flag behavior
   *
   * Note: These are simplified tests. The dual-read implementation is tested
   * through integration tests and manual verification.
   */
  describe('Dual-Read Functionality', () => {
    it('should include both native and legacy file URL fields in story responses', async () => {
      // Arrange
      const storyWithFiles: StoryWithRelations = {
        id: 1,
        title: 'Test Story with Files',
        description: 'A test story with file URLs',
        slug: 'test-story-files',
        communityId: testData.community.id,
        createdBy: testData.users.admin.id,
        language: 'en',
        tags: [],
        culturalProtocols: { permissionLevel: 'public' },
        isRestricted: false,
        privacyLevel: 'public',
        createdAt: new Date(),
        updatedAt: new Date(),
        places: [],
        speakers: [],
        community: testData.community,
        author: testData.users.admin,
        imageUrl: 'https://example.com/image.jpg',
        audioUrl: 'https://example.com/audio.mp3',
        mediaUrls: ['https://legacy.example.com/image.jpg'],
      } as any;

      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        storyWithFiles
      );

      // Act
      const result = await storyService.getStoryById(
        1,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert - Both fields should be present in the response
      expect(result).toBeTruthy();
      expect(result).toHaveProperty('imageUrl');
      expect(result).toHaveProperty('audioUrl');
      expect(result).toHaveProperty('mediaUrls');
      expect(Array.isArray(result!.mediaUrls)).toBe(true);
    });

    it('should accept both native and legacy file URL fields in create input', async () => {
      // Arrange
      const createInput: StoryCreateInput = {
        title: 'Test Story with Mixed File Fields',
        communityId: testData.community.id,
        createdBy: testData.users.admin.id,
        // Both types of file fields
        imageUrl: 'https://example.com/native-image.jpg',
        audioUrl: 'https://example.com/native-audio.mp3',
        mediaUrls: ['https://example.com/legacy-image.jpg'],
      };

      const expectedStory: StoryWithRelations = {
        id: 1,
        title: createInput.title!,
        description: '',
        slug: 'test-story-mixed-fields',
        communityId: createInput.communityId,
        createdBy: createInput.createdBy,
        language: 'en',
        tags: [],
        culturalProtocols: { permissionLevel: 'public' },
        isRestricted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        places: [],
        speakers: [],
        community: testData.community,
        author: testData.users.admin,
        imageUrl: createInput.imageUrl!,
        audioUrl: createInput.audioUrl!,
        mediaUrls: createInput.mediaUrls!,
      } as any;

      mockStoryRepository.generateUniqueSlug.mockResolvedValue(
        'test-story-mixed-fields'
      );
      mockStoryRepository.create.mockResolvedValue(expectedStory);
      mockStoryRepository.findByIdWithRelations.mockResolvedValue(
        expectedStory
      );

      // Act
      const result = await storyService.createStory(
        createInput,
        testData.users.admin.id,
        testData.users.admin.role,
        testData.community.id
      );

      // Assert - Service should handle both types of file fields
      expect(mockStoryRepository.create).toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result).toHaveProperty('imageUrl');
      expect(result).toHaveProperty('audioUrl');
      expect(result).toHaveProperty('mediaUrls');
    });
  });
});
