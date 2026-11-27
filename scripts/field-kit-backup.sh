#!/bin/sh
# =============================================================================
# TERRASTORIES FIELD KIT BACKUP SCRIPT
# Lightweight backup for offline field deployment.
# POSIX sh: runs under BusyBox ash in the field-kit container (no bash, no GNU
# cp --parents). Any failed copy fails the whole backup (set -e, no find -exec
# predicates), so an archive is never reported complete when it is not.
# =============================================================================

set -eu
# Archives hold community content and password verifiers: owner-only.
umask 077

# Configuration for field deployment
# The erasure-records volume (ERASURE_RECORDS_ROOT) is deliberately never mounted
# here or backed up (src/services/ERASURE-OPERATIONS.md).
# Paths default to the field-kit container mounts; the restore drills
# (tests/drills) override them to run the real procedure against a temp tree.
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DATA_DIR="${DATA_DIR:-/data}"
UPLOADS_DIR="${UPLOADS_DIR:-/uploads}"
TILES_DIR="${TILES_DIR:-/tiles}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-3}"
COMPRESSION="${BACKUP_COMPRESSION:-true}"
# Online-backup helper (node + better-sqlite3 in the app image); the sqlite3
# CLI is used when the helper is not configured.
SQLITE_BACKUP_HELPER="${SQLITE_BACKUP_HELPER:-}"

mkdir -p "$BACKUP_DIR"

BACKUP_DATE=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="fieldkit_backup_${BACKUP_DATE}"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
# Work in a hidden .partial- directory and rename on success, so a failed or
# killed run never leaves something that looks like a valid backup.
WORK_PATH="$BACKUP_DIR/.partial-$BACKUP_NAME"
LIST_FILE="$BACKUP_DIR/.${BACKUP_NAME}.list"
KEYS_FILE="$BACKUP_DIR/.${BACKUP_NAME}.keys"
PARTIAL_ARCHIVE="$BACKUP_DIR/.partial-${BACKUP_NAME}.tar.gz"
trap 'rm -f "$LIST_FILE" "$KEYS_FILE" "$PARTIAL_ARCHIVE"; [ -d "$WORK_PATH" ] && rm -rf "$WORK_PATH"' EXIT

echo "Starting field kit backup..."
echo "Data directory: $DATA_DIR"
echo "Uploads directory: $UPLOADS_DIR"
echo "Backup name: $BACKUP_NAME"

mkdir -p "$WORK_PATH"

# Consistent copy of a live SQLite database through the online backup API;
# a raw file copy could capture a torn write, so there is no cp fallback.
sqlite_copy() {
    if [ -n "$SQLITE_BACKUP_HELPER" ] && command -v node >/dev/null 2>&1; then
        node "$SQLITE_BACKUP_HELPER" "$1" "$2"
    elif command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$1" ".backup '$2'"
    else
        echo "ERROR: no online SQLite backup tool (node helper or sqlite3)" >&2
        return 1
    fi
}

# Active storage keys a backed-up database references (empty without a files table).
storage_keys() {
    if [ -n "$SQLITE_BACKUP_HELPER" ] && command -v node >/dev/null 2>&1; then
        node "$SQLITE_BACKUP_HELPER" --storage-keys "$1"
    elif command -v sqlite3 >/dev/null 2>&1; then
        # Query errors fail the backup (no hiding); only a missing files table is empty.
        has_files=$(sqlite3 "$1" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'") || return 1
        if [ -n "$has_files" ]; then
            sqlite3 "$1" "SELECT storage_key FROM files WHERE storage_key IS NOT NULL AND is_active = 1" || return 1
        fi
    else
        echo "ERROR: no SQLite tool to verify storage keys" >&2
        return 1
    fi
}

# Backup the data directory: databases through the online backup API, every
# other file (except journal/WAL sidecars, which the backup API folds in) as-is.
if [ -d "$DATA_DIR" ]; then
    echo "Backing up sqlite databases..."
    mkdir -p "$WORK_PATH/data"
    find "$DATA_DIR" -type f > "$LIST_FILE"
    while IFS= read -r f; do
        rel="${f#"$DATA_DIR"/}"
        mkdir -p "$WORK_PATH/data/$(dirname "$rel")"
        case "$f" in
            *-wal|*-shm|*-journal) ;;
            *.db|*.sqlite|*.sqlite3) sqlite_copy "$f" "$WORK_PATH/data/$rel" ;;
            *) cp -p "$f" "$WORK_PATH/data/$rel" ;;
        esac
    done < "$LIST_FILE"
fi

