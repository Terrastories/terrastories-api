# Terrastories Migration to React + Drizzle ORM

## Current Technology Assessment

**Terrastories** is a mature Ruby on Rails application with React components, designed as an offline-first geostorytelling platform for Indigenous communities. The current stack reveals significant architectural complexity that requires careful migration planning.

### Current Architecture

- **Backend**: Ruby on Rails 6+ with PostgreSQL database
- **Frontend**: Rails-React hybrid using `react-rails` gem and Webpacker
- **ORM**: ActiveRecord with complex multi-tenant relationships
- **Storage**: ActiveStorage for media files (audio, video, images)
- **Maps**: MapLibre GL JS with offline tile server support
- **Deployment**: Dockerized multi-service architecture (Rails, PostgreSQL, Nginx, Tileserver)

The application serves **five core data models** with intricate relationships: Communities (multi-tenant), Users (role-based), Stories (narrative content), Places (geographic locations), and Speakers (storytellers). The architecture prioritizes **data sovereignty** and **offline functionality** - critical requirements for remote Indigenous communities.

## Database Schema Analysis and Migration Strategy

### Current ActiveRecord Schema

The existing database uses complex many-to-many relationships with ActiveStorage integration:

```ruby
# Current ActiveRecord relationships (inferred)
class Story < ApplicationRecord
  belongs_to :community
  has_many :story_places
  has_many :places, through: :story_places
  has_many :story_speakers
  has_many :speakers, through: :story_speakers
  has_many_attached :media_files
end

class Place < ApplicationRecord
  belongs_to :community
  has_many :story_places
  has_many :stories, through: :story_places
  has_one_attached :photo
  has_one_attached :name_audio
end
```

### Drizzle ORM Migration Schema

Here's the equivalent Drizzle schema structure:

```typescript
// schema.ts
import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  decimal,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const communities = pgTable('communities', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  slug: text('slug').unique(),
  public_stories: boolean('public_stories').default(false),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').unique().notNull(),
  role: text('role').notNull(), // 'super_admin', 'admin', 'editor', 'viewer'
  community_id: serial('community_id').references(() => communities.id),
  created_at: timestamp('created_at').defaultNow(),
});

export const stories = pgTable('stories', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  desc: text('desc'),
  community_id: serial('community_id').references(() => communities.id),
  restricted: boolean('restricted').default(false),
  created_at: timestamp('created_at').defaultNow(),
});

export const places = pgTable('places', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  lat: decimal('lat'),
  lng: decimal('lng'),
  community_id: serial('community_id').references(() => communities.id),
});

export const speakers = pgTable('speakers', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  bio: text('bio'),
  community_id: serial('community_id').references(() => communities.id),
});

// Junction tables for many-to-many relationships
export const storyPlaces = pgTable('story_places', {
  story_id: serial('story_id').references(() => stories.id),
  place_id: serial('place_id').references(() => places.id),
});

export const storySpeakers = pgTable('story_speakers', {
  story_id: serial('story_id').references(() => stories.id),
  speaker_id: serial('speaker_id').references(() => speakers.id),
});

// File attachments table (replacing ActiveStorage)
export const attachments = pgTable('attachments', {
  id: serial('id').primaryKey(),
  filename: text('filename').notNull(),
  content_type: text('content_type').notNull(),
  file_size: serial('file_size'),
  url: text('url').notNull(),
  attachable_type: text('attachable_type').notNull(), // 'Story', 'Place', 'Speaker'
  attachable_id: serial('attachable_id').notNull(),
  attachment_type: text('attachment_type').notNull(), // 'media', 'photo', 'audio'
});

// Define relations
export const storiesRelations = relations(stories, ({ one, many }) => ({
  community: one(communities, {
    fields: [stories.community_id],
    references: [communities.id],
  }),
  storyPlaces: many(storyPlaces),
  storySpeakers: many(storySpeakers),
  attachments: many(attachments),
}));
```

## Migration Plan: Phase-by-Phase Approach

### Phase 1: Backend API Modernization (4-6 weeks)

**Objective**: Transform Rails from a monolithic app to an API-first backend while maintaining current functionality.

#### Week 1-2: API Layer Development

```typescript
// Create standardized API responses
interface ApiResponse<T> {
  data: T;
  meta?: {
    pagination?: PaginationMeta;
    permissions?: string[];
  };
  errors?: ApiError[];
}

// Example API endpoint structure
app.get('/api/v1/communities/:id/stories', async (req, res) => {
  const { id } = req.params;
  const { page = 1, per_page = 20 } = req.query;

  const stories = await db
    .select()
    .from(storiesTable)
    .leftJoin(storyPlaces, eq(stories.id, storyPlaces.story_id))
    .leftJoin(places, eq(storyPlaces.place_id, places.id))
    .where(eq(stories.community_id, parseInt(id)))
    .limit(per_page)
    .offset((page - 1) * per_page);

  res.json({
    data: stories,
    meta: {
      pagination: { page, per_page, total: stories.length },
    },
  });
});
```

