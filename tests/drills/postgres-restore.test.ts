/**
 * Restore drill, Node/PostgreSQL profile (#136).
 *
 * pg_dump (custom format) a migrated, seeded database, pg_restore into a
 * second database, then compare counts, per-table checksums, ownership
 * invariants and sequences. Runs only when DRILL_POSTGRES_URL names a
 * dedicated test database, ALLOW_POSTGRES_TEST_RESET=true and the pg client
 * tools are on PATH (the CI PostgreSQL 13 job provides all three); otherwise
 * the whole suite is skipped and the skip reason is in its name.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type postgres from 'postgres';
import { applyPostRestorePostgres } from '../../scripts/ops/post-restore.js';
import { createPostgresClient } from '../../src/db/index.js';
import {
  OWNERSHIP_INVARIANTS,
  digestRows,
  diffSnapshots,
  migrationVersion,
  seedDrillDataset,
  writeDrillReport,
  type Snapshot,
} from './drill-helpers.js';

const url = process.env.DRILL_POSTGRES_URL;

function skipReason(): string | undefined {
  if (!url) return 'DRILL_POSTGRES_URL is not set';
  if (process.env.ALLOW_POSTGRES_TEST_RESET !== 'true')
    return 'ALLOW_POSTGRES_TEST_RESET is not true';
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.includes('test'))
    return `database "${name}" is not a dedicated test database`;
  for (const tool of ['pg_dump', 'pg_restore'])
    if (spawnSync(tool, ['--version']).status !== 0)
      return `${tool} is not on PATH`;
  return undefined;
}

const reason = skipReason();
if (reason) console.warn(`[restore-drill:postgres] skipped: ${reason}`);

async function snapshotPostgres(client: postgres.Sql): Promise<Snapshot> {
  const tables = await client.unsafe(
    "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'drizzle') ORDER BY 1, 2"
  );
  const out: Snapshot = {};
  for (const { s, t } of tables) {
    const rows = await client.unsafe(`SELECT * FROM "${s}"."${t}"`);
    out[`${s}.${t}`] = digestRows(
      rows as unknown as Array<Record<string, unknown>>
    );
  }
  return out;
}

// CI sets DRILL_REQUIRE_POSTGRES=true: missing prerequisites fail the job
// instead of silently skipping the PostgreSQL drill.
if (reason && process.env.DRILL_REQUIRE_POSTGRES === 'true') {
  describe('PostgreSQL restore drill prerequisites (required in CI)', () => {
    it('are present', () => {
      throw new Error(`PostgreSQL restore drill cannot run: ${reason}`);
    });
  });
}

describe.skipIf(Boolean(reason))(
  `PostgreSQL pg_dump/pg_restore drill (#136)${reason ? ` [skipped: ${reason}]` : ''}`,
  () => {
    it('restores identical counts, checksums, invariants and sequences', async () => {
      const sourceUrl = new URL(url!);
      const sourceName = sourceUrl.pathname.replace(/^\//, '');
      const restoreName = `${sourceName}_restore_drill`;
      const restoreUrl = new URL(url!);
      restoreUrl.pathname = `/${restoreName}`;
      // No password in subprocess arguments: it travels as PGPASSWORD.
      const toolEnv = {
        ...process.env,
        PGPASSWORD: decodeURIComponent(sourceUrl.password),
      };
      const bare = (u: URL) => {
        const copy = new URL(u.toString());
        copy.password = '';
        return copy.toString();
      };

      const source = createPostgresClient(sourceUrl.toString(), { max: 2 });
      let target: postgres.Sql | undefined;
      try {
        await source.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
        await source.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
        await source.unsafe('CREATE SCHEMA public');
        const orm = drizzle(source);
        await migrate(orm, { migrationsFolder: 'src/db/migrations/postgres' });
        await seedDrillDataset(orm);
        // drizzle(source) installs string timestamp parsers on its client, so
        // read both sides through fresh, identically configured clients.
        const reader = createPostgresClient(sourceUrl.toString(), { max: 1 });
        const before = await snapshotPostgres(reader);
        await reader.end();

        // pg_dump/pg_restore must match the server major version: a newer client
        // writes settings an older server rejects (e.g. SET transaction_timeout).
        const clientMajor = Number(
          /(\d+)/.exec(
            spawnSync('pg_dump', ['--version'], {
              encoding: 'utf8',
              env: toolEnv,
            }).stdout.replace('pg_dump (PostgreSQL) ', '')
          )?.[1]
        );
        const serverMajor = Math.floor(
          Number(
            (await source.unsafe('SHOW server_version_num'))[0]!
              .server_version_num
          ) / 10000
        );
        expect(
          clientMajor,
          `pg_dump major ${clientMajor} must match server major ${serverMajor}`
        ).toBe(serverMajor);

        const started = Date.now();
        const dumpFile = path.join(
          mkdtempSync(path.join(tmpdir(), 'tsapi-drill-pg-')),
          'drill.dump'
        );
        const dump = spawnSync(
          'pg_dump',
          [
            '--format=custom',
            '--no-owner',
            '--no-privileges',
            `--file=${dumpFile}`,
            `--dbname=${bare(sourceUrl)}`,
          ],
          { encoding: 'utf8', env: toolEnv }
        );
        expect(dump.stderr).toBe('');
        expect(dump.status).toBe(0);

        await source.unsafe(`DROP DATABASE IF EXISTS "${restoreName}"`);
        await source.unsafe(`CREATE DATABASE "${restoreName}"`);
        const restore = spawnSync(
          'pg_restore',
          [
            '--no-owner',
            '--no-privileges',
            '--exit-on-error',
            `--dbname=${bare(restoreUrl)}`,
            dumpFile,
          ],
          { encoding: 'utf8', env: toolEnv }
        );
        expect(restore.stderr).toBe('');
        expect(restore.status).toBe(0);
        const elapsedMs = Date.now() - started;

        target = createPostgresClient(restoreUrl.toString(), { max: 2 });
        const after = await snapshotPostgres(target);
        expect(diffSnapshots(before, after)).toEqual([]);
        expect(after['public.stories']!.count).toBe(3);
        expect(after['drizzle.__drizzle_migrations']!.count).toBe(
          migrationVersion('postgresql').journalEntries
        );

        for (const [name, query] of Object.entries(OWNERSHIP_INVARIANTS)) {
          expect({ name, violations: await target.unsafe(query) }).toEqual({
            name,
            violations: [],
          });
        }

        // Post-restore step: sessions gone, codes and claim tokens superseded.
        const fixed = await applyPostRestorePostgres(target);
        expect(fixed.sessionsDeleted).toBeGreaterThan(0);
        expect(fixed.loginCodesSuperseded).toBeGreaterThan(0);
        expect(fixed.claimTokensSuperseded).toBeGreaterThan(0);
        expect(
          (await target.unsafe('SELECT count(*)::int AS n FROM sessions'))[0]!.n
        ).toBe(0);
        expect(
          (
            await target.unsafe(
              'SELECT count(*)::int AS n FROM login_codes WHERE superseded_at IS NULL'
            )
          )[0]!.n
        ).toBe(0);

        // Sequences come back with the data: the next community id is fresh.
        const [{ n }] = await target.unsafe(
          'SELECT count(*)::int AS n FROM communities'
        );
        const [row] = await target.unsafe(
          "INSERT INTO communities (name, slug, locale) VALUES ('Next', 'next', 'en') RETURNING id"
        );
        expect(row!.id).toBeGreaterThan(n);

        writeDrillReport(
          'postgres',
          {
            backup: 'pg_dump --format=custom / pg_restore',
            schema: migrationVersion('postgresql'),
            serverVersion: (await source.unsafe('SHOW server_version'))[0]!
              .server_version,
            tables: after,
            timingsMs: { dumpAndRestore: elapsedMs },
          },
          [decodeURIComponent(sourceUrl.password)]
        );
      } finally {
        await target?.end();
        await source.unsafe(`DROP DATABASE IF EXISTS "${restoreName}"`);
        await source.end();
      }
    }, 120_000);
  }
);