# Backup every uploaded file, whatever its age, keeping the absolute path
# under the archive root (restore layout: <archive>/<UPLOADS_DIR>/...).
if [ -d "$UPLOADS_DIR" ]; then
    echo "Backing up uploaded files..."
    find "$UPLOADS_DIR" -type f > "$LIST_FILE"
    while IFS= read -r f; do
        mkdir -p "$WORK_PATH$(dirname "$f")"
        cp -p "$f" "$WORK_PATH$f"
    done < "$LIST_FILE"
    cp "$LIST_FILE" "$WORK_PATH/uploads_manifest.txt"
    # Every manifest entry must exist in the backup.
    while IFS= read -r f; do
        [ -f "$WORK_PATH$f" ] || { echo "ERROR: missing in backup: $f" >&2; exit 1; }
    done < "$WORK_PATH/uploads_manifest.txt"
fi

# Rows never precede their bytes (storage.put before the files row: media-writes.service.ts
# uploadMedia/registerStagedUpload, direct-upload.service.ts adapter.complete, imports.service.ts
# staged put), so no row state is excluded below.
# Coherence check: the uploads were copied after the database snapshot, so a file
# deleted in between would leave a database row without bytes. Every storage
# key a backed-up database references must exist in the archive.
# Runs whenever a database was backed up, even if the uploads directory is
# absent: then every referenced key is missing and the backup fails.
if [ -d "$WORK_PATH/data" ]; then
    find "$WORK_PATH/data" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) > "$LIST_FILE"
    while IFS= read -r db; do
        storage_keys "$db" > "$KEYS_FILE"
        while IFS= read -r key; do
            [ -f "$WORK_PATH$UPLOADS_DIR/$key" ] || {
                echo "ERROR: database references $key but it is not in the backup" >&2
                exit 1
            }
        done < "$KEYS_FILE"
    done < "$LIST_FILE"
fi

# Backup offline map tiles (critical for field operations)
if [ -d "$TILES_DIR" ]; then
    echo "Backing up offline map tiles..."
    cp -R "$TILES_DIR" "$WORK_PATH/tiles"
    echo "Map tiles backed up for offline use"
fi

# Create backup metadata
cat > "$WORK_PATH/backup_info.json" << EOF
{
  "backup_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backup_type": "field-kit",
  "hostname": "$(hostname)",
  "disk_usage": {
    "data_size": "$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1 || echo 'N/A')",
    "uploads_size": "$(du -sh "$UPLOADS_DIR" 2>/dev/null | cut -f1 || echo 'N/A')",
    "backup_size": "$(du -sh "$WORK_PATH" | cut -f1)"
  }
}
EOF

# Commit: the backup directory only exists under its final name when complete.
mv "$WORK_PATH" "$BACKUP_PATH"

# Compress backup if enabled
if [ "$COMPRESSION" = "true" ]; then
    echo "Compressing backup..."
    cd "$BACKUP_DIR"
    # Hidden .partial name until complete: a full disk or kill never leaves a
    # truncated archive under its final name.
    tar -czf "$PARTIAL_ARCHIVE" "$BACKUP_NAME"
    chmod 600 "$PARTIAL_ARCHIVE"
    mv "$PARTIAL_ARCHIVE" "${BACKUP_NAME}.tar.gz"
    rm -rf "$BACKUP_NAME"
    FINAL_SIZE=$(du -h "${BACKUP_NAME}.tar.gz" | cut -f1)
    echo "Compressed backup created: ${BACKUP_NAME}.tar.gz ($FINAL_SIZE)"
else
    chmod 700 "$BACKUP_PATH"
    FINAL_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
    echo "Uncompressed backup created: $BACKUP_NAME ($FINAL_SIZE)"
fi

# Clean up old backups
echo "Cleaning up backups older than $RETENTION_DAYS days..."
# (no find -delete: not every BusyBox build has it)
find "$BACKUP_DIR" -name "fieldkit_backup_*" -type f -mtime +"$RETENTION_DAYS" > "$LIST_FILE"
while IFS= read -r old; do
    rm -f "$old"
done < "$LIST_FILE"
find "$BACKUP_DIR" -name "fieldkit_backup_*" -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true
# Leftovers of a killed run (hidden .partial- archives and directories).
find "$BACKUP_DIR" -name ".partial-fieldkit_backup_*" -type f -mtime +"$RETENTION_DAYS" > "$LIST_FILE"
while IFS= read -r old; do
    rm -f "$old"
done < "$LIST_FILE"
find "$BACKUP_DIR" -name ".partial-fieldkit_backup_*" -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} + 2>/dev/null || true

# Show remaining backups
echo "Remaining backups:"
ls -lah "$BACKUP_DIR"/fieldkit_backup_* 2>/dev/null || echo "No backups found"

echo "Field kit backup completed at $(date)"
