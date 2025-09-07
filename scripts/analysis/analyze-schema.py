#!/usr/bin/env python3
"""
Terrastories Database Schema Analyzer
Analyzes the PostgreSQL schema for TypeScript migration planning
"""

import re
import os
from pathlib import Path

def parse_create_table(schema_content):
    """Extract table definitions from schema"""
    tables = {}
    
    # Pattern to match CREATE TABLE statements
    table_pattern = r'CREATE TABLE "public"\."(\w+)" \((.*?)\);'
    
    for match in re.finditer(table_pattern, schema_content, re.DOTALL):
        table_name = match.group(1)
        columns_text = match.group(2)
        
        columns = []
        # Parse individual columns
        for line in columns_text.strip().split('\n'):
            line = line.strip().rstrip(',')
            if line and not line.startswith('--'):
                # Remove quotes and extract column info
                line = re.sub(r'"([^"]*)"', r'\1', line)
                columns.append(line.strip())
        
        tables[table_name] = columns
    
    return tables

def parse_foreign_keys(schema_content):
    """Extract foreign key constraints"""
    fk_pattern = r'ALTER TABLE (?:ONLY )?public\.(\w+) ADD CONSTRAINT (\w+) FOREIGN KEY \(([^)]+)\) REFERENCES public\.(\w+)\(([^)]+)\)'
    
    foreign_keys = []
    for match in re.finditer(fk_pattern, schema_content):
        source_table = match.group(1)
        constraint_name = match.group(2) 
        source_column = match.group(3)
        target_table = match.group(4)
        target_column = match.group(5)
        
        foreign_keys.append({
            'source_table': source_table,
            'source_column': source_column,
            'target_table': target_table,
            'target_column': target_column,
            'constraint_name': constraint_name
        })
    
    return foreign_keys

def analyze_terrastories_schema():
    """Main analysis function"""
    schema_file = Path('dump-analysis/schema.sql')
    
    if not schema_file.exists():
        print("❌ Schema file not found. Please run ./analyze-dump.sh first")
        return
    
    with open(schema_file, 'r') as f:
        schema_content = f.read()
    
    print("🔍 Analyzing Terrastories Database Schema for TypeScript Migration\n")
    
    # Parse tables
    tables = parse_create_table(schema_content)
    
    # Core domain tables
    core_tables = ['communities', 'users', 'stories', 'places', 'speakers', 'themes', 'curriculums']
    
    print("📊 CORE DOMAIN TABLES:")
    print("=" * 50)
    for table in core_tables:
        if table in tables:
            print(f"\n🏷️  {table.upper()}:")
            for col in tables[table][:10]:  # Show first 10 columns
                print(f"   • {col}")
            if len(tables[table]) > 10:
                print(f"   ... and {len(tables[table]) - 10} more columns")
    
    # Junction tables (many-to-many relationships)
    junction_tables = [t for t in tables.keys() if '_' in t and any(core in t for core in core_tables)]
    
    print(f"\n🔗 RELATIONSHIP TABLES:")
    print("=" * 50)
    for table in junction_tables:
        print(f"• {table}")
        for col in tables[table]:
            print(f"  - {col}")
    
    # ActiveStorage tables (media)
    active_storage_tables = [t for t in tables.keys() if t.startswith('active_storage')]
    
    print(f"\n📱 MEDIA TABLES (ActiveStorage):")
    print("=" * 50)
    for table in active_storage_tables:
        print(f"• {table}")
    
    # Parse foreign keys
    foreign_keys = parse_foreign_keys(schema_content)
    
    print(f"\n🔗 FOREIGN KEY RELATIONSHIPS:")
    print("=" * 50)
    for fk in foreign_keys:
        print(f"• {fk['source_table']}.{fk['source_column']} → {fk['target_table']}.{fk['target_column']}")
    
    # Generate TypeScript types preview
    print(f"\n🎯 TYPESCRIPT MIGRATION INSIGHTS:")
    print("=" * 50)
    
    print("\n📋 Recommended TypeScript Types:")
    
    for table in core_tables:
        if table in tables:
            print(f"\n// {table.capitalize()} entity")
            print(f"interface {table.capitalize()} {{")
            
            for col in tables[table][:5]:  # Show sample columns
                # Basic type mapping
                if 'bigint' in col or 'integer' in col:
                    ts_type = 'number'
                elif 'character varying' in col or 'text' in col:
                    ts_type = 'string'
                elif 'timestamp' in col:
                    ts_type = 'Date'
                elif 'boolean' in col:
                    ts_type = 'boolean'
                else:
                    ts_type = 'unknown'
                
                col_name = col.split()[0]
                nullable = '?' if 'NOT NULL' not in col else ''
                print(f"  {col_name}{nullable}: {ts_type};")
            
            print("  // ... other fields")
            print("}")
    
    print(f"\n🗺️ MIGRATION PRIORITY:")
    print("=" * 50)
    print("1. Core entities: Community, User, Story, Place, Speaker")
    print("2. Relationship tables: story_places, story_speakers")  
    print("3. Media system: ActiveStorage → new media handling")
    print("4. Theme & Curriculum systems")
    print("5. Feature flags (flipper_*)")
    
    # Save analysis to file
    output_dir = Path('migration-analysis')
    output_dir.mkdir(exist_ok=True)
    
    with open(output_dir / 'schema_analysis.txt', 'w') as f:
        f.write(f"TERRASTORIES SCHEMA ANALYSIS\n")
        f.write(f"Generated: {os.popen('date').read().strip()}\n\n")
        
        f.write("CORE TABLES:\n")
        for table in core_tables:
            if table in tables:
                f.write(f"\n{table}:\n")
                for col in tables[table]:
                    f.write(f"  {col}\n")
        
        f.write("\nFOREIGN KEYS:\n")
        for fk in foreign_keys:
            f.write(f"{fk['source_table']}.{fk['source_column']} → {fk['target_table']}.{fk['target_column']}\n")
    
    print(f"\n✅ Analysis complete! Detailed results saved to migration-analysis/")

if __name__ == "__main__":
    analyze_terrastories_schema()