#### Week 3-4: Database Migration Script

```sql
-- Migration script for ActiveStorage to attachments table
INSERT INTO attachments (filename, content_type, file_size, url, attachable_type, attachable_id, attachment_type)
SELECT
  ab.filename,
  ab.content_type,
  ab.byte_size,
  CONCAT('/storage/', ab.key),
  aa.record_type,
  aa.record_id,
  aa.name
FROM active_storage_attachments aa
JOIN active_storage_blobs ab ON aa.blob_id = ab.id;
```

#### Week 5-6: Authentication & Authorization

```typescript
// JWT-based authentication middleware
const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!);
    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.userId));
    req.user = user[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Community-scoped authorization
const communityAuth = (req: Request, res: Response, next: NextFunction) => {
  const communityId = parseInt(req.params.communityId);
  if (
    req.user.role !== 'super_admin' &&
    req.user.community_id !== communityId
  ) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};
```

### Phase 2: Frontend React Application (6-8 weeks)

**Objective**: Build a standalone React application with modern tooling to replace the Rails-React hybrid.

#### Week 1-2: Project Setup and Build Configuration

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@services': path.resolve(__dirname, './src/services'),
      '@types': path.resolve(__dirname, './src/types'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'map-vendor': ['maplibre-gl'],
          'ui-vendor': ['@radix-ui/react-select', '@radix-ui/react-dialog'],
        },
      },
    },
  },
});
```

#### Week 3-4: State Management with Zustand

```typescript
// stores/appStore.ts
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface Story {
  id: number;
  title: string;
  description: string;
  places: Place[];
  speakers: Speaker[];
  media: Attachment[];
  restricted: boolean;
}

interface AppState {
  // State
  currentCommunity: Community | null;
  stories: Story[];
  selectedStory: Story | null;
  mapCenter: [number, number];
  user: User | null;

  // Actions
  setCurrentCommunity: (community: Community) => void;
  loadStories: () => Promise<void>;
  selectStory: (story: Story) => void;
  updateMapCenter: (center: [number, number]) => void;
  login: (credentials: LoginCredentials) => Promise<void>;
}

export const useAppStore = create<AppState>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        currentCommunity: null,
        stories: [],
        selectedStory: null,
        mapCenter: [-74.5, 40] as [number, number],
        user: null,

        // Actions
        setCurrentCommunity: (community) =>
          set({ currentCommunity: community }),

        loadStories: async () => {
          const { currentCommunity } = get();
          if (!currentCommunity) return;

          const response = await apiClient.get(
            `/communities/${currentCommunity.id}/stories`
          );
          set({ stories: response.data });
        },

        selectStory: (story) => {
          set({ selectedStory: story });
          if (story.places.length > 0) {
            const firstPlace = story.places[0];
            set({ mapCenter: [firstPlace.lng, firstPlace.lat] });
          }
        },

        login: async (credentials) => {
          const response = await apiClient.post('/auth/login', credentials);
          const { user, token } = response.data;
          localStorage.setItem('auth_token', token);
          set({ user });
        },
      }),
      { name: 'terrastories-app' }
    )
  )
);
```

#### Week 5-6: Core Components Migration

```typescript
// components/MapView.tsx
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useAppStore } from '@/stores/appStore';

export const MapView: React.FC = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const { stories, selectedStory, mapCenter, selectStory } = useAppStore();

  useEffect(() => {
    if (!mapContainer.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: '/map-styles/style.json', // Offline map style
      center: mapCenter,
      zoom: 12
    });

    // Add story markers
    stories.forEach(story => {
      story.places.forEach(place => {
        const marker = new maplibregl.Marker()
          .setLngLat([place.lng, place.lat])
          .addTo(map.current!);

        marker.getElement().addEventListener('click', () => {
          selectStory(story);
        });
      });
    });

    return () => {
      map.current?.remove();
    };
  }, [stories, mapCenter]);

  return <div ref={mapContainer} className="w-full h-full" />;
};

// components/StoryCard.tsx
import { Story } from '@/types';
import { MediaPlayer } from './MediaPlayer';

interface StoryCardProps {
  story: Story;
  onSelect: (story: Story) => void;
}

