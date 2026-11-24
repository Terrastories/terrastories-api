/**
 * Stage-3 load of a Stage-2 transform output (node-sqlite, D1 dump, R2).
 * Synthetic fixtures only; R2 is a local fake that verifies SigV4 itself.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHonoApp } from '../../src/hono-app.js';
import { createLocalStorage } from '../../src/node-storage.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { captureRailsToBundle } from '../../src/migration/rails/capture.js';
import { transformRailsBundle } from '../../src/migration/v2/transform.js';
import {
  D1_MAX_STATEMENT_BYTES,
  loadTransformOutput,
  signR2Request,
  verifyTransformOutput,
} from '../../src/migration/v2/load.js';
import { makeDerivedKey } from '../hono/auth-test-utils.js';
import { parseArgs } from '../../scripts/migrate-rails-load.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'db',
  'migrations'
);

describe('migrate:rails:load arguments', () => {
  it('parses targets and rejects bad input', () => {
    expect(
      parseArgs([
        '--transform-output',
        'o',
        '--target',
        'node-sqlite',
        '--data-dir',
        'd',
        '--storage-root',
        's',
        '--dry-run',
      ])
    ).toEqual({
      help: false,
      transformDir: 'o',
      target: 'node-sqlite',
      dryRun: true,
      dataDir: 'd',
      storageRoot: 's',
    });
    expect(
      parseArgs([
        '--transform-output',
        'o',
        '--target',
        'r2',
        '--bucket',
        'b',
        '--concurrency',
        '2',
      ])
    ).toMatchObject({ target: 'r2', bucket: 'b', concurrency: 2 });
    expect(() => parseArgs(['--target', 'd1'])).toThrow(/--transform-output/);
    expect(() =>
      parseArgs(['--transform-output', 'o', '--target', 'x'])
    ).toThrow(/--target/);
    expect(() =>
      parseArgs(['--transform-output', 'o', '--target', 'r2', '--secret', 'x'])
    ).toThrow(/Unknown argument/);
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });
});

/**
 * Minimal synthetic Stage-2 output (same pattern as load-r2-multipart.test.ts):
 * a files table, one verified media object and the manifest ledger. The
 * AUTOINCREMENT table makes sqlite_sequence exist (loadD1 reads it). The d1
 * dry run only reads this output, so it needs no Rails source database.
 */
async function makeSyntheticOutput(root: string): Promise<string> {
  const dir = await mkdtemp(join(root, 'out-'));
  const body = Buffer.from('synthetic media bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const key = 'communities/1/media/a';
  await mkdir(join(dir, 'v2-media', 'communities/1/media'), {
    recursive: true,
  });
  await writeFile(join(dir, 'v2-media', key), body);
  const db = new Database(join(dir, 'v2.sqlite'));
  db.exec(
    'CREATE TABLE files (id TEXT PRIMARY KEY, storage_key TEXT, checksum TEXT, byte_size INTEGER, mime_type TEXT)'
  );
  db.exec(
    'CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT REFERENCES files(id))'
  );
  db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)').run(
    'file-1',
    key,
    sha256,
    body.length,
    'image/png'
  );
  db.prepare('INSERT INTO attachments (file_id) VALUES (?)').run('file-1');
  db.close();
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      formatVersion: 1,
      media: {
        blobs: [{ blobId: '1', sha256, destinations: [{ fileId: 'file-1' }] }],
      },
    })
  );
  return dir;
}

describe('d1 dry run (synthetic output, no Postgres)', () => {
  it('does not require --sql-out and writes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'd1-dry-'));
    const transformDir = await makeSyntheticOutput(root);
    // Run from an empty temporary cwd so any stray write is observable.
    const cwd = process.cwd();
    const empty = await mkdtemp(join(tmpdir(), 'd1-dry-cwd-'));
    process.chdir(empty);
    try {
      const report = await loadTransformOutput({
        transformDir,
        target: 'd1',
        dryRun: true,
      });
      expect(report).toMatchObject({ dryRun: true, target: 'd1', objects: 1 });
      expect(await readdir(empty)).toEqual([]);
      await expect(
        loadTransformOutput({ transformDir, target: 'd1' })
      ).rejects.toThrow(/--sql-out is required/);
      expect(await readdir(empty)).toEqual([]);
      // an explicit --sql-out target must not be created by a dry run either
      const sqlOut = join(empty, 'sql-out');
      const dry = await loadTransformOutput({
        transformDir,
        target: 'd1',
        dryRun: true,
        sqlOut,
      });
      expect(dry.dryRun).toBe(true);
      await expect(stat(sqlOut)).rejects.toThrow();
      expect(await readdir(empty)).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });
});

