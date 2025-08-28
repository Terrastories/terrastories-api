#!/bin/bash
# =============================================================================
# TERRASTORIES DATABASE BACKUP SCRIPT
# Production backup with retention policy
# =============================================================================

# Enable strict error handling
set -euo pipefail

# Trap to handle errors and provide cleanup
trap 'echo "ERROR: Backup failed at $(date)" >&2; cleanup_on_error; exit 1' ERR

# Cleanup function for error handling
cleanup_on_error() {
    echo "Cleaning up partial backup files..." >&2
    [ -f "${BACKUP_PATH}.custom" ] && rm -f "${BACKUP_PATH}.custom"
    [ -f "${BACKUP_PATH}" ] && rm -f "${BACKUP_PATH}"
    [ -f "${BACKUP_PATH}.gz" ] && rm -f "${BACKUP_PATH}.gz"
}

# Configuration
BACKUP_DIR="/backups"
DB_HOST="${POSTGRES_HOST:-db}"
DB_NAME="${POSTGRES_DB:-terrastories}"
DB_USER="${POSTGRES_USER:-terrastories}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate backup filename with timestamp
BACKUP_DATE=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="terrastories_backup_${BACKUP_DATE}.sql"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILE"

echo "Starting database backup..."
echo "Database: $DB_NAME"
echo "Host: $DB_HOST"
echo "Backup file: $BACKUP_FILE"

# Create database backup using pg_dump (custom format)
echo "Creating custom format backup..."
if ! PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    --host="$DB_HOST" \
    --username="$DB_USER" \
    --dbname="$DB_NAME" \
    --verbose \
    --clean \
    --no-owner \
    --no-privileges \
    --format=custom \
    --file="$BACKUP_PATH.custom"; then
    echo "ERROR: Custom format backup failed" >&2
    exit 1
fi

# Also create a plain SQL backup for easier inspection
echo "Creating plain SQL backup..."
if ! PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    --host="$DB_HOST" \
    --username="$DB_USER" \
    --dbname="$DB_NAME" \
    --clean \
    --no-owner \
    --no-privileges \
    --format=plain \
    --file="$BACKUP_PATH"; then
    echo "ERROR: Plain SQL backup failed" >&2
    exit 1
fi

# Compress the plain SQL backup
echo "Compressing plain SQL backup..."
if ! gzip "$BACKUP_PATH"; then
    echo "ERROR: Compression failed" >&2
    exit 1
fi

# Get backup file sizes
CUSTOM_SIZE=$(du -h "${BACKUP_PATH}.custom" | cut -f1)
SQL_SIZE=$(du -h "${BACKUP_PATH}.gz" | cut -f1)

# Clear error trap since we've successfully completed all critical operations
trap - ERR

echo "Backup completed successfully!"
echo "Custom format: ${BACKUP_FILE}.custom (${CUSTOM_SIZE})"
echo "SQL format (compressed): ${BACKUP_FILE}.gz (${SQL_SIZE})"

# Clean up old backups based on retention policy
echo "Cleaning up backups older than $RETENTION_DAYS days..."

find "$BACKUP_DIR" -name "terrastories_backup_*.sql*" -type f -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "terrastories_backup_*.custom" -type f -mtime +$RETENTION_DAYS -delete

# List remaining backups
echo "Remaining backups:"
ls -lah "$BACKUP_DIR"/terrastories_backup_* 2>/dev/null || echo "No backups found"

echo "Backup process completed at $(date)"