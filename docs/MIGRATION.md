# ActiveStorage to TypeScript File System Migration Guide

## 🎉 Migration Status: **COMPLETED**

**As of 2025-09-12**: The Rails ActiveStorage to TypeScript file system migration has been successfully completed. This guide is maintained for historical reference and knowledge preservation.

**Migration Outcome**:

- ✅ **Zero Data Loss**: All files and associations preserved
- ✅ **Indigenous Data Sovereignty**: Community data isolation maintained
- ✅ **File Integrity**: All files verified and operational
- ✅ **Audit Trail**: Complete logging preserved for Indigenous oversight
- ✅ **Legacy Code Cleanup**: ActiveStorage infrastructure safely removed

---

## 📋 Historical Overview

**Purpose**: This migration moved from Rails ActiveStorage to TypeScript file service while preserving all files, associations, and cultural protocols.

**Migration Path**:

- **FROM**: ActiveStorage (database tables + hashed file structure)
- **TO**: Community-scoped TypeScript file service (direct file paths in database)

**Critical Requirements**:

- 🛡️ **Zero Data Loss**: All files and associations must be preserved
- 🏛️ **Indigenous Data Sovereignty**: Community data isolation maintained
- 📊 **File Integrity**: All files verified using checksums
- 🔄 **Rollback Capability**: Full restoration possible if issues occur
- 📋 **Audit Trail**: Complete logging for Indigenous oversight

## 🚨 Pre-Migration Requirements

### 1. System Preparation

```bash
# Ensure you have adequate disk space (2x current ActiveStorage size)
df -h

# Verify database access
npm run db:migrate

# Verify TypeScript API is running
npm run dev
```

### 2. Environment Variables

```bash
# Required environment variables in .env
DATABASE_URL="postgresql://user:password@localhost/terrastories_db"
ACTIVE_STORAGE_PATH="/path/to/rails/storage"
UPLOADS_PATH="./uploads"

# Optional
MIGRATION_LOG_LEVEL="info"
MIGRATION_MAX_CONCURRENT="10"
```

### 3. Backup Strategy

⚠️ **CRITICAL**: Always create comprehensive backups before migration

```bash
# Create database backup
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql

# Create ActiveStorage files backup
cp -r /path/to/rails/storage backup_storage_$(date +%Y%m%d_%H%M%S)

# Verify backup integrity
psql $DATABASE_URL < backup_YYYYMMDD_HHMMSS.sql --dry-run
```

## 🔍 Phase 1: Analysis

### Step 1: Analyze ActiveStorage Structure

```bash
# Analyze current ActiveStorage setup
npm run migrate:activestorage analyze
```

**Expected Output**:

```json
{
  "tablesFound": [
    "active_storage_blobs",
    "active_storage_attachments",
    "active_storage_variant_records"
  ],
  "blobsCount": 1250,
  "attachmentsCount": 890,
  "variantsCount": 340,
  "totalFileSize": 2147483648
}
```

### Step 2: Identify Communities and File Associations

```bash
# Review file associations by community
npm run migrate:activestorage analyze 2>&1 | grep "Community"
```

### Step 3: Check for Potential Issues

The analyzer will identify:

- **Duplicate filenames** requiring resolution
- **Cross-community conflicts** (files used by multiple communities)
- **Invalid filenames** with special characters
- **Oversized files** exceeding limits
- **Missing files** referenced in database but not on disk
- **Corrupted files** with checksum mismatches

## 🧪 Phase 2: Dry Run Validation

### Step 1: Perform Comprehensive Dry Run

```bash
# Run full migration simulation (no changes made)
npm run migrate:activestorage dry-run
```

**Review Output**:

```json
{
  "dryRun": true,
  "filesAnalyzed": 1250,
  "communitiesAffected": 12,
  "estimatedDuration": "15 minutes",
  "potentialIssues": [
    "5 duplicate filenames need resolution",
    "2 files used across multiple communities",
    "1 file has invalid characters"
  ],
  "rollbackPlan": {
    "backupSize": 2147483648,
    "rollbackSteps": [
      "Restore database from backup",
      "Restore ActiveStorage file structure",
      "Remove migrated community directories",
      "Verify ActiveStorage functionality"
    ]
  }
}
```