export const StoryCard: React.FC<StoryCardProps> = ({ story, onSelect }) => {
  return (
    <div
      className="p-4 border rounded-lg cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => onSelect(story)}
    >
      <h3 className="text-lg font-semibold mb-2">{story.title}</h3>
      <p className="text-gray-600 mb-3">{story.description}</p>

      {story.speakers.length > 0 && (
        <div className="mb-2">
          <span className="text-sm font-medium">Speakers: </span>
          {story.speakers.map(speaker => speaker.name).join(', ')}
        </div>
      )}

      {story.media.length > 0 && (
        <MediaPlayer media={story.media[0]} />
      )}
    </div>
  );
};
```

#### Week 7-8: Advanced Features Implementation

```typescript
// services/offlineService.ts
class OfflineService {
  private db: IDBDatabase | null = null;

  async init() {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('TerrастoriesOffline', 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object stores for offline data
        if (!db.objectStoreNames.contains('stories')) {
          db.createObjectStore('stories', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('places')) {
          db.createObjectStore('places', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('media')) {
          db.createObjectStore('media', { keyPath: 'id' });
        }
      };
    });
  }

  async cacheStories(stories: Story[]) {
    if (!this.db) await this.init();

    const transaction = this.db!.transaction(['stories'], 'readwrite');
    const store = transaction.objectStore('stories');

    for (const story of stories) {
      await store.put(story);
    }
  }

  async getOfflineStories(): Promise<Story[]> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['stories'], 'readonly');
      const store = transaction.objectStore('stories');
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export const offlineService = new OfflineService();
```

### Phase 3: File Storage Migration (3-4 weeks)

**Objective**: Replace ActiveStorage with a modern file handling system compatible with offline functionality.

#### Week 1-2: File Upload Service

```typescript
// services/fileService.ts
interface UploadOptions {
  onProgress?: (progress: number) => void;
  validate?: (file: File) => boolean;
}

class FileService {
  async uploadFile(
    file: File,
    attachableType: string,
    attachableId: number,
    options?: UploadOptions
  ): Promise<Attachment> {
    // Validate file
    if (options?.validate && !options.validate(file)) {
      throw new Error('File validation failed');
    }

    // Create form data
    const formData = new FormData();
    formData.append('file', file);
    formData.append('attachable_type', attachableType);
    formData.append('attachable_id', attachableId.toString());

    // Upload with progress tracking
    const response = await fetch('/api/v1/attachments', {
      method: 'POST',
      body: formData,
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
      },
    });

    if (!response.ok) {
      throw new Error('Upload failed');
    }

    return response.json();
  }

  validateAudioFile(file: File): boolean {
    const allowedTypes = ['audio/mpeg', 'audio/wav'];
    return allowedTypes.includes(file.type) && file.size < 50 * 1024 * 1024; // 50MB limit
  }

  validateImageFile(file: File): boolean {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    return allowedTypes.includes(file.type) && file.size < 10 * 1024 * 1024; // 10MB limit
  }
}

export const fileService = new FileService();
```

#### Week 3-4: Media Player Components

```typescript
// components/MediaPlayer.tsx
import { useState, useRef } from 'react';
import { Attachment } from '@/types';

interface MediaPlayerProps {
  media: Attachment;
  autoplay?: boolean;
}

