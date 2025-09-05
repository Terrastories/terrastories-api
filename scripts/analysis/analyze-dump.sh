#!/bin/bash
# Terrastories Database Dump Analysis Script

DUMP_FILE="latest.dump"
OUTPUT_DIR="dump-analysis"
TEMP_DB="temp_terrastories_$(date +%s)"

echo "🔍 Analyzing Terrastories database dump..."

# Create output directory
mkdir -p $OUTPUT_DIR

echo "📋 Step 1: Listing all database objects..."
pg_restore -l $DUMP_FILE > $OUTPUT_DIR/objects_list.txt

echo "🏗️ Step 2: Extracting schema only..."
pg_restore -s -f $OUTPUT_DIR/schema.sql $DUMP_FILE

echo "📊 Step 3: Creating temporary database for analysis..."
createdb $TEMP_DB 2>/dev/null

if [ $? -eq 0 ]; then
    echo "🔄 Restoring dump to temporary database..."
    pg_restore -d $TEMP_DB $DUMP_FILE 2>/dev/null
    
    echo "📈 Step 4: Generating analysis reports..."
    
    # Table sizes and row counts
    psql -d $TEMP_DB -c "
    SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
        pg_stat_get_tuples_inserted(c.oid) + pg_stat_get_tuples_updated(c.oid) + pg_stat_get_tuples_deleted(c.oid) as total_changes,
        reltuples::bigint as row_count_estimate
    FROM pg_tables pt
    JOIN pg_class c ON c.relname = pt.tablename
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
    " > $OUTPUT_DIR/table_sizes.txt
    
    # Get actual row counts for key tables
    psql -d $TEMP_DB -c "
    SELECT 'communities' as table_name, count(*) as row_count FROM communities
    UNION ALL
    SELECT 'users', count(*) FROM users
    UNION ALL
    SELECT 'stories', count(*) FROM stories
    UNION ALL
    SELECT 'places', count(*) FROM places
    UNION ALL
    SELECT 'speakers', count(*) FROM speakers
    UNION ALL
    SELECT 'story_places', count(*) FROM story_places
    UNION ALL
    SELECT 'story_speakers', count(*) FROM story_speakers
    UNION ALL
    SELECT 'active_storage_blobs', count(*) FROM active_storage_blobs;
    " > $OUTPUT_DIR/row_counts.txt
    
    # Sample data from key tables
    echo "📝 Extracting sample data..."
    psql -d $TEMP_DB -c "SELECT * FROM communities LIMIT 3;" > $OUTPUT_DIR/sample_communities.txt
    psql -d $TEMP_DB -c "SELECT * FROM users LIMIT 3;" > $OUTPUT_DIR/sample_users.txt
    psql -d $TEMP_DB -c "SELECT * FROM stories LIMIT 3;" > $OUTPUT_DIR/sample_stories.txt
    
    # Relationships analysis
    psql -d $TEMP_DB -c "
    SELECT 
        tc.table_name, 
        kcu.column_name, 
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name 
    FROM information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
    WHERE constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_name;
    " > $OUTPUT_DIR/foreign_keys.txt
    
    echo "🧹 Cleaning up temporary database..."
    dropdb $TEMP_DB
else
    echo "⚠️ Could not create temporary database. Using schema analysis only."
fi

echo "✅ Analysis complete! Results in ./$OUTPUT_DIR/"
echo ""
echo "📂 Generated files:"
echo "  - objects_list.txt: All database objects"
echo "  - schema.sql: Complete database schema"
echo "  - table_sizes.txt: Table sizes and estimates"
echo "  - row_counts.txt: Actual row counts"
echo "  - sample_*.txt: Sample data from key tables"
echo "  - foreign_keys.txt: Relationship mappings"