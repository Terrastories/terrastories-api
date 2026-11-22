-- Restore per-community Mapbox and Protomaps style configuration in V2 map-config
-- (2026-11-22 user decision amending SPEC-V2 §6.6). Purely additive; D1-safe.

ALTER TABLE `community_map_configs` ADD `mapbox_style_url` text;
--> statement-breakpoint
ALTER TABLE `community_map_configs` ADD `mapbox_access_token` text;
--> statement-breakpoint
ALTER TABLE `community_map_configs` ADD `expose_mapbox_credentials` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `community_map_configs` ADD `mapbox_3d` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `community_map_configs` ADD `protomaps_api_key` text;
--> statement-breakpoint
ALTER TABLE `community_map_configs` ADD `protomaps_basemap_style` text;
