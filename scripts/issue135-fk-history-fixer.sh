#!/usr/bin/env bash
set -euo pipefail

python3 <<'PY'
from pathlib import Path

mappings = [
    ('users_community_id_fkey', 'users_community_id_communities_id_fk', 'users'),
    ('places_community_id_fkey', 'places_community_id_communities_id_fk', 'places'),
    ('speakers_community_id_fkey', 'speakers_community_id_communities_id_fk', 'speakers'),
    ('stories_community_id_fkey', 'stories_community_id_communities_id_fk', 'stories'),
    ('stories_interview_location_id_fkey', 'stories_interview_location_id_places_id_fk', 'stories'),
    ('stories_interviewer_id_fkey', 'stories_interviewer_id_speakers_id_fk', 'stories'),
    ('files_community_id_fkey', 'files_community_id_communities_id_fk', 'files'),
    ('files_uploaded_by_fkey', 'files_uploaded_by_users_id_fk', 'files'),
    ('story_places_story_id_fkey', 'story_places_story_id_stories_id_fk', 'story_places'),
    ('story_places_place_id_fkey', 'story_places_place_id_places_id_fk', 'story_places'),
    ('story_speakers_story_id_fkey', 'story_speakers_story_id_stories_id_fk', 'story_speakers'),
    ('story_speakers_speaker_id_fkey', 'story_speakers_speaker_id_speakers_id_fk', 'story_speakers'),
]

baseline = Path('src/db/migrations/postgres/0000_current_compat_baseline.sql')
text = baseline.read_text()
for old, new, _table in mappings:
    text = text.replace(old, new)

marker = "CREATE UNIQUE INDEX IF NOT EXISTS communities_slug_unique ON communities (slug);\n--> statement-breakpoint\n"
if 'DO $canonicalize_issue135_fks$' not in text:
    if marker not in text:
        raise SystemExit('could not locate canonical FK rename insertion point')
    values = ',\n    '.join(
        f"('{table}', '{old}', '{new}')" for old, new, table in mappings
    )
    rename_block = f"""DO $canonicalize_issue135_fks$
DECLARE
  mapping record;
BEGIN
  FOR mapping IN
    SELECT * FROM (VALUES
    {values}
    ) AS mappings(table_name, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(mapping.table_name)
        AND conname = mapping.old_name
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(mapping.table_name)
        AND conname = mapping.new_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
        mapping.table_name, mapping.old_name, mapping.new_name
      );
    END IF;
  END LOOP;
END $canonicalize_issue135_fks$;
--> statement-breakpoint
"""
    text = text.replace(marker, marker + rename_block, 1)
baseline.write_text(text)

theme_migration = Path('src/db/migrations/postgres/0001_theme_ownership_fk.sql')
theme_migration.write_text(
    theme_migration.read_text().replace(
        'themes_community_id_fkey', 'themes_community_id_communities_id_fk'
    )
)

for schema_path, table_name in [
    ('src/db/schema/speakers.ts', 'speakersPg'),
    ('src/db/schema/stories.ts', 'storiesPg'),
]:
    schema = Path(schema_path)
    text = schema.read_text()
    old = "communityId: pgInteger('community_id').notNull(),"
    new = "communityId: pgInteger('community_id')\n      .notNull()\n      .references(() => communitiesPg.id),"
    if old in text:
        text = text.replace(old, new, 1)
    elif table_name in text and new not in text:
        raise SystemExit(f'could not add PostgreSQL community FK in {schema_path}')
    schema.write_text(text)

backend = Path('scripts/test-db-backend.ts')
text = backend.read_text()
for old, new, _table in mappings:
    text = text.replace(old, new)
text = text.replace(
    'themes_community_id_fkey', 'themes_community_id_communities_id_fk'
)
anchor = "    'stories_community_id_communities_id_fk',\n"
if "    'stories_interview_location_id_places_id_fk',\n" not in text:
    if anchor not in text:
        raise SystemExit('could not extend PostgreSQL FK assertions')
    text = text.replace(
        anchor,
        anchor
        + "    'stories_interview_location_id_places_id_fk',\n"
        + "    'stories_interviewer_id_speakers_id_fk',\n",
        1,
    )
backend.write_text(text)
PY

cat > scripts/test-postgres-migration-regressions.ts <<'TS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const rootDir = process.cwd();
const migrationsFolder = path.join(rootDir, 'src/db/migrations/postgres');
const previousReleaseFixture = path.join(
  rootDir,
  'tests/fixtures/db/postgres-previous-release.sql'
);
const snapshotPath = path.join(migrationsFolder, 'meta/0001_snapshot.json');

