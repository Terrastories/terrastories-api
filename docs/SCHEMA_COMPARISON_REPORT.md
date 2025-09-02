# Schema Comparison Report: Rails vs TypeScript

**Date**: 2025-09-02  
**Purpose**: Analyze differences between original Rails schema and our current TypeScript/Drizzle schema to identify migration gaps and alignment opportunities.

## Executive Summary

Our TypeScript schema has been **significantly enhanced** beyond the original Rails schema with modern features, cultural protocols, and multi-tenancy. However, we're **missing critical Rails fields** that need to be added for full compatibility.

### ✅ **Strengths of Current Schema**

- **Multi-database support** (PostgreSQL/SQLite)
- **Cultural sensitivity** (elder status, restrictions, protocols)
- **Enhanced multi-tenancy** (community isolation)
- **Modern validation** (Zod schemas, TypeScript types)
- **Media management** (replacing ActiveStorage)
- **Spatial optimization** (PostGIS ready)

### ⚠️ **Critical Missing Fields**

- User authentication fields (password reset, session tracking)
- Story metadata (interview details, permission levels)
- Community configuration (public/beta flags, country)
- Theme management (entire table missing)
- Relationship metadata (story-place cultural context exists, but limited)

---

## Detailed Field-by-Field Analysis

### 1. COMMUNITIES Table

| Field        | Rails Schema                      | TypeScript Schema         | Status          | Action Required     |
| ------------ | --------------------------------- | ------------------------- | --------------- | ------------------- |
| `id`         | `bigint NOT NULL`                 | `serial/integer`          | ✅ **Match**    | None                |
| `name`       | `character varying`               | `text` (required)         | ✅ **Enhanced** | None                |
| `locale`     | `character varying`               | `text` (default 'en')     | ✅ **Enhanced** | None                |
| `country`    | `character varying`               | ❌ **Missing**            | 🔴 **Add field** | Add country field   |
| `created_at` | `timestamp`                       | `timestamp`               | ✅ **Match**    | None                |
| `updated_at` | `timestamp`                       | `timestamp`               | ✅ **Match**    | None                |
| `beta`       | `boolean DEFAULT false`           | ❌ **Missing**            | 🔴 **Add field** | Add beta flag       |
| `public`     | `boolean DEFAULT false NOT NULL`  | `publicStories` (similar) | ✅ **Enhanced** | Consider renaming   |
| `slug`       | `character varying`               | `text` (unique)           | ✅ **Enhanced** | None                |
| `description` | `text`                           | `text` (optional)         | ✅ **Match**    | None                |
| **New Fields** | N/A                             | `culturalSettings`, `isActive` | ➕ **Enhancement** | Cultural support |

**Migration Priority**: 🟡 **Medium** - Add missing `country` and `beta` fields

### 2. USERS Table

| Field                   | Rails Schema                        | TypeScript Schema                 | Status          | Action Required          |
| ----------------------- | ----------------------------------- | --------------------------------- | --------------- | ------------------------ |
| `id`                    | `bigint NOT NULL`                   | `serial/integer`                  | ✅ **Match**    | None                     |
| `email`                 | `character varying`                 | `text` (required, unique per community) | ✅ **Enhanced** | None                     |
| `encrypted_password`    | `character varying DEFAULT '' NOT NULL` | `passwordHash`                    | ✅ **Enhanced** | None                     |
| `reset_password_token`  | `character varying`                 | ❌ **Missing**                    | 🔴 **Add field** | Add for password reset   |
| `reset_password_sent_at` | `timestamp`                        | ❌ **Missing**                    | 🔴 **Add field** | Add for password reset   |
| `remember_created_at`   | `timestamp`                         | ❌ **Missing**                    | 🔴 **Add field** | Add for session mgmt     |
| `sign_in_count`         | `integer DEFAULT 0 NOT NULL`       | ❌ **Missing**                    | 🔴 **Add field** | Add for analytics        |
| `current_sign_in_at`    | `timestamp`                         | `lastLoginAt` (similar)           | ✅ **Similar**  | Consider renaming        |
| `last_sign_in_at`       | `timestamp`                         | ❌ **Missing**                    | 🔴 **Add field** | Add for analytics        |
| `current_sign_in_ip`    | `character varying`                 | ❌ **Missing**                    | 🔴 **Add field** | Add for security         |
| **New Fields**          | N/A                                 | `firstName`, `lastName`, `role`, `communityId`, `isActive` | ➕ **Enhancement** | Multi-tenant + cultural roles |

**Migration Priority**: 🔴 **High** - Critical authentication fields missing

### 3. STORIES Table