### Step 2: Address Issues Identified

**For Duplicate Filenames**:

- The migration script will automatically append numeric suffixes
- Review the naming strategy in dry run output

**For Cross-Community Conflicts**:

- Files will be copied to each community directory
- Original ActiveStorage files remain until migration completes

**For Invalid Characters**:

- Files will be renamed with sanitized names
- Original mapping preserved in migration log

### Step 3: Validate Migration Plan

Ensure the migration plan aligns with Indigenous community requirements:

```bash
# Review cultural compliance
grep -i "cultural\|elder\|restricted" migration_plan.log
```

## 🚀 Phase 3: Production Migration

### Step 1: Final Pre-Migration Checklist

- [ ] ✅ **Database backup verified**
- [ ] ✅ **ActiveStorage files backup verified**
- [ ] ✅ **Dry run completed successfully**
- [ ] ✅ **All identified issues addressed**
- [ ] ✅ **Adequate disk space confirmed**
- [ ] ✅ **TypeScript API tested and working**
- [ ] ✅ **Indigenous community stakeholders notified**
- [ ] ✅ **Maintenance window scheduled**

### Step 2: Migrate Single Community (Recommended)

Start with a small community to validate the process:

```bash
# Migrate specific community
npm run migrate:activestorage migrate --community=1

# Monitor progress
tail -f migration.log
```

**Expected Output**:

```json
{
  "success": true,
  "communityId": 1,
  "filesProcessed": 45,
  "filesMigrated": 43,
  "filesSkipped": 2,
  "errors": [],
  "duration": "2m 15s",
  "backupCreated": "./backup-20250830-143022",
  "culturalRestrictions": {
    "elderOnlyFiles": 5,
    "restrictedFiles": 2,
    "publicFiles": 36,
    "auditTrailCreated": true
  }
}
```

### Step 3: Validate Single Community Migration

```bash
# Test API endpoints for migrated community
curl -X GET "http://localhost:3000/api/communities/1/stories" \
  -H "Cookie: connect.sid=your-session-cookie"

# Verify file accessibility
curl -X GET "http://localhost:3000/uploads/community_1/stories/example.jpg"

# Check database updates
psql $DATABASE_URL -c "SELECT id, media_urls FROM stories WHERE community_id = 1 LIMIT 5;"
```

### Step 4: Migrate All Communities

Once single community validation passes:

```bash
# Migrate all communities
npm run migrate:activestorage migrate --all-communities

# Monitor overall progress
tail -f migration_all.log
```

## 🗂️ Database Schema Changes

### Before Migration (ActiveStorage)

```sql
-- ActiveStorage tables
active_storage_blobs (id, key, filename, content_type, metadata, byte_size, checksum, created_at)
active_storage_attachments (id, name, record_type, record_id, blob_id, created_at)
active_storage_variant_records (id, blob_id, variation_digest, created_at)

-- Model tables with no direct file references
stories (id, title, desc, community_id, ...)
places (id, name, description, community_id, ...)
speakers (id, name, bio, community_id, ...)
```

### After Migration (TypeScript)

```sql
-- ActiveStorage tables remain but are no longer used
-- Model tables now have direct file path references

stories (id, title, desc, community_id, media_urls, ...)
-- media_urls: JSON array like ["uploads/community_1/stories/video1.mp4", "uploads/community_1/stories/image1.jpg"]

places (id, name, description, community_id, photo_url, name_audio_url, ...)
-- photo_url: "uploads/community_1/places/mountain_photo.jpg"
-- name_audio_url: "uploads/community_1/places/mountain_name.mp3"

speakers (id, name, bio, community_id, photo_url, ...)
-- photo_url: "uploads/community_1/speakers/elder_john.jpg"
```

