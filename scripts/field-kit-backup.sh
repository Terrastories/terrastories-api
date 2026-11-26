#!/bin/bash
# =============================================================================
# TERRASTORIES FIELD KIT BACKUP SCRIPT
# Lightweight backup for offline field deployment
# =============================================================================

set -e

# Configuration for field deployment
# The erasure-records volume (ERASURE_RECORDS_ROOT) is deliberately never mounted
# here or backed up (src/services/ERASURE-OPERATIONS.md).
# Paths default to the field-kit container mounts; the restore drills
# (tests/drills) override them to run the real procedure against a temp tree.
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DATA_DIR="${DATA_DIR:-/data}"
UPLOADS_DIR="${UPLOADS_DIR:-/uploads}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-3}"
COMPRESSION="${BACKUP_COMPRESSION:-true}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate backup filename
BACKUP_DATE=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="fieldkit_backup_${BACKUP_DATE}"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"

echo "Starting field kit backup..."
echo "Data directory: $DATA_DIR"
echo "Uploads directory: $UPLOADS_DIR"
echo "Backup name: $BACKUP_NAME"

# Create backup directory structure
mkdir -p "$BACKUP_PATH"

# Backup sqlite databases
if [ -d "$DATA_DIR" ]; then
    echo "Backing up sqlite databases..."
    cp -r "$DATA_DIR" "$BACKUP_PATH/data"
fi

# Backup uploaded files (full copy: every file in the manifest is in the backup)
if [ -d "$UPLOADS_DIR" ]; then
    echo "Backing up uploaded files..."
    # Full copy regardless of age: a restore must find every manifest entry.
    find "$UPLOADS_DIR" -type f -exec cp --parents {} "$BACKUP_PATH/" \;
    
    # Create manifest of all files
    find "$UPLOADS_DIR" -type f > "$BACKUP_PATH/uploads_manifest.txt"
fi

# Backup offline map tiles (critical for field operations)
TILES_DIR="${TILES_DIR:-/tiles}"
if [ -d "$TILES_DIR" ]; then
    echo "Backing up offline map tiles..."
    # Backup tiles directory for offline mapping
    cp -r "$TILES_DIR" "$BACKUP_PATH/tiles"
    echo "Map tiles backed up for offline use"
fi

# Create backup metadata
cat > "$BACKUP_PATH/backup_info.json" << EOF
{
  "backup_date": "$(date -Iseconds)",
  "backup_type": "field-kit",
  "hostname": "$(hostname)",
  "disk_usage": {
    "data_size": "$(du -sh $DATA_DIR 2>/dev/null | cut -f1 || echo 'N/A')",
    "uploads_size": "$(du -sh $UPLOADS_DIR 2>/dev/null | cut -f1 || echo 'N/A')",
    "backup_size": "$(du -sh $BACKUP_PATH | cut -f1)"
  }
}
EOF

# Compress backup if enabled
if [ "$COMPRESSION" = "true" ]; then
    echo "Compressing backup..."
    cd "$BACKUP_DIR"
    tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME"
    rm -rf "$BACKUP_NAME"
    FINAL_SIZE=$(du -h "${BACKUP_NAME}.tar.gz" | cut -f1)
    echo "Compressed backup created: ${BACKUP_NAME}.tar.gz ($FINAL_SIZE)"
else
    FINAL_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
    echo "Uncompressed backup created: $BACKUP_NAME ($FINAL_SIZE)"
fi

# Clean up old backups
echo "Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "fieldkit_backup_*" -type f -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "fieldkit_backup_*" -type d -mtime +$RETENTION_DAYS -exec rm -rf {} + 2>/dev/null || true

# Show remaining backups
echo "Remaining backups:"
ls -lah "$BACKUP_DIR"/fieldkit_backup_* 2>/dev/null || echo "No backups found"

echo "Field kit backup completed at $(date)"