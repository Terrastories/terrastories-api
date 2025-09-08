-- Add themes table with Rails compatibility
CREATE TABLE IF NOT EXISTS themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    mapbox_style_url TEXT,
    mapbox_access_token TEXT,
    center_lat REAL,
    center_long REAL,
    sw_boundary_lat REAL,
    sw_boundary_long REAL,
    ne_boundary_lat REAL,
    ne_boundary_long REAL,
    active INTEGER NOT NULL DEFAULT 0,
    community_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(id)
);

-- Add indexes for performance (matching Rails schema)
CREATE INDEX IF NOT EXISTS idx_themes_community_id ON themes(community_id);
CREATE INDEX IF NOT EXISTS idx_themes_active ON themes(active);
CREATE INDEX IF NOT EXISTS idx_themes_name ON themes(name);
CREATE INDEX IF NOT EXISTS idx_themes_community_active ON themes(community_id, active);