function assertSafeTestDatabase(databaseUrl: string): void {
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, '')
  );
  const dedicatedTestDatabase = /^(?:test|[a-z0-9][a-z0-9_]*_test)$/i;
  assert.match(
    databaseName,
    dedicatedTestDatabase,
    `refusing destructive PostgreSQL regression gate against non-test database ${databaseName}`
  );
  assert.equal(
    process.env.ALLOW_POSTGRES_TEST_RESET,
    'true',
    'ALLOW_POSTGRES_TEST_RESET=true is required for the destructive PostgreSQL regression gate'
  );
}

function splitStatements(source: string): string[] {
  return source
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function resetDatabase(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await client.unsafe('CREATE SCHEMA public');
}

async function installPreviousRelease(
  client: ReturnType<typeof postgres>
): Promise<void> {
  const source = await readFile(previousReleaseFixture, 'utf8');
  for (const statement of splitStatements(source)) {
    await client.unsafe(statement);
  }
}

type SnapshotForeignKey = { name?: string };
type SnapshotTable = { foreignKeys?: Record<string, SnapshotForeignKey> };
type Snapshot = { tables?: Record<string, SnapshotTable> };

async function snapshotForeignKeyNames(): Promise<string[]> {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Snapshot;
  return Object.values(snapshot.tables ?? {})
    .flatMap((table) => Object.values(table.foreignKeys ?? {}))
    .map((foreignKey) => foreignKey.name)
    .filter((name): name is string => Boolean(name))
    .sort();
}

async function assertSnapshotConstraintNames(
  client: ReturnType<typeof postgres>
): Promise<void> {
  const expected = await snapshotForeignKeyNames();
  const rows = await client.unsafe(`
    SELECT conname
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND contype = 'f'
    ORDER BY conname
  `);
  const actual = rows.map((row) => String(row.conname)).sort();
  assert.deepEqual(
    actual,
    expected,
    'applied PostgreSQL FK names must exactly match the latest Drizzle snapshot'
  );
}

async function verifyOrphanThemeUpgrade(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  await installPreviousRelease(client);
  await client.unsafe(`
    INSERT INTO themes
      (id, name, community_id, created_at, updated_at)
    VALUES
      (999, 'Legacy orphan theme', 999999, now(), now())
  `);

  await migrate(drizzle(client), { migrationsFolder });

  const [legacyTheme] = await client.unsafe(
    'SELECT id, community_id FROM themes WHERE id = 999'
  );
  assert.equal(String(legacyTheme?.community_id), '999999');

  const [constraint] = await client.unsafe(`
    SELECT convalidated
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = 'themes_community_id_communities_id_fk'
  `);
  assert.ok(constraint, 'theme ownership FK must exist after legacy upgrade');
  assert.equal(
    constraint.convalidated,
    false,
    'legacy orphan rows must keep the staged FK unvalidated until remediated'
  );
  await assertSnapshotConstraintNames(client);

  await assert.rejects(
    client.unsafe(`
      INSERT INTO themes
        (name, community_id, created_at, updated_at)
      VALUES
        ('New orphan theme', 999998, now(), now())
    `),
    undefined,
    'staged FK must reject new orphan theme writes'
  );
}

async function verifyFreshSnapshotConstraintNames(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  await migrate(drizzle(client), { migrationsFolder });
  await assertSnapshotConstraintNames(client);

  const [themeConstraint] = await client.unsafe(`
    SELECT convalidated
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = 'themes_community_id_communities_id_fk'
  `);
  assert.equal(
    themeConstraint?.convalidated,
    true,
    'fresh databases must fully validate the theme ownership FK'
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'DATABASE_URL is required');
  assertSafeTestDatabase(databaseUrl);

  const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    console.log('🐘 PostgreSQL migration regression gate');
    console.log('  1/2 orphan-theme expand-contract upgrade');
    await verifyOrphanThemeUpgrade(client);
    console.log('  2/2 applied FK names match Drizzle snapshot');
    await verifyFreshSnapshotConstraintNames(client);
    console.log('✅ PostgreSQL migration regression gate passed');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('❌ PostgreSQL migration regression gate failed');
  console.error(error);
  process.exitCode = 1;
});
TS

npx prettier --write \
  src/db/schema/speakers.ts \
  src/db/schema/stories.ts \
  scripts/test-db-backend.ts \
  scripts/test-postgres-migration-regressions.ts