## 📁 File System Structure

### Before: ActiveStorage Structure

```
storage/
├── ab/
│   └── cd/
│       └── abcd1234567890ef... (hashed filename)
├── 12/
│   └── 34/
│       └── 1234567890abcdef... (hashed filename)
└── ...
```

### After: Community-Scoped Structure

```
uploads/
├── community_1/
│   ├── stories/
│   │   ├── traditional_story_video.mp4
│   │   └── cultural_image.jpg
│   ├── places/
│   │   ├── sacred_mountain.jpg
│   │   └── mountain_name_pronunciation.mp3
│   └── speakers/
│       └── elder_john_photo.jpg
├── community_2/
│   ├── stories/
│   ├── places/
│   └── speakers/
└── ...
```

### File Naming Strategy

1. **Sanitization**: Special characters replaced with underscores
2. **Collision Resolution**: Duplicate names get numeric suffixes (e.g., `file_1.jpg`, `file_2.jpg`)
3. **Extension Preservation**: Original file extensions maintained
4. **Cultural Sensitivity**: Elder-only files flagged in audit log

## 🛡️ Data Sovereignty & Cultural Protocols

### Community Data Isolation

Each community's files are isolated in separate directories:

```
uploads/community_{id}/
```

### Cultural Restrictions

- **Elder-only content**: Flagged during migration for special handling
- **Restricted content**: Access controls preserved from original system
- **Public content**: Generally accessible files

### Audit Trail

Complete audit trail maintained in `migration_audit.log`:

```
2025-08-30 14:30:22 [INFO] Starting migration for community 1
2025-08-30 14:30:23 [INFO] Processing elder-only file: sacred_ceremony.mp4
2025-08-30 14:30:24 [WARN] File renamed due to invalid characters: story-with-special!chars.jpg -> story-with-special_chars.jpg
2025-08-30 14:30:25 [INFO] Migration completed for community 1
```

## 🔄 Rollback Procedures

### When to Rollback

Rollback if any of these conditions occur:

- **File integrity checks fail** (checksum mismatches)
- **Database updates fail** (transaction errors)
- **API endpoints return errors** for migrated communities
- **Cultural protocol violations** identified
- **Performance degradation** beyond acceptable limits

### Rollback Steps

```bash
# 1. Stop the TypeScript API
pm2 stop terrastories-api

# 2. Perform database rollback
psql $DATABASE_URL < backup_20250830_143022.sql

# 3. Restore ActiveStorage files
rm -rf storage/
cp -r backup_storage_20250830_143022 storage/

# 4. Remove migrated community directories
rm -rf uploads/community_*

# 5. Verify ActiveStorage functionality
curl -X GET "http://rails-app/api/communities/1/stories"

# 6. Restart services
pm2 start terrastories-api
```

### Automated Rollback

The migration script includes automated rollback on failure:

```bash
# Rollback from specific backup
npm run migrate:activestorage rollback --backup-path=./backup-20250830-143022
```

## ✅ Post-Migration Validation

### Step 1: File Integrity Validation

```bash
# Run comprehensive validation
npm run test:migration

# Check specific community
npm run migrate:activestorage validate --community=1
```

### Step 2: API Endpoint Testing

```bash
# Test all migrated endpoints
npm run test:compatibility

# Test file serving
curl -I "http://localhost:3000/uploads/community_1/stories/example.jpg"
```

### Step 3: Performance Validation

```bash
# Performance benchmarks
npm run test:performance

# Load testing with migrated files
npm run test:load -- --community=1
```

### Step 4: Cultural Compliance Check

Verify cultural protocols are maintained:

```bash
# Check elder-only file access
curl -H "Authorization: Bearer elder-token" \
  "http://localhost:3000/uploads/community_1/stories/elder_only.mp4"

# Verify restricted content protection
curl -H "Authorization: Bearer viewer-token" \
  "http://localhost:3000/uploads/community_1/stories/restricted.mp4"
```

