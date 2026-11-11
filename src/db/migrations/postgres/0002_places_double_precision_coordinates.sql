-- Widen place coordinates from 4-byte real to 8-byte double precision so
-- PostgreSQL keeps the same coordinate precision as SQLite/D1 (issue #135).
-- real -> double precision is lossless for existing rows; values already
-- rounded by real storage stay as stored and are not re-derived.
ALTER TABLE places ALTER COLUMN latitude TYPE double precision;--> statement-breakpoint
ALTER TABLE places ALTER COLUMN longitude TYPE double precision;
