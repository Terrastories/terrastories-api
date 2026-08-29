#!/usr/bin/env bash
set -euo pipefail

python3 <<'PY'
from pathlib import Path

path = Path('src/db/migrations/postgres/0000_current_compat_baseline.sql')
text = path.read_text()
needle = """CREATE UNIQUE INDEX IF NOT EXISTS story_speaker_unique ON story_speakers (story_id, speaker_id);
--> statement-breakpoint
DO $story_speakers_fks$
"""
replacement = """CREATE UNIQUE INDEX IF NOT EXISTS story_speaker_unique ON story_speakers (story_id, speaker_id);
--> statement-breakpoint
DO $canonicalize_issue135_unique_constraints$
DECLARE
  mapping record;
BEGIN
  FOR mapping IN
    SELECT * FROM (VALUES
      ('communities', 'communities_slug_unique'),
      ('users', 'users_email_community_unique'),
      ('story_places', 'story_place_unique'),
      ('story_speakers', 'story_speaker_unique')
    ) AS mappings(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(mapping.table_name)
        AND conname = mapping.constraint_name
        AND contype = 'u'
    ) THEN
      IF to_regclass(mapping.constraint_name) IS NULL THEN
        RAISE EXCEPTION
          'Cannot attach unique constraint %: backing index is missing',
          mapping.constraint_name;
      END IF;

      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE USING INDEX %I',
        mapping.table_name,
        mapping.constraint_name,
        mapping.constraint_name
      );
    END IF;
  END LOOP;
END $canonicalize_issue135_unique_constraints$;
--> statement-breakpoint
DO $story_speakers_fks$
"""
if needle not in text:
    raise SystemExit('could not locate story_speaker_unique insertion point')
path.write_text(text.replace(needle, replacement, 1))
PY

npx prettier --write scripts/test-postgres-migration-regressions.ts
npm run format:check
npm run type-check
npm run lint
npm run test:db:postgres
git diff --check

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add src/db/migrations/postgres/0000_current_compat_baseline.sql scripts/test-postgres-migration-regressions.ts
git diff --cached --check
if ! git diff --cached --quiet; then
  git commit -m 'fix: canonicalize postgres unique constraints'
  git push origin HEAD:feat/issue-135-dual-backend-ci
fi