## 🔧 Troubleshooting

### Common Issues

#### Issue: "Checksum mismatch during validation"

```bash
# Solution: Re-run migration for specific files
npm run migrate:activestorage repair --community=1 --verify-checksums
```

#### Issue: "Database transaction failed"

```bash
# Solution: Check database connection and retry
psql $DATABASE_URL -c "SELECT 1;"
npm run migrate:activestorage migrate --community=1 --retry
```

#### Issue: "Insufficient disk space"

```bash
# Solution: Clean up temporary files and ensure 2x space
df -h
rm -rf /tmp/migration_*
```

#### Issue: "Cultural protocol violation"

```bash
# Solution: Review audit log and apply manual corrections
grep "VIOLATION" migration_audit.log
# Contact community elders for guidance
```

### Recovery Strategies

1. **Partial Failure**: Migrate remaining communities individually
2. **Data Corruption**: Restore from backup and retry with different settings
3. **Performance Issues**: Adjust `MIGRATION_MAX_CONCURRENT` setting
4. **Cultural Concerns**: Pause migration and consult community stakeholders

## 📊 Success Metrics

### Technical Validation

- [ ] ✅ **All files migrated** (count verification)
- [ ] ✅ **Database records updated** (schema compliance)
- [ ] ✅ **File integrity maintained** (checksum verification)
- [ ] ✅ **API endpoints functional** (integration testing)
- [ ] ✅ **Performance acceptable** (< 2x response time increase)

### Cultural Compliance

- [ ] ✅ **Community data isolated** (no cross-community file access)
- [ ] ✅ **Elder permissions preserved** (access control testing)
- [ ] ✅ **Audit trail complete** (all actions logged)
- [ ] ✅ **Cultural protocols respected** (community stakeholder approval)

### Operational Readiness

- [ ] ✅ **Backup strategy tested** (rollback validation)
- [ ] ✅ **Documentation complete** (this guide and API docs)
- [ ] ✅ **Team training completed** (operations handover)
- [ ] ✅ **Monitoring in place** (error tracking and alerts)

## 📞 Support & Contacts

### Technical Issues

- **Developer Team**: Check GitHub issues or create new issue
- **Database Issues**: Database administrator contact
- **Infrastructure**: DevOps/infrastructure team

### Cultural Protocol Questions

- **Community Relations**: Contact appropriate community liaisons
- **Elder Council**: Escalate through proper cultural channels
- **Data Sovereignty**: Indigenous data governance representatives

### Emergency Rollback

- **24/7 Support**: Emergency contact for immediate rollback
- **Backup Recovery**: Data recovery specialist contact
- **Community Notification**: Communication channels for affected communities

## 📚 Additional Resources

- **Rails ActiveStorage Docs**: Understanding the original system
- **Terrastories API Docs**: TypeScript API endpoint documentation
- **Indigenous Data Governance**: Cultural protocols and sovereignty guidelines
- **File Service Documentation**: Technical details of new file handling system

---

## 🚀 Current System (Post-Migration)

**Active File System**: Native TypeScript file service (`file-v2.service.ts`)

- **File Structure**: `uploads/<community>/<entity>/<id>/`
- **Database**: Direct file paths stored (no ActiveStorage tables)
- **Cultural Protocols**: Fully preserved and enforced
- **Data Sovereignty**: Community isolation maintained
- **Performance**: Improved with direct file access

**Archived Components**:

- **Migration Tools**: Available in `archive/migration-tools/` for reference
- **Legacy ActiveStorage Code**: Safely removed (4,318 lines cleaned up)
- **Completion Record**: Full audit trail in `archive/cleanup-completion-record.json`

---

**Version**: 2.0 (Migration Complete)  
**Last Updated**: September 12, 2025  
**Migration Completed**: September 12, 2025

✅ **Migration Complete**: This system successfully transitioned from Rails ActiveStorage to TypeScript file service while maintaining all Indigenous data sovereignty protections and cultural protocols.