describeWithPostgres('Rails -> V2 load (stage 3)', () => {
  let workDir: string;
  let outDir: string;
  let counter = 0;
  const next = (name: string): string => join(workDir, name + '-' + counter++);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'rails-load-'));
    const bundleDir = join(workDir, 'bundle');
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');
      await captureRailsToBundle({
        sourceUrl: dbUrl,
        outputDir: bundleDir,
        blobRoot: join(fixtureDir, 'blobs'),
      });
    });
    outDir = join(workDir, 'transform-out');
    await transformRailsBundle({
      bundleDir,
      outputDir: outDir,
      allowManual: true,
    });
  }, 120_000);

  afterAll(() => undefined);

  describe('node-sqlite', () => {
    it('dry run reports counts and writes nothing', async () => {
      const data = next('data');
      const storage = next('storage');
      const report = await loadTransformOutput({
        transformDir: outDir,
        target: 'node-sqlite',
        dataDir: data,
        storageRoot: storage,
        dryRun: true,
      });
      expect(report).toMatchObject({ dryRun: true, objects: 14 });
      await expect(stat(data)).rejects.toThrow();
      await expect(stat(storage)).rejects.toThrow();
    });

    it('copies objects then the database, and the real app serves the loaded data', async () => {
      const data = next('data');
      const storage = next('storage');
      const report = await loadTransformOutput({
        transformDir: outDir,
        target: 'node-sqlite',
        dataDir: data,
        storageRoot: storage,
      });
      expect(report.objects).toBe(14);
      const sqlite = new Database(join(data, 'v2.sqlite'));
      sqlite.pragma('foreign_keys = ON');
      const file = sqlite
        .prepare(
          'SELECT f.id FROM files f JOIN attachments a ON a.file_id = f.id WHERE a.id = 101'
        )
        .get() as { id: string };
      const app = createHonoApp({
        repository: new HonoFoundationRepository(drizzle(sqlite)),
        secureCookies: false,
        serverSecret: makeDerivedKey(),
        storage: await createLocalStorage(storage),
      });
      const response = await app.request(
        'http://test/v2/public/communities/rio_verde/media/' + file.id
      );
      expect(response.status).toBe(200);
      expect((await response.text()).startsWith('<svg')).toBe(true);
      sqlite.close();
      expect((await stat(join(data, 'v2.sqlite'))).mode & 0o777).toBe(0o600);
      expect(await readdir(data)).toEqual(['v2.sqlite']);
    });

    it('never overwrites a database and aborts on a conflicting object before writing', async () => {
      const data = next('data');
      const storage = next('storage');
      await loadTransformOutput({
        transformDir: outDir,
        target: 'node-sqlite',
        dataDir: data,
        storageRoot: storage,
      });
      await expect(
        loadTransformOutput({
          transformDir: outDir,
          target: 'node-sqlite',
          dataDir: data,
          storageRoot: storage,
        })
      ).rejects.toThrow(/Refusing to overwrite/);

      // a different object already sits at a target key
      const { objects } = await verifyTransformOutput(outDir);
      const data2 = next('data');
      const storage2 = next('storage');
      const first = objects[0]!;
      await mkdir(dirname(join(storage2, first.storageKey)), {
        recursive: true,
      });
      await writeFile(join(storage2, first.storageKey), 'someone else');
      await expect(
        loadTransformOutput({
          transformDir: outDir,
          target: 'node-sqlite',
          dataDir: data2,
          storageRoot: storage2,
        })
      ).rejects.toThrow(/different object already exists/);
      await expect(stat(join(data2, 'v2.sqlite'))).rejects.toThrow();
    });

    it('fails closed when an output object no longer matches its checksum', async () => {
      const copy = next('out-copy');
      await cp(outDir, copy, { recursive: true });
      const { objects } = await verifyTransformOutput(copy);
      await writeFile(
        join(copy, 'v2-media', objects[0]!.storageKey),
        'altered'
      );
      await expect(
        loadTransformOutput({
          transformDir: copy,
          target: 'node-sqlite',
          dataDir: next('data'),
          storageRoot: next('storage'),
        })
      ).rejects.toThrow(/wrong size|SHA-256/);
    });
  });

  describe('d1 dump', () => {
    it('writes a chunked, FK-ordered dump that rebuilds identical tables', async () => {
      const sqlOut = next('d1');
      const report = await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut,
        maxFileBytes: 4000,
      });
      expect(report.sqlFiles).toBeGreaterThan(5);
      const names = (await readdir(sqlOut)).sort();
      expect(names).toContain('r2-upload-manifest.json');
      expect(names).toContain('d1-import.json');
      expect(names).toContain('verify.sql');
      expect(names).toContain('wipe-and-retry.sql');
      const index = JSON.parse(
        await readFile(join(sqlOut, 'd1-import.json'), 'utf8')
      ) as { files: string[]; sequencesFileRequired: boolean };
      expect(index.files).toEqual(
        names
          .filter(
            (n) =>
              n.endsWith('.sql') &&
              n !== 'verify.sql' &&
              n !== 'wipe-and-retry.sql'
          )
          .sort()
      );
      expect(index.files[0]).toBe('0000-preflight.sql');
      expect(index.sequencesFileRequired).toBe(true);
      expect(index.files.some((n) => n.endsWith('-sqlite-sequence.sql'))).toBe(
        true
      );

      const rebuilt = new Database(':memory:');
      rebuilt.pragma('foreign_keys = ON');
      migrate(drizzle(rebuilt), { migrationsFolder });
      let statements = 0;
      for (const name of index.files) {
        const text = await readFile(join(sqlOut, name), 'utf8');
        expect(Buffer.byteLength(text)).toBeLessThan(40_000);
        for (const statement of text.split(';\n')) {
          expect(Buffer.byteLength(statement)).toBeLessThan(
            D1_MAX_STATEMENT_BYTES + 200
          );
          statements += statement.trim() ? 1 : 0;
        }
        rebuilt.exec(text);
      }
      expect(statements).toBeGreaterThan(5);
      expect(rebuilt.pragma('foreign_key_check')).toEqual([]);

      const original = new Database(join(outDir, 'v2.sqlite'), {
        readonly: true,
      });
      const tables = (
        original
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%drizzle%' ORDER BY name"
          )
          .all() as Array<{ name: string }>
      ).map((t) => t.name);
      for (const table of tables) {
        const sql = 'SELECT * FROM "' + table + '" ORDER BY rowid';
        expect(rebuilt.prepare(sql).all(), table).toEqual(
          original.prepare(sql).all()
        );
      }
      const seq = (db: Database.Database): unknown =>
        db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();
      expect(seq(rebuilt)).toEqual(seq(original));
      // every file recorded itself, and the post-import verification passes
      expect(
        (
          rebuilt
            .prepare('SELECT file FROM _rails_migration_load ORDER BY file')
            .all() as Array<{ file: string }>
        ).map((r) => r.file)
      ).toEqual([...index.files].sort());
      const verifySql = await readFile(join(sqlOut, 'verify.sql'), 'utf8');
      rebuilt.exec(verifySql);
      // a sequence below its floor makes verification fail
      rebuilt.exec(
        "UPDATE sqlite_sequence SET seq = 0 WHERE name = 'attachments'"
      );
      expect(() => rebuilt.exec(verifySql)).toThrow(/CHECK constraint/);
      rebuilt.exec('DROP TABLE IF EXISTS _rails_verify');
      original.close();
      rebuilt.close();

      const r2 = JSON.parse(
        await readFile(join(sqlOut, 'r2-upload-manifest.json'), 'utf8')
      ) as { objects: Array<{ key: string; sha256: string }> };
      expect(r2.objects.length).toBe(14);
      expect(r2.objects.every((o) => o.key.startsWith('communities/'))).toBe(
        true
      );
    });

    it('refuses a non-empty target, and a partial re-apply is recovered by wipe-and-retry', async () => {
      const sqlOut = next('d1');
      await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut,
        maxFileBytes: 4000,
      });
      const index = JSON.parse(
        await readFile(join(sqlOut, 'd1-import.json'), 'utf8')
      ) as { files: string[] };
      const read = (name: string): Promise<string> =>
        readFile(join(sqlOut, name), 'utf8');
      const preflight = await read(index.files[0]!);
      const firstData = await read(index.files[1]!);
      const verify = await read('verify.sql');
      const target = new Database(':memory:');
      target.pragma('foreign_keys = ON');
      migrate(drizzle(target), { migrationsFolder });

      // preflight on an empty target passes and records itself
      target.exec(preflight);
      // partial apply; a naive re-run is refused (ledger and tables not empty)
      target.exec(firstData);
      expect(() => target.exec(preflight)).toThrow(/CHECK constraint/);
      expect(() => target.exec(firstData)).toThrow();
      expect(
        (
          target
            .prepare('SELECT file FROM _rails_migration_load ORDER BY file')
            .all() as Array<{ file: string }>
        ).map((r) => r.file)
      ).toEqual(index.files.slice(0, 2));
      // verification of a partial import fails
      expect(() => target.exec(verify)).toThrow(/CHECK constraint/);

      // wipe-and-retry restores a clean target; the full run then verifies
      target.exec(await read('wipe-and-retry.sql'));
      expect(
        target
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '\\_rails\\_%' ESCAPE '\\'"
          )
          .get()
      ).toEqual({ n: 0 });
      for (const name of index.files) target.exec(await read(name));
      target.exec(verify);
      target.close();
    });

    it('wipe-and-retry never erases a target the dump did not preflight', async () => {
      const dump = async (
        maxFileBytes: number
      ): Promise<{ files: string[]; read: (n: string) => Promise<string> }> => {
        const sqlOut = next('d1');
        await loadTransformOutput({
          transformDir: outDir,
          target: 'd1',
          sqlOut,
          maxFileBytes,
        });
        const index = JSON.parse(
          await readFile(join(sqlOut, 'd1-import.json'), 'utf8')
        ) as { files: string[] };
        return {
          files: index.files,
          read: (name) => readFile(join(sqlOut, name), 'utf8'),
        };
      };
      const a = await dump(4000);
      const fresh = (): Database.Database => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        migrate(drizzle(db), { migrationsFolder });
        return db;
      };
      const rowCount = (db: Database.Database): number => {
        const names = (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%drizzle%' AND name NOT LIKE '\\_rails\\_%' ESCAPE '\\'"
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name);
        return names.reduce(
          (sum, name) =>
            sum +
            (
              db.prepare('SELECT COUNT(*) AS n FROM "' + name + '"').get() as {
                n: number;
              }
            ).n,
          0
        );
      };
      const wipeA = await a.read('wipe-and-retry.sql');
      // another dump's wipe carries a different preflight identity
      const wipeB = wipeA.replace(/[0-9a-f]{64}/, 'f'.repeat(64));
      expect(wipeB).not.toBe(wipeA);

      // 1. populated target that never ran a preflight (no ledger): refused
      const populated = fresh();
      const dataOnly = (await a.read(a.files[1]!)).replace(
        /INSERT INTO _rails_migration_load[^\n]*\n$/,
        ''
      );
      expect(dataOnly).not.toContain('_rails_migration_load');
      populated.exec(dataOnly);
      const before = rowCount(populated);
      expect(before).toBeGreaterThan(0);
      expect(() => populated.exec(wipeA)).toThrow();
      expect(rowCount(populated)).toBe(before);
      populated.close();

      // 2. target preflighted by dump A: dump B's wipe is refused, A's works
      const target = fresh();
      target.exec(await a.read(a.files[0]!));
      target.exec(await a.read(a.files[1]!));
      const partial = rowCount(target);
      expect(partial).toBeGreaterThan(0);
      expect(() => target.exec(wipeB)).toThrow(/CHECK constraint/);
      expect(rowCount(target)).toBe(partial);
      target.exec(wipeA);
      expect(rowCount(target)).toBe(0);
      target.close();
    });

    it('estimates rows written and refuses above the budget unless allowed', async () => {
      const dry = await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut: next('d1'),
        dryRun: true,
      });
      expect(dry.estimatedRowsWritten).toBeGreaterThan(dry.rows!);
      expect(dry.warnings).toEqual([]);
      const overDry = await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut: next('d1'),
        dryRun: true,
        rowBudget: 10,
      });
      expect(overDry.warnings![0]).toMatch(/exceed the Workers Free budget/);
      const sqlOut = next('d1');
      await expect(
        loadTransformOutput({
          transformDir: outDir,
          target: 'd1',
          sqlOut,
          rowBudget: 10,
        })
      ).rejects.toThrow(/--allow-over-budget/);
      await expect(stat(sqlOut)).rejects.toThrow();
      const allowed = await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut,
        rowBudget: 10,
        allowOverBudget: true,
      });
      expect(allowed.sqlFiles).toBeGreaterThan(2);
      expect(allowed.instructions!.join(' ')).toContain('wipe-and-retry.sql');

      const paidEnvDry = await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut: next('d1'),
        dryRun: true,
        env: { WORKERS_PLAN: 'paid' },
      });
      expect(paidEnvDry.warnings).toEqual([]);

      const paidOverDry = await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut: next('d1'),
        dryRun: true,
        rowBudget: 10,
        env: { WORKERS_PLAN: 'paid' },
      });
      expect(paidOverDry.warnings![0]).toMatch(
        /exceed the Workers Paid preflight threshold of 10 \(the monthly included rows-written allowance before billable overage\)/
      );
      await expect(
        loadTransformOutput({
          transformDir: outDir,
          target: 'd1',
          sqlOut: next('d1'),
          rowBudget: 10,
          workersPlan: 'paid',
        })
      ).rejects.toThrow(
        /Workers Paid preflight threshold of 10 \(the monthly included rows-written allowance before billable overage\); pass --allow-over-budget/
      );

      await expect(
        loadTransformOutput({
          transformDir: outDir,
          target: 'd1',
          sqlOut: next('d1'),
          dryRun: true,
          env: { WORKERS_PLAN: 'invalid-plan' },
        })
      ).rejects.toThrow(/WORKERS_PLAN must be one of free, paid/);
    });

    it('refuses an existing output directory and a dry run writes nothing', async () => {
      const sqlOut = next('d1');
      const dry = await loadTransformOutput({
        transformDir: outDir,
        target: 'd1',
        sqlOut,
        dryRun: true,
      });
      expect(dry.rows).toBeGreaterThan(20);
      await expect(stat(sqlOut)).rejects.toThrow();
      await loadTransformOutput({ transformDir: outDir, target: 'd1', sqlOut });
      await expect(
        loadTransformOutput({ transformDir: outDir, target: 'd1', sqlOut })
      ).rejects.toThrow(/existing --sql-out/);
    });
  });

  describe('r2 upload', () => {
    const accessKeyId = 'ak' + randomBytes(8).toString('hex');
    const secretAccessKey = randomBytes(16).toString('hex');
    const store = new Map<
      string,
      { body: Buffer; headers: Record<string, string> }
    >();
    let seen: string[] = [];
    let endpoint = '';
    let close: () => Promise<void>;

    const sha = (data: string | Buffer): string =>
      createHash('sha256').update(data).digest('hex');
    const hmac = (key: string | Buffer, data: string): Buffer =>
      createHmac('sha256', key).update(data).digest();

    beforeAll(async () => {
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          seen.push(req.method + ' ' + req.url);
          const auth = req.headers.authorization ?? '';
          const match =
            /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
              auth
            );
          if (!match || match[1] !== accessKeyId) {
            res.statusCode = 403;
            res.end();
            return;
          }
          const [, , date, signedHeaders, signature] = match;
          const canonicalHeaders = signedHeaders!
            .split(';')
            .map((h) => h + ':' + String(req.headers[h]).trim() + '\n')
            .join('');
          const payload = String(req.headers['x-amz-content-sha256']);
          const canonical = [
            req.method,
            req.url!.split('?')[0],
            '',
            canonicalHeaders,
            signedHeaders,
            payload,
          ].join('\n');
          const scope = date + '/auto/s3/aws4_request';
          const toSign = [
            'AWS4-HMAC-SHA256',
            String(req.headers['x-amz-date']),
            scope,
            sha(canonical),
          ].join('\n');
          const key = hmac(
            hmac(hmac(hmac('AWS4' + secretAccessKey, date!), 'auto'), 's3'),
            'aws4_request'
          );
          if (hmac(key, toSign).toString('hex') !== signature) {
            res.statusCode = 403;
            res.end();
            return;
          }
          const path = decodeURIComponent(req.url!.split('?')[0]!);
          if (req.method === 'PUT') {
            const checksum = Buffer.from(
              String(req.headers['x-amz-checksum-sha256']),
              'base64'
            ).toString('hex');
            if (sha(body) !== payload || checksum !== payload) {
              res.statusCode = 400;
              res.end();
              return;
            }
            store.set(path, {
              body,
              headers: {
                'x-amz-meta-sha256': String(req.headers['x-amz-meta-sha256']),
              },
            });
            res.statusCode = 200;
            res.end();
            return;
          }
          const object = store.get(path);
          if (!object) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('content-length', String(object.body.length));
          res.setHeader(
            'x-amz-meta-sha256',
            object.headers['x-amz-meta-sha256']!
          );
          res.statusCode = 200;
          res.end();
        })();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      close = () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
    });

    afterAll(async () => {
      await close();
    });

    const env = {
      R2_ACCESS_KEY_ID: accessKeyId,
      R2_SECRET_ACCESS_KEY: secretAccessKey,
      R2_ACCOUNT_ID: 'acct',
    };

    it('requires credentials from the environment and a dry run contacts nothing', async () => {
      await expect(
        loadTransformOutput({
          transformDir: outDir,
          target: 'r2',
          bucket: 'media',
          endpoint,
          env: {},
        })
      ).rejects.toThrow(/must be set in the environment/);
      seen = [];
      const dry = await loadTransformOutput({
        transformDir: outDir,
        target: 'r2',
        bucket: 'media',
        endpoint,
        env,
        dryRun: true,
      });
      expect(dry).toMatchObject({ dryRun: true, objects: 14, uploaded: 0 });
      expect(seen).toEqual([]);
    });

    it('uploads every object with a verified signature and checksum, then resumes idempotently', async () => {
      const report = await loadTransformOutput({
        transformDir: outDir,
        target: 'r2',
        bucket: 'media',
        endpoint,
        env,
        concurrency: 3,
      });
      expect(report).toMatchObject({ uploaded: 14, alreadyPresent: 0 });
      expect(store.size).toBe(14);
      const { objects } = await verifyTransformOutput(outDir);
      for (const object of objects) {
        const stored = store.get('/media/' + object.storageKey)!;
        expect(sha(stored.body)).toBe(object.sha256);
      }
      const again = await loadTransformOutput({
        transformDir: outDir,
        target: 'r2',
        bucket: 'media',
        endpoint,
        env,
      });
      expect(again).toMatchObject({ uploaded: 0, alreadyPresent: 14 });
    });

    it('fails on a bad signature without leaking credentials, and on a diverged remote object', async () => {
      let message = '';
      try {
        await loadTransformOutput({
          transformDir: outDir,
          target: 'r2',
          bucket: 'media',
          endpoint,
          env: {
            ...env,
            R2_SECRET_ACCESS_KEY: randomBytes(16).toString('hex'),
          },
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/R2 HEAD failed with status 403/);
      expect(message).not.toContain(secretAccessKey);
      expect(message).not.toContain(accessKeyId);

      const { objects } = await verifyTransformOutput(outDir);
      const victim = store.get('/media/' + objects[0]!.storageKey)!;
      victim.body = Buffer.from('different bytes');
      await expect(
        loadTransformOutput({
          transformDir: outDir,
          target: 'r2',
          bucket: 'media',
          endpoint,
          env,
        })
      ).rejects.toThrow(/verification failed/);
    });

    it('signs deterministically for a fixed clock', () => {
      const input = {
        method: 'PUT' as const,
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        bucket: 'media',
        key: 'communities/10/media/abc',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        payloadSha256: sha('x'),
        now: new Date('2026-01-02T03:04:05Z'),
      };
      const a = signR2Request(input);
      expect(a).toEqual(signR2Request(input));
      expect(a.url).toBe(
        'https://acct.r2.cloudflarestorage.com/media/communities/10/media/abc'
      );
      expect(a.headers['x-amz-date']).toBe('20260102T030405Z');
      expect(a.headers.host).toBeUndefined();
    });
  });
});
