#!/bin/bash
# Extract specific data for TypeScript migration analysis

DUMP_FILE="latest.dump"
OUTPUT_DIR="migration-analysis"
TEMP_DB="migration_analysis_$(date +%s)"

echo "🔍 Extracting Rails→TypeScript migration data..."

mkdir -p $OUTPUT_DIR

echo "📊 Creating temporary database..."
if createdb $TEMP_DB 2>/dev/null && pg_restore -d $TEMP_DB $DUMP_FILE 2>/dev/null; then
    echo "✅ Database restored successfully"
    
    echo "📋 1. Core table schemas for TypeScript types..."
    psql -d $TEMP_DB -c "
    SELECT 
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
        AND table_name IN ('communities', 'users', 'stories', 'places', 'speakers', 'themes', 'curriculums')
    ORDER BY table_name, ordinal_position;
    " > $OUTPUT_DIR/core_schemas.txt
    
    echo "🔗 2. Foreign key relationships..."
    psql -d $TEMP_DB -c "
    SELECT 
        tc.table_name as source_table,
        kcu.column_name as source_column,
        ccu.table_name as target_table,
        ccu.column_name as target_column,
        tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    ORDER BY tc.table_name;
    " > $OUTPUT_DIR/relationships.txt
    
    echo "📊 3. Data volume analysis..."
    psql -d $TEMP_DB -c "
    WITH table_counts AS (
        SELECT 'communities' as table_name, count(*) as count FROM communities
        UNION ALL SELECT 'users', count(*) FROM users
        UNION ALL SELECT 'stories', count(*) FROM stories  
        UNION ALL SELECT 'places', count(*) FROM places
        UNION ALL SELECT 'speakers', count(*) FROM speakers
        UNION ALL SELECT 'themes', count(*) FROM themes
        UNION ALL SELECT 'curriculums', count(*) FROM curriculums
        UNION ALL SELECT 'story_speakers', count(*) FROM speaker_stories
        UNION ALL SELECT 'story_places', count(*) FROM places_stories
        UNION ALL SELECT 'media', count(*) FROM media
        UNION ALL SELECT 'media_links', count(*) FROM media_links
        UNION ALL SELECT 'active_storage_blobs', count(*) FROM active_storage_blobs
    )
    SELECT * FROM table_counts ORDER BY count DESC;
    " > $OUTPUT_DIR/data_volumes.txt
    
    echo "🏷️ 4. Sample data for understanding domain..."
    psql -d $TEMP_DB -c "SELECT * FROM communities LIMIT 5;" > $OUTPUT_DIR/sample_communities.txt
    psql -d $TEMP_DB -c "SELECT * FROM users LIMIT 5;" > $OUTPUT_DIR/sample_users.txt  
    psql -d $TEMP_DB -c "SELECT * FROM stories LIMIT 3;" > $OUTPUT_DIR/sample_stories.txt
    psql -d $TEMP_DB -c "SELECT * FROM places LIMIT 3;" > $OUTPUT_DIR/sample_places.txt
    psql -d $TEMP_DB -c "SELECT * FROM speakers LIMIT 3;" > $OUTPUT_DIR/sample_speakers.txt
    
    echo "📱 5. ActiveStorage analysis (media migration)..."
    psql -d $TEMP_DB -c "
    SELECT 
        asa.record_type,
        asa.name as attachment_name,
        count(*) as count,
        avg(asb.byte_size) as avg_file_size,
        string_agg(DISTINCT asb.content_type, ', ') as content_types
    FROM active_storage_attachments asa
    JOIN active_storage_blobs asb ON asa.blob_id = asb.id
    GROUP BY asa.record_type, asa.name
    ORDER BY count DESC;
    " > $OUTPUT_DIR/media_analysis.txt
    
    echo "🗺️ 6. Geographic data analysis (PostGIS)..."
    # Check if there are any geometry columns
    psql -d $TEMP_DB -c "
    SELECT 
        table_name,
        column_name,
        data_type
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
        AND (data_type LIKE '%geometry%' OR data_type LIKE '%geography%' OR column_name LIKE '%geom%' OR column_name LIKE '%coord%' OR column_name LIKE '%lat%' OR column_name LIKE '%lng%' OR column_name LIKE '%lon%')
    ORDER BY table_name;
    " > $OUTPUT_DIR/geographic_columns.txt
    
    echo "👥 7. User roles and permissions analysis..."
    psql -d $TEMP_DB -c "
    SELECT 
        role,
        count(*) as user_count,
        string_agg(DISTINCT email, ', ') as sample_emails
    FROM users 
    GROUP BY role
    ORDER BY user_count DESC;
    " > $OUTPUT_DIR/user_roles.txt
    
    echo "🌍 8. Community analysis..."
    psql -d $TEMP_DB -c "
    SELECT 
        c.name as community_name,
        c.public,
        c.slug,
        count(DISTINCT u.id) as user_count,
        count(DISTINCT s.id) as story_count,
        count(DISTINCT p.id) as place_count,
        count(DISTINCT sp.id) as speaker_count
    FROM communities c
    LEFT JOIN users u ON u.id = c.id  -- This might need adjustment based on actual schema
    LEFT JOIN stories s ON s.community_id = c.id
    LEFT JOIN places p ON p.community_id = c.id  
    LEFT JOIN speakers sp ON sp.community_id = c.id
    GROUP BY c.id, c.name, c.public, c.slug
    ORDER BY story_count DESC;
    " > $OUTPUT_DIR/community_stats.txt
    
    dropdb $TEMP_DB
    echo "✅ Analysis complete!"
else
    echo "❌ Could not create/restore database. Check PostgreSQL is running."
    echo "💡 Alternative: Use schema-only analysis"
fi

echo "📂 Results in ./$OUTPUT_DIR/:"
ls -la $OUTPUT_DIR/