rm -rf .issue135-fk-snapshots src/db/schema-snapshot
mkdir -p .issue135-fk-snapshots/postgres src/db/schema-snapshot
cp src/db/schema/*.ts src/db/schema-snapshot/
sed -i -E "s/(from[[:space:]]+['\"][^'\"]+)\.js(['\"])/\1.ts\2/g" src/db/schema-snapshot/*.ts

python3 <<'PY'
from pathlib import Path
themes = Path('src/db/schema-snapshot/themes.ts')
text = themes.read_text()
old = "communityId: bigint('community_id', { mode: 'number' })\n      .notNull()\n      .references(() => communitiesPg.id),"
new = "communityId: bigint('community_id', { mode: 'number' }).notNull(),"
if old not in text:
    raise SystemExit('could not construct PostgreSQL 0000 schema state')
themes.write_text(text.replace(old, new, 1))
PY

cat > .issue135-fk-snapshots/postgres.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema-snapshot/*.ts',
  out: './.issue135-fk-snapshots/postgres',
  dbCredentials: { url: 'postgresql://snapshot:snapshot@127.0.0.1:5432/snapshot' },
  strict: true,
});
EOF

npx drizzle-kit generate --config=.issue135-fk-snapshots/postgres.config.ts --name=current_compat_baseline
test -f .issue135-fk-snapshots/postgres/meta/0000_snapshot.json
cp src/db/schema/themes.ts src/db/schema-snapshot/themes.ts
sed -i -E "s/(from[[:space:]]+['\"][^'\"]+)\.js(['\"])/\1.ts\2/g" src/db/schema-snapshot/themes.ts
npx drizzle-kit generate --config=.issue135-fk-snapshots/postgres.config.ts --name=theme_ownership_fk
test -f .issue135-fk-snapshots/postgres/meta/0001_snapshot.json
cp .issue135-fk-snapshots/postgres/meta/0000_snapshot.json src/db/migrations/postgres/meta/0000_snapshot.json
cp .issue135-fk-snapshots/postgres/meta/0001_snapshot.json src/db/migrations/postgres/meta/0001_snapshot.json
rm -rf .issue135-fk-snapshots src/db/schema-snapshot
npx prettier --write \
  src/db/migrations/postgres/meta/0000_snapshot.json \
  src/db/migrations/postgres/meta/0001_snapshot.json

npm run format:check
npm run type-check
npm run lint

rm -rf .issue135-drift-probe src/db/schema-drift-probe
mkdir -p .issue135-drift-probe/postgres src/db/schema-drift-probe
cp src/db/schema/*.ts src/db/schema-drift-probe/
sed -i -E "s/(from[[:space:]]+['\"][^'\"]+)\.js(['\"])/\1.ts\2/g" src/db/schema-drift-probe/*.ts
cp -R src/db/migrations/postgres/. .issue135-drift-probe/postgres/
cat > .issue135-drift-probe/drift.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema-drift-probe/*.ts',
  out: './.issue135-drift-probe/postgres',
  dbCredentials: { url: 'postgresql://snapshot:snapshot@127.0.0.1:5432/snapshot' },
  strict: true,
});
EOF
before_pg=$(find .issue135-drift-probe/postgres -maxdepth 1 -name '*.sql' | wc -l)
npx drizzle-kit generate --config=.issue135-drift-probe/drift.config.ts --name=issue135_fk_name_probe
after_pg=$(find .issue135-drift-probe/postgres -maxdepth 1 -name '*.sql' | wc -l)
if [ "$after_pg" -ne "$before_pg" ]; then
  echo 'PostgreSQL schema still has pending migration drift' >&2
  cat .issue135-drift-probe/postgres/*issue135_fk_name_probe.sql || true
  exit 31
fi
rm -rf .issue135-drift-probe src/db/schema-drift-probe

npm run test:db:sqlite
npm run test:db:postgres
git diff --check

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add \
  src/db/migrations/postgres/0000_current_compat_baseline.sql \
  src/db/migrations/postgres/0001_theme_ownership_fk.sql \
  src/db/migrations/postgres/meta/0000_snapshot.json \
  src/db/migrations/postgres/meta/0001_snapshot.json \
  src/db/schema/speakers.ts \
  src/db/schema/stories.ts \
  scripts/test-db-backend.ts \
  scripts/test-postgres-migration-regressions.ts

git diff --cached --check
git diff --cached --stat
if ! git diff --cached --quiet; then
  git commit -m 'fix: align postgres foreign key history'
  git push origin HEAD:feat/issue-135-dual-backend-ci
fi