| Field               | Rails Schema           | TypeScript Schema      | Status         | Action Required             |
| ------------------- | ---------------------- | ---------------------- | -------------- | --------------------------- |
| `id`                | `bigint NOT NULL`      | `serial/integer`       | ✅ **Match**   | None                        |
| `title`             | `character varying`    | `text` (required)      | ✅ **Match**   | None                        |
| `desc`              | `text`                 | `description`          | ✅ **Enhanced** | Field renamed for clarity   |
| `created_at`        | `timestamp`            | `timestamp`            | ✅ **Match**   | None                        |
| `updated_at`        | `timestamp`            | `timestamp`            | ✅ **Match**   | None                        |
| `permission_level`  | `integer`              | `isRestricted` (boolean) | 🟡 **Different** | Consider integer vs boolean |
| `date_interviewed`  | `timestamp`            | ❌ **Missing**         | 🔴 **Add field** | Add interview metadata      |
| `language`          | `character varying`    | `text` (default 'en')  | ✅ **Enhanced** | None                        |
| `interview_location_id` | `integer`          | ❌ **Missing**         | 🔴 **Add field** | Add location reference      |
| `interviewer_id`    | `integer`              | ❌ **Missing**         | 🔴 **Add field** | Add interviewer reference   |
| **New Fields**      | N/A                    | `slug`, `communityId`, `createdBy`, `mediaUrls`, `tags` | ➕ **Enhancement** | Modern content management |

**Migration Priority**: 🔴 **High** - Missing interview metadata critical for Indigenous storytelling

### 4. PLACES Table

| Field          | Rails Schema              | TypeScript Schema      | Status          | Action Required               |
| -------------- | ------------------------- | ---------------------- | --------------- | ----------------------------- |
| `id`           | `bigint NOT NULL`         | `serial/integer`       | ✅ **Match**    | None                          |
| `name`         | `character varying`       | `text` (required)      | ✅ **Match**    | None                          |
| `type_of_place` | `character varying`      | ❌ **Missing**         | 🔴 **Add field** | Add place type classification |
| `created_at`   | `timestamp`               | `timestamp`            | ✅ **Match**    | None                          |
| `updated_at`   | `timestamp`               | `timestamp`            | ✅ **Match**    | None                          |
| `lat`          | `numeric(10,6)`           | `latitude` (real)      | ✅ **Enhanced** | Better precision handling     |
| `long`         | `numeric(10,6)`           | `longitude` (real)     | ✅ **Enhanced** | Better precision handling     |
| `region`       | `character varying`       | `text` (optional)      | ✅ **Match**    | None                          |
| `description`  | `character varying`       | `text` (optional)      | ✅ **Enhanced** | None                          |
| `community_id` | `integer`                 | `communityId`          | ✅ **Match**    | None                          |
| **New Fields** | N/A                       | `mediaUrls`, `culturalSignificance`, `isRestricted` | ➕ **Enhancement** | Cultural protocol support |

**Migration Priority**: 🟡 **Medium** - Add `type_of_place` field

### 5. SPEAKERS Table

| Field              | Rails Schema        | TypeScript Schema     | Status          | Action Required          |
| ------------------ | ------------------- | --------------------- | --------------- | ------------------------ |
| `id`               | `bigint NOT NULL`   | `serial/integer`      | ✅ **Match**    | None                     |
| `name`             | `character varying` | `text` (required)     | ✅ **Match**    | None                     |
| `created_at`       | `timestamp`         | `timestamp`           | ✅ **Match**    | None                     |
| `updated_at`       | `timestamp`         | `timestamp`           | ✅ **Match**    | None                     |
| `birthdate`        | `timestamp`         | `birthYear` (integer) | 🟡 **Different** | Year vs full date consideration |
| `birthplace_id`    | `integer`           | ❌ **Missing**        | 🔴 **Add field** | Add birthplace reference |
| `speaker_community` | `character varying` | `culturalRole` (similar) | ✅ **Enhanced** | Better cultural context |
| `community_id`     | `integer`           | `communityId`         | ✅ **Match**    | None                     |
| **New Fields**     | N/A                 | `bio`, `photoUrl`, `elderStatus`, `isActive` | ➕ **Enhancement** | Richer speaker profiles |

**Migration Priority**: 🟡 **Medium** - Add `birthplace_id` field

### 6. MISSING TABLE: THEMES

**Rails Schema:**

```sql
themes:
• id bigint NOT NULL
• active boolean DEFAULT false NOT NULL
• created_at timestamp NOT NULL
• updated_at timestamp NOT NULL
• mapbox_style_url character varying
• mapbox_access_token character varying
• center_lat numeric(10,6)
• center_long numeric(10,6)
• sw_boundary_lat numeric(10,6)
• sw_boundary_long numeric(10,6)
... and 10 more columns
```

**TypeScript Schema:** ❌ **Completely Missing**

