-- Restore per-community Mapbox and Protomaps style configuration in V2 map-config
-- (2026-11-22 user decision amending SPEC-V2 §6.6). Purely additive.

ALTER TABLE "community_map_configs" ADD COLUMN "mapbox_style_url" text;
--> statement-breakpoint
ALTER TABLE "community_map_configs" ADD COLUMN "mapbox_access_token" text;
--> statement-breakpoint
ALTER TABLE "community_map_configs" ADD COLUMN "expose_mapbox_credentials" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_map_configs" ADD COLUMN "mapbox_3d" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_map_configs" ADD COLUMN "protomaps_api_key" text;
--> statement-breakpoint
ALTER TABLE "community_map_configs" ADD COLUMN "protomaps_basemap_style" text;
