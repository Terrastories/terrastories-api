#!/usr/bin/env bash
set -euo pipefail

python3 <<'PY'
from pathlib import Path

path = Path('src/db/migrations/postgres/0000_current_compat_baseline.sql')
text = path.read_text()
old_create = """  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT files_community_id_communities_id_fk FOREIGN KEY (community_id) REFERENCES communities(id),
"""
new_create = """  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL,
  CONSTRAINT files_community_id_communities_id_fk FOREIGN KEY (community_id) REFERENCES communities(id),
"""
if old_create not in text:
    raise SystemExit('could not locate PostgreSQL files timestamp defaults in CREATE TABLE')
text = text.replace(old_create, new_create, 1)
old_alter = """ALTER TABLE files ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE files ALTER COLUMN updated_at SET DEFAULT now();
"""
new_alter = """ALTER TABLE files ALTER COLUMN created_at DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE files ALTER COLUMN updated_at DROP DEFAULT;
"""
if old_alter not in text:
    raise SystemExit('could not locate PostgreSQL files timestamp defaults in upgrade path')
path.write_text(text.replace(old_alter, new_alter, 1))
PY

rm -rf .issue135-metadata
mkdir -p .issue135-metadata/schema .issue135-metadata/sqlite .issue135-metadata/postgres
cp src/db/schema/*.ts .issue135-metadata/schema/
sed -i -E "s/(from[[:space:]]+['\"][^'\"]+)\.js(['\"])/\1.ts\2/g" .issue135-metadata/schema/*.ts

cat > .issue135-metadata/sqlite.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './.issue135-metadata/schema/*.ts',
  out: './.issue135-metadata/sqlite',
  dbCredentials: { url: './.issue135-metadata/probe.db' },
  strict: true,
});
EOF
cat > .issue135-metadata/postgres.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './.issue135-metadata/schema/*.ts',
  out: './.issue135-metadata/postgres',
  dbCredentials: { url: 'postgresql://snapshot:snapshot@127.0.0.1:5432/snapshot' },
  strict: true,
});
EOF

npx drizzle-kit generate --config=.issue135-metadata/sqlite.config.ts --name=current
npx drizzle-kit generate --config=.issue135-metadata/postgres.config.ts --name=current

python3 <<'PY'
import json
from pathlib import Path

names = {'idx_users_reset_password_token', 'idx_users_community_email'}

def load(path):
    return json.loads(Path(path).read_text())

def extract(path, key):
    snapshot = load(path)
    indexes = snapshot['tables'][key]['indexes']
    selected = {name: value for name, value in indexes.items() if name in names}
    if set(selected) != names:
        raise SystemExit(f'{path} did not generate both authentication indexes: {sorted(selected)}')
    reset = selected['idx_users_reset_password_token']
    where = str(reset.get('where', '')).lower()
    if 'reset_password_token' not in where or 'not null' not in where:
        raise SystemExit(f'{path} generated the wrong reset-token predicate: {reset}')
    return selected

sqlite_indexes = extract('.issue135-metadata/sqlite/meta/0000_snapshot.json', 'users')
postgres_indexes = extract('.issue135-metadata/postgres/meta/0000_snapshot.json', 'public.users')

for path in [
    'src/db/migrations/meta/0001_snapshot.json',
    'src/db/migrations/meta/0002_snapshot.json',
    'src/db/migrations/meta/0003_snapshot.json',
]:
    snapshot = load(path)
    snapshot['tables']['users'].setdefault('indexes', {}).update(sqlite_indexes)
    Path(path).write_text(json.dumps(snapshot, indent=2) + '\n')

for path in [
    'src/db/migrations/postgres/meta/0000_snapshot.json',
    'src/db/migrations/postgres/meta/0001_snapshot.json',
]:
    snapshot = load(path)
    snapshot['tables']['public.users'].setdefault('indexes', {}).update(postgres_indexes)
    Path(path).write_text(json.dumps(snapshot, indent=2) + '\n')
PY

npx prettier --write \
  src/db/schema/users.ts \
  scripts/test-migration-metadata.ts \
  scripts/test-postgres-migration-regressions.ts \
  src/db/migrations/meta/0001_snapshot.json \
  src/db/migrations/meta/0002_snapshot.json \
  src/db/migrations/meta/0003_snapshot.json \
  src/db/migrations/postgres/meta/0000_snapshot.json \
  src/db/migrations/postgres/meta/0001_snapshot.json

# Prove the repaired metadata is the current Drizzle state without mutating the real histories.
rm -rf .issue135-metadata/sqlite-history .issue135-metadata/postgres-history
mkdir -p .issue135-metadata/sqlite-history .issue135-metadata/postgres-history
cp src/db/migrations/*.sql .issue135-metadata/sqlite-history/
cp -R src/db/migrations/meta .issue135-metadata/sqlite-history/meta
cp src/db/migrations/postgres/*.sql .issue135-metadata/postgres-history/
cp -R src/db/migrations/postgres/meta .issue135-metadata/postgres-history/meta
cat > .issue135-metadata/sqlite-drift.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './.issue135-metadata/schema/*.ts',
  out: './.issue135-metadata/sqlite-history',
  dbCredentials: { url: './.issue135-metadata/probe.db' },
  strict: true,
});
EOF
cat > .issue135-metadata/postgres-drift.config.ts <<'EOF'
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './.issue135-metadata/schema/*.ts',
  out: './.issue135-metadata/postgres-history',
  dbCredentials: { url: 'postgresql://snapshot:snapshot@127.0.0.1:5432/snapshot' },
  strict: true,
});
EOF
before_sqlite=$(find .issue135-metadata/sqlite-history -maxdepth 1 -name '*.sql' | wc -l)
before_pg=$(find .issue135-metadata/postgres-history -maxdepth 1 -name '*.sql' | wc -l)
npx drizzle-kit generate --config=.issue135-metadata/sqlite-drift.config.ts --name=issue135_metadata_probe
npx drizzle-kit generate --config=.issue135-metadata/postgres-drift.config.ts --name=issue135_metadata_probe
after_sqlite=$(find .issue135-metadata/sqlite-history -maxdepth 1 -name '*.sql' | wc -l)
after_pg=$(find .issue135-metadata/postgres-history -maxdepth 1 -name '*.sql' | wc -l)
if [ "$before_sqlite" -ne "$after_sqlite" ]; then
  echo 'SQLite schema still has pending Drizzle migration drift' >&2
  exit 31
fi
if [ "$before_pg" -ne "$after_pg" ]; then
  echo 'PostgreSQL schema still has pending Drizzle migration drift' >&2
  cat .issue135-metadata/postgres-history/*issue135_metadata_probe.sql || true
  exit 32
fi
rm -rf .issue135-metadata

npm run format:check
npm run type-check
npm run lint
npm run test:db:sqlite
npm run test:db:postgres
git diff --check

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add \
  src/db/migrations/postgres/0000_current_compat_baseline.sql \
  src/db/migrations/meta/0001_snapshot.json \
  src/db/migrations/meta/0002_snapshot.json \
  src/db/migrations/meta/0003_snapshot.json \
  src/db/migrations/postgres/meta/0000_snapshot.json \
  src/db/migrations/postgres/meta/0001_snapshot.json

git diff --cached --check
if ! git diff --cached --quiet; then
  git commit -m 'fix: align migration metadata semantics'
  git push origin HEAD:feat/issue-135-dual-backend-ci
fi