**Migration Priority**: 🔴 **High** - Themes control map visualization, critical for Terrastories functionality

### 7. RELATIONSHIP TABLES

#### Story-Places Join Table

| Field          | Rails Schema      | TypeScript Schema | Status          | Action Required                  |
| -------------- | ----------------- | ----------------- | --------------- | -------------------------------- |
| `id`           | `bigint NOT NULL` | `serial/integer`  | ✅ **Match**    | None                             |
| `story_id`     | `bigint NOT NULL` | `storyId` (integer) | ✅ **Match**    | None                             |
| `place_id`     | `bigint NOT NULL` | `placeId` (integer) | ✅ **Match**    | None                             |
| **New Fields** | N/A               | `culturalContext`, `sortOrder`, timestamps | ➕ **Enhancement** | Better relationship metadata |

#### Story-Speakers Join Table

| Field          | Rails Schema      | TypeScript Schema | Status          | Action Required                  |
| -------------- | ----------------- | ----------------- | --------------- | -------------------------------- |
| `id`           | `bigint NOT NULL` | `serial/integer`  | ✅ **Match**    | None                             |
| `story_id`     | `bigint NOT NULL` | `storyId` (integer) | ✅ **Match**    | None                             |
| `speaker_id`   | `bigint NOT NULL` | `speakerId` (integer) | ✅ **Match**    | None                             |
| **New Fields** | N/A               | `storyRole`, `sortOrder`, timestamps | ➕ **Enhancement** | Better relationship metadata |

### 8. MEDIA MANAGEMENT

**Rails ActiveStorage** (3 tables):

- `active_storage_attachments`
- `active_storage_blobs`
- `active_storage_variant_records`

**TypeScript Approach** (2 tables):

- `files` (enhanced metadata, cultural restrictions)
- `attachments` (polymorphic relationships)

**Migration Priority**: 🟡 **Medium** - Our approach is more appropriate for Indigenous communities

---

## Migration Recommendations

### Phase 1: Critical Missing Fields (Immediate - Next PR)

1. **Add THEMES table** - Complete schema with all Rails fields
2. **Enhance USERS table** - Add authentication fields:
   - `resetPasswordToken`
   - `resetPasswordSentAt`
   - `rememberCreatedAt`
   - `signInCount`
   - `lastSignInAt`
   - `currentSignInIp`

### Phase 2: Story Enhancement (Week 2)

3. **Enhance STORIES table** - Add interview metadata:
   - `dateInterviewed`
   - `interviewLocationId` (foreign key to places)
   - `interviewerId` (foreign key to users)
   - Consider changing `isRestricted` to `permissionLevel` integer

### Phase 3: Community & Place Enhancement (Week 3)

4. **Enhance COMMUNITIES table** - Add Rails compatibility:
   - `country` field
   - `beta` flag
5. **Enhance PLACES table** - Add classification:
   - `typeOfPlace` field
6. **Enhance SPEAKERS table** - Add demographics:
   - `birthplaceId` (foreign key to places)
   - Consider `birthdate` vs `birthYear` for privacy

### Phase 4: Data Migration Utilities (Week 4)

7. **Create migration utilities** to transform Rails data to TypeScript schema
8. **Validation scripts** to ensure data integrity during migration
9. **Rollback procedures** for safe deployment

---

## Schema Enhancement Assessment

### Our Improvements Over Rails

✅ **Multi-Database Support**: PostgreSQL + SQLite compatibility  
✅ **Cultural Protocols**: Elder status, restrictions, cultural roles  
✅ **Data Sovereignty**: Community isolation, proper multi-tenancy  
✅ **Modern Validation**: Zod schemas, TypeScript safety  
✅ **Spatial Optimization**: PostGIS-ready geometry handling  
✅ **Enhanced Media**: Metadata, restrictions, better file management  
✅ **Performance**: Proper indexing, efficient queries

### Rails Fields We Should Consider Adopting

🔴 **Authentication System**: Complete Devise-compatible fields  
🔴 **Interview Metadata**: Critical for Indigenous storytelling context  
🔴 **Theme Management**: Map visualization configuration  
🟡 **Place Classification**: Geographic type taxonomy  
🟡 **Community Configuration**: Beta/public deployment flags

---

## Conclusion

Our TypeScript schema represents a **significant advancement** over the Rails schema with enhanced cultural sensitivity, data sovereignty, and modern development practices. However, we need to **add critical missing fields** to maintain compatibility with existing Terrastories installations and preserve essential functionality.

**Next Steps**:

1. Create Phase 1 migration to add critical missing fields
2. Update validation schemas to include new fields
3. Test compatibility with existing Rails data exports
4. Document migration path for existing Terrastories communities

**Estimated Timeline**: 2-3 weeks to achieve full Rails compatibility while preserving our enhancements.