export const MediaPlayer: React.FC<MediaPlayerProps> = ({ media, autoplay = false }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const togglePlay = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  if (media.attachment_type === 'audio' || media.content_type.startsWith('audio/')) {
    return (
      <div className="bg-gray-100 p-4 rounded-lg">
        <audio
          ref={audioRef}
          src={media.url}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => setIsPlaying(false)}
          preload="metadata"
        />

        <div className="flex items-center space-x-4">
          <button
            onClick={togglePlay}
            className="bg-blue-500 text-white p-2 rounded-full hover:bg-blue-600"
          >
            {isPlaying ? '⏸️' : '▶️'}
          </button>

          <div className="flex-1">
            <div className="text-sm text-gray-600 mb-1">{media.filename}</div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(currentTime / duration) * 100}%` }}
              />
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {Math.floor(currentTime)}s / {Math.floor(duration)}s
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Handle other media types (images, videos)
  return <div>Unsupported media type</div>;
};
```

### Phase 4: Integration and Testing (4-5 weeks)

**Objective**: Complete integration testing, performance optimization, and deployment preparation.

#### Week 1-2: API Integration Testing

```typescript
// tests/integration/api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers/database';
import { apiClient } from '@/services/apiClient';

describe('API Integration Tests', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('Stories API', () => {
    it('should load community stories', async () => {
      const response = await apiClient.get('/communities/1/stories');

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('data');
      expect(Array.isArray(response.data.data)).toBe(true);
    });

    it('should respect community permissions', async () => {
      // Test with unauthorized user
      const response = await apiClient.get('/communities/2/stories', {
        headers: { Authorization: 'Bearer invalid_token' },
      });

      expect(response.status).toBe(401);
    });

    it('should handle offline mode', async () => {
      // Mock offline condition
      jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

      const stories = await offlineService.getOfflineStories();
      expect(Array.isArray(stories)).toBe(true);
    });
  });
});
```

#### Week 3-4: Performance Optimization

```typescript
// utils/performanceOptimizations.ts
import { useMemo, useCallback } from 'react';
import { debounce } from 'lodash-es';

// Memoized story filtering
export const useFilteredStories = (stories: Story[], searchTerm: string, selectedSpeakers: number[]) => {
  return useMemo(() => {
    return stories.filter(story => {
      const matchesSearch = story.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           story.description.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesSpeakers = selectedSpeakers.length === 0 ||
                             story.speakers.some(speaker => selectedSpeakers.includes(speaker.id));

      return matchesSearch && matchesSpeakers;
    });
  }, [stories, searchTerm, selectedSpeakers]);
};

// Debounced search
export const useDebouncedSearch = (callback: (term: string) => void, delay: number = 300) => {
  return useCallback(
    debounce((term: string) => callback(term), delay),
    [callback, delay]
  );
};

// Virtual scrolling for large story lists
import { FixedSizeList as List } from 'react-window';

export const VirtualizedStoryList: React.FC<{ stories: Story[] }> = ({ stories }) => {
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => (
    <div style={style}>
      <StoryCard story={stories[index]} onSelect={selectStory} />
    </div>
  );

  return (
    <List
      height={600}
      itemCount={stories.length}
      itemSize={200}
      width="100%"
    >
      {Row}
    </List>
  );
};
```

#### Week 5: Deployment and Monitoring

```dockerfile
# Dockerfile for React app
FROM node:18-alpine as builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

```yaml
# docker-compose.yml updated
version: '3.8'
services:
  frontend:
    build: ./frontend
    ports:
      - '3000:80'
    depends_on:
      - api

  api:
    build: ./api
    ports:
      - '3001:3000'
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/terrastories
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - db

  db:
    image: postgis/postgis:14-3.2
    environment:
      - POSTGRES_DB=terrastories
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
    volumes:
      - postgres_data:/var/lib/postgresql/data

  tileserver:
    image: maptiler/tileserver-gl
    ports:
      - '8080:8080'
    volumes:
      - ./tileserver/data:/data

volumes:
  postgres_data:
```

## Critical Migration Challenges and Solutions

### Challenge 1: Offline-First Architecture

**Problem**: Maintaining offline functionality during migration
**Solution**:

- Implement IndexedDB for local data storage
- Create service workers for offline API caching
- Build sync mechanisms for when connectivity returns

### Challenge 2: ActiveStorage Migration

**Problem**: Complex file attachment system with metadata
**Solution**:

- Create migration scripts to preserve file relationships
- Implement compatible API endpoints for file uploads
- Maintain backward compatibility during transition

### Challenge 3: Multi-tenant Community System

**Problem**: Complex role-based access control and data scoping
**Solution**:

- Implement middleware for community-scoped queries in Drizzle
- Create robust authorization system with JWT tokens
- Maintain community isolation at database level

### Challenge 4: Map Integration Complexity

**Problem**: Custom MapLibre integration with offline tiles
**Solution**:

- Port existing MapLibre configuration to React
- Maintain tile server integration
- Preserve offline map functionality

## Timeline Estimates

**Total Migration Duration: 17-23 weeks (4-6 months)**

- **Phase 1** (Backend API): 4-6 weeks
- **Phase 2** (React Frontend): 6-8 weeks
- **Phase 3** (File Storage): 3-4 weeks
- **Phase 4** (Integration): 4-5 weeks

**Critical Path Dependencies**:

1. Database schema migration must complete before frontend development
2. API authentication system required before React app integration
3. File upload system needed before media player components
4. Offline functionality requires both frontend and backend completion

## Best Practices for Transition

### Parallel Development Strategy

1. **Maintain existing Rails app** while building new React app
2. **API-first development** - build endpoints that serve both old and new frontends
3. **Feature flags** to gradually migrate users to new interface
4. **Data validation** at both database and API levels

### Risk Mitigation

1. **Comprehensive testing suite** with integration tests
2. **Staged deployment** with rollback capabilities
3. **User acceptance testing** with Indigenous community partners
4. **Performance monitoring** to ensure offline functionality maintains speed
5. **Data backup strategies** before major migration steps

The migration to React + Drizzle ORM will modernize Terrastories' architecture while preserving its core mission of supporting Indigenous storytelling communities. The phased approach ensures minimal disruption to existing users while building a more maintainable and scalable platform.
